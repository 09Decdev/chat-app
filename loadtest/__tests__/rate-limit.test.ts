/**
 * T-06 FIX-8 — rate-limit sweep evicts failWindows (`login:ip`/`register:ip`).
 * Trước đây sweep delete theo bare IP → failWindow không bao giờ được evict (memory leak).
 */
import { describe, it, expect, vi } from 'vitest';
import { RateLimiters, FailWindow, TokenBucket } from '../rate-limit';

function cfg() {
  return { disabled: false, loginFails: 5, windowMs: 60_000, startMs: 10_000, writeBucket: 0, trustProxy: false };
}

describe('rate-limit — sweep evicts failWindows (FIX-8)', () => {
  it('sweep xoá stale failWindow login:ip + register:ip (entryCount về 0)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const rl = new RateLimiters(cfg());
      // check() touch IP trước (recordFailure không touch) — như thật trong dispatcher
      rl.check('login', '1.2.3.4');
      rl.recordFailure('login', '1.2.3.4');
      rl.check('register', '5.6.7.8');
      rl.recordFailure('register', '5.6.7.8');
      expect(rl.entryCount).toBeGreaterThan(0);
      // 11 phút sau → idle -> sweep evicts
      vi.advanceTimersByTime(11 * 60_000);
      rl.sweep();
      expect(rl.entryCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sweep giữ entry vẫn active (recent lastSeen) — không evict nhầm', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const rl = new RateLimiters(cfg());
      rl.check('login', '1.2.3.4');
      rl.recordFailure('login', '1.2.3.4');
      vi.advanceTimersByTime(60_000); // 1 phút — vẫn active
      rl.sweep();
      expect(rl.entryCount).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rate-limit — FailWindow/TokenBucket đơn vị', () => {
  it('FailWindow blocked sau limit fail, clear reset', () => {
    const fw = new FailWindow(3, 60_000);
    fw.recordFailure();
    fw.recordFailure();
    expect(fw.isBlocked()).toBe(false);
    fw.recordFailure();
    expect(fw.isBlocked()).toBe(true);
    fw.clear();
    expect(fw.isBlocked()).toBe(false);
  });

  it('TokenBucket take 1 = capacity, retryAfterSec > 0 sau khi cạn', () => {
    const tb = new TokenBucket(1, 1000 / 10_000);
    expect(tb.take()).toBe(true);
    expect(tb.take()).toBe(false);
    expect(tb.retryAfterSec()).toBeGreaterThan(0);
  });
});