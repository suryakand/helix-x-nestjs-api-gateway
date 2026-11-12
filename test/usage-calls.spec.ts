import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { applyCallFilters, CallFilters } from '../src/metering/usage.controller';

/**
 * The calls page's filters against a real SQLite usage_logs table (the schema the migrations build), so the SQL
 * itself is checked: lists, status groups, billed, and path search with LIKE wildcards taken literally.
 */

const T = '11111111-1111-4111-8111-111111111111';
let db: DataSource;

const rows: [string, string, string, string, string, number, number][] = [
  // principal_type, principal_key, method, endpoint, path, status, billed_units
  ['CLIENT', 'erp', 'GET', '/track/container/:n', '/track/container/MSCU1234565', 200, 1],
  ['CLIENT', 'erp', 'GET', '/track/container/:n', '/track/container/MAEU7654321', 200, 0],
  ['USER', 'u-bob', 'GET', '/shipments', '/shipments', 200, 0],
  ['USER', 'u-bob', 'POST', '/shipments', '/shipments', 429, 0],
  ['USER', 'u-amy', 'GET', '/track/booking/:n', '/track/booking/BK_100%', 404, 1],
  ['CLIENT', 'erp', 'GET', '/carriers/:scac/raw', '/carriers/MAEU/raw', 502, 0],
];

beforeAll(async () => {
  db = await new DataSource({ type: 'sqlite', database: ':memory:' }).initialize();
  const schema = readFileSync(join(__dirname, '..', 'migrations', 'sqlite', '001_gateway_core_schema.sqlite.sql'), 'utf8');
  // Only the usage_logs table is needed here, plus migration 003's column.
  const create = /CREATE TABLE IF NOT EXISTS "usage_logs" \([\s\S]*?\n\);/.exec(schema)![0];
  await db.query(create);
  await db.query('ALTER TABLE "usage_logs" ADD COLUMN "billed_units" integer NOT NULL DEFAULT 0');
  for (const [type, key, method, endpoint, path, status, billed] of rows) {
    await db.query(
      `INSERT INTO usage_logs (ts, tenant_id, principal_type, principal_key, method, endpoint, path, response_status, duration_ms, billed_units)
       VALUES (datetime('now'), ?, ?, ?, ?, ?, ?, ?, 5, ?)`,
      [T, type, key, method, endpoint, path, status, billed],
    );
  }
});

afterAll(() => db.destroy());

async function paths(f: CallFilters): Promise<string[]> {
  const q = db.createQueryBuilder().select('path').from('usage_logs', 'l').where('tenant_id = :T', { T });
  applyCallFilters(q, f);
  return (await q.orderBy('id').getRawMany<{ path: string }>()).map((r) => r.path);
}

describe('usage calls filters', () => {
  it('no filters: every call', async () => {
    expect(await paths({})).toHaveLength(rows.length);
  });

  it('lists match any value; filters combine with AND', async () => {
    expect(await paths({ principalTypes: ['USER'] })).toHaveLength(3);
    expect(await paths({ principalTypes: ['USER'], methods: ['POST'] })).toEqual(['/shipments']);
    expect(await paths({ endpoints: ['/track/container/:n', '/track/booking/:n'] })).toHaveLength(3);
  });

  it('one caller only with exactly one principal type', async () => {
    expect(await paths({ principalTypes: ['USER'], principalKey: 'u-amy' })).toEqual(['/track/booking/BK_100%']);
    expect(await paths({ principalTypes: ['USER', 'CLIENT'], principalKey: 'u-amy' })).toHaveLength(rows.length);
  });

  it('status groups: ok, client errors without 429, limited, server, and several at once', async () => {
    expect(await paths({ statuses: ['ok'] })).toHaveLength(3);
    expect(await paths({ statuses: ['client'] })).toEqual(['/track/booking/BK_100%']);
    expect(await paths({ statuses: ['limited'] })).toEqual(['/shipments']);
    expect(await paths({ statuses: ['server'] })).toEqual(['/carriers/MAEU/raw']);
    expect(await paths({ statuses: ['limited', 'server'] })).toHaveLength(2);
    expect(await paths({ statuses: ['error'] })).toHaveLength(3);
  });

  it('billed: only charged calls, or only free ones', async () => {
    expect(await paths({ billed: true })).toEqual(['/track/container/MSCU1234565', '/track/booking/BK_100%']);
    expect(await paths({ billed: false })).toHaveLength(4);
  });

  it('path search is case-insensitive and takes LIKE wildcards literally', async () => {
    expect(await paths({ text: 'mscu' })).toEqual(['/track/container/MSCU1234565']);
    expect(await paths({ text: 'BK_100%' })).toEqual(['/track/booking/BK_100%']);
    expect(await paths({ text: '_' })).toEqual(['/track/booking/BK_100%']);
    expect(await paths({ text: '%' })).toEqual(['/track/booking/BK_100%']);
  });
});
