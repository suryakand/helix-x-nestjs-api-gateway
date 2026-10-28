import { BadGatewayException, Controller, Get, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Authenticated, Public } from '../access/decorators';
import { AppConfig } from '../config/configuration';
import { gatewayOptions } from '../options';
import { GatewayRedis, REDIS } from '../redis/redis.module';

export class GatewayHealthDto {
  @ApiProperty({ enum: ['ok', 'degraded'] }) status: 'ok' | 'degraded';
  @ApiProperty() database: boolean;
  @ApiProperty() redis: boolean;
  @ApiProperty() upstream: boolean;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly upstream: string;
  private readonly serviceName = gatewayOptions().naming.serviceName;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @Inject(REDIS) private readonly redis: GatewayRedis,
    config: ConfigService<AppConfig, true>,
  ) {
    this.upstream = config.get('upstreamUrl', { infer: true });
  }

  @Public()
  @Get()
  @ApiOkResponse({ type: GatewayHealthDto })
  async get(): Promise<GatewayHealthDto> {
    const [database, redis, upstream] = await Promise.all([
      this.db.query('SELECT 1').then(() => true, () => false),
      this.redis.ping().then((r) => r === 'PONG', () => false),
      fetch(`${this.upstream}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false),
    ]);
    return { status: database && redis && upstream ? 'ok' : 'degraded', database, redis, upstream };
  }

  /** The upstream's own /health, for signed-in clients; it is internal detail, so not public. */
  @Authenticated()
  @ApiBearerAuth('keycloak')
  @Get('service')
  @ApiOkResponse({ description: 'The upstream /health body, unchanged' })
  async service(): Promise<unknown> {
    const res = await fetch(`${this.upstream}/health`, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    if (!res?.ok) throw new BadGatewayException(`${this.serviceName} service unavailable`);
    return res.json();
  }
}
