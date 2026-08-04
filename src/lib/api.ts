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

export function onAuthFailure(cb: () => void) {
  authFailureCb = cb;
}

async function doRefresh(): Promise<boolean> {
  const refresh = tokenStorage.refresh;
  if (!refresh) return false;
  try {
    const res = await axios.post(`${env.gatewayUrl}${env.refreshEndpoint}`, { refreshToken: refresh });
    const data = unwrap<{ accessToken?: string; refreshToken?: string }>(res.data);
    const access = data?.accessToken;
    if (access) {
      tokenStorage.set(access, data?.refreshToken ?? refresh);
      return true;
    }
    return false;
  } catch {
    return false;
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
};

export { instance as axiosInstance };
