import 'reflect-metadata';
import * as fs from 'node:fs';
import { dirname } from 'node:path';
import { DataSource, DataSourceOptions } from 'typeorm';
import { AppConfig } from '../config/configuration';
import { ProductMigrations } from '../options';
import { ENTITIES } from './entities';
import { DEFAULT_MIGRATIONS_DIR, GATEWAY_LEDGER_TABLE, LEDGER_TABLE, migrate, MigrateResult } from './migrate/schema-migrate';

/**
 * Shared by the Nest module, the migration CLI and a product's TypeORM CLI entry. The schema is migrations/*.sql
 * (src/database/migrate), so TypeORM never changes it.
 */
export function dataSourceOptions(db: AppConfig['database'], entities: DataSourceOptions['entities'] = ENTITIES): DataSourceOptions {
  if (db.type === 'sqlite') {
    // sqlite3 creates the file, not its folder.
    fs.mkdirSync(dirname(db.path), { recursive: true });
    return { type: 'sqlite', database: db.path, entities, synchronize: false };
  }
  return {
    type: 'postgres',
    host: db.host,
    port: db.port,
    username: db.username,
    password: db.password,
    database: db.name,
    entities,
    synchronize: false,
  };
}

/** Where a connection points, for logs and the CLI banner (no password). */
export const describeTarget = (db: AppConfig['database']): string =>
  db.type === 'sqlite' ? `sqlite ${db.path}` : `postgres ${db.username}@${db.host}:${db.port}/${db.name}`;

/** One migration set: a folder and the ledger table its files record themselves in. */
export interface MigrationSet { name: string; dir: string; ledgerTable: string }

/** The gateway's own migrations, then the product's (if any). */
export function migrationSets(product?: ProductMigrations): MigrationSet[] {
  const sets: MigrationSet[] = [{ name: 'gateway', dir: DEFAULT_MIGRATIONS_DIR, ledgerTable: GATEWAY_LEDGER_TABLE }];
  if (product) sets.push({ name: 'product', dir: product.dir, ledgerTable: product.ledgerTable ?? LEDGER_TABLE });
  return sets;
}

/** Applies every pending file of every set, in order, on a connection without entities. */
export async function migrateAll(
  db: AppConfig['database'], product: ProductMigrations | undefined, opts: { dryRun?: boolean; log?: (m: string) => void } = {},
): Promise<{ set: MigrationSet; result: MigrateResult }[]> {
  const ds = await new DataSource(dataSourceOptions(db, [])).initialize();
  try {
    const out: { set: MigrationSet; result: MigrateResult }[] = [];
    for (const set of migrationSets(product)) {
      out.push({ set, result: await migrate(ds, { driver: db.type, dir: set.dir, ledgerTable: set.ledgerTable, ...opts }) });
    }
    return out;
  } finally {
    await ds.destroy();
  }
}
