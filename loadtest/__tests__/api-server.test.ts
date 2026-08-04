/**
 * Integration tests — HTTP API (ApiServer): admin auth + gate + history/replay.
 * Dùng db `loadtest_test_api` (cùng instance postgres-loadtest) — không đụng db thật.
 * Nếu không kết nối được DB → suite tự skip.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getEnv } from '../config';
import { LoadTestCoordinator } from '../coordinator';
import { ApiServer } from '../api-server';
import { LoadtestStore } from '../db/store';

const TEST_DB_URL = process.env.LOADTEST_TEST_API_DATABASE_URL || 'postgresql://appuser:secret@localhost:5439/loadtest_test_api';
const AUTH_SECRET = 'test-secret-for-api-tests';
const MACHINE_ID = os.hostname();

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

describeDb('api-server — admin auth + gate + history', () => {
  let store: LoadtestStore;
  let api: ApiServer;
  let coordinator: LoadTestCoordinator;
  let port = 0;
  let token = '';
  let adminId = 0;

  beforeAll(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-api-test-'));
    const env = getEnv({
      LOADTEST_PORT: '0',
      LOADTEST_HOST: '127.0.0.1',
      LOADTEST_DATA_DIR: tmpDir,
      LOADTEST_DATABASE_URL: TEST_DB_URL,
    });
    store = new LoadtestStore(env.databaseUrl);
    await store.connect();
    await store.ensureSchema();
    // cô lập: truncate bảng dữ liệu
    await (store as unknown as { query: (sql: string) => Promise<unknown[]> }).query(
      `TRUNCATE admin_users, runs, pools, pool_accounts, metric_samples, log_events RESTART IDENTITY CASCADE`,
    );

    coordinator = new LoadTestCoordinator(env);
    api = new ApiServer(env, coordinator, store, AUTH_SECRET);
    await api.listen();
    port = api.port;
  });

  afterAll(async () => {
    await api.close();
    await store.disconnect();
  });

  async function request(method: string, p: string, opts: { token?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body: body as { success?: boolean; statusCode?: number; message?: string; data?: any } };
  }

  // ─── Admin auth (PRD Module A) ──────────────────────────────────────────

  it('register admin → 200 { success, data } không chứa passwordHash', async () => {
    const r = await request('POST', '/api/loadtest/auth/register', {
      body: { username: 'admin1', email: 'admin1@loadtest.local', password: 'Abc123!@' },
    });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.data.username).toBe('admin1');
    expect(r.body.data.email).toBe('admin1@loadtest.local');
    expect(r.body.data.passwordHash).toBeUndefined();
    adminId = r.body.data.id;
    // DB lưu scrypt hash, không plaintext
    const row = await store.findAdminByLogin('admin1');
    expect(row?.passwordHash).toMatch(/^scrypt\$/);
  });

  it('register trùng username/email → 409, không tạo bản ghi mới', async () => {
    const r = await request('POST', '/api/loadtest/auth/register', {
      body: { username: 'admin1', email: 'other@loadtest.local', password: 'Abc123!@' },
    });
    expect(r.status).toBe(409);
    expect(r.body.success).toBe(false);
    expect(r.body.statusCode).toBe(409);
    const rows = await store.listRuns();
    expect(rows).toHaveLength(0); // không tạo gì
  });

  it('register password yếu (2 nhóm) → 400', async () => {
    const r = await request('POST', '/api/loadtest/auth/register', {
      body: { username: 'weak', email: 'weak@loadtest.local', password: 'abcdefgh' },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('3/4');
  });

  it('login sai password → 401 (không lộ account tồn tại)', async () => {
    const r = await request('POST', '/api/loadtest/auth/login', {
      body: { username: 'admin1', password: 'WrongPass1' },
    });
    expect(r.status).toBe(401);
    expect(r.body.success).toBe(false);
  });

  it('login đúng → 200 { token, expiresAt, user }', async () => {
    const r = await request('POST', '/api/loadtest/auth/login', {
      body: { username: 'admin1', password: 'Abc123!@' },
    });
    expect(r.status).toBe(200);
    expect(typeof r.body.data.token).toBe('string');
    expect(r.body.data.token).toContain('.');
    expect(r.body.data.expiresAt).toBeGreaterThan(Date.now());
    expect(r.body.data.user.username).toBe('admin1');
    token = r.body.data.token;
  });

  it('GET /auth/me với token hợp lệ → 200 user; token sai → 401', async () => {
    const ok = await request('GET', '/api/loadtest/auth/me', { token });
    expect(ok.status).toBe(200);
    expect(ok.body.data.username).toBe('admin1');
    const bad = await request('GET', '/api/loadtest/auth/me', { token: 'not-a-real-token' });
    expect(bad.status).toBe(401);
  });

  it('logout cần token → 200; thiếu token → 401', async () => {
    const ok = await request('POST', '/api/loadtest/auth/logout', { token });
    expect(ok.status).toBe(200);
    expect(ok.body.data.loggedOut).toBe(true);
    const bad = await request('POST', '/api/loadtest/auth/logout');
    expect(bad.status).toBe(401);
  });

  // ─── Gate (PRD C1) ──────────────────────────────────────────────────────

  it('mọi route protected thiếu token → 401; /health + /auth/register public', async () => {
    const status = await request('GET', '/api/loadtest/status');
    expect(status.status).toBe(401);
    const health = await request('GET', '/api/loadtest/health');
    expect(health.status).toBe(200);
    const reg = await request('POST', '/api/loadtest/auth/register', {
      body: { username: 'gatecheck', email: 'gatecheck@loadtest.local', password: 'Abc123!@' },
    });
    expect(reg.status).toBe(200);
  });

  it('token hợp lệ → /status trả 200', async () => {
    const r = await request('GET', '/api/loadtest/status', { token });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
  });

  // ─── History / Replay (PRD D1) ──────────────────────────────────────────

  it('GET /runs DB trống → mảng rỗng', async () => {
    const r = await request('GET', '/api/loadtest/runs', { token });
    expect(r.status).toBe(200);
    expect(r.body.data.runs).toEqual([]);
    expect(r.body.data.total).toBe(0);
  });

  it('GET /runs liệt kê run từ DB (sau restart) + filter status', async () => {
    await store.insertRun({
      runId: 'lt-hist1', status: 'running', machineId: MACHINE_ID, startAt: 1000,
      gatewayUrl: 'http://localhost:3000', targetUsers: 1000, workerCount: 2,
      configJson: JSON.stringify({ runId: 'lt-hist1', targetUsers: 1000 }),
    });
    await store.finalizeRun('lt-hist1', {
      status: 'finished',
      stopReason: 'duration hết',
      summaryJson: JSON.stringify({ runId: 'lt-hist1', status: 'finished', summary: { successRate: 99, echoRate: 95 } }),
      endAt: 5000,
      durationSec: 4,
    });
    const r = await request('GET', '/api/loadtest/runs', { token });
    expect(r.status).toBe(200);
    expect(r.body.data.runs).toHaveLength(1);
    expect(r.body.data.runs[0].runId).toBe('lt-hist1');
    expect(r.body.data.runs[0].status).toBe('finished');
    expect(r.body.data.runs[0].stopReason).toBe('duration hết');

    const filtered = await request('GET', '/api/loadtest/runs?status=running', { token });
    expect(filtered.body.data.runs).toHaveLength(0);
  });

  it('GET /runs/{id} → detail (config + report từ JSON); id không tồn tại → 404', async () => {
    const r = await request('GET', '/api/loadtest/runs/lt-hist1', { token });
    expect(r.status).toBe(200);
    expect(r.body.data.report.summary.successRate).toBe(99);
    expect(r.body.data.config.targetUsers).toBe(1000);

    const missing = await request('GET', '/api/loadtest/runs/lt-nope', { token });
    expect(missing.status).toBe(404);
  });

  it('GET /runs/{id}/metrics + /logs đọc từ DB', async () => {
    await store.insertMetricSamples([
      { runId: 'lt-hist1', ts: 1000, phase: 'steady', elapsedSec: 1, usersCreated: 10, usersConnected: 10, usersActive: 9, usersQueued: 0, usersInRoom: 6, actionsTotal: 100, successTotal: 95, failTotal: 5, echoOk: 90, echoSent: 100, queueCount: 2, roomCount: 1, droppedOutbox: 0, reconnectCount: 0, rateLimitedNoEcho: 3, successRate: 95, echoRate: 90, actionsPerSecJson: '{"chat":10}', latencyJson: '{"p50":10,"p95":20,"p99":30}', errorsJson: '[{"code":"HTTP_429","count":5}]', serverJson: '{}', workersJson: '{}' },
    ]);
    await store.insertLogEvent('lt-hist1', 'info', 'start run', 100);
    await store.insertLogEvent('lt-hist1', 'error', 'boom', 200);

    const m = await request('GET', '/api/loadtest/runs/lt-hist1/metrics', { token });
    expect(m.status).toBe(200);
    expect(m.body.data.ticks).toHaveLength(1);
    expect(m.body.data.ticks[0].counters.actionsTotal).toBe(100);
    expect(m.body.data.total).toBe(1);

    const l = await request('GET', '/api/loadtest/runs/lt-hist1/logs?level=error', { token });
    expect(l.status).toBe(200);
    expect(l.body.data.logs).toHaveLength(1);
    expect(l.body.data.logs[0].msg).toBe('boom');
  });

  it('DELETE /runs/{id} → 200 + cascade; rồi GET → 404', async () => {
    const del = await request('DELETE', '/api/loadtest/runs/lt-hist1', { token });
    expect(del.status).toBe(200);
    expect(del.body.data.deleted).toBe(true);
    const gone = await request('GET', '/api/loadtest/runs/lt-hist1', { token });
    expect(gone.status).toBe(404);
  });

  it('token hết hạn → 401 message "hết hạn"', async () => {
    const { createSessionToken } = await import('../auth');
    const expired = createSessionToken({ id: adminId, username: 'admin1' }, AUTH_SECRET, -1000).token;
    const r = await request('GET', '/api/loadtest/status', { token: expired });
    expect(r.status).toBe(401);
    expect(r.body.message).toContain('hết hạn');
  });
});