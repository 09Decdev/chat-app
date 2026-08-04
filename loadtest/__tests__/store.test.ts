/**
 * Integration tests — DB access layer (LoadtestStore) trên Postgres test riêng.
 * Dùng db `loadtest_test` (cùng instance postgres-loadtest, port 5439) để không đụng db thật.
 * Nếu không kết nối được DB → suite tự skip (CI chạy không cần Postgres).
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as os from 'node:os';
import { LoadtestStore } from '../db/store';
import { hashPassword } from '../db/password';

const TEST_DB_URL = process.env.LOADTEST_TEST_DATABASE_URL || 'postgresql://appuser:secret@localhost:5439/loadtest_test';
const MACHINE_ID = os.hostname();

// Probe DB tại module load (top-level await) — nếu không lên được thì skip toàn bộ suite.
let dbAvailable = false;
try {
  const probe = new LoadtestStore(TEST_DB_URL);
  await probe.connect();
  if (probe.enabled) {
    await probe.ensureSchema();
    dbAvailable = true;
  }
  await probe.disconnect();
} catch {
  dbAvailable = false;
}

const describeDb = dbAvailable ? describe : describe.skip;

/** Truncate toàn bộ bảng dữ liệu (giữ schema + schema_version) — cô lập giữa các test. */
async function truncateAll(): Promise<void> {
  const s = new LoadtestStore(TEST_DB_URL);
  await s.connect();
  await s.ensureSchema();
  await (s as unknown as { query: (sql: string) => Promise<unknown[]> }).query(
    `TRUNCATE admin_users, runs, pools, pool_accounts, metric_samples, log_events RESTART IDENTITY CASCADE`,
  );
  await s.disconnect();
}

describeDb('store — admin_users', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await truncateAll();
  });

  it('createAdmin + findAdminByLogin + getAdminById', async () => {
    const store = new LoadtestStore(TEST_DB_URL);
    await store.connect();
    const admin = await store.createAdmin({
      username: 'alpha',
      email: 'alpha@loadtest.local',
      passwordHash: hashPassword('Abc123!@'),
      displayName: 'Alpha',
    });
    expect(admin).not.toBeNull();
    expect(admin!.username).toBe('alpha');
    expect(admin!.passwordHash).toMatch(/^scrypt\$/);
    expect(admin!.role).toBe('admin');

    const byLogin = await store.findAdminByLogin('alpha@loadtest.local');
    expect(byLogin?.id).toBe(admin!.id);

    const byId = await store.getAdminById(admin!.id);
    expect(byId?.email).toBe('alpha@loadtest.local');
    await store.disconnect();
  });

  it('createAdmin trùng username/email → null (caller trả 409)', async () => {
    const store = new LoadtestStore(TEST_DB_URL);
    await store.connect();
    await store.createAdmin({ username: 'dup', email: 'dup@loadtest.local', passwordHash: 'x' });
    const dup = await store.createAdmin({ username: 'dup', email: 'other@loadtest.local', passwordHash: 'y' });
    expect(dup).toBeNull();
    const dup2 = await store.createAdmin({ username: 'other', email: 'dup@loadtest.local', passwordHash: 'y' });
    expect(dup2).toBeNull();
    await store.disconnect();
  });

  it('touchLastLogin cập nhật last_login_at', async () => {
    const store = new LoadtestStore(TEST_DB_URL);
    await store.connect();
    const admin = await store.createAdmin({ username: 'touch', email: 'touch@loadtest.local', passwordHash: 'x' });
    const now = Date.now();
    await store.touchLastLogin(admin!.id, now);
    const after = await store.getAdminById(admin!.id);
    expect(after?.lastLoginAt).toBe(now);
    await store.disconnect();
  });
});

