import { sqlTimestamp } from '../src/database/column-types';

describe('sqlTimestamp', () => {
  it('passes Dates through', () => {
    const d = new Date('2026-10-18T12:00:00.000Z');
    expect(sqlTimestamp(d)).toBe(d);
  });

  it('reads the UTC text TypeORM writes to SQLite as UTC', () => {
    expect(sqlTimestamp('2026-10-18 12:04:35.331').toISOString()).toBe('2026-10-18T12:04:35.331Z');
    expect(sqlTimestamp('2026-10-18 12:04:35').toISOString()).toBe('2026-10-18T12:04:35.000Z');
  });

  it('keeps an explicit zone', () => {
    expect(sqlTimestamp('2026-10-18T14:04:35+02:00').toISOString()).toBe('2026-10-18T12:04:35.000Z');
  });
});
