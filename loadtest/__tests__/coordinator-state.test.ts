import { describe, it, expect } from 'vitest';
import { canTransition, transition, decideAutoStop, endPhaseFromStop, aggregateTicks, peakThroughput } from '../coordinator-state';
import type { WorkerTick } from '../types';

function fakeTick(workerId: number, over: Partial<WorkerTick['counters']> = {}): WorkerTick {
  return {
    type: 'tick',
    workerId,
    ts: 1_700_000_000_000,
    phase: 'steady',
    counters: {
      usersTotal: 100, usersCreated: 100, usersConnected: 100, usersActive: 100,
      usersQueued: 5, usersInRoom: 60, actionsTotal: 1000, successTotal: 950,
      failTotal: 50, echoOk: 90, echoSent: 100, droppedOutbox: 0, reconnectCount: 2,
      rateLimitedNoEcho: 10, connectAttempts: 100, connectFails: 5, ...over,
    },
    actionsPerSec: { chat: 10, read: 20 },
    actionOk: { chat: 9, read: 19 },
    actionFail: { chat: 1, read: 1 },
    errors: { HTTP_429: 3 },
    errorSamples: [{ ts: 1, action: 'chat', code: 'HTTP_429', message: 'x', userId: 'u' }],
    histograms: { chat: [5, 10, 0] },
    histogramBucketCount: 3,
    cpuPct: 40,
    rssMb: 100,
  };
}

describe('coordinator-state — state machine', () => {
  it('cho phép transition hợp lệ', () => {
    expect(canTransition('idle', 'provisioning')).toBe(true);
    expect(canTransition('provisioning', 'ramping')).toBe(true);
    expect(canTransition('ramping', 'steady')).toBe(true);
    expect(canTransition('steady', 'cooldown')).toBe(true);
    expect(canTransition('cooldown', 'report')).toBe(true);
    expect(canTransition('report', 'finished')).toBe(true);
  });

  it('chặn transition bất hợp lệ', () => {
    expect(canTransition('idle', 'steady')).toBe(false);
    expect(canTransition('finished', 'ramping')).toBe(false);
    expect(() => transition('idle', 'steady')).toThrow();
  });

  it('endPhaseFromStop: natural → finished, auto → error, manual → stopped', () => {
    expect(endPhaseFromStop('natural').phase).toBe('finished');
    expect(endPhaseFromStop('auto', 'E1').phase).toBe('error');
    expect(endPhaseFromStop('manual').phase).toBe('stopped');
    expect(endPhaseFromStop('auto', 'E1').stopReason).toBe('E1');
  });
});

describe('coordinator-state — auto-stop', () => {
  it('dừng khi register fail > 50% và đủ sample (E1)', () => {
    const d = decideAutoStop({ phase: 'provisioning', registerFailRate: 60, connectFailRate: 0, registeredTotal: 20, connectTotal: 0 });
    expect(d.stop).toBe(true);
    expect(d.reason).toContain('E1');
  });

  it('không dừng khi sample quá ít', () => {
    const d = decideAutoStop({ phase: 'provisioning', registerFailRate: 100, connectFailRate: 0, registeredTotal: 3, connectTotal: 0 });
    expect(d.stop).toBe(false);
  });

  it('dừng khi connect fail > 30% (E2)', () => {
    const d = decideAutoStop({ phase: 'ramping', registerFailRate: 0, connectFailRate: 40, registeredTotal: 0, connectTotal: 50 });
    expect(d.stop).toBe(true);
    expect(d.reason).toContain('E2');
  });

  it('không dừng khi rate bình thường', () => {
    const d = decideAutoStop({ phase: 'steady', registerFailRate: 10, connectFailRate: 5, registeredTotal: 100, connectTotal: 100 });
    expect(d.stop).toBe(false);
  });
});

