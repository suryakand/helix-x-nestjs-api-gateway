import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Access, JwtOnly } from '../access/decorators';
import { AccessContext } from '../access/request-context';
import { TenantAuthz } from '../access/tenant-authz.service';
import { InviteUserDto, InvitedUserDto, TenantUserDto, UpdateTenantUserDto } from './dto';
import { TenantUsersService } from './tenant-users.service';

/** A tenant's people (Keycloak organization members and their tenant group). */
@ApiTags('tenant users')
@ApiBearerAuth('keycloak')
@JwtOnly()
@Controller('tenants/:tid/users')
export class TenantUsersController {
  constructor(private readonly users: TenantUsersService, private readonly authz: TenantAuthz) {}

  @Get()
  @ApiOkResponse({ type: [TenantUserDto], description: 'tenant:users:read' })
  async list(@Access() a: AccessContext, @Param('tid', ParseUUIDPipe) tid: string): Promise<TenantUserDto[]> {
    return this.users.list(await this.authz.require(a, tid, 'tenant:users:read'));
  }

  @Post()
  @ApiCreatedResponse({ type: InvitedUserDto, description: 'tenant:users:manage. Adds an existing Keycloak user, or creates and invites one' })
  async invite(@Access() a: AccessContext, @Param('tid', ParseUUIDPipe) tid: string, @Body() body: InviteUserDto): Promise<InvitedUserDto> {
    return this.users.invite(a, await this.authz.require(a, tid, 'tenant:users:manage'), body);
  }

  @Patch(':keycloakId')
  @ApiOkResponse({ type: TenantUserDto, description: 'tenant:users:manage. Group (access) and limit' })
  async update(
    @Access() a: AccessContext,
    @Param('tid', ParseUUIDPipe) tid: string,
    @Param('keycloakId', ParseUUIDPipe) keycloakId: string,
    @Body() body: UpdateTenantUserDto,
  ): Promise<TenantUserDto> {
    return this.users.update(a, await this.authz.require(a, tid, 'tenant:users:manage'), keycloakId, body);
  }

  @Delete(':keycloakId')
  @ApiOkResponse({ description: 'tenant:users:manage. Removed from the organization; the Keycloak account stays' })
  async remove(@Access() a: AccessContext, @Param('tid', ParseUUIDPipe) tid: string, @Param('keycloakId', ParseUUIDPipe) keycloakId: string) {
    await this.users.remove(a, await this.authz.require(a, tid, 'tenant:users:manage'), keycloakId);
    return { removed: true };
  }
}
