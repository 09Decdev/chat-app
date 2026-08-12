import axios, {
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosError,
} from 'axios';
import { env } from './env';
import { tokenStorage } from './storage';
import type { LoginRequest, LoginResponse } from '@/types/auth';
import type {
  MatchEnqueueResult,
  MatchCancelResult,
  MyRoomResult,
  QueueCountResult,
  MessagesPage,
  ChatMessage,
  SetMyTopicResult,
  DeleteMyTopicResult,
  SearchMessagesPage,
  RoomMediaPage,
} from '@/types/chat';

/**
 * Error chuan hoa tu response loi (CHAT_API.md muc 3 - error envelope).
 * { success, statusCode, message, error, timestamp, path, traceId }
 */
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string | undefined,
    message: string,
    public traceId?: string,
    public raw?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const instance: AxiosInstance = axios.create({
  baseURL: env.gatewayUrl,
  timeout: 15000,
});

// Authorization header tu token trong storage
instance.interceptors.request.use((config) => {
  const token = tokenStorage.access;
  if (token) config.headers.set('Authorization', `Bearer ${token}`);
  return config;
});

// ---- refresh token (best-effort, endpoint khong co trong CHAT_API.md) ----
let refreshing: Promise<boolean> | null = null;
let authFailureCb: (() => void) | null = null;

/** W3 T-08: timeout refresh — endpoint treo không stall concurrent 401s vĩnh viễn. */
const REFRESH_TIMEOUT_MS = 10_000;

export function onAuthFailure(cb: () => void) {
  authFailureCb = cb;
}

/** Refresh token (best-effort, endpoint khong co trong CHAT_API.md).
 *  Export cho auth.store hydrate — thử refresh trước khi logout khi access hết hạn. */
export async function doRefresh(): Promise<boolean> {
  const refresh = tokenStorage.refresh;
  if (!refresh) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
  try {
    const res = await axios.post(
      `${env.gatewayUrl}${env.refreshEndpoint}`,
      { refreshToken: refresh },
      { signal: controller.signal },
    );
    const data = unwrap<{ accessToken?: string; refreshToken?: string }>(res.data);
    const access = data?.accessToken;
    if (access) {
      tokenStorage.set(access, data?.refreshToken ?? refresh);
      return true;
    }
    return false;
  } catch {
    // Abort (timeout) hay lỗi mạng đều = refresh failure → đường 401 hiện có clear session.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

instance.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as (AxiosRequestConfig & { _retried?: boolean }) | undefined;
    const status = error.response?.status;
    const isRefreshCall = original?.url?.includes(env.refreshEndpoint);
    if (status === 401 && original && !original._retried && !isRefreshCall) {
      original._retried = true;
      refreshing ??= doRefresh();
      const ok = await refreshing.finally(() => {
        refreshing = null;
      });
      if (ok) return instance(original);
      tokenStorage.clear();
      authFailureCb?.();
    }
    return Promise.reject(toApiError(error));
  },
);

function toApiError(error: unknown): ApiError {
  const ax = error as AxiosError<{
    statusCode?: number;
    message?: string;
    error?: string;
    traceId?: string;
  }>;
  if (ax.response) {
    const body = ax.response.data ?? {};
    return new ApiError(
      body.statusCode ?? ax.response.status,
      body.error,
      body.message ?? `Loi ${ax.response.status}`,
      body.traceId,
      body,
    );
  }
  if (ax.request) {
    return new ApiError(0, 'NETWORK', 'Khong ket noi duoc den server. Kiem tra gateway dang chay (port 3000).');
  }
  return new ApiError(0, 'CLIENT', ax.message ?? 'Loi khong xac dinh');
}

/** Unwrap: neu body co field `success` (envelope) thi lay .data, nguoc lai tra nguyen body. */
function unwrap<T>(body: unknown): T {
  if (body && typeof body === 'object' && 'success' in (body as Record<string, unknown>)) {
    return (body as { data: T }).data;
  }
  return body as T;
}

// ---- high-level helpers ----
async function apiPost<T>(url: string, body?: unknown): Promise<T> {
  const res = await instance.post(url, body);
  return unwrap<T>(res.data);
}
async function apiGet<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const res = await instance.get(url, { params });
  return unwrap<T>(res.data);
}
async function apiPut<T>(url: string, body?: unknown): Promise<T> {
  const res = await instance.put(url, body);
  return unwrap<T>(res.data);
}
async function apiDelete<T>(url: string): Promise<T> {
  const res = await instance.delete(url);
  return unwrap<T>(res.data);
}

