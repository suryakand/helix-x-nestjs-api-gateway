import * as fs from 'node:fs';
import { ColumnOptions } from 'typeorm';

// Entity decorators run when entities.ts is imported, before @nestjs/config loads .env, and their column types
// depend on the driver, so read DATABASE_TYPE here. Values already in the environment win, as with @nestjs/config.
if (fs.existsSync('.env')) process.loadEnvFile('.env');

export type DbKind = 'postgres' | 'sqlite';
export const DB_KIND: DbKind = process.env.DATABASE_TYPE?.trim().replace(/^['"]|['"]$/g, '') === 'sqlite' ? 'sqlite' : 'postgres';
const pg = DB_KIND === 'postgres';

/**
 * Column types per driver. Postgres keeps its native types (the schema in migrations/*.sql); SQLite gets the
 * nearest type TypeORM supports there (migrations/sqlite/*.sqlite.sql). Spread into @Column({ ...COL.uuid, … }).
 */
export const COL = {
  uuid: (pg ? { type: 'uuid' } : { type: 'varchar', length: 36 }) satisfies ColumnOptions,
  /** Stored as UTC text on SQLite ('YYYY-MM-DD HH:MM:SS.SSS'); TypeORM converts entities, raw rows need sqlTimestamp(). */
  timestamptz: (pg ? { type: 'timestamptz' } : { type: 'datetime' }) satisfies ColumnOptions,
  json: (pg ? { type: 'jsonb' } : { type: 'simple-json' }) satisfies ColumnOptions,
  inet: (pg ? { type: 'inet' } : { type: 'varchar', length: 45 }) satisfies ColumnOptions,
  /** text[] on Postgres, a JSON array in text on SQLite. */
  textArray: (pg ? { type: 'text', array: true, default: () => "'{}'" } : { type: 'simple-json', default: () => "'[]'" }) satisfies ColumnOptions,
} as const;

/** A timestamp from a raw query row as a Date: pg returns a Date, SQLite the UTC text TypeORM wrote. */
export function sqlTimestamp(v: Date | string): Date {
  if (v instanceof Date) return v;
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : `${v.replace(' ', 'T')}Z`);
}

/** SQL for a date column as 'YYYY-MM-DD' text (pg would otherwise return a local-midnight Date). */
export const sqlDayText = (column: string): string => (pg ? `to_char(${column}, 'YYYY-MM-DD')` : column);
