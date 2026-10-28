import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayUnique, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Length, Matches, Max, Min, ValidateIf,
  ValidateNested,
} from 'class-validator';
import { TENANT_GROUP_NAMES, TenantGroup } from '../access/access-policy';
import { SERVICE_PERMISSION_VALUES } from '../options';

/**
 * Swagger schema of a list of service permissions. SERVICE_PERMISSION_VALUES is empty when this runs and filled in
 * by configureGateway (see options.ts); Swagger and class-validator both hold it by reference. The item type is
 * given, because Swagger would infer it from the (still empty) values.
 */
const PERMISSION_LIST = { type: 'array', items: { type: 'string', enum: SERVICE_PERMISSION_VALUES } } as const;
import { RATE_LIMIT_TYPES, RateLimitType } from '../database/entities';

export class RateLimitConfigDto {
  @ApiProperty({ enum: RATE_LIMIT_TYPES }) @IsIn(RATE_LIMIT_TYPES) type: RateLimitType;
  @ApiPropertyOptional({ description: 'Threshold; required unless UNLIMITED', minimum: 1 })
  @ValidateIf((o: RateLimitConfigDto) => o.type !== 'UNLIMITED')
  @IsInt() @Min(1) @Max(1_000_000_000)
  value?: number;
}

export class RateLimitStateDto {
  @ApiProperty({ enum: RATE_LIMIT_TYPES }) type: RateLimitType;
  @ApiPropertyOptional({ nullable: true, type: Number }) value: number | null;
  @ApiPropertyOptional({ nullable: true, type: Number, description: 'Calls in the current window, or consumed FIXED quota' })
  currentUsage: number | null;
  @ApiPropertyOptional({ nullable: true, type: String, description: 'End of the current window (DAILY/WEEKLY/MONTHLY)' })
  resetsAt: string | null;
}

export class UsageTotalsDto {
  @ApiProperty() requests: number;
  @ApiProperty() errors: number;
}

// ---- identity and tenants ---------------------------------------------------------------------------

export class TenantDto {
  @ApiProperty({ format: 'uuid', description: 'Tenant id (organization attribute <prefix>_tenant_id); send as x-tenant-id' }) id: string;
  @ApiProperty({ format: 'uuid', description: 'Keycloak organization id' }) orgId: string;
  @ApiProperty({ description: 'Organization alias' }) slug: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED'] }) status: 'ACTIVE' | 'SUSPENDED';
  @ApiPropertyOptional({ type: [String], nullable: true, description: "The caller's permissions here (from the token)" })
  permissions: string[] | null;
  @ApiPropertyOptional({ nullable: true, description: 'false: a platform admin who is not a member (not metered)' })
  member: boolean | null;
  @ApiPropertyOptional({ nullable: true, type: Number, description: 'Platform admin list only' }) userCount: number | null;
  @ApiPropertyOptional({ nullable: true, type: Number, description: 'Platform admin list only' }) clientCount: number | null;
}

export class OrganizationGroupDto {
  @ApiProperty({ enum: TENANT_GROUP_NAMES }) name: TenantGroup;
  @ApiPropertyOptional({ nullable: true, type: String, format: 'uuid', description: 'null = missing (Set up creates it)' }) id: string | null;
  @ApiProperty({ example: 'tenant-member', description: 'Bundle role the group should grant' }) bundle: string;
  @ApiProperty({ description: 'The bundle role is mapped to the group' }) roleMapped: boolean;
  @ApiProperty({ type: [String], description: 'Permissions the bundle grants' }) permissions: string[];
  @ApiProperty() memberCount: number;
}

export class UnprovisionedOrganizationDto {
  @ApiProperty({ format: 'uuid' }) orgId: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiProperty() enabled: boolean;
  @ApiProperty({ description: 'Has a tenant id attribute' }) hasTenantId: boolean;
  @ApiProperty({ type: [String], enum: TENANT_GROUP_NAMES, description: 'Tenant groups that are missing or lack their bundle role' })
  missingGroups: TenantGroup[];
}

export class MeUserDto {
  @ApiProperty({ format: 'uuid' }) keycloakId: string;
  @ApiPropertyOptional({ nullable: true, type: String }) username: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) email: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) displayName: string | null;
}

