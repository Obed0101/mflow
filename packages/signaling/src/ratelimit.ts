import { DEFAULT_SIGNALING_LIMITS, type SignalingLimits } from "./limits.js";

// ─── Types ──────────────────────────────────────────────────

interface RateBucket {
  timestamps: number[];
  violations: number;
}

interface RateLimitResult {
  allowed: boolean;
  shouldDisconnect: boolean;
}

// ─── Rate Limiter ───────────────────────────────────────────

export class RateLimiter {
  private readonly joins = new Map<string, RateBucket>();
  private readonly messages = new Map<string, RateBucket>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly limits: SignalingLimits = DEFAULT_SIGNALING_LIMITS) {}

  start(): void {
    // Cleanup stale buckets every 60s
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.joins.clear();
    this.messages.clear();
  }

  checkJoin(ip: string): RateLimitResult {
    return this.check(this.joins, ip, this.limits.joinAttemptsPerMinute);
  }

  checkMessage(ip: string): RateLimitResult {
    return this.check(this.messages, ip, this.limits.messagesPerMinute);
  }

  private check(
    store: Map<string, RateBucket>,
    ip: string,
    limit: number,
  ): RateLimitResult {
    const now = Date.now();
    const windowStart = now - 60_000;

    let bucket = store.get(ip);
    if (!bucket) {
      bucket = { timestamps: [], violations: 0 };
      store.set(ip, bucket);
    }

    // Prune timestamps outside the 1-minute window
    bucket.timestamps = bucket.timestamps.filter((t) => t > windowStart);

    if (bucket.timestamps.length >= limit) {
      bucket.violations++;
      return {
        allowed: false,
        shouldDisconnect:
          bucket.violations >= this.limits.rateLimitViolationsBeforeDisconnect,
      };
    }

    bucket.timestamps.push(now);
    return { allowed: true, shouldDisconnect: false };
  }

  private cleanup(): void {
    const now = Date.now();
    const windowStart = now - 60_000;

    for (const store of [this.joins, this.messages]) {
      for (const [ip, bucket] of store) {
        bucket.timestamps = bucket.timestamps.filter((t) => t > windowStart);
        if (bucket.timestamps.length === 0) {
          // Reset violations when no activity in the window — prevents permanent bans
          store.delete(ip);
        }
      }
    }
  }
}
