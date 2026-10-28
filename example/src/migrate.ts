import { runMigrateCli } from '../../src';

// Same defaults as app.module.ts; a product with its own migrations passes `migrations: { dir }` here and there.
void runMigrateCli({ defaults: { databasePath: 'data/example-gateway.sqlite' } });
