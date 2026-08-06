import { describe, it, expect } from 'vitest';
import {
  canTransition, transition, decideAutoStop, endPhaseFromStop, aggregateTicks, peakThroughput,
  rollWindow, sumWindow, windowSpanSecs, connectFailRateFromWindow, diffConnectWindowEntry, formatE2Log,
  E2_MIN_ATTEMPTS, E2_WINDOW_MS, E2_MAX_BUCKETS,
} from '../coordinator-state';
import type { RunPhase, WorkerTick } from '../types';

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
      rateLimitedNoEcho: 10, connectAttempts: 100, connectFails: 5,
      connectFailsByType: { timeout: 3, transport: 1, reject: 1, other: 0 },
      usersFailed: 2, reconcileCount: 1, reconnectTotalMs: 3000, reconnectMaxMs: 2000, usersLost: 1, ...over,
    },
    actionsPerSec: { chat: 10, read: 20 },
    actionOk: { chat: 9, read: 19 },
    actionFail: { chat: 1, read: 1 },
    errors: { HTTP_429: 3 },
    errorsByStage: { chat: [{ code: 'HTTP_429', count: 3 }] },
    errorSamples: [{ ts: 1, action: 'chat', stage: 'chat', code: 'HTTP_429', message: 'x', userId: 'u' }],
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

  it('transition bất hợp lệ throw message đầy đủ (G2 — kills 37)', () => {
    expect(() => transition('idle', 'steady')).toThrow('Bất hợp lệ: phase idle → steady');
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
  it('T1: gộp connect metrics (attempts/fails/byType/usersFailed) + hasConnectData true + rates.connectFailRate 0', () => {
    const t0 = fakeTick(0, { connectAttempts: 100, connectFails: 4, usersFailed: 2, connectFailsByType: { timeout: 2, transport: 1, reject: 1, other: 0 } });
    const t1 = fakeTick(1, { connectAttempts: 50, connectFails: 6, usersFailed: 3, connectFailsByType: { timeout: 0, transport: 4, reject: 1, other: 1 } });
    const agg = aggregateTicks('run1', 1_700_000_001_000, 10, 'steady', [t0, t1]);

    expect(agg.tick.counters.connectAttempts).toBe(150);
    expect(agg.tick.counters.connectFails).toBe(10);
    expect(agg.tick.counters.connectFailsByType).toEqual({ timeout: 2, transport: 5, reject: 2, other: 1 });
    expect(agg.tick.counters.usersFailed).toBe(5);
    // rates.connectFailRate: coordinator T5 override trước pushTick — aggregate trả 0 (chưa có window)
    expect(agg.tick.rates.connectFailRate).toBe(0);
    // tick LIVE: hasConnectData = true (replay toMetricTick đặt false)
    expect(agg.tick.hasConnectData).toBe(true);
  });

  it('T1: window rỗng workers → connect metrics zeros, không crash', () => {
    const agg = aggregateTicks('run1', 1_700_000_001_000, 1, 'ramping', []);
    expect(agg.tick.counters.connectAttempts).toBe(0);
    expect(agg.tick.counters.connectFails).toBe(0);
    expect(agg.tick.counters.connectFailsByType).toEqual({ timeout: 0, transport: 0, reject: 0, other: 0 });
    expect(agg.tick.counters.usersFailed).toBe(0);
    expect(agg.tick.rates.connectFailRate).toBe(0);
    expect(agg.tick.hasConnectData).toBe(true);
  });

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
    expect(over.reason).toBe('auto-stop: register fail 50.1% > 50% (E1)'); // F6: 50.1 không làm tròn "50"
    const below = decideAutoStop({ phase: 'provisioning', registerFailRate: 50, connectFailRate: 0, registeredTotal: 9, connectTotal: 0 });
    expect(below.stop).toBe(false);
  });

  it('E1: 49.9% → không dừng (so sánh > thật)', () => {
    expect(decideAutoStop({ phase: 'provisioning', registerFailRate: 49.9, connectFailRate: 0, registeredTotal: 100, connectTotal: 0 }).stop).toBe(false);
  });

  it('E2: đúng biên 30% KHÔNG dừng (điều kiện là > 30, không >=)', () => {
    const at = decideAutoStop({ phase: 'ramping', registerFailRate: 0, connectFailRate: 30, registeredTotal: 0, connectTotal: 50 });
    expect(at.stop).toBe(false);
    expect(at.reason).toBeUndefined();
  });

  it('E2: 30.1% + 50 connect (window) → dừng với reason chính xác; 30% + 49 connect → không dừng', () => {
    const over = decideAutoStop({ phase: 'ramping', registerFailRate: 0, connectFailRate: 30.1, registeredTotal: 0, connectTotal: 50 });
    expect(over.stop).toBe(true);
    expect(over.reason).toBe('auto-stop: connect fail 30.1% > 30% (E2)'); // F6: 30.1 không làm tròn "30"
    const below = decideAutoStop({ phase: 'ramping', registerFailRate: 0, connectFailRate: 30, registeredTotal: 0, connectTotal: 49 });
    expect(below.stop).toBe(false);
  });

  it('E2: connect fail 29.9% → không dừng (so sánh > thật)', () => {
    expect(decideAutoStop({ phase: 'ramping', registerFailRate: 0, connectFailRate: 29.9, registeredTotal: 0, connectTotal: 100 }).stop).toBe(false);
  });

  it('E2: rate 100% nhưng window chưa đủ 50 attempts → KHÔNG dừng (AC-3)', () => {
    const d = decideAutoStop({ phase: 'ramping', registerFailRate: 0, connectFailRate: 100, registeredTotal: 0, connectTotal: 49 });
    expect(d.stop).toBe(false);
  });

  it('E2: window rỗng (rate 0, attempts 0) → không dừng', () => {
    const d = decideAutoStop({ phase: 'ramping', registerFailRate: 0, connectFailRate: 0, registeredTotal: 0, connectTotal: 0 });
    expect(d.stop).toBe(false);
  });

  it('fail rate cao nhưng phase không phải provisioning/ramping → vẫn dừng theo input (thuần)', () => {
    const d = decideAutoStop({ phase: 'error', registerFailRate: 100, connectFailRate: 100, registeredTotal: 20, connectTotal: 20 });
    expect(d.stop).toBe(true);
  });
});

