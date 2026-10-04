/**
 * Rate limiting.
 *
 * - `publish` and `authFailures` are enforced with strongly consistent counters in the registry
 *   database (SqlRateLimiter): these are the security-relevant limits.
 * - `auth` and `admin` are coarse, cheap first-line limits per client IP. In the Worker they are
 *   Cloudflare Rate Limiting bindings, which are approximate (counted per machine/location);
 *   locally they are in-memory.
 */
import type { SqlDatabase } from "./storage.js";

export interface RateLimiter {
  /** Records one hit for `key`; resolves false when the limit is exceeded. */
  limit(key: string): Promise<boolean>;
}

/** Counts failures only, so normal traffic costs nothing. */
export interface FailureLimiter {
  /** True when `key` has exceeded its failure budget in the current window. */
  blocked(key: string): Promise<boolean>;
  record(key: string): Promise<void>;
}

export interface RateLimits {
  /** Per user: publishes. */
  publish?: RateLimiter;
  /** Per client IP: failed authentications (user or admin). Blocks the client when exceeded. */
  authFailures?: FailureLimiter;
  /** Per client IP: every authenticated request (coarse). */
  auth?: RateLimiter;
  /** Per client IP: admin API (coarse). */
  admin?: RateLimiter;
  /** Per client IP: sign-up attempts. */
  signup?: RateLimiter;
}

export const DEFAULT_RATE_LIMITS = {
  publish: { limit: 10, periodSeconds: 60 },
  authFailures: { limit: 20, periodSeconds: 600 },
  auth: { limit: 60, periodSeconds: 60 },
  admin: { limit: 30, periodSeconds: 60 },
  signup: { limit: 10, periodSeconds: 600 },
} as const;

export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly max: number,
    private readonly periodMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async limit(key: string): Promise<boolean> {
    const t = this.now();
    const current = this.windows.get(key);
    if (!current || t - current.start >= this.periodMs) {
      this.windows.set(key, { start: t, count: 1 });
      if (this.windows.size > 10_000) this.prune(t);
      return true;
    }
    current.count++;
    return current.count <= this.max;
  }

  private prune(t: number): void {
    for (const [key, w] of this.windows) if (t - w.start >= this.periodMs) this.windows.delete(key);
  }
}

/**
 * Fixed-window counters in the `rate_limits` table. The increment is a single atomic
 * `INSERT … ON CONFLICT … RETURNING`, so concurrent requests cannot exceed the limit.
 */
export class SqlRateLimiter implements RateLimiter, FailureLimiter {
  constructor(
    private readonly db: SqlDatabase,
    private readonly name: string,
    private readonly max: number,
    private readonly periodSeconds: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private window(): number {
    return Math.floor(this.now() / 1000 / this.periodSeconds);
  }

  private async increment(key: string): Promise<number> {
    const window = this.window();
    const row = await this.db.first<{ count: number }>(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING count`,
      [`${this.name}:${key}`, window],
    );
    const count = row?.count ?? 1;
    // Occasionally drop counters from old windows so the table stays small.
    if (count === 1 && Math.random() < 0.02) {
      await this.db.run("DELETE FROM rate_limits WHERE key LIKE ? AND window_start < ?", [`${this.name}:%`, window - 1]);
    }
    return count;
  }

  async limit(key: string): Promise<boolean> {
    return (await this.increment(key)) <= this.max;
  }

  async blocked(key: string): Promise<boolean> {
    const row = await this.db.first<{ window_start: number; count: number }>(
      "SELECT window_start, count FROM rate_limits WHERE key = ?",
      [`${this.name}:${key}`],
    );
    return row !== null && row.window_start === this.window() && row.count >= this.max;
  }

  async record(key: string): Promise<void> {
    await this.increment(key);
  }
}

export interface RateLimitConfig {
  publishPerMinute?: number;
  authFailuresPer10Minutes?: number;
}

/** The strongly consistent limits, backed by the registry database. */
export function sqlRateLimits(db: SqlDatabase, config: RateLimitConfig = {}): Pick<RateLimits, "publish" | "authFailures" | "signup"> {
  return {
    publish: new SqlRateLimiter(db, "publish", config.publishPerMinute ?? DEFAULT_RATE_LIMITS.publish.limit, 60),
    signup: new SqlRateLimiter(db, "signup", DEFAULT_RATE_LIMITS.signup.limit, DEFAULT_RATE_LIMITS.signup.periodSeconds),
    authFailures: new SqlRateLimiter(
      db,
      "auth-failure",
      config.authFailuresPer10Minutes ?? DEFAULT_RATE_LIMITS.authFailures.limit,
      DEFAULT_RATE_LIMITS.authFailures.periodSeconds,
    ),
  };
}

/** Local Node registry: database-backed limits plus in-memory coarse limits. */
export function localRateLimits(db: SqlDatabase): RateLimits {
  return {
    ...sqlRateLimits(db),
    auth: new MemoryRateLimiter(DEFAULT_RATE_LIMITS.auth.limit, DEFAULT_RATE_LIMITS.auth.periodSeconds * 1000),
    admin: new MemoryRateLimiter(DEFAULT_RATE_LIMITS.admin.limit, DEFAULT_RATE_LIMITS.admin.periodSeconds * 1000),
  };
}
