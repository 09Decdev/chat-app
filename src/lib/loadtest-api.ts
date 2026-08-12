/**
 * LoadTest API client — REST contract docs/API-loadtest-tool.md.
 * Server: chat-app loadtest backend (npm run loadtest:server), port 3401 mặc định.
 * Đi qua Vite proxy /api/loadtest (vite.config.ts).
 *
 * Auth (PRD-loadtest-admin-auth C4): request interceptor gắn `Authorization: Bearer`
 * cho mọi request; response interceptor nhận 401 → clear session + redirect login.
 */
import axios, { type AxiosError } from 'axios';
import { loadtestAuthStorage } from '@/lib/loadtest-auth-storage';
import type {
  LoadTestConfig,
  RunStatus,
  LoadTestTick,
  RunReport,
  StartRunRequest,
  CleanupResult,
  ErrorBucket,
  ErrorSample,
  LoadtestAdminUser,
  LoadtestAuthResponse,
  LoadtestRunSummary,
  LoadtestRunDetail,
  LoadtestLogEvent,
  UserPhase,
  UserSortDir,
  UserSortField,
  UsersResponse,
} from '@/types/loadtest';

const client = axios.create({ baseURL: '/api/loadtest', timeout: 20000 });

export interface LoadtestApiError {
  statusCode: number;
  message: string;
  errors?: string[];
  warnings?: string[];
  /** 429 contract bắt buộc (backend DESIGN §2) — envelope `retryAfterSec` + `Retry-After` header. */
  retryAfterSec?: number;
  /** 'http' = có response; 'network' = lỗi network/CORS (browser không đọc được response). */
  kind?: 'http' | 'network';
}

export function toApiError(e: unknown): LoadtestApiError {
  const ax = e as AxiosError<{
    statusCode?: number;
    message?: string;
    errors?: string[];
    warnings?: string[];
    retryAfterSec?: number;
  }>;
  const response = ax.response;
  if (!response) {
    // Network/CORS — khi CORS chặn, browser cũng rơi vào nhánh này (không đọc được response).
    return {
      statusCode: 0,
      message:
        'Không kết nối được đến loadtest server (port 3401). Nếu truy cập cross-origin, kiểm tra LOADTEST_CORS_ORIGIN.',
      kind: 'network',
    };
  }
  const body = response.data;
  const retryAfterSec =
    (typeof body?.retryAfterSec === 'number' ? body.retryAfterSec : undefined) ??
    (response.headers['retry-after'] ? Number(response.headers['retry-after']) : undefined) ??
    0;
  return {
    statusCode: body?.statusCode ?? response.status ?? 0,
    message: body?.message ?? 'Không kết nối được đến loadtest server (port 3401). Chạy: npm run loadtest:server',
    errors: body?.errors,
    warnings: body?.warnings,
    retryAfterSec: retryAfterSec > 0 ? retryAfterSec : undefined,
    kind: 'http',
  };
}

// ─── Auth interceptor (PRD C4) ──────────────────────────────────────────────

client.interceptors.request.use((config) => {
  const token = loadtestAuthStorage.load()?.token;
  if (token) config.headers.set('Authorization', `Bearer ${token}`);
  return config;
});

let authFailureCb: (() => void) | null = null;

/** Đăng ký callback khi mọi request nhận 401 — session hết hạn/gate chặn. */
export function onLoadtestAuthFailure(cb: () => void) {
  authFailureCb = cb;
}

client.interceptors.response.use(
  (res) => res,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      authFailureCb?.();
    }
    return Promise.reject(error);
  },
);

/** Unwrap envelope { success, data }. */
function unwrap<T>(body: unknown): T {
  const obj = body as { success?: boolean; data?: T };
  if (obj && typeof obj === 'object' && 'data' in obj) return obj.data as T;
  return body as T;
}

