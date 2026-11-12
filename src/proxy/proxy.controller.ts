import { All, Controller, Logger, Req, Res, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { Response } from 'express';
import * as http from 'node:http';
import * as https from 'node:https';
import { ProxyRoute } from '../access/decorators';
import { GatewayRequest } from '../access/request-context';
import { AppConfig } from '../config/configuration';
import { LimitsService } from '../metering/limits.service';
import { quotaHeaders } from '../metering/quota-headers';
import { ConsumeResult } from '../metering/rate-limiter.service';
import { gatewayOptions, GatewayNaming } from '../options';

/** Never forwarded upstream in either direction, whatever the product. */
const STRIP_ALWAYS = [
  'authorization', 'x-api-key', 'cookie', 'x-tenant-id', 'host', 'connection', 'keep-alive', 'proxy-connection',
  'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization',
];
const STRIP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'set-cookie']);

/**
 * Streams authorized calls to the upstream unchanged. Body parsing is off for these paths (see bootstrapGateway),
 * so request bodies are piped through as-is. Documented in Swagger from the upstream's own schema.
 *
 * Never forwarded upstream: credentials, hop-by-hop headers, and any client-sent tenant, principal, permissions or
 * quota-exhausted header — the upstream trusts those, so only the gateway may set them (from the authenticated caller).
 *
 * `'upstream'`-metered calls are charged here, after the response arrives: the upstream says what the call cost in
 * the billable-units header (stripped before the client sees it), and the X-RateLimit-* headers are set from the
 * limit after that charge. A gateway-side failure (timeout, unreachable upstream) is never charged.
 */
export class ProxyHandler {
  private readonly log = new Logger('ProxyController');
  private readonly upstream: URL;
  private readonly agent: http.Agent;
  private readonly strip: Set<string>;

  constructor(
    config: ConfigService<AppConfig, true>,
    private readonly naming: GatewayNaming,
    private readonly forward: ForwardedHeaders,
    private readonly limits?: LimitsService,
  ) {
    this.upstream = new URL(config.get('upstreamUrl', { infer: true }));
    const Agent = this.upstream.protocol === 'https:' ? https.Agent : http.Agent;
    this.agent = new Agent({ keepAlive: true, maxSockets: 256 });
    this.strip = new Set([
      ...STRIP_ALWAYS, naming.tenantHeader, naming.principalHeader, naming.permissionsHeader, naming.quotaExhaustedHeader,
      naming.billableUnitsHeader,
    ]);
  }

  handle(req: GatewayRequest, res: Response) {
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!this.strip.has(k) && v !== undefined) headers[k] = v;
    headers['x-forwarded-for'] = [req.header('x-forwarded-for'), req.socket.remoteAddress].filter(Boolean).join(', ');
    headers['x-forwarded-proto'] = req.protocol;
    if (req.access?.tenant) headers[this.naming.tenantHeader] = req.access.tenant.id;
    if (this.forward.principal && req.access) headers[this.naming.principalHeader] = `${req.access.caller.type}:${req.access.caller.key}`;
    if (this.forward.permissions && req.access?.tenant) {
      const { policy } = gatewayOptions();
      headers[this.naming.permissionsHeader] = req.access.permissions.filter((p) => policy.isServicePermission(p)).join(',');
    }
    if (req.requestId) headers['x-request-id'] = req.requestId;
    const metering = req.access?.metering;
    if (metering?.mode === 'upstream' && metering.exhausted) headers[this.naming.quotaExhaustedHeader] = '1';

    const target = new URL(req.originalUrl, this.upstream);
    const client = target.protocol === 'https:' ? https : http;
    const upstreamReq = client.request(target, { method: req.method, headers, agent: this.agent, timeout: 120_000 }, (up) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (!STRIP_RESPONSE.has(k) && k !== this.naming.billableUnitsHeader && v !== undefined) out[k] = v;
      }
      const status = up.statusCode ?? 502;
      const send = (quota?: Record<string, string>) => {
        res.status(status);
        res.set({ ...out, ...quota });
        up.pipe(res);
      };
      if (metering?.mode !== 'upstream') return send();
      const units = billableUnits(up.headers[this.naming.billableUnitsHeader]);
      req.billedUnits = units;
      void this.charge(req, units).then((state) => send(state && quotaHeaders(state, status === 429)));
    });
    upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('upstream timeout')));
    upstreamReq.on('error', (e) => {
      this.log.warn(`${req.method} ${target.pathname} → upstream error: ${e.message}`);
      if (!res.headersSent) res.status(502).json({ statusCode: 502, message: `${this.naming.serviceName} service unavailable` });
      else res.destroy();
    });
    req.on('aborted', () => upstreamReq.destroy());
    req.pipe(upstreamReq);
  }

  /** Charges an `'upstream'` call's units; the limit state to report (the guard's look when nothing was charged). */
  private async charge(req: GatewayRequest, units: number): Promise<ConsumeResult | undefined> {
    const a = req.access!;
    if (units <= 0 || !this.limits || !a.tenant) return a.metering?.state;
    return this.limits.charge(a.tenant.id, a.caller, units).catch((e: Error) => {
      this.log.warn(`could not charge ${units} unit(s) for ${req.method} ${a.endpoint}: ${e.message}`);
      return a.metering?.state;
    });
  }
}

/** The billable-units header as a whole number of units; anything else (missing, negative, garbage) is 0. */
export function billableUnits(value: string | string[] | undefined): number {
  const n = Number(Array.isArray(value) ? value[0] : value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1000) : 0;
}

/** Express paths for the upstream prefixes: `/orders` → `orders` and `orders/*path`. */
export function proxyPaths(prefixes: readonly string[]): string[] {
  return prefixes.flatMap((p) => {
    const bare = p.replace(/^\/+|\/+$/g, '');
    return [bare, `${bare}/*path`];
  });
}

/**
 * The proxy controller for one product. Route paths are decorator arguments, so the class is made per product,
 * from its upstream prefixes. Registered last: its routes are prefixes owned by the upstream, the others are
 * the gateway's own API.
 */
/** Which caller headers the proxy adds upstream (GatewayModuleOptions.forwardPrincipalHeader / forwardPermissionsHeader). */
export interface ForwardedHeaders { principal: boolean; permissions: boolean }

export function createProxyController(prefixes: readonly string[], naming: GatewayNaming, forward: ForwardedHeaders): Type {
  const paths = proxyPaths(prefixes);

  @ApiExcludeController()
  @Controller()
  class ProxyController {
    private readonly handler: ProxyHandler;

    constructor(config: ConfigService, limits: LimitsService) {
      this.handler = new ProxyHandler(config as unknown as ConfigService<AppConfig, true>, naming, forward, limits);
    }

    @ProxyRoute()
    @All(paths)
    forward(@Req() req: GatewayRequest, @Res() res: Response) {
      this.handler.handle(req, res);
    }
  }
  return ProxyController;
}
