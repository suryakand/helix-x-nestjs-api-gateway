import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { GatewayRedis, INVALIDATE_CHANNEL, REDIS } from './redis.module';

export type InvalidationKind = 'org' | 'limit';
/** Called with the id of the changed organization or limit. */
export type InvalidationHandler = (id: string) => void;

/**
 * Cross-instance cache eviction. A change made on one gateway instance (organization renamed or suspended, a
 * limit changed) is published as `<kind>:<id>`; every instance, this one included, runs the handlers that the
 * caches registered for that kind. (Access revocations don't use this: they live in Redis, see RevocationService.)
 */
@Injectable()
export class InvalidationService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(InvalidationService.name);
  private readonly handlers = new Map<InvalidationKind, InvalidationHandler[]>();
  private subscriber?: GatewayRedis;

  constructor(@Inject(REDIS) private readonly redis: GatewayRedis) {}

  async onModuleInit() {
    // Own connection (subscribe mode); queue the SUBSCRIBE until connected and re-subscribe after reconnects.
    this.subscriber = this.redis.duplicate({ enableOfflineQueue: true, autoResubscribe: true }) as GatewayRedis;
    this.subscriber.on('error', () => undefined); // logged by the main connection
    this.subscriber.on('message', (_ch, msg: string) => this.dispatch(msg));
    await this.subscriber.subscribe(INVALIDATE_CHANNEL).catch((e) => this.log.warn(`no invalidation feed: ${e.message}`));
  }

  async onModuleDestroy() {
    await this.subscriber?.quit().catch(() => undefined);
  }

  on(kind: InvalidationKind, handler: InvalidationHandler) {
    this.handlers.set(kind, [...(this.handlers.get(kind) ?? []), handler]);
  }

  /** Evicts locally right away (the published copy is then a harmless repeat) and on every other instance. */
  async publish(kind: InvalidationKind, id: string) {
    const msg = `${kind}:${id}`;
    this.dispatch(msg);
    await this.redis.publish(INVALIDATE_CHANNEL, msg).catch((e) => this.log.warn(`invalidate publish failed: ${e.message}`));
  }

  private dispatch(msg: string) {
    const i = msg.indexOf(':');
    const kind = msg.slice(0, i) as InvalidationKind;
    for (const h of this.handlers.get(kind) ?? []) h(msg.slice(i + 1));
  }
}
