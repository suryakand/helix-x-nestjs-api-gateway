import { checkClientPermissions, checkGroupChange, checkKeepsAdmin, checkUserPermissions } from '../src/tenancy/admin-guard';
import { POLICY } from './fixtures/acme';

const isService = (p: string) => POLICY.isServicePermission(p);

const MEMBER = ['orders:read', 'catalog:read', 'tenant:usage:read'];
const ADMIN = [...MEMBER, 'orders:create', 'tenant:users:manage', 'tenant:clients:manage'];

describe('admin guard', () => {
  it('a group can only be assigned or changed by someone holding all of its permissions', () => {
    expect(checkGroupChange(ADMIN, [MEMBER, ADMIN])).toBeNull();
    expect(checkGroupChange(MEMBER, [ADMIN])).toMatch(/orders:create/);
  });

  it('clients get service permissions only, and only ones the admin holds', () => {
    expect(checkClientPermissions(ADMIN, ['orders:read', 'orders:create'], isService)).toBeNull();
    expect(checkClientPermissions(ADMIN, ['tenant:users:manage'], isService)).toMatch(/only hold service/);
    expect(checkClientPermissions(ADMIN, ['platform:tenants:access'], isService)).toMatch(/only hold service/);
    expect(checkClientPermissions(MEMBER, ['orders:create'], isService)).toMatch(/don't hold/);
  });

  it('the last admin cannot be demoted or removed', () => {
    expect(checkKeepsAdmin(['a'], 'a', false)).toMatch(/at least one admin/);
    expect(checkKeepsAdmin(['a', 'b'], 'a', false)).toBeNull();
    expect(checkKeepsAdmin(['a'], 'b', false)).toBeNull();
    expect(checkKeepsAdmin(['a'], 'a', true)).toBeNull();
  });

  it('a user can be narrowed to service permissions the admin holds, nothing else', () => {
    expect(checkUserPermissions(ADMIN, ['orders:read'], isService)).toBeNull();
    expect(checkUserPermissions(ADMIN, [], isService)).toBeNull();
    expect(checkUserPermissions(ADMIN, ['tenant:users:manage'], isService)).toMatch(/only be narrowed to service/);
    expect(checkUserPermissions(['orders:read'], ['orders:create'], isService)).toMatch(/don't hold/);
  });
});
