/**
 * MAYogu LoadTest Tool — Coordinator (CP-2..CP-5, SE-4, DB-1, DB-3):
 * - Vòng đời run: IDLE → PROVISIONING → RAMPING → STEADY → COOLDOWN → REPORT → FINISHED.
 * - Auth Factory (provision) → Worker Farm → aggregate tick 1s → auto-stop → report.
 * - Poll queue-count (Redis server-side qua REST) + scrape gateway /metrics 5s (DB-3).
 * - Ring buffer tick 3600 cho dashboard/report.
 */

import Redis from 'ioredis';
import type { LoadTestEnv } from './config';
import { buildRunConfig, mergedAllowlist } from './config';
import type { LoadTestTick, RunConfig, RunPhase, StartRunRequest, TestAccount, WorkerMessage, WorkerTick } from './types';
import { ACTION_TYPES } from './types';
import { WorkerFarm } from './worker-farm';
import { createRedis, provisionAccounts } from './auth-factory';
import { aggregateTicks, decideAutoStop, endPhaseFromStop, transition, type AggregatedTick } from './coordinator-state';
import { ActionHistograms } from './metrics';
import { RestDriver } from './rest-actions';
import { buildReport } from './report';
import { saveReportFiles } from './report';
import { ltLog, normalizeUrl, setVerbose, redactUrl } from './util';
import { toolMetrics } from './tool-metrics';
import type { DbWriter } from './db/writer';

const TICK_HISTORY_LIMIT = 3600; // 1h @1s (UI-SPEC §4.1)
const COOLDOWN_WAIT_MS = 10_000; // chờ worker done tối đa
const WORKER_RESTART_BACKOFF_MS = 2000;
/** C-2: worker không tick trong N ms = chết im lặng (treo event loop) — 5 tick @1s, khớp farm.checkHeartbeats default. */
const WORKER_HEARTBEAT_STALE_MS = 5000;

export interface CoordinatorEvents {
  onPhaseChange?: (phase: RunPhase) => void;
}

export class LoadTestCoordinator {
  phase: RunPhase = 'idle';
  config: RunConfig | null = null;
  runId = '';
  startAt = 0;
  lastTick: LoadTestTick | null = null;
  tickHistory: LoadTestTick[] = [];
  latestReport: ReturnType<typeof buildReport> | null = null;
  stopReason = '';

  private farm: WorkerFarm;
  private redis: Redis | null = null;
  private workerTicks = new Map<number, WorkerTick>();
  /** Histogram cumulative ĐÚNG: merge giá trị MỚI NHẤT từng worker (worker histogram là cumulative — merge theo thời gian sẽ phóng đại). */
  private workerHistograms = new Map<number, Partial<Record<string, number[]>>>();
  private cumulativeHistograms = new ActionHistograms();
  private cumulativeActionOk: Record<string, number> = {};
  private cumulativeActionFail: Record<string, number> = {};
  private aggregateTimer: NodeJS.Timeout | null = null;
  private scrapeTimer: NodeJS.Timeout | null = null;
  private queueTimer: NodeJS.Timeout | null = null;
  private metricsTimer: NodeJS.Timeout | null = null;
  /** Số lần NO_POST_FIXTURE (T-07/S-12) — feed trống, action read/view/comment/like bị bỏ qua. */
  private noPostFixtureCount = 0;
  private provisionSummary: { registered: number; loggedIn: number; failed: number; errors: Record<string, number> } = { registered: 0, loggedIn: 0, failed: 0, errors: {} };
  /** Progress provisioning realtime (dashboard tick PROVISIONING). */
  private provisionProgress = { done: 0, total: 0 };
  private workerDoneCount = 0;
  private workerDeathTimes: number[] = [];
  private serverMetrics = { wsConnections: 0, wsMessagesEmitted: 0, wsMessagesPerSec: 0, lastScrapeAt: 0 };
  private queueCount = 0;
  private restDriver: RestDriver | null = null;
  private accounts: TestAccount[] = [];
  private stopRequested: 'manual' | 'kill' | null = null;
  private finishing = false;
  /** B-2 (T-06 FIX-9): promise của finishRun đang in-flight — stop()/shutdown() await để không drop finalize. */
  private finishPromise: Promise<void> | null = null;
  private maxConnected = 0;
  private maxActive = 0;
  private maxQueue = 0;
  private peakActionsPerSec = 0;
  private actionsPerSecSeries: number[] = [];
  /** C-2: số restart đang chờ backoff — E3 "toàn bộ worker chết" phải trừ đi để không auto-stop nhầm khi restart đang bay. */
  private pendingRestarts = 0;

