import { TENANT_ADMIN_PERMISSIONS } from '../src/access/access-policy';
import { checkGeneratedRealm, checkRealmTemplate, RealmJson } from '../src/testing/realm-check';
import { API, POLICY } from './fixtures/acme';

const plain = (name: string) => ({ name, composite: false });
const bundle = (name: string, perms: string[]) => ({ name, composite: true, composites: { client: { [API]: perms } } });

/** A template that matches the Acme policy, built the way realm-base.json files are. */
function template(): RealmJson {
  return {
    roles: {
      realm: [bundle('platform-admin', [...POLICY.platformPermissions, 'tenant-admin'])],
      client: {
        [API]: [
          ...POLICY.permissions.map(plain),
          bundle('tenant-admin', [...POLICY.servicePermissions, ...TENANT_ADMIN_PERMISSIONS]),
          bundle('tenant-member', ['orders:create', 'orders:read', 'catalog:read', 'tenant:usage:read']),
          bundle('tenant-viewer', ['orders:read', 'catalog:read']),
        ],
      },
    },
    clientScopes: [{ name: 'organization' }],
  };
}

describe('realm checks', () => {
  it('a template that matches the policy has no problems', () => {
    expect(checkRealmTemplate(template(), POLICY, API)).toEqual([]);
  });

  it('reports missing and extra permissions, wrong bundles and wrong admin roles', () => {
    const t = template();
    const roles = t.roles!.client![API];
    roles.splice(roles.findIndex((r) => r.name === 'catalog:read'), 1);
    roles.push(plain('orders:delete'));
    roles.find((r) => r.name === 'tenant-viewer')!.composites!.client![API].push('platform:queue:work');
    t.roles!.realm![0].composites!.client![API] = ['tenant-admin'];
    const problems = checkRealmTemplate(t, POLICY, API);
    expect(problems.join('\n')).toMatch(/missing \[catalog:read\], not in the policy \[orders:delete\]/);
    expect(problems.join('\n')).toMatch(/tenant-viewer holds platform permission platform:queue:work/);
    expect(problems.join('\n')).toMatch(/platform-admin should hold/);
    expect(checkRealmTemplate(t, POLICY, 'other-api')).toEqual(['realm has no client roles for other-api']);
  });

  it('a generated realm must carry the template and map every group to its bundle', () => {
    const t = template();
    const groups = [
      { name: 'admins', clientRoles: { [API]: ['tenant-admin'] } },
      { name: 'members', clientRoles: { [API]: ['tenant-member'] } },
      { name: 'viewers', clientRoles: { [API]: ['tenant-viewer'] } },
    ];
    const good = { ...template(), organizations: [{ alias: 'acme', groups }] };
    expect(checkGeneratedRealm(good, t, API)).toEqual([]);
    const bad = { ...template(), clientScopes: [], organizations: [{ alias: 'acme', groups: groups.slice(0, 2) }] };
    expect(checkGeneratedRealm(bad, t, API)).toEqual([
      'client scopes differ from the template (regenerate the realm)',
      'organization acme does not map admins / members / viewers to their bundles',
    ]);
  });
});
