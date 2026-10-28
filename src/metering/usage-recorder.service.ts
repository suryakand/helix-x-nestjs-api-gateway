import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AppConfig } from '../config/configuration';
import { AuthType, UsageDaily, UsageLog } from '../database/entities';

export interface UsageRecord {
  ts: Date;
  tenantId: string | null;
  /** USER, CLIENT, or ADMIN (platform admin outside their own tenants); null before authentication. */
  principalType: string | null;
  principalKey: string | null;
  principalLabel: string | null;
  authType: AuthType | null;
  method: string;
  endpoint: string;
  path: string;
  responseStatus: number;
  durationMs: number;
  clientIp: string | null;
}

/**
 * Write-behind buffer for usage logs: `record()` is synchronous and never touches the database, a timer
 * flushes batches as one transaction (raw rows + the usage_daily rollup). Bounded: under sustained DB
 * failure the oldest rows are dropped rather than growing memory without limit.
 */
@Injectable()
export class UsageRecorder implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(UsageRecorder.name);
  private buffer: UsageRecord[] = [];
  private timer?: NodeJS.Timeout;
  private flushing?: Promise<void>;
  private dropped = 0;
  private readonly cfg: AppConfig['usage'];

  constructor(@InjectDataSource() private readonly db: DataSource, config: ConfigService<AppConfig, true>) {
    this.cfg = config.get('usage', { infer: true });
  }

  onModuleInit() {
    this.timer = setInterval(() => void this.flush(), this.cfg.flushMs);
    this.timer.unref();
  }

  async onApplicationShutdown() {
    clearInterval(this.timer);
    await this.flushing;
    while (this.buffer.length) {
      const before = this.buffer.length;
      await this.flush();
      if (this.buffer.length >= before) break; // DB gone; give up rather than hang shutdown
    }
  }

  record(r: UsageRecord) {
    this.buffer.push(r);
    if (this.buffer.length > this.cfg.maxBuffer) {
      this.buffer.splice(0, this.buffer.length - this.cfg.maxBuffer);
      if (this.dropped++ % 1000 === 0) this.log.warn(`usage buffer full (${this.cfg.maxBuffer}); dropping oldest rows`);
    }
    if (this.buffer.length >= this.cfg.flushBatch) void this.flush();
  }

  flush(): Promise<void> {
    if (this.flushing || !this.buffer.length) return this.flushing ?? Promise.resolve();
    const batch = this.buffer.splice(0, this.cfg.flushBatch * 4);
    this.flushing = this.write(batch)
      .catch((e) => {
        this.log.warn(`usage flush failed (${batch.length} rows requeued): ${e.message}`);
        this.buffer.unshift(...batch);
      })
      .finally(() => (this.flushing = undefined));
    return this.flushing;
  }

  private async write(batch: UsageRecord[]) {
    const daily = new Map<string, UsageDaily>();
    for (const r of batch) {
      // Unauthenticated rejections have no tenant or principal to bill.
      if (!r.tenantId || !r.principalType || !r.principalKey) continue;
      const day = r.ts.toISOString().slice(0, 10);
      const k = `${day}|${r.tenantId}|${r.principalType}|${r.principalKey}|${r.endpoint}`;
      const d = daily.get(k) ?? Object.assign(new UsageDaily(), {
        day, tenantId: r.tenantId, principalType: r.principalType, principalKey: r.principalKey, principalLabel: r.principalLabel,
        endpoint: r.endpoint, requestCount: 0, errorCount: 0,
      });
      d.requestCount++;
      if (r.responseStatus >= 400) d.errorCount++;
      daily.set(k, d);
    }
    await this.db.transaction(async (em) => {
      await em.createQueryBuilder().insert().into(UsageLog).values(batch).updateEntity(false).execute();
      if (daily.size) {
        await em
          .createQueryBuilder()
          .insert()
          .into(UsageDaily)
          .values([...daily.values()])
          .onConflict(
            `("day", "tenant_id", "endpoint", "principal_type", "principal_key") DO UPDATE SET
               "principal_label" = COALESCE(EXCLUDED.principal_label, usage_daily.principal_label),
               "request_count" = usage_daily.request_count + EXCLUDED.request_count,
               "error_count" = usage_daily.error_count + EXCLUDED.error_count`,
          )
          .updateEntity(false)
          .execute();
      }
    });
  }
}
