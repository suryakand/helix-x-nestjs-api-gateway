import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { DataSource, QueryRunner } from 'typeorm';

/**
 * Numbered SQL migrations with a `schema_migrations` ledger, the same scheme as ef-backend's database/migrations.
 * Derived from ef-track's runner, with the ledger table as a parameter: the gateway keeps its own ledger
 * (GATEWAY_LEDGER_TABLE), so its versions never meet a product's `schema_migrations`.
 *
 * - Postgres reads `<dir>/NNN_name.sql`, SQLite reads `<dir>/sqlite/NNN_name.sqlite.sql`. The version is the file
 *   name without its suffix, so both ledgers use the same names.
 * - Pending = no ledger row. Each file and its row are written in one transaction. A row whose checksum is
 *   'self-recorded' (the file's own INSERT, e.g. after a run by hand) is adopted: its checksum is filled in and the
 *   file is not re-run. A row whose checksum differs from the file means an applied file was edited: reported, never
 *   re-run.
 * - Files hold no BEGIN/COMMIT (the runner owns the transaction). SQLite files are split into statements at a ';'
 *   that ends a line, so keep one statement per ';' line ending there (no triggers).
 */

export type MigrateDriver = 'postgres' | 'sqlite';
/** Ledger of a product's own migrations, and the default. */
export const LEDGER_TABLE = 'schema_migrations';
/** Ledger of the gateway's own migrations (this package's migrations/). */
export const GATEWAY_LEDGER_TABLE = 'gateway_schema_migrations';
export const SELF_RECORDED = 'self-recorded';
/** The gateway's migrations: this package's root /migrations, three levels up from src/ or dist/database/migrate. */
export const DEFAULT_MIGRATIONS_DIR = join(__dirname, '..', '..', '..', 'migrations');
/** pg_advisory_lock key, so two instances booting at once apply each file once. */
const LOCK_KEY = 7_340_291;

const NAME = /^(\d{3})_[a-z0-9_]+$/;

export interface MigrationFile {
  version: string;
  path: string;
  sql: string;
  checksum: string;
}

export interface LedgerRow {
  version: string;
  checksum: string;
  applied_at?: string | Date;
  applied_by?: string;
}

export interface MigrationPlan {
  pending: MigrationFile[];
  /** Applied by hand (self-recorded row): fill in the checksum, don't re-run. */
  adopt: MigrationFile[];
  /** Applied, but the file has changed since. */
  changed: { file: MigrationFile; recorded: string }[];
  /** Ledger rows with no file (applied from another branch, or a file was removed). */
  unknown: LedgerRow[];
}

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Version from a file name, or undefined when it is not a migration of that driver. */
export function versionOf(fileName: string, driver: MigrateDriver): string | undefined {
  const suffix = driver === 'sqlite' ? '.sqlite.sql' : '.sql';
  if (!fileName.endsWith(suffix) || (driver === 'postgres' && fileName.endsWith('.sqlite.sql'))) return undefined;
  const version = fileName.slice(0, -suffix.length);
  if (!NAME.test(version)) throw new Error(`migration file name must be NNN_snake_case${suffix}: ${fileName}`);
  return version;
}

export function listMigrations(dir: string, driver: MigrateDriver): MigrationFile[] {
  const folder = driver === 'sqlite' ? join(dir, 'sqlite') : dir;
  if (!fs.existsSync(folder)) throw new Error(`migrations folder not found: ${folder}`);
  const files: MigrationFile[] = [];
  for (const name of fs.readdirSync(folder).sort()) {
    const version = versionOf(name, driver);
    if (!version) continue;
    const path = join(folder, name);
    const sql = fs.readFileSync(path, 'utf8');
    files.push({ version, path, sql, checksum: sha256(sql) });
  }
  const seen = new Map<string, string>();
  for (const f of files) {
    const n = f.version.slice(0, 3);
    if (seen.has(n)) throw new Error(`two migrations numbered ${n}: ${seen.get(n)} and ${f.version}`);
    seen.set(n, f.version);
  }
  return files;
}

export function planMigrations(files: MigrationFile[], rows: LedgerRow[]): MigrationPlan {
  const byVersion = new Map(rows.map((r) => [r.version, r]));
  const plan: MigrationPlan = { pending: [], adopt: [], changed: [], unknown: [] };
  for (const file of files) {
    const row = byVersion.get(file.version);
    if (!row) plan.pending.push(file);
    else if (row.checksum === SELF_RECORDED) plan.adopt.push(file);
    else if (row.checksum !== file.checksum) plan.changed.push({ file, recorded: row.checksum });
  }
  const known = new Set(files.map((f) => f.version));
  plan.unknown = rows.filter((r) => !known.has(r.version));
  return plan;
}