describe('coordinator-state — aggregateTicks', () => {
  it('gộp counters + histogram từ nhiều worker', () => {
    const ticks = [fakeTick(0), fakeTick(1, { actionsTotal: 2000, successTotal: 1950, failTotal: 50, usersConnected: 50 })];
    const agg = aggregateTicks('run1', 1_700_000_001_000, 10, 'steady', ticks);

    expect(agg.tick.counters.actionsTotal).toBe(3000);
    expect(agg.tick.counters.usersConnected).toBe(150);
    expect(agg.tick.counters.roomCount).toBe(20); // 120 in_room / 6
    expect(agg.tick.rates.successRate).toBeCloseTo(96.7, 1);
    expect(agg.tick.actionsPerSec.chat).toBe(20);
    expect(agg.tick.actionsPerSec.read).toBe(40);
    // histogram gộp: chat [10, 20, 0]
    expect(agg.perActionHistograms.chat).toEqual([10, 20, 0]);
    // per-action ok/fail gộp
    expect(agg.actionOk.chat).toBe(18);
    expect(agg.actionFail.chat).toBe(2);
    // top errors gộp: HTTP_429 = 6
    const err = agg.tick.errors.find((e) => e.code === 'HTTP_429');
    expect(err?.count).toBe(6);
  });

  it('latency P50/P95/P99 tính từ histogram', () => {
    // 100 sample ở bucket nhỏ nhất (1ms)
    const tick = fakeTick(0, {});
    const agg = aggregateTicks('run1', 1_700_000_001_000, 1, 'steady', [tick]);
    expect(agg.tick.latency.p50).toBeGreaterThanOrEqual(1);
  });

  it('empty workers → tick zeros, không crash', () => {
    const agg = aggregateTicks('run1', 1_700_000_001_000, 1, 'ramping', []);
    expect(agg.tick.counters.actionsTotal).toBe(0);
    expect(agg.tick.rates.successRate).toBe(100);
  });
});

// ─── T-11 (G-2): test mở rộng diệt mutant coordinator-state.ts ─────────────

describe('coordinator-state — biên auto-stop (E1/E2)', () => {
  it('E1: đúng biên 50% KHÔNG dừng (điều kiện là > 50, không >=)', () => {
    const at = decideAutoStop({ phase: 'provisioning', registerFailRate: 50, connectFailRate: 0, registeredTotal: 10, connectTotal: 0 });
    expect(at.stop).toBe(false);
    expect(at.reason).toBeUndefined();
  });

  it('E1: 50.1% + 10 sample → dừng với reason chính xác; 50% + 9 sample → không dừng', () => {
    const over = decideAutoStop({ phase: 'provisioning', registerFailRate: 50.1, connectFailRate: 0, registeredTotal: 10, connectTotal: 0 });
    expect(over.stop).toBe(true);
    expect(over.reason).toBe('auto-stop: register fail 50% > 50% (E1)');
    const below = decideAutoStop({ phase: 'provisioning', registerFailRate: 50, connectFailRate: 0, registeredTotal: 9, connectTotal: 0 });
    expect(below.stop).toBe(false);
  });

  it('E1: 49.9% → không dừng (so sánh > thật)', () => {
    expect(decideAutoStop({ phase: 'provisioning', registerFailRate: 49.9, connectFailRate: 0, registeredTotal: 100, connectTotal: 0 }).stop).toBe(false);
  });

  it('E2: đúng biên 30% KHÔNG dừng (điều kiện là > 30, không >=)', () => {
    const at = decideAutoStop({ phase: 'ramping', registerFailRate: 0, connectFailRate: 30, registeredTotal: 0, connectTotal: 10 });
    expect(at.stop).toBe(false);
    expect(at.reason).toBeUndefined();
  });

  it('E2: 30.1% + 10 connect → dừng với reason chính xác; 30% + 9 connect → không dừng', () => {
    const over = decideAutoStop({ phase: 'ramping', registerFailRate: 0, connectFailRate: 30.1, registeredTotal: 0, connectTotal: 10 });
    expect(over.stop).toBe(true);
    expect(over.reason).toBe('auto-stop: connect fail 30% > 30% (E2)');
    const below = decideAutoStop({ phase: 'ramping', registerFailRate: 0, connectFailRate: 30, registeredTotal: 0, connectTotal: 9 });
    expect(below.stop).toBe(false);
  });

  it('E2: connect fail 29.9% → không dừng (so sánh > thật)', () => {
    expect(decideAutoStop({ phase: 'ramping', registerFailRate: 0, connectFailRate: 29.9, registeredTotal: 0, connectTotal: 100 }).stop).toBe(false);
  });

  it('fail rate cao nhưng phase không phải provisioning/ramping → vẫn dừng theo input (thuần)', () => {
    const d = decideAutoStop({ phase: 'error', registerFailRate: 100, connectFailRate: 100, registeredTotal: 20, connectTotal: 20 });
    expect(d.stop).toBe(true);
  });
});

