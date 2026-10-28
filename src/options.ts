import { DynamicModule, ForwardReference, Provider, Type } from '@nestjs/common';
import { AccessPolicy } from './access/access-policy';
import { GatewayDefaults } from './config/configuration';

/**
 * How the product names its claims, attributes and headers. Every name is derived from two prefixes, so a
 * product picks e.g. `ef` and gets `ef_tenant`, `ef_tenant_id`, `x-ef-tenant-id`, … The realm generator
 * (`@helix-x/kc-realm-generator`) uses the same claim prefix.
 */
export interface GatewayNamingInput {
  /** Shown in messages and Keycloak descriptions, e.g. `acme-orders`. */
  serviceName: string;
  /** Prefix of the token claims and organization attributes, e.g. `acme` → `acme_tenant_id`. */
  claimPrefix: string;
  /** Prefix of the headers the gateway sends upstream, e.g. `acme` → `x-acme-tenant-id`. Defaults to claimPrefix. */
  headerPrefix?: string;
}

/** Every name derived from {@link GatewayNamingInput}. */
export interface GatewayNaming {
  /** e.g. `acme-orders`. */
  serviceName: string;
  /** M2M client tokens: the organization id the client belongs to (hardcoded-claim mapper), e.g. `acme_tenant`. */
  tenantClaim: string;
  /** M2M client tokens: the tenant id the upstream stores, e.g. `acme_tenant_id`. */
  tenantIdClaim: string;
  /** Organization attribute holding the tenant id; user tokens carry it per organization. Same as tenantIdClaim. */
  tenantIdAttribute: string;
  /** Client attribute naming the organization an M2M client belongs to, e.g. `acme.tenant`. */
  clientTenantAttribute: string;
  /** Name of the protocol mapper that adds tenantClaim to an M2M client's tokens, e.g. `acme-tenant`. */
  tenantMapperName: string;
  /** Name of the protocol mapper that adds tenantIdClaim, e.g. `acme-tenant-id`. */
  tenantIdMapperName: string;
  /** Header carrying the resolved tenant id upstream, e.g. `x-acme-tenant-id`. */
  tenantHeader: string;
  /** Header carrying `TYPE:key` of the caller upstream (only with forwardPrincipalHeader), e.g. `x-acme-principal`. */
  principalHeader: string;
}

/** Derives every name from the two prefixes. Pure. */
export function resolveNaming(input: GatewayNamingInput): GatewayNaming {
  const c = input.claimPrefix;
  const h = input.headerPrefix ?? c;
  if (!/^[a-z][a-z0-9]*$/.test(c) || !/^[a-z][a-z0-9]*$/.test(h)) {
    throw new Error(`gateway naming: prefixes must be lower-case letters and digits, got ${c} / ${h}`);
  }
  return {
    serviceName: input.serviceName,
    tenantClaim: `${c}_tenant`,
    tenantIdClaim: `${c}_tenant_id`,
    tenantIdAttribute: `${c}_tenant_id`,
    clientTenantAttribute: `${c}.tenant`,
    tenantMapperName: `${c}-tenant`,
    tenantIdMapperName: `${c}-tenant-id`,
    tenantHeader: `x-${h}-tenant-id`,
    principalHeader: `x-${h}-principal`,
  };
}

/** Product schema migrations, applied after the gateway's own (see the README, "Schema migrations"). */
export interface ProductMigrations {
  /** Folder of `NNN_name.sql` files, with SQLite twins in `<dir>/sqlite`. */
  dir: string;
  /** Ledger table of these files. Default `schema_migrations`. */
  ledgerTable?: string;
}

/** Everything a product passes to `GatewayModule.forRoot`. */
export interface GatewayModuleOptions {
  /** The product's routes and permissions, from `defineAccessPolicy`. */
  policy: AccessPolicy;
  /** The product's claim and header names. */
  naming: GatewayNamingInput;
  /** Send `x-<prefix>-principal: TYPE:key` upstream with every proxied call. Default false. */
  forwardPrincipalHeader?: boolean;
  /** Defaults for settings not in the environment (ports, Keycloak ids, database). The environment always wins. */
  defaults?: GatewayDefaults;
  /** Extra principal types that appear in old usage rows (e.g. `LEGACY`), listed by the usage API. */
  extraPrincipalTypes?: string[];
  /** Extra TypeORM entities, e.g. tables only the product's own scripts read. */
  entities?: Function[];
  /** The product's own schema migrations, applied after the gateway's. */
  migrations?: ProductMigrations;
  /** Extra modules, controllers and providers. Controllers are registered before the proxy. */
  imports?: (Type | DynamicModule | Promise<DynamicModule> | ForwardReference)[];
  controllers?: Type[];
  providers?: Provider[];
}

/** {@link GatewayModuleOptions} with the naming resolved. */
export interface ResolvedGatewayOptions extends Omit<GatewayModuleOptions, 'naming'> {
  naming: GatewayNaming;
  forwardPrincipalHeader: boolean;
  defaults: GatewayDefaults;
  extraPrincipalTypes: string[];
  entities: Function[];
}

/** Injection token of the {@link ResolvedGatewayOptions}. */
export const GATEWAY_OPTIONS = Symbol('GATEWAY_OPTIONS');

/** Principal types in usage rows: users, clients and platform admins outside their own tenants. */
export const CORE_PRINCIPAL_TYPES = ['USER', 'CLIENT', 'ADMIN'] as const;

/**
 * Arrays referenced by DTO decorators (`@IsIn`, `@ApiProperty({ enum })`). Decorators run when the library is
 * imported, before the product's options are known, so they hold these arrays by reference and
 * {@link configureGateway} fills them in. Both class-validator and the Swagger document read them later, at
 * request and at document time.
 * @internal
 */
export const SERVICE_PERMISSION_VALUES: string[] = [];
/** @internal */
export const PRINCIPAL_TYPE_VALUES: string[] = [...CORE_PRINCIPAL_TYPES];

let current: ResolvedGatewayOptions | undefined;

/**
 * Resolves and records the options. One gateway per process: `GatewayModule.forRoot` calls this, and so does the
 * migration CLI. Calling it again replaces the options.
 */
export function configureGateway(options: GatewayModuleOptions): ResolvedGatewayOptions {
  const resolved: ResolvedGatewayOptions = {
    ...options,
    naming: resolveNaming(options.naming),
    forwardPrincipalHeader: options.forwardPrincipalHeader ?? false,
    defaults: options.defaults ?? {},
    extraPrincipalTypes: options.extraPrincipalTypes ?? [],
    entities: options.entities ?? [],
  };
  SERVICE_PERMISSION_VALUES.splice(0, SERVICE_PERMISSION_VALUES.length, ...resolved.policy.servicePermissions);
  PRINCIPAL_TYPE_VALUES.splice(0, PRINCIPAL_TYPE_VALUES.length, ...CORE_PRINCIPAL_TYPES, ...resolved.extraPrincipalTypes);
  current = resolved;
  return resolved;
}

/** The options recorded by {@link configureGateway}; throws before it has run. */
export function gatewayOptions(): ResolvedGatewayOptions {
  if (!current) throw new Error('@helix-x/nestjs-api-gateway: call GatewayModule.forRoot() (or configureGateway()) first');
  return current;
}
