/**
 * T-11 (G-7) — E2E: `coordinator.start()` + `provisionAccounts()` với MOCK gateway.
 * KHÔNG cần gateway thật / Postgres / Redis thật:
 *   - Mock gateway (http + socket.io tối thiểu) — xem mock-gateway.ts.
 *   - Fake Redis in-memory (vi.mock('ioredis')) — OTP seed chỉ cần set/get.
 *   - Recording DbWriter (không Postgres) — assert pipeline DB gọi đúng thứ tự.
 * Run NGẮN (CI fast): 12 users × 30s → run finished + report đầy đủ + pipeline DB đúng thứ tự.
 * Đây là bằng chứng reality-check cho máy móc E2E (run thật 5k user là T-12/manual step).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getEnv } from '../config';
import { LoadTestCoordinator } from '../coordinator';
import type { DbWriter } from '../db/writer';
import type { RunConfig, LoadTestTick, RunReport } from '../types';
import { startMockGateway, type MockGateway } from './mock-gateway';
import { sleep } from '../util';
// ─── Fake Redis (in-memory — đủ cho seedOtp/seedSmsOtp + connect/ping) ─────
const FakeRedis = vi.hoisted(() => {
  class FakeRedis {
    private store = new Map<string, { value: string; expAt: number }>();
    async connect(): Promise<this> {
      return this;
    }
    async ping(): Promise<string> {
      return 'PONG';
    }
    async set(key: string, value: string, mode?: string, ttlSeconds?: number): Promise<string> {
      this.store.set(key, {
        value,
        expAt: mode === 'EX' && ttlSeconds ? Date.now() + ttlSeconds * 1000 : Number.POSITIVE_INFINITY,
      });
      return 'OK';
    }
    async get(key: string): Promise<string | null> {
      const e = this.store.get(key);
      if (!e) return null;
      if (Date.now() > e.expAt) {
        this.store.delete(key);
        return null;
      }
      return e.value;
    }
    async quit(): Promise<string> {
      return 'OK';
    }
    disconnect(): void {}
    on(): this {
      return this;
    }
  }
  return FakeRedis;
});
vi.mock('ioredis', () => ({ default: FakeRedis }));

// ─── Recording DbWriter — assert thứ tự pipeline DB (không Postgres) ───────
class RecordingDbWriter {
  writeRunStartCount = 0;
  writePoolCount = 0;
  pushTickCount = 0;
  writeRunFinishCount = 0;
  startConfig: RunConfig | null = null;
  finishStatus: string | null = null;
  finishReport: RunReport | null = null;
  /** Thứ tự thực tế các stage pipeline DB (để assert đúng thứ tự, không phụ thuộc counter). */
  calls: string[] = [];
  async writeRunStart(config: RunConfig): Promise<void> {
    this.writeRunStartCount++;
    this.startConfig = config;
    this.calls.push('start');
  }
  async writePool(): Promise<void> {
    this.writePoolCount++;
    this.calls.push('pool');
  }
  pushTick(_tick: LoadTestTick): void {
    this.pushTickCount++;
    this.calls.push('tick');
  }
  async writeRunFinish(runId: string, status: 'finished' | 'stopped' | 'error', _reason: string | null, report: unknown): Promise<void> {
    this.writeRunFinishCount++;
    this.finishStatus = status;
    this.finishReport = report as RunReport | null;
    this.calls.push('finish');
    void runId;
  }
}

const TERMINAL = ['finished', 'stopped', 'error'] as const;

