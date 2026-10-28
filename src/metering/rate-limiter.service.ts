import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { AppConfig } from '../config/configuration';
import { PrincipalLimit, RateLimitType } from '../database/entities';
import { GatewayRedis, REDIS } from '../redis/redis.module';
import { isWindowType, redisKeyFor, windowFor } from './rate-window';

export interface ConsumeResult {
  allowed: boolean;
  /** Undefined for UNLIMITED. */
  limit?: number;
  remaining?: number;
  /** Window end; undefined for FIXED/UNLIMITED. */
  resetsAt?: Date;
  /** The limiter backend was unreachable (and RATE_LIMIT_FAIL_OPEN decided `allowed`). */
  degraded?: boolean;
}

export interface UsageSnapshot { type: RateLimitType; value: number | null; currentUsage: number | null; resetsAt: Date | null }

/** What a quota is configured on: a user's or client's limit row in one tenant. */
export type Metered = Pick<PrincipalLimit, 'id' | 'rateLimitType' | 'rateLimitValue' | 'fixedUsed'>;

/**
 * Per-principal (user or client within a tenant) quota enforcement. FIXED quotas are an atomic conditional UPDATE in postgres (durable);
 * DAILY/WEEKLY/MONTHLY are fixed UTC windows counted in Redis by a Lua script.
 */
@Injectable()
export class RateLimiterService {
  private readonly log = new Logger(RateLimiterService.name);
  private readonly failOpen: boolean;

  constructor(
    @Inject(REDIS) private readonly redis: GatewayRedis,
    @InjectDataSource() private readonly db: DataSource,
    config: ConfigService<AppConfig, true>,
  ) {
    this.failOpen = config.get('limits', { infer: true }).failOpen;
  }

  async consume(key: Metered, now = new Date()): Promise<ConsumeResult> {
    const type = key.rateLimitType;
    if (type === 'UNLIMITED') return { allowed: true };
    const limit = key.rateLimitValue ?? 0;

    if (type === 'FIXED') {
      const used = await this.consumeFixed(key.id);
      if (used === undefined) return { allowed: false, limit, remaining: 0 };
      return { allowed: true, limit, remaining: Math.max(0, limit - used) };
    }

    if (!isWindowType(type)) return { allowed: false };
    const w = windowFor(type, now);
    try {
      const [ok, count] = await this.redis.windowConsume(
        redisKeyFor(key.id, type, w), limit, Math.floor(w.end.getTime() / 1000) + 3600,
      );
      return { allowed: ok === 1, limit, remaining: Math.max(0, limit - count), resetsAt: w.end };
    } catch (e) {
      this.log.warn(`rate limiter unavailable (${(e as Error).message}); failOpen=${this.failOpen}`);
      return { allowed: this.failOpen, limit, resetsAt: w.end, degraded: true };
    }
  }

  /**
   * One atomic `fixed_used + 1` while under the limit; the new count, or undefined when the quota is spent.
   * Postgres does it in one UPDATE … RETURNING. TypeORM has no RETURNING for SQLite, so there the UPDATE and the
   * read share a transaction (SQLite serializes writers, so no other increment can land in between).
   */
  private async consumeFixed(id: string): Promise<number | undefined> {
    const increment = (em: EntityManager) =>
      em
        .createQueryBuilder()
        .update(PrincipalLimit)
        .set({ fixedUsed: () => 'fixed_used + 1' })
        .where('id = :id AND fixed_used < rate_limit_value', { id });
    if (this.db.options.type === 'postgres') {
      const res = await increment(this.db.manager).returning('fixed_used').execute();
      return (res.raw as { fixed_used: number }[])[0]?.fixed_used;
    }
    return this.db.transaction(async (em) => {
      if (!(await increment(em).execute()).affected) return undefined;
      return (await em.findOneByOrFail(PrincipalLimit, { id })).fixedUsed;
    });
  }

  /** Live usage for the admin API (Redis for windows, the DB column for FIXED). */
  async snapshot(key: Metered, now = new Date()): Promise<UsageSnapshot> {
    const type = key.rateLimitType;
    if (type === 'FIXED') return { type, value: key.rateLimitValue, currentUsage: key.fixedUsed, resetsAt: null };
    if (!isWindowType(type)) return { type, value: null, currentUsage: null, resetsAt: null };
    const w = windowFor(type, now);
    const v = await this.redis.get(redisKeyFor(key.id, type, w)).catch(() => null);
    return { type, value: key.rateLimitValue, currentUsage: v === null ? 0 : Number(v), resetsAt: w.end };
  }

  /** Clears the current window's counter (FIXED is reset in the DB by the caller). */
  async resetWindow(key: Metered, now = new Date()) {
    for (const t of ['DAILY', 'WEEKLY', 'MONTHLY'] as const) {
      await this.redis.del(redisKeyFor(key.id, t, windowFor(t, now))).catch(() => undefined);
    }
  }
}
