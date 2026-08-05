/**
 * T1 — contract connect metrics (DESIGN-loadtest-e2-connect-fail §2):
 * toMetricTick (DB replay) — DB không có cột connect (R1) → field = 0 + hasConnectData: false.
 */
import { describe, it, expect } from 'vitest';
import { toMetricTick } from '../api-mappers';
import type { MetricSampleRow } from '../db/store';

function row(over: Partial<MetricSampleRow> = {}): MetricSampleRow {
  return {
    runId: 'lt-replay', ts: 1_700_000_000_000, phase: 'steady', elapsedSec: 10,
    usersCreated: 1000, usersConnected: 900, usersActive: 800, usersQueued: 10, usersInRoom: 500,
    actionsTotal: 5000, successTotal: 4800, failTotal: 200, echoOk: 400, echoSent: 500,
    queueCount: 30, roomCount: 83, droppedOutbox: 0, reconnectCount: 2, rateLimitedNoEcho: 5,
    successRate: 96, echoRate: 80,
    actionsPerSecJson: '{"chat":10}', latencyJson: '{"p50":1,"p95":2,"p99":3}',
    errorsJson: '[{"code":"HTTP_429","count":3}]', serverJson: '{}', workersJson: '{}',
    ...over,
  };
}

describe('api-mappers — toMetricTick (T1 contract: replay)', () => {
  it('connect fields = 0 (DB không cột — R1) + rates.connectFailRate 0 + hasConnectData false', () => {
    const t = toMetricTick(row());
    expect(t.counters.connectAttempts).toBe(0);
    expect(t.counters.connectFails).toBe(0);
    expect(t.counters.connectFailsByType).toEqual({ timeout: 0, transport: 0, reject: 0, other: 0 });
    expect(t.counters.usersFailed).toBe(0);
    expect(t.rates.connectFailRate).toBe(0);
    // UI phân biệt "không persist" vs "thật 0" (UI-1 — DESIGN §2.1)
    expect(t.hasConnectData).toBe(false);
  });

  it('không đổi field cũ — replay vẫn trả đúng giá trị lịch sử', () => {
    const t = toMetricTick(row({ usersConnected: 777, successRate: 91.5, phase: 'error' }));
    expect(t.counters.usersConnected).toBe(777);
    expect(t.rates.successRate).toBe(91.5);
    expect(t.phase).toBe('error');
  });
});
