# @helix-x/nestjs-api-gateway

A multi-tenant access gateway for NestJS, placed in front of one upstream service:

- **Keycloak organizations are the tenants.** People sign in with Keycloak. Systems use per-tenant M2M clients
  (`client_credentials`).
- **A route table is the API surface.** Every proxied endpoint names the permission it needs, and anything not
  listed returns 404. Permissions are client roles of one Keycloak resource-server client, granted through
  organization groups (`admins` / `members` / `viewers` → bundle roles).
- **Per-principal quotas and metering.** Each user and each client in a tenant has a rate limit (daily, weekly,
  monthly, fixed or unlimited). Every call is logged and rolled up per day.
- **An admin API over Keycloak.** It covers tenants, users, groups, M2M clients and secret rotation. Narrowing an
  admin's own access is refused, every change is audited, and tokens issued before a revocation stop working at once.
- **A streaming reverse proxy.** Request bodies go upstream untouched, and the gateway sets the tenant header the
  upstream trusts.

It began as ef-track's gateway and now serves several products. A product supplies only three things: its route
table, its claim and header names, and its defaults.

## Install

Until it is published, consumers install a packed tarball committed to their `vendor/` folder:

```bash
# in this repo
npm run pack:local                       # → dist/helix-x-nestjs-api-gateway-<version>.tgz
# in the consuming gateway
cp ../../helix-x-nestjs-api-gateway/dist/helix-x-nestjs-api-gateway-0.1.0.tgz vendor/
npm install ./vendor/helix-x-nestjs-api-gateway-0.1.0.tgz
```

Nest, TypeORM, class-validator, express and rxjs are **peer dependencies**, so there is one copy of Nest's metadata
per process. Install `pg` and/or `sqlite3` for the database you use. Node 22+.

## A product gateway in three files

`example/` is a complete one. Run it with the instructions in `example/README.md`.

```ts
// src/access-policy.ts: the API surface, and nothing else
import { defineAccessPolicy } from '@helix-x/nestjs-api-gateway';

export const policy = defineAccessPolicy({
  servicePermissions: ['orders:create', 'orders:read', 'catalog:read'],
  extraPlatformPermissions: ['platform:queue:work'],          // optional
  routes: [
    { method: 'GET', pattern: '/catalog', permission: 'catalog:read' },
    { method: 'GET', pattern: '/orders/:id', permission: 'orders:read' },
    { method: 'POST', pattern: '/orders', permission: 'orders:create' },
    { method: 'GET', pattern: '/queue/tasks', permission: 'platform:queue:work', scope: 'platform' },
  ],
  upstreamPrefixes: ['/catalog', '/orders', '/queue'],
});
```

```ts
// src/main.ts
import { bootstrapGateway, GatewayModule } from '@helix-x/nestjs-api-gateway';
import { policy } from './access-policy';

void bootstrapGateway(
  GatewayModule.forRoot({
    policy,
    naming: { serviceName: 'acme-orders', claimPrefix: 'acme' },
    defaults: { port: 3500, upstreamUrl: 'http://localhost:3400', keycloakAudience: 'acme-orders-api' },
  }),
  { title: 'Acme Orders API Gateway', description: 'Multi-tenant access to Acme Orders.' },
);
```

```ts
// src/migrate.ts: the migration CLI (npm run db:migrate / db:migrate -- status)
import { runMigrateCli } from '@helix-x/nestjs-api-gateway';
void runMigrateCli({ defaults: { databasePath: 'data/acme-gateway.sqlite' } });
```

`defineAccessPolicy` checks the table when it is built. A route whose permission is undeclared or has the wrong
scope, a pattern outside the upstream prefixes, or a permission declared twice makes it throw, so a bad table
fails at boot.

## Options (`GatewayModule.forRoot`)

| Option | Purpose |
|---|---|
| `policy` | The route table, from `defineAccessPolicy`. |
| `naming` | `serviceName`, `claimPrefix` and an optional `headerPrefix` (see below). |
| `forwardPrincipalHeader` | Also send `x-<prefix>-principal: USER:<sub>` / `CLIENT:<clientId>` upstream. Default false. |
| `defaults` | Defaults for ports, Keycloak ids, database and Redis. **The environment always wins.** |
| `extraPrincipalTypes` | Extra principal types listed by the usage API, e.g. `LEGACY` for old rows. |
| `entities` | Extra TypeORM entities, e.g. tables read only by the product's own scripts. |
| `migrations` | The product's own SQL migrations, applied after the gateway's (see below). |
| `imports`, `controllers`, `providers` | Extra Nest pieces. Controllers are registered before the proxy, and can inject every exported service (`KeycloakAdminService`, `TenantAuthz`, `AuditService`, `RevocationService`, `LimitsService`, …). |

