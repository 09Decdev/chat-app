/**
 * slicesFromTick — donut slice `failed` từ usersFailed (D7, UI-SPEC §5).
 * Bất biến khóa: tổng slices = usersCreated (với dữ liệu nhất quán về mặt vật lý:
 * connected + failed ≤ usersCreated; in_room/queued ≤ connected).
 */
import { describe, it, expect } from 'vitest';
import { slicesFromTick } from '@/components/loadtest/user-phases';
import type { LoadTestTick } from '@/types/loadtest';

function makeTick(counters?: Partial<LoadTestTick['counters']>): LoadTestTick {
  return {
    type: 'tick',
    runId: 'run-1',
    ts: 1,
    phase: 'steady',
    elapsedSec: 1,
    counters: {
      usersCreated: 1000,
      usersConnected: 700,
      usersActive: 500,
      usersQueued: 100,
      usersInRoom: 300,
      actionsTotal: 0,
      successTotal: 0,
      failTotal: 0,
      echoOk: 0,
      echoSent: 0,
      queueCount: 0,
      roomCount: 0,
      droppedOutbox: 0,
      reconnectCount: 0,
      rateLimitedNoEcho: 0,
      connectAttempts: 12400,
      connectFails: 1107,
      connectFailsByType: { timeout: 750, transport: 340, reject: 12, other: 5 },
      usersFailed: 42,
      reconcileCount: 0,
      reconnectTotalMs: 0,
      reconnectMaxMs: 0,
      usersLost: 0,
      ...counters,
    },
    rates: { successRate: 95, echoRate: 90, connectFailRate: 12.4 },
    actionsPerSec: {},
    latency: { p50: 1, p95: 2, p99: 3 },
    errors: [],
    errorsByStage: {},
    server: { wsConnections: 1, wsMessagesEmitted: 1, wsMessagesPerSec: 1 },
    workers: { alive: 1, total: 1, cpuAvg: 0, rssAvgMb: 0 },
  };
}

const sumSlices = (slices: ReturnType<typeof slicesFromTick>) => slices.reduce((acc, s) => acc + s.value, 0);

describe('slicesFromTick — slice failed (D7)', () => {
  it('bất biến: tổng slices = usersCreated khi có usersFailed', () => {
    const slices = slicesFromTick(makeTick());
    expect(sumSlices(slices)).toBe(1000);
  });

  it('thêm slice failed: value = usersFailed, label "Lỗi", đứng cuối (USER_PHASE_ORDER)', () => {
    const slices = slicesFromTick(makeTick({ usersFailed: 42 }));
    const failed = slices.find((s) => s.key === 'failed');
    expect(failed).toBeDefined();
    expect(failed!.label).toBe('Lỗi');
    expect(failed!.value).toBe(42);
    expect(slices[slices.length - 1].key).toBe('failed');
  });

  it('usersFailed = 0 → không có slice failed, tổng vẫn = usersCreated', () => {
    const slices = slicesFromTick(makeTick({ usersFailed: 0 }));
    expect(slices.some((s) => s.key === 'failed')).toBe(false);
    expect(sumSlices(slices)).toBe(1000);
  });

  it('usersFailed chiếm hết phần chưa kết nối → provisioned = 0 (bị lọc), tổng giữ nguyên', () => {
    // connected 700 → chưa kết nối tối đa 300; failed 300 ăn trọn phần đó
    const slices = slicesFromTick(makeTick({ usersFailed: 300 }));
    expect(sumSlices(slices)).toBe(1000);
    expect(slices.every((s) => s.value >= 0)).toBe(true);
    expect(slices.find((s) => s.key === 'failed')!.value).toBe(300);
  });

  it('usersFailed vượt chưa-kết-nối (counters race) → clamp, không giá trị âm, không crash', () => {
    const slices = slicesFromTick(makeTick({ usersFailed: 500 }));
    expect(slices.every((s) => s.value >= 0)).toBe(true);
  });

  it('tick null / usersCreated 0 → []', () => {
    expect(slicesFromTick(null)).toEqual([]);
    expect(slicesFromTick(undefined)).toEqual([]);
    expect(slicesFromTick(makeTick({ usersCreated: 0 }))).toEqual([]);
  });
});