/** SQLite runs one statement per call: split at ';' ending a line, dropping '--' comment lines. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  for (const line of sql.split(/\r?\n/)) {
    if (/^\s*--/.test(line)) continue;
    current.push(line);
    if (/;\s*$/.test(line)) {
      const stmt = current.join('\n').trim().replace(/;\s*$/, '');
      if (stmt) out.push(stmt);
      current = [];
    }
  }
  const rest = current.join('\n').trim();
  if (rest) out.push(rest);
  return out;
}

export interface MigrateOptions {
  driver: MigrateDriver;
  dir?: string;
  /** Ledger table the files record themselves in. Default {@link LEDGER_TABLE}. */
  ledgerTable?: string;
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export interface MigrateResult {
  plan: MigrationPlan;
  applied: string[];
  rows: LedgerRow[];
}

async function ledgerExists(qr: QueryRunner, driver: MigrateDriver, table: string): Promise<boolean> {
  const rows: unknown[] =
    driver === 'postgres'
      ? await qr.query(`SELECT 1 FROM pg_catalog.pg_tables WHERE schemaname = current_schema() AND tablename = $1`, [table])
      : await qr.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);
  return rows.length > 0;
}

export async function readLedger(qr: QueryRunner, driver: MigrateDriver, table: string = LEDGER_TABLE): Promise<LedgerRow[]> {
  if (!(await ledgerExists(qr, driver, table))) return [];
  return qr.query(`SELECT version, checksum, applied_at, applied_by FROM ${table} ORDER BY version`);
}

/** Apply pending migrations (or, with dryRun, only plan them). The DataSource needs no entities. */
export async function migrate(ds: DataSource, opts: MigrateOptions): Promise<MigrateResult> {
  const { driver, log = () => undefined } = opts;
  const ledger = opts.ledgerTable ?? LEDGER_TABLE;
  if (!/^[a-z_][a-z0-9_]*$/.test(ledger)) throw new Error(`invalid ledger table name: ${ledger}`);
  const files = listMigrations(opts.dir ?? DEFAULT_MIGRATIONS_DIR, driver);
  const p = driver === 'postgres' ? (i: number) => `$${i}` : () => '?';
  const qr = ds.createQueryRunner();
  await qr.connect();
  try {
    if (driver === 'postgres' && !opts.dryRun) await qr.query(`SELECT pg_advisory_lock(${LOCK_KEY})`);
    const plan = planMigrations(files, await readLedger(qr, driver, ledger));
    for (const { file, recorded } of plan.changed) {
      log(`WARNING ${file.version} changed after it was applied (ledger ${recorded.slice(0, 12)}…, file ${file.checksum.slice(0, 12)}…); add a new migration instead of editing it`);
    }
    for (const row of plan.unknown) log(`note: ledger has ${row.version}, which has no file here`);
    const applied: string[] = [];
    if (!opts.dryRun) {
      for (const file of plan.adopt) {
        await qr.query(`UPDATE ${ledger} SET checksum = ${p(1)} WHERE version = ${p(2)}`, [file.checksum, file.version]);
        log(`adopted ${file.version} (self-recorded)`);
      }
      for (const file of plan.pending) {
        await qr.startTransaction();
        try {
          if (driver === 'postgres') await qr.query(file.sql);
          else for (const stmt of splitStatements(file.sql)) await qr.query(stmt);
          const by = driver === 'postgres' ? 'current_user' : `'sqlite'`;
          await qr.query(
            `INSERT INTO ${ledger} (version, checksum, applied_by) VALUES (${p(1)}, ${p(2)}, ${by}) ` +
              `ON CONFLICT (version) DO UPDATE SET checksum = excluded.checksum`,
            [file.version, file.checksum],
          );
          await qr.commitTransaction();
        } catch (err) {
          await qr.rollbackTransaction();
          throw new Error(`migration ${file.version} failed: ${(err as Error).message}`);
        }
        applied.push(file.version);
        log(`applied ${file.version}`);
      }
    }
    return { plan, applied, rows: await readLedger(qr, driver, ledger) };
  } finally {
    if (driver === 'postgres' && !opts.dryRun) await qr.query(`SELECT pg_advisory_unlock(${LOCK_KEY})`).catch(() => undefined);
    await qr.release();
  }
}
