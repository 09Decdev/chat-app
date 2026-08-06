/**
 * MAYogu LoadTest Tool — HTTP server helpers (T-06, zero-dep).
 * - `readBody` 1MB limit + 400 (JSON hỏng / non-object) + 413 (oversize) — US-API-1 / SB-3.
 * - `applyCors` allowlist từ `LOADTEST_CORS_ORIGIN` (mặc định http://localhost:5173) — echo origin, KHÔNG `*`.
 * - Envelope chuẩn `{ success, statusCode, message, timestamp, error?, requestId? }` — additive (frontend toApiError chỉ đọc success/statusCode/message).
 * - `makeRequestId` — requestId sinh 1 lần/request, echo header `X-Request-Id` (T-07 tiêu thụ).
 * - `RouteCtx` — context cho handler route (guards do dispatcher áp dụng — B-3).
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import type { LoadTestEnv } from './config';
import type { LoadTestCoordinator } from './coordinator';
import type { LoadtestStore } from './db/store';
import type { SessionUser } from './auth';

/** Lỗi body (400 JSON hỏng / 404 runId không hợp lệ / 413 quá lớn) — dispatcher map sang envelope. */
export class BodyError extends Error {
  constructor(public statusCode: 400 | 404 | 413, message: string) {
    super(message);
  }
}

/** requestId — 1 lần/request, echo `X-Request-Id` header + envelope error context. */
export function makeRequestId(): string {
  return crypto.randomUUID();
}

/** Parse allowlist origin từ env (comma-separated). Default http://localhost:5173 (R-7). */
export function parseOrigins(raw: string | undefined, def: string[] = ['http://localhost:5173']): string[] {
  const rawList = (raw ?? '').trim();
  if (!rawList) return def;
  const list = rawList.split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return def;
  return list.map((entry) => {
    if (entry === '*') return '*';
    try {
      return new URL(entry).origin;
    } catch {
      return entry;
    }
  });
}

/** Origin khớp allowlist (`new URL(origin).origin` vs entry). */
export function originAllowed(origin: string | undefined, origins: string[]): boolean {
  if (!origin) return false;
  if (origins.includes('*')) return true;
  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    return false;
  }
  return origins.includes(normalized);
}

/** Áp CORS headers — echo origin nếu nằm trong allowlist; KHÔNG `*` nếu không config. */
export function applyCors(req: http.IncomingMessage, res: http.ServerResponse, origins: string[]): void {
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  res.setHeader('Access-Control-Max-Age', '600');
  const origin = req.headers.origin;
  if (origin && originAllowed(origin, origins)) {
    res.setHeader('Access-Control-Allow-Origin', Array.isArray(origin) ? origin[0] : origin);
    res.setHeader('Vary', 'Origin');
  }
}

/** IP thật — KHÔNG tin X-Forwarded-For trừ LOADTEST_TRUST_PROXY=1 (chống spoof header). */
export function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string') {
      const first = fwd.split(',')[0].trim();
      if (first) return first;
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Envelope JSON — CORS đã được dispatcher áp dụng trước. */
export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Envelope success `{ success:true, statusCode:200, data, timestamp }`. */
export function okJson(res: http.ServerResponse, data: unknown): void {
  sendJson(res, 200, { success: true, statusCode: 200, data, timestamp: Date.now() });
}

/** Envelope lỗi `{ success:false, statusCode, message, timestamp, ...extra }`. */
export function failJson(
  res: http.ServerResponse,
  status: number,
  message: string,
  extra: Record<string, unknown> = {},
): void {
  sendJson(res, status, { success: false, statusCode: status, message, timestamp: Date.now(), ...extra });
}

/** Đọc body: limit ≤ 1MB; JSON hỏng / non-object → 400; rỗng → {}. KHÔNG check Content-Type (JSON.parse là nguồn chân lý). */
export async function readBody(req: http.IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const buf = c as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      // Dừng đọc (chống tiêu băng thông) — body throw lên dispatcher → 413.
      req.removeAllListeners('data');
      throw new BodyError(413, 'Body vượt quá 1MB');
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BodyError(400, 'JSON body không hợp lệ');
  }
  // SB-3: chỉ chấp nhận plain object — array/string/number/null → 400.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BodyError(400, 'JSON body không hợp lệ');
  }
  return parsed as Record<string, unknown>;
}

