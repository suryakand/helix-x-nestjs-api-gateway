import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TENANT_GROUP_NAMES, TenantGroup } from '../access/access-policy';
import { TenantGrant } from '../access/caller';
import { AccessContext } from '../access/request-context';
import { RevocationService } from '../access/revocation.service';
import { KcUser, KeycloakAdminService } from '../keycloak/keycloak-admin.service';
import { PermissionCatalog } from '../keycloak/permission-catalog.service';
import { LimitsService } from '../metering/limits.service';
import { NO_USAGE, UsageStatsService } from '../metering/usage-stats.service';
import { checkGroupChange, checkKeepsAdmin } from './admin-guard';
import { AuditService } from './audit.service';
import { InviteUserDto, InvitedUserDto, TenantUserDto, UpdateTenantUserDto } from './dto';
import { TenantGroupIds, TenantProvisioning } from './tenant-provisioning.service';

interface Roster { groups: TenantGroupIds; groupOf: Map<string, TenantGroup>; admins: string[] }

/**
 * A tenant's users: members of its Keycloak organization, with access through exactly one of its groups
 * (admins / members / viewers). Everything is changed in Keycloak; the gateway keeps only their limits. A
 * change that removes or narrows access is also revoked here, so tokens issued before it stop working at once.
 */
@Injectable()
export class TenantUsersService {
  constructor(
    private readonly kc: KeycloakAdminService,
    private readonly provisioning: TenantProvisioning,
    private readonly catalog: PermissionCatalog,
    private readonly limits: LimitsService,
    private readonly stats: UsageStatsService,
    private readonly revocations: RevocationService,
    private readonly audit: AuditService,
  ) {}

  async list(t: TenantGrant): Promise<TenantUserDto[]> {
    const [members, roster, limits, usage, seen] = await Promise.all([
      this.kc.organizationMembers(t.orgId),
      this.roster(t.orgId),
      this.limits.statesFor(t.tenantId, 'USER'),
      this.stats.totals(t.tenantId, 'USER'),
      this.stats.lastSeen(t.tenantId, 'USER'),
    ]);
    const out = await Promise.all(members.map(async (m) => {
      const dto = await this.toDto(m, roster.groupOf.get(m.id) ?? null);
      return { ...dto, rateLimit: limits.get(m.id) ?? dto.rateLimit, usage30d: usage.get(m.id) ?? NO_USAGE, lastSeenAt: seen.get(m.id) ?? null };
    }));
    return out.sort((a, b) => (a.displayName ?? a.username).localeCompare(b.displayName ?? b.username));
  }

  async invite(a: AccessContext, t: TenantGrant, body: InviteUserDto): Promise<InvitedUserDto> {
    await this.guardGroups(t, [body.group]);
    let kcUser = await this.kc.findUserByEmail(body.email.trim());
    const created = !kcUser;
    let inviteEmailSent = false;
    if (!kcUser) {
      const id = await this.kc.createUser({
        email: body.email.trim().toLowerCase(), firstName: body.firstName, lastName: body.lastName, temporaryPassword: body.temporaryPassword,
      });
      kcUser = (await this.kc.getUser(id))!;
      if (!body.temporaryPassword) inviteEmailSent = await this.kc.sendActionsEmail(id, ['UPDATE_PASSWORD', 'VERIFY_EMAIL']);
    }
    await this.kc.addOrganizationMember(t.orgId, kcUser.id);
    const roster = await this.roster(t.orgId);
    const current = roster.groupOf.get(kcUser.id) ?? null;
    if (current && current !== body.group) await this.guardGroups(t, [current]);
    await this.setGroup(t, roster, kcUser.id, body.group);
    if (body.rateLimit) await this.limits.set(t.tenantId, 'USER', kcUser.id, { rateLimit: body.rateLimit });
    await this.audit.record(a, created ? 'user.create' : 'user.add', t.tenantId, kcUser.email ?? kcUser.username, { group: body.group });
    const dto = await this.toDto(kcUser, body.group);
    return { user: { ...dto, rateLimit: await this.limits.state(t.tenantId, 'USER', kcUser.id) }, created, inviteEmailSent };
  }

