/**
 * QueryResult<T> contract (T-05, B-1) — phân biệt "no rows" vs "DB fail".
 *
 * Mọi caller phải check `ok` TRƯỚC khi dùng `rows` — KHÔNG bao giờ coi
 * `{ ok: false }` là "trống". Điều này chặn mất dữ liệu im lặng (D-6):
 * `countMetricSamples` không trả 0 giả khi DB lỗi.
 *
 * Redaction (B-1 / TH-11): QueryError CHỈ chứa `{ code, message, context? }` —
 * KHÔNG sql, KHÔNG params, KHÔNG raw pg error (có thể chứa password/secret/hash:
 * `insertPoolAccounts`/`createAdmin` đưa plaintext + scrypt hash vào params).
 * Helpers `redactSql`/`redactParams` nằm trong `db/int.ts`.
 */

export interface QueryError {
  code?: string;
  message: string;
  context?: string;
}

export type QueryResult<T> =
  | { ok: true; rows: T[] }
  | { ok: false; error: QueryError };

/** Kết quả truy vấn 1 dòng — `rows[0] ?? null`; error giữ nguyên. */
export type SingleResult<T> =
  | { ok: true; row: T | null }
  | { ok: false; error: QueryError };

export function first<T>(r: QueryResult<T>): SingleResult<T> {
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, row: r.rows[0] ?? null };
}