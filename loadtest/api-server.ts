/**
 * MAYogu LoadTest Tool — HTTP API server (native node:http, không framework mới).
 * T-06 (S-6): router + composition root — handlers tách ra `loadtest/routes/*`.
 * Guards (auth / rate / gate) áp dụng TẠI route table (B-3) — handler KHÔNG tự gọi guard.
 *
 * Route | Guards
 * - POST /auth/register → gate (LOADTEST_ALLOW_REGISTER) + rate 'register' (fail window/IP)
 * - POST /auth/login      → rate 'login' (fail window/IP)
 * - POST /start           → rate 'start' (token bucket 1/10s/IP)
 * - POST /allowlist, /cleanup, DELETE /runs/{id} → rate 'write' (OFF mặc định)
 * - mọi route khác (trừ /health, /auth/*) → auth Bearer (PRD C1)
 *
 * CORS allowlist từ LOADTEST_CORS_ORIGIN (mặc định http://localhost:5173) — echo origin, KHÔNG `*`.
 * Envelope: { success, statusCode, message, timestamp, error?, requestId? } — additive.
 */

import * as http from 'node:http';
import type { LoadTestEnv } from './config';
import type { LoadTestCoordinator } from './coordinator';
import type { LoadtestStore } from './db/store';
import { loadAuthSecret } from './auth';
import { ltLog } from './util';
import { toolMetrics } from './tool-metrics';
import {
  applyCors,
  BodyError,
  clientIp,
  failJson,
  makeRequestId,
  makeRouteCtx,
  parseOrigins,
  type RouteCtx,
} from './http-server';
import { requireAuth, registerGate } from './guards';
import { createRateLimiters, type RateLimiters, type RateKind } from './rate-limit';
import { authHandlers } from './routes/auth';
import { runHandlers } from './routes/run';
import { historyHandlers } from './routes/history';
import { settingsHandlers } from './routes/settings';

type RouteHandler = (ctx: RouteCtx, req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  auth: boolean;
  gate?: boolean;
  rate?: RateKind;
  handler: RouteHandler;
}

