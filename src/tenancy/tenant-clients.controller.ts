import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Access, JwtOnly } from '../access/decorators';
import { AccessContext } from '../access/request-context';
import { TenantAuthz } from '../access/tenant-authz.service';
import { ClientCredentialsDto, CreateClientDto, TenantClientDto, UpdateClientDto } from './dto';
import { TenantClientsService } from './tenant-clients.service';

/** A tenant's machine-to-machine clients. Clients themselves can never call this. */
@ApiTags('tenant clients')
@ApiBearerAuth('keycloak')
@JwtOnly()
@Controller('tenants/:tid/clients')
export class TenantClientsController {
  constructor(private readonly clients: TenantClientsService, private readonly authz: TenantAuthz) {}

  @Get()
  @ApiOkResponse({ type: [TenantClientDto], description: 'tenant:clients:read' })
  async list(@Access() a: AccessContext, @Param('tid', ParseUUIDPipe) tid: string): Promise<TenantClientDto[]> {
    return this.clients.list(await this.authz.require(a, tid, 'tenant:clients:read'));
  }

  @Post()
  @ApiCreatedResponse({ type: ClientCredentialsDto, description: 'tenant:clients:manage. Returns the secret once' })
  async create(@Access() a: AccessContext, @Param('tid', ParseUUIDPipe) tid: string, @Body() body: CreateClientDto): Promise<ClientCredentialsDto> {
    return this.clients.create(a, await this.authz.require(a, tid, 'tenant:clients:manage'), body);
  }

  @Patch(':id')
  @ApiOkResponse({ type: TenantClientDto, description: 'tenant:clients:manage' })
  async update(
    @Access() a: AccessContext,
    @Param('tid', ParseUUIDPipe) tid: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateClientDto,
  ): Promise<TenantClientDto> {
    return this.clients.update(a, await this.authz.require(a, tid, 'tenant:clients:manage'), id, body);
  }

  @Post(':id/rotate-secret')
  @ApiOkResponse({ type: ClientCredentialsDto, description: 'tenant:clients:manage. Returns the new secret once' })
  async rotate(@Access() a: AccessContext, @Param('tid', ParseUUIDPipe) tid: string, @Param('id', ParseUUIDPipe) id: string): Promise<ClientCredentialsDto> {
    return this.clients.rotateSecret(a, await this.authz.require(a, tid, 'tenant:clients:manage'), id);
  }

  @Delete(':id')
  @ApiOkResponse({ description: 'tenant:clients:manage. Deletes the Keycloak client; its usage history stays' })
  async remove(@Access() a: AccessContext, @Param('tid', ParseUUIDPipe) tid: string, @Param('id', ParseUUIDPipe) id: string) {
    await this.clients.remove(a, await this.authz.require(a, tid, 'tenant:clients:manage'), id);
    return { removed: true };
  }
}
