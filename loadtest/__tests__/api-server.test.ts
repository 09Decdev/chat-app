/**
 * Integration tests — HTTP API (ApiServer): admin auth + gate + history/replay.
 * Dùng db `loadtest_test_api` (cùng instance postgres-loadtest) — không đụng db thật.
 * Nếu không kết nối được DB → suite tự skip.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getEnv } from '../config';
import type { LoadTestEnv } from '../config';
import { LoadTestCoordinator } from '../coordinator';
import { ApiServer } from '../api-server';
import { LoadtestStore } from '../db/store';
import { DbWriter } from '../db/writer';
import type { QueryResult } from '../db/result';
import type { RunConfig } from '../types';

const TEST_DB_URL = process.env.LOADTEST_TEST_API_DATABASE_URL || 'postgresql://appuser:secret@localhost:5439/loadtest_test_api';
const AUTH_SECRET = 'test-secret-for-api-tests';
const MACHINE_ID = os.hostname();

/** Unwrap QueryResult — throw nếu DB fail (test kỳ vọng thành công). */
function expectOk<T>(r: QueryResult<T>): T[] {
  if (!r.ok) throw new Error(`DB error: ${r.error.message}`);
  return r.rows;
}

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
      LOADTEST_ALLOW_REGISTER: 'true', // T-06: register gate mặc định false — test register cần bật
      LOADTEST_RATE_LIMIT_DISABLED: 'true', // T-06: suite cũ không dính 429 (test 429 riêng)
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper: parse-anybody body
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
    const row = expectOk(await store.findAdminByLogin('admin1'))[0];
    expect(row?.passwordHash).toMatch(/^scrypt\$/);
  });

  it('register trùng username/email → 409, không tạo bản ghi mới', async () => {
    const r = await request('POST', '/api/loadtest/auth/register', {
      body: { username: 'admin1', email: 'other@loadtest.local', password: 'Abc123!@' },
    });
    expect(r.status).toBe(409);
    expect(r.body.success).toBe(false);
    expect(r.body.statusCode).toBe(409);
    const rows = expectOk(await store.listRuns());
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
    expectOk(await store.insertRun({
      runId: 'lt-hist1', status: 'running', machineId: MACHINE_ID, startAt: 1000,
      gatewayUrl: 'http://localhost:3000', targetUsers: 1000, workerCount: 2,
      configJson: JSON.stringify({ runId: 'lt-hist1', targetUsers: 1000 }),
    }));
    expectOk(await store.finalizeRun('lt-hist1', {
      status: 'finished',
      stopReason: 'duration hết',
      summaryJson: JSON.stringify({ runId: 'lt-hist1', status: 'finished', summary: { successRate: 99, echoRate: 95 } }),
      endAt: 5000,
      durationSec: 4,
    }));
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
    expectOk(await store.insertMetricSamples([
      { runId: 'lt-hist1', ts: 1000, phase: 'steady', elapsedSec: 1, usersCreated: 10, usersConnected: 10, usersActive: 9, usersQueued: 0, usersInRoom: 6, actionsTotal: 100, successTotal: 95, failTotal: 5, echoOk: 90, echoSent: 100, queueCount: 2, roomCount: 1, droppedOutbox: 0, reconnectCount: 0, rateLimitedNoEcho: 3, successRate: 95, echoRate: 90, actionsPerSecJson: '{"chat":10}', latencyJson: '{"p50":10,"p95":20,"p99":30}', errorsJson: '[{"code":"HTTP_429","count":5}]', serverJson: '{}', workersJson: '{}' },
    ]));
    expectOk(await store.insertLogEvent('lt-hist1', 'info', 'start run', 100));
    expectOk(await store.insertLogEvent('lt-hist1', 'error', 'boom', 200));

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

  it('B-2: shutdown mid-run → finalize UPDATE xong trước pool.end() (run không kẹt running)', async () => {
    const writer = new DbWriter(store, fs.mkdtempSync(path.join(os.tmpdir(), 'lt-api-shutdown-')));
    await writer.startup();
    const cfg: RunConfig = {
      runId: 'lt-shutdown1', targetUsers: 1000, rampRate: 100, rampMode: 'rate',
      durationMin: 1, durationSec: 60,
      profile: { chat: 40, read: 30, comment: 20, like: 10, view: 0 },
      gatewayUrl: 'http://localhost:3000', workerCount: 1, socketsPerWorker: 1000,
      registerRamp: 100, useExistingAccounts: true, freshAccounts: false, seed: 1, createdAt: Date.now(),
    };
    await writer.writeRunStart(cfg);
    // Không await — simulate writeRunFinish đang bay (B-2 race cũ: fire-and-forget).
    const finishPromise = writer.writeRunFinish('lt-shutdown1', 'stopped', 'shutdown-mid-run', null, Date.now());
    await writer.shutdown(); // B-2: shutdown() await finalizePromise TRƯỚC pool.end()
    await finishPromise;
    // Dùng store riêng để verify (store chính đã bị writer.shutdown() đóng pool).
    const verifyStore = new LoadtestStore(TEST_DB_URL);
    await verifyStore.connect();
    try {
      const row = expectOk(await verifyStore.getRun('lt-shutdown1'))[0];
      expect(row.status).toBe('stopped');
    } finally {
      await verifyStore.disconnect();
    }
  });
});

