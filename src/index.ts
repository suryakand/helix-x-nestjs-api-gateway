/**
 * `@helix-x/nestjs-api-gateway`: a multi-tenant access gateway for NestJS. Keycloak organizations are the
 * tenants; user and M2M client tokens are checked against a product's route table; usage is metered and
 * limited per principal; an admin API drives Keycloak; authorized calls stream to the upstream service.
 *
 * A product supplies its policy ({@link defineAccessPolicy}), its naming and its defaults to
 * {@link GatewayModule.forRoot}, and starts with {@link bootstrapGateway}. See the README.
 * @packageDocumentation
 */

// Setup
export { GatewayModule } from './gateway.module';
export { bootstrapGateway, BootstrapOptions } from './bootstrap';
export {
  configureGateway, CORE_PRINCIPAL_TYPES, GATEWAY_OPTIONS, gatewayOptions, GatewayModuleOptions, GatewayNaming, GatewayNamingInput,
  ProductMigrations, ResolvedGatewayOptions, resolveNaming,
} from './options';
export { AppConfig, GatewayDefaults, readGatewayConfig } from './config/configuration';

// Policy
export {
  AccessPolicy, AccessPolicyInput, CorePlatformPermission, defineAccessPolicy, GatewayPermission, PLATFORM_PERMISSIONS, RouteRule,
  TENANT_ADMIN_PERMISSIONS, TENANT_GROUP_NAMES, TENANT_GROUPS, TenantAdminPermission, TenantGroup,
} from './access/access-policy';

// Access decision (pure) and request context
export {
  AccessInput, AccessOutcome, AccessPorts, decideAccess, DenyStatus, OrgInfo, resolveTenant, revocationKeys, RouteMode, TenantResolution,
} from './access/access-decision';
export { Caller, CallerContext, parseCaller, PrincipalType, TenantGrant } from './access/caller';
export { KeycloakClaims, JwtVerifier } from './access/jwt.verifier';
export { AccessContext, GatewayRequest } from './access/request-context';
export { Access, Authenticated, JwtOnly, ProxyRoute, Public } from './access/decorators';
export { checkClientPermissions, checkGroupChange, checkKeepsAdmin } from './tenancy/admin-guard';
export {
  ClientCredentialsDto, CreateClientDto, InvitedUserDto, InviteUserDto, RateLimitConfigDto, RateLimitStateDto, TenantClientDto, TenantUserDto,
  slugPart, UpdateClientDto, UpdateTenantUserDto, UsageTotalsDto,
} from './tenancy/dto';

// Services a product's controllers and scripts may inject
export { RevocationService } from './access/revocation.service';
export { TenantAuthz } from './access/tenant-authz.service';
export { KcClient, KcGroup, KcOrganization, KcRole, KcUser, KeycloakAdminService } from './keycloak/keycloak-admin.service';
export { OrgDirectory, orgInfo } from './keycloak/org-directory.service';
export { Catalog, PermissionCatalog, PermissionInfo } from './keycloak/permission-catalog.service';
export { LimitConfig, LimitsService, LimitState } from './metering/limits.service';
export { ConsumeResult, Metered, RateLimiterService, UsageSnapshot } from './metering/rate-limiter.service';
export { UsageRecord, UsageRecorder } from './metering/usage-recorder.service';
export { UsageStatsService, UsageTotals } from './metering/usage-stats.service';
export { AuditService } from './tenancy/audit.service';
export { GroupState, TenantGroupIds, TenantProvisioning } from './tenancy/tenant-provisioning.service';
export { TenantUsersService } from './tenancy/tenant-users.service';
export { TenantClientsService } from './tenancy/tenant-clients.service';
export { InvalidationHandler, InvalidationKind, InvalidationService } from './redis/invalidation.service';
export { GatewayRedis, REDIS } from './redis/redis.module';

// Database
export { AdminAudit, AuthType, ENTITIES, PrincipalType as LimitPrincipalType, PrincipalLimit, RATE_LIMIT_TYPES, RateLimitType, UsageDaily, UsageLog } from './database/entities';
export { COL, DB_KIND, DbKind, sqlDayText, sqlTimestamp } from './database/column-types';
export { dataSourceOptions, describeTarget, migrateAll, MigrationSet, migrationSets } from './database/data-source';
export {
  DEFAULT_MIGRATIONS_DIR, GATEWAY_LEDGER_TABLE, LEDGER_TABLE, LedgerRow, listMigrations, migrate, MigrateDriver, MigrateOptions, MigrateResult,
  MigrationFile, MigrationPlan, planMigrations, readLedger, SELF_RECORDED, splitStatements,
} from './database/migrate/schema-migrate';
export { runMigrateCli } from './database/migrate/migrate-cli';

// Testing helpers
export { checkGeneratedRealm, checkRealmTemplate, RealmJson, RealmRole } from './testing/realm-check';