export class MeDto {
  @ApiProperty({ type: MeUserDto }) user: MeUserDto;
  @ApiProperty({ type: [String], description: 'Permissions not tied to a tenant (platform:*, and those applying in every tenant)' })
  permissions: string[];
  @ApiProperty({ type: [TenantDto], description: "The organizations in the caller's token, with their permissions there" })
  tenants: TenantDto[];
}

export class CreateTenantDto {
  @ApiProperty({ example: 'Acme Logistics' }) @IsString() @Length(2, 200) name: string;
  @ApiProperty({ example: 'acme-logistics', description: 'Becomes the Keycloak organization alias; cannot be changed later' })
  @Matches(/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/)
  slug: string;
  @ApiPropertyOptional({ description: 'First tenant admin: an existing Keycloak user, or a new account invited by email' })
  @IsOptional() @IsEmail()
  adminEmail?: string;
}

export class UpdateTenantDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 200) name?: string;
  @ApiPropertyOptional({ enum: ['ACTIVE', 'SUSPENDED'] }) @IsOptional() @IsIn(['ACTIVE', 'SUSPENDED']) status?: 'ACTIVE' | 'SUSPENDED';
}

export class PermissionInfoDto {
  @ApiProperty() name: string;
  @ApiPropertyOptional({ nullable: true, type: String }) description: string | null;
  @ApiProperty({ enum: ['service', 'tenant', 'platform', 'other'] }) kind: 'service' | 'tenant' | 'platform' | 'other';
}

export class TenantGroupInfoDto {
  @ApiProperty({ enum: TENANT_GROUP_NAMES }) name: TenantGroup;
  @ApiProperty({ example: 'tenant-member' }) bundle: string;
  @ApiProperty({ type: [String] }) permissions: string[];
}

export class PermissionCatalogDto {
  @ApiProperty({ type: [PermissionInfoDto], description: 'Client roles of the resource-server client, as defined in Keycloak' })
  permissions: PermissionInfoDto[];
  @ApiProperty({ type: [TenantGroupInfoDto], description: "Every tenant's groups and what their bundle grants" })
  groups: TenantGroupInfoDto[];
}

// ---- tenant users ------------------------------------------------------------------------------------

const GROUP_OR_NONE = [...TENANT_GROUP_NAMES, 'none'] as const;

export class TenantUserDto {
  @ApiProperty({ format: 'uuid', description: 'Keycloak user id (route key)' }) keycloakId: string;
  @ApiProperty() username: string;
  @ApiPropertyOptional({ nullable: true, type: String }) email: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) displayName: string | null;
  @ApiProperty({ description: 'Keycloak account enabled (global)' }) enabled: boolean;
  @ApiPropertyOptional({ enum: TENANT_GROUP_NAMES, nullable: true, description: 'null = member without access in this tenant' })
  group: TenantGroup | null;
  @ApiProperty({ type: [String], description: "Permissions from the group's bundle" }) permissions: string[];
  @ApiProperty({ type: RateLimitStateDto }) rateLimit: RateLimitStateDto;
  @ApiPropertyOptional({ nullable: true, type: String, description: 'Last call through the gateway in this tenant' }) lastSeenAt: string | null;
  @ApiProperty({ type: UsageTotalsDto }) usage30d: UsageTotalsDto;
}

export class InviteUserDto {
  @ApiProperty() @IsEmail() email: string;
  @ApiProperty({ enum: TENANT_GROUP_NAMES }) @IsIn(TENANT_GROUP_NAMES) group: TenantGroup;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) firstName?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 100) lastName?: string;
  @ApiPropertyOptional({ description: 'New accounts only: a password the user must change at first sign-in (when no invite email can be sent)' })
  @IsOptional() @IsString() @Length(8, 128)
  temporaryPassword?: string;
  @ApiPropertyOptional({ type: RateLimitConfigDto }) @IsOptional() @ValidateNested() @Type(() => RateLimitConfigDto) rateLimit?: RateLimitConfigDto;
}

export class InvitedUserDto {
  @ApiProperty({ type: TenantUserDto }) user: TenantUserDto;
  @ApiProperty({ description: 'A new Keycloak account was created' }) created: boolean;
  @ApiProperty({ description: 'Keycloak sent the "set your password" email' }) inviteEmailSent: boolean;
}

