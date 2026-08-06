/**
 * Integration tests — DB access layer (LoadtestStore) trên Postgres test riêng.
 * Dùng db `loadtest_test` (cùng instance postgres-loadtest, port 5439) để không đụng db thật.
 * Nếu không kết nối được DB → suite tự skip (CI chạy không cần Postgres).
 *
 * T-05: QueryResult contract — mọi call site đọc `ok` trước khi dùng `rows`.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LoadtestStore } from '../db/store';
import { DbWriter } from '../db/writer';
import { hashPassword } from '../db/password';
import { toolMetrics } from '../tool-metrics';
import type { QueryResult } from '../db/result';

const TEST_DB_URL = process.env.LOADTEST_TEST_DATABASE_URL || 'postgresql://appuser:secret@localhost:5439/loadtest_test';
const MACHINE_ID = os.hostname();

/** Unwrap QueryResult — throw nếu DB fail (test kỳ vọng thành công). */
function expectOk<T>(r: QueryResult<T>): T[] {
  if (!r.ok) throw new Error(`DB error: ${r.error.message}`);
  return r.rows;
}

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
  await (s as unknown as { query: (sql: string) => Promise<unknown> }).query(
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
    const admin = expectOk(await store.createAdmin({
      username: 'alpha',
      email: 'alpha@loadtest.local',
      passwordHash: hashPassword('Abc123!@'),
      displayName: 'Alpha',
    }))[0];
    expect(admin).not.toBeNull();
    expect(admin!.username).toBe('alpha');
    expect(admin!.passwordHash).toMatch(/^scrypt\$/);
    expect(admin!.role).toBe('admin');

    const byLogin = expectOk(await store.findAdminByLogin('alpha@loadtest.local'))[0];
    expect(byLogin?.id).toBe(admin!.id);

    const byId = expectOk(await store.getAdminById(admin!.id))[0];
    expect(byId?.email).toBe('alpha@loadtest.local');
    await store.disconnect();
  });

  it('createAdmin trùng username/email → QueryError 23505 (caller trả 409)', async () => {
    const store = new LoadtestStore(TEST_DB_URL);
    await store.connect();
    await store.createAdmin({ username: 'dup', email: 'dup@loadtest.local', passwordHash: 'x' });
    const dup = await store.createAdmin({ username: 'dup', email: 'other@loadtest.local', passwordHash: 'y' });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.code).toBe('23505');
    const dup2 = await store.createAdmin({ username: 'other', email: 'dup@loadtest.local', passwordHash: 'y' });
    expect(dup2.ok).toBe(false);
    if (!dup2.ok) expect(dup2.error.code).toBe('23505');
    await store.disconnect();
  });

  it('touchLastLogin cập nhật last_login_at', async () => {
    const store = new LoadtestStore(TEST_DB_URL);
    await store.connect();
    const admin = expectOk(await store.createAdmin({ username: 'touch', email: 'touch@loadtest.local', passwordHash: 'x' }))[0];
    const now = Date.now();
    await store.touchLastLogin(admin!.id, now);
    const after = expectOk(await store.getAdminById(admin!.id))[0];
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

    const rows = expectOk(await store.listRuns());
    expect(rows.map((r) => r.runId)).toEqual(['lt-test2', 'lt-test1']); // startAt desc

    const filtered = expectOk(await store.listRuns({ status: 'running' }));
    expect(filtered.length).toBe(2);

    await store.finalizeRun('lt-test1', {
      status: 'finished', stopReason: 'duration hết', summaryJson: JSON.stringify({ ok: true }), endAt: 5000, durationSec: 4,
    });
    const done = expectOk(await store.getRun('lt-test1'))[0];
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
    const n = expectOk(await store.markRunsRunningAsError(MACHINE_ID, 'crash-detect')).length;
    expect(n).toBe(1);
    const r1 = expectOk(await store.getRun('crash-1'))[0];
    expect(r1?.status).toBe('error');
    expect(r1?.stopReason).toContain('crash-detect');
    const r2 = expectOk(await store.getRun('crash-2'))[0];
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
    const list = expectOk(await store.listMetricSamples('lt-m1'));
    expect(list.length).toBe(2);
    expect(list[0].ts).toBe(1000);
    expect(list[1].ts).toBe(2000);
    expect(list[0].usersCreated).toBe(10);
    expect(expectOk(await store.countMetricSamples('lt-m1'))[0]?.n).toBe(2);
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
    const all = expectOk(await store.listLogEvents('lt-l1'));
    expect(all.map((l) => l.level)).toEqual(['info', 'warn', 'error']);
    const errors = expectOk(await store.listLogEvents('lt-l1', { level: 'error' }));
    expect(errors.length).toBe(1);
    expect(errors[0].msg).toBe('boom');
    const limited = expectOk(await store.listLogEvents('lt-l1', { limit: 2 }));
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
    const p = expectOk(await store.getPool('lt-p1'))[0];
    expect(p?.poolId).toBe('lt-p1');
    expect(p?.accountCount).toBe(2);
    expect(expectOk(await store.listPools())).toHaveLength(1);
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
    const list = expectOk(await store.listPoolAccounts('lt-p2'));
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
    const list = expectOk(await store.listPoolAccounts('lt-p3'));
    expect(list[0].status).toBe('failed');
    expect(list[0].lastErrorCode).toBe('LOGIN_FAIL');
    expect(list[0].lastUsedRunId).toBe('lt-r9');
    expect(list[0].lastLoginAt).toBe(12345);
    await store.disconnect();
  });

  it('findPool chọn pool MỚI NHẤT khớp gateway + targetUsers (DB reuse)', async () => {
    const store = new LoadtestStore(TEST_DB_URL);
    await store.connect();
    await store.upsertPool({
      poolId: 'lt-fp1', gatewayUrl: 'http://localhost:3000', targetUsers: 1000,
      accountCount: 1, registered: 1, loggedIn: 0, failed: 0, errorsJson: '{}', reusedByRunIdsJson: '[]', createdAt: 1000,
    });
    await store.upsertPool({
      poolId: 'lt-fp2', gatewayUrl: 'http://localhost:3000', targetUsers: 1000,
      accountCount: 1, registered: 1, loggedIn: 0, failed: 0, errorsJson: '{}', reusedByRunIdsJson: '[]', createdAt: 2000,
    });
    await store.upsertPool({
      poolId: 'lt-fp3', gatewayUrl: 'http://localhost:3001', targetUsers: 1000,
      accountCount: 1, registered: 1, loggedIn: 0, failed: 0, errorsJson: '{}', reusedByRunIdsJson: '[]', createdAt: 3000,
    });
    const r = expectOk(await store.findPool('http://localhost:3000', 1000));
    expect(r).toHaveLength(1);
    expect(r[0].poolId).toBe('lt-fp2'); // created_at DESC
    const none = expectOk(await store.findPool('http://localhost:9999', 1000));
    expect(none).toHaveLength(0); // no pool ≠ DB fail (ok:true, rows rỗng)
    await store.disconnect();
  });

  it('markPoolReused append runId idempotent + KHÔNG đụng per-account (login outcome ghi sau login thật)', async () => {
    const store = new LoadtestStore(TEST_DB_URL);
    await store.connect();
    await store.upsertPool({
      poolId: 'lt-mr1', gatewayUrl: 'http://localhost:3000', targetUsers: 1000,
      accountCount: 1, registered: 1, loggedIn: 0, failed: 0, errorsJson: '{}', reusedByRunIdsJson: '[]',
    });
    await store.insertPoolAccounts([
      { poolId: 'lt-mr1', email: 'mr@test.vn', password: 'pw', userId: 'u', displayName: 'MR', deviceInfo: {}, dateOfBirth: '2000-01-01', country: 'VN', status: 'registered' },
    ]);
    await store.markPoolReused('lt-mr1', 'lt-run-1');
    await store.markPoolReused('lt-mr1', 'lt-run-1'); // idempotent — không trùng
    await store.markPoolReused('lt-mr1', 'lt-run-2');
    const p = expectOk(await store.getPool('lt-mr1'))[0];
    expect(JSON.parse(p!.reusedByRunIdsJson)).toEqual(['lt-run-1', 'lt-run-2']);
    // markPoolReused chỉ đánh dấu reuse ở mức pool — KHÔNG ghi 'logged_in' giả cho
    // account trước khi login thật (writePool ghi outcome sau login).
    const acc = expectOk(await store.listPoolAccounts('lt-mr1'))[0];
    expect(acc?.status).toBe('registered');
    expect(acc?.lastLoginAt).toBeNull();
    expect(acc?.lastUsedRunId).toBeNull();
    const missing = await store.markPoolReused('lt-nonexistent', 'lt-run-x');
    expect(missing.ok).toBe(false);
    await store.disconnect();
  });

  it('listPoolAccounts limit lớn cho reuse (cap 100k, không chỉ 500)', async () => {
    const store = new LoadtestStore(TEST_DB_URL);
    await store.connect();
    await store.upsertPool({
      poolId: 'lt-p4', gatewayUrl: 'http://localhost:3000', targetUsers: 1000,
      accountCount: 3, registered: 3, loggedIn: 0, failed: 0, errorsJson: '{}', reusedByRunIdsJson: '[]',
    });
    await store.insertPoolAccounts(
      Array.from({ length: 3 }, (_, i) => ({
        poolId: 'lt-p4', email: `big${i}@test.vn`, password: 'pw', userId: `u${i}`, displayName: `B${i}`,
        deviceInfo: {}, dateOfBirth: '2000-01-01', country: 'VN', status: 'registered',
      })),
    );
    const all = expectOk(await store.listPoolAccounts('lt-p4', { limit: 100_000 }));
    expect(all).toHaveLength(3);
    await store.disconnect();
  });

  it('insertPoolAccounts fail (FK 23503) → error KHÔNG chứa sql/params/password (B-1)', async () => {
    const store = new LoadtestStore(TEST_DB_URL);
    await store.connect();
    const r = await store.insertPoolAccounts([
      { poolId: 'lt-nonexistent', email: 'a@test.vn', password: 'SuperSecretPw123', userId: 'u1', displayName: 'A', deviceInfo: {}, dateOfBirth: '2000-01-01', country: 'VN', status: 'registered' },
    ]);
    expect(r.ok).toBe(false); // pool không tồn tại → FK violation → không ghi được
    if (!r.ok) {
      expect('sql' in r.error).toBe(false);
      expect('params' in r.error).toBe(false);
      expect(JSON.stringify(r.error)).not.toContain('SuperSecretPw123');
    }
    await store.disconnect();
  });
});