  constructor(
    private env: LoadTestEnv,
    private events: CoordinatorEvents = {},
    private dbWriter?: DbWriter,
  ) {
    this.farm = new WorkerFarm({
      onTick: (workerId, msg) => this.onWorkerMessage(workerId, msg),
      onWorkerDied: (workerId) => this.handleWorkerDied(workerId),
      onWorkerRestarted: (workerId) => ltLog.info(`coordinator: worker#${workerId} restarted`),
    });
  }

  /**
   * C-1: worker chết — E3 restart worker crash + prune tick. Tách method để test được.
   * C-2: prune workerTicks/workerHistograms NGAY khi worker chết (trước đây tick cũ cộng dồn mãi mãi).
   */
  private handleWorkerDied(workerId: number) {
    this.workerDeathTimes.push(Date.now());
    const cutoff = Date.now() - 60_000;
    while (this.workerDeathTimes.length && this.workerDeathTimes[0] < cutoff) this.workerDeathTimes.shift();
    this.workerTicks.delete(workerId);
    this.workerHistograms.delete(workerId);
    ltLog.warn(`coordinator: worker#${workerId} died`);
    // E3: tự restart worker crash (trừ khi đang stop/finish)
    if (this.isRunning && !this.finishing && this.phase !== 'cooldown') {
      this.pendingRestarts++;
      void this.farm.restart(workerId, WORKER_RESTART_BACKOFF_MS).catch((err) => {
        ltLog.error(`restart worker#${workerId} fail: ${String(err)}`);
      }).finally(() => {
        this.pendingRestarts--;
      });
    }
  }

  /**
   * C-1: cooldown/report cũng là "đang chạy" — worker cũ vẫn đang thoát + finalize DB.
   * Trước đây isRunning=false khi cooldown/report → start() mới spawn đè handle worker cũ
   * (orphan, không bao giờ bị killAll sau này) + `this.phase = phase` (finishRun cũ) clobber
   * phase run mới → transition throw → run mới chết + DB row kẹt 'running'.
   */
  get isRunning(): boolean {
    return ['provisioning', 'ramping', 'steady', 'cooldown', 'report'].includes(this.phase);
  }

  /** Số worker còn sống — health endpoint (T-07). */
  get workerAlive(): number {
    return this.farm.alive;
  }

  /** Redis có được cấu hình (LOADTEST_REDIS_URL) — health (T-07 FIX-2). Default localhost → luôn configured. */
  get redisConfigured(): boolean {
    return this.env.redisUrl !== '';
  }

