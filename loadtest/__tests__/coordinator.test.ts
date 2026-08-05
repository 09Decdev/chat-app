/**
 * Phase 4 council regression tests — coordinator lifecycle (KHÔNG cần Postgres/Redis/gateway):
 * - FIX-1 (C-1): start() trong cooldown/report → 409, không spawn (orphan worker race).
 * - FIX-2 (C-2): heartbeat detect (worker im lặng → kill); E3 toàn bộ worker chết → auto-stop
 *   (không kẹt 'ramping' vĩnh viễn); prune workerTicks khi worker chết.
 * - FIX-5 (C-3): E1 auto-stop sau manual stop KHÔNG đổi 'stopped' → 'error'.
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getEnv } from '../config';
import { LoadTestCoordinator } from '../coordinator';
import { WorkerFarm } from '../worker-farm';
import type { DbWriter } from '../db/writer';
import type { RunConfig, StartRunRequest } from '../types';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lt-coordinator-'));
}

function runConfig(): RunConfig {
  return {
    runId: 'lt-c1-test', targetUsers: 1000, rampRate: 100, rampMode: 'rate',
    durationMin: 1, durationSec: 60,
    profile: { chat: 40, read: 30, comment: 20, like: 10, view: 0 },
    gatewayUrl: 'http://localhost:3000', workerCount: 1, socketsPerWorker: 1000,
    registerRamp: 100, useExistingAccounts: true, freshAccounts: false, seed: 1, createdAt: Date.now(),
  };
}

function startReq(): StartRunRequest {
  return {
    targetUsers: 1000,
    rampRate: 100,
    rampMode: 'rate',
    durationMin: 1,
    profile: { chat: 40, read: 30, comment: 20, like: 10, view: 0 },
    gatewayUrl: 'http://localhost:3000',
  };
}

function mockDb(): DbWriter {
  return {
    writeRunStart: vi.fn(async () => {}),
    writeRunFinish: vi.fn(async () => {}),
    pushTick: vi.fn(() => {}),
  } as unknown as DbWriter;
}

type CoordinatorPriv = {
  phase: string;
  runId: string;
  startAt: number;
  config: RunConfig | null;
  workerTicks: Map<number, unknown>;
  workerHistograms: Map<number, unknown>;
  workerDeathTimes: number[];
  pendingRestarts: number;
  finishing: boolean;
  handleWorkerDied: (workerId: number) => void;
  finishRun: (kind: 'natural' | 'auto' | 'manual', reason: string, force?: boolean) => Promise<void>;
  aggregateTick: () => Promise<void>;
};

function priv(c: LoadTestCoordinator): CoordinatorPriv {
  return c as unknown as CoordinatorPriv;
}

// ─── FIX-1 (C-1): start-during-cooldown/report race — orphan workers ──────────

describe('coordinator — FIX-1: start() trong cooldown/report bị 409 (không spawn orphan)', () => {
  it('start() khi phase=cooldown → { ok:false, error "Đang chạy" }, không spawn, không tạo run row', async () => {
    const env = getEnv({ LOADTEST_DATA_DIR: tmpDir(), LOADTEST_REPORTS_DIR: tmpDir() });
    const db = mockDb();
    const c = new LoadTestCoordinator(env, {}, db);
    priv(c).phase = 'cooldown'; // worker cũ vẫn đang thoát

    const r = await c.start(startReq());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Đang chạy');
    expect(priv(c).phase).toBe('cooldown'); // không clobber phase
    // Không spawn worker mới (farm vẫn rỗng) + không INSERT runs (không có run row kẹt 'running')
    expect((c as unknown as { farm: WorkerFarm }).farm.total).toBe(0);
    expect(db.writeRunStart).not.toHaveBeenCalled();
    expect(db.writeRunFinish).not.toHaveBeenCalled();
  });

  it('start() khi phase=report (finalize cũ đang in-flight) → 409 — không clobber phase run', async () => {
    const env = getEnv({ LOADTEST_DATA_DIR: tmpDir(), LOADTEST_REPORTS_DIR: tmpDir() });
    const db = mockDb();
    const c = new LoadTestCoordinator(env, {}, db);
    priv(c).phase = 'report';

    const r = await c.start(startReq());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Đang chạy');
    expect(priv(c).phase).toBe('report');
    expect(db.writeRunStart).not.toHaveBeenCalled();
  });
});

// ─── FIX-2 (C-2): heartbeat + E3 zero-workers + prune ────────────────────────

describe('coordinator — FIX-2: heartbeat + E3 (không kẹt run vô hạn)', () => {
  it('worker im lặng (heartbeat timeout) khi ramping → bị SIGKILL (để restart/E3)', async () => {
    const env = getEnv({ LOADTEST_DATA_DIR: tmpDir(), LOADTEST_REPORTS_DIR: tmpDir() });
    const db = mockDb();
    const c = new LoadTestCoordinator(env, {}, db);
    const p = priv(c);
    p.phase = 'ramping';
    p.startAt = Date.now();
    p.config = runConfig();

    const kill = vi.fn();
    const staleSpy = vi.spyOn(WorkerFarm.prototype, 'checkHeartbeats').mockReturnValue([0]);
    const getSpy = vi.spyOn(WorkerFarm.prototype, 'get').mockReturnValue({
      id: 0, pid: 9999, alive: true, crashed: false, lastTickAt: 0,
      accounts: [], restartCount: 0, runSent: false,
      child: { kill, send: vi.fn(), connected: true },
    } as unknown as ReturnType<WorkerFarm['get']>);
    try {
      await p.aggregateTick();
      expect(kill).toHaveBeenCalledWith('SIGKILL'); // heartbeat-chết → kill → onWorkerDied → restart/E3
      // run vẫn còn → chưa finish (chỉ kill, không auto-stop khi chưa đủ worker chết)
      expect(priv(c).phase).toBe('ramping');
      expect(db.writeRunFinish).not.toHaveBeenCalled();
    } finally {
      staleSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  it('toàn bộ worker chết khi ramping (farm.total=0, không restart chờ) → E3 auto-stop ngay', async () => {
    const env = getEnv({ LOADTEST_DATA_DIR: tmpDir(), LOADTEST_REPORTS_DIR: tmpDir() });
    const db = mockDb();
    const c = new LoadTestCoordinator(env, {}, db);
    const p = priv(c);
    p.phase = 'ramping';
    p.runId = 'lt-c1-test';
    p.startAt = Date.now();
    p.config = runConfig();
    p.workerDeathTimes = [Date.now()]; // đã có worker chết thật
    p.pendingRestarts = 0; // không restart nào đang chờ backoff

    await p.aggregateTick();

    // Trước fix: guard `farm.total > 0` short-circuit → run kẹt 'ramping' vĩnh viễn (DB row 'running').
    expect(priv(c).phase).toBe('error');
    expect(db.writeRunFinish).toHaveBeenCalledTimes(1);
    expect(db.writeRunFinish).toHaveBeenCalledWith('lt-c1-test', 'error', expect.any(String), expect.anything(), expect.any(Number));
  });

  it('toàn bộ worker chết NHƯNG restart đang chờ backoff → KHÔNG auto-stop vội (chờ restart)', async () => {
    const env = getEnv({ LOADTEST_DATA_DIR: tmpDir(), LOADTEST_REPORTS_DIR: tmpDir() });
    const db = mockDb();
    const c = new LoadTestCoordinator(env, {}, db);
    const p = priv(c);
    p.phase = 'ramping';
    p.startAt = Date.now();
    p.config = runConfig();
    p.workerDeathTimes = [Date.now()];
    p.pendingRestarts = 1; // restart worker duy nhất đang chờ backoff 2s

    await p.aggregateTick();
    expect(priv(c).phase).toBe('ramping'); // không finish vội
    expect(db.writeRunFinish).not.toHaveBeenCalled();
  });

  it('worker chết → prune workerTicks/workerHistograms (tick cũ không cộng dồn mãi)', async () => {
    const env = getEnv({ LOADTEST_DATA_DIR: tmpDir(), LOADTEST_REPORTS_DIR: tmpDir() });
    const db = mockDb();
    const c = new LoadTestCoordinator(env, {}, db);
    const p = priv(c);
    p.phase = 'ramping';
    p.workerTicks.set(0, {});
    p.workerHistograms.set(0, {});

    const restartSpy = vi.spyOn(WorkerFarm.prototype, 'restart').mockResolvedValue(null);
    try {
      p.handleWorkerDied(0);
      expect(p.workerTicks.size).toBe(0);
      expect(p.workerHistograms.size).toBe(0);
      expect(p.workerDeathTimes.length).toBe(1);
      expect(restartSpy).toHaveBeenCalledWith(0, 2000);
      await new Promise((r) => setTimeout(r, 0)); // chờ .finally() của restart chain
      expect(p.pendingRestarts).toBe(0); // restart xong → counter reset
    } finally {
      restartSpy.mockRestore();
    }
  });
});

// ─── FIX-7: queryUsers TTL cache (không re-query worker mỗi poll dashboard) ─────

describe('coordinator — FIX-7: users TTL cache (poll /users không re-query mọi worker)', () => {
  function coordWithFakeWorker() {
    const env = getEnv({ LOADTEST_DATA_DIR: tmpDir(), LOADTEST_REPORTS_DIR: tmpDir() });
    const c = new LoadTestCoordinator(env, {}, mockDb());
    const farm = (c as unknown as { farm: WorkerFarm }).farm;
    // Giả 1 worker trong farm (không fork process thật).
    (farm as unknown as { workers: Map<number, unknown> }).workers.set(0, {
      id: 0, pid: 1, alive: true, crashed: false, lastTickAt: Date.now(),
      accounts: [], restartCount: 0, runSent: true, child: {},
    });
    return { c, farm };
  }

  const ROW = {
    index: 0, email: 'a@test.local', phase: 'idle', currentAction: null, lastActionAt: null,
    lastActionMs: null, messagesSent: 0, messagesEchoed: 0, roomId: null, socketConnected: false,
    reconnectCount: 0, outboxPending: 0, lastError: null,
  };

  it('2 queryUsers cùng filter/sort trong TTL → farm.queryUsers chỉ gọi 1 lần; offset khác slice từ cache', async () => {
    const { c } = coordWithFakeWorker();
    const spy = vi.spyOn(WorkerFarm.prototype, 'queryUsers').mockResolvedValue({ rows: [ROW], total: 1, phaseCounts: { idle: 1 } });
    try {
      const r1 = await c.queryUsers(0, 10, 'a', undefined, 'index', 'asc');
      expect(r1.total).toBe(1);
      expect(spy).toHaveBeenCalledTimes(1);

      // Lần 2 trong TTL → cache hit, KHÔNG query lại worker.
      const r2 = await c.queryUsers(0, 10, 'a', undefined, 'index', 'asc');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(r2.rows[0].email).toBe('a@test.local');

      // Offset/limit khác → slice từ merged+sorted cache, vẫn không query lại.
      const r3 = await c.queryUsers(1, 1, 'a', undefined, 'index', 'asc');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(r3.rows).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('filter/sort khác → miss cache (query lại worker)', async () => {
    const { c } = coordWithFakeWorker();
    const spy = vi.spyOn(WorkerFarm.prototype, 'queryUsers').mockResolvedValue({ rows: [ROW], total: 1, phaseCounts: { idle: 1 } });
    try {
      await c.queryUsers(0, 10, 'a', undefined, 'index', 'asc');
      await c.queryUsers(0, 10, 'b', undefined, 'index', 'asc'); // filter khác
      await c.queryUsers(0, 10, 'a', undefined, 'email', 'asc'); // sort khác
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });

  it('phase đổi (setPhase) → cache bị vô hiệu (query lại worker)', async () => {
    const { c } = coordWithFakeWorker();
    const spy = vi.spyOn(WorkerFarm.prototype, 'queryUsers').mockResolvedValue({ rows: [ROW], total: 1, phaseCounts: { idle: 1 } });
    try {
      await c.queryUsers(0, 10, 'a', undefined, 'index', 'asc');
      expect(spy).toHaveBeenCalledTimes(1);
      (priv(c) as unknown as { setPhase: (p: string) => void }).setPhase('ramping');
      await c.queryUsers(0, 10, 'a', undefined, 'index', 'asc');
      expect(spy).toHaveBeenCalledTimes(2); // cache cleared khi phase đổi
    } finally {
      spy.mockRestore();
    }
  });
});

describe('coordinator — T1: provisioning tick có connect metrics = 0 + hasConnectData true', () => {
  it('aggregateTick phase=provisioning → lastTick đủ field connect (0) + hasConnectData true', async () => {
    const env = getEnv({ LOADTEST_DATA_DIR: tmpDir(), LOADTEST_REPORTS_DIR: tmpDir() });
    const db = mockDb();
    const c = new LoadTestCoordinator(env, {}, db);
    const p = priv(c);
    p.phase = 'provisioning';
    p.runId = 'lt-c1-test';
    p.startAt = Date.now();
    p.config = runConfig();

    await p.aggregateTick();

    const t = c.lastTick;
    expect(t).not.toBeNull();
    expect(t!.phase).toBe('provisioning');
    expect(t!.counters.connectAttempts).toBe(0);
    expect(t!.counters.connectFails).toBe(0);
    expect(t!.counters.connectFailsByType).toEqual({ timeout: 0, transport: 0, reject: 0, other: 0 });
    expect(t!.counters.usersFailed).toBe(0);
    expect(t!.rates.connectFailRate).toBe(0);
    expect(t!.hasConnectData).toBe(true); // tick LIVE (DESIGN §2.1)
  });
});

describe('coordinator — FIX-5: E1 auto-stop sau manual stop không flip stopped → error', () => {
  it('manual stop (provisioning) → phase stopped; finishRun("auto", E1) sau đó bị bỏ qua', async () => {
    const env = getEnv({ LOADTEST_DATA_DIR: tmpDir(), LOADTEST_REPORTS_DIR: tmpDir() });
    const db = mockDb();
    const c = new LoadTestCoordinator(env, {}, db);
    priv(c).phase = 'provisioning';

    await c.stop(false); // finishRun('manual') → doFinishRun → phase 'stopped'
    expect(priv(c).phase).toBe('stopped');

    // E1 của provisionAndLaunch chạy tiếp SAU khi stop xong — trước fix: finishRun lần 2
    // đổi 'stopped' → 'error' + writeRunFinish 2 lần (run 'stopped' bị ghi đè 'error').
    await priv(c).finishRun('auto', 'E1: register fail 60% > 50%');
    expect(priv(c).phase).toBe('stopped'); // KHÔNG flip sang error
    expect(db.writeRunFinish).toHaveBeenCalledTimes(1);
    expect(db.writeRunFinish).toHaveBeenCalledWith(expect.any(String), 'stopped', expect.any(String), expect.anything(), expect.any(Number));
  });
});
