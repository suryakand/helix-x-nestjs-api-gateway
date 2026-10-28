import { DynamicModule, MiddlewareConsumer, Module, NestModule, Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtVerifier } from './access/jwt.verifier';
import { RevocationService } from './access/revocation.service';
import { TenantAuthz } from './access/tenant-authz.service';
import { UnifiedAccessGuard } from './access/unified-access.guard';
import { readGatewayConfig } from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { GlobalRateLimitMiddleware } from './global-limit/global-rate-limit.middleware';
import { IpLimiterService } from './global-limit/ip-limiter.service';
import { HealthController } from './health/health.controller';
import { KeycloakAdminService } from './keycloak/keycloak-admin.service';
import { OrgDirectory } from './keycloak/org-directory.service';
import { PermissionCatalog } from './keycloak/permission-catalog.service';
import { LimitsService } from './metering/limits.service';
import { RateLimiterService } from './metering/rate-limiter.service';
import { UsageRecorder } from './metering/usage-recorder.service';
import { UsageStatsService } from './metering/usage-stats.service';
import { UsageController } from './metering/usage.controller';
import { UsageMiddleware } from './metering/usage.middleware';
import { configureGateway, GATEWAY_OPTIONS, GatewayModuleOptions } from './options';
import { createProxyController } from './proxy/proxy.controller';
import { InvalidationService } from './redis/invalidation.service';
import { RedisModule } from './redis/redis.module';
import { AuditService } from './tenancy/audit.service';
import { PlatformUsersController } from './tenancy/platform-users.controller';
import { TenantClientsController } from './tenancy/tenant-clients.controller';
import { TenantClientsService } from './tenancy/tenant-clients.service';
import { TenantProvisioning } from './tenancy/tenant-provisioning.service';
import { TenantUsersController } from './tenancy/tenant-users.controller';
import { TenantUsersService } from './tenancy/tenant-users.service';
import { TenantsController } from './tenancy/tenants.controller';

/** Services a product's own controllers and scripts may inject. */
const EXPORTED = [
  JwtVerifier, RevocationService, TenantAuthz, KeycloakAdminService, OrgDirectory, PermissionCatalog, InvalidationService,
  LimitsService, RateLimiterService, UsageRecorder, UsageStatsService, AuditService, TenantProvisioning,
  TenantUsersService, TenantClientsService,
];

/**
 * The whole gateway as one module: Keycloak token checks, tenants, admin API, metering, limits and the proxy.
 * A product's app module is usually just `GatewayModule.forRoot({ policy, naming, defaults })`.
 */
@Module({})
export class GatewayModule implements NestModule {
  private static proxy?: Type;

  /** Records the options (see `configureGateway`) and builds the module. One gateway per process. */
  static forRoot(options: GatewayModuleOptions): DynamicModule {
    const o = configureGateway(options);
    const proxy = createProxyController(o.policy.upstreamPrefixes, o.naming, o.forwardPrincipalHeader);
    GatewayModule.proxy = proxy;
    return {
      module: GatewayModule,
      global: true,
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [() => readGatewayConfig(o.defaults)] }),
        DatabaseModule.forRoot(o.entities, o.migrations),
        RedisModule,
        ...(o.imports ?? []),
      ],
      // The proxy last: its routes are prefixes owned by the upstream, the others are the gateway's own API.
      controllers: [
        HealthController, TenantsController, TenantUsersController, TenantClientsController, PlatformUsersController, UsageController,
        ...(o.controllers ?? []),
        proxy,
      ],
      providers: [
        { provide: GATEWAY_OPTIONS, useValue: o },
        ...EXPORTED, IpLimiterService,
        { provide: APP_GUARD, useClass: UnifiedAccessGuard },
        ...(o.providers ?? []),
      ],
      exports: [GATEWAY_OPTIONS, ...EXPORTED, DatabaseModule],
    };
  }

  configure(consumer: MiddlewareConsumer) {
    // Global per-IP budget runs before everything (and before usage logging, so floods aren't written to the DB).
    consumer.apply(GlobalRateLimitMiddleware).forRoutes('*path');
    if (GatewayModule.proxy) consumer.apply(UsageMiddleware).forRoutes(GatewayModule.proxy);
  }
}
