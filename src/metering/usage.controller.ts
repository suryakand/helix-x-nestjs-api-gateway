import { BadRequestException, Controller, DefaultValuePipe, Get, Param, ParseIntPipe, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, SelectQueryBuilder } from 'typeorm';
import { Access, JwtOnly } from '../access/decorators';
import { AccessContext } from '../access/request-context';
import { TenantAuthz } from '../access/tenant-authz.service';
import { sqlDayText, sqlTimestamp, sqlTimestampParam } from '../database/column-types';
import { PRINCIPAL_TYPE_VALUES as PRINCIPAL_TYPES } from '../options';
import { clampDays, since } from './usage-stats.service';

export class TopPrincipalDto {
  @ApiProperty({ enum: PRINCIPAL_TYPES, description: 'ADMIN = platform admins outside their own tenants' })
  type: string;
  @ApiProperty({ description: 'Keycloak user id (USER) or clientId (CLIENT)' }) key: string;
  @ApiProperty() label: string;
  @ApiProperty() requests: number;
  @ApiProperty() errors: number;
  @ApiProperty({ description: 'Units charged to the limit' }) billed: number;
}

export class DailyUsageDto {
  @ApiProperty({ example: '2026-10-16' }) day: string;
  @ApiProperty() requests: number;
  @ApiProperty() errors: number;
  @ApiProperty({ description: 'Units charged to the limit' }) billed: number;
}

export class RecentCallDto {
  @ApiProperty({ description: 'Row id in usage_logs (stable; for keys and links)' }) id: string;
  @ApiProperty() ts: string;
  @ApiPropertyOptional({ nullable: true, enum: PRINCIPAL_TYPES }) principalType: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) principalKey: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) principalLabel: string | null;
  @ApiProperty() method: string;
  @ApiProperty() endpoint: string;
  @ApiProperty() path: string;
  @ApiProperty() status: number;
  @ApiProperty() durationMs: number;
  @ApiProperty({ description: 'Units charged to the limit for this call' }) billedUnits: number;
}

/** Status groups for the calls filter. */
export const CALL_STATUS_FILTERS = ['ok', 'error', 'client', 'limited', 'server'] as const;
export type CallStatusFilter = (typeof CALL_STATUS_FILTERS)[number];

export class CallsPageDto {
  @ApiProperty({ type: [RecentCallDto] }) items: RecentCallDto[];
  @ApiProperty({ description: 'Calls matching the filters (all pages)' }) total: number;
  @ApiProperty() limit: number;
  @ApiProperty() offset: number;
}

type CallRow = {
  id: string | number; ts: Date | string; principal_type: string | null; principal_key: string | null; principal_label: string | null; method: string;
  endpoint: string; path: string; response_status: number; duration_ms: number; billed_units: number | null;
};

const toCall = (r: CallRow): RecentCallDto => ({
  id: String(r.id),
  ts: sqlTimestamp(r.ts).toISOString(),
  principalType: r.principal_type,
  principalKey: r.principal_key,
  principalLabel: r.principal_label,
  method: r.method,
  endpoint: r.endpoint,
  path: r.path,
  status: r.response_status,
  durationMs: r.duration_ms,
  billedUnits: Number(r.billed_units ?? 0),
});

const CALL_COLUMNS = [
  'id', 'ts', 'principal_type', 'principal_key', 'principal_label', 'method', 'endpoint', 'path', 'response_status', 'duration_ms', 'billed_units',
];

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/**
 * Usage per tenant, user and M2M client (tenant:usage:read). Aggregates come from usage_daily; only "recent"
 * reads usage_logs. Labels are stored with the rows, so no Keycloak lookups are needed.
 */
@ApiTags('usage')
@ApiBearerAuth('keycloak')
@JwtOnly()
@Controller('tenants/:tid/usage')
export class UsageController {
  constructor(@InjectDataSource() private readonly db: DataSource, private readonly authz: TenantAuthz) {}

