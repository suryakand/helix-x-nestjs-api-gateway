import {
  Check, Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn,
  Unique, UpdateDateColumn,
} from 'typeorm';
import { COL } from './column-types';

/**
 * Gateway schema (PostgreSQL, or SQLite for local runs: column types per driver come from ./column-types). Keycloak holds every piece of authentication and authorization data:
 * tenants (organizations), users and their tenant groups, M2M clients, permissions. The gateway stores only
 * what Keycloak can't: usage limits per principal (`principal_limits`), metering (`usage_logs` raw,
 * `usage_daily` rollup) and an audit trail of admin actions (`admin_audit`).
 * Principals are keyed the way tokens name them: USER = Keycloak user id (`sub`), CLIENT = clientId.
 * Schema changes are a new file in ../../migrations (and its sqlite/ twin) — synchronize is off.
 */

export type RateLimitType = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'FIXED' | 'UNLIMITED';
/** JWT = a signed-in user, CLIENT = a client_credentials token. */
export type AuthType = 'JWT' | 'CLIENT';
export type PrincipalType = 'USER' | 'CLIENT';
export const RATE_LIMIT_TYPES: RateLimitType[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'FIXED', 'UNLIMITED'];

/**
 * Usage limit of one user or M2M client within one tenant. No row = unlimited. Who the principal is and what
 * it may do lives in Keycloak; this row only meters it.
 */
@Entity('principal_limits')
@Unique('uq_principal_limits', ['tenantId', 'principalType', 'principalKey'])
@Check('chk_principal_limits', `"rate_limit_type" = 'UNLIMITED' OR "rate_limit_value" > 0`)
export class PrincipalLimit {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ name: 'tenant_id', ...COL.uuid }) tenantId: string;
  @Column({ name: 'principal_type', type: 'varchar', length: 8 }) principalType: PrincipalType;
  /** Keycloak user id (USER) or clientId (CLIENT). */
  @Column({ name: 'principal_key', type: 'varchar', length: 255 }) principalKey: string;
  @Column({ name: 'rate_limit_type', type: 'varchar', length: 16, default: 'UNLIMITED' }) rateLimitType: RateLimitType;
  @Column({ name: 'rate_limit_value', type: 'int', nullable: true }) rateLimitValue: number | null;
  /** Consumed part of a FIXED quota. Windowed (DAILY/WEEKLY/MONTHLY) counters live in Redis. */
  @Column({ name: 'fixed_used', type: 'int', default: 0 }) fixedUsed: number;
  @UpdateDateColumn({ name: 'updated_at', ...COL.timestamptz }) updatedAt: Date;
}

/** Append-only record of every change made through the gateway's admin API. */
@Entity('admin_audit')
@Index('idx_admin_audit_tenant_ts', ['tenantId', 'ts'])
export class AdminAudit {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: string;
  @CreateDateColumn({ ...COL.timestamptz }) ts: Date;
  /** Keycloak user id of the admin. */
  @Column({ name: 'actor_key', type: 'varchar', length: 255 }) actorKey: string;
  @Column({ name: 'actor_label', type: 'varchar', length: 255 }) actorLabel: string;
  @Column({ name: 'tenant_id', ...COL.uuid, nullable: true }) tenantId: string | null;
  /** e.g. user.invite, user.group, client.create, tenant.suspend. */
  @Column({ type: 'varchar', length: 64 }) action: string;
  @Column({ type: 'varchar', length: 255, nullable: true }) target: string | null;
  @Column({ ...COL.json, nullable: true }) detail: Record<string, unknown> | null;
}

/** One row per request, written asynchronously in batches by UsageRecorder. */
@Entity('usage_logs')
@Index('idx_usage_logs_tenant_ts', ['tenantId', 'ts'])
@Index('idx_usage_logs_principal', ['tenantId', 'principalType', 'principalKey', 'ts'])
export class UsageLog {
  @PrimaryGeneratedColumn({ type: 'bigint' }) id: string;
  @Column({ ...COL.timestamptz }) ts: Date;
  /** No foreign keys: tenants, users and clients live in Keycloak, and usage outlives them. */
  @Column({ name: 'tenant_id', ...COL.uuid, nullable: true }) tenantId: string | null;
  /** USER, CLIENT or ADMIN (platform admin outside their tenants). */
  @Column({ name: 'principal_type', type: 'varchar', length: 8, nullable: true }) principalType: string | null;
  /** Keycloak user id (USER) or clientId (CLIENT). */
  @Column({ name: 'principal_key', type: 'varchar', length: 255, nullable: true }) principalKey: string | null;
  /** Name at call time (user's name or username, clientId), so usage lists need no Keycloak lookups. */
  @Column({ name: 'principal_label', type: 'varchar', length: 255, nullable: true }) principalLabel: string | null;
  @Column({ name: 'auth_type', type: 'varchar', length: 8, nullable: true }) authType: AuthType | null;
  @Column({ type: 'varchar', length: 8 }) method: string;
  /** Route template, e.g. /searches/:id — groups well, carries no ids. */
  @Column({ type: 'varchar', length: 200 }) endpoint: string;
  @Column({ type: 'varchar', length: 500 }) path: string;
  @Column({ name: 'response_status', type: 'smallint' }) responseStatus: number;
  @Column({ name: 'duration_ms', type: 'int' }) durationMs: number;
  @Column({ name: 'client_ip', ...COL.inet, nullable: true }) clientIp: string | null;
}


/** Daily rollup upserted with every usage flush; backs "top users/clients" and usage charts. */
@Entity('usage_daily')
@Index('idx_usage_daily_tenant_day', ['tenantId', 'day'])
export class UsageDaily {
  @PrimaryColumn({ type: 'date' }) day: string;
  @PrimaryColumn({ name: 'tenant_id', ...COL.uuid }) tenantId: string;
  /** USER, CLIENT, or ADMIN for platform admins outside their own tenants (logged, not metered). */
  @PrimaryColumn({ name: 'principal_type', type: 'varchar', length: 8 }) principalType: string;
  @PrimaryColumn({ name: 'principal_key', type: 'varchar', length: 255 }) principalKey: string;
  @PrimaryColumn({ type: 'varchar', length: 200 }) endpoint: string;
  /** Latest name seen for the principal. */
  @Column({ name: 'principal_label', type: 'varchar', length: 255, nullable: true }) principalLabel: string | null;
  @Column({ name: 'request_count', type: 'int', default: 0 }) requestCount: number;
  @Column({ name: 'error_count', type: 'int', default: 0 }) errorCount: number;
}

export const ENTITIES = [
  PrincipalLimit, AdminAudit, UsageLog, UsageDaily,
];
