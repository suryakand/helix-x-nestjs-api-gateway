import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { sqlTimestamp } from '../database/column-types';

export interface UsageTotals { requests: number; errors: number }
export const NO_USAGE: UsageTotals = { requests: 0, errors: 0 };

export const clampDays = (d: number) => Math.min(Math.max(d, 1), 366);
/** First day (UTC, YYYY-MM-DD) of a `days`-long window ending today. */
export const since = (days: number) => new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);

/** Per-principal totals for the users and clients admin lists, keyed by principal key. */
@Injectable()
export class UsageStatsService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  /** From the usage_daily rollup. */
  async totals(tenantId: string, type: 'USER' | 'CLIENT', days = 30): Promise<Map<string, UsageTotals>> {
    const rows: { principal_key: string; requests: string; errors: string }[] = await this.db
      .createQueryBuilder()
      .select('principal_key')
      .addSelect('SUM(request_count)', 'requests')
      .addSelect('SUM(error_count)', 'errors')
      .from('usage_daily', 'd')
      .where('tenant_id = :tenantId AND principal_type = :type AND day >= :since', { tenantId, type, since: since(clampDays(days)) })
      .groupBy('principal_key')
      .getRawMany();
    return new Map(rows.map((r) => [r.principal_key, { requests: Number(r.requests), errors: Number(r.errors) }]));
  }

  /** Last call per principal (index idx_usage_logs_principal). */
  async lastSeen(tenantId: string, type: 'USER' | 'CLIENT'): Promise<Map<string, string>> {
    const rows: { principal_key: string; ts: Date | string }[] = await this.db
      .createQueryBuilder()
      .select('principal_key')
      .addSelect('MAX(ts)', 'ts')
      .from('usage_logs', 'l')
      .where('tenant_id = :tenantId AND principal_type = :type', { tenantId, type })
      .groupBy('principal_key')
      .getRawMany();
    return new Map(rows.map((r) => [r.principal_key, sqlTimestamp(r.ts).toISOString()]));
  }
}
