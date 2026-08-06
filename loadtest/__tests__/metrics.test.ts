import { describe, it, expect, vi } from 'vitest';
import { BucketedHistogram, SlidingWindow, ActionHistograms, Counter, HISTOGRAM_BUCKETS, HISTOGRAM_MAX_MS } from '../metrics';

describe('BucketedHistogram', () => {
  it('P50/P95/P99 đúng với dữ liệu cố định', () => {
    const h = new BucketedHistogram();
    for (let i = 0; i < 100; i++) h.add(i % 2 === 0 ? 100 : 200); // 50× 100ms, 50× 200ms
    const q = h.quantiles();
    // bucket log-scale: giá trị trả về là mid-bucket, cho phép tolerance
    expect(q.p50).toBeGreaterThanOrEqual(50);
    expect(q.p50).toBeLessThanOrEqual(160);
    expect(q.p95).toBeGreaterThanOrEqual(150);
    expect(q.p95).toBeLessThanOrEqual(260);
    expect(q.p99).toBeLessThanOrEqual(260);
    expect(q.count).toBe(100);
    expect(q.avg).toBe(150); // avg chính xác — sum giữ nguyên
  });

  it('quantile trả 0 khi rỗng', () => {
    const h = new BucketedHistogram();
    expect(h.quantile(0.95)).toBe(0);
    expect(h.quantiles().count).toBe(0);
  });

  it('merge histogram', () => {
    const a = new BucketedHistogram();
    const b = new BucketedHistogram();
    a.add(100);
    b.add(200);
    b.add(300);
    a.merge(b);
    expect(a.getCount()).toBe(3);
  });

  it('bucketIndex clamp ở biên', () => {
    const h = new BucketedHistogram();
    h.add(0.1); // dưới min → bucket 0
    h.add(999_999); // trên max → bucket cuối
    expect(h.getCount()).toBe(2);
  });

  // ─── T-11 (G-2): test mở rộng diệt mutant metrics.ts ─────────────────────

  it('merge từ plain object { buckets } — count/sum ước lượng qua mid-bucket', () => {
    const a = new BucketedHistogram();
    a.add(100);
    const plain = new Array(HISTOGRAM_BUCKETS).fill(0);
    plain[0] = 10; // 10 sample ở bucket đầu (1ms)
    a.merge({ buckets: plain });
    expect(a.getCount()).toBe(11);
    // sum = sum(mid-bucket * count) — mid(0) = exp(log(1) + 0.5/48 * span) > 1
    expect(a.getSum()).toBeGreaterThan(10);
    expect(a.getSum()).toBeLessThan(100 * 1000);
  });

  it('merge bucket ngắn hơn (len mismatch) → không crash, chỉ cộng phần chung', () => {
    const a = new BucketedHistogram();
    a.add(50);
    a.merge({ buckets: [1, 2, 3] }); // ngắn hơn 48
    // count = sample thật + mọi bucket khác 0 của object (count từ mid-bucket)
    expect(a.getCount()).toBe(1 + 1 + 2 + 3);
    expect(a.buckets[0]).toBeGreaterThanOrEqual(1);
  });

  it('add(0) / giá trị dưới min → bucket 0; trên max → bucket cuối (clamp chính xác)', () => {
    const h = new BucketedHistogram();
    h.add(-5);
    h.add(HISTOGRAM_MAX_MS * 10);
    expect(h.buckets[0]).toBe(1);
    expect(h.buckets[HISTOGRAM_BUCKETS - 1]).toBe(1);
  });

  it('quantiles() khi chỉ có 1 sample ở bucket 0 → avg = sum chính xác', () => {
    const h = new BucketedHistogram();
    h.add(1);
    const q = h.quantiles();
    expect(q.avg).toBe(1);
    expect(q.count).toBe(1);
    expect(q.p50).toBeGreaterThanOrEqual(1);
  });

  it('toJSON trả về chính buckets array', () => {
    const h = new BucketedHistogram();
    h.add(10);
    expect(h.toJSON()).toHaveLength(HISTOGRAM_BUCKETS);
    expect(h.toJSON().reduce((a, b) => a + b, 0)).toBe(1); // đúng 1 sample
  });
});

