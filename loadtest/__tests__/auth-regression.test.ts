/**
 * T7 (DESIGN-loadtest-e2-connect-fail §9) — ST-9: auth regression.
 * Dashboard routes (/api/loadtest/metrics, /errors, /users, /logs) vẫn yêu cầu admin session:
 *   - KHÔNG token → 401
 *   - Token giả mạo → 401
 *   - Token hợp lệ (HMAC session) → 200 + field connect MỚI hiện diện (S-1: tick live đủ dữ liệu,
 *     không "0 giả" — connectAttempts/connectFails/connectFailsByType/usersFailed/rates.connectFailRate/hasConnectData).
 * KHÔNG cần Postgres (ApiServer không store) — chạy local, CI-safe.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getEnv } from '../config';
import { LoadTestCoordinator } from '../coordinator';
import { ApiServer } from '../api-server';
import { createSessionToken } from '../auth';
import type { RunConfig } from '../types';

const AUTH_SECRET = 't7-auth-secret-0123456789abcdef0123456789abcdef';

interface RouteCtxPriv {
  phase: string;
  runId: string;
  startAt: number;
  config: RunConfig | null;
  aggregateTick: () => Promise<void>;
}

describe('ST-9 — auth regression: dashboard routes yêu cầu admin session (DESIGN §9 T7)', () => {
  let api: ApiServer;
  let coordinator: LoadTestCoordinator;
  let port = 0;
  let token = '';

  beforeAll(async () => {
    const env = getEnv({
      LOADTEST_PORT: '0',
      LOADTEST_HOST: '127.0.0.1',
      LOADTEST_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'lt-st9-')),
      LOADTEST_REPORTS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'lt-st9-r-')),
    });
    coordinator = new LoadTestCoordinator(env);
    api = new ApiServer(env, coordinator, undefined, AUTH_SECRET); // không store — route test không cần DB
    await api.listen();
    port = api.port;
    token = createSessionToken({ id: 1, username: 'admin' }, AUTH_SECRET).token;

    // Tick live provisioning (như coordinator.test.ts T1) — để GET /metrics trả tick đủ field connect mới
    const p = coordinator as unknown as RouteCtxPriv;
    p.phase = 'provisioning';
    p.runId = 'lt-st9';
    p.startAt = Date.now();
    p.config = {
      runId: 'lt-st9', targetUsers: 1000, rampRate: 100, rampMode: 'rate',
      durationMin: 1, durationSec: 60,
      profile: { chat: 40, read: 30, comment: 20, like: 10, view: 0 },
      gatewayUrl: 'http://localhost:3000', workerCount: 1, socketsPerWorker: 1000,
      registerRamp: 100, useExistingAccounts: true, freshAccounts: false, seed: 1, createdAt: Date.now(),
    };
    await p.aggregateTick();
  });

  afterAll(async () => {
    await api.close();
  });

  async function req(p: string, authorization?: string) {
    const headers: Record<string, string> = {};
    if (authorization) headers.Authorization = authorization;
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body: body as Record<string, unknown> };
  }

  const AUTH_ROUTES = ['/api/loadtest/metrics', '/api/loadtest/errors', '/api/loadtest/users', '/api/loadtest/logs'];

  for (const p of AUTH_ROUTES) {
    it(`KHÔNG token → 401 (${p})`, async () => {
      const r = await req(p);
      expect(r.status).toBe(401);
    });
    it(`token hợp lệ → 200 (${p})`, async () => {
      const r = await req(p, `Bearer ${token}`);
      expect(r.status).toBe(200);
    });
  }

  it('token giả mạo → 401 (HMAC verify — auth.ts)', async () => {
    const r = await req('/api/loadtest/metrics', 'Bearer eyJzdWIiOiIxIn0.forged-sig');
    expect(r.status).toBe(401);
  });

  it('GET /metrics có token → tick chứa field connect MỚI (connectAttempts/connectFails/byType/usersFailed/rate + hasConnectData true)', async () => {
    const r = await req('/api/loadtest/metrics', `Bearer ${token}`);
    expect(r.status).toBe(200);
    const data = r.body.data as {
      ticks?: Array<{
        counters: Record<string, unknown>;
        rates: Record<string, unknown>;
        hasConnectData?: boolean;
      }>;
    };
    const ticks = data.ticks ?? [];
    expect(ticks.length).toBeGreaterThan(0);
    const tick = ticks[0];
    expect(tick.counters.connectAttempts).toBe(0);
    expect(tick.counters.connectFails).toBe(0);
    expect(tick.counters.connectFailsByType).toEqual({ timeout: 0, transport: 0, reject: 0, other: 0 });
    expect(tick.counters.usersFailed).toBe(0);
    expect(tick.rates.connectFailRate).toBe(0);
    expect(tick.hasConnectData).toBe(true); // tick LIVE — UI không hiển thị "0 giả" (S-1/UI-1)
  });

  it('GET /errors có token → 200 { top, samples } đủ shape (dashboard không vỡ)', async () => {
    const r = await req('/api/loadtest/errors', `Bearer ${token}`);
    expect(r.status).toBe(200);
    const data = r.body.data as { top?: unknown; samples?: unknown };
    expect(Array.isArray(data.top)).toBe(true);
    expect(Array.isArray(data.samples)).toBe(true);
  });

  it('GET /users có token → 200 { rows, total, phaseCounts } (không worker → rỗng, không crash)', async () => {
    const r = await req('/api/loadtest/users', `Bearer ${token}`);
    expect(r.status).toBe(200);
    const data = r.body.data as { rows?: unknown; total?: unknown; phaseCounts?: unknown };
    expect(Array.isArray(data.rows)).toBe(true);
    expect(typeof data.total).toBe('number');
    expect(data.phaseCounts).toBeDefined();
  });
});
