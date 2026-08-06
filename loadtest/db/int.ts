/**
 * BIGINT boundary + DB error class + redaction helpers (T-05, D-7, B-1).
 *
 * - `parseBigInt`: INT8 (OID 20) pg trả string → number an toàn (< 2^53).
 *   Giữ an toàn < 2^53 — mọi int8 trong schema là epoch ms hoặc counter nhỏ.
 * - `toEpochMs`: fix float→BIGINT (D-5) — `Math.trunc` trước khi insert.
 * - `isTransient`: code lỗi transient → retry ≥ 1. KHÔNG retry business error
 *   (23505 unique / 23503 FK / 22P02 invalid input) — retry chắc chắn fail.
 * - `redactSql`/`redactParams`: B-1 — chặn password/secret/hash vào log/error.
 */

const MAX_SAFE = 9007199254740991; // 2^53 - 1

export function parseBigInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null;
  if (typeof v === 'bigint') {
    return v >= BigInt(-MAX_SAFE) && v <= BigInt(MAX_SAFE) ? Number(v) : null;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

/** Epoch ms integer — Math.trunc mọi float (fix writer.ts mtimeMs → created_at BIGINT). */
export function toEpochMs(x: number | string | null | undefined): number | null {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', '08001', '08006', '57P01', '57P02', '40001']);
const BUSINESS_CODES = new Set(['23505', '23503', '22P02']);

export function isTransient(code: string): boolean {
  return TRANSIENT_CODES.has(code);
}

/** Lỗi nghiệp vụ (unique/FK/invalid input) — KHÔNG retry, KHÔNG tính dbWriteFail. */
export function isBusinessError(code: string): boolean {
  return BUSINESS_CODES.has(code);
}

const SENSITIVE_KEY = /(password|secret|token|hash|refresh|otp)/i;

/**
 * Redact SQL: nếu câu SQL có cột nhạy cảm (password/secret/token/hash/refresh/otp),
 * thay mọi literal chuỗi `'...'` → `'[REDACTED]'` (vd `VALUES ('x', 'SuperSecret')`).
 */
export function redactSql(sql: string): string {
  if (SENSITIVE_KEY.test(sql)) {
    return sql.replace(/'[^']*'/g, "'[REDACTED]'");
  }
  return sql;
}

/**
 * Param thật sự là secret (T-05): scrypt hash (`scrypt$` prefix) hoặc chuỗi dài
 * length ≥ 32 chỉ gồm hex / base64url — heuristic cho flat param (insertPoolAccounts
 * / createAdmin đưa plaintext + hash vào array, không phải object).
 */
function looksLikeSecret(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  if (v.startsWith('scrypt$')) return true;
  if (v.length >= 32 && /^[0-9a-fA-F]+$/.test(v)) return true; // hex
  if (v.length >= 32 && /^[A-Za-z0-9_-]+$/.test(v)) return true; // base64url
  return false;
}

/**
 * Cột nhạy cảm trong SQL text → tập 1-based index `$N` của param tương ứng.
 * INSERT: mapping cột → placeholder theo vị trí trong `(cols) VALUES ($1,…)`.
 * UPDATE: dò `SET col = $N`.
 */
function sensitiveParamIndexes(sql: string): Set<number> {
  const idx = new Set<number>();
  const insertRe = /INSERT\s+INTO\s+[`"\w.]+\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i;
  const im = insertRe.exec(sql);
  if (im) {
    const cols = im[1].split(',').map((c) => c.trim());
    const placeholders = im[2].split(',').map((p) => p.trim());
    cols.forEach((col, i) => {
      if (SENSITIVE_KEY.test(col)) {
        const pm = /\$(\d+)/.exec(placeholders[i]);
        if (pm) idx.add(Number(pm[1]));
      }
    });
  }
  const setRe = /UPDATE\s+[`"\w.]+\s+SET\s+([^;]*)/i;
  const sm = setRe.exec(sql);
  if (sm) {
    for (const clause of sm[1].split(',')) {
      const m = /([`"\w.]+)\s*=\s*\$(\d+)/i.exec(clause);
      if (m && SENSITIVE_KEY.test(m[1])) idx.add(Number(m[2]));
    }
  }
  return idx;
}

/**
 * Redact params (T-05, B-1): 3 lớp, giữ nguyên nếu không dính.
 * 1. Object param → key khớp SENSITIVE_KEY → '[REDACTED]' (giữ behavior cũ).
 * 2. Position-aware: SQL text cho biết cột nhạy cảm → `$N` tương ứng → '[REDACTED]'
 *    (flat param `insertPoolAccounts`/`createAdmin` — plaintext password, scrypt hash).
 * 3. Giá trị tự thân là secret (scrypt hash / hex / base64url dài) → '[REDACTED]'.
 */
export function redactParams(params: unknown[] | undefined, sql?: string): unknown[] | undefined {
  if (params === undefined) return undefined;
  const sensitiveIdx = sql ? sensitiveParamIndexes(sql) : new Set<number>();
  return params.map((p, i) => {
    if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
        out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : v;
      }
      return out;
    }
    if (sensitiveIdx.has(i + 1) || looksLikeSecret(p)) return '[REDACTED]';
    return p;
  });
}