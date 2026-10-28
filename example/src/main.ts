import { bootstrapGateway } from '../../src';
import { AppModule } from './app.module';

void bootstrapGateway(AppModule, {
  title: 'Acme Orders API Gateway',
  description: 'Multi-tenant access to Acme Orders.',
});
