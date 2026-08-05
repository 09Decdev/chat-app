/**
 * T-11 (G-3) — Contract test: khoá EXTERNAL API contract của loadtest tool.
 * Consumer = frontend (dashboard) — UI đọc `success`/`data`, envelope shape KHÔNG được đổi.
 *
 * Với MỖI route trong bảng ROUTES (api-server.ts:68-105 — source of truth):
 *   - assert method + path tồn tại (không 404) và response là envelope JSON chuẩn
 *     `{ success, statusCode, message, timestamp }` (lỗi) / `{ success, statusCode, data }` (thành công).
 *   - Route protected: thiếu token → 401 envelope (không 404/500).
 * KHÔNG cần Postgres: store = undefined → route protected bị 401 TRƯỚC handler; route history/auth
 * trả 503 DB_UNAVAILABLE rõ ràng — vẫn đủ để assert envelope. (Contract DB-gated đầy đủ ở api-server.test.ts.)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getEnv } from '../config';
import type { LoadTestEnv } from '../config';
import { LoadTestCoordinator } from '../coordinator';
import { ApiServer } from '../api-server';
import { createSessionToken } from '../auth';

const AUTH_SECRET = 'test-secret-for-contract-tests';

/** Bảng route protected — phải khớp ROUTES (api-server.ts:79-104) — thêm route mới ở đây. */
const PROTECTED_ROUTES: { method: string; path: string }[] = [
  { method: 'POST', path: '/api/loadtest/auth/logout' },
  { method: 'GET', path: '/api/loadtest/auth/me' },
  { method: 'POST', path: '/api/loadtest/start' },
  { method: 'POST', path: '/api/loadtest/stop' },
  { method: 'POST', path: '/api/loadtest/kill' },
  { method: 'POST', path: '/api/loadtest/pause' },
  { method: 'POST', path: '/api/loadtest/resume' },
  { method: 'GET', path: '/api/loadtest/status' },
  { method: 'GET', path: '/api/loadtest/metrics' },
  { method: 'GET', path: '/api/loadtest/users' },
  { method: 'GET', path: '/api/loadtest/errors' },
  { method: 'GET', path: '/api/loadtest/logs' },
  { method: 'GET', path: '/api/loadtest/report' },
  { method: 'GET', path: '/api/loadtest/report/export' },
  { method: 'GET', path: '/api/loadtest/config' },
  { method: 'GET', path: '/api/loadtest/allowlist' },
  { method: 'POST', path: '/api/loadtest/allowlist' },
  { method: 'GET', path: '/api/loadtest/pools' },
  { method: 'POST', path: '/api/loadtest/cleanup' },
  { method: 'GET', path: '/api/loadtest/runs' },
  { method: 'GET', path: '/api/loadtest/runs/lt-contract/metrics' },
  { method: 'GET', path: '/api/loadtest/runs/lt-contract/logs' },
  { method: 'GET', path: '/api/loadtest/runs/lt-contract' },
  { method: 'DELETE', path: '/api/loadtest/runs/lt-contract' },
];

interface Envelope {
  success?: boolean;
  statusCode?: number;
  message?: string;
  timestamp?: number;
  requestId?: string;
  error?: string;
  data?: unknown;
}

