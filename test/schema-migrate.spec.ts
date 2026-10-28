import { join } from 'node:path';
import {
  GATEWAY_LEDGER_TABLE, listMigrations, MigrationFile, planMigrations, SELF_RECORDED, sha256, splitStatements, versionOf,
} from '../src/database/migrate/schema-migrate';

const file = (version: string, sql = `-- ${version}`): MigrationFile => ({ version, path: version, sql, checksum: sha256(sql) });

describe('schema-migrate', () => {
  it('derives versions per driver', () => {
    expect(versionOf('001_initial_schema.sql', 'postgres')).toBe('001_initial_schema');
    expect(versionOf('001_initial_schema.sqlite.sql', 'postgres')).toBeUndefined();
    expect(versionOf('001_initial_schema.sqlite.sql', 'sqlite')).toBe('001_initial_schema');
    expect(versionOf('README.md', 'postgres')).toBeUndefined();
    expect(() => versionOf('1_bad.sql', 'postgres')).toThrow(/NNN_snake_case/);
  });

  it('plans pending, adopted, changed and unknown', () => {
    const a = file('000_a');
    const b = file('001_b');
    const c = file('002_c');
    const d = file('003_d');
    const plan = planMigrations([a, b, c, d], [
      { version: '000_a', checksum: a.checksum },
      { version: '001_b', checksum: SELF_RECORDED },
      { version: '002_c', checksum: 'something-else' },
      { version: '009_gone', checksum: 'x' },
    ]);
    expect(plan.pending.map((f) => f.version)).toEqual(['003_d']);
    expect(plan.adopt.map((f) => f.version)).toEqual(['001_b']);
    expect(plan.changed.map((x) => x.file.version)).toEqual(['002_c']);
    expect(plan.unknown.map((r) => r.version)).toEqual(['009_gone']);
  });

  it('splits sqlite files at line-ending semicolons and drops comment lines', () => {
    const sql = `-- header; not a statement\nCREATE TABLE t (\n  a int -- trailing note\n);\nCREATE INDEX i ON t (a);\n\n-- done\n`;
    expect(splitStatements(sql)).toEqual(['CREATE TABLE t (\n  a int -- trailing note\n)', 'CREATE INDEX i ON t (a)']);
  });

  it('ships ordered migrations for both drivers, each recording itself in the gateway ledger', () => {
    const dir = join(__dirname, '..', 'migrations');
    for (const driver of ['postgres', 'sqlite'] as const) {
      const files = listMigrations(dir, driver);
      expect(files.map((f) => f.version)).toEqual(['000_create_gateway_schema_migrations', '001_gateway_core_schema']);
      for (const f of files) {
        expect(f.sql).toContain(`INSERT INTO ${GATEWAY_LEDGER_TABLE} (version, checksum, applied_by)\nVALUES ('${f.version}', '${SELF_RECORDED}'`);
        // The runner owns the transaction (a DO block's BEGIN has no ';').
        expect(f.sql).not.toMatch(/^\s*(BEGIN|COMMIT|START TRANSACTION)\s*;/im);
      }
    }
  });
});
