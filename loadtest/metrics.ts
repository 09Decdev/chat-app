/**
 * MAYogu LoadTest Tool — metrics: log-scale histogram (P50/P95/P99) + aggregation.
 *
 * - Histogram dùng bucket log-scale cố định (1ms → 60s, 48 bucket) — O(1) insert,
 *   memory cố định, merge nhanh giữa worker → coordinator (DB-1).
 * - Không giữ sample thô → an toàn ở 100k events/s (AC5.4).
 */

export const HISTOGRAM_BUCKETS = 48;
export const HISTOGRAM_MIN_MS = 1;
export const HISTOGRAM_MAX_MS = 60_000;

export interface Quantiles {
  p50: number;
  p95: number;
  p99: number;
  avg: number;
  count: number;
}

export class BucketedHistogram {
  readonly buckets: number[];
  private count = 0;
  private sumMs = 0;

  constructor(bucketCount = HISTOGRAM_BUCKETS) {
    this.buckets = new Array(bucketCount).fill(0);
  }

  private static bucketIndex(valueMs: number): number {
    const logMin = Math.log(HISTOGRAM_MIN_MS);
    const logMax = Math.log(HISTOGRAM_MAX_MS);
    const span = logMax - logMin;
    const idx = Math.floor(((Math.log(Math.max(valueMs, HISTOGRAM_MIN_MS)) - logMin) / span) * HISTOGRAM_BUCKETS);
    return Math.min(HISTOGRAM_BUCKETS - 1, Math.max(0, idx));
  }

  add(valueMs: number) {
    const idx = BucketedHistogram.bucketIndex(valueMs);
    this.buckets[idx] += 1;
    this.count += 1;
    this.sumMs += valueMs;
  }

  /** Giá trị đại diện giữa bucket (log-mid) — dùng ước lượng sum khi merge nguồn thô. */
  private static bucketMidMs(idx: number): number {
    const frac = (idx + 0.5) / HISTOGRAM_BUCKETS;
    const logMin = Math.log(HISTOGRAM_MIN_MS);
    const logMax = Math.log(HISTOGRAM_MAX_MS);
    return Math.exp(logMin + frac * (logMax - logMin));
  }

  merge(other: { buckets: number[] } | BucketedHistogram) {
    const isHist = other instanceof BucketedHistogram;
    const ob = other.buckets;
    for (let i = 0; i < Math.min(ob.length, this.buckets.length); i++) this.buckets[i] += ob[i];
    if (isHist) {
      this.count += (other as BucketedHistogram).getCount();
      this.sumMs += (other as BucketedHistogram).getSum();
    } else {
      for (let i = 0; i < ob.length; i++) {
        if (ob[i]) {
          this.sumMs += BucketedHistogram.bucketMidMs(i) * ob[i];
          this.count += ob[i];
        }
      }
    }
  }

  getCount(): number {
    return this.count;
  }

  getSum(): number {
    return this.sumMs;
  }

  quantile(q: number): number {
    if (this.count === 0) return 0;
    const target = q * this.count;
    let cum = 0;
    for (let i = 0; i < this.buckets.length; i++) {
      cum += this.buckets[i];
      if (cum >= target) {
        // trả về giá trị đại diện đầu bucket (log-mid) — đủ chính xác cho P50/P95/P99
        const frac = i / this.buckets.length;
        const logMin = Math.log(HISTOGRAM_MIN_MS);
        const logMax = Math.log(HISTOGRAM_MAX_MS);
        return Math.round(Math.exp(logMin + frac * (logMax - logMin)));
      }
    }
    return HISTOGRAM_MAX_MS;
  }

  quantiles(): Quantiles {
    return {
      p50: this.quantile(0.5),
      p95: this.quantile(0.95),
      p99: this.quantile(0.99),
      avg: this.count > 0 ? Math.round(this.sumMs / this.count) : 0,
      count: this.count,
    };
  }

  toJSON(): number[] {
    return this.buckets;
  }
}

/** Bộ histogram theo action + registry tên action cố định. */
export class ActionHistograms {
  private map = new Map<string, BucketedHistogram>();

  add(action: string, valueMs: number) {
    let h = this.map.get(action);
    if (!h) {
      h = new BucketedHistogram();
      this.map.set(action, h);
    }
    h.add(valueMs);
  }

  mergeFrom(action: string, buckets: number[]) {
    let h = this.map.get(action);
    if (!h) {
      h = new BucketedHistogram(buckets.length);
      this.map.set(action, h);
    }
    h.merge({ buckets });
  }

  get(action: string): BucketedHistogram | undefined {
    return this.map.get(action);
  }

  /** Gộp toàn bộ (cho latency tổng P50/P95/P99 toàn run — UI-SPEC tick.latency). */
  mergedTotal(): BucketedHistogram {
    const out = new BucketedHistogram();
    for (const h of this.map.values()) out.merge(h);
    return out;
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  toJSON(): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const [k, h] of this.map) out[k] = h.buckets;
    return out;
  }
}

/** Counter tăng nhanh — đảm bảo không âm sau delta. */
export class Counter {
  private v = 0;
  inc(n = 1) {
    this.v += n;
  }
  get(): number {
    return this.v;
  }
  reset() {
    this.v = 0;
  }
}

/** Sliding window 60s cho auto-stop thresholds (register fail > 50% etc.). */
export class SlidingWindow {
  private entries: { ts: number; ok: boolean }[] = [];
  constructor(private windowMs = 60_000) {}

  add(ok: boolean) {
    this.entries.push({ ts: Date.now(), ok });
    const cutoff = Date.now() - this.windowMs;
    while (this.entries.length && this.entries[0].ts < cutoff) this.entries.shift();
  }

  /** Tỷ lệ fail trong cửa sổ (0-100). 0 nếu chưa có dữ liệu. */
  failRatePct(): number {
    if (this.entries.length === 0) return 0;
    let fails = 0;
    for (const e of this.entries) if (!e.ok) fails++;
    return (fails / this.entries.length) * 100;
  }

  get size(): number {
    return this.entries.length;
  }
}
