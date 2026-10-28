import { AccessInput, AccessPorts, decideAccess, OrgInfo } from '../src/access/access-decision';
import { Caller } from '../src/access/caller';
import { KeycloakClaims } from '../src/access/jwt.verifier';
import { ConsumeResult } from '../src/metering/rate-limiter.service';
import { API, NAMING, POLICY } from './fixtures/acme';

const ACME = { orgId: 'aaaaaaaa-1111-4111-8111-111111111111', tenantId: '11111111-1111-4111-8111-111111111111', alias: 'acme', name: 'Acme', enabled: true };
const GLOBEX = { orgId: 'bbbbbbbb-2222-4222-8222-222222222222', tenantId: '22222222-2222-4222-8222-222222222222', alias: 'globex', name: 'Globex', enabled: true };
const MEMBER = ['tenant-member', 'orders:create', 'orders:read', 'catalog:read', 'tenant:usage:read'];
const VIEWER = ['tenant-viewer', 'orders:read', 'catalog:read'];
const PLATFORM = ['platform-admin', 'platform:tenants:access', 'platform:tenants:manage', 'platform:queue:work', ...MEMBER];

const org = (o: OrgInfo, roles: string[]) => ({ id: o.orgId, acme_tenant_id: [o.tenantId], groups: ['/x'], resource_access: { [API]: { roles } } });

/** Tokens by name; anything else fails verification. */
const TOKENS: Record<string, KeycloakClaims> = {
  bob: { sub: 'u-bob', iat: 1000, preferred_username: 'bob', organization: { acme: org(ACME, MEMBER), globex: org(GLOBEX, VIEWER) } },
  alice: { sub: 'u-alice', iat: 1000, preferred_username: 'alice', organization: { acme: org(ACME, MEMBER) } },
  nobody: { sub: 'u-none', iat: 1000 },
  admin: { sub: 'u-admin', iat: 1000, resource_access: { [API]: { roles: PLATFORM } } },
  m2m: { sub: 'sa-1', iat: 1000, azp: 'acme-m2m-acme-erp', acme_tenant: ACME.orgId, acme_tenant_id: ACME.tenantId, resource_access: { [API]: { roles: ['orders:read', 'platform:tenants:manage'] } } },
};

function ports(over: { orgs?: OrgInfo[]; revoked?: Record<string, number>; quota?: ConsumeResult } = {}) {
  const orgs = over.orgs ?? [ACME, GLOBEX];
  const p = {
    consumed: [] as string[],
    apiClientId: API,
    policy: POLICY,
    naming: NAMING,
    verifyJwt: async (t: string) => {
      const c = TOKENS[t];
      if (!c) throw new Error('bad');
      return c;
    },
    revokedBefore: async (keys: string[]) => {
      const ts = keys.map((k) => over.revoked?.[k]).filter((x): x is number => x !== undefined);
      return ts.length ? Math.max(...ts) : undefined;
    },
    orgById: async (id: string) => orgs.find((o) => o.orgId === id) ?? null,
    orgByTenantId: async (id: string) => orgs.find((o) => o.tenantId === id) ?? null,
    consume: async (tid: string, c: Caller) => {
      p.consumed.push(`${tid}|${c.type}|${c.key}`);
      return over.quota ?? { allowed: true, limit: 10, remaining: 9 };
    },
  };
  return p as AccessPorts & { consumed: string[] };
}

const call = (token: string, over: Partial<AccessInput> = {}): AccessInput =>
  ({ mode: 'proxy', method: 'GET', path: '/orders', authorization: `Bearer ${token}`, ...over });

