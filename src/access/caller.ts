import { GatewayNaming } from '../options';
import { AccessPolicy } from './access-policy';
import { KeycloakClaims } from './jwt.verifier';

/** One tenant the caller may act in, with the permissions they hold there. */
export interface TenantGrant {
  /** The tenant id the upstream stores (organization attribute `<prefix>_tenant_id`). */
  tenantId: string;
  /** Keycloak organization id. */
  orgId: string;
  /** Organization alias = tenant slug ('' when only the id is known, e.g. an M2M token). */
  alias: string;
  permissions: string[];
  /** false = a platform admin acting outside their own tenants (logged, never metered). */
  member: boolean;
}

/** USER = a signed-in person, CLIENT = an M2M client_credentials token. */
export type PrincipalType = 'USER' | 'CLIENT';

/** Everything the gateway knows about a caller, read from one verified access token. */
export interface Caller {
  type: PrincipalType;
  /** Keycloak user id (a client's service-account user for CLIENT). */
  sub: string;
  /** USER: Keycloak user id; CLIENT: clientId. The key usage and limits are kept under. */
  key: string;
  /** Human-readable name for usage lists, captured at call time. */
  label: string;
  email?: string;
  name?: string;
  username?: string;
  /** Token issue time (seconds), compared with revocations. */
  issuedAt: number;
  /** Permissions that are not tied to one organization (top-level resource_access): platform roles. */
  global: string[];
  /** USER: the organizations in the token; CLIENT: exactly its own tenant. */
  tenants: TenantGrant[];
}

/** What {@link parseCaller} needs besides the claims. */
export interface CallerContext {
  /** The resource-server client whose roles are the permissions (KEYCLOAK_AUDIENCE). */
  apiClientId: string;
  naming: Pick<GatewayNaming, 'tenantClaim' | 'tenantIdClaim' | 'tenantIdAttribute'>;
  policy: Pick<AccessPolicy, 'isServicePermission'>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ResourceAccess = Record<string, { roles?: unknown } | undefined> | undefined;
const rolesOf = (ra: ResourceAccess, api: string): string[] => {
  const r = ra?.[api]?.roles;
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : [];
};
const first = (v: unknown): string | undefined => (Array.isArray(v) ? first(v[0]) : typeof v === 'string' ? v : undefined);

/**
 * Reads a Keycloak access token. Shapes (see the README, "Token claims"), with `<p>` the claim prefix:
 * - user, scope organization:* → `organization: { <alias>: { id, <p>_tenant_id: [..], groups, resource_access: { <api>: { roles } } } }`
 *   (organization group role mappings, composites expanded), plus top-level `resource_access` for realm-wide
 *   roles such as platform-admin's;
 * - M2M client → `<p>_tenant` (organization id), `<p>_tenant_id`, `azp` and its service account's
 *   `resource_access.<api>.roles`. Only service permissions count for clients.
 */
export function parseCaller(claims: KeycloakClaims, ctx: CallerContext): Caller {
  const { apiClientId, naming, policy } = ctx;
  const global = rolesOf(claims.resource_access as ResourceAccess, apiClientId);
  const base = { sub: claims.sub, issuedAt: typeof claims.iat === 'number' ? claims.iat : 0 };

  const orgClaim = claims[naming.tenantClaim];
  if (typeof orgClaim === 'string') {
    const clientId = claims.azp ?? '';
    const tenantId = first(claims[naming.tenantIdClaim]) ?? '';
    return {
      ...base,
      type: 'CLIENT',
      key: clientId,
      label: clientId,
      global: [],
      tenants: UUID.test(tenantId) && UUID.test(orgClaim)
        ? [{ tenantId, orgId: orgClaim, alias: '', permissions: global.filter((p) => policy.isServicePermission(p)), member: true }]
        : [],
    };
  }

  const tenants: TenantGrant[] = [];
  const orgs = claims.organization;
  if (orgs && typeof orgs === 'object' && !Array.isArray(orgs)) {
    for (const [alias, v] of Object.entries(orgs as Record<string, Record<string, unknown>>)) {
      const tenantId = first(v?.[naming.tenantIdAttribute]);
      const orgId = first(v?.id);
      if (!tenantId || !orgId || !UUID.test(tenantId)) continue; // not provisioned for this product (no tenant id)
      const own = rolesOf(v.resource_access as ResourceAccess, apiClientId);
      tenants.push({ tenantId, orgId, alias, permissions: [...new Set([...own, ...global])], member: true });
    }
  }
  const username = claims.preferred_username;
  return {
    ...base,
    type: 'USER',
    key: claims.sub,
    label: claims.name || username || claims.email || claims.sub,
    email: claims.email,
    name: claims.name,
    username,
    global,
    tenants,
  };
}
