/**
 * MAYogu LoadTest Tool — rate-limit per IP (T-06, zero-dep, inject clock).
 *
 * KHÔNG dùng `SimpleRateLimiter` (auth-factory.ts) — đó là pacing limiter (acquire() ngủ),
 * không trả 429, không theo IP. Module này là limiter thật trả 429:
 *
 * | Route | Limiter | Giá trị | Hành vi vượt |
 * |---|---|---|---|
 * | POST /auth/login | FailWindow/IP | 5 fail / 60s | 429 + Retry-After |
 * | POST /auth/register | FailWindow/IP | 5 fail / 60s | 429 (gate 403 tính 1 fail) |
 * | POST /start | TokenBucket/IP | capacity 1, refill 1 / 10s | 429 |
 * | /allowlist POST, /cleanup, DELETE /runs/{id} | TokenBucket/IP | 30 req/min | 429 — mặc định OFF (LOADTEST_RATE_LIMIT_WRITE_BUCKET=1) |
 *
 * "Fail" (B-6): mọi response 4xx của login/register = 1 fail; success (2xx) → clear().
 * Fail ghi ở dispatcher SAU khi handler trả response (không trong handler).
 *
 * IP key: `req.socket.remoteAddress` (tool bind 127.0.0.1). KHÔNG tin X-Forwarded-For
 * trừ `LOADTEST_TRUST_PROXY=1` (chống spoof header).
 *
 * Cleanup: lazy sweep — mỗi check() nếu `lastSeen.size > 2048` → sweep() xoá entry
 * idle > 10 phút (không setInterval; test bằng fake clock).
 */

import type { LoadTestEnv } from './config';

export type RateKind = 'login' | 'register' | 'start' | 'write' | 'none';

export interface RateLimitConfig {
  disabled: boolean;
  loginFails: number;
  windowMs: number;
  startMs: number;
  /** 0 = OFF (write routes không giới hạn — không phá test/E2E default). */
  writeBucket: number;
  trustProxy: boolean;
}

/** Token bucket — zero-dep, inject clock. */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private capacity: number,
    private refillPerMs: number,
    private now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.lastRefill = this.now();
  }

  take(): boolean {
    const now = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.lastRefill) * this.refillPerMs);
    this.lastRefill = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Thời gian (giây) tới khi có đủ 1 token. */
  retryAfterSec(): number {
    const need = 1 - this.tokens;
    if (need <= 0 || this.refillPerMs <= 0) return 0;
    return Math.max(1, Math.ceil((need / this.refillPerMs) / 1000));
  }
}

/** Đếm FAILURE (không phải tổng request) trong cửa sổ trượt. */
export class FailWindow {
  private fails: number[] = [];

  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.fails.length && this.fails[0] <= cutoff) this.fails.shift();
  }

  isBlocked(): boolean {
    this.prune();
    return this.fails.length >= this.limit;
  }

  recordFailure(): void {
    this.prune();
    this.fails.push(this.now());
  }

  /** Thời gian (giây) tới khi fail đầu tiên rời khỏi cửa sổ. */
  retryAfterSec(): number {
    this.prune();
    if (!this.fails.length) return 0;
    return Math.max(1, Math.ceil((this.fails[0] + this.windowMs - this.now()) / 1000));
  }

  clear(): void {
    this.fails = [];
  }
}

/** Rate-limit theo IP cho toàn bộ route (B-3: dispatcher gọi, không phải handler). */
export class RateLimiters {
  private failWindows = new Map<string, FailWindow>();
  private startBuckets = new Map<string, TokenBucket>();
  private writeBuckets = new Map<string, TokenBucket>();
  private lastSeen = new Map<string, number>();

  constructor(private cfg: RateLimitConfig) {}

  check(rate: RateKind, ip: string): { allowed: boolean; retryAfterSec?: number } {
    if (this.cfg.disabled || rate === 'none') return { allowed: true };
    this.touch(ip);
    if (rate === 'login' || rate === 'register') {
      const fw = this.getFailWindow(rate, ip);
      if (fw.isBlocked()) return { allowed: false, retryAfterSec: fw.retryAfterSec() };
      return { allowed: true };
    }
    if (rate === 'start') {
      const tb = this.getStartBucket(ip);
      if (!tb.take()) return { allowed: false, retryAfterSec: tb.retryAfterSec() };
      return { allowed: true };
    }
    if (rate === 'write') {
      if (this.cfg.writeBucket <= 0) return { allowed: true };
      const tb = this.getWriteBucket(ip);
      if (!tb.take()) return { allowed: false, retryAfterSec: tb.retryAfterSec() };
      return { allowed: true };
    }
    return { allowed: true };
  }

  /** Ghi fail (dispatcher post-response — 4xx từ login/register). */
  recordFailure(rate: 'login' | 'register', ip: string): void {
    if (this.cfg.disabled) return;
    this.getFailWindow(rate, ip).recordFailure();
  }

  /** 2xx từ login/register → reset window (login đúng trong cửa sổ vẫn hoạt động). */
  clear(rate: 'login' | 'register', ip: string): void {
    if (this.cfg.disabled) return;
    this.getFailWindow(rate, ip).clear();
  }

  /** Xoá entry idle > 10 phút (lazy sweep — không setInterval).
   *  FIX-8 (T-06): failWindow keys là `login:ip`/`register:ip` — trước đây sweep delete theo bare IP
   *  (không khớp) → failWindows không bao giờ bị evict. Giờ xoá đúng prefix từng rate. */
  sweep(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [key, ts] of this.lastSeen) {
      if (ts < cutoff) {
        this.lastSeen.delete(key);
        this.failWindows.delete(`login:${key}`);
        this.failWindows.delete(`register:${key}`);
        this.startBuckets.delete(key);
        this.writeBuckets.delete(key);
      }
    }
  }

  /** Tổng entry đang giữ (test — FIX-8 eviction). */
  get entryCount(): number {
    return this.failWindows.size + this.startBuckets.size + this.writeBuckets.size + this.lastSeen.size;
  }

  private touch(ip: string): void {
    this.lastSeen.set(ip, Date.now());
    if (this.lastSeen.size > 2048) this.sweep();
  }

  private getFailWindow(rate: 'login' | 'register', ip: string): FailWindow {
    const key = `${rate}:${ip}`;
    let fw = this.failWindows.get(key);
    if (!fw) {
      fw = new FailWindow(this.cfg.loginFails, this.cfg.windowMs);
      this.failWindows.set(key, fw);
    }
    return fw;
  }

  private getStartBucket(ip: string): TokenBucket {
    let tb = this.startBuckets.get(ip);
    if (!tb) {
      tb = new TokenBucket(1, 1000 / this.cfg.startMs);
      this.startBuckets.set(ip, tb);
    }
    return tb;
  }

  private getWriteBucket(ip: string): TokenBucket {
    let tb = this.writeBuckets.get(ip);
    if (!tb) {
      tb = new TokenBucket(this.cfg.writeBucket, this.cfg.writeBucket / 60_000);
      this.writeBuckets.set(ip, tb);
    }
    return tb;
  }
}

/** Tạo limiter từ env (T-06 env keys). */
export function createRateLimiters(env: LoadTestEnv): RateLimiters {
  return new RateLimiters({
    disabled: env.rateLimitDisabled,
    loginFails: env.rateLimitLoginFails,
    windowMs: env.rateLimitWindowMs,
    startMs: env.rateLimitStartMs,
    writeBucket: env.rateLimitWriteBucket,
    trustProxy: env.trustProxy,
  });
}