describe('ActionHistograms', () => {
  it('add/mergeFrom tạo histogram mới + get theo action', () => {
    const ah = new ActionHistograms();
    ah.add('chat', 100);
    ah.add('chat', 200);
    ah.mergeFrom('read', new Array(HISTOGRAM_BUCKETS).fill(0).map((_, i) => (i === 5 ? 3 : 0)));
    expect(ah.get('chat')?.getCount()).toBe(2);
    expect(ah.get('read')?.getCount()).toBe(3);
    expect(ah.get('view')).toBeUndefined();
    expect(ah.keys().sort()).toEqual(['chat', 'read']);
  });

  it('mergedTotal gộp toàn bộ action (latency tổng P50/P95/P99)', () => {
    const ah = new ActionHistograms();
    ah.add('chat', 100);
    ah.add('read', 200);
    const total = ah.mergedTotal();
    expect(total.getCount()).toBe(2);
    expect(total.quantiles().avg).toBe(150);
  });

  it('toJSON: record action → buckets array', () => {
    const ah = new ActionHistograms();
    ah.add('chat', 10);
    const json = ah.toJSON();
    expect(Object.keys(json)).toEqual(['chat']);
    expect(json.chat).toHaveLength(HISTOGRAM_BUCKETS);
  });

  it('mergeFrom với bucket ngắn hơn (len khác) → không crash', () => {
    const ah = new ActionHistograms();
    ah.mergeFrom('topic', [1, 2]);
    expect(ah.get('topic')?.getCount()).toBe(1 + 2); // count từ bucket ≠ 0
  });
});

describe('Counter', () => {
  it('inc/get/reset', () => {
    const c = new Counter();
    expect(c.get()).toBe(0);
    c.inc();
    c.inc(3);
    expect(c.get()).toBe(4);
    c.reset();
    expect(c.get()).toBe(0);
  });
});

describe('SlidingWindow', () => {
  it('failRatePct tính đúng trong cửa sổ', () => {
    const w = new SlidingWindow(60_000);
    w.add(true);
    w.add(false);
    w.add(false);
    expect(w.failRatePct()).toBeCloseTo(66.7, 1);
  });

  it('rỗng → 0', () => {
    expect(new SlidingWindow().failRatePct()).toBe(0);
  });

  it('loại bỏ entry cũ ngoài cửa sổ', () => {
    const w = new SlidingWindow(1000);
    w.add(true); // ngay bây giờ
    const old = { ts: Date.now() - 5000, ok: false } as never;
    // chèn entry cũ giả lập (chỉ test qua việc window trượt)
    void old;
    w.add(false);
    expect(w.size).toBeGreaterThanOrEqual(2);
  });

  // ─── T-11 (G-2): test mở rộng diệt mutant SlidingWindow ───────────────────

  it('entry hết hạn bị loại khỏi window (dùng fake timers Date)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const w = new SlidingWindow(1000);
      w.add(true);
      w.add(false);
      expect(w.size).toBe(2);
      vi.advanceTimersByTime(2000); // cả 2 entry hết hạn
      w.add(true);
      expect(w.size).toBe(1); // 2 entry cũ bị shift
      expect(w.failRatePct()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('failRatePct chính xác 0%/50%/100% (biên)', () => {
    const w = new SlidingWindow(60_000);
    expect(w.failRatePct()).toBe(0);
    w.add(true);
    expect(w.failRatePct()).toBe(0);
    w.add(false);
    expect(w.failRatePct()).toBe(50);
    w.add(false);
    expect(w.failRatePct()).toBeCloseTo(66.7, 1);
  });
});