  /**
   * Redis probe cho health — 'up' CHỈ khi đang kết nối và ping OK (FIX-2, không 'up' giả):
   * `this.redis === null` (idle/chưa kết nối) → không phải 'up'; configured → false, optional → true.
   */
  async redisHealth(): Promise<boolean> {
    if (!this.redis) return !this.redisConfigured;
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  /** T-07 FIX-2: kết nối Redis khi khởi động (best-effort) — health trung thực từ đầu (không 'down' giả khi idle). */
  async initRedis(): Promise<void> {
    if (!this.env.redisUrl) return;
    try {
      this.redis = createRedis(this.env);
      await this.redis.connect();
      ltLog.info('[lt] redis connected');
    } catch (err) {
      this.redis = null;
      ltLog.warn(`[lt] redis không kết nối được (${redactUrl(this.env.redisUrl)}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Mẫu lỗi gần nhất (bảng top errors — dashboard). */
  get errorSamples() {
    return this.errorSamplesPrivate;
  }
  private errorSamplesPrivate: WorkerTick['errorSamples'] = [];

  // ─── Control ───────────────────────────────────────────────────────────

  async start(req: StartRunRequest): Promise<{ ok: boolean; error?: string; config?: RunConfig }> {
    if (this.isRunning) return { ok: false, error: `Đang chạy (${this.phase}) — không thể start` };
    const config = buildRunConfig(req, this.env);
    // env guard (SD-1): double-check ngay tại coordinator — dùng merged allowlist (env + settings file)
    if (!mergedAllowlist(this.env).includes(normalizeUrl(config.gatewayUrl))) {
      return { ok: false, error: `Gateway ngoài allowlist: ${config.gatewayUrl}` };
    }
    if (this.phase !== 'idle') this.phase = 'idle'; // cho phép start lại sau finished/stopped/error
    this.config = config;
    this.runId = config.runId;
    this.phase = transition(this.phase, 'provisioning');
    this.events.onPhaseChange?.(this.phase);
    this.startAt = Date.now();
    this.resetRunState();
    this.stopReason = '';
    this.stopRequested = null;
    this.startTimers(); // tick provisioning progress ngay từ đầu (dashboard)
    // FK race fix: AWAIT insertRun TRƯỚC mọi log_events (runs row phải tồn tại
    // trước khi provisioning/log ghi DB — nếu không sẽ 23503 log_events_run_id_fkey).
    await this.dbWriter?.writeRunStart(this.config);

    ltLog.info(`=== run ${config.runId} start: target=${config.targetUsers} workers=${config.workerCount} duration=${config.durationMin}m gateway=${config.gatewayUrl} ===`, { runId: config.runId });
    void this.provisionAndLaunch();
    return { ok: true, config };
  }

  private resetRunState() {
    this.workerTicks.clear();
    this.workerHistograms.clear();
    this.cumulativeHistograms = new ActionHistograms();
    this.cumulativeActionOk = {};
    this.cumulativeActionFail = {};
    this.errorSamplesPrivate = [];
    this.tickHistory = [];
    this.lastTick = null;
    this.latestReport = null;
    this.workerDoneCount = 0;
    this.provisionSummary = { registered: 0, loggedIn: 0, failed: 0, errors: {} };
    this.provisionProgress = { done: 0, total: 0 };
    this.maxConnected = 0;
    this.maxActive = 0;
    this.maxQueue = 0;
    this.peakActionsPerSec = 0;
    this.actionsPerSecSeries = [];
    this.queueCount = 0;
    this.serverMetrics = { wsConnections: 0, wsMessagesEmitted: 0, wsMessagesPerSec: 0, lastScrapeAt: 0 };
    this.workerDeathTimes = []; // không reset → run sau E3 giả (worker chết run trước cộng dồn)
    this.noPostFixtureCount = 0;
  }

  private async provisionAndLaunch() {
    if (!this.config) return;
    try {
      // T-07 FIX-2: reuse connection đã mở ở initRedis (startup) — nếu chưa có, tạo mới.
      if (!this.redis) {
        this.redis = createRedis(this.env);
        await this.redis.connect().catch(() => {
          throw new Error(`Không kết nối được Redis test: ${redactUrl(this.env.redisUrl)}`);
        });
      }
      if (!this.env.otpSecret) {
        throw new Error('Thiếu LOADTEST_OTP_SECRET — không thể OTP-Seed register (AF-1). Kiểm tra loadtest/.env');
      }
      this.restDriver = new RestDriver(this.config.gatewayUrl, this.env);

      const dbWriter = this.dbWriter;
      const summary = await provisionAccounts(
        this.redis,
        this.config,
        this.env,
        (done, total) => {
          // KHÔNG reference `summary` (TDZ — chưa được gán khi callback chạy); dùng this.provisionProgress
          this.provisionProgress = { done, total };
        },
        () => this.finishing || ['stopped', 'error'].includes(this.phase),
        // DB-based pool reuse (seed-accounts.ts): tìm pool seed khớp gateway + targetUsers → login lại.
        dbWriter ? (gw, tu) => dbWriter.findPoolForRun(gw, tu) : undefined,
      );
      this.provisionSummary = summary;
      void this.dbWriter?.writePool(this.config, summary); // DB: pools + pool_accounts (per-account outcome) — PRD B1

      // Auto-stop E1: register fail > 50% (chỉ đếm fail của REGISTER — không tính login fail khi tái sử dụng pool)
      const total = summary.registered + summary.registerFailed;
      const failRate = total > 0 ? (summary.registerFailed / total) * 100 : 0;
      if (failRate > 50 && total >= 10) {
        ltLog.error(`E1: register fail ${failRate.toFixed(0)}% (${summary.registerFailed}/${total})`);
        return this.finishRun('auto', `E1: register fail ${failRate.toFixed(0)}% > 50%`);
      }
      if (summary.accounts.length < Math.ceil(this.config.targetUsers * 0.5)) {
        ltLog.error(`Không đủ account sau provisioning (${summary.accounts.length}/${this.config.targetUsers})`);
        return this.finishRun('auto', `provisioning fail: chỉ có ${summary.accounts.length} account`);
      }
      // Kill-switch giữa chừng provisioning → không spawn worker
      if (this.finishing || !['provisioning'].includes(this.phase)) return;
      this.accounts = summary.accounts;
      ltLog.info(`provisioning done: registered=${summary.registered} loggedIn=${summary.loggedIn} failed=${summary.failed}`);

      this.farm.setRunConfig(this.config);
      this.farm.spawnAll(this.config.workerCount, summary.accounts);
      this.phase = transition(this.phase, 'ramping');
      this.events.onPhaseChange?.(this.phase);
      this.broadcastRun();
    } catch (err) {
      ltLog.error(`provisioning exception: ${err instanceof Error ? err.message : String(err)}`);
      return this.finishRun('auto', err instanceof Error ? err.message : String(err));
    }
  }

  private broadcastRun() {
    if (!this.config) return;
    for (let i = 0; i < this.config.workerCount; i++) {
      const w = this.farm.get(i);
      if (w) {
        this.farm.send(i, { type: 'run', config: this.config, accounts: w.accounts, workerIndex: i });
        w.runSent = true;
      }
    }
  }

  private startTimers() {
    this.aggregateTimer = setInterval(() => void this.aggregateTick(), 1000);
    this.queueTimer = setInterval(() => void this.pollQueueCount(), 1000);
    this.scrapeTimer = setInterval(() => void this.scrapeGatewayMetrics(), this.env.scrapeIntervalMs);
    // T-07: snapshot tool metrics định kỳ 5s (coordinator memory, worker alive, apiErrors).
    this.metricsTimer = setInterval(() => this.snapshotToolMetrics(), 5000);
  }

  private stopTimers() {
    if (this.aggregateTimer) clearInterval(this.aggregateTimer);
    if (this.queueTimer) clearInterval(this.queueTimer);
    if (this.scrapeTimer) clearInterval(this.scrapeTimer);
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    this.aggregateTimer = null;
    this.queueTimer = null;
    this.scrapeTimer = null;
    this.metricsTimer = null;
  }

  /** T-07: log snapshot 5s — coordinator RSS, worker alive, apiErrors (logger context).
   *  FIX-6: rssMb gauge đọc memoryUsage() TẠI ĐÂY (5s), KHÔNG ở tick 1s (design: 5s snapshot). */
  private snapshotToolMetrics(): void {
    toolMetrics.setGauge('coordinator.rssMb', Math.round(process.memoryUsage().rss / 1024 / 1024));
    const snap = toolMetrics.snapshot();
    ltLog.info('tool metrics snapshot', {
      runId: this.runId || undefined,
      context: {
        rssMb: snap.gauges['coordinator.rssMb'],
        workerAlive: snap.gauges['worker.alive'],
        apiErrors: snap.counters.apiErrors,
        dbWriteFail: snap.counters.dbWriteFail,
        workerRestarts: snap.counters.workerRestarts,
        runFinished: snap.counters.runFinished,
      },
    });
  }

  /** Dừng run (manual) hoặc kill-switch — AC1.4 / SD-3. */
  async stop(force: boolean): Promise<void> {
    // B-2 (T-06 FIX-9): finishRun đang in-flight → chờ xong TRƯỚC khi tiếp tục (shutdown không drop finalize).
    // Check này phải ĐỨNG TRƯỚC phase guard — phase có thể đã 'stopped'/'error' trong lúc finishRun còn await writeRunFinish.
    if (this.finishing) {
      await this.finishPromise;
      return;
    }
    if (this.phase === 'idle' || this.phase === 'finished' || this.phase === 'stopped' || this.phase === 'error') {
      if (this.phase === 'stopped' || this.phase === 'error') return; // đã dừng
      return;
    }
    this.stopRequested = force ? 'kill' : 'manual';
    if (force) {
      this.farm.killAll();
      return this.finishRun('manual', 'kill-switch: dừng ngay mọi worker', true);
    }
    if (this.phase === 'provisioning') {
      // không có worker — dừng luôn
      return this.finishRun('manual', 'run bị dừng khi đang provisioning');
    }
    this.phase = transition(this.phase, 'cooldown');
    this.events.onPhaseChange?.(this.phase);
    this.farm.broadcast({ type: 'stop', reason: 'manual stop', force: false });
    // finishRun gọi khi đủ worker done (onWorkerMessage) hoặc timeout an toàn
    setTimeout(() => {
      if (this.phase === 'cooldown') {
        void this.finishRun('manual', this.stopReason || 'cooldown timeout (worker không phản hồi)', false);
      }
    }, COOLDOWN_WAIT_MS);
  }

  pause() {
    this.farm.broadcast({ type: 'pause' });
  }
  resume() {
    this.farm.broadcast({ type: 'resume' });
  }

  // ─── Worker messages ───────────────────────────────────────────────────

  private onWorkerMessage(workerId: number, msg: WorkerMessage) {
    switch (msg.type) {
      case 'tick':
        this.workerTicks.set(workerId, msg.tick);
        if (msg.tick.histograms) this.workerHistograms.set(workerId, msg.tick.histograms);
        break;
      case 'users-response':
        this.farm.resolveUsers(msg.requestId, msg.rows, msg.total);
        break;
      case 'done':
        this.workerDoneCount++;
        ltLog.info(`coordinator: worker#${workerId} done (${this.workerDoneCount}/${this.farm.total})`);
        if (this.phase === 'cooldown' && this.workerDoneCount >= this.farm.total) {
          const kind = this.stopRequested === 'manual' ? 'manual' : 'natural';
          void this.finishRun(kind, this.stopReason || 'run hoàn tất (duration hết)', false);
        }
        break;
      case 'log':
        ltLog.info(`worker#${workerId}: ${msg.msg}`, { workerId, runId: this.runId || undefined });
        break;
      case 'fatal':
        ltLog.error(`worker#${workerId} fatal: ${msg.error}`);
        break;
      case 'ready': {
        // Worker gửi ready SAU khi xử lý `run` — chỉ gửi run lại khi worker CHƯA nhận (restart/new)
        const w = this.farm.get(workerId);
        if (w && !w.runSent && this.config && (this.phase === 'ramping' || this.phase === 'steady')) {
          this.farm.send(workerId, { type: 'run', config: this.config, accounts: w.accounts, workerIndex: workerId });
          w.runSent = true;
        }
        break;
      }
    }
  }

  // ─── Aggregation 1s (DB-1) ─────────────────────────────────────────────

  private async aggregateTick() {
    if (!this.config) return;
    // T-07: gauge worker alive mỗi tick (cheap); rssMb CHỈ ở snapshot 5s (FIX-6 — không gọi memoryUsage() mỗi giây).
    toolMetrics.setGauge('worker.alive', this.farm.alive);
    const now = Date.now();
    const elapsedSec = Math.round((now - this.startAt) / 1000);

    if (this.phase === 'provisioning') {
      // tick provisioning: đếm từ Auth Factory
      const p = this.provisionProgress;
      const tick: LoadTestTick = {
        type: 'tick', runId: this.runId, ts: now, phase: 'provisioning', elapsedSec,
        counters: {
          usersCreated: p.done,
          usersConnected: 0, usersActive: 0, usersQueued: 0, usersInRoom: 0,
          actionsTotal: 0, successTotal: 0, failTotal: 0, echoOk: 0, echoSent: 0,
          queueCount: 0, roomCount: 0, droppedOutbox: 0, reconnectCount: 0, rateLimitedNoEcho: 0,
        },
        rates: { successRate: 100, echoRate: 100 },
        actionsPerSec: {},
        latency: { p50: 0, p95: 0, p99: 0 },
        errors: [],
        server: { wsConnections: 0, wsMessagesEmitted: 0, wsMessagesPerSec: 0 },
        // Chưa spawn worker (đang register users) — total=0 tránh UI hiểu nhầm "worker chết" (E3 giả)
        workers: { alive: 0, total: 0, cpuAvg: 0 },
      };
      this.pushTick(tick);
      return;
    }

    const ticks = [...this.workerTicks.values()];
    // T-07/S-12: đếm NO_POST_FIXTURE từ raw worker errors (trước top-10 cap) — report rõ ràng.
    let noPostFixture = 0;
    for (const t of ticks) noPostFixture += t.errors['NO_POST_FIXTURE'] ?? 0;
    this.noPostFixtureCount = noPostFixture;
    const agg: AggregatedTick = aggregateTicks(this.runId, now, elapsedSec, this.phase, ticks, undefined);
    // bổ sung server-side: queue-count + gateway metrics
    agg.tick.counters.queueCount = this.queueCount;
    agg.tick.server = { ...this.serverMetrics };
    agg.tick.workers = {
      alive: this.farm.alive,
      total: this.farm.total,
      cpuAvg: agg.tick.workers.cpuAvg,
    };
    // Histogram cumulative: rebuild từ giá trị MỚI NHẤT của từng worker (worker histogram
    // là cumulative — merge thêm mỗi giây sẽ phóng đại count lên ~T lần, phá AC6.4).
    this.cumulativeHistograms = new ActionHistograms();
    for (const hist of this.workerHistograms.values()) {
      for (const [action, buckets] of Object.entries(hist)) {
        if (buckets) this.cumulativeHistograms.mergeFrom(action, buckets);
      }
    }
    // Kết quả ok/fail theo action (cumulative — replace, không accumulate).
    this.cumulativeActionOk = { ...(agg.actionOk as Record<string, number>) };
    this.cumulativeActionFail = { ...(agg.actionFail as Record<string, number>) };
    for (const s of agg.errorSamples) this.errorSamplesPrivate.push(s);
    if (this.errorSamplesPrivate.length > 50) this.errorSamplesPrivate = this.errorSamplesPrivate.slice(-50);

    // max tracking
    this.maxConnected = Math.max(this.maxConnected, agg.tick.counters.usersConnected);
    this.maxActive = Math.max(this.maxActive, agg.tick.counters.usersActive);
    this.maxQueue = Math.max(this.maxQueue, this.queueCount);
    const aps = Object.values(agg.tick.actionsPerSec).reduce((a, b) => a + (b ?? 0), 0);
    this.peakActionsPerSec = Math.max(this.peakActionsPerSec, aps);
    this.actionsPerSecSeries.push(aps);

    this.pushTick(agg.tick);

    // Phase advance
    if (this.phase === 'ramping' && agg.tick.counters.usersConnected >= this.config.targetUsers) {
      this.phase = transition(this.phase, 'steady');
      this.events.onPhaseChange?.(this.phase);
      ltLog.info(`run ${this.runId}: STEADY — ${agg.tick.counters.usersConnected} connected`);
    }
    if (this.phase === 'steady' && elapsedSec >= this.config.durationSec) {
      this.phase = transition(this.phase, 'cooldown');
      this.events.onPhaseChange?.(this.phase);
      this.stopReason = 'duration hết';
      this.farm.broadcast({ type: 'stop', reason: 'duration ended', force: false });
      ltLog.info(`run ${this.runId}: COOLDOWN (duration ${this.config.durationSec}s)`);
      // timeout an toàn nếu worker không done
      setTimeout(() => {
        if (this.phase === 'cooldown') void this.finishRun('natural', this.stopReason || 'cooldown timeout', false);
      }, COOLDOWN_WAIT_MS);
    }

    // Auto-stop E2: connect fail > 30%
    if (this.phase === 'ramping' || this.phase === 'steady') {
      // C-2: heartbeat detect (wiring — trước đây checkHeartbeats là dead code).
      // Worker im lặng > WORKER_HEARTBEAT_STALE_MS = treo (event loop đứng / IPC chết):
      // kill → onWorkerDied → restart/E3 đúng như worker crash thật.
      const stale = this.farm.checkHeartbeats(WORKER_HEARTBEAT_STALE_MS);
      for (const id of stale) {
        const w = this.farm.get(id);
        if (w?.alive) {
          ltLog.error(`E3: worker#${id} heartbeat timeout (${WORKER_HEARTBEAT_STALE_MS}ms không tick) — kill để restart`);
          try {
            w.child.kill('SIGKILL');
          } catch {
            // đã chết
          }
        }
      }

      let attempts = 0, fails = 0;
      for (const t of ticks) {
        attempts += t.counters.connectAttempts;
        fails += t.counters.connectFails;
      }
      const connectFailRate = attempts >= 10 ? (fails / attempts) * 100 : 0;
      const decision = decideAutoStop({
        phase: this.phase,
        registerFailRate: 0,
        connectFailRate,
        registeredTotal: 0,
        connectTotal: attempts,
      });
      if (decision.stop) {
        ltLog.error(`E2: ${decision.reason}`);
        return this.finishRun('auto', decision.reason ?? 'connect fail', false);
      }
      // E3: > 50% worker chết trong 60s
      if (this.farm.total > 0 && this.workerDeathTimes.length > this.farm.total * 0.5) {
        ltLog.error(`E3: > 50% worker chết trong 60s (${this.workerDeathTimes.length}/${this.farm.total})`);
        return this.finishRun('auto', 'E3: quá nhiều worker chết', true);
      }
      // C-2: TOÀN BỘ worker chết (farm.total===0) + không restart nào đang chờ backoff
      // → auto-stop NGAY (trước đây guard `total > 0` short-circuit → run kẹt 'ramping' vĩnh viễn, DB row 'running').
      if (this.farm.total === 0 && this.pendingRestarts === 0 && this.workerDeathTimes.length > 0) {
        ltLog.error(`E3: toàn bộ ${this.workerDeathTimes.length} worker chết — auto-stop`);
        return this.finishRun('auto', 'E3: toàn bộ worker chết', true);
      }
    }
  }

  private pushTick(tick: LoadTestTick) {
    this.tickHistory.push(tick);
    if (this.tickHistory.length > TICK_HISTORY_LIMIT) this.tickHistory.shift();
    this.lastTick = tick;
    this.dbWriter?.pushTick(tick); // DB: MetricSample (batch flush ~30s) — PRD A2
  }

  private async pollQueueCount() {
    if (!this.restDriver || !this.accounts.length) return;
    try {
      const res = await this.restDriver.chatQueueCount();
      const count = res.data?.count ?? 0;
      if (Number.isFinite(count)) this.queueCount = count;
    } catch {
      // Redis chết — giữ giá trị cũ (E5)
    }
  }

  /** Scrape gateway /metrics (Prometheus text) — DB-3. */
  private async scrapeGatewayMetrics() {
    if (!this.config) return;
    try {
      const res = await (await fetch(normalizeUrl(this.config.gatewayUrl) + '/metrics', {
        signal: AbortSignal.timeout(4000),
      })).text();
      const lines = res.split('\n');
      let wsConnections = 0, wsMessages = 0;
      for (const line of lines) {
        if (line.startsWith('ws_connections ')) wsConnections = parseFloat(line.split(' ')[1]) || 0;
        if (line.startsWith('ws_messages_emitted_total')) {
          wsMessages += parseFloat(line.split(' ')[1]) || 0;
        }
      }
      const now = Date.now();
      const perSec = this.serverMetrics.lastScrapeAt > 0
        ? Math.round(wsMessages / Math.max(1, (now - this.serverMetrics.lastScrapeAt) / 1000))
        : 0;
      this.serverMetrics = { wsConnections, wsMessagesEmitted: Math.round(wsMessages), wsMessagesPerSec: perSec, lastScrapeAt: now };
    } catch {
      // gateway /metrics có thể 401 hoặc tắt — bỏ qua (không phải lỗi run)
    }
  }

  // ─── Finish / report ───────────────────────────────────────────────────

  /**
   * B-2 (T-06 FIX-9): finishRun track promise in-flight — nếu gọi lần 2 (stop/shutdown) khi đang finish,
   * trả về chính finishPromise để caller await (không drop finalize khi pool.end).
   */
  private finishRun(kind: 'natural' | 'auto' | 'manual', reason: string, force = false): Promise<void> {
    if (this.finishing) return this.finishPromise ?? Promise.resolve();
    // C-3: run đã kết thúc (stopped/finished/error) KHÔNG được finalize lại.
    // Race: manual stop xong (phase='stopped') rồi E1 auto-stop của provisionAndLaunch vẫn chạy tiếp
    // → trước đây finishRun lần 2 đổi 'stopped' → 'error' (writeRunFinish 2 lần).
    if (this.phase === 'stopped' || this.phase === 'finished' || this.phase === 'error') return Promise.resolve();
    this.finishing = true;
    this.finishPromise = this.doFinishRun(kind, reason, force);
    return this.finishPromise;
  }

  private async doFinishRun(kind: 'natural' | 'auto' | 'manual', reason: string, force = false): Promise<void> {
    try {
      toolMetrics.inc('runFinished');
      this.stopTimers();
      this.stopReason = reason;
      if (force) this.farm.killAll();
      this.farm.dispose();
      // T-07 FIX-2: KHÔNG disconnect Redis ở finishRun — giữ connection cho health trung thực
      // (redis 'up' chỉ khi connected) + run sau reuse. ioredis tự reconnect nếu server drop.
      const { phase, stopReason } = endPhaseFromStop(kind, reason);
      this.phase = 'report';
      this.events.onPhaseChange?.(this.phase);
      try {
        this.latestReport = buildReport({
          runId: this.runId,
          status: phase === 'finished' ? 'finished' : phase === 'stopped' ? 'stopped' : 'error',
          startAt: this.startAt,
          endAt: Date.now(),
          config: this.config ?? ({} as RunConfig),
          tickHistory: this.tickHistory,
          perActionHistograms: this.cumulativeHistograms,
          actionOk: this.cumulativeActionOk,
          actionFail: this.cumulativeActionFail,
          maxConnected: this.maxConnected,
          maxActive: this.maxActive,
          maxQueue: this.maxQueue,
          peakActionsPerSec: this.peakActionsPerSec,
          provisioned: this.provisionSummary.registered + this.provisionSummary.loggedIn,
          stopReason,
          noPostFixtureSkipped: this.noPostFixtureCount,
        });
        this.phase = phase;
        this.events.onPhaseChange?.(this.phase);
        saveReportFiles(this.latestReport, this.tickHistory, this.env.reportsDir);
        ltLog.info(`=== run ${this.runId} ${this.phase} — ${reason} ===`, { runId: this.runId });
      } catch (err) {
        ltLog.error(`buildReport fail: ${String(err)}`);
        this.phase = 'error';
        this.events.onPhaseChange?.(this.phase);
      }
      // DB finalize (best-effort): status + stop_reason + summary_json + flush ticks còn lại — PRD A1
      // B-2 (T-06): AWAIT writeRunFinish — finalize UPDATE phải xong TRƯỚC khi dbWriter.shutdown()
      // đóng pool. Trước đây fire-and-forget → pool.end() có thể drop finalize đang bay → run kẹt 'running'.
      const finalStatus = this.phase === 'finished' ? 'finished' : this.phase === 'stopped' ? 'stopped' : 'error';
      try {
        await this.dbWriter?.writeRunFinish(
          this.runId,
          finalStatus,
          this.stopReason,
          this.latestReport,
          this.latestReport?.endAt ?? Date.now(),
        );
      } catch (err) {
        ltLog.warn(`[lt][db] writeRunFinish ném lỗi (runId=${this.runId}): ${String(err)}`);
      }
    } finally {
      this.finishing = false;
      this.finishPromise = null;
    }
  }

  /** Truy vấn user từ các worker (virtualized). */
  async queryUsers(offset: number, limit: number, filter?: string): Promise<{ rows: unknown[]; total: number }> {
    const per = Math.ceil(limit / Math.max(1, this.farm.total));
    const rows: unknown[] = [];
    let total = 0;
    const idList = [...Array(this.farm.total).keys()];
    for (const id of idList) {
      const localOffset = Math.max(0, offset - total);
      const res = await this.farm.queryUsers(id, localOffset, per, filter);
      rows.push(...res.rows);
      total += res.total;
      if (rows.length >= limit) break;
    }
    return { rows: rows.slice(0, limit), total };
  }

  getRunSnapshot() {
    return {
      runId: this.runId,
      phase: this.phase,
      startAt: this.startAt,
      config: this.config,
      lastTick: this.lastTick,
      stopReason: this.stopReason,
    };
  }
}

export { ACTION_TYPES };
export type { StartRunRequest };
export { setVerbose };