// ─── runId path helpers (SB-2: format-check TRƯỚC decodeURIComponent — chống malformed escape gây 500) ───

const RUN_PREFIX = '/api/loadtest/runs/';
// Cho phép '-' cho backward compat với dữ liệu/test cũ (lt-hist1); vẫn chặn '%'/'/'/'.' (SB-2 malformed escape).
const RUN_ID_RE = /^lt[a-z0-9-]{2,24}$/i;

/** Kiểm tra path có dạng /api/loadtest/runs/{id}{suffix} với id là 1 segment. */
export function isRunPath(p: string, suffix: string): boolean {
  if (!p.startsWith(RUN_PREFIX)) return false;
  const rest = p.slice(RUN_PREFIX.length);
  if (!rest) return false;
  const id = suffix ? rest.slice(0, rest.length - suffix.length) : rest;
  return id.length > 0 && !id.includes('/') && rest.endsWith(suffix);
}

/** Lấy runId từ path — format-check trước decode (SB-2). */
export function runIdFromPath(p: string, suffix: string): string {
  const rest = p.slice(RUN_PREFIX.length);
  const raw = rest.slice(0, rest.length - suffix.length);
  return decodeRunIdParam(raw);
}

/** Decode param runId từ route table — format-check trước decode (SB-2 / TH-9 defense-in-depth). */
export function decodeRunIdParam(raw: string): string {
  if (!RUN_ID_RE.test(raw)) throw new BodyError(404, 'runId không hợp lệ');
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new BodyError(404, 'runId không hợp lệ');
  }
}

// ─── RouteCtx (B-3: guards ở dispatcher, handler KHÔNG tự gọi guard) ────────────

export interface RouteCtx {
  env: LoadTestEnv;
  coordinator: LoadTestCoordinator;
  store?: LoadtestStore;
  authSecret: string;
  requestId: string;
  url: URL;
  params: Record<string, string>;
  /** Thời điểm server start (ms) — health uptime (T-07). */
  startedAt: number;
  /** Set bởi dispatcher sau requireAuth (route auth:true). */
  user?: SessionUser;
  ok: (res: http.ServerResponse, data: unknown) => void;
  fail: (res: http.ServerResponse, status: number, message: string, extra?: Record<string, unknown>) => void;
  /** Đọc body + tự trả 400/413 khi lỗi; trả undefined khi đã respond. */
  readBody: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<Record<string, unknown> | undefined>;
}

export interface RouteCtxBase {
  env: LoadTestEnv;
  coordinator: LoadTestCoordinator;
  store?: LoadtestStore;
  authSecret: string;
  requestId: string;
  url: URL;
  params: Record<string, string>;
  startedAt: number;
}

/** Tạo ctx cho 1 request (requestId là per-request). */
export function makeRouteCtx(base: RouteCtxBase): RouteCtx {
  const ctx: RouteCtx = {
    ...base,
    ok: (res, data) => okJson(res, data),
    fail: (res, status, message, extra) => failJson(res, status, message, { ...extra, requestId: ctx.requestId }),
    readBody: async (req, res) => {
      try {
        return await readBody(req);
      } catch (e) {
        if (e instanceof BodyError) {
          ctx.fail(res, e.statusCode, e.message, { error: e.statusCode === 413 ? 'BODY_TOO_LARGE' : 'INVALID_JSON' });
          if (e.statusCode === 413) {
            // FIX-7 (T-06): sau khi trả 413, hủy socket — client gửi body quá lớn không giữ connection mở.
            res.once('finish', () => {
              try {
                req.destroy();
              } catch {
                // socket đã đóng
              }
            });
          }
          return undefined;
        }
        throw e;
      }
    },
  };
  return ctx;
}