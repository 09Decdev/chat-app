import { describe, it, expect } from 'vitest';
import { canTransition, transition, decideAutoStop, endPhaseFromStop, aggregateTicks } from '../coordinator-state';
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
