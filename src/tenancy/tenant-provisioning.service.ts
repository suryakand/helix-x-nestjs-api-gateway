import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TENANT_GROUP_NAMES, TENANT_GROUPS, TenantGroup } from '../access/access-policy';
import { KcGroup, KcOrganization, KeycloakAdminService } from '../keycloak/keycloak-admin.service';
import { PermissionCatalog } from '../keycloak/permission-catalog.service';

export type TenantGroupIds = Record<TenantGroup, string>;

export interface GroupState { name: TenantGroup; group: KcGroup | null; bundle: string; roleMapped: boolean }

/**
 * Makes an organization a tenant: it needs a `<prefix>_tenant_id` attribute (the id the upstream stores) and
 * the organization groups admins / members / viewers, each mapped to its bundle role. Idempotent, so it also
 * repairs organizations created in the Keycloak console (scripts/sync-to-keycloak.ts runs it for all).
 */
@Injectable()
export class TenantProvisioning {
  private readonly log = new Logger(TenantProvisioning.name);

  constructor(private readonly kc: KeycloakAdminService, private readonly catalog: PermissionCatalog) {}

  async create(name: string, slug: string, tenantId: string = randomUUID()): Promise<KcOrganization> {
    if ((await this.kc.listOrganizations()).some((o) => o.alias === slug)) {
      throw new ConflictException(`an organization with alias "${slug}" already exists`);
    }
    const orgId = await this.kc.createOrganization({ name, alias: slug, enabled: true, attributes: { [this.kc.naming.tenantIdAttribute]: [tenantId] } });
    await this.ensureGroups(orgId);
    const org = await this.kc.getOrganization(orgId);
    if (!org) throw new NotFoundException('organization vanished after create');
    return org;
  }

  /** Adds a tenant id attribute when the organization has none. Returns the tenant id. */
  async ensureTenantId(org: KcOrganization, preferred?: string): Promise<string> {
    const current = org.attributes?.[this.kc.naming.tenantIdAttribute]?.[0];
    if (current) return current;
    const tenantId = preferred ?? randomUUID();
    await this.kc.updateOrganization(org.id, { attributes: { [this.kc.naming.tenantIdAttribute]: [tenantId] } });
    return tenantId;
  }

  /** Read-only: each tenant group, whether it exists and grants its bundle. */
  async inspectGroups(orgId: string): Promise<GroupState[]> {
    const { apiUuid } = await this.catalog.get();
    const existing = await this.kc.organizationGroups(orgId);
    return Promise.all(TENANT_GROUP_NAMES.map(async (name) => {
      const group = existing.find((g) => g.name === name) ?? null;
      const bundle = TENANT_GROUPS[name];
      const roleMapped = group ? (await this.kc.organizationGroupClientRoles(orgId, group.id, apiUuid)).some((r) => r.name === bundle) : false;
      return { name, group, bundle, roleMapped };
    }));
  }

  /** Makes an existing organization a complete tenant (tenant id attribute + groups). Returns its tenant id. */
  async provision(org: KcOrganization): Promise<string> {
    const tenantId = await this.ensureTenantId(org);
    await this.ensureGroups(org.id);
    return tenantId;
  }

  /** The three groups with their bundle role, created or repaired as needed. */
  async ensureGroups(orgId: string): Promise<TenantGroupIds> {
    const { apiUuid } = await this.catalog.get();
    const existing = await this.kc.organizationGroups(orgId);
    const ids = {} as TenantGroupIds;
    for (const name of TENANT_GROUP_NAMES) {
      const id = existing.find((g) => g.name === name)?.id ?? (await this.kc.createOrganizationGroup(orgId, name));
      ids[name] = id;
      const bundle = TENANT_GROUPS[name];
      const mapped = await this.kc.organizationGroupClientRoles(orgId, id, apiUuid);
      if (!mapped.some((r) => r.name === bundle)) {
        const roles = await this.catalog.roles([bundle]);
        if (!roles.length) this.log.warn(`bundle role ${bundle} is missing from Keycloak; group ${name} grants nothing`);
        await this.kc.addOrganizationGroupClientRoles(orgId, id, apiUuid, roles);
      }
    }
    return ids;
  }
}
