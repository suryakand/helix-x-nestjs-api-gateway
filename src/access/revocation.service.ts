import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { GatewayRedis, REDIS } from '../redis/redis.module';

/**
 * Makes admin actions apply before already-issued tokens expire. Each revocation stores "tokens issued at or
 * before <now> are void" under a key (`user:<sub>`, `client:<clientId>`, `tenant:<id>`, `member:<tenant>:<sub>`),
 * kept for at least the access-token lifetime. A token issued afterwards carries Keycloak's current state, so
 * it passes. Changes made directly in the Keycloak console are not seen here and apply when tokens expire.
 */
@Injectable()
export class RevocationService {
  private readonly log = new Logger(RevocationService.name);
  private readonly ttl: number;

  constructor(@Inject(REDIS) private readonly redis: GatewayRedis, config: ConfigService<AppConfig, true>) {
    this.ttl = config.get('revocationTtlSec', { infer: true });
  }

  /** Voids every token of these keys issued up to now (on every gateway instance: the state is in Redis). */
  async revoke(...keys: string[]): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const multi = this.redis.multi();
    for (const k of keys) multi.set(`rv:${k}`, String(now), 'EX', this.ttl);
    await multi.exec().catch((e) => this.log.warn(`revocation not stored (${(e as Error).message}); it applies when tokens expire`));
  }

  /** Latest revocation time among the keys. Fails open: without Redis, tokens are trusted until they expire. */
  async revokedBefore(keys: string[]): Promise<number | undefined> {
    if (!keys.length) return undefined;
    const values = await this.redis.mget(...keys.map((k) => `rv:${k}`)).catch((e) => {
      this.log.warn(`revocation check skipped: ${(e as Error).message}`);
      return [] as (string | null)[];
    });
    const times = values.filter((v): v is string => v !== null).map(Number);
    return times.length ? Math.max(...times) : undefined;
  }
}
