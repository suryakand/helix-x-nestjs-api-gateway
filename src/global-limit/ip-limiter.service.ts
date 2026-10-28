import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { GatewayRedis, REDIS } from '../redis/redis.module';

/**
 * Infrastructure-level protection, independent of tenant quotas: a per-IP request budget per minute and a
 * tighter per-IP budget for failed authentications. Fails open — a Redis outage must not take the API down
 * here (per-key quotas decide that separately with RATE_LIMIT_FAIL_OPEN).
 */
@Injectable()
export class IpLimiterService {
  private readonly log = new Logger(IpLimiterService.name);
  private readonly limits: AppConfig['limits'];

  constructor(@Inject(REDIS) private readonly redis: GatewayRedis, config: ConfigService<AppConfig, true>) {
    this.limits = config.get('limits', { infer: true });
  }

  /** Counts one request; returns seconds to wait when over budget, else 0. */
  hit(ip: string): Promise<number> {
    return this.consume(`gl:req:${ip}`, this.limits.globalPerMin);
  }

  /** True when this IP already failed authentication too often in the current minute. */
  async authBlocked(ip: string): Promise<boolean> {
    const v = await this.redis.get(this.authKey(ip)).catch(() => null);
    return v !== null && Number(v) >= this.limits.authFailPerMin;
  }

  async recordAuthFailure(ip: string) {
    const key = this.authKey(ip);
    await this.redis.multi().incr(key).expire(key, 120).exec().catch(() => undefined);
  }

  retryAfterSec(): number {
    return 60 - new Date().getUTCSeconds();
  }

  private authKey(ip: string) {
    return `gl:authfail:${ip}:${Math.floor(Date.now() / 60_000)}`;
  }

  private async consume(prefix: string, limit: number): Promise<number> {
    if (limit <= 0) return 0;
    const minute = Math.floor(Date.now() / 60_000);
    try {
      const [ok] = await this.redis.windowConsume(`${prefix}:${minute}`, limit, (minute + 2) * 60);
      return ok === 1 ? 0 : this.retryAfterSec();
    } catch (e) {
      this.log.debug(`global limit skipped: ${(e as Error).message}`);
      return 0;
    }
  }
}
