import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { gatewayOptions } from '../options';
import { TenantGrant } from '../access/caller';
import { AccessContext } from '../access/request-context';
import { RevocationService } from '../access/revocation.service';
import { AppConfig } from '../config/configuration';
import { KcClient, KeycloakAdminService } from '../keycloak/keycloak-admin.service';
import { PermissionCatalog } from '../keycloak/permission-catalog.service';
import { LimitsService } from '../metering/limits.service';
import { NO_USAGE, UsageStatsService } from '../metering/usage-stats.service';
import { checkClientPermissions } from './admin-guard';
import { AuditService } from './audit.service';
import { ClientCredentialsDto, CreateClientDto, slugPart, TenantClientDto, UpdateClientDto } from './dto';

const SUFFIX_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/**
 * A tenant's machine-to-machine clients: Keycloak confidential clients (client_credentials). Their tenant is
 * fixed by hardcoded claims, their permissions are role mappings of their service account. Keycloak holds the
 * secret; the gateway returns it once and keeps only the client's limit.
 */
@Injectable()
export class TenantClientsService {
  private readonly log = new Logger(TenantClientsService.name);
  private readonly kcCfg: AppConfig['keycloak'];

  constructor(
    private readonly kc: KeycloakAdminService,
    private readonly catalog: PermissionCatalog,
    private readonly limits: LimitsService,
    private readonly stats: UsageStatsService,
    private readonly revocations: RevocationService,
    private readonly audit: AuditService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.kcCfg = config.get('keycloak', { infer: true });
  }

  async list(t: TenantGrant): Promise<TenantClientDto[]> {
    const [clients, limits, usage, seen] = await Promise.all([
      this.clientsOf(t),
      this.limits.statesFor(t.tenantId, 'CLIENT'),
      this.stats.totals(t.tenantId, 'CLIENT'),
      this.stats.lastSeen(t.tenantId, 'CLIENT'),
    ]);
    return Promise.all(clients.map(async (c) => ({
      ...(await this.toDto(c)),
      rateLimit: limits.get(c.clientId) ?? { type: 'UNLIMITED' as const, value: null, currentUsage: null, resetsAt: null },
      usage30d: usage.get(c.clientId) ?? NO_USAGE,
      lastUsedAt: seen.get(c.clientId) ?? null,
    })));
  }

  async create(a: AccessContext, t: TenantGrant, body: CreateClientDto): Promise<ClientCredentialsDto> {
    this.guard(t, body.permissions);
    const { apiUuid } = await this.catalog.get();
    const clientId = this.newClientId(t, body.name);
    const uuid = await this.kc.createM2mClient({ clientId, name: body.name, orgId: t.orgId, tenantId: t.tenantId, audience: this.kcCfg.audience });
    try {
      // fullScopeAllowed=false: allow every service role in tokens; the service account's mappings decide.
      await this.kc.addClientScopeMappings(uuid, apiUuid, await this.catalog.roles([...gatewayOptions().policy.servicePermissions]));
      await this.setPermissions(uuid, body.permissions);
      const rateLimit = await this.limits.set(t.tenantId, 'CLIENT', clientId, { rateLimit: body.rateLimit });
      await this.audit.record(a, 'client.create', t.tenantId, clientId, { permissions: body.permissions, rateLimit: body.rateLimit });
      const client = { ...(await this.toDto((await this.kc.getClient(uuid))!)), rateLimit };
      return { client, clientSecret: await this.kc.clientSecret(uuid), tokenUrl: this.kcCfg.tokenUrl };
    } catch (e) {
      await this.kc.deleteClient(uuid).catch((d) => this.log.warn(`orphan Keycloak client ${clientId}: ${(d as Error).message}`));
      throw e;
    }
  }

  async update(a: AccessContext, t: TenantGrant, id: string, body: UpdateClientDto): Promise<TenantClientDto> {
    const c = await this.get(t, id);
    let revoke = false;
    if ((body.name !== undefined && body.name !== c.name) || (body.enabled !== undefined && body.enabled !== c.enabled)) {
      await this.kc.updateClient(c.id, { name: body.name ?? c.name, enabled: body.enabled ?? c.enabled });
      revoke ||= body.enabled === false;
    }
    if (body.permissions) {
      const before = await this.permissionsOf(c.id);
      // Changing a client's grants is limited to permissions the admin holds, before and after.
      this.guard(t, [...new Set([...before, ...body.permissions])]);
      await this.setPermissions(c.id, body.permissions);
      revoke ||= before.some((p) => !body.permissions!.includes(p));
    }
    if (revoke) await this.revocations.revoke(`client:${c.clientId}`);
    const rateLimit = body.rateLimit || body.resetUsage
      ? await this.limits.set(t.tenantId, 'CLIENT', c.clientId, { rateLimit: body.rateLimit, resetUsage: body.resetUsage })
      : await this.limits.state(t.tenantId, 'CLIENT', c.clientId);
    await this.audit.record(a, 'client.update', t.tenantId, c.clientId, { ...body });
    return { ...(await this.toDto((await this.kc.getClient(c.id))!)), rateLimit };
  }