  @Get('top-principals')
  @ApiQuery({ name: 'days', required: false, example: 30 })
  @ApiQuery({ name: 'limit', required: false, example: 10 })
  @ApiQuery({ name: 'offset', required: false, example: 0, description: 'Rows to skip (paging)' })
  @ApiQuery({ name: 'principalType', required: false, enum: PRINCIPAL_TYPES, description: 'Only users, only clients, …' })
  @ApiQuery({ name: 'sort', required: false, enum: ['requests', 'billed', 'errors'], description: 'Default requests' })
  @ApiOkResponse({ type: [TopPrincipalDto] })
  async topPrincipals(
    @Access() a: AccessContext,
    @Param('tid', ParseUUIDPipe) tid: string,
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset = 0,
    @Query('principalType') principalType?: string,
    @Query('sort') sort?: string,
  ): Promise<TopPrincipalDto[]> {
    await this.authz.require(a, tid, 'tenant:usage:read');
    if (sort !== undefined && !['requests', 'billed', 'errors'].includes(sort)) throw new BadRequestException('sort must be requests, billed or errors');
    const q = this.db
      .createQueryBuilder()
      .select(['principal_type', 'principal_key'])
      .addSelect('MAX(principal_label)', 'label')
      .addSelect('SUM(request_count)', 'requests')
      .addSelect('SUM(error_count)', 'errors')
      .addSelect('SUM(billed_count)', 'billed')
      .from('usage_daily', 'd')
      .where('tenant_id = :tid AND day >= :since', { tid, since: since(clampDays(days)) });
    if (principalType) q.andWhere('principal_type = :principalType', { principalType });
    const rows: { principal_type: string; principal_key: string; label: string | null; requests: string; errors: string; billed: string }[] = await q
      .groupBy('principal_type, principal_key')
      .orderBy(sort ?? 'requests', 'DESC')
      .addOrderBy('principal_key', 'ASC')
      .limit(clamp(limit, 1, 100))
      .offset(Math.max(offset, 0))
      .getRawMany();
    return rows.map((r) => ({
      type: r.principal_type, key: r.principal_key, label: r.label ?? r.principal_key, requests: Number(r.requests), errors: Number(r.errors),
      billed: Number(r.billed ?? 0),
    }));
  }

  @Get('daily')
  @ApiQuery({ name: 'days', required: false, example: 30 })
  @ApiQuery({ name: 'principalType', required: false })
  @ApiQuery({ name: 'principalKey', required: false })
  @ApiOkResponse({ type: [DailyUsageDto] })
  async daily(
    @Access() a: AccessContext,
    @Param('tid', ParseUUIDPipe) tid: string,
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
    @Query('principalType') principalType?: string,
    @Query('principalKey') principalKey?: string,
  ): Promise<DailyUsageDto[]> {
    await this.authz.require(a, tid, 'tenant:usage:read');
    const q = this.db
      .createQueryBuilder()
      .select(sqlDayText('day'), 'day')
      .addSelect('SUM(request_count)', 'requests')
      .addSelect('SUM(error_count)', 'errors')
      .addSelect('SUM(billed_count)', 'billed')
      .from('usage_daily', 'd')
      .where('tenant_id = :tid AND day >= :since', { tid, since: since(clampDays(days)) });
    if (principalType && principalKey) q.andWhere('principal_type = :principalType AND principal_key = :principalKey', { principalType, principalKey });
    const rows: { day: string; requests: string; errors: string; billed: string }[] = await q.groupBy('d.day').orderBy('d.day').getRawMany();
    return rows.map((r) => ({ day: r.day, requests: Number(r.requests), errors: Number(r.errors), billed: Number(r.billed ?? 0) }));
  }

  @Get('recent')
  @ApiQuery({ name: 'limit', required: false, example: 50 })
  @ApiQuery({ name: 'principalType', required: false })
  @ApiQuery({ name: 'principalKey', required: false })
  @ApiOkResponse({ type: [RecentCallDto] })
  async recent(
    @Access() a: AccessContext,
    @Param('tid', ParseUUIDPipe) tid: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit: number,
    @Query('principalType') principalType?: string,
    @Query('principalKey') principalKey?: string,
  ): Promise<RecentCallDto[]> {
    await this.authz.require(a, tid, 'tenant:usage:read');
    const q = this.db.createQueryBuilder().select(CALL_COLUMNS).from('usage_logs', 'l').where('tenant_id = :tid', { tid });
    if (principalType && principalKey) q.andWhere('principal_type = :principalType AND principal_key = :principalKey', { principalType, principalKey });
    const rows: CallRow[] = await q.orderBy('l.ts', 'DESC').limit(clamp(limit, 1, 500)).getRawMany();
    return rows.map(toCall);
  }

