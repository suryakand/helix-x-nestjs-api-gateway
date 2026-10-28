import { Body, Controller, Post } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { configureGateway, gatewayOptions, PRINCIPAL_TYPE_VALUES, resolveNaming } from '../src/options';
import { CreateClientDto } from '../src/tenancy/dto';
import { POLICY } from './fixtures/acme';

describe('naming', () => {
  it('derives every claim, attribute, mapper and header name from the prefixes', () => {
    expect(resolveNaming({ serviceName: 'acme-orders', claimPrefix: 'acme' })).toEqual({
      serviceName: 'acme-orders',
      tenantClaim: 'acme_tenant',
      tenantIdClaim: 'acme_tenant_id',
      tenantIdAttribute: 'acme_tenant_id',
      clientTenantAttribute: 'acme.tenant',
      tenantMapperName: 'acme-tenant',
      tenantIdMapperName: 'acme-tenant-id',
      tenantHeader: 'x-acme-tenant-id',
      principalHeader: 'x-acme-principal',
    });
    expect(resolveNaming({ serviceName: 's', claimPrefix: 'ef', headerPrefix: 'gw' }).tenantHeader).toBe('x-gw-tenant-id');
    expect(() => resolveNaming({ serviceName: 's', claimPrefix: 'Bad-Prefix' })).toThrow(/prefixes/);
  });
});

describe('configureGateway', () => {
  beforeAll(() => configureGateway({
    policy: POLICY,
    naming: { serviceName: 'acme-orders', claimPrefix: 'acme' },
    extraPrincipalTypes: ['LEGACY'],
  }));

  it('records the options', () => {
    expect(gatewayOptions()).toMatchObject({ forwardPrincipalHeader: false, entities: [], naming: { tenantHeader: 'x-acme-tenant-id' } });
    expect(PRINCIPAL_TYPE_VALUES).toEqual(['USER', 'CLIENT', 'ADMIN', 'LEGACY']);
  });

  it('DTOs decorated before configuration validate against the configured service permissions', async () => {
    const dto = (permissions: string[]) => plainToInstance(CreateClientDto, { name: 'ERP', permissions, rateLimit: { type: 'UNLIMITED' } });
    expect(await validate(dto(['orders:read', 'catalog:read']))).toEqual([]);
    const errors = await validate(dto(['orders:read', 'tenant:users:manage']));
    expect(errors.map((e) => e.property)).toEqual(['permissions']);
  });

  it('and document them as the Swagger enum', async () => {
    @Controller('clients')
    class ClientsController {
      @Post() create(@Body() _dto: CreateClientDto) {}
    }
    const mod = await Test.createTestingModule({ controllers: [ClientsController] }).compile();
    const app = mod.createNestApplication();
    await app.init();
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    await app.close();
    const schema = doc.components?.schemas?.CreateClientDto as { properties: Record<string, { type?: string; items?: { enum?: string[] } }> };
    expect(schema.properties.permissions).toEqual({ type: 'array', items: { type: 'string', enum: ['orders:create', 'orders:read', 'catalog:read'] } });
  });
});
