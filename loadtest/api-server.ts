/**
 * MAYogu LoadTest Tool — HTTP API server (native node:http, không framework mới).
 * Cung cấp toàn bộ contract dashboard (UI-SPEC Màn 1/2/5/6/7):
 * - POST /start, /stop, /pause, /resume
 * - GET /status, /metrics (polling 1s), /users, /errors, /report + export
 * - GET/POST /allowlist, POST /cleanup
 * - Admin auth: POST /auth/register|login|logout, GET /auth/me (PRD-loadtest-admin-auth Module A)
 * - Gate: mọi route (trừ /health, /auth/*) yêu cầu Authorization: Bearer <token> (PRD C1)
 * - History: GET /runs, /runs/{id}, /runs/{id}/metrics, /runs/{id}/logs, DELETE /runs/{id} (PRD D1)
 * Response theo convention hệ thống: { success, data } / { success, statusCode, message }.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import type { LoadTestEnv } from './config';
import { PRESETS, validateRunRequest, estimateInfra, loadSettings, saveSettings, mergedAllowlist } from './config';
import type { LoadTestCoordinator } from './coordinator';
import type { StartRunRequest } from './types';
import { ltLog, logHistory, normalizeUrl } from './util';
import { createRedis } from './auth-factory';
import { runCleanup, type CleanupResult } from './cleanup';
import { ticksToCsv, reportToMarkdown } from './report';
import { listPools, poolPath } from './auth-factory';
import type { LoadtestStore, MetricSampleRow, RunRow } from './db/store';
import { createSessionToken, loadAuthSecret, verifySessionToken } from './auth';
import { hashPassword, validatePasswordStrength, verifyPassword } from './db/password';

type JsonBody = Record<string, unknown>;

interface SessionUser {
  id: number;
  username: string;
}

export class ApiServer {
  private server: http.Server;
  private authSecret: string;

  constructor(
    private env: LoadTestEnv,
    private coordinator: LoadTestCoordinator,
    private store?: LoadtestStore,
    authSecret?: string,
  ) {
    this.authSecret = authSecret ?? loadAuthSecret(env.dataDir);
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  /** Port thực tế (0 = OS cấp — dùng trong test). */
  get port(): number {
    const addr = this.server.address();
    if (addr && typeof addr === 'object' && 'port' in addr) return addr.port;
    return this.env.port;
  }

  listen(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.env.port, this.env.host, () => {
        ltLog.info(`HTTP API listening on http://${this.env.host}:${this.port}/api/loadtest`);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private cors(res: http.ServerResponse) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  }

  private json(res: http.ServerResponse, status: number, body: unknown) {
    this.cors(res);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  private ok(res: http.ServerResponse, data: unknown) {
    this.json(res, 200, { success: true, statusCode: 200, data });
  }

  private fail(res: http.ServerResponse, status: number, message: string, extra: Record<string, unknown> = {}) {
    this.json(res, status, { success: false, statusCode: status, message, ...extra });
  }

  private async readBody(req: http.IncomingMessage): Promise<JsonBody> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return {};
    try {
      return JSON.parse(text) as JsonBody;
    } catch {
      return {};
    }
  }

  private url(req: http.IncomingMessage): URL {
    return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  }

  /** Verify Bearer token (HMAC, không decode) — ≤ 1ms, không DB lookup (PRD US-3). */
  private requireAuth(req: http.IncomingMessage): { ok: true; user: SessionUser } | { ok: false; message: string } {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) return { ok: false, message: 'Thiếu Authorization: Bearer <token>' };
    const result = verifySessionToken(m[1], this.authSecret);
    if (!result.ok) {
      return {
        ok: false,
        message: result.reason === 'expired' ? 'Phiên hết hạn, đăng nhập lại' : 'Token không hợp lệ',
      };
    }
    return { ok: true, user: { id: Number(result.payload.sub), username: result.payload.username } };
  }

  // ─── Routes ─────────────────────────────────────────────────────────────

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    this.cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = this.url(req);
    const p = url.pathname;
    const method = req.method ?? 'GET';

    try {
      // Public: health + auth
      if (method === 'GET' && p === '/api/loadtest/health') return this.ok(res, { status: 'ok' });
      if (p.startsWith('/api/loadtest/auth/')) return this.handleAuth(req, res, p, method);

      // Gate (PRD C1): mọi route khác yêu cầu token hợp lệ
      const auth = this.requireAuth(req);
      if (!auth.ok) return this.fail(res, 401, auth.message);

      if (method === 'GET' && p === '/api/loadtest/config') {
        const settings = loadSettings(this.env);
        return this.ok(res, {
          port: this.env.port,
          allowlist: mergedAllowlist(this.env),
          allowlistFromFile: settings.allowlist,
          gatewayUrl: this.env.gatewayUrl,
          maxTarget: this.env.maxTarget,
          maxDurationMin: this.env.maxDurationMin,
          maxRegisterRamp: this.env.maxRegisterRamp,
          presets: PRESETS,
          hasOtpSecret: !!this.env.otpSecret,
          hasRedisConfigured: !!this.env.redisUrl,
          reportsDir: this.env.reportsDir,
        });
      }

      if (method === 'POST' && p === '/api/loadtest/start') {
        const body = await this.readBody(req);
        const startReq: StartRunRequest = {
          targetUsers: Number(body.targetUsers),
          rampRate: Number(body.rampRate ?? 200),
          rampMode: (body.rampMode as 'rate' | 'minutes') ?? 'rate',
          durationMin: Number(body.durationMin),
          profile: body.profile as StartRunRequest['profile'],
          gatewayUrl: String(body.gatewayUrl ?? this.env.gatewayUrl),
          freshAccounts: Boolean(body.freshAccounts),
        };
        const envForGuard = { ...this.env, allowlist: mergedAllowlist(this.env) };
        const v = validateRunRequest(startReq, envForGuard);
        if (!v.ok) {
          return this.fail(res, 400, 'Cấu hình run không hợp lệ (SD-1 chặn cứng)', { errors: v.errors, warnings: v.warnings });
        }
        const result = await this.coordinator.start(startReq);
        if (!result.ok) return this.fail(res, 409, result.error ?? 'Không start được');
        return this.ok(res, {
          runId: result.config?.runId,
          config: result.config,
          warnings: v.warnings,
          estimate: estimateInfra(startReq.targetUsers, this.env),
        });
      }

      if (method === 'POST' && (p === '/api/loadtest/stop' || p === '/api/loadtest/kill')) {
        const body = await this.readBody(req);
        const force = p.endsWith('/kill') || body.force === true;
        await this.coordinator.stop(force);
        return this.ok(res, { stopped: true, force });
      }

      if (method === 'POST' && p === '/api/loadtest/pause') {
        this.coordinator.pause();
        return this.ok(res, { paused: true });
      }

      if (method === 'POST' && p === '/api/loadtest/resume') {
        this.coordinator.resume();
        return this.ok(res, { resumed: true });
      }

      if (method === 'GET' && p === '/api/loadtest/status') {
        const s = this.coordinator.getRunSnapshot();
        return this.ok(res, {
          ...s,
          elapsedSec: s.startAt > 0 ? Math.round((Date.now() - s.startAt) / 1000) : 0,
          isRunning: this.coordinator.isRunning,
        });
      }

      if (method === 'GET' && p === '/api/loadtest/metrics') {
        const since = Number(url.searchParams.get('since') ?? 0);
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 3600), 7200);
        let ticks = this.coordinator.tickHistory;
        if (since > 0) ticks = ticks.filter((t) => t.ts > since);
        ticks = ticks.slice(-limit);
        return this.ok(res, { ticks, runId: this.coordinator.runId });
      }

      if (method === 'GET' && p === '/api/loadtest/users') {
        const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
        const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') ?? 100)), 500);
        const filter = url.searchParams.get('filter') ?? undefined;
        const result = await this.coordinator.queryUsers(offset, limit, filter);
        return this.ok(res, { rows: result.rows, total: result.total, offset, limit });
      }

      if (method === 'GET' && p === '/api/loadtest/errors') {
        const samples = this.coordinator.errorSamples ?? [];
        return this.ok(res, {
          top: this.coordinator.lastTick?.errors ?? [],
          samples,
        });
      }

      if (method === 'GET' && p === '/api/loadtest/logs') {
        const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') ?? 200)), 500);
        return this.ok(res, { logs: logHistory.slice(-limit) });
      }

      if (method === 'GET' && p === '/api/loadtest/report') {
        if (!this.coordinator.latestReport) {
          return this.fail(res, 404, 'Chưa có report — run chưa kết thúc');
        }
        return this.ok(res, this.coordinator.latestReport);
      }

      if (method === 'GET' && p === '/api/loadtest/report/export') {
        const format = String(url.searchParams.get('format') ?? 'json');
        if (!this.coordinator.latestReport) return this.fail(res, 404, 'Chưa có report');
        const r = this.coordinator.latestReport;
        if (format === 'md') {
          this.cors(res);
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="report-${r.runId}.md"` });
          return res.end(reportToMarkdown(r));
        }
        if (format === 'csv') {
          this.cors(res);
          res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="metrics-${r.runId}.csv"` });
          return res.end(ticksToCsv(r.runId, this.coordinator.tickHistory));
        }
        this.cors(res);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="report-${r.runId}.json"` });
        return res.end(JSON.stringify(r, null, 2));
      }

      if (method === 'GET' && p === '/api/loadtest/allowlist') {
        return this.ok(res, { allowlist: mergedAllowlist(this.env), fromFile: loadSettings(this.env).allowlist });
      }

      if (method === 'POST' && p === '/api/loadtest/allowlist') {
        const body = await this.readBody(req);
        const urls = Array.isArray(body.urls) ? (body.urls as unknown[]).filter((u): u is string => typeof u === 'string').map(normalizeUrl) : [];
        const s = loadSettings(this.env);
        s.allowlist = [...new Set(urls)];
        s.updatedAt = Date.now();
        saveSettings(this.env, s);
        return this.ok(res, { allowlist: mergedAllowlist(this.env) });
      }

      if (method === 'POST' && p === '/api/loadtest/cleanup') {
        const body = await this.readBody(req);
        const runId = String(body.runId ?? this.coordinator.runId ?? '');
        const dryRun = body.dryRun !== false;
        if (!runId) return this.fail(res, 400, 'runId bắt buộc');
        let accounts: { userId: string }[] = [];
        const pool = listPools(this.env.dataDir).find((p2) => p2.runId === runId);
        if (pool) {
          try {
            const parsed = JSON.parse(fs.readFileSync(poolPath(this.env.dataDir, runId), 'utf8')) as { accounts: { userId: string }[] };
            accounts = parsed.accounts ?? [];
          } catch {
            accounts = [];
          }
        }
        const redis = createRedis(this.env);
        try {
          await redis.connect();
          const result: CleanupResult = await runCleanup(redis, runId, accounts, dryRun);
          return this.ok(res, result);
        } finally {
          redis.disconnect();
        }
      }

      if (method === 'GET' && p === '/api/loadtest/pools') {
        if (this.store) {
          const pools = await this.store.listPools();
          if (!pools.ok) return this.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
          if (pools.rows.length) {
            return this.ok(res, {
              pools: pools.rows.map((pl) => ({
                runId: pl.poolId,
                targetUsers: pl.targetUsers,
                gatewayUrl: pl.gatewayUrl,
                accountCount: pl.accountCount,
                registered: pl.registered,
                loggedIn: pl.loggedIn,
                failed: pl.failed,
                importedFromFile: pl.importedFromFile,
                mtimeMs: pl.createdAt,
              })),
            });
          }
        }
        // fallback: file JSON khi DB trống/chưa import (PRD §2.5)
        return this.ok(res, { pools: listPools(this.env.dataDir) });
      }

      // ─── History / Replay (PRD D1) ────────────────────────────────────────
      if (!this.store) return this.fail(res, 503, 'Database chưa được kết nối');

      if (method === 'GET' && p === '/api/loadtest/runs') {
        const status = url.searchParams.get('status') ?? undefined;
        const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') ?? 500)), 2000);
        const rows = await this.store.listRuns({ status, limit });
        if (!rows.ok) return this.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
        return this.ok(res, { runs: rows.rows.map(toRunSummary), total: rows.rows.length });
      }

      if (method === 'GET' && isRunPath(p, '/metrics')) {
        const runId = runIdFromPath(p, '/metrics');
        const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') ?? 3600)), 20000);
        const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
        const rows = await this.store.listMetricSamples(runId, { limit, offset });
        if (!rows.ok) return this.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
        // D-6: countMetricSamples KHÔNG trả 0 giả khi DB lỗi — check ok trước khi cộng total.
        const total = await this.store.countMetricSamples(runId);
        if (!total.ok) return this.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
        return this.ok(res, { runId, ticks: rows.rows.map(toMetricTick), total: total.rows[0]?.n ?? 0 });
      }

      if (method === 'GET' && isRunPath(p, '/logs')) {
        const runId = runIdFromPath(p, '/logs');
        const limit = Math.min(Math.max(1, Number(url.searchParams.get('limit') ?? 200)), 500);
        const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));
        const level = url.searchParams.get('level') ?? undefined;
        const rows = await this.store.listLogEvents(runId, { limit, offset, level });
        if (!rows.ok) return this.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
        return this.ok(res, { runId, logs: rows.rows, total: rows.rows.length });
      }

      if (method === 'GET' && isRunPath(p, '')) {
        const runId = runIdFromPath(p, '');
        const r = await this.store.getRun(runId);
        if (!r.ok) return this.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
        if (r.rows.length === 0) return this.fail(res, 404, `Run ${runId} không tồn tại`);
        return this.ok(res, toRunDetail(r.rows[0]));
      }

      if (method === 'DELETE' && isRunPath(p, '')) {
        const runId = runIdFromPath(p, '');
        const deleted = await this.store.deleteRun(runId);
        if (!deleted.ok) return this.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
        if (deleted.rows.length === 0) return this.fail(res, 404, `Run ${runId} không tồn tại`);
        return this.ok(res, { deleted: true, runId });
      }

      return this.fail(res, 404, `Không có route: ${method} ${p}`);
    } catch (err) {
      ltLog.error(`api error ${method} ${p}: ${String(err)}`);
      return this.fail(res, 500, `Lỗi server: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Admin auth routes (PRD Module A) ───────────────────────────────────

  private async handleAuth(req: http.IncomingMessage, res: http.ServerResponse, p: string, method: string): Promise<void> {
    if (method === 'POST' && p === '/api/loadtest/auth/register') {
      const body = await this.readBody(req);
      const username = String(body.username ?? '').trim();
      const email = String(body.email ?? '').trim().toLowerCase();
      const password = String(body.password ?? '');
      if (!username || !email) return this.fail(res, 400, 'username và email bắt buộc');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return this.fail(res, 400, 'email không hợp lệ');
      const pwErr = validatePasswordStrength(password);
      if (pwErr) return this.fail(res, 400, pwErr);
      if (!this.store) return this.fail(res, 503, 'Database chưa được kết nối');
      const r = await this.store.createAdmin({ username, email, passwordHash: hashPassword(password) });
      if (!r.ok) {
        // 23505 = unique violation (trùng username/email) → 409; còn lại là DB fail → 503.
        if (r.error.code === '23505') return this.fail(res, 409, 'username hoặc email đã tồn tại');
        return this.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
      }
      const admin = r.rows[0];
      if (!admin) return this.fail(res, 409, 'username hoặc email đã tồn tại');
      ltLog.info(`[lt][auth] admin registered: ${username} (${email})`);
      return this.ok(res, { id: admin.id, username: admin.username, email: admin.email, displayName: admin.displayName, role: admin.role });
    }

    if (method === 'POST' && p === '/api/loadtest/auth/login') {
      const body = await this.readBody(req);
      const identifier = String(body.username ?? body.email ?? body.identifier ?? '').trim();
      const password = String(body.password ?? '');
      if (!identifier || !password) return this.fail(res, 400, 'username/email và password bắt buộc');
      if (!this.store) return this.fail(res, 503, 'Database chưa được kết nối');
      const r = await this.store.findAdminByLogin(identifier);
      if (!r.ok) return this.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
      const admin = r.rows[0];
      if (!admin || !admin.isActive || !verifyPassword(password, admin.passwordHash)) {
        // Không lộ thông tin account tồn tại hay không (PRD US-2)
        return this.fail(res, 401, 'Sai username/email hoặc mật khẩu');
      }
      void this.store.touchLastLogin(admin.id);
      const { token, expiresAt } = createSessionToken({ id: admin.id, username: admin.username }, this.authSecret);
      return this.ok(res, {
        token,
        expiresAt,
        user: { id: admin.id, username: admin.username, email: admin.email, displayName: admin.displayName, role: admin.role },
      });
    }

    if (method === 'POST' && p === '/api/loadtest/auth/logout') {
      const auth = this.requireAuth(req);
      if (!auth.ok) return this.fail(res, 401, auth.message);
      return this.ok(res, { loggedOut: true });
    }

    if (method === 'GET' && p === '/api/loadtest/auth/me') {
      const auth = this.requireAuth(req);
      if (!auth.ok) return this.fail(res, 401, auth.message);
      if (!this.store) return this.fail(res, 503, 'Database chưa được kết nối');
      const r = await this.store.getAdminById(auth.user.id);
      if (!r.ok) return this.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
      const admin = r.rows[0];
      if (!admin) return this.fail(res, 401, 'Tài khoản không tồn tại');
      return this.ok(res, { id: admin.id, username: admin.username, email: admin.email, displayName: admin.displayName, role: admin.role });
    }

    return this.fail(res, 404, `Không có route: ${method} ${p}`);
  }
}

