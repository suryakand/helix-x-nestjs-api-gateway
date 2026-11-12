import { Module } from '@nestjs/common';
import { GatewayModule } from '../../src';
import { policy } from './access-policy';

@Module({
  imports: [
    GatewayModule.forRoot({
      policy,
      naming: { serviceName: 'acme-orders', claimPrefix: 'acme' },
      forwardPrincipalHeader: true,
      // x-acme-permissions: the caller's effective service permissions, for finer checks upstream.
      forwardPermissionsHeader: true,
      defaults: {
        port: 3900,
        upstreamUrl: 'http://localhost:3901',
        keycloakIssuer: 'http://localhost:8180/realms/acme-org',
        databasePath: 'data/example-gateway.sqlite',
      },
    }),
  ],
})
export class AppModule {}
