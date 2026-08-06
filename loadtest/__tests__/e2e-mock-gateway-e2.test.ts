/**
 * T7 (DESIGN-loadtest-e2-connect-fail §9) — Integration 3 kịch bản E2 với MOCK gateway
 * + ST-12 (gateway gửi message độc). Pattern y hệt e2e-mock-gateway.test.ts (T-11):
 * mock socket.io server local, FakeRedis (vi.mock ioredis), Recording DbWriter — KHÔNG cần
 * gateway thật / Postgres / Redis. Đây là bằng chứng HARD-GATE G7 cho AC-1..AC-5:
 *
 *   (a) 100% token OK     → run finished, connectFailRate ~0, không E2 (mini AC-5)
 *   (b) 5% token lỗi      → E2 KHÔNG trigger (AC-1 + F4): window ≥ 50 attempts, rate ~20.8% < 30%,
 *                          5 user phase 'failed', usersFailed = 5, fail ≤ 25 (cap 5 × 5 user)
 *   (c) 100% token lỗi    → E2 trigger ≤ 60s, stopReason bắt đầu "E2:", log đủ 8 trường (AC-2/AC-4)
 *   (d) KÊNH B (F-T7-2)   → gateway accept rồi disconnect NGAY (như gateway thật) — 100% user failed,
 *                          E2 trigger ≤ 60s, stopReason "E2:", usersFailed == userCount (AC-2 trên
 *                          kênh reject THẬT — 'io server disconnect' terminal, KHÔNG connect_error)
 *   ST-12                 → middleware next(new Error('độc')): errorSamples/lastError/log đã sanitize
 *
 * Mock-gateway extension (mock-gateway.ts): rejectInvalidTokens (2 chế độ — 403 upgrade → retry ~1/s
 * kênh C engine-level; rejectMessage → middleware next(new Error('độc')) 1-shot cho ST-12) +
 * brokenTokenRatio (deterministic counter — 5% với 100 users = ĐÚNG 5 token lỗi) +
 * acceptThenDrop (F-T7-2 kênh B — hành vi gateway THẬT).
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getEnv } from '../config';
import { LoadTestCoordinator } from '../coordinator';
import { ltLog, logHistory, sleep } from '../util';
import type { DbWriter } from '../db/writer';
import type { LoadTestTick, RunReport } from '../types';
import { startMockGateway, type MockGateway, type MockGatewayOptions } from './mock-gateway';

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

// ─── Recording DbWriter — assert finish status/reason (KHÔNG Postgres) ─────
class RecordingDbWriter {
  writeRunStartCount = 0;
  writePoolCount = 0;
  pushTickCount = 0;
  writeRunFinishCount = 0;
  finishStatus: string | null = null;
  finishReason: string | null = null;
  finishReport: RunReport | null = null;
  async writeRunStart(_config: unknown): Promise<void> {
    this.writeRunStartCount++;
  }
  async writePool(): Promise<void> {
    this.writePoolCount++;
  }
  pushTick(_tick: LoadTestTick): void {
    this.pushTickCount++;
  }
  async writeRunFinish(
    _runId: string,
    status: 'finished' | 'stopped' | 'error',
    reason: string | null,
    report: unknown,
  ): Promise<void> {
    this.writeRunFinishCount++;
    this.finishStatus = status;
    this.finishReason = reason;
    this.finishReport = report as RunReport | null;
  }
}

const TERMINAL = ['finished', 'stopped', 'error'] as const;
const PROFILE_READ = { chat: 0, read: 100, comment: 0, like: 0, view: 0 };
/** Regex log E2 8 trường (AC-4/ST-7 — DESIGN §6). */
const E2_LOG_RE =
  /^E2: auto-stop: connect fail 100% > 30% \(E2\) \| phase=\S+ elapsedSec=\d+ windowSec=\d+ windowAttempts=\d+ windowFails=\d+ byType=timeout:\d+,transport:\d+,reject:\d+,other:\d+ usersFailedCum=\d+ workersAlive=\d+ workersTotal=\d+$/;