describeDb('store — runs + metric_samples + log_events', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await truncateAll();
  });

  it('insertRun + getRun + listRuns (sort startAt desc) + finalizeRun', async () => {
    const store = new LoadtestStore(TEST_DB_URL);
    await store.connect();
    const cfg = { runId: 'lt-test1', targetUsers: 1000, gatewayUrl: 'http://localhost:3000' };
    await store.insertRun({
      runId: 'lt-test1', status: 'running', machineId: MACHINE_ID, startAt: 1000,
      gatewayUrl: '/', targetUsers: 1000, workerCount: 2, configJson: JSON.stringify(cfg),
    });
    await store.insertRun({
      runId: 'lt-test2', status: 'running', machineId: MACHINE_ID, startAt: 2000,
      gatewayUrl: '/', targetUsers: 1000, workerCount: 2, configJson: JSON.stringify(cfg),
    });

    const rows = await store.listRuns();
    expect(rows.map((r) => r.runId)).toEqual(['lt-test2', 'lt-test1']); // startAt desc

    const filtered = await store.listRuns({ status: 'running' });
    expect(filtered.length).toBe(2);

    await store.finalizeRun('lt-test1', {
      status: 'finished', stopReason: 'duration hết', summaryJson: JSON.stringify({ ok: true }), endAt: 5000, durationSec: 4,
    });
    const done = await store.getRun('lt-test1');
    expect(done?.status).toBe('finished');
    expect(done?.stopReason).toBe('duration hết');
    expect(done?.durationSec).toBe(4);
    expect(JSON.parse(done!.summaryJson ?? '{}')).toEqual({ ok: true });
    await store.disconnect();
  });

  it('markRunsRunningAsError chỉ đánh dấu run của máy này (crash-detect)', async () => {
    const store = new LoadtestStore(TEST_DB_URL);
    await store.connect();
    await store.insertRun({
      runId: 'crash-1', status: 'running', machineId: MACHINE_ID, startAt: 1,
      gatewayUrl: '/', targetUsers: 1000, workerCount: 1, configJson: '{}',
    });
    await store.insertRun({
      runId: 'crash-2', status: 'running', machineId: 'other-machine', startAt: 1,
      gatewayUrl: '/', targetUsers: 1000, workerCount: 1, configJson: '{}',
    });
    const n = await store.markRunsRunningAsError(MACHINE_ID, 'crash-detect');
    expect(n).toBe(1);
    const r1 = await store.getRun('crash-1');
    expect(r1?.status).toBe('error');
    expect(r1?.stopReason).toContain('crash-detect');
    const r2 = await store.getRun('crash-2');
    expect(r2?.status).toBe('running'); // máy khác không đụng
    await store.disconnect();
  });

  it('insertMetricSamples batch + listMetricSamples theo ts + count', async () => {
    const store = new LoadtestStore(TEST_DB_URL);
    await store.connect();
    await store.insertRun({
      runId: 'lt-m1', status: 'running', machineId: MACHINE_ID, startAt: 1,
      gatewayUrl: '/', targetUsers: 1000, workerCount: 1, configJson: '{}',
    });
    await store.insertMetricSamples([
      {
        runId: 'lt-m1', ts: 1000, phase: 'steady', elapsedSec: 1,
        usersCreated: 10, usersConnected: 10, usersActive: 9, usersQueued: 1, usersInRoom: 6,
        actionsTotal: 100, successTotal: 95, failTotal: 5, echoOk: 90, echoSent: 100,
        queueCount: 2, roomCount: 1, droppedOutbox: 0, reconnectCount: 1, rateLimitedNoEcho: 3,
        successRate: 95, echoRate: 90, actionsPerSecJson: '{"chat":10}', latencyJson: '{"p50":10,"p95":20,"p99":30}',
        errorsJson: '[{"code":"HTTP_429","count":5}]', serverJson: '{"wsConnections":10}', workersJson: '{"alive":1,"total":1,"cpuAvg":50}',
      },
      {
        runId: 'lt-m1', ts: 2000, phase: 'steady', elapsedSec: 2,
        usersCreated: 10, usersConnected: 10, usersActive: 9, usersQueued: 1, usersInRoom: 6,
        actionsTotal: 100, successTotal: 95, failTotal: 5, echoOk: 90, echoSent: 100,
        queueCount: 2, roomCount: 1, droppedOutbox: 0, reconnectCount: 1, rateLimitedNoEcho: 3,
        successRate: 95, echoRate: 90, actionsPerSecJson: '{}', latencyJson: '{}', errorsJson: '[]', serverJson: '{}', workersJson: '{}',
      },
    ]);
    const list = await store.listMetricSamples('lt-m1');
    expect(list.length).toBe(2);
    expect(list[0].ts).toBe(1000);
    expect(list[1].ts).toBe(2000);
    expect(list[0].usersCreated).toBe(10);
    expect(await store.countMetricSamples('lt-m1')).toBe(2);
    await store.disconnect();
  });

  it('insertLogEvent + listLogEvents (filter level, limit)', async () => {
    const store = new LoadtestStore(TEST_DB_URL);
    await store.connect();
    await store.insertRun({
      runId: 'lt-l1', status: 'running', machineId: MACHINE_ID, startAt: 1,
      gatewayUrl: '/', targetUsers: 1000, workerCount: 1, configJson: '{}',
    });
    await store.insertLogEvent('lt-l1', 'info', 'start', 100);
    await store.insertLogEvent('lt-l1', 'warn', 'worker slow', 200);
    await store.insertLogEvent('lt-l1', 'error', 'boom', 300);
    const all = await store.listLogEvents('lt-l1');
    expect(all.map((l) => l.level)).toEqual(['info', 'warn', 'error']);
    const errors = await store.listLogEvents('lt-l1', { level: 'error' });
    expect(errors.length).toBe(1);
    expect(errors[0].msg).toBe('boom');
    const limited = await store.listLogEvents('lt-l1', { limit: 2 });
    expect(limited.length).toBe(2);
    await store.disconnect();
  });
});

