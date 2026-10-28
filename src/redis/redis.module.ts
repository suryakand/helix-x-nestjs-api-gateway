import { Global, Inject, Injectable, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { AppConfig } from '../config/configuration';

export const REDIS = Symbol('REDIS');
/** Pub/sub channel used to evict cached organizations and limits on every gateway instance (`<kind>:<id>`). */
export const INVALIDATE_CHANNEL = 'ef-gw:invalidate';

/** Fixed-window consume: refuses without incrementing once the limit is reached, so usage never overshoots. */
const CONSUME_LUA = `
local c = tonumber(redis.call('GET', KEYS[1]) or '0')
if c >= tonumber(ARGV[1]) then return {0, c} end
c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIREAT', KEYS[1], ARGV[2]) end
return {1, c}
`;

export type GatewayRedis = Redis & {
  windowConsume(key: string, limit: number, expireAtSec: number): Promise<[number, number]>;
};

@Injectable()
class RedisCloser implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: GatewayRedis) {}
  async onApplicationShutdown() {
    await this.redis.quit().catch(() => undefined);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const log = new Logger('Redis');
        const redis = new Redis(config.get('redisUrl', { infer: true }), {
          // Commands issued while (re)connecting wait for one reconnect attempt, then fail fast so the
          // limiters can apply their fail-open / fail-closed policy instead of hanging requests.
          maxRetriesPerRequest: 1,
          enableOfflineQueue: true,
          connectTimeout: 2000,
        });
        redis.on('error', (e) => log.warn(`redis: ${e.message}`));
        redis.defineCommand('windowConsume', { numberOfKeys: 1, lua: CONSUME_LUA });
        return redis as GatewayRedis;
      },
    },
    RedisCloser,
  ],
  exports: [REDIS],
})
export class RedisModule {}
