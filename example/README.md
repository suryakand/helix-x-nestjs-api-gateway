# Example: Acme Orders gateway

A complete product gateway is three small files: the policy (`src/access-policy.ts`), the module
(`src/app.module.ts`) and the entry point (`src/main.ts`). `src/migrate.ts` is the migration CLI and
`src/upstream.ts` a stand-in upstream for trying it out.

```bash
# from the package root, with Redis on :6379 (Keycloak is only needed for real tokens)
npx ts-node example/src/upstream.ts &
DATABASE_TYPE=sqlite npx ts-node example/src/main.ts
curl localhost:3900/health                 # gateway, database, redis, upstream
curl -i localhost:3900/orders              # 401: no token
open http://localhost:3900/api             # gateway API + the upstream's /orders, merged
```

Type-check with `npx tsc -p example --noEmit`.

The policy declares two products, `catalog` and `orders`. A tenant without entitlements of its own gets only
`catalog:read` (`defaultEntitlements`); a platform admin enables orders with
`PATCH /tenants/:tid { "entitlements": ["catalog:read", "orders:read", "orders:create"] }`. A tenant admin can then
narrow one user further: `PATCH /tenants/:tid/users/:id { "allowedPermissions": ["orders:read"] }`. The stand-in
upstream echoes `x-acme-permissions`, the effective service permissions the gateway forwarded.
