/**
 * Permissions are client roles of the Keycloak resource-server client (KEYCLOAK_AUDIENCE, e.g. `acme-org-api`).
 * Keycloak owns who holds which permission in which tenant (organization groups → bundle roles). The policy owns
 * only the API surface: which permission each proxied upstream endpoint needs. Pure and table-driven: a new
 * upstream endpoint is unreachable through the gateway until it gets a route rule (default deny).
 *
 * The tenant-admin and platform permissions below belong to the gateway's own API and are the same in every
 * product. The service permissions, the route table and the upstream prefixes come from the product, through
 * {@link defineAccessPolicy}.
 *
 * Adding a permission = a client role in Keycloak (the product's realm-base.json), its name in the product's
 * policy, and the bundles (tenant-admin / tenant-member / tenant-viewer composites) that should include it.
 */

/** Permissions of the gateway's tenant admin API. */
export const TENANT_ADMIN_PERMISSIONS = [
  'tenant:usage:read',
  'tenant:users:read',
  'tenant:users:manage',
  'tenant:clients:read',
  'tenant:clients:manage',
] as const;

/** Platform permissions of the gateway's own API. A product can add more with `extraPlatformPermissions`. */
export const PLATFORM_PERMISSIONS = [
  /** Act in any tenant (x-tenant-id / :tid) with the caller's other permissions, unmetered outside their own. */
  'platform:tenants:access',
  'platform:tenants:manage',
  'platform:users:manage',
  'platform:usage:read',
] as const;

/** A permission of the gateway's tenant admin API. */
export type TenantAdminPermission = (typeof TENANT_ADMIN_PERMISSIONS)[number];
/** A platform permission of the gateway's own API. */
export type CorePlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];
/** A permission the gateway's own API checks. */
export type GatewayPermission = TenantAdminPermission | CorePlatformPermission;

/** Organization groups every tenant gets, each mapped to one bundle role (a composite of permissions). */
export const TENANT_GROUPS = { admins: 'tenant-admin', members: 'tenant-member', viewers: 'tenant-viewer' } as const;
/** One of the organization groups every tenant gets. */
export type TenantGroup = keyof typeof TENANT_GROUPS;
/** The group names of {@link TENANT_GROUPS}, in order. */
export const TENANT_GROUP_NAMES = Object.keys(TENANT_GROUPS) as TenantGroup[];

/**
 * One proxied endpoint and the permission it needs.
 *
 * - scope `'tenant'` (default): the call acts in one tenant, needs a service permission there and is metered.
 * - scope `'platform'`: the call spans tenants (e.g. a staff work queue), needs a platform permission globally,
 *   is never metered and carries no tenant upstream. Users only.
 *
 * Patterns use `:params` for single path segments. Static segments win over params.
 */
export type RouteRule<S extends string = string, P extends string = string> =
  | { method: string; pattern: string; permission: S; scope?: 'tenant' }
  | { method: string; pattern: string; permission: P; scope: 'platform' };

/** What a product declares; see {@link defineAccessPolicy}. */
export interface AccessPolicyInput<S extends string, P extends string> {
  /** Permissions of the upstream service: the only ones an M2M client can hold. */
  servicePermissions: readonly S[];
  /** Platform permissions beyond {@link PLATFORM_PERMISSIONS}, for `scope: 'platform'` routes. */
  extraPlatformPermissions?: readonly P[];
  /** Every proxied endpoint. Anything not listed is a 404 through the gateway. */
  routes: readonly RouteRule<S, P | CorePlatformPermission>[];
  /** Path prefixes the gateway forwards upstream, e.g. `/orders`. Everything else is the gateway's own API. */
  upstreamPrefixes: readonly string[];
}

