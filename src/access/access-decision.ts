import { ConsumeResult } from '../metering/rate-limiter.service';
import { AccessPolicy, RouteRule } from './access-policy';
import { Caller, CallerContext, parseCaller, TenantGrant } from './caller';
import { KeycloakClaims } from './jwt.verifier';
import { AccessContext } from './request-context';

/**
 * The guard's decision sequence, free of Nest/HTTP so it can be tested with fakes:
 * extract → verify token → caller → tenant → revocation → permission → quota.
 *
 * Every permission comes from the token (Keycloak is the only source of authorization data). The gateway
 * narrows it (never widens it) by the tenant's entitlements (an organization attribute) and, for a user, by the
 * permissions an admin allowed them (its database), and adds revocations made through its admin API since the
 * token was issued (Redis) and usage limits (its database).
 */
export type RouteMode = 'proxy' | 'jwt-only' | 'any';

/** What the gateway can find out about an organization (cached Keycloak lookup). */
export interface OrgInfo {
  orgId: string;
  tenantId: string;
  alias: string;
  name: string;
  enabled: boolean;
  /**
   * Service permissions the tenant may use, from its `<prefix>_entitlements` attribute; null when it has none
   * (then the policy's `defaultEntitlements` apply).
   */
  entitlements: string[] | null;
}

/** Attribute value meaning "no service permissions at all" (an attribute can't hold an empty list). */
export const NO_ENTITLEMENTS = '-';

/** An entitlements attribute's values as permissions; undefined (no attribute) → null. */
export function parseEntitlements(values: readonly string[] | undefined): string[] | null {
  return values ? values.filter((v) => v && v !== NO_ENTITLEMENTS) : null;
}

/** The attribute values that store `permissions` (see {@link parseEntitlements}). */
export function entitlementValues(permissions: readonly string[]): string[] {
  return permissions.length ? [...new Set(permissions)] : [NO_ENTITLEMENTS];
}

/**
 * A caller's permissions in a tenant after the gateway's narrowing. Only service permissions are narrowed:
 * one is kept when the tenant is entitled to it (`entitlements`, or the policy's defaults when null) and, when
 * `allowed` is given (an admin's per-user choice), when it is in `allowed` too. Tenant admin, platform and
 * bundle roles pass through unchanged. Pure.
 */
export function effectivePermissions(
  permissions: readonly string[],
  policy: Pick<AccessPolicy, 'isServicePermission' | 'defaultEntitlements'>,
  entitlements: readonly string[] | null,
  allowed: readonly string[] | null,
): string[] {
  const entitled = new Set(entitlements ?? policy.defaultEntitlements);
  const permitted = allowed ? new Set(allowed) : null;
  return permissions.filter((p) => !policy.isServicePermission(p) || (entitled.has(p) && (!permitted || permitted.has(p))));
}

/** The decision's inputs besides the request: the product's policy and naming, and every I/O as a function. */
export interface AccessPorts extends CallerContext {
  policy: AccessPolicy;
  verifyJwt(token: string): Promise<KeycloakClaims>;
  /** Latest "revoked before" time (epoch seconds) among these revocation keys; undefined = none. */
  revokedBefore(keys: string[]): Promise<number | undefined>;
  orgById(orgId: string): Promise<OrgInfo | null>;
  orgByTenantId(tenantId: string): Promise<OrgInfo | null>;
  /** The service permissions an admin allowed this user in this tenant; null = no narrowing. */
  allowedPermissions(tenantId: string, caller: Caller): Promise<string[] | null>;
  consume(tenantId: string, caller: Caller): Promise<ConsumeResult>;
  /** The caller's limit without charging it (`'upstream'` routes); `allowed` false = already spent. */
  peek(tenantId: string, caller: Caller): Promise<ConsumeResult>;
}

export interface AccessInput {
  mode: RouteMode;
  method: string;
  /** Path without query string. */
  path: string;
  authorization?: string;
  /** Only to explain that API keys are retired. */
  apiKey?: string;
  tenantHeader?: string;
}

/** HTTP status of a refusal. */
export type DenyStatus = 400 | 401 | 403 | 404 | 429 | 503;
export type AccessOutcome =
  | { ok: true; access: AccessContext; quota?: ConsumeResult }
  | {
      ok: false; status: DenyStatus; message: string; authFailure?: boolean; quota?: ConsumeResult;
      /** Who was identified before the refusal, so rejected calls are still attributed in usage logs. */
      identified?: AccessContext;
    };

