/**
 * MAYogu LoadTest Tool — mapping helpers thuần (T-06, S-6): DB row → API contract.
 * Tách khỏi api-server.ts (giảm god class). Giữ nguyên shape response (UI-SPEC / API-loadtest-tool).
 */

import type { MetricSampleRow, RunRow } from './db/store';

export function toRunSummary(row: RunRow) {
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
    },
    rates: { successRate: row.successRate, echoRate: row.echoRate },
    actionsPerSec: parse(row.actionsPerSecJson, {}),
    latency: parse(row.latencyJson, { p50: 0, p95: 0, p99: 0 }),
    errors: parse(row.errorsJson, []),
    server: parse(row.serverJson, {}),
    workers: parse(row.workersJson, {}),
  };
}