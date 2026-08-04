/**
 * MAYogu LoadTest Tool — structured JSON logger (T-07).
 *
 * BACKWARD COMPAT (O-5 / R-8):
 * - `ltLog.info/warn/error` — giữ nguyên API (toàn bộ module gọi qua util.ts re-export).
 * - Ring buffer 500 (`logHistory`) + `subscribeLog` — dashboard `/logs` + DB log_events không đổi.
 *   Entry trong ring buffer GIỮ format text `[lt][INFO][ts] msg` (compat).
 * - `setVerbose` — giữ.
 *
 * JSONL sink (O-2):
 * - Append JSON `{ ts, level, runId?, workerId?, requestId?, msg, context? }` vào
 *   `LOGTEST_LOG_FILE` (mặc định KHÔNG ghi file khi env unset — plan: "LOG_FILE unset → không ghi").
 * - Rotation size-based: 10MB → `.1`, `.2`, ... giữ 5 file.
 *
 * Redaction (B-1): `redactSensitiveFields` chặn mọi field tên khớp
 * `/authorization|password|passwordHash|refreshToken|token|otp|secret/i` + `redactUrl` +
 * `redactParams/redactSql` (db/int) trước khi emit console + JSONL. KHÔNG log password/
 * token/Authorization ở bất kỳ đâu.
 *
 * KHÔNG import util.ts (tránh cycle) — util.ts re-export logger (shim).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { redactParams, redactSql } from './db/int';

export type LogLevel = 'info' | 'warn' | 'error';

/** Fields bổ sung cho log entry structured (tất cả optional). */
export interface LogFields {
  runId?: string;
  workerId?: number | string;
  requestId?: string;
  context?: Record<string, unknown>;
}

/** Entry trong ring buffer (dashboard compat — msg giữ text `[lt]...`). */
export interface LogHistoryEntry {
  ts: number;
  level: LogLevel;
  msg: string;
}

/** Entry JSONL (file sink). */
export interface JsonlEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  runId?: string;
  workerId?: string;
  requestId?: string;
  context?: Record<string, unknown>;
}

let verbose = false;

export function setVerbose(v: boolean) {
  verbose = v;
}

/** Ring buffer log gần đây (GET /api/loadtest/logs — dashboard). */
export const logHistory: LogHistoryEntry[] = [];
const LOG_HISTORY_LIMIT = 500;

/** Subscriber nhận log raw (dùng cho DB persistence — ghi log_events theo runId). */
export type LogSubscriber = (level: LogLevel, msg: string) => void;
const logSubscribers: LogSubscriber[] = [];

export function subscribeLog(fn: LogSubscriber): () => void {
  logSubscribers.push(fn);
  return () => {
    const i = logSubscribers.indexOf(fn);
    if (i >= 0) logSubscribers.splice(i, 1);
  };
}

// ─── Redaction (B-1 — dùng chung với db/int.ts) ───────────────────────────────

/** Redact password trong URL để log/error an toàn (T-03): `user:pass@host` → `user:***@host`. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url.replace(/^([^:]+:\/\/[^:]+):[^@]*@/, '$1:***@');
  }
}

const SENSITIVE_FIELD = /authorization|password|passwordHash|refreshToken|token|otp|secret/i;

/**
 * Redact mọi field trước khi emit (B-1): field tên khớp sensitive → '[REDACTED]';
 * chuỗi → redactUrl phòng hờ; `params`/`sql` → redactParams/redactSql (db/int).
 * Đệ quy vào object/array. KHÔNG đổi giá trị nếu không dính.
 */