describe('contract — external API (T-11, G-3)', () => {
  let api: ApiServer;
  let port = 0;
  let token = '';

  beforeAll(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-contract-'));
    const env: LoadTestEnv = getEnv({
      LOADTEST_PORT: '0',
      LOADTEST_HOST: '127.0.0.1',
      LOADTEST_DATA_DIR: tmpDir,
      LOADTEST_RATE_LIMIT_DISABLED: 'true', // R-6: contract test không dính 429
      // LOADTEST_ALLOW_REGISTER không set → gate mặc định false (SEC-6) → register 403.
    });
    const coordinator = new LoadTestCoordinator(env);
    api = new ApiServer(env, coordinator, undefined, AUTH_SECRET);
    await api.listen();
    port = api.port;
    token = createSessionToken({ id: 1, username: 'admin' }, AUTH_SECRET).token;
  });

  afterAll(async () => {
    await api.close();
  });

  async function call(method: string, p: string, body?: unknown): Promise<{ status: number; headers: Headers; body: Envelope | string }> {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: Envelope | string = text;
    try {
      parsed = JSON.parse(text) as Envelope;
    } catch {
      // text response (vd /metrics)
    }
    return { status: res.status, headers: res.headers, body: parsed };
  }

  function expectErrorEnvelope(body: unknown, status: number, extraCode?: string): void {
    const b = body as Envelope;
    expect(b.success).toBe(false);
    expect(b.statusCode).toBe(status);
    expect(typeof b.message).toBe('string');
    expect((b.message ?? '').length).toBeGreaterThan(0);
    expect(typeof b.timestamp).toBe('number');
    expect(typeof b.requestId).toBe('string'); // T-06: mọi response có requestId
    if (extraCode) expect(b.error).toBe(extraCode);
  }

  // ─── Protected routes: method + path + 401 envelope ──────────────────────

  it.each(PROTECTED_ROUTES)('$method $path → 401 envelope chuẩn (thiếu token)', async ({ method, path: p }) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify({}),
    });
    expect(r.status).toBe(401); // route tồn tại (không 404) và bị auth chặn (không 500)
    expect(r.headers.get('x-request-id')).toBeTruthy(); // T-06: header requestId
    expectErrorEnvelope(await r.json(), 401);
  });

  it('GET /api/loadtest/status với token hợp lệ → 200 envelope { success:true, statusCode:200, data, timestamp }', async () => {
    const r = await call('GET', '/api/loadtest/status');
    expect(r.status).toBe(200);
    const b = r.body as Envelope;
    expect(b.success).toBe(true);
    expect(b.statusCode).toBe(200);
    expect(b.data).toBeDefined();
    expect(typeof b.timestamp).toBe('number');
  });

  // ─── Public routes ───────────────────────────────────────────────────────

  it('GET /api/loadtest/health → 200 envelope success + data.status (T-07 shape)', async () => {
    const r = await call('GET', '/api/loadtest/health');
    expect(r.status).toBe(200);
    const b = r.body as Envelope;
    expect(b.success).toBe(true);
    expect(b.statusCode).toBe(200);
    expect(typeof (b.data as { status?: unknown })?.status).toBe('string');
  });

  it('GET /metrics → 200 text/plain Prometheus (không envelope — riêng biệt)', async () => {
    const r = await call('GET', '/metrics');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/plain');
    expect(typeof r.body).toBe('string');
  });

  it('POST /api/loadtest/auth/register (gate mặc định false) → 403 REGISTER_DISABLED envelope', async () => {
    const r = await call('POST', '/api/loadtest/auth/register', { username: 'c', email: 'c@loadtest.local', password: 'Abc123!@' });
    expect(r.status).toBe(403);
    expectErrorEnvelope(r.body, 403, 'REGISTER_DISABLED');
  });

  it('POST /api/loadtest/auth/login không DB → 503 envelope rõ ràng (không 200 giả, không [] im lặng)', async () => {
    const r = await call('POST', '/api/loadtest/auth/login', { username: 'admin1', password: 'Abc123!@' });
    expect(r.status).toBe(503);
    expectErrorEnvelope(r.body, 503);
  });

  // ─── Method/path matching + 404 envelope ─────────────────────────────────

  it('route không tồn tại → 404 envelope; method sai trên path đúng → 404 envelope (khớp chính xác)', async () => {
    const unknown = await call('GET', '/api/loadtest/does-not-exist');
    expect(unknown.status).toBe(404);
    expectErrorEnvelope(unknown.body, 404);

    const wrongMethod = await call('GET', '/api/loadtest/start'); // start chỉ chấp nhận POST
    expect(wrongMethod.status).toBe(404);
    expectErrorEnvelope(wrongMethod.body, 404);
  });

  // ─── CORS (T-06, SEC-2) ─────────────────────────────────────────────────

  it('OPTIONS preflight origin allow → 204 + ACAO echo (không `*`)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/loadtest/start`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(res.headers.get('access-control-allow-origin')).not.toContain('*');
  });
});