  /** New secret; the old one stops working, and tokens issued with it are voided too. */
  async rotateSecret(a: AccessContext, t: TenantGrant, id: string): Promise<ClientCredentialsDto> {
    const c = await this.get(t, id);
    const clientSecret = await this.kc.regenerateClientSecret(c.id);
    await this.revocations.revoke(`client:${c.clientId}`);
    await this.audit.record(a, 'client.rotate', t.tenantId, c.clientId);
    const client = { ...(await this.toDto(c)), rateLimit: await this.limits.state(t.tenantId, 'CLIENT', c.clientId) };
    return { client, clientSecret, tokenUrl: this.kcCfg.tokenUrl };
  }

  async remove(a: AccessContext, t: TenantGrant, id: string): Promise<void> {
    const c = await this.get(t, id);
    this.guard(t, await this.permissionsOf(c.id));
    await this.kc.deleteClient(c.id);
    await this.revocations.revoke(`client:${c.clientId}`);
    await this.limits.remove(t.tenantId, 'CLIENT', c.clientId);
    await this.audit.record(a, 'client.delete', t.tenantId, c.clientId);
  }

  private guard(t: TenantGrant, permissions: string[]) {
    const err = checkClientPermissions(t.permissions, permissions, (p) => gatewayOptions().policy.isServicePermission(p));
    if (err) throw new ForbiddenException(err);
  }

  /** A tenant's clients: our prefix and slug, and bound to its organization. */
  private async clientsOf(t: TenantGrant): Promise<KcClient[]> {
    const found = await this.kc.searchClients(`${this.kcCfg.m2mClientPrefix}-`);
    return found.filter((c) => c.attributes?.[this.kc.naming.clientTenantAttribute] === t.orgId).sort((x, y) => x.clientId.localeCompare(y.clientId));
  }

  /** The target must be one of this tenant's clients (confused-deputy guard). */
  private async get(t: TenantGrant, id: string): Promise<KcClient> {
    const c = await this.kc.getClient(id);
    if (!c || c.attributes?.[this.kc.naming.clientTenantAttribute] !== t.orgId) throw new NotFoundException('client not found');
    return c;
  }

  private async permissionsOf(uuid: string): Promise<string[]> {
    const { apiUuid } = await this.catalog.get();
    const sa = await this.kc.serviceAccountUser(uuid);
    return (await this.kc.userClientRoles(sa.id, apiUuid)).map((r) => r.name).filter((p) => gatewayOptions().policy.isServicePermission(p));
  }

  private async setPermissions(uuid: string, wanted: string[]) {
    const { apiUuid } = await this.catalog.get();
    const sa = await this.kc.serviceAccountUser(uuid);
    const current = await this.kc.userClientRoles(sa.id, apiUuid);
    const add = await this.catalog.roles(wanted.filter((p) => !current.some((r) => r.name === p)));
    if (add.length !== wanted.filter((p) => !current.some((r) => r.name === p)).length) {
      throw new BadRequestException('some permissions are not defined in Keycloak');
    }
    await this.kc.addUserClientRoles(sa.id, apiUuid, add);
    await this.kc.removeUserClientRoles(sa.id, apiUuid, current.filter((r) => !wanted.includes(r.name)));
  }

  private newClientId(t: TenantGrant, name: string): string {
    const suffix = [...randomBytes(4)].map((b) => SUFFIX_ALPHABET[b % SUFFIX_ALPHABET.length]).join('');
    return `${this.kcCfg.m2mClientPrefix}-${t.alias}-${slugPart(name)}-${suffix}`;
  }

  private async toDto(c: KcClient): Promise<TenantClientDto> {
    return {
      id: c.id,
      clientId: c.clientId,
      name: c.name || c.clientId,
      enabled: c.enabled,
      permissions: await this.permissionsOf(c.id),
      rateLimit: { type: 'UNLIMITED', value: null, currentUsage: null, resetsAt: null },
      lastUsedAt: null,
      usage30d: NO_USAGE,
    };
  }
}
