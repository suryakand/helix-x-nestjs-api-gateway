/** Typed view over process.env. Every variable name is the same in every product; only the defaults differ. */
const str = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t.replace(/^['"]|['"]$/g, '') : undefined;
};
const num = (v: string | undefined, d: number): number => {
  const n = Number(str(v));
  return Number.isFinite(n) ? n : d;
};
const bool = (v: string | undefined, d: boolean): boolean => {
  const t = str(v)?.toLowerCase();
  return t === undefined ? d : ['1', 'true', 'yes', 'on'].includes(t);
};

/** A product's defaults for settings missing from the environment. Each names the variable that overrides it. */
export interface GatewayDefaults {
  /** GATEWAY_PORT. Default 3500. */
  port?: number;
  /** UPSTREAM_URL. Default http://localhost:3400. */
  upstreamUrl?: string;
  /** CORS_ORIGINS (comma-separated). Default http://localhost:5173. */
  corsOrigins?: string[];
  /** KEYCLOAK_ISSUER. Default http://localhost:8180/realms/acme-org. */
  keycloakIssuer?: string;
  /** KEYCLOAK_AUDIENCE: the resource-server client whose roles are the permissions. Default acme-org-api. */
  keycloakAudience?: string;
  /** KEYCLOAK_ADMIN_CLIENT_ID: the service account that drives the admin API. Default acme-org-admin. */
  keycloakAdminClientId?: string;
  /** M2M_CLIENT_PREFIX: clientId prefix of the M2M clients the gateway creates. Default acme-m2m. */
  m2mClientPrefix?: string;
  /** DATABASE_PATH (sqlite). Default data/gateway.sqlite. */
  databasePath?: string;
  /** DB_PORT. Default 5432. */
  databasePort?: number;
  /** DB_USERNAME, DB_PASSWORD and DB_NAME. Default gateway. */
  databaseUser?: string;
  databasePassword?: string;
  databaseName?: string;
  /** REDIS_URL. Default redis://localhost:6379. */
  redisUrl?: string;
}

/** The gateway's configuration, read from the environment with the product's defaults. */
export function readGatewayConfig(d: GatewayDefaults = {}, e: NodeJS.ProcessEnv = process.env) {
  const issuer = str(e.KEYCLOAK_ISSUER) ?? d.keycloakIssuer ?? 'http://localhost:8180/realms/acme-org';
  const realmUrl = /^(.*)\/realms\/([^/]+)\/?$/.exec(issuer);
  const issuerBase = realmUrl?.[1] ?? 'http://localhost:8180';
  const realm = realmUrl?.[2] ?? 'acme-org';
  return {
    port: num(e.GATEWAY_PORT, d.port ?? 3500),
    upstreamUrl: (str(e.UPSTREAM_URL) ?? d.upstreamUrl ?? 'http://localhost:3400').replace(/\/$/, ''),
    /** Express 'trust proxy' (number of hops, or false) so req.ip is the real client behind nginx/LB. */
    trustProxy: num(e.TRUST_PROXY, 0),
    corsOrigins: str(e.CORS_ORIGINS)?.split(',').map((s) => s.trim()).filter(Boolean) ?? d.corsOrigins ?? ['http://localhost:5173'],
    keycloak: {
      issuer,
      jwksUrl: str(e.KEYCLOAK_JWKS_URL) ?? `${issuer}/protocol/openid-connect/certs`,
      /** Token audience and the resource-server client whose client roles are the permissions. */
      audience: str(e.KEYCLOAK_AUDIENCE) ?? d.keycloakAudience ?? 'acme-org-api',
      platformAdminRole: str(e.KEYCLOAK_PLATFORM_ADMIN_ROLE) ?? 'platform-admin',
      /** Admin REST API (organizations, users, M2M clients), called with the admin service account. */
      admin: {
        url: (str(e.KEYCLOAK_ADMIN_URL) ?? issuerBase).replace(/\/$/, ''),
        realm,
        clientId: str(e.KEYCLOAK_ADMIN_CLIENT_ID) ?? d.keycloakAdminClientId ?? 'acme-org-admin',
        clientSecret: str(e.KEYCLOAK_ADMIN_CLIENT_SECRET) ?? '',
      },
      /** Public token endpoint handed to M2M callers (the issuer's, as seen from outside). */
      tokenUrl: `${issuer}/protocol/openid-connect/token`,
      m2mClientPrefix: str(e.M2M_CLIENT_PREFIX) ?? d.m2mClientPrefix ?? 'acme-m2m',
    },
    /**
     * How long an admin revocation (disable, remove, regroup, rotate) is remembered: at least the realm's access
     * token lifetime, so every token issued before it has expired by then.
     */
    revocationTtlSec: num(e.REVOCATION_TTL_SEC, 900),
    database: {
      /** postgres (default) or sqlite (a single file, for local runs without Docker). */
      type: (str(e.DATABASE_TYPE) === 'sqlite' ? 'sqlite' : 'postgres') as 'postgres' | 'sqlite',
      /** sqlite only; relative to the working directory. */
      path: str(e.DATABASE_PATH) ?? d.databasePath ?? 'data/gateway.sqlite',
      host: str(e.DB_HOST) ?? 'localhost',
      port: num(e.DB_PORT, d.databasePort ?? 5432),
      username: str(e.DB_USERNAME) ?? d.databaseUser ?? 'gateway',
      password: str(e.DB_PASSWORD) ?? d.databasePassword ?? 'gateway',
      name: str(e.DB_NAME) ?? d.databaseName ?? 'gateway',
      migrationsRun: bool(e.DB_MIGRATIONS_RUN, true),
    },
    redisUrl: str(e.REDIS_URL) ?? d.redisUrl ?? 'redis://localhost:6379',
    limits: {
      globalPerMin: num(e.GLOBAL_RATE_LIMIT_PER_MIN, 600),
      authFailPerMin: num(e.AUTH_FAIL_LIMIT_PER_MIN, 20),
      failOpen: bool(e.RATE_LIMIT_FAIL_OPEN, false),
    },
    usage: {
      flushMs: num(e.USAGE_FLUSH_MS, 1000),
      flushBatch: num(e.USAGE_FLUSH_BATCH, 500),
      maxBuffer: num(e.USAGE_MAX_BUFFER, 50000),
    },
  };
}

/** The gateway's configuration, as `ConfigService<AppConfig, true>` sees it. */
export type AppConfig = ReturnType<typeof readGatewayConfig>;