`bootstrapGateway(module, { title, description, version?, mergeUpstreamDoc?, configure? })` sets up CORS, raw
bodies for proxied paths, validation, Swagger UI at `/api` (with the upstream's `/api-json` paths merged in) and
`GATEWAY_PORT`.

### Naming

Every product-specific name comes from the two prefixes. They are lower-case letters and digits only.

| Name | `claimPrefix: 'acme'` |
|---|---|
| M2M token claim with the organization id | `acme_tenant` |
| M2M token claim and organization attribute with the tenant id | `acme_tenant_id` |
| M2M client attribute naming its organization | `acme.tenant` |
| Protocol mapper names on M2M clients | `acme-tenant`, `acme-tenant-id` |
| Header carrying the tenant upstream | `x-acme-tenant-id` (`headerPrefix`) |
| Principal header (with `forwardPrincipalHeader`) | `x-acme-principal` |

The proxy strips client-sent copies of both headers, so only the gateway can set them. Use the same prefix as
the realm generator (`@helix-x/kc-realm-generator`, `claimPrefix` in its answers).

### Environment

The variable names are the same in every product: `GATEWAY_PORT`, `UPSTREAM_URL`, `TRUST_PROXY`, `CORS_ORIGINS`,
`KEYCLOAK_ISSUER`, `KEYCLOAK_JWKS_URL`, `KEYCLOAK_AUDIENCE`, `KEYCLOAK_PLATFORM_ADMIN_ROLE`, `KEYCLOAK_ADMIN_URL`,
`KEYCLOAK_ADMIN_CLIENT_ID`, `KEYCLOAK_ADMIN_CLIENT_SECRET`, `M2M_CLIENT_PREFIX`, `REVOCATION_TTL_SEC`,
`DATABASE_TYPE` (`postgres` | `sqlite`), `DATABASE_PATH`, `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`,
`DB_NAME`, `DB_MIGRATIONS_RUN`, `REDIS_URL`, `GLOBAL_RATE_LIMIT_PER_MIN`, `AUTH_FAIL_LIMIT_PER_MIN`,
`RATE_LIMIT_FAIL_OPEN`, `USAGE_FLUSH_MS`, `USAGE_FLUSH_BATCH` and `USAGE_MAX_BUFFER`. `readGatewayConfig` documents
each one.

`DATABASE_TYPE` is read when the package is imported, because column types depend on it. At that point the package
loads `.env` from the working directory itself (real environment variables win), so either place works. A `.env`
loaded later, for example from another path through `ConfigModule`, is too late.

## The access decision

The guard's whole decision is the pure `decideAccess`. It runs these steps in order:

1. extract the bearer token;
2. resolve the route (404 if unmapped);
3. verify the token against the realm's JWKS;
4. read the caller from the token;
5. resolve the tenant;
6. check revocations;
7. check the permission;
8. check the quota.

A route's scope changes the tenant and quota steps:

- `scope: 'tenant'` (the default) acts in one tenant. The caller sends `x-tenant-id` if they belong to several.
  The call is metered.
- `scope: 'platform'` acts across tenants. The permission must be held globally, there is no tenant and no
  metering, and only users may call it.

Platform admins holding `platform:tenants:access` may act in any tenant. Those calls are logged but not metered.

Gateway-owned permissions, the same in every product:

- tenant admin: `tenant:usage:read`, `tenant:users:read|manage`, `tenant:clients:read|manage`;
- platform: `platform:tenants:access|manage`, `platform:users:manage`, `platform:usage:read`.

## Schema migrations

The gateway's tables are `principal_limits`, `usage_logs`, `usage_daily` and `admin_audit`. They are created by
this package's `migrations/` (postgres, plus `sqlite/` twins), which record themselves in their **own ledger**,
`gateway_schema_migrations`. A product's migrations (`options.migrations.dir`) keep their own ledger,
`schema_migrations` by default. The two sets never share version numbers.

Both sets are applied at boot before TypeORM connects (`DB_MIGRATIONS_RUN`, default true), or by `runMigrateCli`.

**Adopting an existing database.** `001_gateway_core_schema` is idempotent and uses TypeORM's constraint names, so
it does nothing on a database that a copy of this gateway already built. It just records itself in the new ledger.
The product's old `schema_migrations` rows stay where they are.

The file rules are the same as ef-track's runner:

- names are `NNN_snake_case.sql`;
- files contain no `BEGIN` / `COMMIT`;
- the last statement inserts the file's own ledger row (`'self-recorded'`);
- in SQLite files, every statement ends with `;` at the end of a line;
- an applied file is never edited.

## Checking a realm against the policy

`@helix-x/kc-realm-generator` builds realms from a product template. Two framework-free checks keep that
template in step with the policy. Each returns a list of problems:

```ts
import { checkGeneratedRealm, checkRealmTemplate } from '@helix-x/nestjs-api-gateway';
import { policy } from '../src/access-policy';

const template = JSON.parse(readFileSync('docker/keycloak/realm-base.json', 'utf8').replaceAll('"acme-org-api"', '"acme-orders-api"'));
it('realm template matches the policy', () => expect(checkRealmTemplate(template, policy, 'acme-orders-api')).toEqual([]));
it('dev sample carries the template', () => expect(checkGeneratedRealm(sample, template, 'acme-orders-api')).toEqual([]));
```

## Design notes

- **One gateway per process.** `GatewayModule.forRoot` records its options module-wide (`configureGateway`). DTO
  decorators run when this package is imported, before those options exist, so the permission lists they validate
  and document are arrays held by reference and filled in at configuration. Both class-validator and Swagger read
  them later. `test/options.spec.ts` covers this.
- **Keycloak holds all access data.** The gateway stores only limits, usage and the audit trail. It never logs or
  stores a token or client secret: it returns a new secret once and forgets it.
- **Revocation.** An admin action that removes or narrows access calls `RevocationService.revoke`, so tokens
  issued before it fail at once (Redis, `REVOCATION_TTL_SEC`).

## Development

```bash
npm install
npm run typecheck && npm test && npm run build
npx typedoc --treatWarningsAsErrors
npx tsc -p example --noEmit
```

The tests are pure (no network) and use an Acme policy (`test/fixtures/acme.ts`). The same specs used to live in
each product's gateway. See `RELEASING.md` for packing and publishing.
