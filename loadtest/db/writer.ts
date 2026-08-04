/**
 * MAYogu LoadTest Tool — ghi DB (Run / MetricSample / LogEvent / Pool) từ coordinator.
 *
 * Single-writer: chỉ coordinator ghi (PRD §2.4). Best-effort: DB lỗi → cảnh báo, KHÔNG làm chết run.
 * - MetricSample: batch insert mỗi ~30s (hoặc 500 tick) + flush cuối lúc finishRun (PRD §2.4).
 * - LogEvent: subscribe vào logger (util.ts) — log trong lúc run chạy được gắn đúng runId.
 * - Crash-detect (PRD B3): startup đánh dấu run `running` còn sót → `error`.
 * - Import legacy pool JSON (PRD B2): quét dataDir/accounts-*.json, idempotent, giữ file gốc.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LoadTestTick, RunConfig } from '../types';
import { ltLog, normalizeUrl, subscribeLog } from '../util';
import type { ProvisionSummary } from '../auth-factory';
import { LoadtestStore, type MetricSampleRow, type PoolRow } from './store';

const FLUSH_INTERVAL_MS = 30_000; // batch insert mỗi ~30s
const MAX_PENDING_TICKS = 500; // hoặc flush khi đủ 500 tick

export class DbWriter {
  private store: LoadtestStore;
  private dataDir: string;
  private currentRunId: string | null = null;
  private startAt = 0;
  private pendingTicks: MetricSampleRow[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private unsubscribeLog: (() => void) | null = null;

  constructor(store: LoadtestStore, dataDir: string) {
    this.store = store;
    this.dataDir = dataDir;
  }

  /** Startup: ensure schema + crash-detect + import legacy pool JSON + subscribe log (DB disabled → bỏ qua). */
  async startup(): Promise<void> {
    if (!this.store.enabled) {
      ltLog.warn('[lt][db] DB disabled — bỏ qua startup tasks (crash-detect, import pool)');
      return;
    }
    await this.store.ensureSchema();
    const machineId = os.hostname();
    const crashed = await this.store.markRunsRunningAsError(machineId, 'crash-detect: server khởi động lại khi run đang chạy');
    if (crashed > 0) ltLog.warn(`[lt][db] crash-detect: ${crashed} run còn sót status=running → đánh dấu error`);
    await this.importLegacyPools();
    this.unsubscribeLog = subscribeLog((level, msg) => void this.writeLog(level, msg));
  }

  async shutdown(): Promise<void> {
    if (this.unsubscribeLog) {
      this.unsubscribeLog();
      this.unsubscribeLog = null;
    }
    this.stopFlushTimer();
    await this.flushTicks();
    await this.store.disconnect();
  }

  // ─── Run ─────────────────────────────────────────────────────────────────

  async writeRunStart(config: RunConfig): Promise<void> {
    this.currentRunId = config.runId;
    this.startAt = Date.now();
    await this.store.insertRun({
      runId: config.runId,
      status: 'running',
      machineId: os.hostname(),
      startAt: this.startAt,
      gatewayUrl: config.gatewayUrl,
      targetUsers: config.targetUsers,
      workerCount: config.workerCount,
      configJson: JSON.stringify(config),
    });
    this.startFlushTimer();
  }

  async writeRunFinish(
    runId: string,
    status: 'finished' | 'stopped' | 'error',
    stopReason: string | null,
    report: unknown,
    endAt: number,
  ): Promise<void> {
    await this.flushTicks();
    this.stopFlushTimer();
    if (this.currentRunId === runId) this.currentRunId = null;
    const durationSec = this.startAt > 0 ? Math.max(0, Math.round((endAt - this.startAt) / 1000)) : null;
    await this.store.finalizeRun(runId, {
      status,
      stopReason,
      summaryJson: report ? JSON.stringify(report) : null,
      endAt,
      durationSec,
    });
  }

  // ─── MetricSample ────────────────────────────────────────────────────────

  pushTick(tick: LoadTestTick): void {
    if (!this.currentRunId) return;
    this.pendingTicks.push(toMetricSample(this.currentRunId, tick));
    if (this.pendingTicks.length >= MAX_PENDING_TICKS) void this.flushTicks();
  }

  async flushTicks(): Promise<void> {
    if (this.flushing || !this.pendingTicks.length) return;
    this.flushing = true;
    const batch = this.pendingTicks;
    this.pendingTicks = [];
    try {
      await this.store.insertMetricSamples(batch);
    } finally {
      this.flushing = false;
    }
  }

  private startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => void this.flushTicks(), FLUSH_INTERVAL_MS);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ─── LogEvent ────────────────────────────────────────────────────────────

  async writeLog(level: string, msg: string): Promise<void> {
    if (!this.currentRunId) return;
    await this.store.insertLogEvent(this.currentRunId, level, msg);
  }

  // ─── Pool + PoolAccount ──────────────────────────────────────────────────

  /**
   * Ghi pool + per-account outcome sau khi provisioning xong (PRD B1).
   * - pool_id = runId hiện tại (pool tạo bởi run này).
   * - summary.results = per-account outcome (registered/logged_in/failed + errorCode) — giải bug §1.9.
   * - Reuse: cập nhật thêm pool nguồn (reusedByRunIdsJson + trạng thái từng account).
   */
  async writePool(config: RunConfig, summary: ProvisionSummary): Promise<void> {
    const poolId = config.runId;
    const gatewayUrl = normalizeUrl(config.gatewayUrl);
    const now = Date.now();
    const sourceRunId = summary.poolSourceRunId ?? null;

    await this.store.upsertPool({
      poolId,
      gatewayUrl,
      targetUsers: config.targetUsers,
      accountCount: summary.accounts.length,
      registered: summary.registered,
      loggedIn: summary.loggedIn,
      failed: summary.failed,
      errorsJson: JSON.stringify(summary.errors),
      reusedByRunIdsJson: '[]',
      createdAt: now,
    });

    const results = summary.results ?? [];
    if (results.length) {
      await this.store.insertPoolAccounts(
        results.map((a) => ({
          poolId,
          email: a.email,
          password: a.password,
          userId: a.userId,
          displayName: a.displayName,
          deviceInfo: a.deviceInfo,
          dateOfBirth: a.dateOfBirth,
          country: a.country,
          registeredAt: a.status === 'registered' ? a.registeredAt : null,
          status: a.status,
          lastErrorCode: a.lastErrorCode,
          lastUsedRunId: a.status === 'logged_in' ? config.runId : null,
          lastLoginAt: a.lastLoginAt,
        })),
      );
    }

    // Reuse: cập nhật pool nguồn (reusedByRunIds + per-account login outcome)
    if (sourceRunId && sourceRunId !== poolId) {
      const src = await this.store.getPool(sourceRunId);
      if (src) {
        const reused = safeParseArray(src.reusedByRunIdsJson);
        if (!reused.includes(poolId)) reused.push(poolId);
        await this.store.upsertPool({
          ...fromPoolRow(src),
          loggedIn: summary.loggedIn,
          failed: summary.failed,
          errorsJson: JSON.stringify(summary.errors),
          reusedByRunIdsJson: JSON.stringify(reused),
        });
      }
      for (const a of results) {
        await this.store.updatePoolAccount(sourceRunId, a.email, {
          status: a.status,
          lastErrorCode: a.lastErrorCode,
          lastUsedRunId: a.status === 'logged_in' ? config.runId : null,
          lastLoginAt: a.lastLoginAt,
        });
      }
    }
  }

  // ─── Import legacy pool JSON (PRD B2 / US-7) ─────────────────────────────

  async importLegacyPools(): Promise<void> {
    if (!fs.existsSync(this.dataDir)) return;
    const files = fs
      .readdirSync(this.dataDir)
      .filter((f) => /^accounts-.+\.json$/.test(f))
      .sort();
    for (const f of files) {
      const filePath = path.join(this.dataDir, f);
      try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
          runId?: string;
          targetUsers?: number;
          gatewayUrl?: string;
          accounts?: Array<{
            email: string;
            password: string;
            userId?: string;
            displayName?: string;
            deviceInfo?: unknown;
            dateOfBirth?: string;
            country?: string;
            registeredAt?: number | null;
          }>;
        };
        const poolId = parsed.runId ?? f.replace(/^accounts-/, '').replace(/\.json$/, '');
        if (!poolId) continue;
        const existing = await this.store.getPool(poolId);
        if (existing) {
          ltLog.info(`[lt][db] pool ${poolId} đã import — bỏ qua (idempotent)`);
          continue;
        }
        const accounts = parsed.accounts ?? [];
        await this.store.upsertPool({
          poolId,
          gatewayUrl: normalizeUrl(parsed.gatewayUrl ?? ''),
          targetUsers: parsed.targetUsers ?? 0,
          accountCount: accounts.length,
          registered: accounts.length,
          loggedIn: 0,
          failed: 0,
          errorsJson: '{}',
          reusedByRunIdsJson: '[]',
          importedFromFile: filePath,
          createdAt: fs.statSync(filePath).mtimeMs,
        });
        if (accounts.length) {
          await this.store.insertPoolAccounts(
            accounts.map((a) => ({
              poolId,
              email: a.email,
              password: a.password,
              userId: a.userId ?? '',
              displayName: a.displayName ?? '',
              deviceInfo: a.deviceInfo ?? {},
              dateOfBirth: a.dateOfBirth ?? '',
              country: a.country ?? 'VN',
              registeredAt: a.registeredAt ?? null,
              status: 'registered',
            })),
          );
        }
        ltLog.info(`[lt][db] imported pool ${poolId}: ${accounts.length} accounts (${filePath})`);
      } catch (err) {
        ltLog.warn(`[lt][db] bỏ qua pool file hỏng ${f}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}

// ─── Mapping helpers ────────────────────────────────────────────────────────

function toMetricSample(runId: string, t: LoadTestTick): MetricSampleRow {
  return {
    runId,
    ts: t.ts,
    phase: t.phase,
    elapsedSec: t.elapsedSec,
    usersCreated: t.counters.usersCreated,
    usersConnected: t.counters.usersConnected,
    usersActive: t.counters.usersActive,
    usersQueued: t.counters.usersQueued,
    usersInRoom: t.counters.usersInRoom,
    actionsTotal: t.counters.actionsTotal,
    successTotal: t.counters.successTotal,
    failTotal: t.counters.failTotal,
    echoOk: t.counters.echoOk,
    echoSent: t.counters.echoSent,
    queueCount: t.counters.queueCount,
    roomCount: t.counters.roomCount,
    droppedOutbox: t.counters.droppedOutbox,
    reconnectCount: t.counters.reconnectCount,
    rateLimitedNoEcho: t.counters.rateLimitedNoEcho,
    successRate: t.rates.successRate,
    echoRate: t.rates.echoRate,
    actionsPerSecJson: JSON.stringify(t.actionsPerSec),
    latencyJson: JSON.stringify(t.latency),
    errorsJson: JSON.stringify(t.errors),
    serverJson: JSON.stringify(t.server),
    workersJson: JSON.stringify(t.workers),
  };
}

function safeParseArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function fromPoolRow(row: PoolRow): {
  poolId: string;
  gatewayUrl: string;
  targetUsers: number;
  accountCount: number;
  registered: number;
  loggedIn: number;
  failed: number;
  errorsJson: string;
  reusedByRunIdsJson: string;
  importedFromFile: string | null;
  createdAt: number;
} {
  return {
    poolId: row.poolId,
    gatewayUrl: row.gatewayUrl,
    targetUsers: row.targetUsers,
    accountCount: row.accountCount,
    registered: row.registered,
    loggedIn: row.loggedIn,
    failed: row.failed,
    errorsJson: row.errorsJson,
    reusedByRunIdsJson: row.reusedByRunIdsJson,
    importedFromFile: row.importedFromFile,
    createdAt: row.createdAt,
  };
}