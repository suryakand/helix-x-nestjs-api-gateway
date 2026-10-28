import { Request } from 'express';
import { Caller } from './caller';

/** What UnifiedAccessGuard attaches to the request. Downstream code reads this, never the raw credentials. */
export interface AccessContext {
  /** JWT = a signed-in user, CLIENT = an M2M client_credentials token. */
  authType: 'JWT' | 'CLIENT';
  caller: Caller;
  /** Set for proxied tenant-scoped calls once the tenant is resolved. */
  tenant?: { id: string; orgId: string; alias: string };
  /** false = platform admin outside their own tenants (logged, not metered). */
  member?: boolean;
  /** Permissions in that tenant (proxied calls), or the caller's global permissions (management API). */
  permissions: string[];
  /** Route template of a proxied call, used for metering, e.g. /orders/:id. */
  endpoint?: string;
}

export interface GatewayRequest extends Request {
  access?: AccessContext;
  startedAt?: number;
  requestId?: string;
}