describe('E2E — coordinator.start + provisionAccounts với mock gateway (T-11, G-7)', () => {
  const runTimeout = 150_000; // run 30s + cooldown ~10s + buffer
  let gateway: MockGateway;
  let coordinator: LoadTestCoordinator;
  let db: RecordingDbWriter;
  let reportsDir: string;

  beforeAll(async () => {
    gateway = await startMockGateway();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-e2e-data-'));
    reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-e2e-reports-'));
    const env = getEnv({
      LOADTEST_PORT: '0',
      LOADTEST_HOST: '127.0.0.1',
      LOADTEST_ALLOWLIST: gateway.url, // SD-1: mock phải nằm trong allowlist
      LOADTEST_GATEWAY_URL: gateway.url,
      LOADTEST_REDIS_URL: 'redis://mock.invalid:6379', // FakeRedis — không cần Redis thật
      LOADTEST_OTP_SECRET: 'e2e-otp-secret-0123456789abcdef0123456789abcdef', // ≥ 32 (AF-1)
      LOADTEST_AUTH_SECRET: 'e2e-auth-secret-0123456789abcdef0123456789abcdef',
      LOADTEST_WORKERS: '1',
      LOADTEST_DATA_DIR: dataDir,
      LOADTEST_REPORTS_DIR: reportsDir,
      LOADTEST_REGISTER_RAMP: '200',
      LOADTEST_RATE_LIMIT_DISABLED: 'true', // R-6: E2E không dính 429 của chính tool
    });
    db = new RecordingDbWriter();
    coordinator = new LoadTestCoordinator(env, {}, db as unknown as DbWriter);
  });

  afterAll(async () => {
    await gateway.stop();
  });

  it(
    'run ngắn: 12 users × 30s với mock gateway → finished + report đầy đủ + pipeline DB đúng thứ tự',
    async () => {
      const started = await coordinator.start({
        targetUsers: 12,
        rampRate: 100,
        rampMode: 'rate',
        durationMin: 0.5, // 30s — CI fast (thời lượng thật vẫn chạy đủ pipeline)
        profile: { chat: 40, read: 30, comment: 20, like: 10, view: 0 },
        gatewayUrl: gateway.url,
        freshAccounts: true, // register mới qua mock (không reuse pool)
      });
      expect(started.ok).toBe(true);
      expect(started.config?.workerCount).toBe(1);

      // Chờ run kết thúc (finished/stopped/error).
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline && !(TERMINAL as readonly string[]).includes(coordinator.phase)) {
        await sleep(500);
      }

      // ── 1. Run chuyển trạng thái đúng: provisioning → … → finished ──────
      expect(coordinator.phase).toBe('finished');
      expect(coordinator.runId).toMatch(/^lt/);
      expect(coordinator.latestReport).not.toBeNull();

      // ── 2. Report đầy đủ các section (G-7) ──────────────────────────────
      const report = coordinator.latestReport!;
      expect(report.status).toBe('finished');
      expect(report.runId).toBe(coordinator.runId);
      expect(report.summary.usersCreated).toBe(12); // provision đủ
      expect(Array.isArray(report.perAction)).toBe(true);
      expect(report.perAction.length).toBeGreaterThan(0); // latency theo action
      expect(Array.isArray(report.errors)).toBe(true);
      expect(Array.isArray(report.bottlenecks)).toBe(true);
      expect(typeof report.durationSec).toBe('number');
      expect(report.durationSec).toBeGreaterThanOrEqual(20); // run chạy đủ ~30s

      // ── 3. Socket + chat echo thật sự chảy (mock socket.io có auth) ─────
      expect(gateway.socketConnections).toBeGreaterThanOrEqual(12); // đủ user connect với auth
      expect(report.summary.echoSent).toBeGreaterThan(0);
      expect(report.summary.echoOk).toBeGreaterThan(0); // echo khớp clientMsgId (AC3.3)
      expect(report.summary.successTotal).toBeGreaterThan(0);

      // ── 4. Không mất DB im lặng: pipeline DB đầy đủ + đúng thứ tự ──────────
      // (dbWriteFail counter bị bypass bởi Recording writer — assert pipeline
      //  ĐÃ record thay vì counter vô nghĩa: mọi stage chạy đúng thứ tự
      //  start → pool → ticks → finish, không stage nào bị drop; count
      //  exactly-once cho mỗi stage được assert ở section 5.)
      const firstTick = db.calls.indexOf('tick');
      expect(db.calls[0]).toBe('start');
      expect(db.calls).toContain('pool');
      expect(firstTick).toBeGreaterThan(db.calls.indexOf('pool'));
      expect(db.calls[db.calls.length - 1]).toBe('finish');

      // ── 5. Pipeline DB gọi đúng thứ tự (start → pool → ticks → finish) ──
      expect(db.writeRunStartCount).toBe(1);
      expect(db.writePoolCount).toBe(1);
      expect(db.pushTickCount).toBeGreaterThan(5);
      expect(db.writeRunFinishCount).toBe(1);
      expect(db.finishStatus).toBe('finished');
      expect(db.finishReport?.runId).toBe(coordinator.runId);

      // ── 6. Report file được lưu (RE-3) ───────────────────────────────────
      const runDir = path.join(reportsDir, coordinator.runId);
      expect(fs.existsSync(path.join(runDir, `report-${coordinator.runId}.json`))).toBe(true);
      expect(fs.existsSync(path.join(runDir, `report-${coordinator.runId}.md`))).toBe(true);
      expect(fs.existsSync(path.join(runDir, `metrics-${coordinator.runId}.csv`))).toBe(true);
    },
    runTimeout,
  );
});
