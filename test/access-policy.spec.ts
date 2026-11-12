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

  it('groups service permissions by product and defaults the entitlements to every service permission', () => {
    expect(POLICY.products).toEqual({});
    expect(POLICY.defaultEntitlements).toEqual(POLICY.servicePermissions);
    const p = defineAccessPolicy({
      servicePermissions: ['a:read', 'b:read'], products: { a: ['a:read'], b: ['b:read'] }, defaultEntitlements: ['a:read'],
      routes: [], upstreamPrefixes: ['/a'],
    });
    expect(p.products).toEqual({ a: ['a:read'], b: ['b:read'] });
    expect(p.defaultEntitlements).toEqual(['a:read']);
  });

  it('refuses a product or default entitlement that is not a service permission, and a permission in two products', () => {
    const base = { servicePermissions: ['a:read'], routes: [], upstreamPrefixes: ['/a'] };
    expect(() => defineAccessPolicy({ ...base, products: { a: ['x:read' as 'a:read'] } })).toThrow(/not a service permission/);
    expect(() => defineAccessPolicy({ ...base, products: { a: ['a:read'], b: ['a:read'] } })).toThrow(/in products a and b/);
    expect(() => defineAccessPolicy({ ...base, defaultEntitlements: ['tenant:usage:read' as 'a:read'] })).toThrow(/default entitlement/);
  });

  it("meters tenant routes by their own mode, else the default ('request' unless set); platform routes never", () => {
    expect(POLICY.defaultMetering).toBe('request');
    expect(POLICY.meteringOf(POLICY.resolveRoute('GET', '/orders')!)).toBe('request');
    expect(POLICY.meteringOf(POLICY.resolveRoute('GET', '/orders/1/quote')!)).toBe('upstream');
    expect(POLICY.meteringOf(POLICY.resolveRoute('GET', '/catalog/categories')!)).toBe('none');
    expect(POLICY.meteringOf(POLICY.resolveRoute('GET', '/queue/tasks')!)).toBe('none');
    const free = defineAccessPolicy({
      servicePermissions: ['a:read'], upstreamPrefixes: ['/a'], defaultMetering: 'none',
      routes: [{ method: 'GET', pattern: '/a', permission: 'a:read' }, { method: 'GET', pattern: '/a/:id', permission: 'a:read', metering: 'upstream' }],
    });
    expect(free.meteringOf(free.resolveRoute('GET', '/a')!)).toBe('none');
    expect(free.meteringOf(free.resolveRoute('GET', '/a/1')!)).toBe('upstream');
  });

  it('refuses an unknown metering mode, and metering on a platform route', () => {
    const base = { servicePermissions: ['a:read'], upstreamPrefixes: ['/a'] };
    expect(() => defineAccessPolicy({ ...base, routes: [{ method: 'GET', pattern: '/a', permission: 'a:read', metering: 'sometimes' as 'none' }] }))
      .toThrow(/has metering sometimes/);
    expect(() => defineAccessPolicy({
      ...base, routes: [{ method: 'GET', pattern: '/a', permission: 'platform:usage:read', scope: 'platform', metering: 'request' as never }],
    })).toThrow(/platform routes are never metered/);
    expect(() => defineAccessPolicy({ ...base, routes: [], defaultMetering: 'free' as 'none' })).toThrow(/unknown default metering/);
  });
});
