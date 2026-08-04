/**
 * T-07 — tool metrics (T-05 tạo → T-07 mở rộng): counters dbWriteFail/apiErrors/workerRestarts/runFinished
 * + gauges coordinator.rssMb/worker.alive + Prometheus text.
 */
import { describe, it, expect } from 'vitest';
import { createToolMetrics, toolMetrics } from '../tool-metrics';

describe('tool-metrics — counters + gauges (T-05/T-07)', () => {
  it('inc/setGauge/snapshot', () => {
    const m = createToolMetrics();
    m.inc('dbWriteFail');
    m.inc('dbWriteFail', 2);
    m.inc('apiErrors', 3);
    m.inc('workerRestarts', 1);
    m.inc('runFinished', 1);
    m.setGauge('coordinator.rssMb', 512);
    m.setGauge('worker.alive', 4);
    const snap = m.snapshot();
    expect(snap.counters.dbWriteFail).toBe(3);
    expect(snap.counters.apiErrors).toBe(3);
    expect(snap.counters.workerRestarts).toBe(1);
    expect(snap.counters.runFinished).toBe(1);
    expect(snap.gauges['coordinator.rssMb']).toBe(512);
    expect(snap.gauges['worker.alive']).toBe(4);
  });

  it('toPrometheusText: counter có _total + # TYPE/# HELP; gauge đổi dot → underscore', () => {
    const m = createToolMetrics();
    m.inc('dbWriteFail', 3);
    m.inc('apiErrors', 2);
    m.setGauge('coordinator.rssMb', 512);
    m.setGauge('worker.alive', 4);
    const text = m.toPrometheusText();
    // FIX-5: counter suffix `_total` + TYPE/HELP đầy đủ
    expect(text).toContain('# TYPE lt_dbWriteFail_total counter');
    expect(text).toContain('# HELP lt_dbWriteFail_total');
    expect(text).toContain('lt_dbWriteFail_total 3');
    expect(text).toContain('lt_apiErrors_total 2');
    expect(text).toContain('# TYPE lt_coordinator_rssMb gauge');
    expect(text).toContain('lt_coordinator_rssMb 512');
    expect(text).toContain('lt_worker_alive 4');
    // HELP đi trước sample line
    expect(text.indexOf('# HELP')).toBeLessThan(text.indexOf('lt_dbWriteFail_total 3'));
  });

  it('reset() cô lập giữa test case', () => {
    const m = createToolMetrics();
    m.inc('dbWriteFail', 5);
    m.reset();
    const snap = m.snapshot();
    expect(snap.counters.dbWriteFail).toBe(0);
    expect(snap.gauges['coordinator.rssMb']).toBe(0);
  });

  it('singleton có đủ 5 counters + 2 gauges', () => {
    const snap = toolMetrics.snapshot();
    expect(Object.keys(snap.counters).sort()).toEqual(
      ['apiErrors', 'dbRetry', 'dbWriteFail', 'runFinished', 'workerRestarts'].sort(),
    );
    expect(Object.keys(snap.gauges).sort()).toEqual(['coordinator.rssMb', 'worker.alive'].sort());
  });
});