/** JWT trần (F-5) + hex-40 — nhúng vào message độc ST-12. */
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const MALICIOUS = `reject: token=${JWT}\n[lt][ERROR][09:00:00.000] forged line\naccess_token=${JWT}\x00tail`;

async function waitUntil(fn: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(500);
  }
  throw new Error(`timeout chờ: ${what}`);
}

/** Đọc lastWindow (T5 — private) để assert E2 evaluate THẬT (window ≥ 50 attempts, AC-3). */
function windowState(c: LoadTestCoordinator): { attempts: number; fails: number; byType: Record<string, number> } {
  return (c as unknown as { lastWindow: { attempts: number; fails: number; byType: Record<string, number> } }).lastWindow;
}

/** Spy log E2 của coordinator (ltLog là module singleton — worker log ở process riêng).
 *  Dùng SPY per-test (KHÔNG logHistory — ring buffer là module-global, dính log test khác). */
function installE2Spy(): { e2ErrorLines: () => string[]; restore: () => void } {
  const errorSpy = vi.spyOn(ltLog, 'error');
  return {
    e2ErrorLines: () =>
      errorSpy.mock.calls.map((m) => String(m[0])).filter((l) => l.startsWith('E2: auto-stop: connect fail')),
    restore: () => errorSpy.mockRestore(),
  };
}

interface Scenario {
  gateway: MockGateway;
  coordinator: LoadTestCoordinator;
  db: RecordingDbWriter;
  stop: () => Promise<void>;
}

/** Mỗi kịch bản: mock gateway riêng (option khác nhau) + coordinator riêng + dataDir/reportsDir riêng. */
async function startScenario(opts: MockGatewayOptions): Promise<Scenario> {
  const gateway = await startMockGateway(opts);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-t7-data-'));
  const reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-t7-reports-'));
  const env = getEnv({
    LOADTEST_PORT: '0',
    LOADTEST_HOST: '127.0.0.1',
    LOADTEST_ALLOWLIST: gateway.url,
    LOADTEST_GATEWAY_URL: gateway.url,
    LOADTEST_REDIS_URL: 'redis://mock.invalid:6379',
    LOADTEST_OTP_SECRET: 't7-otp-secret-0123456789abcdef0123456789abcdef',
    LOADTEST_AUTH_SECRET: 't7-auth-secret-0123456789abcdef0123456789abcdef',
    LOADTEST_WORKERS: '1',
    LOADTEST_DATA_DIR: dataDir,
    LOADTEST_REPORTS_DIR: reportsDir,
    LOADTEST_REGISTER_RAMP: '200',
    LOADTEST_RATE_LIMIT_DISABLED: 'true',
    LOADTEST_POOL_FILE: '', // cô lập khỏi loadtest/.env máy (có thể set pool-file) — E2E chạy register thật qua mock
  });
  const db = new RecordingDbWriter();
  const coordinator = new LoadTestCoordinator(env, {}, db as unknown as DbWriter);
  return {
    gateway,
    coordinator,
    db,
    stop: async () => {
      await gateway.stop();
    },
  };
}

