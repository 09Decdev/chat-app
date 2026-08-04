/**
 * MAYogu LoadTest Tool — HTTP client mỏng (Node 22 fetch, không axios — server-side).
 * - Unwrap envelope `{ success, statusCode, data, metadata }` của gateway/content-service.
 * - Phân loại lỗi thành mã ổn định cho metrics (bảng top errors).
 */

export interface HttpResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  /** Envelope error code (errorCode/error string) nếu có. */
  code: string;
  message: string;
  /** HTTP status 429 | 401 | 403 | 4xx | 5xx */
  failClass: 'THROTTLED' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'CLIENT' | 'SERVER' | 'NETWORK' | 'OK';
  latencyMs: number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  token?: string;
  body?: unknown;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** không decode JSON (dùng cho /metrics text). */
  rawText?: boolean;
}

export function classifyStatus(status: number): HttpResult['failClass'] {
  if (status === 429) return 'THROTTLED';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status >= 500) return 'SERVER';
  if (status >= 400) return 'CLIENT';
  return 'OK';
}

/** Rút mã lỗi ổn định từ error envelope hệ thống. */
export function extractErrorCode(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    if (typeof b.error === 'number' || (typeof b.error === 'string' && b.error !== '')) {
      return String(b.error);
    }
    if (typeof b.code === 'number' || typeof b.code === 'string') return String(b.code);
    if (typeof b.message === 'string' && b.message.length > 0 && b.message.length < 120) {
      return `msg:${b.message.slice(0, 80)}`;
    }
  }
  return `HTTP_${status}`;
}

export async function requestJson<T = unknown>(
  baseUrl: string,
  path: string,
  opts: RequestOptions = {},
): Promise<HttpResult<T>> {
  const method = opts.method ?? 'GET';
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    ...opts.headers,
  };
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + path, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const latencyMs = Math.round(performance.now() - started);
    if (opts.rawText) {
      const text = await res.text();
      return { ok: res.ok, status: res.status, data: text as unknown as T, code: '', message: '', failClass: classifyStatus(res.status), latencyMs };
    }
    let body: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    const unwrapped =
      body && typeof body === 'object' && 'success' in (body as Record<string, unknown>)
        ? (body as { data?: T }).data ?? null
        : (body as T | null);
    const message =
      body && typeof body === 'object' && typeof (body as Record<string, unknown>).message === 'string'
        ? String((body as Record<string, unknown>).message)
        : '';
    if (res.ok) {
      return { ok: true, status: res.status, data: unwrapped, code: '', message, failClass: 'OK', latencyMs };
    }
    return {
      ok: false,
      status: res.status,
      data: unwrapped,
      code: extractErrorCode(body, res.status),
      message,
      failClass: classifyStatus(res.status),
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      data: null,
      code: isAbort ? 'TIMEOUT' : 'NETWORK',
      message: isAbort ? `timeout ${timeoutMs}ms` : err instanceof Error ? err.message : String(err),
      failClass: 'NETWORK',
      latencyMs,
    };
  } finally {
    clearTimeout(timer);
  }
}
