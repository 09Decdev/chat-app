/**
 * MAYogu LoadTest Tool — coordinator state machine (PURE — testable không cần IO).
 * Phase: IDLE → PROVISIONING → RAMPING → STEADY → COOLDOWN → REPORT → FINISHED
 *        → (lỗi) ERROR · (dừng tay) STOPPED
 */

import type { ConnectFailsByType, LoadTestTick, RunPhase, WorkerTick, ActionType, ErrorSample } from './types';
import { ACTION_TYPES, EMPTY_CONNECT_FAILS } from './types';
import { BucketedHistogram } from './metrics';

export type StopKind = 'auto' | 'manual' | 'kill';

export interface StopDecision {
  stop: boolean;
  reason?: string;
}

/** Chuyển phase hợp lệ. */
const TRANSITIONS: Record<RunPhase, RunPhase[]> = {
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

export function canTransition(from: RunPhase, to: RunPhase): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function transition(from: RunPhase, to: RunPhase): RunPhase {
  if (!canTransition(from, to)) {
    throw new Error(`Bất hợp lệ: phase ${from} → ${to}`);
  }
  return to;
}

/**
 * Quyết định dừng tự động (AC1.3 / UX-FLOW E1-E3):
 * - register fail > 50% (cửa sổ 60s)
 * - connect fail > 30% (cửa sổ 60s)
 * - > 50% worker chết trong 60s (kiểm tra ngoài — ở coordinator)
 */
export interface AutoStopInput {
  phase: RunPhase;
  registerFailRate: number; // 0-100
  connectFailRate: number; // 0-100
  registeredTotal: number; // tổng đã thử register
  connectTotal: number; // tổng đã thử connect
}

export function decideAutoStop(input: AutoStopInput): StopDecision {
  if (input.registerFailRate > 50 && input.registeredTotal >= 10) {
    return { stop: true, reason: `auto-stop: register fail ${input.registerFailRate.toFixed(0)}% > 50% (E1)` };
  }
  // E2: connectTotal = attempts TRONG window 60s (semantics đổi — PRD §6.6 chấp nhận; window chưa đủ
  // 50 attempts → rate 0 từ connectFailRateFromWindow nên nhánh này không trigger — AC-3).
  if (input.connectFailRate > E2_FAIL_RATE_PCT && input.connectTotal >= E2_MIN_ATTEMPTS) {
    return { stop: true, reason: `auto-stop: connect fail ${input.connectFailRate.toFixed(0)}% > ${E2_FAIL_RATE_PCT}% (E2)` };
  }
  return { stop: false };
}

// ─── E2 sliding window 60s WALL-CLOCK (DESIGN-loadtest-e2-connect-fail §4) ───

/** Cumulative connect của 1 worker tại 1 tick (snapshot để diff). */
export interface ConnectCountersSnapshot {
  attempts: number;
  fails: number;
  byType: ConnectFailsByType;
}

/** 1 bucket = delta của 1 lần aggregateTick (đã diff + clamp). `ts` = wall-clock ms lúc roll. */
export interface ConnectWindowBucket {
  ts: number;
  attempts: number;
  fails: number;
  byType: ConnectFailsByType;
}

/** Cửa sổ 60s thật (wall-clock age — không đếm bucket, PF1). */
export const E2_WINDOW_MS = 60_000;
/** Threshold M2: window phải đủ ≥ 50 attempts mới evaluate (PRD §3 M2 — thay 10 cumulative). */
export const E2_MIN_ATTEMPTS = 50;
/** Safety cap: chống length vô hạn nếu evict hỏng (roll bug). */
export const E2_MAX_BUCKETS = 120;
/** Ngưỡng fail rate E2 (PRD §6.6: KHÔNG cấu hình hóa). */
export const E2_FAIL_RATE_PCT = 30;

/**
 * Diff cumulative per-worker → delta bucket (T5 wiring dùng).
 * - `prev` undefined (worker mới spawn / vừa E3-restart) → SKIP tick đầu (return null, không tạo bucket
 *   phình 2-15s — PF1). T5 set prev = snapshot hiện tại rồi continue.
 * - Clamp delta âm max(0, …) cho attempts/fails/byType — restart race / counter reset không được tạo
 *   rate âm giấu outage thật (S2/ST-3).
 */
export function diffConnectWindowEntry(
  prev: ConnectCountersSnapshot | undefined,
  cur: ConnectCountersSnapshot,
): Omit<ConnectWindowBucket, 'ts'> | null {
  if (!prev) return null;
  return {
    attempts: Math.max(0, cur.attempts - prev.attempts),
    fails: Math.max(0, cur.fails - prev.fails),
    byType: {
      timeout: Math.max(0, cur.byType.timeout - prev.byType.timeout),
      transport: Math.max(0, cur.byType.transport - prev.byType.transport),
      reject: Math.max(0, cur.byType.reject - prev.byType.reject),
      other: Math.max(0, cur.byType.other - prev.byType.other),
    },
  };
}

/**
 * Roll window WALL-CLOCK (DESIGN §4.2): push entry rồi evict bucket có `ts < now - E2_WINDOW_MS`
 * (age > 60s — không đếm số bucket) + safety cap `max`. PURE — không mutate input.
 */
export function rollWindow(
  buckets: ConnectWindowBucket[],
  ts: number,
  attempts: number,
  fails: number,
  byType: ConnectFailsByType,
  max = E2_MAX_BUCKETS,
): ConnectWindowBucket[] {
  const next = [...buckets, { ts, attempts, fails, byType }];
  const cutoff = ts - E2_WINDOW_MS;
  while (next.length && next[0].ts < cutoff) next.shift();
  while (next.length > max) next.shift();
  return next;
}

/** Sum toàn bộ bucket — bất biến: sum 4 loại byType == fails (SEC-1: log/dashboard dùng chung 1 mẫu số). */
export function sumWindow(buckets: ConnectWindowBucket[]): ConnectCountersSnapshot {
  let attempts = 0;
  let fails = 0;
  const byType = { ...EMPTY_CONNECT_FAILS };
  for (const b of buckets) {
    attempts += b.attempts;
    fails += b.fails;
    byType.timeout += b.byType.timeout;
    byType.transport += b.byType.transport;
    byType.reject += b.byType.reject;
    byType.other += b.byType.other;
  }
  return { attempts, fails, byType };
}

/** Span THẬT của window (BE-3 — log windowSec không hardcode 60). Rỗng → 0; clamp [0, 120]. */
export function windowSpanSecs(buckets: ConnectWindowBucket[], now: number): number {
  if (!buckets.length) return 0;
  return Math.min(120, Math.max(0, Math.round((now - buckets[0].ts) / 1000)));
}

/** Rate E2 từ window: 0 khi chưa đủ mẫu (AC-3 — window < 50 attempts không evaluate). */
export function connectFailRateFromWindow(attempts: number, fails: number, minAttempts = E2_MIN_ATTEMPTS): number {
  return attempts >= minAttempts ? (fails / attempts) * 100 : 0;
}

/** Pha cuối dựa trên cách run kết thúc: natural → finished, auto lỗi → error, manual → stopped. */
export function endPhaseFromStop(
  kind: 'natural' | 'auto' | 'manual',
  reason?: string,
): { phase: RunPhase; stopReason?: string } {
  if (kind === 'natural') return { phase: 'finished', stopReason: reason };
  if (kind === 'manual') return { phase: 'stopped', stopReason: reason ?? 'run bị dừng thủ công (kill-switch)' };
  return { phase: 'error', stopReason: reason ?? 'run tự dừng do lỗi' };
}

/** Gộp N worker tick → LoadTestTick 1s (DB-1 aggregation). */
export interface AggregatedTick {
  tick: LoadTestTick;
  /** Histogram gộp theo action (dùng cho report). */
  perActionHistograms: Record<string, number[]>;
  /** Kết quả ok/fail theo action (cumulative — report AC6.1). */
  actionOk: Partial<Record<ActionType, number>>;
  actionFail: Partial<Record<ActionType, number>>;
  /** Error samples gần nhất (tối đa 20). */
  errorSamples: ErrorSample[];
}

export function aggregateTicks(runId: string, ts: number, elapsedSec: number, phase: RunPhase, ticks: WorkerTick[], _prev?: AggregatedTick): AggregatedTick {
  const C = {
    usersCreated: 0, usersConnected: 0, usersActive: 0, usersQueued: 0, usersInRoom: 0,
    actionsTotal: 0, successTotal: 0, failTotal: 0, echoOk: 0, echoSent: 0,
    droppedOutbox: 0, reconnectCount: 0, rateLimitedNoEcho: 0,
    connectAttempts: 0, connectFails: 0, usersFailed: 0,
    connectFailsByType: { ...EMPTY_CONNECT_FAILS },
  };
  const actionsPerSec: Partial<Record<ActionType, number>> = {};
  const actionOk: Partial<Record<ActionType, number>> = {};
  const actionFail: Partial<Record<ActionType, number>> = {};
  const errors: Record<string, number> = {};
  const histograms: Record<string, number[]> = {};
  let histBucketCount = 0;
  let cpuSum = 0;
  let cpuN = 0;
  let errorSamples: ErrorSample[] = [];

  for (const t of ticks) {
    C.usersCreated += t.counters.usersCreated;
    C.usersConnected += t.counters.usersConnected;
    C.usersActive += t.counters.usersActive;
    C.usersQueued += t.counters.usersQueued;
    C.usersInRoom += t.counters.usersInRoom;
    C.actionsTotal += t.counters.actionsTotal;
    C.successTotal += t.counters.successTotal;
    C.failTotal += t.counters.failTotal;
    C.echoOk += t.counters.echoOk;
    C.echoSent += t.counters.echoSent;
    C.droppedOutbox += t.counters.droppedOutbox;
    C.reconnectCount += t.counters.reconnectCount;
    C.rateLimitedNoEcho += t.counters.rateLimitedNoEcho;
    // Connect metrics (DESIGN §2) — cumulative per-worker, sum tick mới nhất (BE-2)
    C.connectAttempts += t.counters.connectAttempts;
    C.connectFails += t.counters.connectFails;
    C.usersFailed += t.counters.usersFailed;
    C.connectFailsByType.timeout += t.counters.connectFailsByType.timeout;
    C.connectFailsByType.transport += t.counters.connectFailsByType.transport;
    C.connectFailsByType.reject += t.counters.connectFailsByType.reject;
    C.connectFailsByType.other += t.counters.connectFailsByType.other;

    for (const action of ACTION_TYPES) {
      const v = t.actionsPerSec[action];
      if (v) actionsPerSec[action] = (actionsPerSec[action] ?? 0) + v;
    }
    for (const action of ACTION_TYPES) {
      const ok = t.actionOk?.[action];
      if (ok) actionOk[action] = (actionOk[action] ?? 0) + ok;
      const fail = t.actionFail?.[action];
      if (fail) actionFail[action] = (actionFail[action] ?? 0) + fail;
    }
    for (const [code, count] of Object.entries(t.errors)) errors[code] = (errors[code] ?? 0) + count;
    if (t.histograms) {
      for (const [action, buckets] of Object.entries(t.histograms)) {
        const target = (histograms[action] ??= new Array(t.histogramBucketCount || 0).fill(0));
        for (let i = 0; i < Math.min(buckets.length, target.length); i++) target[i] += buckets[i];
      }
      histBucketCount = Math.max(histBucketCount, t.histogramBucketCount);
    }
    if (t.cpuPct > 0) {
      cpuSum += t.cpuPct;
      cpuN++;
    }
    if (t.errorSamples?.length) {
      errorSamples = [...t.errorSamples, ...errorSamples].slice(0, 20);
    }
  }

  // Latency tổng từ histogram gộp (P50/P95/P99 toàn run — UI-SPEC tick.latency).
  const totalHist = new BucketedHistogram();
  for (const buckets of Object.values(histograms)) totalHist.merge({ buckets });
  const q = totalHist.quantiles();

  const successTotal = C.successTotal + C.failTotal;
  const echoTotal = C.echoSent;

  const topErrors = Object.entries(errors)
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const tick: LoadTestTick = {
    type: 'tick',
    runId,
    ts,
    phase,
    elapsedSec,
    counters: {
      usersCreated: C.usersCreated,
      usersConnected: C.usersConnected,
      usersActive: C.usersActive,
      usersQueued: C.usersQueued,
      usersInRoom: C.usersInRoom,
      actionsTotal: C.actionsTotal,
      successTotal: C.successTotal,
      failTotal: C.failTotal,
      echoOk: C.echoOk,
      echoSent: C.echoSent,
      queueCount: 0, // coordinator bổ sung từ Redis (bên ngoài — vì pure)
      roomCount: Math.round(C.usersInRoom / 6),
      droppedOutbox: C.droppedOutbox,
      reconnectCount: C.reconnectCount,
      rateLimitedNoEcho: C.rateLimitedNoEcho,
      connectAttempts: C.connectAttempts,
      connectFails: C.connectFails,
      connectFailsByType: C.connectFailsByType,
      usersFailed: C.usersFailed,
    },
    rates: {
      successRate: successTotal > 0 ? Math.round((C.successTotal / successTotal) * 1000) / 10 : 100,
      echoRate: echoTotal > 0 ? Math.round((C.echoOk / echoTotal) * 1000) / 10 : 100,
      // Window 60s — coordinator (T5) override TRƯỚC pushTick; 0 = chưa đủ mẫu (DESIGN §4).
      connectFailRate: 0,
    },
    actionsPerSec,
    latency: { p50: q.p50, p95: q.p95, p99: q.p99 },
    errors: topErrors,
    server: { wsConnections: 0, wsMessagesEmitted: 0, wsMessagesPerSec: 0 },
    workers: { alive: ticks.length, total: ticks.length, cpuAvg: cpuN > 0 ? Math.round(cpuSum / cpuN) : 0 },
    hasConnectData: true, // tick LIVE (DESIGN §2.1 — replay đặt false ở toMetricTick)
  };

  return { tick, perActionHistograms: histograms, actionOk, actionFail, errorSamples };
}

/** Tính throughput peak từ chuỗi tick (dùng report). */
export function peakThroughput(actionsPerSecSeries: number[]): number {
  return actionsPerSecSeries.reduce((m, v) => Math.max(m, v), 0);
}
