import { Body, Controller, DefaultValuePipe, Get, NotFoundException, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { TENANT_ADMIN_PERMISSIONS, TENANT_GROUP_NAMES, TENANT_GROUPS } from '../access/access-policy';
import { Access, JwtOnly } from '../access/decorators';
import { AccessContext } from '../access/request-context';
import { RevocationService } from '../access/revocation.service';
import { TenantAuthz } from '../access/tenant-authz.service';
import { AppConfig } from '../config/configuration';
import { KeycloakAdminService } from '../keycloak/keycloak-admin.service';
import { gatewayOptions } from '../options';
import { OrgDirectory, orgInfo } from '../keycloak/org-directory.service';
import { PermissionCatalog } from '../keycloak/permission-catalog.service';
import { AuditService } from './audit.service';
import {
  AuditEntryDto, CreateTenantDto, MeDto, OrganizationGroupDto, PermissionCatalogDto, TenantDto, UnprovisionedOrganizationDto, UpdateTenantDto,
} from './dto';
import { TenantProvisioning } from './tenant-provisioning.service';
import { TenantUsersService } from './tenant-users.service';

const kindOf = (p: string): 'service' | 'tenant' | 'platform' | 'other' => {
  const { policy } = gatewayOptions();
  return policy.isServicePermission(p) ? 'service'
    : (TENANT_ADMIN_PERMISSIONS as readonly string[]).includes(p) ? 'tenant'
      : (policy.platformPermissions as readonly string[]).includes(p) ? 'platform' : 'other';
};

/** Who am I, which tenants exist, and the permission model. Tenants are Keycloak organizations. */
@ApiTags('identity')
@ApiBearerAuth('keycloak')
@JwtOnly()
@Controller()
export class TenantsController {
  private readonly m2mPrefix: string;

  constructor(
    private readonly kc: KeycloakAdminService,
    private readonly orgs: OrgDirectory,
    private readonly catalog: PermissionCatalog,
    private readonly provisioning: TenantProvisioning,
    private readonly users: TenantUsersService,
    private readonly authz: TenantAuthz,
    private readonly revocations: RevocationService,
    private readonly audit: AuditService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.m2mPrefix = config.get('keycloak', { infer: true }).m2mClientPrefix;
  }

  @Get('me')
  @ApiOkResponse({ type: MeDto, description: 'Read from the token; tenant names from Keycloak (cached)' })
  async me(@Access() a: AccessContext): Promise<MeDto> {
    const c = a.caller;
    const tenants = await Promise.all(c.tenants.map(async (t): Promise<TenantDto> => {
      const org = await this.orgs.byId(t.orgId).catch(() => null);
      return {
        id: t.tenantId, orgId: t.orgId, slug: t.alias, name: org?.name ?? t.alias, status: org?.enabled === false ? 'SUSPENDED' : 'ACTIVE',
        permissions: t.permissions, member: true, userCount: null, clientCount: null,
      };
    }));
    return {
      user: { keycloakId: c.sub, username: c.username ?? null, email: c.email ?? null, displayName: c.name ?? null },
      permissions: c.global,
      tenants: tenants.sort((x, y) => x.name.localeCompare(y.name)),
    };
  }

  @Get('permissions')
  @ApiOkResponse({ type: PermissionCatalogDto })
  async permissions(): Promise<PermissionCatalogDto> {
    const cat = await this.catalog.get();
    return {
      permissions: cat.permissions.map((p) => ({ ...p, kind: kindOf(p.name) })),
      groups: TENANT_GROUP_NAMES.map((name) => ({ name, bundle: TENANT_GROUPS[name], permissions: cat.bundles[TENANT_GROUPS[name]] ?? [] })),
    };
  }

  @Get('tenants')
  @ApiOkResponse({ type: [TenantDto], description: 'Every tenant with user/client counts (platform:tenants:manage), else the caller’s own' })
  async list(@Access() a: AccessContext): Promise<TenantDto[]> {
    if (!a.caller.global.includes('platform:tenants:manage')) return (await this.me(a)).tenants;
    const [all, clients] = await Promise.all([this.kc.listOrganizations(), this.kc.searchClients(`${this.m2mPrefix}-`)]);
    const own = new Map(a.caller.tenants.map((t) => [t.orgId, t]));
    const rows = await Promise.all(all.map(async (o): Promise<TenantDto | null> => {
      const info = orgInfo(o);
      if (!info) return null; // not set up yet: listed by GET /organizations/unprovisioned
      return {
        id: info.tenantId, orgId: o.id, slug: o.alias, name: o.name, status: o.enabled ? 'ACTIVE' : 'SUSPENDED',
        permissions: own.get(o.id)?.permissions ?? a.caller.global, member: own.has(o.id),
        userCount: await this.kc.organizationMemberCount(o.id).catch(() => null),
        clientCount: clients.filter((c) => c.attributes?.[this.kc.naming.clientTenantAttribute] === o.id).length,
      };
    }));
    return rows.filter((r): r is TenantDto => !!r).sort((x, y) => x.name.localeCompare(y.name));
  }

  @Post('tenants')
  @ApiCreatedResponse({ type: TenantDto })
  async create(@Access() a: AccessContext, @Body() body: CreateTenantDto): Promise<TenantDto> {
    this.authz.requireGlobal(a, 'platform:tenants:manage');
    const org = await this.provisioning.create(body.name, body.slug);
    const info = orgInfo(org)!;
    await this.audit.record(a, 'tenant.create', info.tenantId, org.alias, { name: org.name, adminEmail: body.adminEmail });
    if (body.adminEmail) {
      const grant = await this.authz.require(a, info.tenantId, 'tenant:users:manage');
      await this.users.invite(a, grant, { email: body.adminEmail, group: 'admins' });
    }
    return { id: info.tenantId, orgId: org.id, slug: org.alias, name: org.name, status: 'ACTIVE', permissions: a.caller.global, member: false, userCount: null, clientCount: 0 };
  }

  @Get('tenants/:tid/groups')
  @ApiOkResponse({ type: [OrganizationGroupDto], description: "The tenant's organization groups: bundle, permissions, members (tenant:users:read)" })
  async groups(@Access() a: AccessContext, @Param('tid', ParseUUIDPipe) tid: string): Promise<OrganizationGroupDto[]> {
    const t = await this.authz.require(a, tid, 'tenant:users:read');
    const cat = await this.catalog.get();
    const states = await this.provisioning.inspectGroups(t.orgId);
    return Promise.all(states.map(async (g) => ({
      name: g.name,
      id: g.group?.id ?? null,
      bundle: g.bundle,
      roleMapped: g.roleMapped,
      permissions: cat.bundles[g.bundle] ?? [],
      memberCount: g.group ? (await this.kc.organizationGroupMembers(t.orgId, g.group.id)).length : 0,
    })));
  }

  @Get('organizations/unprovisioned')
  @ApiOkResponse({ type: [UnprovisionedOrganizationDto], description: 'Organizations (e.g. made in the Keycloak console) that are not complete tenants yet (platform:tenants:manage)' })
  async unprovisioned(@Access() a: AccessContext): Promise<UnprovisionedOrganizationDto[]> {
    this.authz.requireGlobal(a, 'platform:tenants:manage');
    const rows = await Promise.all((await this.kc.listOrganizations()).map(async (o): Promise<UnprovisionedOrganizationDto | null> => {
      const missingGroups = (await this.provisioning.inspectGroups(o.id)).filter((g) => !g.group || !g.roleMapped).map((g) => g.name);
      const hasTenantId = !!orgInfo(o);
      return hasTenantId && !missingGroups.length
        ? null
        : { orgId: o.id, slug: o.alias, name: o.name, enabled: o.enabled, hasTenantId, missingGroups };
    }));
    return rows.filter((r): r is UnprovisionedOrganizationDto => !!r).sort((x, y) => x.name.localeCompare(y.name));
  }

  @Post('organizations/:orgId/provision')
  @ApiCreatedResponse({ type: TenantDto, description: 'Adds the tenant id attribute and the admins / members / viewers groups (platform:tenants:manage). Idempotent' })
  async provision(@Access() a: AccessContext, @Param('orgId', ParseUUIDPipe) orgId: string): Promise<TenantDto> {
    this.authz.requireGlobal(a, 'platform:tenants:manage');
    const org = await this.kc.getOrganization(orgId);
    if (!org) throw new NotFoundException('organization not found');
    const tenantId = await this.provisioning.provision(org);
    await this.orgs.invalidate(orgId);
    await this.audit.record(a, 'tenant.provision', tenantId, org.alias);
    return {
      id: tenantId, orgId, slug: org.alias, name: org.name, status: org.enabled ? 'ACTIVE' : 'SUSPENDED',
      permissions: a.caller.global, member: false, userCount: null, clientCount: null,
    };
  }

  @Patch('tenants/:tid')
  @ApiOkResponse({ type: TenantDto })
  async update(@Access() a: AccessContext, @Param('tid', ParseUUIDPipe) tid: string, @Body() body: UpdateTenantDto): Promise<TenantDto> {
    this.authz.requireGlobal(a, 'platform:tenants:manage');
    const org = await this.orgs.byTenantId(tid);
    if (!org) throw new NotFoundException('tenant not found');
    const next = await this.kc.updateOrganization(org.orgId, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.status !== undefined ? { enabled: body.status === 'ACTIVE' } : {}),
    });
    if (body.status === 'SUSPENDED') await this.revocations.revoke(`tenant:${tid}`);
    await this.orgs.invalidate(org.orgId);
    await this.audit.record(a, body.status ? `tenant.${body.status === 'ACTIVE' ? 'activate' : 'suspend'}` : 'tenant.rename', tid, org.alias, { ...body });
    return { id: tid, orgId: org.orgId, slug: org.alias, name: next.name, status: next.enabled ? 'ACTIVE' : 'SUSPENDED', permissions: null, member: null, userCount: null, clientCount: null };
  }

  @Get('tenants/:tid/audit')
  @ApiOkResponse({ type: [AuditEntryDto], description: 'Changes made through the admin API (tenant:users:read)' })
  async auditLog(
    @Access() a: AccessContext,
    @Param('tid', ParseUUIDPipe) tid: string,
    @Query('limit', new DefaultValuePipe(100), ParseIntPipe) limit: number,
  ): Promise<AuditEntryDto[]> {
    await this.authz.require(a, tid, 'tenant:users:read');
    return (await this.audit.list(tid, limit)).map((e) => ({ ts: e.ts.toISOString(), actor: e.actorLabel, action: e.action, target: e.target, detail: e.detail }));
  }
}
