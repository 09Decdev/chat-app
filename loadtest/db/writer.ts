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
import { toEpochMs } from './int';
import type { ProvisionSummary } from '../auth-factory';
import { LoadtestStore, type MetricSampleRow, type PoolRow } from './store';

const FLUSH_INTERVAL_MS = 30_000; // batch insert mỗi ~30s
const MAX_PENDING_TICKS = 500; // hoặc flush khi đủ 500 tick
/** F-1: khi DB log write fail, suppress mọi DB log write trong window này (chống loop tự khuếch đại). */
const LOG_SUPPRESS_WINDOW_MS = 5000;

export class DbWriter {
  private store: LoadtestStore;
  private dataDir: string;
  private currentRunId: string | null = null;
  private startAt = 0;
  private pendingTicks: MetricSampleRow[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  /** FIX-8 (C-5): promise của flush đang in-flight — final flush AWAIT nó thay vì skip (pool.end() race). */
  private flushPromise: Promise<void> | null = null;
  private unsubscribeLog: (() => void) | null = null;
  /** B-2 (T-06): finalize barrier — shutdown() await finalizePromise TRƯỚC pool.end(). */
  private finalizePromise: Promise<void> | null = null;
  /** F-1: guard reentrancy — log write đang chạy thì bỏ qua log mới (lỗi DB → warn → subscriber → insert mới → loop). */
  private isWritingLog = false;
  /** F-1: hết hạn suppress DB log write (ms epoch) — sau 1 fail, chờ window rồi mới thử lại. */
  private logSuppressUntil = 0;
  /** F-1: số log bị bỏ qua trong window suppress (đếm 1 lần, không spam DB). */
  private suppressedLogCount = 0;

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
    if (crashed.ok && crashed.rows.length > 0) {
      ltLog.warn(`[lt][db] crash-detect: ${crashed.rows.length} run còn sót status=running → đánh dấu error`);
    }
    await this.importLegacyPools();
    this.unsubscribeLog = subscribeLog((level, msg) => void this.writeLog(level, msg));
  }

  async shutdown(): Promise<void> {
    if (this.unsubscribeLog) {
      this.unsubscribeLog();
      this.unsubscribeLog = null;
    }
    // B-2: chờ finalize runner TRƯỚC pool.end() — không drop UPDATE đang bay.
    if (this.finalizePromise) await this.finalizePromise;
    this.stopFlushTimer();
    await this.flushTicks();
    await this.store.disconnect();
  }

  // ─── Run ─────────────────────────────────────────────────────────────────

  async writeRunStart(config: RunConfig): Promise<void> {
    this.currentRunId = config.runId;
    this.startAt = Date.now();
    const r = await this.store.insertRun({
      runId: config.runId,
      status: 'running',
      machineId: os.hostname(),
      startAt: this.startAt,
      gatewayUrl: config.gatewayUrl,
      targetUsers: config.targetUsers,
      workerCount: config.workerCount,
      configJson: JSON.stringify(config),
    });
    if (!r.ok) ltLog.warn(`[lt][db] writeRunStart fail (runId=${config.runId}): ${r.error.message}`);
    this.startFlushTimer();
  }

  async writeRunFinish(
    runId: string,
    status: 'finished' | 'stopped' | 'error',
    stopReason: string | null,
    report: unknown,
    endAt: number,
  ): Promise<void> {
    // B-2: finalize barrier — track promise để shutdown() await trước pool.end().
    const p = this.doWriteRunFinish(runId, status, stopReason, report, endAt);
    this.finalizePromise = p;
    await p;
    if (this.finalizePromise === p) this.finalizePromise = null;
  }

  private async doWriteRunFinish(
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
    const r = await this.store.finalizeRun(runId, {
      status,
      stopReason,
      summaryJson: report ? JSON.stringify(report) : null,
      endAt,
      durationSec,
    });
    if (!r.ok) ltLog.warn(`[lt][db] finalizeRun fail (runId=${runId}): ${r.error.message}`);
  }

  // ─── MetricSample ────────────────────────────────────────────────────────

  pushTick(tick: LoadTestTick): void {
    if (!this.currentRunId) return;
    this.pendingTicks.push(toMetricSample(this.currentRunId, tick));
    if (this.pendingTicks.length >= MAX_PENDING_TICKS) void this.flushTicks();
  }

  async flushTicks(): Promise<void> {
    // FIX-8 (C-5): timer flush đang in-flight → AWAIT nó trước, rồi flush phần còn lại.
    // Trước đây `if (this.flushing) return` làm final flush bị SKIP → pool.end() (shutdown)
    // đóng DB giữa chừng flush đang bay → mất ticks cuối cùng (double-fault).
    if (this.flushing && this.flushPromise) await this.flushPromise;
    if (!this.pendingTicks.length) return;
    this.flushing = true;
    const p = this.doFlushTicks().finally(() => {
      this.flushing = false;
      this.flushPromise = null;
    });
    this.flushPromise = p;
    await p;
  }