// ─── Regression T-05 — DB down → history 503 (không 0 giả / [] im lặng) ─────
// KHÔNG cần Postgres lên: store disabled → mọi history route phải trả 503 rõ ràng.

describe('api-server — DB down → history 503 (không 0 giả)', () => {
  async function startDbDownApi(): Promise<{ api: ApiServer; token: string }> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-api-dbdown-'));
    const env = getEnv({
      LOADTEST_PORT: '0',
      LOADTEST_HOST: '127.0.0.1',
      LOADTEST_DATA_DIR: tmpDir,
      LOADTEST_DATABASE_URL: TEST_DB_URL,
    });
    const badStore = new LoadtestStore(TEST_DB_URL); // không connect → enabled=false
    const coordinator = new LoadTestCoordinator(env);
    const api = new ApiServer(env, coordinator, badStore, AUTH_SECRET);
    await api.listen();
    const { createSessionToken } = await import('../auth');
    const token = createSessionToken({ id: 1, username: 'admin1' }, AUTH_SECRET).token;
    return { api, token };
  }

  it('GET /runs/{id}/metrics → 503, KHÔNG trả total 0 giả', async () => {
    const { api, token } = await startDbDownApi();
    try {
      const res = await fetch(`http://127.0.0.1:${api.port}/api/loadtest/runs/lt-any/metrics`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as { success?: boolean; data?: unknown };
      expect(res.status).toBe(503);
      expect(body.success).toBe(false);
      expect(body.data).toBeUndefined(); // countMetricSamples lỗi → KHÔNG total 0
    } finally {
      await api.close();
    }
  });

  it('GET /runs → 503, không [] im lặng', async () => {
    const { api, token } = await startDbDownApi();
    try {
      const res = await fetch(`http://127.0.0.1:${api.port}/api/loadtest/runs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = (await res.json()) as { success?: boolean };
      expect(res.status).toBe(503);
      expect(body.success).toBe(false);
    } finally {
      await api.close();
    }
  });
});

// ─── Regression T-06 — CORS + body validation (không cần Postgres) ─────────────

/** Start server không DB (đủ cho CORS / body / gate / rate-limit test). */
async function startNoDbApi(overrides: Record<string, string>): Promise<{ api: ApiServer; env: LoadTestEnv }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-api-t06-'));
  const env = getEnv({
    LOADTEST_PORT: '0',
    LOADTEST_HOST: '127.0.0.1',
    LOADTEST_DATA_DIR: tmpDir,
    ...overrides,
  });
  const coordinator = new LoadTestCoordinator(env);
  const api = new ApiServer(env, coordinator, undefined, AUTH_SECRET);
  await api.listen();
  return { api, env };
}

describe('api-server — CORS + body validation (T-06)', () => {
  it('CORS preflight OPTIONS → 204 + ACAO echo; KHÔNG còn `*`; origin lạ không có ACAO', async () => {
    const { api } = await startNoDbApi({ LOADTEST_CORS_ORIGIN: 'http://localhost:5173' });
    try {
      const opts = await fetch(`http://127.0.0.1:${api.port}/api/loadtest/start`, {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' },
      });
      expect(opts.status).toBe(204);
      expect(opts.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
      expect(opts.headers.get('access-control-allow-origin')).not.toContain('*');

      const ok = await fetch(`http://127.0.0.1:${api.port}/api/loadtest/health`, {
        headers: { Origin: 'http://localhost:5173' },
      });
      expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');

      const disallowed = await fetch(`http://127.0.0.1:${api.port}/api/loadtest/health`, {
        headers: { Origin: 'http://evil.example.com' },
      });
      expect(disallowed.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await api.close();
    }
  });

  it('readBody: JSON hỏng → 400 { success:false, message:"JSON body không hợp lệ" }; non-object → 400', async () => {
    const { api } = await startNoDbApi({});
    try {
      const bad = await fetch(`http://127.0.0.1:${api.port}/api/loadtest/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      });
      const badBody = (await bad.json()) as { success?: boolean; message?: string };
      expect(bad.status).toBe(400);
      expect(badBody.success).toBe(false);
      expect(badBody.message).toBe('JSON body không hợp lệ');

      const nonObj = await fetch(`http://127.0.0.1:${api.port}/api/loadtest/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '"just a string"',
      });
      const nonObjBody = (await nonObj.json()) as { success?: boolean; message?: string };
      expect(nonObj.status).toBe(400);
      expect(nonObjBody.message).toBe('JSON body không hợp lệ');
    } finally {
      await api.close();
    }
  });

  it('FIX-7: body > 1MB → 413 BODY_TOO_LARGE + socket bị hủy (server vẫn phục vụ request sau)', async () => {
    const { api } = await startNoDbApi({});
    try {
      const big = 'x'.repeat(1024 * 1024 + 1024); // > 1MB
      const res = await fetch(`http://127.0.0.1:${api.port}/api/loadtest/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: big }),
      });
      const body = (await res.json()) as { success?: boolean; statusCode?: number; error?: string };
      expect(res.status).toBe(413);
      expect(body.success).toBe(false);
      expect(body.error).toBe('BODY_TOO_LARGE');
      // Connection không kẹt do client còn gửi — request mới vẫn phục vụ bình thường
      const after = await fetch(`http://127.0.0.1:${api.port}/api/loadtest/health`);
      expect(after.status).toBe(200);
    } finally {
      await api.close();
    }
  });

  it('requestId: mọi response có header X-Request-Id + envelope error có requestId', async () => {
    const { api } = await startNoDbApi({});
    try {
      const res = await fetch(`http://127.0.0.1:${api.port}/api/loadtest/status`); // 401 (thiếu token)
      expect(res.headers.get('x-request-id')).toBeTruthy();
      const body = (await res.json()) as { requestId?: string };
      expect(body.requestId).toBeTruthy();
    } finally {
      await api.close();
    }
  });
});

describe('api-server — register gate (T-06, LOADTEST_ALLOW_REGISTER=false)', () => {
  it('POST /auth/register → 403 REGISTER_DISABLED (chưa chạm body/DB)', async () => {
    const { api } = await startNoDbApi({ LOADTEST_ALLOW_REGISTER: 'false' });
    try {
      const res = await fetch(`http://127.0.0.1:${api.port}/api/loadtest/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'gateuser', email: 'gate@loadtest.local', password: 'Abc123!@' }),
      });
      const body = (await res.json()) as { success?: boolean; statusCode?: number; error?: string };
      expect(res.status).toBe(403);
      expect(body.success).toBe(false);
      expect(body.statusCode).toBe(403);
      expect(body.error).toBe('REGISTER_DISABLED');
    } finally {
      await api.close();
    }
  });
});

// ─── Regression T-07 — health shape + /metrics tool (không cần Postgres) ─────────

describe('api-server — health (T-07, US-OBS-1) + /metrics (G-10)', () => {
  it('GET /api/loadtest/health DB không kết nối → 200 status down + db down (không 500, không ok giả)', async () => {
    const { api } = await startNoDbApi({});
    try {
      const res = await fetch(`http://127.0.0.1:${api.port}/api/loadtest/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success?: boolean;
        data?: {
          status?: string;
          db?: string;
          redis?: string;
          workers?: string;
          version?: string;
          uptimeSec?: number;
          timestamp?: number;
        };
      };
      expect(body.success).toBe(true);
      // FIX-2: db không cấu hình (down) + redis chưa kết nối (down) → cả 2 down → status 'down'
      expect(body.data?.status).toBe('down');
      expect(body.data?.db).toBe('down');
      expect(body.data?.redis).toBe('down');
      expect(typeof body.data?.version).toBe('string');
      expect(typeof body.data?.uptimeSec).toBe('number');
      expect(typeof body.data?.timestamp).toBe('number');
    } finally {
      await api.close();
    }
  });

  it('GET /metrics → Prometheus text có dbWriteFail + apiErrors (KHÔNG phải /api/loadtest/metrics)', async () => {
    const { api } = await startNoDbApi({});
    try {
      const res = await fetch(`http://127.0.0.1:${api.port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      const text = await res.text();
      expect(text).toContain('lt_dbWriteFail');
      expect(text).toContain('lt_apiErrors');
      expect(text).toContain('lt_worker_alive');
      // /api/loadtest/metrics vẫn là tick-history (KHÔNG bị đổi route) — cần token auth thật
      const { createSessionToken } = await import('../auth');
      const token = createSessionToken({ id: 1, username: 'admin1' }, AUTH_SECRET).token;
      const history = await fetch(`http://127.0.0.1:${api.port}/api/loadtest/metrics`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(history.status).toBe(200);
      const json = (await history.json()) as { success?: boolean; data?: { ticks?: unknown[] } };
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data?.ticks)).toBe(true);
    } finally {
      await api.close();
    }
  });
});

