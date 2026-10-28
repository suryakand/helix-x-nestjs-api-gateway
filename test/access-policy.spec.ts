import { defineAccessPolicy, PLATFORM_PERMISSIONS, TENANT_ADMIN_PERMISSIONS } from '../src/access/access-policy';
import { POLICY } from './fixtures/acme';

describe('access policy', () => {
  it.each([
    ['GET', '/catalog', 'catalog:read', '/catalog'],
    ['POST', '/orders', 'orders:create', '/orders'],
    ['GET', '/orders', 'orders:read', '/orders'],
    ['GET', '/orders/', 'orders:read', '/orders'],
    ['get', '/orders/abc', 'orders:read', '/orders/:id'],
    ['GET', '/orders/summary', 'orders:read', '/orders/summary'],
    ['GET', '/orders/abc/documents/invoice', 'orders:read', '/orders/:id/documents/:doc'],
    ['GET', '/queue/tasks', 'platform:queue:work', '/queue/tasks'],
    ['POST', '/queue/tasks/abc/claim', 'platform:queue:work', '/queue/tasks/:id/claim'],
  ])('%s %s → %s', (method, path, permission, pattern) => {
    expect(POLICY.resolveRoute(method, path)).toMatchObject({ permission, pattern });
  });

  it.each([
    ['DELETE', '/orders/123'],
    ['PUT', '/orders/123'],
    ['GET', '/orders/a/b'],
    ['POST', '/catalog'],
    ['DELETE', '/queue/tasks/1'],
    ['GET', '/health'],
    ['GET', '/admin'],
  ])('denies unmapped %s %s', (method, path) => {
    expect(POLICY.resolveRoute(method, path)).toBeUndefined();
  });

  it('lists service, tenant-admin and platform permissions, core and extra', () => {
    expect(POLICY.permissions).toEqual([
      'orders:create', 'orders:read', 'catalog:read', ...TENANT_ADMIN_PERMISSIONS, ...PLATFORM_PERMISSIONS, 'platform:queue:work',
    ]);
    expect(POLICY.isServicePermission('orders:read')).toBe(true);
    expect(POLICY.isServicePermission('tenant:users:read')).toBe(false);
  });

  it('normalises upstream prefixes and matches whole segments', () => {
    expect(POLICY.upstreamPrefixes).toEqual(['/catalog', '/orders', '/queue']);
    expect(POLICY.isUpstream('/orders')).toBe(true);
    expect(POLICY.isUpstream('/orders/1')).toBe(true);
    expect(POLICY.isUpstream('/ordersx')).toBe(false);
    expect(POLICY.isUpstream('/tenants')).toBe(false);
  });

  it('refuses a route whose permission is undeclared, of the wrong scope, or outside the prefixes', () => {
    const base = { servicePermissions: ['a:read'], upstreamPrefixes: ['/a'] };
    expect(() => defineAccessPolicy({ ...base, routes: [{ method: 'GET', pattern: '/a', permission: 'b:read' as 'a:read' }] }))
      .toThrow(/not a service permission/);
    expect(() => defineAccessPolicy({ ...base, routes: [{ method: 'GET', pattern: '/a', permission: 'platform:usage:read', scope: 'platform' }] }))
      .not.toThrow();
    expect(() => defineAccessPolicy({ ...base, routes: [{ method: 'GET', pattern: '/a', permission: 'a:read', scope: 'platform' }] }))
      .toThrow(/not a platform permission/);
    expect(() => defineAccessPolicy({ ...base, routes: [{ method: 'GET', pattern: '/b', permission: 'a:read' }] }))
      .toThrow(/not under an upstream prefix/);
    expect(() => defineAccessPolicy({ ...base, servicePermissions: ['tenant:users:read'], routes: [] })).toThrow(/declared twice/);
  });
});