  private async doFlushTicks(): Promise<void> {
    const batch = this.pendingTicks;
    this.pendingTicks = [];
    try {
      const r = await this.store.insertMetricSamples(batch);
      if (!r.ok) {
        // DB hồi phục → flush timer (30s) retry; đưa batch về đầu hàng đợi (B-5).
        this.pendingTicks = [...batch, ...this.pendingTicks];
        const cap = MAX_PENDING_TICKS * 2;
        if (this.pendingTicks.length > cap) {
          // DB chết lâu — vượt trần: drop batch cũ nhất + log cảnh báo.
          // KHÔNG đếm dbWriteFail ở đây — store.query() đã đếm đúng 1 lần cho chính
          // failure này (FIX-8, T-05): đếm thêm = double-count cùng 1 lỗi.
          const dropped = this.pendingTicks.length - cap;
          this.pendingTicks = this.pendingTicks.slice(this.pendingTicks.length - cap);
          ltLog.warn(`[lt][db] flushTicks fail — drop ${dropped} tick cũ nhất (pending > ${cap}): ${r.error.message}`);
        } else {
          ltLog.warn(`[lt][db] flushTicks fail (${r.error.message}) — ${batch.length} tick chờ retry (${this.pendingTicks.length})`);
        }
      }
    } finally {
      // flushing/finishPromise được reset ở flushTicks() (await in-flight xong mới reset)
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
    // F-1 (reentrancy guard TRÊN đường WRITE): insertLogEvent fail → store warn → subscriber
    // → writeLog mới → insert mới → warn mới → ... loop vô hạn khi DB down.
    // Guard này chặn ngay lần re-enter ĐẦU TIÊN (isWritingLog) + suppress window chặn spam sau đó.
    if (this.isWritingLog) return;
    if (Date.now() < this.logSuppressUntil) {
      this.suppressedLogCount++;
      return;
    }
    this.isWritingLog = true;
    try {
      const r = await this.store.insertLogEvent(this.currentRunId, level, msg);
      if (!r.ok) {
        // Suppress DB log write 5s — chỉ đếm dbWriteFail 1 lần cho chính fail này (store.query đã đếm).
        this.logSuppressUntil = Date.now() + LOG_SUPPRESS_WINDOW_MS;
        const suppressed = this.suppressedLogCount;
        this.suppressedLogCount = 0;
        ltLog.warn(
          `[lt][db] insertLogEvent fail (runId=${this.currentRunId}): ${r.error.message}` +
            ` — suppress DB log ${LOG_SUPPRESS_WINDOW_MS / 1000}s (${suppressed} log khác bị bỏ qua lần trước)`,
        );
      }
    } finally {
      this.isWritingLog = false;
    }
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

    const up = await this.store.upsertPool({
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
    if (!up.ok) ltLog.warn(`[lt][db] upsertPool fail (runId=${poolId}): ${up.error.message}`);

    const results = summary.results ?? [];
    if (results.length) {
      const ins = await this.store.insertPoolAccounts(
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
      if (!ins.ok) ltLog.warn(`[lt][db] insertPoolAccounts fail (runId=${poolId}): ${ins.error.message}`);
    }

    // Reuse: cập nhật pool nguồn (reusedByRunIds + per-account login outcome)
    if (sourceRunId && sourceRunId !== poolId) {
      const src = await this.store.getPool(sourceRunId);
      if (!src.ok) {
        ltLog.warn(`[lt][db] getPool fail (${sourceRunId}): ${src.error.message}`);
      } else if (src.rows[0]) {
        const reused = safeParseArray(src.rows[0].reusedByRunIdsJson);
        if (!reused.includes(poolId)) reused.push(poolId);
        const up2 = await this.store.upsertPool({
          ...fromPoolRow(src.rows[0]),
          loggedIn: summary.loggedIn,
          failed: summary.failed,
          errorsJson: JSON.stringify(summary.errors),
          reusedByRunIdsJson: JSON.stringify(reused),
        });
        if (!up2.ok) ltLog.warn(`[lt][db] upsertPool fail (source=${sourceRunId}): ${up2.error.message}`);
      }
      for (const a of results) {
        const upd = await this.store.updatePoolAccount(sourceRunId, a.email, {
          status: a.status,
          lastErrorCode: a.lastErrorCode,
          lastUsedRunId: a.status === 'logged_in' ? config.runId : null,
          lastLoginAt: a.lastLoginAt,
        });
        if (!upd.ok) ltLog.warn(`[lt][db] updatePoolAccount fail (${sourceRunId}/${a.email}): ${upd.error.message}`);
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
        if (!existing.ok) {
          ltLog.warn(`[lt][db] getPool fail (${poolId}): ${existing.error.message}`);
          continue;
        }
        if (existing.rows.length > 0) {
          ltLog.info(`[lt][db] pool ${poolId} đã import — bỏ qua (idempotent)`);
          continue;
        }
        const accounts = parsed.accounts ?? [];
        const up = await this.store.upsertPool({
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
          // D-5: mtimeMs là float — MUST trunc thành integer trước khi insert vào created_at BIGINT.
          createdAt: toEpochMs(fs.statSync(filePath).mtimeMs) ?? 0,
        });
        if (!up.ok) ltLog.warn(`[lt][db] upsertPool fail (${poolId}): ${up.error.message}`);
        if (accounts.length) {
          const ins = await this.store.insertPoolAccounts(
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
          if (!ins.ok) ltLog.warn(`[lt][db] insertPoolAccounts fail (${poolId}): ${ins.error.message}`);
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