describeDb('writer — import legacy pool JSON', () => {
  afterAll(async () => {
    await truncateAll();
  });

  it('importLegacyPools dùng created_at integer (toEpochMs/Math.trunc mtimeMs)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-import-'));
    const filePath = path.join(tmpDir, 'accounts-legacy1.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        runId: 'lt-legacy1',
        targetUsers: 1,
        gatewayUrl: 'http://localhost:3000',
        accounts: [{ email: 'a@test.vn', password: 'pw', userId: 'u1', displayName: 'A', country: 'VN' }],
      }),
      'utf8',
    );
    const mtimeMs = fs.statSync(filePath).mtimeMs; // float — phải trunc thành integer
    const store = new LoadtestStore(TEST_DB_URL);
    await store.connect();
    const writer = new DbWriter(store, tmpDir);
    await writer.importLegacyPools();
    const r = await store.getPool('lt-legacy1');
    expect(r.ok).toBe(true);
    const pool = r.ok ? r.rows[0] : null;
    expect(pool?.poolId).toBe('lt-legacy1');
    expect(pool?.createdAt).toBe(Math.trunc(mtimeMs));
    expect(Number.isInteger(pool?.createdAt)).toBe(true);
    const acc = await store.listPoolAccounts('lt-legacy1');
    expect(acc.ok).toBe(true);
    expect(acc.ok ? acc.rows.length : 0).toBe(1);
    await store.disconnect();
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
    const deleted = expectOk(await store.deleteRun('lt-del'));
    expect(deleted.length).toBe(1);
    expect(expectOk(await store.getRun('lt-del'))).toHaveLength(0);
    expect(expectOk(await store.countMetricSamples('lt-del'))[0]?.n).toBe(0);
    expect(expectOk(await store.listLogEvents('lt-del'))).toHaveLength(0);
    expect(expectOk(await store.deleteRun('lt-del'))).toHaveLength(0); // đã xóa
    await store.disconnect();
  });
});

// ─── Regression T-05 — KHÔNG cần Postgres (DB disabled) ─────────────────────

describe('db/store — DB disabled (không cần Postgres)', () => {
  it('countMetricSamples DB-disabled → ok:false (KHÔNG trả 0 giả — D-6)', async () => {
    const store = new LoadtestStore(TEST_DB_URL); // không connect → enabled=false
    const r = await store.countMetricSamples('lt-any');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('DB_DISABLED');
      expect('rows' in r).toBe(false);
    }
  });

  it('dbWriteFail tăng khi write fail (DB_DISABLED — US-DB-2)', async () => {
    toolMetrics.reset();
    const store = new LoadtestStore(TEST_DB_URL); // không connect → write fail
    await store.insertRun({
      runId: 'lt-x', status: 'running', machineId: 'm', startAt: 1,
      gatewayUrl: '/', targetUsers: 1, workerCount: 1, configJson: '{}',
    });
    expect(toolMetrics.getSnapshot().counters.dbWriteFail).toBe(1);
  });
});