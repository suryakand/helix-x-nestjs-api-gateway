import { BadRequestException, ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import { OrgDirectory } from '../keycloak/org-directory.service';
import { LimitsService } from '../metering/limits.service';
import { gatewayOptions } from '../options';
import { resolveTenant, restrictGrant, revocationKeys } from './access-decision';
import { GatewayPermission } from './access-policy';
import { TenantGrant } from './caller';
import { AccessContext } from './request-context';
import { RevocationService } from './revocation.service';

/** Platform permissions that stand in for a tenant permission in any tenant the caller may access. */
const PLATFORM_EQUIVALENT: Partial<Record<string, string>> = { 'tenant:usage:read': 'platform:usage:read' };

/**
 * Permission checks for the gateway's own API. The same rules as proxied calls (resolveTenant, restrictGrant):
 * permissions come from the token, per tenant, narrowed by the tenant's entitlements and per-user choices; a
 * revocation made through the gateway since the token was issued applies. The grant's permissions are also what
 * an admin may hand on (clients, users), so nobody can grant beyond the tenant's entitlements.
 */
@Injectable()
export class TenantAuthz {
  constructor(private readonly orgs: OrgDirectory, private readonly revocations: RevocationService, private readonly limits: LimitsService) {}

  /** The caller's grant in tenant `tenantId`, which must include `permission`. */
  async require(a: AccessContext, tenantId: string, permission: GatewayPermission | (string & {})): Promise<TenantGrant> {
    const t = await resolveTenant(a.caller, tenantId, { orgById: (id) => this.orgs.byId(id), orgByTenantId: (id) => this.orgs.byTenantId(id) });
    if (!t.ok) throw t.status === 400 ? new BadRequestException(t.message) : new ForbiddenException(t.message);
    const before = await this.revocations.revokedBefore(revocationKeys(a.caller, tenantId));
    if (before !== undefined && a.caller.issuedAt <= before) {
      throw new HttpException({ statusCode: 401, message: 'token revoked; get a new token' }, 401);
    }
    const grant = await this.restrict(a, t.grant);
    const alt = PLATFORM_EQUIVALENT[permission];
    if (!grant.permissions.includes(permission) && !(alt && a.caller.global.includes(alt))) {
      throw new ForbiddenException(`missing permission ${permission} in this tenant`);
    }
    return grant;
  }

  /** {@link restrictGrant} with the gateway's own lookups. */
  restrict(a: AccessContext, grant: TenantGrant): Promise<TenantGrant> {
    return restrictGrant(a.caller, grant, {
      policy: gatewayOptions().policy,
      orgById: (id) => this.orgs.byId(id),
      allowedPermissions: (tid, caller) => this.limits.allowedPermissions(tid, caller),
    });
  }

  /** A permission that is not tied to a tenant (platform:*), from the token's top-level roles. */
  requireGlobal(a: AccessContext, permission: GatewayPermission | (string & {})): void {
    if (!a.caller.global.includes(permission)) throw new ForbiddenException(`missing permission ${permission}`);
  }
}