export class UpdateTenantUserDto {
  @ApiPropertyOptional({ enum: GROUP_OR_NONE, description: "'none' keeps the member in the organization without any access here" })
  @IsOptional() @IsIn(GROUP_OR_NONE)
  group?: TenantGroup | 'none';
  @ApiPropertyOptional({ type: RateLimitConfigDto }) @IsOptional() @ValidateNested() @Type(() => RateLimitConfigDto) rateLimit?: RateLimitConfigDto;
  @ApiPropertyOptional({ description: 'Zero the consumed FIXED quota and the current window counter' }) @IsOptional() @IsBoolean() resetUsage?: boolean;
}

// ---- tenant M2M clients ------------------------------------------------------------------------------

export class TenantClientDto {
  @ApiProperty({ format: 'uuid', description: 'Keycloak client id (internal uuid; route key)' }) id: string;
  @ApiProperty({ example: 'acme-m2m-erp-7k2q', description: 'OAuth2 client_id' }) clientId: string;
  @ApiProperty() name: string;
  @ApiProperty() enabled: boolean;
  @ApiProperty(PERMISSION_LIST) permissions: string[];
  @ApiProperty({ type: RateLimitStateDto }) rateLimit: RateLimitStateDto;
  @ApiPropertyOptional({ nullable: true, type: String }) lastUsedAt: string | null;
  @ApiProperty({ type: UsageTotalsDto }) usage30d: UsageTotalsDto;
}

export class ClientCredentialsDto {
  @ApiProperty({ type: TenantClientDto }) client: TenantClientDto;
  @ApiProperty({ description: 'Shown once; store it now. Keycloak keeps it, the gateway never does.' }) clientSecret: string;
  @ApiProperty({ example: 'http://localhost:8180/realms/acme-org/protocol/openid-connect/token' }) tokenUrl: string;
}

export class CreateClientDto {
  @ApiProperty({ example: 'ERP integration' }) @IsString() @Length(1, 120) name: string;
  @ApiProperty(PERMISSION_LIST)
  @IsArray() @ArrayUnique() @IsIn(SERVICE_PERMISSION_VALUES, { each: true })
  permissions: string[];
  @ApiProperty({ type: RateLimitConfigDto }) @ValidateNested() @Type(() => RateLimitConfigDto) rateLimit: RateLimitConfigDto;
}

export class UpdateClientDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 120) name?: string;
  @ApiPropertyOptional(PERMISSION_LIST)
  @IsOptional() @IsArray() @ArrayUnique() @IsIn(SERVICE_PERMISSION_VALUES, { each: true })
  permissions?: string[];
  @ApiPropertyOptional({ description: 'Enables/disables the Keycloak client' }) @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional({ type: RateLimitConfigDto }) @IsOptional() @ValidateNested() @Type(() => RateLimitConfigDto) rateLimit?: RateLimitConfigDto;
  @ApiPropertyOptional({ description: 'Zero the consumed FIXED quota and the current window counter' }) @IsOptional() @IsBoolean() resetUsage?: boolean;
}

// ---- platform ---------------------------------------------------------------------------------------

export class PlatformUserDto {
  @ApiProperty({ format: 'uuid' }) keycloakId: string;
  @ApiProperty() username: string;
  @ApiPropertyOptional({ nullable: true, type: String }) email: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) displayName: string | null;
  @ApiProperty() enabled: boolean;
  @ApiProperty({ type: [String], description: 'Organization aliases (tenant slugs)' }) tenants: string[];
}

export class UpdatePlatformUserDto {
  @ApiProperty({ description: 'false disables the Keycloak account everywhere, ends its sessions and voids its tokens' }) @IsBoolean() enabled: boolean;
}

export class AuditEntryDto {
  @ApiProperty() ts: string;
  @ApiProperty() actor: string;
  @ApiProperty() action: string;
  @ApiPropertyOptional({ nullable: true, type: String }) target: string | null;
  @ApiPropertyOptional({ nullable: true, type: Object }) detail: Record<string, unknown> | null;
}

/** clientId-safe fragment of a display name. */
/** A lower-case, dash-separated part of a clientId (at most 30 characters). */
export const slugPart = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'client';
