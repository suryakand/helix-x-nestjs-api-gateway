import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Caller, PrincipalType } from '../access/caller';
import { PrincipalLimit, RateLimitType } from '../database/entities';
import { InvalidationService } from '../redis/invalidation.service';
import { ConsumeResult, RateLimiterService } from './rate-limiter.service';

const CACHE_MS = 30_000;
const CACHE_MAX = 20_000;

export interface LimitConfig { type: RateLimitType; value?: number }
export interface LimitState { type: RateLimitType; value: number | null; currentUsage: number | null; resetsAt: string | null }
const UNLIMITED: LimitState = { type: 'UNLIMITED', value: null, currentUsage: null, resetsAt: null };

/** Per-principal usage limits (the only access-related data the gateway stores). No row = unlimited. */
@Injectable()
export class LimitsService {
  private readonly cache = new Map<string, { row: PrincipalLimit | null; at: number }>();

  constructor(
    @InjectRepository(PrincipalLimit) private readonly repo: Repository<PrincipalLimit>,
    private readonly limiter: RateLimiterService,
    private readonly invalidation: InvalidationService,
  ) {
    invalidation.on('limit', (key) => this.cache.delete(key));
  }

  /** Charges one call to the caller's limit in this tenant. */
  async consume(tenantId: string, caller: Caller): Promise<ConsumeResult> {
    const row = await this.get(tenantId, caller.type, caller.key);
    return row && row.rateLimitType !== 'UNLIMITED' ? this.limiter.consume(row) : { allowed: true };
  }

  async state(tenantId: string, type: PrincipalType, key: string): Promise<LimitState> {
    const row = await this.repo.findOneBy({ tenantId, principalType: type, principalKey: key });
    return this.toState(row);
  }

  /** All rows of a tenant, keyed by `${type}:${key}`, for admin lists. */
  async statesFor(tenantId: string, type: PrincipalType): Promise<Map<string, LimitState>> {
    const rows = await this.repo.findBy({ tenantId, principalType: type });
    const out = new Map<string, LimitState>();
    for (const r of rows) out.set(r.principalKey, await this.toState(r));
    return out;
  }

  async set(tenantId: string, type: PrincipalType, key: string, change: { rateLimit?: LimitConfig; resetUsage?: boolean }): Promise<LimitState> {
    let row = await this.repo.findOneBy({ tenantId, principalType: type, principalKey: key });
    row ??= this.repo.create({ tenantId, principalType: type, principalKey: key });
    if (change.rateLimit) {
      if (change.rateLimit.type !== row.rateLimitType) row.fixedUsed = 0;
      row.rateLimitType = change.rateLimit.type;
      row.rateLimitValue = change.rateLimit.type === 'UNLIMITED' ? null : change.rateLimit.value!;
    }
    if (change.resetUsage) {
      row.fixedUsed = 0;
      if (row.id) await this.limiter.resetWindow(row);
    }
    row = await this.repo.save(row);
    await this.invalidation.publish('limit', this.cacheKey(tenantId, type, key));
    return this.toState(row);
  }

  async remove(tenantId: string, type: PrincipalType, key: string): Promise<void> {
    const row = await this.repo.findOneBy({ tenantId, principalType: type, principalKey: key });
    if (!row) return;
    await this.limiter.resetWindow(row);
    await this.repo.delete({ id: row.id });
    await this.invalidation.publish('limit', this.cacheKey(tenantId, type, key));
  }

  private async get(tenantId: string, type: PrincipalType, key: string): Promise<PrincipalLimit | null> {
    const ck = this.cacheKey(tenantId, type, key);
    const hit = this.cache.get(ck);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.row;
    const row = await this.repo.findOneBy({ tenantId, principalType: type, principalKey: key });
    this.cache.set(ck, { row, at: Date.now() });
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    return row;
  }

  private cacheKey(tenantId: string, type: PrincipalType, key: string) {
    return `${tenantId}|${type}|${key}`;
  }

  private async toState(row: PrincipalLimit | null): Promise<LimitState> {
    if (!row) return UNLIMITED;
    const s = await this.limiter.snapshot(row);
    return { type: s.type, value: s.value, currentUsage: s.currentUsage, resetsAt: s.resetsAt?.toISOString() ?? null };
  }
}
