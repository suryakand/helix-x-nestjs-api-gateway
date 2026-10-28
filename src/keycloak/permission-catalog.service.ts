import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TENANT_GROUPS, TenantGroup } from '../access/access-policy';
import { gatewayOptions } from '../options';
import { AppConfig } from '../config/configuration';
import { KcRole, KeycloakAdminService } from './keycloak-admin.service';

const REFRESH_MS = 5 * 60_000;

export interface PermissionInfo { name: string; description: string | null }
export interface Catalog {
  /** Keycloak client uuid of the resource-server client. */
  apiUuid: string;
  /** Non-composite client roles: the permissions, as defined in Keycloak. */
  permissions: PermissionInfo[];
  /** Bundle role → the permissions it grants (Keycloak composites, expanded). */
  bundles: Record<string, string[]>;
  roles: Map<string, KcRole>;
}

/**
 * The permission model as Keycloak defines it: the resource-server client's roles and what each bundle
 * (tenant-admin / -member / -viewer) contains. Static configuration, so read every few minutes, never per call.
 * Used to show permissions in the admin UI and to stop admins granting more than they hold.
 */
@Injectable()
export class PermissionCatalog {
  private readonly audience: string;
  private current?: { catalog: Catalog; at: number };
  private loading?: Promise<Catalog>;

  constructor(private readonly kc: KeycloakAdminService, config: ConfigService<AppConfig, true>) {
    this.audience = config.get('keycloak', { infer: true }).audience;
  }

  async get(): Promise<Catalog> {
    if (this.current && Date.now() - this.current.at < REFRESH_MS) return this.current.catalog;
    this.loading ??= this.load().finally(() => (this.loading = undefined));
    return this.loading;
  }

  async bundleOf(group: TenantGroup): Promise<string[]> {
    return (await this.get()).bundles[TENANT_GROUPS[group]] ?? [];
  }

  async roles(names: string[]): Promise<KcRole[]> {
    const { roles } = await this.get();
    return names.map((n) => roles.get(n)).filter((r): r is KcRole => !!r);
  }

  private async load(): Promise<Catalog> {
    const client = await this.kc.findClient(this.audience);
    if (!client) throw new ServiceUnavailableException(`Keycloak has no client "${this.audience}" (KEYCLOAK_AUDIENCE)`);
    const all = await this.kc.clientRoles(client.id);
    const bundles: Record<string, string[]> = {};
    for (const b of Object.values(TENANT_GROUPS)) {
      bundles[b] = all.some((r) => r.name === b) ? (await this.kc.clientRoleComposites(client.id, b)).map((r) => r.name) : [];
    }
    // Keycloak may define permissions the gateway doesn't route yet; list known ones first.
    const known = gatewayOptions().policy.permissions;
    const order = (n: string) => { const i = known.indexOf(n); return i < 0 ? 999 : i; };
    const catalog: Catalog = {
      apiUuid: client.id,
      permissions: all.filter((r) => !r.composite).sort((a, b) => order(a.name) - order(b.name) || a.name.localeCompare(b.name))
        .map((r) => ({ name: r.name, description: r.description ?? null })),
      bundles,
      roles: new Map(all.map((r) => [r.name, r])),
    };
    this.current = { catalog, at: Date.now() };
    return catalog;
  }
}
