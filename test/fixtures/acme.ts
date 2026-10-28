import { defineAccessPolicy } from '../../src/access/access-policy';
import { resolveNaming } from '../../src/options';

/** A fictional product: orders and a catalog per tenant, plus a staff work queue across tenants. */
export const POLICY = defineAccessPolicy({
  servicePermissions: ['orders:create', 'orders:read', 'catalog:read'],
  extraPlatformPermissions: ['platform:queue:work'],
  routes: [
    { method: 'GET', pattern: '/catalog', permission: 'catalog:read' },
    { method: 'POST', pattern: '/orders', permission: 'orders:create' },
    { method: 'GET', pattern: '/orders', permission: 'orders:read' },
    { method: 'GET', pattern: '/orders/:id', permission: 'orders:read' },
    { method: 'GET', pattern: '/orders/:id/documents/:doc', permission: 'orders:read' },
    { method: 'GET', pattern: '/orders/summary', permission: 'orders:read' },
    { method: 'GET', pattern: '/queue/tasks', permission: 'platform:queue:work', scope: 'platform' },
    { method: 'POST', pattern: '/queue/tasks/:id/claim', permission: 'platform:queue:work', scope: 'platform' },
    { method: 'POST', pattern: '/queue/tasks/:id/complete', permission: 'platform:queue:work', scope: 'platform' },
  ],
  upstreamPrefixes: ['/catalog', '/orders', 'queue/'],
});

export const NAMING = resolveNaming({ serviceName: 'acme-orders', claimPrefix: 'acme' });
export const API = 'acme-org-api';
