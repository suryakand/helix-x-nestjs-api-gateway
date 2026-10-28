import { Controller, DefaultValuePipe, Get, Param, ParseIntPipe, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiPropertyOptional, ApiQuery, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Access, JwtOnly } from '../access/decorators';
import { AccessContext } from '../access/request-context';
import { TenantAuthz } from '../access/tenant-authz.service';
import { sqlDayText, sqlTimestamp } from '../database/column-types';
import { PRINCIPAL_TYPE_VALUES as PRINCIPAL_TYPES } from '../options';
import { clampDays, since } from './usage-stats.service';

export class TopPrincipalDto {
  @ApiProperty({ enum: PRINCIPAL_TYPES, description: 'ADMIN = platform admins outside their own tenants' })
  type: string;
  @ApiProperty({ description: 'Keycloak user id (USER) or clientId (CLIENT)' }) key: string;
  @ApiProperty() label: string;
  @ApiProperty() requests: number;
  @ApiProperty() errors: number;
}

export class DailyUsageDto {
  @ApiProperty({ example: '2026-10-16' }) day: string;
  @ApiProperty() requests: number;
  @ApiProperty() errors: number;
}

export class RecentCallDto {
  @ApiProperty() ts: string;
  @ApiPropertyOptional({ nullable: true, enum: PRINCIPAL_TYPES }) principalType: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) principalKey: string | null;
  @ApiPropertyOptional({ nullable: true, type: String }) principalLabel: string | null;
  @ApiProperty() method: string;
  @ApiProperty() endpoint: string;
  @ApiProperty() path: string;
  @ApiProperty() status: number;
  @ApiProperty() durationMs: number;
}

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
  @ApiOkResponse({ type: [TopPrincipalDto] })
  async topPrincipals(
    @Access() a: AccessContext,
    @Param('tid', ParseUUIDPipe) tid: string,
    @Query('days', new DefaultValuePipe(30), ParseIntPipe) days: number,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ): Promise<TopPrincipalDto[]> {
    await this.authz.require(a, tid, 'tenant:usage:read');
    const rows: { principal_type: string; principal_key: string; label: string | null; requests: string; errors: string }[] = await this.db
      .createQueryBuilder()
      .select(['principal_type', 'principal_key'])
      .addSelect('MAX(principal_label)', 'label')
      .addSelect('SUM(request_count)', 'requests')
      .addSelect('SUM(error_count)', 'errors')
      .from('usage_daily', 'd')
      .where('tenant_id = :tid AND day >= :since', { tid, since: since(clampDays(days)) })
      .groupBy('principal_type, principal_key')
      .orderBy('requests', 'DESC')
      .limit(Math.min(Math.max(limit, 1), 100))
      .getRawMany();
    return rows.map((r) => ({
      type: r.principal_type, key: r.principal_key, label: r.label ?? r.principal_key, requests: Number(r.requests), errors: Number(r.errors),
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
      .from('usage_daily', 'd')
      .where('tenant_id = :tid AND day >= :since', { tid, since: since(clampDays(days)) });
    if (principalType && principalKey) q.andWhere('principal_type = :principalType AND principal_key = :principalKey', { principalType, principalKey });
    const rows: { day: string; requests: string; errors: string }[] = await q.groupBy('d.day').orderBy('d.day').getRawMany();
    return rows.map((r) => ({ day: r.day, requests: Number(r.requests), errors: Number(r.errors) }));
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
    const q = this.db
      .createQueryBuilder()
      .select(['ts', 'principal_type', 'principal_key', 'principal_label', 'method', 'endpoint', 'path', 'response_status', 'duration_ms'])
      .from('usage_logs', 'l')
      .where('tenant_id = :tid', { tid });
    if (principalType && principalKey) q.andWhere('principal_type = :principalType AND principal_key = :principalKey', { principalType, principalKey });
    const rows: {
      ts: Date | string; principal_type: string | null; principal_key: string | null; principal_label: string | null; method: string;
      endpoint: string; path: string; response_status: number; duration_ms: number;
    }[] = await q.orderBy('l.ts', 'DESC').limit(Math.min(Math.max(limit, 1), 500)).getRawMany();
    return rows.map((r) => ({
      ts: sqlTimestamp(r.ts).toISOString(),
      principalType: r.principal_type,
      principalKey: r.principal_key,
      principalLabel: r.principal_label,
      method: r.method,
      endpoint: r.endpoint,
      path: r.path,
      status: r.response_status,
      durationMs: r.duration_ms,
    }));
  }
}