/** Parse messages page defensive (CHAT_API.md 4.4 - co the co/khong envelope). */
function parseMessagesPage(body: unknown): MessagesPage {
  const obj = body as Record<string, unknown> | null;
  const arr = Array.isArray(obj?.data)
    ? (obj!.data as ChatMessage[])
    : Array.isArray(obj)
      ? (obj as unknown as ChatMessage[])
      : [];
  const nextCursor =
    (obj?.nextCursor as string | undefined) ??
    ((obj?.metadata as { nextCursor?: string } | undefined)?.nextCursor as string | undefined) ??
    null;
  return { messages: arr, nextCursor };
}

/** Bỏ envelope `{success, data}` nếu có (gateway có thể wrap) — fallback raw. */
function unwrapBody(body: unknown): unknown {
  if (body && typeof body === 'object' && 'success' in (body as Record<string, unknown>)) {
    return (body as { data: unknown }).data;
  }
  return body;
}

/** Parse search page defensive — đồng thời support envelope & raw shape. */
function parseSearchPage(body: unknown): SearchMessagesPage {
  const obj = unwrapBody(body) as Record<string, unknown> | null;
  const arr = Array.isArray(obj?.data)
    ? (obj!.data as SearchMessagesPage['data'])
    : Array.isArray(obj)
      ? (obj as unknown as SearchMessagesPage['data'])
      : [];
  const nextCursor = (obj?.nextCursor as string | undefined) ?? null;
  const hasNextPage = (obj?.hasNextPage as boolean | undefined) ?? !!nextCursor;
  return { data: arr, nextCursor, hasNextPage };
}

/** Parse media page (data + members) defensive. */
function parseMediaPage(body: unknown): RoomMediaPage {
  const obj = unwrapBody(body) as Record<string, unknown> | null;
  const arr = Array.isArray(obj?.data)
    ? (obj!.data as RoomMediaPage['data'])
    : Array.isArray(obj)
      ? (obj as unknown as RoomMediaPage['data'])
      : [];
  const nextCursor = (obj?.nextCursor as string | undefined) ?? null;
  const membersRaw = (obj as Record<string, unknown> | null)?.members;
  const members = Array.isArray(membersRaw)
    ? (membersRaw as RoomMediaPage['members'])
    : null;
  return { data: arr, nextCursor, members };
}

export const chatApi = {
  login: (req: LoginRequest) => apiPost<LoginResponse>('/auth/login', req),
  enqueue: (topic?: string) =>
    apiPost<MatchEnqueueResult>('/content-service/chat/match', topic ? { topic } : {}),
  cancel: () => apiDelete<MatchCancelResult>('/content-service/chat/match'),
  myRoom: () => apiGet<MyRoomResult>('/content-service/chat/match/my-room'),
  queueCount: () => apiGet<QueueCountResult>('/content-service/chat/match/queue-count'),
  messages: async (roomId: string, cursor?: string | null, limit = env.historyPageSize) => {
    const res = await instance.get(`/content-service/chat/rooms/${encodeURIComponent(roomId)}/messages`, {
      params: { ...(cursor ? { cursor } : {}), limit },
    });
    return parseMessagesPage(res.data);
  },
  // Topic (CHAT_API.md §10.4-10.5) — PUT upsert tra 200, DELETE idempotent
  setMyTopic: (roomId: string, title: string) =>
    apiPut<SetMyTopicResult>(`/content-service/chat/rooms/${encodeURIComponent(roomId)}/my-topic`, { title }),
  removeMyTopic: (roomId: string) =>
    apiDelete<DeleteMyTopicResult>(`/content-service/chat/rooms/${encodeURIComponent(roomId)}/my-topic`),

  // ─── Room search + media gallery (2026-08-07) ──────────────────────────
  searchMessages: async (roomId: string, q: string, cursor?: string | null, limit = 20) => {
    const res = await instance.get(
      `/content-service/chat/rooms/${encodeURIComponent(roomId)}/messages/search`,
      { params: { q, ...(cursor ? { cursor } : {}), limit } },
    );
    return parseSearchPage(res.data);
  },
  listRoomMedia: async (roomId: string, cursor?: string | null, limit = 20) => {
    const res = await instance.get(
      `/content-service/chat/rooms/${encodeURIComponent(roomId)}/media`,
      { params: { ...(cursor ? { cursor } : {}), limit } },
    );
    return parseMediaPage(res.data);
  },
};

export { instance as axiosInstance };
