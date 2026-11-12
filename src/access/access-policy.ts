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
 * How a tenant route counts against the caller's usage limit.
 *
 * - `'request'`: every allowed call costs 1, charged by the guard before it is proxied (refused with 429 when the
 *   limit is spent). The behaviour before metering modes existed, and the default.
 * - `'upstream'`: the upstream decides. The guard only looks at the limit and, when it is spent, tells the
 *   upstream (`x-<prefix>-quota-exhausted: 1`) instead of refusing, so the upstream can still serve what costs it
 *   nothing (a cached answer). The upstream answers `x-<prefix>-billable-units: <n>` and the gateway charges n
 *   after the response (missing = 0). For routes whose cost is a paid call the upstream may or may not make.
 * - `'none'`: never charged (still logged in usage). For reads of data the upstream already holds.
 */
export const METERING_MODES = ['request', 'upstream', 'none'] as const;
/** One of {@link METERING_MODES}. */
export type MeteringMode = (typeof METERING_MODES)[number];

/**
 * One proxied endpoint and the permission it needs.
 *
 * - scope `'tenant'` (default): the call acts in one tenant, needs a service permission there and is metered
 *   according to `metering` (default: the policy's `defaultMetering`).
 * - scope `'platform'`: the call spans tenants (e.g. a staff work queue), needs a platform permission globally,
 *   is never metered and carries no tenant upstream. Users only.
 *
 * Patterns use `:params` for single path segments. Static segments win over params.
 */
export type RouteRule<S extends string = string, P extends string = string> =
  | { method: string; pattern: string; permission: S; scope?: 'tenant'; metering?: MeteringMode }
  | { method: string; pattern: string; permission: P; scope: 'platform'; metering?: never };

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
  /**
   * Service permissions grouped by product, e.g. `{ orders: [...], catalog: [...] }`, for admin screens that let
   * an admin enable a whole product. Each permission may appear in at most one product. Optional.
   */
  products?: Readonly<Record<string, readonly S[]>>;
  /**
   * The service permissions a tenant may use when no platform admin has set its entitlements (the organization
   * has no `<prefix>_entitlements` attribute). Default: every service permission, the behaviour before
   * entitlements existed. List fewer to make a product opt-in per tenant.
   */
  defaultEntitlements?: readonly S[];
  /**
   * How a tenant route without its own `metering` counts against usage limits. Default `'request'` (every call
   * costs 1). A product that bills only some routes sets `'none'` here and marks those routes, so a route added
   * later is free until it is classified.
   */
  defaultMetering?: MeteringMode;
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
  /** Service permissions by product (empty when the product declares none). */
  readonly products: Readonly<Record<string, readonly S[]>>;
  /** Service permissions of a tenant without entitlements of its own. */
  readonly defaultEntitlements: readonly S[];
  /** Metering of tenant routes that don't set their own. */
  readonly defaultMetering: MeteringMode;
  /** A route's metering: its own, else the default; `'none'` for platform routes. */
  meteringOf(rule: RouteRule<S, P | CorePlatformPermission>): MeteringMode;
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
    if (r.metering !== undefined && (platform || !METERING_MODES.includes(r.metering))) {
      throw new Error(`access policy: ${r.method} ${r.pattern} has metering ${String(r.metering)}${platform ? ' (platform routes are never metered)' : ''}`);
    }
  }
  const defaultMetering: MeteringMode = input.defaultMetering ?? 'request';
  if (!METERING_MODES.includes(defaultMetering)) throw new Error(`access policy: unknown default metering ${String(defaultMetering)}`);
  const isService = (p: string) => (servicePermissions as readonly string[]).includes(p);
  const products: Record<string, readonly S[]> = {};
  const productOf = new Map<string, string>();
  for (const [name, list] of Object.entries(input.products ?? {})) {
    for (const p of list) {
      if (!isService(p)) throw new Error(`access policy: product ${name} lists ${p}, which is not a service permission`);
      const other = productOf.get(p);
      if (other) throw new Error(`access policy: ${p} is in products ${other} and ${name}`);
      productOf.set(p, name);
    }
    products[name] = [...list];
  }
  const defaultEntitlements: readonly S[] = [...(input.defaultEntitlements ?? servicePermissions)];
  const bad = defaultEntitlements.find((p) => !isService(p));
  if (bad) throw new Error(`access policy: default entitlement ${bad} is not a service permission`);

  return {
    servicePermissions,
    platformPermissions,
    permissions,
    routes,
    upstreamPrefixes: prefixes,
    products,
    defaultEntitlements,
    defaultMetering,
    meteringOf: (r) => (r.scope === 'platform' ? 'none' : (r.metering ?? defaultMetering)),
    resolveRoute(method, path) {
      const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
      const m = method.toUpperCase();
      // Static segments win over params.
      const candidates = routes.filter((r) => r.method === m && matches(r.pattern, clean));
      candidates.sort((a, b) => a.pattern.split(':').length - b.pattern.split(':').length);
      return candidates[0];
    },
    isUpstream,
    isServicePermission: (s: string): s is S => isService(s),
  };
}