export const loadtestApi = {
  // ── Admin auth (PRD Module A) ──
  authRegister: async (username: string, email: string, password: string) => {
    const res = await client.post('/auth/register', { username, email, password });
    return unwrap<LoadtestAdminUser>(res.data);
  },
  authLogin: async (identifier: string, password: string) => {
    const res = await client.post('/auth/login', { username: identifier, password });
    return unwrap<LoadtestAuthResponse>(res.data);
  },
  authLogout: async () => {
    const res = await client.post('/auth/logout');
    return unwrap<{ loggedOut: boolean }>(res.data);
  },
  authMe: async () => {
    const res = await client.get('/auth/me');
    return unwrap<LoadtestAdminUser>(res.data);
  },

  // ── History / Replay (PRD D1) ──
  listRuns: async (params?: { status?: string; limit?: number }) => {
    const res = await client.get('/runs', { params });
    return unwrap<{ runs: LoadtestRunSummary[]; total: number }>(res.data);
  },
  getRun: async (runId: string) => {
    const res = await client.get(`/runs/${encodeURIComponent(runId)}`);
    return unwrap<LoadtestRunDetail>(res.data);
  },
  getRunMetrics: async (runId: string, params?: { limit?: number; offset?: number }) => {
    const res = await client.get(`/runs/${encodeURIComponent(runId)}/metrics`, { params });
    return unwrap<{ runId: string; ticks: LoadTestTick[]; total: number }>(res.data);
  },
  getRunLogs: async (runId: string, params?: { limit?: number; offset?: number; level?: string }) => {
    const res = await client.get(`/runs/${encodeURIComponent(runId)}/logs`, { params });
    return unwrap<{ runId: string; logs: LoadtestLogEvent[]; total: number }>(res.data);
  },
  deleteRun: async (runId: string) => {
    const res = await client.delete(`/runs/${encodeURIComponent(runId)}`);
    return unwrap<{ deleted: boolean; runId: string }>(res.data);
  },

  health: async () => {
    const res = await client.get('/health');
    return unwrap<{ status: string }>(res.data);
  },
  getConfig: async () => {
    const res = await client.get('/config');
    return unwrap<LoadTestConfig>(res.data);
  },
  start: async (req: StartRunRequest) => {
    const res = await client.post('/start', req);
    return unwrap<{ runId: string; config: unknown; warnings: string[]; estimate: { workers: number; ramGB: number; seatMin: number } }>(res.data);
  },
  impersonate: async (email: string) => {
    const res = await client.post('/impersonate', { email });
    return unwrap<{ accessToken: string; refreshToken: string; user: { id: string; email: string; displayName: string; avatar: string } }>(res.data);
  },
  stop: async (force = false) => {
    const res = await client.post(force ? '/kill' : '/stop', force ? { force: true } : {});
    return unwrap<{ stopped: boolean; force: boolean }>(res.data);
  },
  pause: async () => {
    const res = await client.post('/pause');
    return unwrap<{ paused: boolean }>(res.data);
  },
  resume: async () => {
    const res = await client.post('/resume');
    return unwrap<{ resumed: boolean }>(res.data);
  },
  status: async () => {
    const res = await client.get('/status');
    return unwrap<RunStatus>(res.data);
  },
  metrics: async (since = 0, limit = 3600) => {
    const res = await client.get('/metrics', { params: { since, limit } });
    return unwrap<{ ticks: LoadTestTick[]; runId: string }>(res.data);
  },
  errors: async () => {
    const res = await client.get('/errors');
    return unwrap<{ top: ErrorBucket[]; samples: ErrorSample[] }>(res.data);
  },
  /** Bảng virtual users — sort server-side (whitelist backend) + filter email/phase/roomId + phase chính xác. */
  users: async (params?: {
    offset?: number;
    limit?: number;
    filter?: string;
    phase?: UserPhase;
    sortBy?: UserSortField;
    sortDir?: UserSortDir;
  }) => {
    const res = await client.get('/users', { params });
    return unwrap<UsersResponse>(res.data);
  },
  logs: async (limit = 200) => {
    const res = await client.get('/logs', { params: { limit } });
    return unwrap<{ logs: { ts: number; level: string; msg: string }[] }>(res.data);
  },
  report: async () => {
    const res = await client.get('/report');
    return unwrap<RunReport>(res.data);
  },
  /** Tải report file qua axios (mang Bearer token) — thay cho <a href> trực tiếp (gate 401). */
  downloadReport: async (format: 'json' | 'md' | 'csv', runId?: string) => {
    const res = await client.get('/report/export', { params: { format }, responseType: 'blob' });
    const cd = res.headers['content-disposition'] as string | undefined;
    const m = cd ? /filename="?([^";]+)"?/.exec(cd) : null;
    const filename = m?.[1] ?? (runId ? `report-${runId}.${format}` : `report.${format}`);
    const url = URL.createObjectURL(res.data as Blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Firefox có thể hủy download nếu revoke ngay sau click — hoãn ~1s.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
  allowlist: async () => {
    const res = await client.get('/allowlist');
    return unwrap<{ allowlist: string[]; fromFile: string[] }>(res.data);
  },
  saveAllowlist: async (urls: string[]) => {
    const res = await client.post('/allowlist', { urls });
    return unwrap<{ allowlist: string[] }>(res.data);
  },
  pools: async () => {
    const res = await client.get('/pools');
    return unwrap<{ pools: unknown[] }>(res.data);
  },
  cleanup: async (runId: string, dryRun = true) => {
    const res = await client.post('/cleanup', { runId, dryRun });
    return unwrap<CleanupResult>(res.data);
  },
};