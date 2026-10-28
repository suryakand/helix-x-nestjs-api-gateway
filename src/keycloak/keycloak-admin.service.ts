import {
  BadGatewayException, ConflictException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { gatewayOptions, GatewayNaming } from '../options';

export interface KcOrganization {
  id: string;
  name: string;
  alias: string;
  enabled: boolean;
  description?: string;
  attributes?: Record<string, string[]>;
}

export interface KcUser {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled: boolean;
  createdTimestamp?: number;
}

export interface KcClient {
  id: string;
  clientId: string;
  name?: string;
  enabled: boolean;
  attributes?: Record<string, string>;
}

export interface KcGroup { id: string; name: string; path?: string }
export interface KcRole { id: string; name: string; description?: string; composite: boolean; clientRole?: boolean; containerId?: string }


const PAGE = 200;

/**
 * Thin wrapper over the Keycloak admin REST API (organizations, users, M2M clients), authenticated as the
 * confidential service-account client KEYCLOAK_ADMIN_CLIENT_ID. Plain fetch on purpose: the official admin
 * client is ESM-only and the gateway is CommonJS. Keycloak errors surface as Nest HTTP exceptions.
 */
@Injectable()
export class KeycloakAdminService {
  private readonly log = new Logger(KeycloakAdminService.name);
  private readonly cfg: AppConfig['keycloak']['admin'];
  /** Claim, attribute and mapper names (GatewayNaming). */
  readonly naming: GatewayNaming;
  private readonly base: string;
  private token?: { value: string; until: number };
  private tokenRequest?: Promise<string>;

  constructor(config: ConfigService<AppConfig, true>) {
    this.cfg = config.get('keycloak', { infer: true }).admin;
    this.naming = gatewayOptions().naming;
    this.base = `${this.cfg.url}/admin/realms/${encodeURIComponent(this.cfg.realm)}`;
  }

  get configured(): boolean {
    return !!this.cfg.clientSecret;
  }

  // ---- organizations ------------------------------------------------------------------------------

  async listOrganizations(): Promise<KcOrganization[]> {
    return this.paged<KcOrganization>((first) => `/organizations?briefRepresentation=false&first=${first}&max=${PAGE}`);
  }

  getOrganization(id: string): Promise<KcOrganization | null> {
    return this.call<KcOrganization>('GET', `/organizations/${id}`).catch(nullOn404);
  }

  /** By the tenant id attribute (documented attribute query). */
  async findOrganizationByTenantId(tenantId: string): Promise<KcOrganization | null> {
    const found = await this.call<KcOrganization[]>(
      'GET', `/organizations?q=${encodeURIComponent(`${this.naming.tenantIdAttribute}:${tenantId}`)}&briefRepresentation=false`,
    );
    return found.find((o) => o.attributes?.[this.naming.tenantIdAttribute]?.[0] === tenantId) ?? null;
  }

  /** Returns the new organization's id. */
  async createOrganization(org: Omit<KcOrganization, 'id'>): Promise<string> {
    return this.createdId(await this.raw('POST', '/organizations', { domains: [], ...org }));
  }

  /** Read-modify-write: the organizations PUT replaces the whole representation. */
  async updateOrganization(id: string, patch: Partial<Pick<KcOrganization, 'name' | 'enabled' | 'attributes'>>): Promise<KcOrganization> {
    const org = await this.call<KcOrganization & Record<string, unknown>>('GET', `/organizations/${id}`);
    const next = { ...org, ...patch, attributes: { ...(org.attributes ?? {}), ...(patch.attributes ?? {}) } };
    await this.call('PUT', `/organizations/${id}`, next);
    return next;
  }

  organizationMembers(orgId: string): Promise<KcUser[]> {
    return this.paged<KcUser>((first) => `/organizations/${orgId}/members?first=${first}&max=${PAGE}`);
  }

  async organizationMemberCount(orgId: string): Promise<number> {
    return Number(await this.call<number>('GET', `/organizations/${orgId}/members/count`));
  }

  /** false when the user already was a member. */
  async addOrganizationMember(orgId: string, userId: string): Promise<boolean> {
    try {
      await this.call('POST', `/organizations/${orgId}/members`, userId);
      return true;
    } catch (e) {
      if (e instanceof ConflictException) return false;
      throw e;
    }
  }

  removeOrganizationMember(orgId: string, userId: string): Promise<void> {
    return this.call<void>('DELETE', `/organizations/${orgId}/members/${userId}`).catch(nullOn404) as Promise<void>;
  }

  organizationsOfUser(userId: string): Promise<KcOrganization[]> {
    return this.call<KcOrganization[]>('GET', `/organizations/members/${userId}/organizations?briefRepresentation=true`);
  }

  // ---- organization groups (a tenant's role groups) -----------------------------------------------

  organizationGroups(orgId: string): Promise<KcGroup[]> {
    return this.call<KcGroup[]>('GET', `/organizations/${orgId}/groups`);
  }

  async createOrganizationGroup(orgId: string, name: string): Promise<string> {
    return this.createdId(await this.raw('POST', `/organizations/${orgId}/groups`, { name }));
  }

  organizationGroupClientRoles(orgId: string, groupId: string, clientUuid: string): Promise<KcRole[]> {
    return this.call<KcRole[]>('GET', `/organizations/${orgId}/groups/${groupId}/role-mappings/clients/${clientUuid}`);
  }

  async addOrganizationGroupClientRoles(orgId: string, groupId: string, clientUuid: string, roles: KcRole[]): Promise<void> {
    await this.call('POST', `/organizations/${orgId}/groups/${groupId}/role-mappings/clients/${clientUuid}`, roles);
  }

  organizationGroupMembers(orgId: string, groupId: string): Promise<KcUser[]> {
    return this.paged<KcUser>((first) => `/organizations/${orgId}/groups/${groupId}/members?first=${first}&max=${PAGE}`);
  }

  async addOrganizationGroupMember(orgId: string, groupId: string, userId: string): Promise<void> {
    await this.call('PUT', `/organizations/${orgId}/groups/${groupId}/members/${userId}`);
  }

  async removeOrganizationGroupMember(orgId: string, groupId: string, userId: string): Promise<void> {
    await this.call('DELETE', `/organizations/${orgId}/groups/${groupId}/members/${userId}`).catch(nullOn404);
  }

  /** The organization groups a member is in. */
  memberOrganizationGroups(orgId: string, userId: string): Promise<KcGroup[]> {
    return this.call<KcGroup[]>('GET', `/organizations/${orgId}/members/${userId}/groups`);
  }

  // ---- users --------------------------------------------------------------------------------------

  getUser(id: string): Promise<KcUser | null> {
    return this.call<KcUser>('GET', `/users/${id}`).catch(nullOn404);
  }

  async findUserByEmail(email: string): Promise<KcUser | null> {
    const found = await this.call<KcUser[]>('GET', `/users?email=${encodeURIComponent(email)}&exact=true`);
    return found.find((u) => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
  }

  searchUsers(search: string, first: number, max: number): Promise<KcUser[]> {
    const q = search ? `search=${encodeURIComponent(search)}&` : '';
    return this.call<KcUser[]>('GET', `/users?${q}first=${first}&max=${max}&briefRepresentation=true`);
  }

  /** Creates an enabled user who must set a password on first sign-in. Returns the Keycloak user id. */
  async createUser(u: { email: string; firstName?: string; lastName?: string; temporaryPassword?: string }): Promise<string> {
    const res = await this.raw('POST', '/users', {
      username: u.email,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      enabled: true,
      emailVerified: false,
      requiredActions: ['UPDATE_PASSWORD'],
      credentials: u.temporaryPassword ? [{ type: 'password', value: u.temporaryPassword, temporary: true }] : undefined,
    });
    return this.createdId(res);
  }

  async setUserEnabled(id: string, enabled: boolean): Promise<void> {
    await this.call('PUT', `/users/${id}`, { enabled });
  }

  /** Ends every session of the user, so no new access token can be refreshed. */
  async logoutUser(id: string): Promise<void> {
    await this.call('POST', `/users/${id}/logout`);
  }

  /** Sends Keycloak's "update your account" email; false when the realm has no working SMTP. */
  async sendActionsEmail(id: string, actions: string[]): Promise<boolean> {
    try {
      await this.call('PUT', `/users/${id}/execute-actions-email`, actions);
      return true;
    } catch (e) {
      this.log.warn(`invite email not sent: ${(e as Error).message}`);
      return false;
    }
  }

  // ---- M2M clients --------------------------------------------------------------------------------

  /**
   * A confidential client with only the client_credentials grant. Its tokens carry `aud` = the gateway and
   * `<prefix>_tenant` = the organization id, which is how the gateway binds them to a tenant (service-account users
   * cannot be organization members). Returns Keycloak's internal client id.
   */
  async createM2mClient(c: { clientId: string; name: string; orgId: string; tenantId: string; audience: string }): Promise<string> {
    const res = await this.raw('POST', '/clients', {
      clientId: c.clientId,
      name: c.name,
      description: `${this.naming.serviceName} machine-to-machine client (managed by the ${this.naming.serviceName} gateway)`,
      enabled: true,
      protocol: 'openid-connect',
      publicClient: false,
      clientAuthenticatorType: 'client-secret',
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      // Tokens carry only the roles scope-mapped below (the resource server's), not every realm role.
      fullScopeAllowed: false,
      attributes: { [this.naming.clientTenantAttribute]: c.orgId },
      defaultClientScopes: ['acr', 'basic', 'roles'],
      optionalClientScopes: [],
      protocolMappers: [
        {
          name: 'api-audience',
          protocol: 'openid-connect',
          protocolMapper: 'oidc-audience-mapper',
          config: { 'included.client.audience': c.audience, 'access.token.claim': 'true', 'id.token.claim': 'false' },
        },
        {
          name: this.naming.tenantMapperName,
          protocol: 'openid-connect',
          protocolMapper: 'oidc-hardcoded-claim-mapper',
          config: {
            'claim.name': this.naming.tenantClaim,
            'claim.value': c.orgId,
            'jsonType.label': 'String',
            'access.token.claim': 'true',
            'id.token.claim': 'false',
            'introspection.token.claim': 'true',
          },
        },
        {
          name: this.naming.tenantIdMapperName,
          protocol: 'openid-connect',
          protocolMapper: 'oidc-hardcoded-claim-mapper',
          config: {
            'claim.name': this.naming.tenantIdClaim,
            'claim.value': c.tenantId,
            'jsonType.label': 'String',
            'access.token.claim': 'true',
            'id.token.claim': 'false',
            'introspection.token.claim': 'true',
          },
        },
      ],
    });
    return this.createdId(res);
  }

  getClient(uuid: string): Promise<(KcClient & Record<string, unknown>) | null> {
    return this.call<KcClient & Record<string, unknown>>('GET', `/clients/${uuid}`).catch(nullOn404);
  }

  serviceAccountUser(clientUuid: string): Promise<KcUser> {
    return this.call<KcUser>('GET', `/clients/${clientUuid}/service-account-user`);
  }

  // ---- roles of the resource-server client (the permissions) --------------------------------------

  clientRoles(clientUuid: string): Promise<KcRole[]> {
    return this.call<KcRole[]>('GET', `/clients/${clientUuid}/roles?briefRepresentation=false`);
  }

  /** A composite role's members, expanded transitively by Keycloak. */
  clientRoleComposites(clientUuid: string, role: string): Promise<KcRole[]> {
    return this.call<KcRole[]>('GET', `/clients/${clientUuid}/roles/${encodeURIComponent(role)}/composites/clients/${clientUuid}`);
  }

  userClientRoles(userId: string, clientUuid: string): Promise<KcRole[]> {
    return this.call<KcRole[]>('GET', `/users/${userId}/role-mappings/clients/${clientUuid}`);
  }

  async addUserClientRoles(userId: string, clientUuid: string, roles: KcRole[]): Promise<void> {
    if (roles.length) await this.call('POST', `/users/${userId}/role-mappings/clients/${clientUuid}`, roles);
  }

  async removeUserClientRoles(userId: string, clientUuid: string, roles: KcRole[]): Promise<void> {
    if (roles.length) await this.call('DELETE', `/users/${userId}/role-mappings/clients/${clientUuid}`, roles);
  }

  /** Lets `clientUuid`'s tokens carry these roles of `resourceUuid` (needed with fullScopeAllowed=false). */
  async addClientScopeMappings(clientUuid: string, resourceUuid: string, roles: KcRole[]): Promise<void> {
    if (roles.length) await this.call('POST', `/clients/${clientUuid}/scope-mappings/clients/${resourceUuid}`, roles);
  }

  async deleteClientMapper(clientUuid: string, name: string): Promise<void> {
    const m = (await this.call<{ id: string; name: string }[]>('GET', `/clients/${clientUuid}/protocol-mappers/models`)).find((x) => x.name === name);
    if (m) await this.call('DELETE', `/clients/${clientUuid}/protocol-mappers/models/${m.id}`);
  }

  /** Replaces a hardcoded/audience mapper's config by name, creating the mapper when missing. */
  async upsertClientMapper(clientUuid: string, mapper: { name: string; protocolMapper: string; config: Record<string, string> }): Promise<void> {
    const existing = (await this.call<{ id: string; name: string }[]>('GET', `/clients/${clientUuid}/protocol-mappers/models`))
      .find((m) => m.name === mapper.name);
    const body = { ...mapper, protocol: 'openid-connect' };
    if (existing) await this.call('PUT', `/clients/${clientUuid}/protocol-mappers/models/${existing.id}`, { ...body, id: existing.id });
    else await this.call('POST', `/clients/${clientUuid}/protocol-mappers/models`, body);
  }

  async findClient(clientId: string): Promise<KcClient | null> {
    const found = await this.call<KcClient[]>('GET', `/clients?clientId=${encodeURIComponent(clientId)}`);
    return found.find((c) => c.clientId === clientId) ?? null;
  }

  /** Clients whose clientId contains `fragment` (with their attributes). */
  searchClients(fragment: string): Promise<KcClient[]> {
    return this.paged<KcClient>((first) => `/clients?clientId=${encodeURIComponent(fragment)}&search=true&first=${first}&max=${PAGE}`);
  }

  async clientSecret(uuid: string): Promise<string> {
    return (await this.call<{ value: string }>('GET', `/clients/${uuid}/client-secret`)).value;
  }

  async regenerateClientSecret(uuid: string): Promise<string> {
    return (await this.call<{ value: string }>('POST', `/clients/${uuid}/client-secret`)).value;
  }

  /** Read-modify-write of a client's top-level fields. */
  async updateClient(uuid: string, patch: Partial<Pick<KcClient, 'name' | 'enabled'>> & { fullScopeAllowed?: boolean }): Promise<void> {
    const c = await this.call<KcClient & Record<string, unknown>>('GET', `/clients/${uuid}`);
    await this.call('PUT', `/clients/${uuid}`, { ...c, ...patch });
  }

  deleteClient(uuid: string): Promise<void> {
    return this.call<void>('DELETE', `/clients/${uuid}`).catch(nullOn404) as Promise<void>;
  }

  // ---- plumbing -----------------------------------------------------------------------------------

  private async paged<T>(path: (first: number) => string): Promise<T[]> {
    const all: T[] = [];
    for (let first = 0; ; first += PAGE) {
      const page = await this.call<T[]>('GET', path(first));
      all.push(...page);
      if (page.length < PAGE) return all;
    }
  }

  private createdId(res: Response): string {
    const id = res.headers.get('location')?.split('/').pop();
    if (!id) throw new BadGatewayException('Keycloak did not return the created id');
    return id;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    if (res.status === 204 || res.status === 201) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async raw(method: string, path: string, body?: unknown, retried = false): Promise<Response> {
    const token = await this.adminToken();
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    }).catch((e: Error) => {
      throw new ServiceUnavailableException(`Keycloak unreachable: ${e.message}`);
    });
    if (res.status === 401 && !retried) {
      this.token = undefined;
      return this.raw(method, path, body, true);
    }
    if (res.ok) return res;
    const detail = await res.text().then((t) => {
      try {
        const j = JSON.parse(t) as { errorMessage?: string; error?: string; error_description?: string };
        return j.errorMessage ?? j.error_description ?? j.error ?? t;
      } catch {
        return t;
      }
    });
    if (res.status === 404) throw new NotFoundException(detail || 'not found in Keycloak');
    if (res.status === 409) throw new ConflictException(detail || 'already exists in Keycloak');
    if (res.status === 400) throw new HttpException({ statusCode: 400, message: `Keycloak: ${detail}` }, 400);
    this.log.warn(`${method} ${path} → Keycloak ${res.status}: ${detail}`);
    throw new BadGatewayException(`Keycloak ${res.status}: ${detail}`);
  }

  private adminToken(): Promise<string> {
    if (!this.configured) {
      throw new ServiceUnavailableException('Keycloak admin access is not configured (KEYCLOAK_ADMIN_CLIENT_SECRET)');
    }
    if (this.token && Date.now() < this.token.until) return Promise.resolve(this.token.value);
    this.tokenRequest ??= this.fetchToken().finally(() => (this.tokenRequest = undefined));
    return this.tokenRequest;
  }

  private async fetchToken(): Promise<string> {
    const res = await fetch(`${this.cfg.url}/realms/${encodeURIComponent(this.cfg.realm)}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }),
      signal: AbortSignal.timeout(10_000),
    }).catch((e: Error) => {
      throw new ServiceUnavailableException(`Keycloak unreachable: ${e.message}`);
    });
    if (!res.ok) throw new ServiceUnavailableException(`Keycloak admin sign-in failed (${res.status})`);
    const t = (await res.json()) as { access_token: string; expires_in: number };
    // Renew 30 s early so a request never starts with a token that expires in flight.
    this.token = { value: t.access_token, until: Date.now() + Math.max(5, t.expires_in - 30) * 1000 };
    return t.access_token;
  }
}

function nullOn404(e: unknown): null {
  if (e instanceof NotFoundException) return null;
  throw e;
}