  async update(a: AccessContext, t: TenantGrant, keycloakId: string, body: UpdateTenantUserDto): Promise<TenantUserDto> {
    const kcUser = await this.member(t, keycloakId);
    const roster = await this.roster(t.orgId);
    const current = roster.groupOf.get(keycloakId) ?? null;
    if (body.group !== undefined) {
      const next = body.group === 'none' ? null : body.group;
      if (next !== current) {
        await this.guardGroups(t, [current, next].filter((g): g is TenantGroup => !!g));
        const err = checkKeepsAdmin(roster.admins, keycloakId, next === 'admins');
        if (err) throw new BadRequestException(err);
        await this.setGroup(t, roster, keycloakId, next);
        await this.audit.record(a, 'user.group', t.tenantId, kcUser.email ?? kcUser.username, { from: current, to: next });
      }
    }
    let rateLimit = await this.limits.state(t.tenantId, 'USER', keycloakId);
    if (body.rateLimit || body.resetUsage) {
      rateLimit = await this.limits.set(t.tenantId, 'USER', keycloakId, { rateLimit: body.rateLimit, resetUsage: body.resetUsage });
      await this.audit.record(a, 'user.limit', t.tenantId, kcUser.email ?? kcUser.username, { rateLimit: body.rateLimit, resetUsage: body.resetUsage });
    }
    const group = body.group === undefined ? current : body.group === 'none' ? null : body.group;
    return { ...(await this.toDto(kcUser, group)), rateLimit };
  }

  async remove(a: AccessContext, t: TenantGrant, keycloakId: string): Promise<void> {
    const kcUser = await this.member(t, keycloakId);
    const roster = await this.roster(t.orgId);
    const current = roster.groupOf.get(keycloakId);
    if (current) await this.guardGroups(t, [current]);
    const err = checkKeepsAdmin(roster.admins, keycloakId, false);
    if (err) throw new BadRequestException(err);
    await this.kc.removeOrganizationMember(t.orgId, keycloakId);
    await this.revocations.revoke(`member:${t.tenantId}:${keycloakId}`);
    await this.limits.remove(t.tenantId, 'USER', keycloakId);
    await this.audit.record(a, 'user.remove', t.tenantId, kcUser.email ?? kcUser.username);
  }

  /** Moves the user into exactly `group` (or none) and voids their earlier tokens for this tenant. */
  private async setGroup(t: TenantGrant, roster: Roster, userId: string, group: TenantGroup | null) {
    for (const name of TENANT_GROUP_NAMES) {
      if (name !== group && roster.groupOf.get(userId) === name) await this.kc.removeOrganizationGroupMember(t.orgId, roster.groups[name], userId);
    }
    if (group && roster.groupOf.get(userId) !== group) await this.kc.addOrganizationGroupMember(t.orgId, roster.groups[group], userId);
    await this.revocations.revoke(`member:${t.tenantId}:${userId}`);
  }

  /** The admin must hold every permission of the groups involved (confused-deputy guard). */
  private async guardGroups(t: TenantGrant, groups: TenantGroup[]) {
    const bundles = await Promise.all(groups.map((g) => this.catalog.bundleOf(g)));
    const err = checkGroupChange(t.permissions, bundles);
    if (err) throw new ForbiddenException(err);
  }

  /** The target must be a member of this tenant's organization. */
  private async member(t: TenantGrant, keycloakId: string): Promise<KcUser> {
    const kcUser = await this.kc.getUser(keycloakId);
    const orgs = kcUser ? await this.kc.organizationsOfUser(keycloakId) : [];
    if (!kcUser || !orgs.some((o) => o.id === t.orgId)) throw new NotFoundException('not a member of this tenant');
    return kcUser;
  }

  private async roster(orgId: string): Promise<Roster> {
    const groups = await this.provisioning.ensureGroups(orgId);
    const groupOf = new Map<string, TenantGroup>();
    const admins: string[] = [];
    for (const name of TENANT_GROUP_NAMES) {
      // Highest group wins if someone ended up in two (admins listed first).
      for (const u of await this.kc.organizationGroupMembers(orgId, groups[name])) {
        if (!groupOf.has(u.id)) groupOf.set(u.id, name);
        if (name === 'admins') admins.push(u.id);
      }
    }
    return { groups, groupOf, admins };
  }

  private async toDto(m: KcUser, group: TenantGroup | null): Promise<TenantUserDto> {
    return {
      keycloakId: m.id,
      username: m.username,
      email: m.email ?? null,
      displayName: [m.firstName, m.lastName].filter(Boolean).join(' ') || null,
      enabled: m.enabled,
      group,
      permissions: group ? await this.catalog.bundleOf(group) : [],
      rateLimit: { type: 'UNLIMITED', value: null, currentUsage: null, resetsAt: null },
      lastSeenAt: null,
      usage30d: NO_USAGE,
    };
  }
}