export type TenantResolution = { ok: true; grant: TenantGrant } | { ok: false; status: 400 | 403; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const deny = (status: DenyStatus, message: string, extra: Partial<Extract<AccessOutcome, { ok: false }>> = {}): AccessOutcome =>
  ({ ok: false, status, message, ...extra });

/** Revocation keys that apply to a caller, optionally within one tenant. */
export function revocationKeys(caller: Caller, tenantId?: string): string[] {
  const keys = caller.type === 'CLIENT' ? [`client:${caller.key}`] : [`user:${caller.key}`];
  if (tenantId) keys.push(`tenant:${tenantId}`, `member:${tenantId}:${caller.key}`);
  return keys;
}

/**
 * Which tenant the call acts in and with which permissions. Shared by proxied calls (x-tenant-id) and the
 * admin API (:tid). A client is always in its own tenant; a user picks one of the organizations in their
 * token, or — holding platform:tenants:access — any existing, enabled tenant, with their global permissions.
 */
export async function resolveTenant(
  caller: Caller, requested: string | undefined, ports: Pick<AccessPorts, 'orgById' | 'orgByTenantId'>,
): Promise<TenantResolution> {
  if (requested !== undefined && !UUID.test(requested)) return { ok: false, status: 400, message: 'tenant id must be a uuid' };

  if (caller.type === 'CLIENT') {
    const grant = caller.tenants[0];
    if (!grant) return { ok: false, status: 403, message: 'client is not bound to a tenant (tenant claims missing)' };
    if (requested && requested !== grant.tenantId) return { ok: false, status: 403, message: 'clients can only act in their own tenant' };
    // Keycloak keeps issuing tokens with the hardcoded claims, so tenant status is checked here.
    const org = await ports.orgById(grant.orgId);
    if (!org || org.tenantId !== grant.tenantId) return { ok: false, status: 403, message: 'client is bound to an unknown tenant' };
    if (!org.enabled) return { ok: false, status: 403, message: 'tenant is suspended' };
    return { ok: true, grant: { ...grant, alias: org.alias } };
  }

  const own = requested ? caller.tenants.find((t) => t.tenantId === requested) : caller.tenants.length === 1 ? caller.tenants[0] : undefined;
  if (own) return { ok: true, grant: own };
  if (requested && caller.global.includes('platform:tenants:access')) {
    const org = await ports.orgByTenantId(requested);
    if (!org) return { ok: false, status: 403, message: 'unknown tenant' };
    if (!org.enabled) return { ok: false, status: 403, message: 'tenant is suspended' };
    return { ok: true, grant: { tenantId: org.tenantId, orgId: org.orgId, alias: org.alias, permissions: caller.global, member: false } };
  }
  if (requested) return { ok: false, status: 403, message: 'not a member of this tenant' };
  return caller.tenants.length
    ? { ok: false, status: 400, message: 'x-tenant-id header required (member of several tenants)' }
    : { ok: false, status: 403, message: 'not a member of any tenant' };
}

/**
 * A grant from {@link resolveTenant} with the gateway's narrowing applied ({@link effectivePermissions}): the
 * tenant's entitlements for everyone, and an admin's per-user choice for a member user. A platform admin acting
 * outside their own tenants keeps their global permissions, limited only by the tenant's entitlements.
 */
export async function restrictGrant(
  caller: Caller, grant: TenantGrant, ports: Pick<AccessPorts, 'policy' | 'orgById' | 'allowedPermissions'>,
): Promise<TenantGrant> {
  const [org, allowed] = await Promise.all([
    ports.orgById(grant.orgId).catch(() => null),
    caller.type === 'USER' && grant.member ? ports.allowedPermissions(grant.tenantId, caller) : Promise.resolve(null),
  ]);
  return { ...grant, permissions: effectivePermissions(grant.permissions, ports.policy, org?.entitlements ?? null, allowed) };
}

export async function decideAccess(input: AccessInput, ports: AccessPorts): Promise<AccessOutcome> {
  // 1. Extraction
  const bearer = /^Bearer\s+(.+)$/i.exec(input.authorization ?? '')?.[1]?.trim();
  if (input.apiKey?.trim()) {
    return deny(401, 'API keys are retired: get a token from Keycloak with your client id and secret (client_credentials) and send Authorization: Bearer');
  }
  if (!bearer) return deny(401, 'missing credentials (Authorization: Bearer <Keycloak access token>)');

  // Route → permission first, so unknown upstream routes are refused before any quota is spent.
  let rule: RouteRule | undefined;
  if (input.mode === 'proxy') {
    rule = ports.policy.resolveRoute(input.method, input.path);
    if (!rule) return deny(404, 'endpoint not available through the gateway');
  }
  const endpoint = rule?.pattern;
  const needed = rule?.permission;

  // 2. Authentication
  let claims: KeycloakClaims;
  try {
    claims = await ports.verifyJwt(bearer);
  } catch {
    return deny(401, 'invalid or expired token', { authFailure: true });
  }
  const caller = parseCaller(claims, ports);
  const authType = caller.type === 'CLIENT' ? 'CLIENT' : 'JWT';
  if (caller.type === 'CLIENT' && input.mode === 'jwt-only') {
    return deny(403, 'clients cannot call the management API; sign in as a user instead');
  }

  // 3. Management API and other tenant-less routes: identity + revocation only; controllers check permissions.
  if (input.mode !== 'proxy') {
    if (await revoked(caller, undefined, ports)) return deny(401, 'token revoked; get a new token');
    return { ok: true, access: { authType, caller, permissions: caller.global } };
  }

  // 3b. Platform-scoped upstream routes (operator queue): no tenant, a global permission, never metered.
  if (rule?.scope === 'platform') {
    if (caller.type === 'CLIENT') return deny(403, 'clients cannot call platform routes; sign in as a user instead');
    if (await revoked(caller, undefined, ports)) return deny(401, 'token revoked; get a new token');
    const access: AccessContext = { authType, caller, permissions: caller.global, endpoint };
    if (!caller.global.includes(rule.permission)) return deny(403, `missing permission ${rule.permission}`, { identified: access });
    return { ok: true, access };
  }

  // 4. Tenant
  const header = input.tenantHeader?.trim() || undefined;
  const t = await resolveTenant(caller, caller.type === 'CLIENT' ? undefined : header, ports);
  if (!t.ok) return deny(t.status, t.message);
  const grant = await restrictGrant(caller, t.grant, ports);
  const access: AccessContext = {
    authType, caller, tenant: { id: grant.tenantId, orgId: grant.orgId, alias: grant.alias }, member: grant.member,
    permissions: grant.permissions, endpoint,
  };

  // 5. Revocation (admin actions through the gateway apply before the token expires)
  if (await revoked(caller, grant.tenantId, ports)) return deny(401, 'token revoked; get a new token', { identified: access });

  // 6. Permission
  if (needed && !grant.permissions.includes(needed)) {
    return deny(403, `missing permission ${needed} in tenant ${grant.alias || grant.tenantId}`, { identified: access });
  }

  // 7. Quota: members and clients are metered as the route says; a platform admin outside their tenants is only logged.
  const mode = grant.member && rule ? ports.policy.meteringOf(rule) : 'none';
  if (mode === 'none') return { ok: true, access: { ...access, metering: { mode } } };
  if (mode === 'upstream') {
    // Not charged here: the upstream reports what the call cost, and the proxy charges it afterwards. A spent
    // limit is passed on rather than refused, so the upstream can still answer what costs it nothing.
    const state = await ports.peek(grant.tenantId, caller);
    if (state.degraded && !state.allowed) return deny(503, 'rate limiter unavailable, try again shortly', { identified: access });
    return { ok: true, access: { ...access, metering: { mode, exhausted: !state.allowed, state } } };
  }
  const quota = await ports.consume(grant.tenantId, caller);
  if (quota.allowed) return { ok: true, access: { ...access, metering: { mode } }, quota };
  const who = caller.type === 'CLIENT' ? 'client' : 'user';
  return quota.degraded
    ? deny(503, 'rate limiter unavailable, try again shortly', { quota, identified: access })
    : deny(429, quota.remaining === 0 && quota.resetsAt === undefined ? `${who} quota exhausted` : `${who} rate limit exceeded`, { quota, identified: access });
}

async function revoked(caller: Caller, tenantId: string | undefined, ports: Pick<AccessPorts, 'revokedBefore'>): Promise<boolean> {
  const before = await ports.revokedBefore(revocationKeys(caller, tenantId));
  return before !== undefined && caller.issuedAt <= before;
}
