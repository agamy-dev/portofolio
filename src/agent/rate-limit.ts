/**
 * Fixed-window, in-memory rate limiter. Good enough for one server instance;
 * swap for a shared store (e.g. Upstash Redis) when running on several instances.
 */
const hits = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(
  key: string,
  { max, windowMs }: { max: number; windowMs: number },
): { ok: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }
  const entry = hits.get(key);
  if (!entry || entry.resetAt <= now) {
    hits.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfterSeconds: 0 };
  }
  entry.count += 1;
  return {
    ok: entry.count <= max,
    retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
  };
}

export const LIMITS = {
  chat: { max: 20, windowMs: 10 * 60 * 1000 },
  booking: { max: 3, windowMs: 24 * 60 * 60 * 1000 },
  lead: { max: 10, windowMs: 60 * 60 * 1000 },
};