/** Compile pattern `/runs/:id` → regex + param names. */
function compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:([a-zA-Z_]+)/g, (_, name: string) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${escaped}$`), paramNames };
}

function route(method: Route['method'], pattern: string, handler: RouteHandler, extra: Partial<Omit<Route, 'method' | 'pattern' | 'handler'>> = {}): Route {
  const { regex, paramNames } = compilePattern(pattern);
  return { method, pattern, regex, paramNames, auth: false, handler, ...extra };
}

const ROUTES: Route[] = [
  // Public (no auth) — health + auth + tool metrics (Prometheus)
  route('GET', '/api/loadtest/health', runHandlers.health),
  route('GET', '/metrics', async (_ctx, _req, res) => {
    // T-07: tool metrics Prometheus — KHÔNG đụng /api/loadtest/metrics (tick-history dashboard).
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(toolMetrics.toPrometheusText());
  }),
  route('POST', '/api/loadtest/auth/login', authHandlers.login, { rate: 'login' }),
  route('POST', '/api/loadtest/auth/register', authHandlers.register, { gate: true, rate: 'register' }),
  // Auth (PRD C1)
  route('POST', '/api/loadtest/auth/logout', authHandlers.logout, { auth: true }),
  route('GET', '/api/loadtest/auth/me', authHandlers.me, { auth: true }),
  route('POST', '/api/loadtest/start', runHandlers.start, { auth: true, rate: 'start' }),
  route('POST', '/api/loadtest/stop', runHandlers.stop, { auth: true }),
  route('POST', '/api/loadtest/kill', runHandlers.kill, { auth: true }),
  route('POST', '/api/loadtest/pause', runHandlers.pause, { auth: true }),
  route('POST', '/api/loadtest/resume', runHandlers.resume, { auth: true }),
  route('GET', '/api/loadtest/status', runHandlers.status, { auth: true }),
  route('GET', '/api/loadtest/metrics', runHandlers.metrics, { auth: true }),
  route('GET', '/api/loadtest/users', runHandlers.users, { auth: true }),
  route('GET', '/api/loadtest/errors', runHandlers.errors, { auth: true }),
  route('GET', '/api/loadtest/logs', runHandlers.logs, { auth: true }),
  route('GET', '/api/loadtest/report', runHandlers.report, { auth: true }),
  route('GET', '/api/loadtest/report/export', runHandlers.reportExport, { auth: true }),
  // Settings
  route('GET', '/api/loadtest/config', settingsHandlers.config, { auth: true }),
  route('GET', '/api/loadtest/allowlist', settingsHandlers.allowlistGet, { auth: true }),
  route('POST', '/api/loadtest/allowlist', settingsHandlers.allowlistPost, { auth: true, rate: 'write' }),
  route('GET', '/api/loadtest/pools', settingsHandlers.pools, { auth: true }),
  route('POST', '/api/loadtest/cleanup', settingsHandlers.cleanup, { auth: true, rate: 'write' }),
  // History / Replay (PRD D1) — specific trước generic
  route('GET', '/api/loadtest/runs', historyHandlers.runsList, { auth: true }),
  route('GET', '/api/loadtest/runs/:id/metrics', historyHandlers.runMetrics, { auth: true }),
  route('GET', '/api/loadtest/runs/:id/logs', historyHandlers.runLogs, { auth: true }),
  route('GET', '/api/loadtest/runs/:id', historyHandlers.runDetail, { auth: true }),
  route('DELETE', '/api/loadtest/runs/:id', historyHandlers.runDelete, { auth: true, rate: 'write' }),
];

export class ApiServer {
  private server: http.Server;
  private authSecret: string;
  private origins: string[];
  private limiter: RateLimiters;
  /** Thời điểm server start — health uptime (T-07). */
  private startedAt: number;

  constructor(
    private env: LoadTestEnv,
    private coordinator: LoadTestCoordinator,
    private store?: LoadtestStore,
    authSecret?: string,
    startedAt = Date.now(),
  ) {
    this.authSecret = authSecret ?? loadAuthSecret(env.dataDir);
    this.origins = parseOrigins(process.env.LOADTEST_CORS_ORIGIN, env.corsOrigins);
    this.limiter = createRateLimiters(env);
    this.startedAt = startedAt;
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

  /** Đóng mọi connection đang mở (B-2: graceful shutdown — KHÔNG chờ keep-alive). */
  closeConnections(): Promise<void> {
    const server = this.server as http.Server & { closeAllConnections?: () => void };
    server.closeAllConnections?.();
    return this.close();
  }

  private url(req: http.IncomingMessage): URL {
    return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  }

  private matchRoute(method: string, p: string): (Route & { params: Record<string, string> }) | undefined {
    for (const r of ROUTES) {
      if (r.method !== method) continue;
      const m = r.regex.exec(p);
      if (!m) continue;
      const params: Record<string, string> = {};
      for (let i = 0; i < r.paramNames.length; i++) params[r.paramNames[i]] = m[i + 1];
      return { ...r, params };
    }
    return undefined;
  }

  private limiterLimit(rate: RateKind): number {
    if (rate === 'login' || rate === 'register') return this.env.rateLimitLoginFails;
    if (rate === 'start') return 1;
    if (rate === 'write') return this.env.rateLimitWriteBucket;
    return 0;
  }

  /** Ghi fail window post-response (B-6): mọi 4xx login/register = 1 fail; 2xx → clear. */
  private recordFail(route: Route, res: http.ServerResponse, ip: string): void {
    if (route.rate !== 'login' && route.rate !== 'register') return;
    if (res.statusCode >= 400) this.limiter.recordFailure(route.rate, ip);
    else this.limiter.clear(route.rate, ip);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const requestId = makeRequestId();
    res.setHeader('X-Request-Id', requestId);
    applyCors(req, res, this.origins);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    // FIX: path malformed (`GET /%zz`) → new URL() ném URIError TRƯỚC try/catch dưới →
    // `void this.handle(...)` reject → unhandled rejection → crash process (DoS không cần auth).
    let url: URL;
    try {
      url = this.url(req);
    } catch {
      toolMetrics.inc('apiErrors');
      return failJson(res, 400, 'URL không hợp lệ', { error: 'MALFORMED_URL', requestId });
    }
    const p = url.pathname;
    const method = req.method ?? 'GET';
    const ip = clientIp(req, this.env.trustProxy);
    const route = this.matchRoute(method, p);
    const ctx = makeRouteCtx({
      env: this.env,
      coordinator: this.coordinator,
      store: this.store,
      authSecret: this.authSecret,
      requestId,
      url,
      params: route?.params ?? {},
      startedAt: this.startedAt,
    });
    if (!route) return ctx.fail(res, 404, `Không có route: ${method} ${p}`);

    try {
      // 1. Gate (SEC-6) — register 403 chạy TRƯỚC body validation + rate check (403 vẫn tính 1 fail).
      if (route.gate && !registerGate(this.env)) {
        ctx.fail(res, 403, 'Đăng ký đã bị tắt (LOADTEST_ALLOW_REGISTER=false)', { error: 'REGISTER_DISABLED' });
        return this.recordFail(route, res, ip);
      }
      // 2. Auth (PRD C1)
      if (route.auth) {
        const auth = requireAuth(req, this.authSecret);
        if (!auth.ok) return ctx.fail(res, 401, auth.message);
        ctx.user = auth.user;
      }
      // 3. Rate limit (B-3 / US-SEC-4)
      if (route.rate && route.rate !== 'none') {
        const rl = this.limiter.check(route.rate, ip);
        if (!rl.allowed) {
          const retryAfterSec = rl.retryAfterSec ?? 1;
          res.setHeader('Retry-After', String(retryAfterSec));
          res.setHeader('X-RateLimit-Limit', String(this.limiterLimit(route.rate)));
          res.setHeader('X-RateLimit-Remaining', '0');
          res.setHeader('X-RateLimit-Reset', String(Math.ceil(Date.now() / 1000) + retryAfterSec));
          ctx.fail(res, 429, `Quá nhiều yêu cầu — thử lại sau ${retryAfterSec}s`, {
            error: 'RATE_LIMITED',
            retryAfterSec,
          });
          // FIX-10 (T-06): mọi 4xx login/register = 1 fail (kể cả 429) — đếm vào fail window.
          return this.recordFail(route, res, ip);
        }
      }
      // 4. Handler
      await route.handler(ctx, req, res);
      return this.recordFail(route, res, ip);
    } catch (err) {
      if (err instanceof BodyError) {
        // runId path lỗi (SB-2) — 404
        ctx.fail(res, err.statusCode, err.message, { error: err.statusCode === 413 ? 'BODY_TOO_LARGE' : 'INVALID_PATH' });
        // FIX-10 (T-06): 4xx body error của login/register cũng đếm fail.
        return this.recordFail(route, res, ip);
      }
      ltLog.error(`api error ${method} ${p}: ${err instanceof Error ? err.message : String(err)}`, { requestId });
      toolMetrics.inc('apiErrors');
      return ctx.fail(res, 500, 'Lỗi server, xem log với requestId', { error: 'SERVER_ERROR', requestId });
    }
  }
}