// ─── T2 (DESIGN §4): sliding window 60s WALL-CLOCK + diff clamp ─────────────

describe('coordinator-state — E2 sliding window (T2)', () => {
  const now = 1_700_000_000_000;
  const BY = (timeout = 0, transport = 0, reject = 0, other = 0) => ({ timeout, transport, reject, other });

  it('diffConnectWindowEntry: prev undefined → null (skip-first-tick sau restart — PF1)', () => {
    const cur = { attempts: 200, fails: 40, byType: BY(10, 20, 5, 5) };
    expect(diffConnectWindowEntry(undefined, cur)).toBeNull();
  });

  it('diffConnectWindowEntry: delta đúng + clamp delta âm (S2/ST-3)', () => {
    const prev = { attempts: 100, fails: 10, byType: BY(5, 3, 1, 1) };
    const cur = { attempts: 250, fails: 25, byType: BY(9, 11, 2, 3) };
    expect(diffConnectWindowEntry(prev, cur)).toEqual({
      attempts: 150, fails: 15, byType: BY(4, 8, 1, 2),
    });
    // Restart race: cumulative mới NHỎ HƠN prev → delta = 0 (không âm — rate không bao giờ âm)
    const reset = { attempts: 5, fails: 1, byType: BY(0, 1, 0, 0) };
    expect(diffConnectWindowEntry(prev, reset)).toEqual({ attempts: 0, fails: 0, byType: BY(0, 0, 0, 0) });
    // Clamp theo từng key byType riêng
    const partial = { attempts: 150, fails: 0, byType: BY(0, 0, 2, 0) };
    expect(diffConnectWindowEntry(prev, partial)).toEqual({
      attempts: 50, fails: 0, byType: BY(0, 0, 1, 0),
    });
  });

  it('rollWindow: 1 entry → [entry] (PURE — không mutate input)', () => {
    const buckets: ReturnType<typeof rollWindow> = [];
    const byTypeIn = BY(1, 1, 0, 0);
    const out = rollWindow(buckets, now, 10, 2, byTypeIn);
    expect(out).toEqual([{ ts: now, attempts: 10, fails: 2, byType: BY(1, 1, 0, 0) }]);
    expect(buckets).toEqual([]); // immutability
    expect(out[0].byType).not.toBe(byTypeIn); // F7: không alias object caller (clone)
  });

  it('rollWindow: evict theo WALL-CLOCK age > 60s (không đếm bucket)', () => {
    let buckets: ReturnType<typeof rollWindow> = [];
    // 65 tick, ts cách 1s từ now-64s → now
    for (let i = 0; i < 65; i++) {
      const ts = now - (64 - i) * 1000;
      buckets = rollWindow(buckets, ts, 10, 1, BY(1, 0, 0, 0));
    }
    // Chỉ giữ 60s thực: ts ∈ [now-60s, now] → 61 bucket, oldest = now-60s
    expect(buckets.length).toBe(61);
    expect(buckets[0].ts).toBe(now - 60_000);
    expect(buckets[buckets.length - 1].ts).toBe(now);
  });

  it('rollWindow: safety cap length ≤ 120 kể cả khi mọi entry trong window (evict hỏng)', () => {
    let buckets: ReturnType<typeof rollWindow> = [];
    for (let i = 0; i < 150; i++) {
      buckets = rollWindow(buckets, now, 1, 0, BY(0, 0, 0, 0), E2_MAX_BUCKETS);
    }
    expect(buckets.length).toBe(120);
  });

  it('rollWindow: entry quá hạn bị evict dù length < max (age, không phải count)', () => {
    const buckets = [
      { ts: now - 90_000, attempts: 999, fails: 999, byType: BY(999, 0, 0, 0) }, // quá hạn
      { ts: now - 30_000, attempts: 5, fails: 1, byType: BY(1, 0, 0, 0) },
    ];
    const out = rollWindow(buckets, now, 2, 0, BY(0, 0, 0, 0));
    expect(out).toHaveLength(2); // entry 90s cũ bị evict, chỉ còn 30s + mới
    expect(out[0].ts).toBe(now - 30_000);
  });

  it('sumWindow: rỗng → zeros; sum attempts/fails + merge byType (sum 4 loại == fails)', () => {
    expect(sumWindow([])).toEqual({ attempts: 0, fails: 0, byType: BY(0, 0, 0, 0) });
    const buckets = [
      { ts: now - 2000, attempts: 100, fails: 20, byType: BY(10, 5, 3, 2) },
      { ts: now - 1000, attempts: 50, fails: 12, byType: BY(4, 6, 1, 1) },
    ];
    const s = sumWindow(buckets);
    expect(s.attempts).toBe(150);
    expect(s.fails).toBe(32);
    expect(s.byType).toEqual(BY(14, 11, 4, 3));
    expect(s.byType.timeout + s.byType.transport + s.byType.reject + s.byType.other).toBe(s.fails); // bất biến
  });

  it('windowSpanSecs: rỗng → 0; span thật không hardcode 60 (BE-3)', () => {
    expect(windowSpanSecs([], now)).toBe(0);
    const buckets = [
      { ts: now - 62_400, attempts: 1, fails: 0, byType: BY(0, 0, 0, 0) },
      { ts: now, attempts: 1, fails: 0, byType: BY(0, 0, 0, 0) },
    ];
    expect(windowSpanSecs(buckets, now)).toBe(62); // stall bucket → span thật
    const full = Array.from({ length: 60 }, (_, i) => ({
      ts: now - (59 - i) * 1000, attempts: 1, fails: 0, byType: BY(0, 0, 0, 0),
    }));
    expect(windowSpanSecs(full, now)).toBe(59);
  });

  it('connectFailRateFromWindow: chưa đủ 50 attempts → 0 (AC-3); đủ → fails/attempts*100', () => {
    expect(connectFailRateFromWindow(0, 0)).toBe(0);
    expect(connectFailRateFromWindow(49, 49)).toBe(0); // 100% fail nhưng thiếu mẫu
    expect(connectFailRateFromWindow(50, 17)).toBe(34);
    expect(connectFailRateFromWindow(50, 50)).toBe(100);
    expect(connectFailRateFromWindow(E2_MIN_ATTEMPTS, 15)).toBe(30); // biên 30% với 50 attempts
  });

  it('decideAutoStop: rate 100% attempts 49 → không dừng; 50 → dừng (E2)', () => {
    expect(decideAutoStop({ phase: 'ramping', registerFailRate: 0, connectFailRate: 100, registeredTotal: 0, connectTotal: 49 }).stop).toBe(false);
    const d = decideAutoStop({ phase: 'ramping', registerFailRate: 0, connectFailRate: 100, registeredTotal: 0, connectTotal: 50 });
    expect(d.stop).toBe(true);
    expect(d.reason).toContain('E2');
  });

  it('decideAutoStop: boundary 30% + 50 attempts → không dừng (> thật)', () => {
    expect(decideAutoStop({ phase: 'steady', registerFailRate: 0, connectFailRate: 30, registeredTotal: 0, connectTotal: 50 }).stop).toBe(false);
    expect(decideAutoStop({ phase: 'steady', registerFailRate: 0, connectFailRate: 30.1, registeredTotal: 0, connectTotal: 50 }).stop).toBe(true);
  });

  it('hằng số: E2_WINDOW_MS = 60s, E2_MIN_ATTEMPTS = 50', () => {
    expect(E2_WINDOW_MS).toBe(60_000);
    expect(E2_MIN_ATTEMPTS).toBe(50);
  });
});