export function redactSensitiveFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'params' && Array.isArray(v)) {
      out[k] = redactParams(v as unknown[]);
    } else if (k === 'sql' && typeof v === 'string') {
      out[k] = redactSql(v);
    } else if (SENSITIVE_FIELD.test(k)) {
      out[k] = '[REDACTED]';
    } else if (typeof v === 'string') {
      out[k] = redactUrl(v);
    } else if (Array.isArray(v)) {
      out[k] = v.map((x) =>
        x !== null && typeof x === 'object' && !Array.isArray(x)
          ? redactSensitiveFields(x as Record<string, unknown>)
          : x,
      );
    } else if (v !== null && typeof v === 'object') {
      out[k] = redactSensitiveFields(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * T-07 FIX-4: redact msg trước khi emit (B-1) — chạy qua redactSensitiveFields (redactUrl chuỗi)
 * + chặn value của field nhạy cảm nhúng trong text (`password=...`, `token=...`, ...).
 */
export function redactMsg(msg: string): string {
  const viaFields = redactSensitiveFields({ msg });
  let s = typeof viaFields.msg === 'string' ? viaFields.msg : msg;
  s = s.replace(
    /\b((?:password|passwd|pwd|token|secret|otp|authorization|refreshToken)\s*[=:]\s*)([^\s,;|]+)/gi,
    '$1[REDACTED]',
  );
  return s;
}

// ─── JSONL file sink + rotation ───────────────────────────────────────────────

export interface JsonlSink {
  readonly path: string;
  write(entry: JsonlEntry): void;
  close(): void;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_FILES = 5;

/**
 * File sink JSONL append + rotation size-based (10MB → `.1`, `.2` ... giữ maxFiles).
 * Dùng `fs.appendFileSync` (open/close mỗi lần) — không cầm handle, rotation an toàn
 * trên Windows (rename file đang mở dễ EBUSY/EPERM).
 */
export function createJsonlSink(filePath: string, opts: { maxBytes?: number; maxFiles?: number } = {}): JsonlSink {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  let closed = false;
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    size = 0;
  }

  function rotate(): void {
    for (let i = maxFiles; i >= 1; i--) {
      const from = i === 1 ? filePath : `${filePath}.${i - 1}`;
      const to = `${filePath}.${i}`;
      try {
        if (fs.existsSync(from)) fs.renameSync(from, to);
      } catch {
        // best-effort — rotation lỗi không làm hỏng log
      }
    }
    size = 0;
  }

  return {
    path: filePath,
    write(entry) {
      if (closed) return;
      const line = JSON.stringify(entry) + '\n';
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFileSync(filePath, line, 'utf8');
      } catch {
        return; // sink lỗi không làm hỏng log
      }
      size += Buffer.byteLength(line);
      if (size > maxBytes) {
        try {
          rotate();
        } catch {
          // best-effort
        }
      }
    },
    close() {
      closed = true;
    },
  };
}

// ─── Logger state ─────────────────────────────────────────────────────────────

let jsonlSink: JsonlSink | null = null;

/**
 * Configure JSONL file sink. `logFile: null` → tắt file sink (test / disable).
 * Gọi lại để đổi path. Nếu không gọi, đọc `process.env.LOGTEST_LOG_FILE` lúc module load.
 */
export function configureLogger(opts: { logFile?: string | null; maxBytes?: number; maxFiles?: number } = {}): void {
  if (jsonlSink) {
    try {
      jsonlSink.close();
    } catch {
      // ignore
    }
    jsonlSink = null;
  }
  const file = opts.logFile ?? process.env.LOGTEST_LOG_FILE ?? null;
  if (file) {
    jsonlSink = createJsonlSink(file, { maxBytes: opts.maxBytes, maxFiles: opts.maxFiles });
  }
}

// Auto-init từ env (lúc import). Nếu env unset → không ghi file (plan: "LOG_FILE unset → không ghi").
if (process.env.LOGTEST_LOG_FILE) configureLogger({ logFile: process.env.LOGTEST_LOG_FILE });

function buildJsonlEntry(level: LogLevel, msg: string, fields?: LogFields): JsonlEntry {
  const safeMsg = redactMsg(msg); // T-07 FIX-4: msg cũng qua redact (B-1)
  const entry: JsonlEntry = { ts: new Date().toISOString(), level, msg: safeMsg };
  if (fields?.runId) entry.runId = fields.runId;
  if (fields?.workerId !== undefined && fields?.workerId !== null && fields?.workerId !== '') {
    entry.workerId = String(fields.workerId);
  }
  if (fields?.requestId) entry.requestId = fields.requestId;
  if (fields?.context) {
    const redacted = redactSensitiveFields(fields.context);
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(redacted)) {
      if (v !== undefined && v !== null && v !== '') cleaned[k] = v;
    }
    if (Object.keys(cleaned).length) entry.context = cleaned;
  }
  return entry;
}

/**
 * Log 1 entry — GIỮ format text ở ring buffer (dashboard compat) + JSONL sink song song.
 * `fields` optional (runId/workerId/requestId/context) — luôn qua redact guard (B-1).
 */
export function log(level: LogLevel, msg: string, fields?: LogFields): void {
  const ts = new Date();
  const timeStr = ts.toISOString().slice(11, 23);
  const safeMsg = redactMsg(msg); // T-07 FIX-4: msg redact ở mọi sink (ring buffer, subscriber, JSONL, console)
  const line = `[lt][${level.toUpperCase()}][${timeStr}] ${safeMsg}`;
  logHistory.push({ ts: Date.now(), level, msg: line });
  if (logHistory.length > LOG_HISTORY_LIMIT) logHistory.shift();
  for (const fn of logSubscribers) {
    try {
      fn(level, safeMsg);
    } catch {
      // subscriber không được làm hỏng log
    }
  }
  if (jsonlSink) {
    try {
      jsonlSink.write(buildJsonlEntry(level, msg, fields));
    } catch {
      // sink lỗi không làm hỏng log
    }
  }
  // Console: text giữ nguyên; JSON 1 dòng khi LOADTEST_LOG_JSON=1 (prod).
  const logJson = process.env.LOADTEST_LOG_JSON === '1';
  if (logJson) {
    const jsonLine = JSON.stringify(buildJsonlEntry(level, msg, fields));
    if (level === 'error') console.error(jsonLine);
    else if (level === 'warn') console.warn(jsonLine);
    else if (verbose) console.log(jsonLine);
  } else if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else if (verbose) {
    console.log(line);
  }
}

export const ltLog = {
  info: (msg: string, fields?: LogFields) => log('info', msg, fields),
  warn: (msg: string, fields?: LogFields) => log('warn', msg, fields),
  error: (msg: string, fields?: LogFields) => log('error', msg, fields),
};