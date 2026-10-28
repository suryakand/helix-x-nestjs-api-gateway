import { RateLimitType } from '../database/entities';

export type WindowType = Extract<RateLimitType, 'DAILY' | 'WEEKLY' | 'MONTHLY'>;

export interface RateWindow { start: Date; end: Date; id: string }

/** Fixed, UTC-aligned window containing `now`: a calendar day, an ISO week (Mon–Sun) or a calendar month. */
export function windowFor(type: WindowType, now: Date): RateWindow {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  let start: Date;
  let end: Date;
  if (type === 'DAILY') {
    start = new Date(Date.UTC(y, m, d));
    end = new Date(Date.UTC(y, m, d + 1));
  } else if (type === 'WEEKLY') {
    const sinceMonday = (now.getUTCDay() + 6) % 7;
    start = new Date(Date.UTC(y, m, d - sinceMonday));
    end = new Date(Date.UTC(y, m, d - sinceMonday + 7));
  } else {
    start = new Date(Date.UTC(y, m, 1));
    end = new Date(Date.UTC(y, m + 1, 1));
  }
  return { start, end, id: start.toISOString().slice(0, 10) };
}

export function isWindowType(t: RateLimitType): t is WindowType {
  return t === 'DAILY' || t === 'WEEKLY' || t === 'MONTHLY';
}

/** Counter key of one limit row's window. */
export function redisKeyFor(limitId: string, type: WindowType, w: RateWindow): string {
  return `rl:${limitId}:${type}:${w.id}`;
}