// ─── T5 (DESIGN §6): formatE2Log 8 trường — regex-assertable (AC-4/ST-7) ─────

describe('coordinator-state — formatE2Log (T5)', () => {
  const E2_LOG_RE =
    /^phase=\S+ elapsedSec=\d+ windowSec=\d+ windowAttempts=\d+ windowFails=\d+ byType=timeout:\d+,transport:\d+,reject:\d+,other:\d+ usersFailedCum=\d+ workersAlive=\d+ workersTotal=\d+$/;

  it('8 trường đủ + byType sum == windowFails + khớp regex', () => {
    const s = formatE2Log({
      phase: 'ramping',
      elapsedSec: 87,
      windowSecs: 60,
      window: { attempts: 8120, fails: 3330, byType: { timeout: 2500, transport: 500, reject: 300, other: 30 } },
      usersFailedCum: 450,
      workersAlive: 10,
      workersTotal: 10,
    });
    expect(s).toMatch(E2_LOG_RE);
    expect(s).toContain('phase=ramping');
    expect(s).toContain('elapsedSec=87');
    expect(s).toContain('windowSec=60');
    expect(s).toContain('windowAttempts=8120');
    expect(s).toContain('windowFails=3330');
    expect(s).toContain('byType=timeout:2500,transport:500,reject:300,other:30'); // TỪ WINDOW (SEC-1)
    expect(s).toContain('usersFailedCum=450'); // cumulative — suffix Cum (F-7)
    expect(s).toContain('workersAlive=10');
    expect(s).toContain('workersTotal=10');
  });

  it('window rỗng → 8 trường zeros, vẫn khớp regex (không crash)', () => {
    const s = formatE2Log({
      phase: 'steady',
      elapsedSec: 1,
      windowSecs: 0,
      window: { attempts: 0, fails: 0, byType: { timeout: 0, transport: 0, reject: 0, other: 0 } },
      usersFailedCum: 0,
      workersAlive: 0,
      workersTotal: 1,
    });
    expect(s).toMatch(E2_LOG_RE);
    expect(s).toContain('windowAttempts=0');
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
    expect(agg.actionFail.chat).toBeUndefined(); // G2: mutant if(fail)=true → NaN (kills 270)
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
        ts: i, action: 'chat' as const, stage: 'chat' as const, code: `${prefix}${i}`, message: 'm', userId: 'u',
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

// ─── G2 (hard-gate fix E2) — diệt mutant critical còn sống ─────────────────

describe('G2 — TRANSITIONS toàn bộ cạnh + transition happy path (21-25/36)', () => {
  // Bảng 20 cạnh — khớp source TRANSITIONS; mutant StringLiteral/ArrayDecl ở 21-25
  // bị diệt vì từng cạnh được assert cụ thể (stop/error path — đường auto-stop E2).
  const EXPECTED: Record<string, string[]> = {
    idle: ['provisioning'],
    provisioning: ['ramping', 'cooldown', 'error', 'stopped'],
    ramping: ['steady', 'cooldown', 'error', 'stopped'],
    steady: ['cooldown', 'error', 'stopped'],
    cooldown: ['report', 'error', 'stopped'],
    report: ['finished', 'stopped'],
    finished: [],
    stopped: [],
    error: [],
  };

  it('mọi cạnh hợp lệ đều canTransition true (kills 21-25)', () => {
    for (const [from, tos] of Object.entries(EXPECTED)) {
      for (const to of tos) {
        expect(canTransition(from as RunPhase, to as RunPhase)).toBe(true);
      }
    }
  });

  it('rows rỗng (finished/stopped/error) chặn MỌI phase — kể cả placeholder ArrayDecl của Stryker (kills 26-28)', () => {
    // Stryker ArrayDeclarationMutator biến `[]` → `['Stryker was here']` (KHÔNG có '!') —
    // chặn cả placeholder lẫn mọi RunPhase hợp lệ để diệt mutant, không chỉ test cạnh positive.
    const placeholders = ['provisioning', 'ramping', 'steady', 'cooldown', 'report', 'finished', 'Stryker was here', 'Stryker was here!'] as const;
    for (const from of ['finished', 'stopped', 'error'] as const) {
      for (const to of placeholders) {
        expect(canTransition(from, to as RunPhase)).toBe(false);
      }
    }
  });

  it('transition() happy path trả đúng phase đích, không throw (kills 36)', () => {
    expect(transition('idle', 'provisioning')).toBe('provisioning');
    expect(transition('provisioning', 'ramping')).toBe('ramping');
    expect(transition('provisioning', 'cooldown')).toBe('cooldown');
    expect(transition('provisioning', 'error')).toBe('error');
    expect(transition('ramping', 'steady')).toBe('steady');
    expect(transition('steady', 'cooldown')).toBe('cooldown');
    expect(transition('cooldown', 'report')).toBe('report');
    expect(transition('cooldown', 'stopped')).toBe('stopped');
    expect(transition('report', 'finished')).toBe('finished');
  });
});

describe('G2 — aggregateTicks mutant còn sống (240-252/264/270/297/303/331/338/339/237)', () => {
  it('gộp đủ counter (kills 240/242/243/248/249/250/251/252 -= mutants)', () => {
    const ticks = [fakeTick(0), fakeTick(1, { actionsTotal: 2000, successTotal: 1950, failTotal: 50, usersConnected: 50, droppedOutbox: 3 })];
    const agg = aggregateTicks('run1', 1_700_000_001_000, 10, 'steady', ticks);
    expect(agg.tick.counters.usersCreated).toBe(200);
    expect(agg.tick.counters.usersActive).toBe(200);
    expect(agg.tick.counters.usersQueued).toBe(10);
    expect(agg.tick.counters.echoOk).toBe(180);
    expect(agg.tick.counters.echoSent).toBe(200);
    expect(agg.tick.counters.droppedOutbox).toBe(3); // mutant -= → -3
    expect(agg.tick.counters.reconnectCount).toBe(4);
    expect(agg.tick.counters.rateLimitedNoEcho).toBe(20);
    // Histogram gộp 2 tick [5,10,0] → [10,20,0] (giữ giá trị merge; mutant 278 Math.max→Math.min
    // là dead local — histBucketCount không được đọc sau vòng lặp → equivalent, không kill được)
    expect(agg.perActionHistograms.chat).toEqual([10, 20, 0]);
  });

  it('rates/type/server/actionsPerSec đúng (kills 264/303/331/338)', () => {
    const ticks = [fakeTick(0), fakeTick(1, {})];
    const agg = aggregateTicks('run1', 1_700_000_001_000, 10, 'steady', ticks);
    expect(agg.tick.rates.echoRate).toBe(90); // mutant *10 → 9000, /1000 → 0.1, * → 36e6
    expect(agg.tick.type).toBe('tick'); // mutant → ''
    expect(agg.tick.server.wsConnections).toBe(0); // mutant server={} → undefined
    expect(agg.tick.actionsPerSec.comment).toBeUndefined(); // mutant if(v)=true → NaN
  });

  it('> 10 error codes → topErrors slice 10 (kills 297)', () => {
    const t = fakeTick(0, {});
    const errs: Record<string, number> = {};
    for (let i = 0; i < 12; i++) errs[`E${i}`] = i;
    t.errors = errs;
    const agg = aggregateTicks('run1', 1_700_000_001_000, 1, 'steady', [t]);
    expect(agg.tick.errors).toHaveLength(10); // mutant bỏ slice → 12
  });

  it('cpuAvg: round(sum/n) với 2 worker + rỗng → 0 (kills 339)', () => {
    const agg2 = aggregateTicks('run1', 1_700_000_001_000, 1, 'steady', [fakeTick(0, {}), { ...fakeTick(1, {}), cpuPct: 20 }]);
    expect(agg2.tick.workers.cpuAvg).toBe(30); // mutant cpuSum*cpuN → 120
    const agg0 = aggregateTicks('run1', 1_700_000_001_000, 1, 'steady', []);
    expect(agg0.tick.workers.cpuAvg).toBe(0); // mutant cpuN>=0 → NaN
  });

  it('không tick → errorSamples rỗng (kills 237)', () => {
    const agg = aggregateTicks('run1', 1_700_000_001_000, 1, 'steady', []);
    expect(agg.errorSamples).toEqual([]); // mutant → ['Stryker was here']
  });
});
