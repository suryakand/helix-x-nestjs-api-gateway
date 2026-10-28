import { parseCaller } from '../src/access/caller';
import { API, NAMING, POLICY } from './fixtures/acme';

const CTX = { apiClientId: API, naming: NAMING, policy: POLICY };
const ORG = 'a1c0ffee-0000-4000-8000-00000000ac01';
const TENANT = '7e1a0000-0000-4000-8000-00000000ac01';

describe('parseCaller', () => {
  it('reads per-organization permissions (organization:* with group role mappings) and adds global ones', () => {
    // Shape captured from Keycloak 26.7 (ef-track's realm), with the claim prefix acme.
    const c = parseCaller({
      sub: 'u1', iat: 5, preferred_username: 'bob', name: 'Bob Reader',
      resource_access: { [API]: { roles: ['platform:usage:read'] }, account: { roles: ['view-profile'] } },
      organization: {
        acme: { acme_tenant_id: [TENANT], id: ORG, groups: ['/members'], resource_access: { [API]: { roles: ['tenant-member', 'orders:read'] } } },
        unprovisioned: { id: 'b1c0ffee-0000-4000-8000-00000000ac01', groups: [] },
      },
    }, CTX);
    expect(c).toMatchObject({ type: 'USER', key: 'u1', label: 'Bob Reader', issuedAt: 5, global: ['platform:usage:read'] });
    expect(c.tenants).toEqual([
      { tenantId: TENANT, orgId: ORG, alias: 'acme', member: true, permissions: ['tenant-member', 'orders:read', 'platform:usage:read'] },
    ]);
  });

  it('a token without the organization scope has no tenants', () => {
    expect(parseCaller({ sub: 'u1' }, CTX).tenants).toEqual([]);
  });

  it('M2M client: its one tenant from hardcoded claims, service permissions only', () => {
    const c = parseCaller({
      sub: 'sa', azp: 'acme-m2m-acme-erp', acme_tenant: ORG, acme_tenant_id: TENANT,
      resource_access: { [API]: { roles: ['orders:read', 'tenant:users:manage', 'platform:tenants:access'] } },
    }, CTX);
    expect(c).toMatchObject({ type: 'CLIENT', key: 'acme-m2m-acme-erp', global: [] });
    expect(c.tenants).toEqual([{ tenantId: TENANT, orgId: ORG, alias: '', member: true, permissions: ['orders:read'] }]);
  });

  it('M2M client with malformed tenant claims has no tenant', () => {
    expect(parseCaller({ sub: 'sa', azp: 'x', acme_tenant: 'not-a-uuid', acme_tenant_id: TENANT }, CTX).tenants).toEqual([]);
  });
});
