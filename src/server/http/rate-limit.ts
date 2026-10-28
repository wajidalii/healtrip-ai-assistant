/**
 * In-memory sliding-window rate limiter (docs/API.md "Limits and protections").
 * Per-process only: a multi-instance deployment swaps this for Redis behind the
 * same `check()` shape. The clock is injectable so tests are deterministic.
 */

export type RateLimitResult = {
  allowed: boolean;
  /** Requests still allowed in the current window (after this one). */
  remaining: number;
  /** Milliseconds until the oldest counted request leaves the window; 0 when allowed. */
  retryAfterMs: number;
};

/** How many `check()` calls between sweeps of keys that have gone quiet. */
const SWEEP_EVERY = 1_000;

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private checksSinceSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (limit < 1 || windowMs < 1) throw new Error("rate limit and window must be positive");
  }

  /** Records a hit for `key` if it is within the limit and reports the outcome. */
  check(key: string): RateLimitResult {
    const current = this.now();
    const cutoff = current - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);

    this.maybeSweep(cutoff);

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { allowed: false, remaining: 0, retryAfterMs: recent[0] + this.windowMs - current };
    }
    recent.push(current);
    this.hits.set(key, recent);
    return { allowed: true, remaining: this.limit - recent.length, retryAfterMs: 0 };
  }

  /** Number of keys currently tracked (exposed for tests and metrics). */
  get size(): number {
    return this.hits.size;
  }

  /** Drops keys whose hits have all expired so idle clients do not accumulate forever. */
  private maybeSweep(cutoff: number): void {
    if (++this.checksSinceSweep < SWEEP_EVERY) return;
    this.checksSinceSweep = 0;
    for (const [key, timestamps] of this.hits) {
      if (timestamps.every((t) => t <= cutoff)) this.hits.delete(key);
    }
  }
}

/**
 * Best-effort client address. `x-forwarded-for` is trusted because the app is
 * expected to sit behind a single reverse proxy (Vercel / nginx); at the edge
 * that header is overwritten, not appended by clients.
 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get("x-real-ip")?.trim();
  return real || "unknown";
}
