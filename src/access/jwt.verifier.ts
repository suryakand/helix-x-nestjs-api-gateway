import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, JWTPayload, jwtVerify } from 'jose';
import { AppConfig } from '../config/configuration';

export interface KeycloakClaims extends JWTPayload {
  sub: string;
  preferred_username?: string;
  email?: string;
  name?: string;
  realm_access?: { roles?: string[] };
  /** Roles per client; the resource-server client's roles are the permissions. */
  resource_access?: unknown;
  /** Client the token was issued to (an M2M client's clientId). */
  azp?: string;
  /** User tokens requested with scope organization:* — per organization: id, attributes, groups, roles. */
  organization?: unknown;
  /**
   * Everything else, notably the M2M tenant claims `<prefix>_tenant` (organization id) and `<prefix>_tenant_id`
   * (the tenant id the upstream stores), added by the client's hardcoded-claim mappers.
   */
  [claim: string]: unknown;
}

/** Verifies Keycloak access tokens against the realm JWKS (fetched once, refreshed by jose on unknown kid). */
@Injectable()
export class JwtVerifier {
  private readonly jwks;
  private readonly kc: AppConfig['keycloak'];

  constructor(config: ConfigService<AppConfig, true>) {
    this.kc = config.get('keycloak', { infer: true });
    this.jwks = createRemoteJWKSet(new URL(this.kc.jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 });
  }

  /** Throws on any invalid token (signature, expiry, issuer, audience). */
  async verify(token: string): Promise<KeycloakClaims> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.kc.issuer,
      audience: this.kc.audience,
      algorithms: ['RS256', 'ES256', 'PS256'],
    });
    if (!payload.sub) throw new Error('token has no sub');
    return payload as KeycloakClaims;
  }
}