describe('T7 — integration E2 với mock gateway (DESIGN §9, G7 evidence)', () => {
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it(
    '(a) 100% token OK → run finished, connectFailRate 0, không E2 (mini AC-5)',
    async () => {
      const sc = await startScenario({});
      const spy = installE2Spy();
      try {
        const startWall = Date.now();
        const started = await sc.coordinator.start({
          targetUsers: 100,
          rampRate: 100,
          rampMode: 'rate',
          durationMin: 0.5,
          profile: PROFILE_READ,
          gatewayUrl: sc.gateway.url,
          freshAccounts: true,
        });
        expect(started.ok).toBe(true);

        await waitUntil(() => (TERMINAL as readonly string[]).includes(sc.coordinator.phase), 120_000, 'run (a) kết thúc');

        // AC-1/AC-5 mini: finished, không E2, rate ~0 suốt run
        expect(sc.coordinator.phase).toBe('finished');
        expect(sc.db.finishStatus).toBe('finished');
        expect(sc.coordinator.stopReason ?? '').not.toContain('E2');
        for (const t of sc.coordinator.tickHistory) {
          expect(t.rates.connectFailRate).toBe(0); // < 5% — AC-5 ngưỡng hợp lệ
          expect(t.counters.connectFails).toBe(0);
          expect(t.counters.usersFailed).toBe(0);
          expect(t.hasConnectData).toBe(true); // tick LIVE đủ field connect (S-1: không "0 giả")
        }
        expect(sc.gateway.socketConnections).toBe(100); // mọi token OK → connect đủ
        expect(sc.db.writeRunFinishCount).toBe(1);
        expect(sc.coordinator.latestReport?.status).toBe('finished');
        expect(Date.now() - startWall).toBeLessThan(120_000);
        expect(spy.e2ErrorLines()).toEqual([]); // KHÔNG có log E2
      } finally {
        spy.restore();
        await sc.stop();
      }
    },
    150_000,
  );

  it(
    '(b) 5% token lỗi → E2 KHÔNG trigger (AC-1 + F4): window ≥ 50 attempts, rate ~20.8% < 30%, 5 user failed',
    async () => {
      const sc = await startScenario({ rejectInvalidTokens: true, brokenTokenRatio: 0.05 });
      const spy = installE2Spy();
      try {
        const started = await sc.coordinator.start({
          targetUsers: 100,
          // ramp 20/s: 100 users connect trong ~5s — healthy attempts tích lũy NHANH hơn fail-burst
          // (25 fails ≤ 25% window tại MỌI vị trí broken trong connect order — deterministic AC-1;
          // ramp quá chậm + broken cluster → transient > 30% → flaky, đã verify).
          // durationMin 1 (60s): đủ cho 5 user cutover (~25-30s, backoff 1→10s) TRƯỚC khi run
          // thoát ramping theo duration (F-T7-1) → kết thúc finished thật (AC-1).
          rampRate: 20,
          rampMode: 'rate',
          durationMin: 1,
          profile: PROFILE_READ,
          gatewayUrl: sc.gateway.url,
          freshAccounts: true,
        });
        expect(started.ok).toBe(true);

        // Chờ window ĐỦ 50 attempts (AC-3 gate) → E2 đã evaluate thật + provisioning đã xong
        await waitUntil(() => windowState(sc.coordinator).attempts >= 50, 90_000, '(b) window ≥ 50 attempts');
        expect(windowState(sc.coordinator).attempts).toBeGreaterThanOrEqual(50);

        // 5 token lỗi cấp đúng (deterministic counter trong mock — provisioning đã xong)
        expect(sc.gateway.brokenTokensIssued).toBe(5);

        // E2 KHÔNG trigger: chưa finish, không log E2, không writeRunFinish
        expect(sc.db.writeRunFinishCount).toBe(0);
        expect(spy.e2ErrorLines()).toEqual([]);
        expect(sc.coordinator.phase).toBe('ramping'); // run còn sống — chưa đủ connected (user failed plateau)

        // AC-7: user failed không sinh fail thêm — chờ đủ 5 user cutover (cap 5) rồi assert
        await waitUntil(() => (sc.coordinator.lastTick?.counters.usersFailed ?? 0) >= 5, 90_000, '(b) 5 user failed');
        expect(sc.coordinator.lastTick?.counters.usersFailed).toBe(5); // đếm ĐÚNG 1 lần/user
        expect(sc.coordinator.lastTick!.counters.connectFails).toBeLessThanOrEqual(25); // cap 5 × 5 user (F-1)

        // AC-1: toàn bộ 5% broken đã cutover → rate window ổn định ~20.8% < 30% (DESIGN §5.2)
        const w2 = windowState(sc.coordinator);
        const rate = (w2.fails / w2.attempts) * 100;
        expect(rate).toBeLessThan(30);
        expect(rate).toBeGreaterThan(10); // dữ liệu chảy thật — không "0 giả" (S-1)
        // byType sum == fails (SEC-1 invariant)
        expect(w2.byType.timeout + w2.byType.transport + w2.byType.reject + w2.byType.other).toBe(w2.fails);
        // Mọi fail của broken token là reject (upgrade 403 → 'websocket error' → classify reject)
        expect(w2.byType.reject).toBe(w2.fails);

        // 95 connect OK (đã đủ thời gian ramp hoàn tất)
        expect(sc.gateway.socketConnections).toBe(95);

        // AC-7: bảng users đúng 5 user phase 'failed' + lastError đã sanitize (F-2 e2e)
        const failed = await sc.coordinator.queryUsers(0, 100, undefined, 'failed');
        expect(failed.total).toBe(5);
        for (const row of failed.rows) {
          expect(row.phase).toBe('failed');
          expect(row.lastError).not.toBeNull();
          expect(row.lastError).not.toMatch(/[\x00-\x1f\x7f]/);
          expect(row.lastError).not.toContain('\n');
        }

        // F-T7-1: run thoát ramping theo duration (user failed plateau < target) → cooldown → FINISHED
        // (AC-1: run kết thúc THẬT — trước fix kẹt ramping vĩnh viễn; thay stop thủ công cũ)
        await waitUntil(() => (TERMINAL as readonly string[]).includes(sc.coordinator.phase), 120_000, '(b) run kết thúc (F-T7-1)');
        expect(sc.coordinator.phase).toBe('finished');
        expect(sc.db.finishStatus).toBe('finished');
        expect(sc.coordinator.stopReason).toBe('duration hết');
        expect(sc.coordinator.stopReason ?? '').not.toContain('E2'); // kết thúc NATURAL — không phải auto-stop
      } finally {
        spy.restore();
        await sc.stop();
      }
    },
    150_000,
  );

  it(
    '(c) 100% token lỗi → E2 trigger ≤ 60s, stopReason "E2:", log đủ 8 trường (AC-2/AC-4)',
    async () => {
      const sc = await startScenario({ rejectInvalidTokens: true, brokenTokenRatio: 1 });
      const spy = installE2Spy();
      try {
        const startWall = Date.now();
        const started = await sc.coordinator.start({
          targetUsers: 100,
          rampRate: 100,
          rampMode: 'rate',
          durationMin: 0.5,
          profile: PROFILE_READ,
          gatewayUrl: sc.gateway.url,
          freshAccounts: true,
        });
        expect(started.ok).toBe(true);

        await waitUntil(() => (TERMINAL as readonly string[]).includes(sc.coordinator.phase), 90_000, '(c) auto-stop');

        // AC-2: status 'error', stopReason bắt đầu "E2:", ≤ 60s kể từ start
        expect(sc.coordinator.phase).toBe('error');
        expect(sc.db.finishStatus).toBe('error');
        expect(sc.coordinator.stopReason ?? '').toMatch(/^E2:/);
        expect(Date.now() - startWall).toBeLessThan(60_000);
        expect(sc.db.writeRunFinishCount).toBe(1);

        // 100% reject → 0 connect thành công
        expect(sc.gateway.socketConnections).toBe(0);

        // Window tại lúc E2: ≥ 50 attempts, 100% fail (bounded-5 mọi user — F-1)
        const w = windowState(sc.coordinator);
        expect(w.attempts).toBeGreaterThanOrEqual(50);
        expect(w.fails).toBe(w.attempts);
        expect(w.byType.timeout + w.byType.transport + w.byType.reject + w.byType.other).toBe(w.fails);

        // AC-4: log E2 đủ 8 trường + regex (ST-7) — dòng ltLog.error bắt đầu "E2: auto-stop: connect fail"
        const line = spy.e2ErrorLines().find((l) => l.startsWith('E2: auto-stop: connect fail'));
        expect(line).toBeDefined();
        expect(line).toMatch(E2_LOG_RE);
        expect(line).toContain('windowAttempts=');
        expect(line).toContain('windowFails=');
        expect(line).toContain('byType=timeout:0,transport:0,reject:'); // upgrade 403 → 'websocket error' → reject
        expect(line).toContain('workersAlive=1');
        expect(line).toContain('workersTotal=1');
      } finally {
        spy.restore();
        await sc.stop();
      }
    },
    150_000,
  );

  it(
    'ST-12: gateway gửi message độc (JWT + newline + control chars) → errorSamples/lastError/log sanitized, không dòng giả',
    async () => {
      const sc = await startScenario({
        rejectInvalidTokens: true,
        brokenTokenRatio: 1,
        rejectMessage: MALICIOUS,
      });
      const spy = installE2Spy();
      try {
        const started = await sc.coordinator.start({
          targetUsers: 100,
          rampRate: 100,
          rampMode: 'rate',
          durationMin: 0.25,
          profile: PROFILE_READ,
          gatewayUrl: sc.gateway.url,
          freshAccounts: true,
        });
        expect(started.ok).toBe(true);

        // Middleware CONNECT_ERROR là 1-shot (socket.io-client v4 không retry) — chờ errorSamples chảy về
        await waitUntil(
          () => sc.coordinator.errorSamples.filter((s) => s.action === 'connect').length > 0,
          30_000,
          'ST-12 errorSamples action connect',
        );

        // F-2/F-4 e2e: errorSamples action 'connect' — message đã sanitize (không newline/control/JWT, cap 160)
        const samples = sc.coordinator.errorSamples.filter((s) => s.action === 'connect');
        expect(samples.length).toBeGreaterThan(0);
        for (const s of samples) {
          expect(s.message).not.toMatch(/[\x00-\x1f\x7f]/);
          expect(s.message).not.toContain('\n');
          expect(s.message).not.toContain(JWT);
          expect(s.message.length).toBeLessThanOrEqual(160);
        }
        // Message độc thật sự được redact (không phải test trống rỗng)
        expect(samples.some((s) => s.message.includes('[REDACTED]'))).toBe(true);

        // F-4: TOP ERRORS không bị phá — code = loại classify (không text độc)
        for (const e of sc.coordinator.lastTick?.errors ?? []) {
          expect(['reject', 'timeout', 'transport', 'other']).toContain(e.code);
          expect(e.code).not.toContain(JWT);
        }

        // F-2 e2e: lastError của user (bảng users — GET /users sink) đã sanitize
        const users = await sc.coordinator.queryUsers(0, 100);
        expect(users.total).toBe(100);
        for (const row of users.rows) {
          expect(row.lastError).not.toBeNull();
          expect(row.lastError).not.toMatch(/[\x00-\x1f\x7f]/);
          expect(row.lastError).not.toContain('\n');
          expect(row.lastError).not.toContain(JWT);
        }

        // F-3 e2e: ring buffer KHÔNG có dòng giả — mọi entry 1 dòng, không JWT raw
        for (const entry of logHistory) {
          expect(entry.msg).not.toContain('\n');
          expect(entry.msg).not.toContain(JWT);
        }

        // Đường LOG trực tiếp với message độc (redactMsg sink — F-3): 1 dòng, không JWT
        ltLog.error(MALICIOUS);
        const last = logHistory[logHistory.length - 1];
        expect(last.msg).not.toContain('\n');
        expect(last.msg).not.toContain(JWT);
        expect(last.msg).toContain('[REDACTED]');

        // 1-shot (middleware CONNECT_ERROR) → window không đủ 50 attempts → E2 KHÔNG trigger
        expect(sc.db.writeRunFinishCount).toBe(0);
        expect(spy.e2ErrorLines()).toEqual([]);

        // Dừng thủ công (run kẹt ramping — không retry) → 'stopped', KHÔNG E2
        await sc.coordinator.stop(false);
        await waitUntil(() => (TERMINAL as readonly string[]).includes(sc.coordinator.phase), 60_000, 'ST-12 dừng');
        expect(sc.coordinator.phase).toBe('stopped');
        expect(sc.coordinator.stopReason ?? '').not.toContain('E2');
      } finally {
        spy.restore();
        await sc.stop();
      }
    },
    150_000,
  );

  it(
    '(d) F-T7-2 kênh B: 100% accept-then-drop (gateway THẬT client.disconnect()) → E2 stop ≤ 60s, stopReason "E2:", usersFailed == userCount',
    async () => {
      // Kênh B = 1-shot terminal (KHÔNG retry như kênh C) → pacing ramp phải đủ chậm để window
      // 60s đạt ≥ 50 attempts SAU khi user cuối drop: 60 users @ 8/s → xong t≈7.5s; window (skip-first
      // ~8 attempts) đạt 50 ở tick ~8s → fire với MỌI user đã failed (margin ~0.5s, đã calibrate).
      const USER_COUNT = 60;
      const sc = await startScenario({ acceptThenDrop: true });
      const spy = installE2Spy();
      try {
        const startWall = Date.now();
        const started = await sc.coordinator.start({
          targetUsers: USER_COUNT,
          rampRate: 8,
          rampMode: 'rate',
          durationMin: 2,
          profile: PROFILE_READ,
          gatewayUrl: sc.gateway.url,
          freshAccounts: true,
        });
        expect(started.ok).toBe(true);

        await waitUntil(() => (TERMINAL as readonly string[]).includes(sc.coordinator.phase), 120_000, '(d) auto-stop');

        // AC-2 trên kênh THẬT: status 'error', stopReason "E2:", ≤ 60s kể từ start
        expect(sc.coordinator.phase).toBe('error');
        expect(sc.db.finishStatus).toBe('error');
        expect(sc.coordinator.stopReason ?? '').toMatch(/^E2:/);
        expect(Date.now() - startWall).toBeLessThan(60_000);
        expect(sc.db.writeRunFinishCount).toBe(1);

        // Kênh B: gateway accept MỌI connection rồi drop — socketConnections = đủ user
        expect(sc.gateway.socketConnections).toBe(USER_COUNT);

        // Window tại lúc E2: ≥ 50 attempts, 100% fail, mọi fail là 'reject' (io server disconnect)
        const w = windowState(sc.coordinator);
        expect(w.attempts).toBeGreaterThanOrEqual(50);
        expect(w.fails).toBe(w.attempts);
        expect(w.byType.timeout + w.byType.transport + w.byType.reject + w.byType.other).toBe(w.fails);
        expect(w.byType.reject).toBe(w.fails); // kênh B = reject (không timeout/transport)

        // F-T7-2 cốt lõi: MỌI user accept-then-drop → phase failed — không user kẹt 'connecting' giả,
        // không "attempt thành công" trống; usersFailed == userCount tại tick bắn E2
        const last = sc.coordinator.lastTick;
        expect(last?.counters.usersFailed).toBe(USER_COUNT);
        expect(last?.counters.connectFails).toBe(USER_COUNT);
        expect(last?.counters.usersConnected).toBe(0); // không user nào "connected" giả
        expect(last?.rates.connectFailRate).toBeGreaterThan(30);

        // AC-4: log E2 đủ 8 trường + regex (ST-7) — byType toàn reject
        const line = spy.e2ErrorLines().find((l) => l.startsWith('E2: auto-stop: connect fail'));
        expect(line).toBeDefined();
        expect(line).toMatch(E2_LOG_RE);
        expect(line).toContain('byType=timeout:0,transport:0,reject:');
      } finally {
        spy.restore();
        await sc.stop();
      }
    },
    150_000,
  );
});