describe('decideAccess', () => {
  it('401 without credentials; retired API keys get an explanation; bad token is an auth failure', async () => {
    expect(await decideAccess({ mode: 'proxy', method: 'GET', path: '/orders' }, ports())).toMatchObject({ ok: false, status: 401 });
    const r = await decideAccess({ mode: 'proxy', method: 'GET', path: '/orders', apiKey: 'eft_live_x' }, ports());
    expect(!r.ok && r.message).toMatch(/retired/);
    expect(await decideAccess(call('forged'), ports())).toMatchObject({ ok: false, status: 401, authFailure: true });
  });

  it('unmapped upstream route is 404 before anything is spent', async () => {
    const p = ports();
    expect(await decideAccess(call('m2m', { method: 'POST', path: '/orders/1/delete-all' }), p)).toMatchObject({ ok: false, status: 404 });
    expect(p.consumed).toEqual([]);
  });

  describe('user: permissions per tenant come from the token', () => {
    it('member in acme may place an order; viewer in globex may not', async () => {
      const del = { method: 'POST', path: '/orders' };
      expect(await decideAccess(call('bob', { ...del, tenantHeader: ACME.tenantId }), ports()))
        .toMatchObject({ ok: true, access: { authType: 'JWT', tenant: { id: ACME.tenantId, alias: 'acme' }, member: true } });
      expect(await decideAccess(call('bob', { ...del, tenantHeader: GLOBEX.tenantId }), ports()))
        .toMatchObject({ ok: false, status: 403, identified: { tenant: { id: GLOBEX.tenantId } } });
    });

    it('one tenant is implicit; several need x-tenant-id; none is 403; a foreign tenant is 403', async () => {
      expect(await decideAccess(call('alice'), ports())).toMatchObject({ ok: true, access: { tenant: { id: ACME.tenantId } } });
      expect(await decideAccess(call('bob'), ports())).toMatchObject({ ok: false, status: 400 });
      expect(await decideAccess(call('nobody'), ports())).toMatchObject({ ok: false, status: 403 });
      expect(await decideAccess(call('alice', { tenantHeader: GLOBEX.tenantId }), ports())).toMatchObject({ ok: false, status: 403 });
      expect(await decideAccess(call('alice', { tenantHeader: 'nope' }), ports())).toMatchObject({ ok: false, status: 400 });
    });

    it('members are metered under their Keycloak id', async () => {
      const p = ports();
      await decideAccess(call('alice'), p);
      expect(p.consumed).toEqual([`${ACME.tenantId}|USER|u-alice`]);
      expect(await decideAccess(call('alice'), ports({ quota: { allowed: false, limit: 5, remaining: 0, resetsAt: new Date() } })))
        .toMatchObject({ ok: false, status: 429 });
      expect(await decideAccess(call('alice'), ports({ quota: { allowed: false, degraded: true } }))).toMatchObject({ ok: false, status: 503 });
    });

    it('platform admin acts in any existing, enabled tenant with global permissions, unmetered', async () => {
      const p = ports();
      expect(await decideAccess(call('admin', { method: 'POST', path: '/orders', tenantHeader: GLOBEX.tenantId }), p))
        .toMatchObject({ ok: true, access: { member: false, tenant: { id: GLOBEX.tenantId } } });
      expect(p.consumed).toEqual([]);
      expect(await decideAccess(call('admin', { tenantHeader: '99999999-9999-4999-8999-999999999999' }), ports())).toMatchObject({ ok: false, status: 403 });
      expect(await decideAccess(call('admin', { tenantHeader: GLOBEX.tenantId }), ports({ orgs: [ACME, { ...GLOBEX, enabled: false }] })))
        .toMatchObject({ ok: false, status: 403 });
    });

    it('revocations through the gateway void earlier tokens (user, membership, tenant)', async () => {
      for (const key of ['user:u-alice', `member:${ACME.tenantId}:u-alice`, `tenant:${ACME.tenantId}`]) {
        expect(await decideAccess(call('alice'), ports({ revoked: { [key]: 1000 } }))).toMatchObject({ ok: false, status: 401 });
      }
      // A token issued after the revocation passes.
      expect(await decideAccess(call('alice'), ports({ revoked: { 'user:u-alice': 999 } }))).toMatchObject({ ok: true });
      // A membership revocation in another tenant doesn't matter.
      expect(await decideAccess(call('alice'), ports({ revoked: { [`member:${GLOBEX.tenantId}:u-alice`]: 2000 } }))).toMatchObject({ ok: true });
    });

    it('management API: identity only, plus account revocation', async () => {
      expect(await decideAccess({ mode: 'jwt-only', method: 'GET', path: '/me', authorization: 'Bearer bob' }, ports()))
        .toMatchObject({ ok: true, access: { caller: { type: 'USER', key: 'u-bob' } } });
      expect(await decideAccess({ mode: 'jwt-only', method: 'GET', path: '/me', authorization: 'Bearer bob' }, ports({ revoked: { 'user:u-bob': 1000 } })))
        .toMatchObject({ ok: false, status: 401 });
    });
  });

  describe('M2M client', () => {
    it('acts in its own tenant only, with its own service permissions; metered by clientId', async () => {
      const p = ports();
      expect(await decideAccess(call('m2m', { tenantHeader: GLOBEX.tenantId }), p))
        .toMatchObject({ ok: true, access: { authType: 'CLIENT', tenant: { id: ACME.tenantId, alias: 'acme' }, permissions: ['orders:read'] } });
      expect(p.consumed).toEqual([`${ACME.tenantId}|CLIENT|acme-m2m-acme-erp`]);
      expect(await decideAccess(call('m2m', { method: 'POST', path: '/orders' }), ports())).toMatchObject({ ok: false, status: 403 });
    });

    it('suspended or unknown tenant, or a mismatched tenant id, is 403', async () => {
      expect(await decideAccess(call('m2m'), ports({ orgs: [{ ...ACME, enabled: false }] }))).toMatchObject({ ok: false, status: 403 });
      expect(await decideAccess(call('m2m'), ports({ orgs: [GLOBEX] }))).toMatchObject({ ok: false, status: 403 });
      expect(await decideAccess(call('m2m'), ports({ orgs: [{ ...ACME, tenantId: GLOBEX.tenantId }] }))).toMatchObject({ ok: false, status: 403 });
    });

    it('revoked client tokens are refused; clients cannot use the management API', async () => {
      expect(await decideAccess(call('m2m'), ports({ revoked: { 'client:acme-m2m-acme-erp': 1000 } }))).toMatchObject({ ok: false, status: 401 });
      expect(await decideAccess({ mode: 'jwt-only', method: 'GET', path: '/me', authorization: 'Bearer m2m' }, ports()))
        .toMatchObject({ ok: false, status: 403 });
    });
  });

  describe('platform-scoped routes (work queue)', () => {
    const op = (token: string) => call(token, { method: 'POST', path: '/queue/tasks/1/claim' });

    it('need the permission globally; no tenant, never metered', async () => {
      const p = ports();
      const r = await decideAccess(op('admin'), p);
      expect(r).toMatchObject({ ok: true, access: { authType: 'JWT', endpoint: '/queue/tasks/:id/claim' } });
      expect(r.ok && r.access.tenant).toBeUndefined();
      expect(p.consumed).toEqual([]);
    });

    it('tenant permissions do not count, and clients are refused', async () => {
      expect(await decideAccess(op('bob'), ports())).toMatchObject({ ok: false, status: 403 });
      expect(await decideAccess(op('m2m'), ports())).toMatchObject({ ok: false, status: 403 });
    });

    it('a revoked account is refused', async () => {
      expect(await decideAccess(op('admin'), ports({ revoked: { 'user:u-admin': 1000 } }))).toMatchObject({ ok: false, status: 401 });
    });
  });
});
