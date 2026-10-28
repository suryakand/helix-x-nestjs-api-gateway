import { redisKeyFor, windowFor } from '../src/metering/rate-window';

const iso = (d: Date) => d.toISOString();

describe('rate windows (UTC)', () => {
  it('DAILY covers the UTC calendar day', () => {
    const w = windowFor('DAILY', new Date('2026-10-16T23:59:59.999Z'));
    expect(iso(w.start)).toBe('2026-10-16T00:00:00.000Z');
    expect(iso(w.end)).toBe('2026-10-17T00:00:00.000Z');
  });

  it('WEEKLY starts on Monday (ISO week)', () => {
    // 2026-10-16 is a Friday
    const w = windowFor('WEEKLY', new Date('2026-10-16T12:00:00Z'));
    expect(iso(w.start)).toBe('2026-10-12T00:00:00.000Z');
    expect(iso(w.end)).toBe('2026-10-19T00:00:00.000Z');
    // Sunday belongs to the week that started the Monday before
    expect(iso(windowFor('WEEKLY', new Date('2026-10-18T23:00:00Z')).start)).toBe('2026-10-12T00:00:00.000Z');
    // Monday starts a new one
    expect(iso(windowFor('WEEKLY', new Date('2026-10-19T00:00:00Z')).start)).toBe('2026-10-19T00:00:00.000Z');
  });

  it('WEEKLY crosses month and year boundaries', () => {
    const w = windowFor('WEEKLY', new Date('2027-01-01T10:00:00Z')); // Friday
    expect(iso(w.start)).toBe('2026-12-28T00:00:00.000Z');
    expect(iso(w.end)).toBe('2027-01-04T00:00:00.000Z');
  });

  it('MONTHLY covers the calendar month, including December → January', () => {
    const w = windowFor('MONTHLY', new Date('2026-12-31T23:00:00Z'));
    expect(iso(w.start)).toBe('2026-12-01T00:00:00.000Z');
    expect(iso(w.end)).toBe('2027-01-01T00:00:00.000Z');
    expect(iso(windowFor('MONTHLY', new Date('2028-02-29T00:00:00Z')).end)).toBe('2028-03-01T00:00:00.000Z');
  });

  it('builds distinct redis keys per window and type', () => {
    const now = new Date('2026-10-16T00:00:00Z');
    expect(redisKeyFor('k1', 'DAILY', windowFor('DAILY', now))).toBe('rl:k1:DAILY:2026-10-16');
    expect(redisKeyFor('k1', 'MONTHLY', windowFor('MONTHLY', now))).toBe('rl:k1:MONTHLY:2026-10-01');
  });
});
