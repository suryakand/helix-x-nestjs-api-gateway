import { BadRequestException, Body, Controller, DefaultValuePipe, Get, NotFoundException, Param, ParseIntPipe, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Access, JwtOnly } from '../access/decorators';
import { AccessContext } from '../access/request-context';
import { RevocationService } from '../access/revocation.service';
import { TenantAuthz } from '../access/tenant-authz.service';
import { KcUser, KeycloakAdminService } from '../keycloak/keycloak-admin.service';
import { AuditService } from './audit.service';
import { PlatformUserDto, UpdatePlatformUserDto } from './dto';

/** Platform admins (platform:users:manage): every account of the realm, across tenants, with a global switch. */
@ApiTags('platform admin')
@ApiBearerAuth('keycloak')
@JwtOnly()
@Controller('admin/users')
export class PlatformUsersController {
  constructor(
    private readonly kc: KeycloakAdminService,
    private readonly authz: TenantAuthz,
    private readonly revocations: RevocationService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'first', required: false, example: 0 })
  @ApiQuery({ name: 'max', required: false, example: 50 })
  @ApiOkResponse({ type: [PlatformUserDto] })
  async list(
    @Access() a: AccessContext,
    @Query('search', new DefaultValuePipe('')) search: string,
    @Query('first', new DefaultValuePipe(0), ParseIntPipe) first: number,
    @Query('max', new DefaultValuePipe(50), ParseIntPipe) max: number,
  ): Promise<PlatformUserDto[]> {
    this.authz.requireGlobal(a, 'platform:users:manage');
    // Service accounts of M2M clients are Keycloak users too; they are managed as clients.
    const users = (await this.kc.searchUsers(search.trim(), Math.max(first, 0), Math.min(Math.max(max, 1), 200)))
      .filter((u) => !u.username.startsWith('service-account-'));
    // One call per organization (few) instead of one per user (many).
    const tenantsOf = new Map<string, string[]>();
    for (const o of await this.kc.listOrganizations()) {
      for (const m of await this.kc.organizationMembers(o.id)) tenantsOf.set(m.id, [...(tenantsOf.get(m.id) ?? []), o.alias]);
    }
    return users.map((u) => this.toDto(u, tenantsOf.get(u.id) ?? []));
  }

  @Patch(':keycloakId')
  @ApiOkResponse({ type: PlatformUserDto })
  async update(
    @Access() a: AccessContext,
    @Param('keycloakId', ParseUUIDPipe) keycloakId: string,
    @Body() body: UpdatePlatformUserDto,
  ): Promise<PlatformUserDto> {
    this.authz.requireGlobal(a, 'platform:users:manage');
    if (keycloakId === a.caller.sub && !body.enabled) throw new BadRequestException('you cannot disable yourself');
    const user = await this.kc.getUser(keycloakId);
    if (!user) throw new NotFoundException('user not found');
    await this.kc.setUserEnabled(keycloakId, body.enabled);
    if (!body.enabled) {
      await this.kc.logoutUser(keycloakId);
      await this.revocations.revoke(`user:${keycloakId}`);
    }
    await this.audit.record(a, body.enabled ? 'account.enable' : 'account.disable', null, user.email ?? user.username);
    const orgs = await this.kc.organizationsOfUser(keycloakId).catch(() => []);
    return this.toDto({ ...user, enabled: body.enabled }, orgs.map((o) => o.alias));
  }

  private toDto(u: KcUser, tenants: string[]): PlatformUserDto {
    return {
      keycloakId: u.id,
      username: u.username,
      email: u.email ?? null,
      displayName: [u.firstName, u.lastName].filter(Boolean).join(' ') || null,
      enabled: u.enabled,
      tenants: [...tenants].sort(),
    };
  }
}
