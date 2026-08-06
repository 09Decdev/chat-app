/**
 * MAYogu LoadTest Tool — mapping helpers thuần (T-06, S-6): DB row → API contract.
 * Tách khỏi api-server.ts (giảm god class). Giữ nguyên shape response (UI-SPEC / API-loadtest-tool).
 */

import type { MetricSampleRow, RunRow } from './db/store';

export function toRunSummary(row: RunRow) {
  // F4: parse sub-object summary (cho trend/compare) — KHÔNG trả full report (nặng).
  let summary: unknown = null;
  if (row.summaryJson) {
    try {
      const r = JSON.parse(row.summaryJson) as { summary?: unknown };
      summary = r?.summary ?? null;
    } catch {
      summary = null;
    }
  }
  return {
    runId: row.runId,
    status: row.status,
    machineId: row.machineId,
    startAt: row.startAt,
    endAt: row.endAt,
    durationSec: row.durationSec,
    gatewayUrl: row.gatewayUrl,
    targetUsers: row.targetUsers,
    workerCount: row.workerCount,
    stopReason: row.stopReason,
    poolSourceRunId: row.poolSourceRunId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    summary,
  };
}

export function toRunDetail(row: RunRow) {
  let config: unknown = null;
  let report: unknown = null;
  try {
    config = JSON.parse(row.configJson);
  } catch {
    config = null;
  }
  try {
    report = row.summaryJson ? JSON.parse(row.summaryJson) : null;
  } catch {
    report = null;
  }
  return { ...toRunSummary(row), config, report };
}

export function toMetricTick(row: MetricSampleRow) {
  const parse = (s: string, fallback: unknown): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return fallback;
    }
  };
  return {
    type: 'tick',
    runId: row.runId,
    ts: row.ts,
    phase: row.phase,
    elapsedSec: row.elapsedSec,
    counters: {
      usersCreated: row.usersCreated,
      usersConnected: row.usersConnected,
      usersActive: row.usersActive,
      usersQueued: row.usersQueued,
      usersInRoom: row.usersInRoom,
      actionsTotal: row.actionsTotal,
      successTotal: row.successTotal,
      failTotal: row.failTotal,
      echoOk: row.echoOk,
      echoSent: row.echoSent,
      queueCount: row.queueCount,
      roomCount: row.roomCount,
      droppedOutbox: row.droppedOutbox,
      reconnectCount: row.reconnectCount,
      rateLimitedNoEcho: row.rateLimitedNoEcho,
      connectAttempts: 0, // DB không có cột (R1 — MVP chưa persist, DESIGN §8)
      connectFails: 0,
      connectFailsByType: { timeout: 0, transport: 0, reject: 0, other: 0 },
      usersFailed: 0,
      // Các field dưới KHÔNG được persist (MVP — toMetricSample không có cột) — default 0 để
      // replay không vỡ type contract: LiveDashboardPage chia reconnectTotalMs/reconcileCount
      // → NaN nếu undefined; workers.rssAvgMb cũng cần default cho run cũ.
      reconcileCount: 0,
      reconnectTotalMs: 0,
      reconnectMaxMs: 0,
      usersLost: 0,
    },
    rates: { successRate: row.successRate, echoRate: row.echoRate, connectFailRate: 0 },
    actionsPerSec: parse(row.actionsPerSecJson, {}),
    latency: parse(row.latencyJson, { p50: 0, p95: 0, p99: 0 }),
    errors: parse(row.errorsJson, []),
    errorsByStage: {}, // không persist trên tick 1s — chỉ aggregate ở report
    server: { wsConnections: 0, wsMessagesEmitted: 0, wsMessagesPerSec: 0, ...(parse(row.serverJson, {}) as object) },
    workers: { alive: 0, total: 0, cpuAvg: 0, rssAvgMb: 0, ...(parse(row.workersJson, {}) as object) },
    hasConnectData: false, // replay — UI phân biệt "không persist" vs "thật 0" (DESIGN §2.1, UI-1)
  };
}