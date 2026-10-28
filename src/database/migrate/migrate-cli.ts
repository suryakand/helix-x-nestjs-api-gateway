import 'reflect-metadata';
import * as fs from 'node:fs';
import { DataSource } from 'typeorm';
import { readGatewayConfig } from '../../config/configuration';
import { GatewayModuleOptions } from '../../options';
import { dataSourceOptions, describeTarget, migrateAll, migrationSets } from '../data-source';
import { listMigrations, planMigrations, readLedger } from './schema-migrate';

/**
 * Schema migrations from the command line (the gateway also applies them at boot unless DB_MIGRATIONS_RUN=false).
 * A product calls this from its own script with the same options it passes to GatewayModule.forRoot:
 *
 *   // src/migrate.ts
 *   runMigrateCli({ defaults, migrations });
 *
 *   ts-node src/migrate.ts                  apply pending files
 *   ts-node src/migrate.ts --dry-run        list what would be applied
 *   ts-node src/migrate.ts status           every file's state and the ledgers
 *
 * Settings are the gateway's DATABASE_* / DB_* variables; .env in the working directory is loaded, and the real
 * environment wins.
 */
export async function runMigrateCli(
  options: Pick<GatewayModuleOptions, 'defaults' | 'migrations'>, argv: string[] = process.argv.slice(2),
): Promise<void> {
  try {
    if (fs.existsSync('.env')) process.loadEnvFile('.env');
    const status = argv.includes('status');
    const dryRun = argv.includes('--dry-run');
    const db = readGatewayConfig(options.defaults).database;
    const sets = migrationSets(options.migrations);
    console.log(`target: ${describeTarget(db)}\naction: ${status ? 'status' : dryRun ? 'dry run' : 'apply'}\n`);

    if (status) {
      const ds = await new DataSource(dataSourceOptions(db, [])).initialize();
      try {
        for (const set of sets) {
          console.log(`${set.ledgerTable} (${set.dir}${db.type === 'sqlite' ? '/sqlite' : ''})`);
          const qr = ds.createQueryRunner();
          const rows = await readLedger(qr, db.type, set.ledgerTable).finally(() => qr.release());
          const files = listMigrations(set.dir, db.type);
          const plan = planMigrations(files, rows);
          const byVersion = new Map(rows.map((r) => [r.version, r]));
          for (const f of files) {
            const row = byVersion.get(f.version);
            const state = !row
              ? 'PENDING'
              : plan.adopt.includes(f)
                ? 'applied (self-recorded, checksum filled in on next run)'
                : plan.changed.some((c) => c.file === f)
                  ? 'CHANGED since applied'
                  : 'applied';
            const when = row ? `  ${new Date(row.applied_at!).toISOString()} by ${row.applied_by}` : '';
            console.log(`  ${f.version.padEnd(40)} ${state}${when}`);
          }
          for (const r of plan.unknown) console.log(`  ${r.version.padEnd(40)} in the ledger, no file here`);
          if (!rows.length) console.log(`  no ${set.ledgerTable} table yet: the first run creates it.`);
          console.log('');
        }
      } finally {
        await ds.destroy();
      }
      return;
    }

    for (const { set, result } of await migrateAll(db, options.migrations, { dryRun, log: (m) => console.log(m) })) {
      if (dryRun) {
        console.log(`${set.ledgerTable}: ${result.plan.pending.length ? `would apply ${result.plan.pending.map((f) => f.version).join(', ')}` : 'nothing pending'}`);
      } else {
        console.log(`${set.ledgerTable}: ${result.applied.length ? `applied ${result.applied.length} file(s)` : 'up to date'}`);
      }
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