describeDb('store — pools + pool_accounts', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await truncateAll();
  });

  it('upsertPool + getPool + listPools', async () => {
    const store = new LoadtestStore(TEST_DB_URL);
    await store.connect();
    await store.upsertPool({
      poolId: 'lt-p1', gatewayUrl: 'http://localhost:3000', targetUsers: 1000,
      accountCount: 2, registered: 2, loggedIn: 0, failed: 0,
      errorsJson: '{}', reusedByRunIdsJson: '[]', importedFromFile: null,
    });
    const p = await store.getPool('lt-p1');
    expect(p?.poolId).toBe('lt-p1');
    expect(p?.accountCount).toBe(2);
    expect(await store.listPools()).toHaveLength(1);
    await store.disconnect();
  });

  it('insertPoolAccounts idempotent theo UNIQUE(pool_id, email)', async () => {
    const store = new LoadtestStore(TEST_DB_URL);
    await store.connect();
    await store.upsertPool({
      poolId: 'lt-p2', gatewayUrl: 'http://localhost:3000', targetUsers: 1000,
      accountCount: 1, registered: 1, loggedIn: 0, failed: 0, errorsJson: '{}', reusedByRunIdsJson: '[]',
    });
    const acc = {
      poolId: 'lt-p2', email: 'a@test.vn', password: 'pw', userId: 'u1', displayName: 'A',
      deviceInfo: { installationId: 'x' }, dateOfBirth: '2000-01-01', country: 'VN', status: 'registered',
    };
    await store.insertPoolAccounts([acc]);
    await store.insertPoolAccounts([acc]); // chạy lại không sinh trùng
    const list = await store.listPoolAccounts('lt-p2');
    expect(list).toHaveLength(1);
    expect(list[0].email).toBe('a@test.vn');
    await store.disconnect();
  });

  it('updatePoolAccount cập nhật status/errorCode/lastLoginAt', async () => {
    const store = new LoadtestStore(TEST_DB_URL);
    await store.connect();
    await store.upsertPool({
      poolId: 'lt-p3', gatewayUrl: 'http://localhost:3000', targetUsers: 1000,
      accountCount: 1, registered: 1, loggedIn: 0, failed: 0, errorsJson: '{}', reusedByRunIdsJson: '[]',
    });
    await store.insertPoolAccounts([
      { poolId: 'lt-p3', email: 'b@test.vn', password: 'pw', userId: 'u2', displayName: 'B', deviceInfo: {}, dateOfBirth: '2000-01-01', country: 'VN', status: 'registered' },
    ]);
    await store.updatePoolAccount('lt-p3', 'b@test.vn', { status: 'failed', lastErrorCode: 'LOGIN_FAIL', lastUsedRunId: 'lt-r9', lastLoginAt: 12345 });
    const list = await store.listPoolAccounts('lt-p3');
    expect(list[0].status).toBe('failed');
    expect(list[0].lastErrorCode).toBe('LOGIN_FAIL');
    expect(list[0].lastUsedRunId).toBe('lt-r9');
    expect(list[0].lastLoginAt).toBe(12345);
    await store.disconnect();
  });
});

describeDb('store — deleteRun cascade', () => {
  it('xóa run kéo theo metric_samples + log_events', async () => {
    const store = new LoadtestStore(TEST_DB_URL);
    await store.connect();
    await store.ensureSchema();
    await store.insertRun({
      runId: 'lt-del', status: 'running', machineId: MACHINE_ID, startAt: 1,
      gatewayUrl: '/', targetUsers: 1000, workerCount: 1, configJson: '{}',
    });
    await store.insertMetricSamples([
      { runId: 'lt-del', ts: 1, phase: 'steady', elapsedSec: 1, usersCreated: 0, usersConnected: 0, usersActive: 0, usersQueued: 0, usersInRoom: 0, actionsTotal: 0, successTotal: 0, failTotal: 0, echoOk: 0, echoSent: 0, queueCount: 0, roomCount: 0, droppedOutbox: 0, reconnectCount: 0, rateLimitedNoEcho: 0, successRate: 100, echoRate: 100, actionsPerSecJson: '{}', latencyJson: '{}', errorsJson: '[]', serverJson: '{}', workersJson: '{}' },
    ]);
    await store.insertLogEvent('lt-del', 'info', 'x');
    const deleted = await store.deleteRun('lt-del');
    expect(deleted).toBe(true);
    expect(await store.getRun('lt-del')).toBeNull();
    expect(await store.countMetricSamples('lt-del')).toBe(0);
    expect(await store.listLogEvents('lt-del')).toHaveLength(0);
    expect(await store.deleteRun('lt-del')).toBe(false); // đã xóa
    await store.disconnect();
  });
});