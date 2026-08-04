/**
 * Tool metrics — bộ đếm/gauge riêng cho chính tool loadtest (T-05 tạo).
 * T-06 thêm `apiErrors`; T-07 mở rộng gauges (`coordinator.rssMb`, `worker.alive`).
 * Zero-dep, plain TS.
 */

export type ToolCounter = 'dbWriteFail' | 'dbRetry' | 'apiErrors' | 'workerRestarts' | 'runFinished';

export type ToolGauge = 'coordinator.rssMb' | 'worker.alive';

export interface ToolMetrics {
  inc(name: ToolCounter, by?: number): void;
  setGauge(name: ToolGauge, v: number): void;
  /** Snapshot counters/gauges tại thời điểm gọi (bản sao). */
  snapshot(): { counters: Record<string, number>; gauges: Record<string, number> };
  /** Alias snapshot — dùng trong test. */
  getSnapshot(): { counters: Record<string, number>; gauges: Record<string, number> };
  /** Reset toàn bộ counter/gauge — dùng cho test (cô lập giữa các case). */
  reset(): void;
  toPrometheusText(): string;
}

export function createToolMetrics(): ToolMetrics {
  const counters: Record<ToolCounter, number> = {
    dbWriteFail: 0,
    dbRetry: 0,
    apiErrors: 0,
    workerRestarts: 0,
    runFinished: 0,
  };
  const gauges: Record<ToolGauge, number> = { 'coordinator.rssMb': 0, 'worker.alive': 0 };

  return {
    inc(name, by = 1) {
      counters[name] = (counters[name] ?? 0) + by;
    },
    setGauge(name, v) {
      gauges[name] = v;
    },
    snapshot() {
      return { counters: { ...counters }, gauges: { ...gauges } };
    },
    getSnapshot() {
      return { counters: { ...counters }, gauges: { ...gauges } };
    },
    reset() {
      for (const k of Object.keys(counters) as ToolCounter[]) counters[k] = 0;
      for (const k of Object.keys(gauges) as ToolGauge[]) gauges[k] = 0;
    },
    toPrometheusText() {
      const lines: string[] = [];
      for (const [k, v] of Object.entries(counters)) lines.push(`lt_${k} ${v}`);
      for (const [k, v] of Object.entries(gauges)) lines.push(`lt_${k.replace('.', '_')} ${v}`);
      return lines.join('\n');
    },
  };
}

/** Singleton dùng trong production (writer.ts, store.ts). */
export const toolMetrics: ToolMetrics = createToolMetrics();