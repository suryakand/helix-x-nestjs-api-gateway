import { CanActivate, ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { gatewayOptions } from '../options';
import { AppConfig } from '../config/configuration';
import { IpLimiterService } from '../global-limit/ip-limiter.service';
import { OrgDirectory } from '../keycloak/org-directory.service';
import { LimitsService } from '../metering/limits.service';
import { quotaHeaders } from '../metering/quota-headers';
import { AccessPorts, decideAccess, RouteMode } from './access-decision';
import { ACCESS_MODE, IS_PUBLIC } from './decorators';
import { JwtVerifier } from './jwt.verifier';
import { GatewayRequest } from './request-context';
import { RevocationService } from './revocation.service';

/**
 * Global guard: one entry point for user and M2M client tokens. Permissions come from the token (Keycloak),
 * narrowed by tenant entitlements and per-user choices; the guard adds revocations made through the gateway and
 * usage limits. The upstream never sees credentials —
 * it only receives the request after this guard has attached `req.access` and charged the quota (`'request'` routes;
 * `'upstream'` routes are charged by the proxy, from the upstream's answer).
 */
@Injectable()
export class UnifiedAccessGuard implements CanActivate {
  private readonly ports: AccessPorts;

  constructor(
    private readonly reflector: Reflector,
    private readonly ipLimiter: IpLimiterService,
    jwt: JwtVerifier,
    orgs: OrgDirectory,
    revocations: RevocationService,
    limits: LimitsService,
    config: ConfigService<AppConfig, true>,
  ) {
    const { policy, naming } = gatewayOptions();
    this.ports = {
      apiClientId: config.get('keycloak', { infer: true }).audience,
      policy,
      naming,
      verifyJwt: (t) => jwt.verify(t),
      revokedBefore: (keys) => revocations.revokedBefore(keys),
      orgById: (id) => orgs.byId(id),
      orgByTenantId: (id) => orgs.byTenantId(id),
      allowedPermissions: (tid, caller) => limits.allowedPermissions(tid, caller),
      consume: (tid, caller) => limits.consume(tid, caller),
      peek: (tid, caller) => limits.peek(tid, caller),
    };
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest<GatewayRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    if (req.method === 'OPTIONS') return true;
    const mode = this.reflector.getAllAndOverride<RouteMode>(ACCESS_MODE, targets) ?? 'jwt-only';

    const ip = req.ip ?? 'unknown';
    if (await this.ipLimiter.authBlocked(ip)) {
      res.setHeader('Retry-After', String(this.ipLimiter.retryAfterSec()));
      throw new HttpException('too many failed authentication attempts', 429);
    }

    const outcome = await decideAccess(
      {
        mode,
        method: req.method,
        path: req.path,
        authorization: req.header('authorization'),
        apiKey: req.header('x-api-key'),
        tenantHeader: req.header('x-tenant-id'),
      },
      this.ports,
    );
    if (outcome.quota) res.set(quotaHeaders(outcome.quota));
    if (!outcome.ok) {
      req.access = outcome.identified;
      if (outcome.authFailure) void this.ipLimiter.recordAuthFailure(ip);
      if (outcome.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      throw new HttpException({ statusCode: outcome.status, message: outcome.message }, outcome.status);
    }
    req.access = outcome.access;
    return true;
  }
}
