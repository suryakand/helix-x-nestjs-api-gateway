import { defineAccessPolicy } from '../../src';

/**
 * Acme Orders: what a product writes. Every proxied endpoint and the permission it needs; anything else under
 * the upstream prefixes is a 404 through the gateway. The permissions must match the realm template's client
 * roles (checkRealmTemplate).
 */
export const policy = defineAccessPolicy({
  servicePermissions: ['orders:create', 'orders:read', 'catalog:read'],
  extraPlatformPermissions: ['platform:queue:work'],
  routes: [
    { method: 'GET', pattern: '/catalog', permission: 'catalog:read' },
    { method: 'GET', pattern: '/orders', permission: 'orders:read' },
    { method: 'GET', pattern: '/orders/:id', permission: 'orders:read' },
    { method: 'POST', pattern: '/orders', permission: 'orders:create' },
    { method: 'GET', pattern: '/queue/tasks', permission: 'platform:queue:work', scope: 'platform' },
  ],
  upstreamPrefixes: ['/catalog', '/orders', '/queue'],
  // Two products a platform admin can switch on per tenant (PATCH /tenants/:tid { entitlements }). Catalog is on
  // for every tenant without entitlements of its own; orders must be enabled explicitly.
  products: { catalog: ['catalog:read'], orders: ['orders:create', 'orders:read'] },
  defaultEntitlements: ['catalog:read'],
});