describe('coordinator-state — endPhaseFromStop reason mặc định (template chính xác)', () => {
  it('manual không reason → default stopReason', () => {
    expect(endPhaseFromStop('manual').stopReason).toBe('run bị dừng thủ công (kill-switch)');
  });
  it('auto không reason → default error', () => {
    expect(endPhaseFromStop('auto').stopReason).toBe('run tự dừng do lỗi');
  });
  it('natural giữ reason (có thể undefined)', () => {
    expect(endPhaseFromStop('natural', 'duration hết').stopReason).toBe('duration hết');
    expect(endPhaseFromStop('natural').stopReason).toBeUndefined();
  });
});

describe('coordinator-state — aggregateTicks nhánh sâu (T-11)', () => {
  it('actionOk/actionFail khi worker KHÔNG có field (undefined) → không crash', () => {
    const t = {
      ...fakeTick(0),
      actionOk: undefined,
      actionFail: undefined,
      histograms: undefined,
      errorSamples: undefined,
    } as unknown as WorkerTick;
    const agg = aggregateTicks('run1', 1_700_000_001_000, 1, 'steady', [t]);
    expect(agg.actionOk.chat).toBeUndefined();
    expect(agg.tick.counters.actionsTotal).toBe(1000);
    expect(agg.tick.latency.p50).toBe(0);
  });

  it('successTotal == 0 → successRate 100; echoSent == 0 → echoRate 100', () => {
    const t: WorkerTick = { ...fakeTick(0), counters: { ...fakeTick(0).counters, successTotal: 0, failTotal: 0, echoOk: 0, echoSent: 0 } };
    const agg = aggregateTicks('run1', 1_700_000_001_000, 1, 'steady', [t]);
    expect(agg.tick.rates.successRate).toBe(100);
    expect(agg.tick.rates.echoRate).toBe(100);
  });

  it('cpuPct == 0 bị bỏ qua (không làm giảm cpuAvg)', () => {
    const t0 = fakeTick(0, {});
    const t1: WorkerTick = { ...fakeTick(1, {}), cpuPct: 0 };
    const agg = aggregateTicks('run1', 1_700_000_001_000, 1, 'steady', [t0, t1]);
    expect(agg.tick.workers.cpuAvg).toBe(40); // chỉ 1 worker có cpu
  });

  it('top errors sort theo count giảm + slice 10', () => {
    const t = fakeTick(0, {});
    t.errors = { A: 1, B: 9, C: 2 };
    const agg = aggregateTicks('run1', 1_700_000_001_000, 1, 'steady', [t]);
    expect(agg.tick.errors.map((e) => e.code)).toEqual(['B', 'C', 'A']);
  });

  it('errorSamples: tick sau gộp trước tick cũ, cap 20', () => {
    const mk = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ts: i, action: 'chat' as const, code: `${prefix}${i}`, message: 'm', userId: 'u',
      }));
    const t0 = { ...fakeTick(0), errorSamples: mk('E', 5) }; // 5 mẫu cũ
    const t1 = { ...fakeTick(1), errorSamples: mk('F', 25) }; // 25 mẫu mới
    const agg = aggregateTicks('run1', 1_700_000_001_000, 1, 'steady', [t0, t1]);
    expect(agg.errorSamples).toHaveLength(20);
    expect(agg.errorSamples[0].code).toBe('F0'); // mẫu của tick xử lý sau đứng trước
    expect(agg.errorSamples[19].code).toBe('F19');
    expect(agg.errorSamples.some((s) => s.code.startsWith('E'))).toBe(false); // mẫu cũ bị cắt
  });

  it('histogram gộp: target array do TICK ĐẦU tạo — bucket sau chỉ cộng phần chung', () => {
    const t0 = fakeTick(0, {}); // histogramBucketCount 3
    const t1: WorkerTick = {
      ...fakeTick(1, {}),
      histograms: { chat: [1, 2, 3, 4, 5, 6, 7, 8] },
      histogramBucketCount: 8,
    };
    const agg = aggregateTicks('run1', 1_700_000_001_000, 1, 'steady', [t0, t1]);
    // bucket 0-2: t0 [5,10,0] + t1 [1,2,3]; bucket 3-7: KHÔNG có target (giữ len 3)
    expect(agg.perActionHistograms.chat).toEqual([6, 12, 3]);
  });

  it('roomCount = round(usersInRoom / 6)', () => {
    const t = fakeTick(0, { usersInRoom: 7 });
    const agg = aggregateTicks('run1', 1_700_000_001_000, 1, 'steady', [t]);
    expect(agg.tick.counters.roomCount).toBe(1);
  });

  it('peakThroughput: rỗng → 0; chuỗi → max', () => {
    expect(peakThroughput([])).toBe(0);
    expect(peakThroughput([1, 5, 3, 9, 2])).toBe(9);
  });
});
