import { Injectable, Logger } from '@nestjs/common';
import { OrgInfo } from '../access/access-decision';
import { InvalidationService } from '../redis/invalidation.service';
import { gatewayOptions } from '../options';
import { KcOrganization, KeycloakAdminService } from './keycloak-admin.service';

const CACHE_MS = 60_000;
const CACHE_MAX = 5_000;

/** The tenant behind an organization, or null when it has no tenant id attribute (not provisioned). */
export function orgInfo(o: KcOrganization, tenantIdAttribute = gatewayOptions().naming.tenantIdAttribute): OrgInfo | null {
  const tenantId = o.attributes?.[tenantIdAttribute]?.[0];
  return tenantId ? { orgId: o.id, tenantId, alias: o.alias, name: o.name, enabled: o.enabled } : null;
}

/**
 * Cached organization lookups, for the few calls whose token doesn't already say everything: M2M clients
 * (Keycloak keeps issuing their hardcoded tenant claim, so suspension is checked here), platform admins acting
 * in someone else's tenant, and the admin pages' tenant names. Users' own tenants come from their token.
 */
@Injectable()
export class OrgDirectory {
  private readonly log = new Logger(OrgDirectory.name);
  private readonly cache = new Map<string, { org: OrgInfo | null; at: number }>();

  constructor(private readonly kc: KeycloakAdminService, private readonly invalidation: InvalidationService) {
    invalidation.on('org', (orgId) => {
      for (const [k, v] of this.cache) if (!v.org || v.org.orgId === orgId) this.cache.delete(k);
    });
  }

  byId(orgId: string): Promise<OrgInfo | null> {
    return this.cached(`id:${orgId}`, async () => {
      const o = await this.kc.getOrganization(orgId);
      return o ? orgInfo(o) : null;
    });
  }

  byTenantId(tenantId: string): Promise<OrgInfo | null> {
    return this.cached(`t:${tenantId}`, async () => {
      const o = await this.kc.findOrganizationByTenantId(tenantId);
      return o ? orgInfo(o) : null;
    });
  }

  /** After a change made through the gateway, on every instance. */
  invalidate(orgId: string) {
    return this.invalidation.publish('org', orgId);
  }

  private async cached(key: string, load: () => Promise<OrgInfo | null>): Promise<OrgInfo | null> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.org;
    let org: OrgInfo | null;
    try {
      org = await load();
    } catch (e) {
      // Keycloak down: keep serving the last answer rather than refusing every M2M call.
      this.log.warn(`organization lookup ${key} failed: ${(e as Error).message}`);
      if (hit) return hit.org;
      throw e;
    }
    this.cache.set(key, { org, at: Date.now() });
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    return org;
  }
}