// ─── Mapping helpers ────────────────────────────────────────────────────────

const RUN_PREFIX = '/api/loadtest/runs/';

/** Lấy runId từ path /api/loadtest/runs/{id}{suffix}. */
function runIdFromPath(p: string, suffix: string): string {
  const rest = p.slice(RUN_PREFIX.length);
  return decodeURIComponent(rest.slice(0, rest.length - suffix.length));
}

/** Kiểm tra path có dạng /api/loadtest/runs/{id}{suffix} với id là 1 segment. */
function isRunPath(p: string, suffix: string): boolean {
  const rest = p.slice(RUN_PREFIX.length);
  if (!rest) return false;
  const id = suffix ? rest.slice(0, rest.length - suffix.length) : rest;
  return id.length > 0 && !id.includes('/') && rest.endsWith(suffix);
}

function toRunSummary(row: RunRow) {
  return {
    runId: row.runId,
    status: row.status,
    machineId: row.machineId,
    startAt: row.startAt,
    endAt: row.endAt,
    durationSec: row.durationSec,
    gatewayUrl: row.gatewayUrl,
    targetUsers: row.targetUsers,
    workerCount: row.workerCount,
    stopReason: row.stopReason,
    poolSourceRunId: row.poolSourceRunId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRunDetail(row: RunRow) {
  let config: unknown = null;
  let report: unknown = null;
  try {
    config = JSON.parse(row.configJson);
  } catch {
    config = null;
  }
  try {
    report = row.summaryJson ? JSON.parse(row.summaryJson) : null;
  } catch {
    report = null;
  }
  return { ...toRunSummary(row), config, report };
}

function toMetricTick(row: MetricSampleRow) {
  const parse = (s: string, fallback: unknown): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return fallback;
    }
  };
  return {
    type: 'tick',
    runId: row.runId,
    ts: row.ts,
    phase: row.phase,
    elapsedSec: row.elapsedSec,
    counters: {
      usersCreated: row.usersCreated,
      usersConnected: row.usersConnected,
      usersActive: row.usersActive,
      usersQueued: row.usersQueued,
      usersInRoom: row.usersInRoom,
      actionsTotal: row.actionsTotal,
      successTotal: row.successTotal,
      failTotal: row.failTotal,
      echoOk: row.echoOk,
      echoSent: row.echoSent,
      queueCount: row.queueCount,
      roomCount: row.roomCount,
      droppedOutbox: row.droppedOutbox,
      reconnectCount: row.reconnectCount,
      rateLimitedNoEcho: row.rateLimitedNoEcho,
    },
    rates: { successRate: row.successRate, echoRate: row.echoRate },
    actionsPerSec: parse(row.actionsPerSecJson, {}),
    latency: parse(row.latencyJson, { p50: 0, p95: 0, p99: 0 }),
    errors: parse(row.errorsJson, []),
    server: parse(row.serverJson, {}),
    workers: parse(row.workersJson, {}),
  };
}