/** A product's access policy, ready for `GatewayModule.forRoot`. Build it with {@link defineAccessPolicy}. */
export interface AccessPolicy<S extends string = string, P extends string = string> {
  /** Permissions of the upstream service. */
  readonly servicePermissions: readonly S[];
  /** Core and product platform permissions. */
  readonly platformPermissions: readonly (CorePlatformPermission | P)[];
  /** Every permission: service, tenant admin and platform, in that order. */
  readonly permissions: readonly string[];
  /** The route table (methods upper-cased). */
  readonly routes: readonly RouteRule<S, P | CorePlatformPermission>[];
  /** Path prefixes forwarded upstream, each with one leading slash and none trailing. */
  readonly upstreamPrefixes: readonly string[];
  /** Resolves method + path (no query string) to its rule; undefined means "deny". Trailing slash tolerated. */
  resolveRoute(method: string, path: string): RouteRule<S, P | CorePlatformPermission> | undefined;
  /** True for a path the gateway forwards upstream. */
  isUpstream(path: string): boolean;
  /** True for one of the service permissions. */
  isServicePermission(s: string): s is S;
}

function matches(pattern: string, path: string): boolean {
  const p = pattern.split('/');
  const s = path.split('/');
  if (p.length !== s.length) return false;
  return p.every((seg, i) => (seg.startsWith(':') ? s[i].length > 0 : seg === s[i]));
}

/**
 * Builds a product's access policy and checks it: every route's permission must be declared with the right
 * scope, and every pattern must sit under an upstream prefix. Throws on a mistake, so a bad table fails at boot.
 *
 * @example
 * ```ts
 * export const policy = defineAccessPolicy({
 *   servicePermissions: ['orders:read', 'orders:create'],
 *   routes: [
 *     { method: 'GET', pattern: '/orders/:id', permission: 'orders:read' },
 *     { method: 'POST', pattern: '/orders', permission: 'orders:create' },
 *   ],
 *   upstreamPrefixes: ['/orders'],
 * });
 * ```
 */
export function defineAccessPolicy<const S extends string, const P extends string = never>(
  input: AccessPolicyInput<S, P>,
): AccessPolicy<S, P> {
  const servicePermissions: readonly S[] = [...input.servicePermissions];
  const platformPermissions: readonly (CorePlatformPermission | P)[] = [...PLATFORM_PERMISSIONS, ...(input.extraPlatformPermissions ?? [])];
  const permissions: readonly string[] = [...servicePermissions, ...TENANT_ADMIN_PERMISSIONS, ...platformPermissions];
  const prefixes = input.upstreamPrefixes.map((p) => `/${p.replace(/^\/+|\/+$/g, '')}`);
  const routes = input.routes.map((r) => ({ ...r, method: r.method.toUpperCase() }));

  const dup = permissions.find((p, i) => permissions.indexOf(p) !== i);
  if (dup) throw new Error(`access policy: permission ${dup} is declared twice`);
  const isUpstream = (path: string) => prefixes.some((p) => path === p || path.startsWith(`${p}/`));
  for (const r of routes) {
    const platform = r.scope === 'platform';
    const known = (platform ? platformPermissions : servicePermissions) as readonly string[];
    if (!known.includes(r.permission)) {
      throw new Error(`access policy: ${r.method} ${r.pattern} needs ${r.permission}, which is not a ${platform ? 'platform' : 'service'} permission`);
    }
    if (!isUpstream(r.pattern)) throw new Error(`access policy: ${r.method} ${r.pattern} is not under an upstream prefix`);
  }

  return {
    servicePermissions,
    platformPermissions,
    permissions,
    routes,
    upstreamPrefixes: prefixes,
    resolveRoute(method, path) {
      const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
      const m = method.toUpperCase();
      // Static segments win over params.
      const candidates = routes.filter((r) => r.method === m && matches(r.pattern, clean));
      candidates.sort((a, b) => a.pattern.split(':').length - b.pattern.split(':').length);
      return candidates[0];
    },
    isUpstream,
    isServicePermission: (s: string): s is S => (servicePermissions as readonly string[]).includes(s),
  };
}