// ─── Regression T-06 — rate-limit (cần Postgres: login 401 đếm fail) ───────────

describeDb('api-server — rate-limit (T-06)', () => {
  async function freshRlServer(disabled: boolean): Promise<{ api: ApiServer; store: LoadtestStore }> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-api-rl-'));
    const env = getEnv({
      LOADTEST_PORT: '0',
      LOADTEST_HOST: '127.0.0.1',
      LOADTEST_DATA_DIR: tmpDir,
      LOADTEST_DATABASE_URL: TEST_DB_URL,
      LOADTEST_ALLOW_REGISTER: 'true',
      LOADTEST_RATE_LIMIT_DISABLED: disabled ? 'true' : 'false',
    });
    const store = new LoadtestStore(env.databaseUrl);
    await store.connect();
    await store.ensureSchema();
    await (store as unknown as { query: (sql: string) => Promise<unknown[]> }).query(
      `TRUNCATE admin_users, runs, pools, pool_accounts, metric_samples, log_events RESTART IDENTITY CASCADE`,
    );
    const coordinator = new LoadTestCoordinator(env);
    const api = new ApiServer(env, coordinator, store, AUTH_SECRET);
    await api.listen();
    return { api, store };
  }

  async function registerLogin(port: number, username: string, password: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/api/loadtest/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  }

  it('>5 login sai/60s cùng IP → 429 + retryAfterSec + Retry-After; disable → không 429', async () => {
    // Server A: rate limit ON
    const a = await freshRlServer(false);
    try {
      await fetch(`http://127.0.0.1:${a.api.port}/api/loadtest/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'rladmin', email: 'rl@loadtest.local', password: 'Abc123!@' }),
      });
      for (let i = 0; i < 5; i++) {
        const res = await registerLogin(a.api.port, 'rladmin', 'WrongPass1');
        expect(res.status).toBe(401);
      }
      const sixth = await registerLogin(a.api.port, 'rladmin', 'WrongPass1');
      expect(sixth.status).toBe(429);
      const body = (await sixth.json()) as { success?: boolean; statusCode?: number; error?: string; retryAfterSec?: number };
      expect(body.success).toBe(false);
      expect(body.statusCode).toBe(429);
      expect(body.error).toBe('RATE_LIMITED');
      expect(body.retryAfterSec).toBeGreaterThan(0);
      expect(sixth.headers.get('retry-after')).toBeTruthy();
      expect(sixth.headers.get('x-ratelimit-remaining')).toBe('0');
    } finally {
      await a.api.close();
      await a.store.disconnect();
    }

    // Server B: LOADTEST_RATE_LIMIT_DISABLED=true → 6 login sai vẫn 401 (không 429)
    const b = await freshRlServer(true);
    try {
      await fetch(`http://127.0.0.1:${b.api.port}/api/loadtest/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'rloff', email: 'rloff@loadtest.local', password: 'Abc123!@' }),
      });
      for (let i = 0; i < 6; i++) {
        const res = await registerLogin(b.api.port, 'rloff', 'WrongPass1');
        expect(res.status).toBe(401);
      }
    } finally {
      await b.api.close();
      await b.store.disconnect();
    }
  });

  it('FIX-10: 429 đếm thêm fail window (6 fail giữ block lâu hơn — không fix sẽ 401 ở mốc t=60s)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const a = await freshRlServer(false);
      try {
        await fetch(`http://127.0.0.1:${a.api.port}/api/loadtest/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'rl429', email: 'rl429@loadtest.local', password: 'Abc123!@' }),
        });
        // 5 login sai ở t=0..4000ms
        for (let i = 0; i < 5; i++) {
          const res = await registerLogin(a.api.port, 'rl429', 'WrongPass1');
          expect(res.status).toBe(401);
          vi.advanceTimersByTime(1000);
        }
        // t=10000: 6th → 429 (FIX-10: đếm thêm 1 fail)
        vi.advanceTimersByTime(5000);
        const sixth = await registerLogin(a.api.port, 'rl429', 'WrongPass1');
        expect(sixth.status).toBe(429);
        // t=60000: fail t=0 hết hạn (cutoff=0); với fix còn 5 fail (1000,2000,3000,4000,10000) → vẫn blocked
        vi.advanceTimersByTime(50_000);
        const seventh = await registerLogin(a.api.port, 'rl429', 'WrongPass1');
        expect(seventh.status).toBe(429);
      } finally {
        await a.api.close();
        await a.store.disconnect();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('FIX-10: 400 body error đếm fail window (4 login 401 + 1 body 400 → 6th bị 429)', async () => {
    const a = await freshRlServer(false);
    try {
      await fetch(`http://127.0.0.1:${a.api.port}/api/loadtest/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'rl400', email: 'rl400@loadtest.local', password: 'Abc123!@' }),
      });
      for (let i = 0; i < 4; i++) {
        const res = await registerLogin(a.api.port, 'rl400', 'WrongPass1');
        expect(res.status).toBe(401);
      }
      // 1 body 400 (JSON hỏng) → đếm 1 fail
      const badBody = await fetch(`http://127.0.0.1:${a.api.port}/api/loadtest/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{invalid json',
      });
      expect(badBody.status).toBe(400);
      // 6th → 429 (5 fail đã đủ)
      const sixth = await registerLogin(a.api.port, 'rl400', 'WrongPass1');
      expect(sixth.status).toBe(429);
    } finally {
      await a.api.close();
      await a.store.disconnect();
    }
  });
});

// ─── Regression T-06 FIX-9 — coordinator stop(true) giữa finishRun đang in-flight ──────────
// Không cần Postgres: mock DbWriter có writeRunFinish chậm (gate). Verify stop(true) thứ 2
// AWAIT finishRun đang chạy (không drop finalize → shutdown đóng pool an toàn).

describe('coordinator — stop(true) chờ finishRun in-flight (FIX-9, B-2 race)', () => {
  it('stop(true) lần 2 không resolve cho tới khi finishRun (writeRunFinish) xong', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const mockDbWriter = {
      writeRunFinish: vi.fn(async () => {
        await gate;
      }),
    } as unknown as DbWriter;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-stop-race-'));
    const env = getEnv({ LOADTEST_REPORTS_DIR: tmpDir, LOADTEST_DATA_DIR: tmpDir });
    const coordinator = new LoadTestCoordinator(env, {}, mockDbWriter);
    // Force phase running — bỏ qua provisioning (không cần Redis/DB thật).
    (coordinator as unknown as { phase: string }).phase = 'ramping';

    const p1 = coordinator.stop(true); // finishRun bắt đầu, writeRunFinish chờ gate
    expect((coordinator as unknown as { finishing: boolean }).finishing).toBe(true);

    const p2 = coordinator.stop(true); // lần 2 — phải chờ finishPromise
    let finished2 = false;
    void p2.then(() => {
      finished2 = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(finished2).toBe(false); // chưa chờ finishRun xong → chưa resolve

    release();
    await p1;
    await p2;
    expect(finished2).toBe(true);
    expect(mockDbWriter.writeRunFinish).toHaveBeenCalledTimes(1);
  });
});