  /**
   * One page of the tenant's calls, newest first, with filters. `total` counts every matching call, for the pager.
   * Reads usage_logs within the last `days` (index idx_usage_logs_tenant_ts, or idx_usage_logs_principal for one caller).
   */
  @Get('calls')
  @ApiQuery({ name: 'days', required: false, example: 30 })
  @ApiQuery({ name: 'limit', required: false, example: 25, description: 'Page size, 1-200' })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiQuery({ name: 'principalType', required: false, description: `Comma-separated: ${PRINCIPAL_TYPES.join(', ')}` })
  @ApiQuery({ name: 'principalKey', required: false, description: 'One caller (with a single principalType)' })
  @ApiQuery({ name: 'endpoint', required: false, description: 'Comma-separated route templates, e.g. /orders/:id (see GET …/usage/endpoints)' })
  @ApiQuery({ name: 'method', required: false, example: 'GET,POST', description: 'Comma-separated' })
  @ApiQuery({
    name: 'status', required: false, example: 'client,server',
    description: `Comma-separated, any of ${CALL_STATUS_FILTERS.join(', ')}: ok <400, error ≥400, client 4xx but 429, limited 429, server 5xx`,
  })
  @ApiQuery({ name: 'billed', required: false, type: Boolean, description: 'true: only calls charged to the limit; false: only free ones' })
  @ApiQuery({ name: 'q', required: false, description: 'Text in the request path, case-insensitive' })
  @ApiOkResponse({ type: CallsPageDto })
  async calls(
    @Access() a: AccessContext,
    @Param('tid', ParseUUIDPipe) tid: string,
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
    @Query('limit', new DefaultValuePipe(25), ParseIntPipe) limit: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset: number,
    @Query('principalType') principalType?: string,
    @Query('principalKey') principalKey?: string,
    @Query('endpoint') endpoint?: string,
    @Query('method') method?: string,
    @Query('status') status?: string,
    @Query('billed') billed?: string,
    @Query('q') text?: string,
  ): Promise<CallsPageDto> {
    await this.authz.require(a, tid, 'tenant:usage:read');
    const statuses = list(status);
    const bad = statuses.find((x) => !(CALL_STATUS_FILTERS as readonly string[]).includes(x));
    if (bad) throw new BadRequestException(`status ${bad} is not one of ${CALL_STATUS_FILTERS.join(', ')}`);
    if (billed !== undefined && billed !== 'true' && billed !== 'false') throw new BadRequestException('billed must be true or false');
    const from = new Date(Date.now() - clampDays(days) * 86_400_000);
    const filtered = () => {
      const q = this.db.createQueryBuilder().from('usage_logs', 'l').where('tenant_id = :tid AND ts >= :from', { tid, from: sqlTimestampParam(from) });
      applyCallFilters(q, {
        principalTypes: list(principalType), principalKey, endpoints: list(endpoint), methods: list(method).map((m) => m.toUpperCase()),
        statuses: statuses as CallStatusFilter[], billed: billed === undefined ? undefined : billed === 'true', text,
      });
      return q;
    };
    const size = clamp(limit, 1, 200);
    const skip = Math.max(offset, 0);
    const [rows, count] = await Promise.all([
      filtered().select(CALL_COLUMNS).orderBy('l.ts', 'DESC').addOrderBy('l.id', 'DESC').limit(size).offset(skip).getRawMany<CallRow>(),
      filtered().select('COUNT(*)', 'n').getRawOne<{ n: string | number }>(),
    ]);
    return { items: rows.map(toCall), total: Number(count?.n ?? 0), limit: size, offset: skip };
  }

  /** Route templates called in the last `days`, for the calls filter. */
  @Get('endpoints')
  @ApiQuery({ name: 'days', required: false, example: 30 })
  @ApiOkResponse({ type: [String] })
  async endpoints(
    @Access() a: AccessContext,
    @Param('tid', ParseUUIDPipe) tid: string,
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
  ): Promise<string[]> {
    await this.authz.require(a, tid, 'tenant:usage:read');
    const rows: { endpoint: string }[] = await this.db
      .createQueryBuilder()
      .select('DISTINCT endpoint', 'endpoint')
      .from('usage_daily', 'd')
      .where('tenant_id = :tid AND day >= :since', { tid, since: since(clampDays(days)) })
      .orderBy('endpoint')
      .getRawMany();
    return rows.map((r) => r.endpoint);
  }
}

/** A comma-separated query parameter as its non-empty values. */
const list = (v?: string): string[] => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);

const STATUS_SQL: Record<CallStatusFilter, string> = {
  ok: 'response_status < 400',
  error: 'response_status >= 400',
  client: '(response_status >= 400 AND response_status < 500 AND response_status <> 429)',
  limited: 'response_status = 429',
  server: 'response_status >= 500',
};

/** Filters of the calls page. Lists match any of their values; filters combine with AND. */
export interface CallFilters {
  principalTypes?: string[];
  /** One caller: only with exactly one principal type. */
  principalKey?: string;
  endpoints?: string[];
  methods?: string[];
  statuses?: CallStatusFilter[];
  /** true: only charged calls; false: only free ones; undefined: both. */
  billed?: boolean;
  /** Case-insensitive text in the request path. */
  text?: string;
}

/** The calls filters as SQL conditions (parameters only, never interpolated values). Exported for tests. */
export function applyCallFilters(q: SelectQueryBuilder<object>, f: CallFilters): void {
  if (f.principalTypes?.length) q.andWhere('principal_type IN (:...principalTypes)', { principalTypes: f.principalTypes });
  if (f.principalTypes?.length === 1 && f.principalKey) q.andWhere('principal_key = :principalKey', { principalKey: f.principalKey });
  if (f.endpoints?.length) q.andWhere('endpoint IN (:...endpoints)', { endpoints: f.endpoints });
  if (f.methods?.length) q.andWhere('method IN (:...methods)', { methods: f.methods });
  if (f.statuses?.length) q.andWhere(`(${[...new Set(f.statuses)].map((x) => STATUS_SQL[x]).join(' OR ')})`);
  if (f.billed !== undefined) q.andWhere(f.billed ? 'billed_units > 0' : 'billed_units = 0');
  const text = f.text?.trim();
  if (text) {
    // LIKE wildcards in the search text are literal.
    const pattern = `%${text.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    q.andWhere("LOWER(path) LIKE :pattern ESCAPE '\\'", { pattern });
  }
}
