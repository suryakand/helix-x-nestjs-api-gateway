import { ConsumeResult } from './rate-limiter.service';

/**
 * `X-RateLimit-*` (and `Retry-After` when refused) for a limit state; nothing for an unlimited caller. Shared by the
 * guard (`'request'` routes, charged before proxying) and the proxy (`'upstream'` routes, charged after).
 */
export function quotaHeaders(q: ConsumeResult, refused = !q.allowed): Record<string, string> {
  if (q.limit === undefined) return {};
  const out: Record<string, string> = { 'X-RateLimit-Limit': String(q.limit) };
  if (q.remaining !== undefined) out['X-RateLimit-Remaining'] = String(q.remaining);
  if (q.resetsAt) {
    out['X-RateLimit-Reset'] = String(Math.floor(q.resetsAt.getTime() / 1000));
    if (refused) out['Retry-After'] = String(Math.max(1, Math.ceil((q.resetsAt.getTime() - Date.now()) / 1000)));
  }
  return out;
}
