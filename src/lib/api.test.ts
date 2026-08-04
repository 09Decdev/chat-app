import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock axios: fake instance (callable cho retry) + module-level `post` (doRefresh) ──
const mocks = vi.hoisted(() => {
  const responseErr: Array<(e: unknown) => unknown> = [];
  const requestUse: Array<(c: unknown) => unknown> = [];
  const post = vi.fn();
  const set = vi.fn();
  const clear = vi.fn();

  const instance = (async (config: unknown) => ({
    data: { success: true, data: { ok: true } },
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  })) as unknown as {
    (config: unknown): Promise<unknown>;
    interceptors: {
      request: { use: (fn: (c: unknown) => unknown) => void };
      response: { use: (ok: (r: unknown) => unknown, err: (e: unknown) => unknown) => void };
    };
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  instance.interceptors = {
    request: { use: (fn) => void requestUse.push(fn) },
    response: { use: (_ok, err) => void responseErr.push(err) },
  };
  instance.get = vi.fn();
  instance.post = vi.fn();
  instance.put = vi.fn();
  instance.delete = vi.fn();

  return { mocks: { responseErr, requestUse, post, set, clear, instance } };
});

vi.mock('axios', () => ({ default: { create: () => mocks.mocks.instance, post: mocks.mocks.post } }));

vi.mock('@/lib/storage', () => ({
  tokenStorage: {
    get access() {
      return null;
    },
    get refresh() {
      return 'refresh-token-value';
    },
    set: mocks.mocks.set,
    clear: mocks.mocks.clear,
  },
  deviceStorage: { getDeviceInfo: () => ({}) },
  matchingFlag: { get: () => false, set: () => {} },
  topicDraft: { get: () => '', set: () => {}, clear: () => {} },
}));

import '@/lib/api';
import { chatApi, ApiError } from '@/lib/api';
import { env } from '@/lib/env';

describe('refresh interceptor (F-6, US-FE-1)', () => {
  beforeEach(() => {
    mocks.mocks.post.mockReset();
    mocks.mocks.instance.post.mockReset();
    mocks.mocks.instance.get.mockReset();
    mocks.mocks.set.mockReset();
    mocks.mocks.clear.mockReset();
    mocks.mocks.post.mockResolvedValue({
      data: { success: true, data: { accessToken: 'new-access', refreshToken: 'new-refresh' } },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    });
  });

  it('env.refreshEndpoint mặc định = /auth/refresh-token (khớp gateway auth.controller.ts:314)', () => {
    expect(env.refreshEndpoint).toBe('/auth/refresh-token');
  });

  it('401 → POST {gatewayUrl}/auth/refresh-token với { refreshToken } + retry request cũ', async () => {
    const errInterceptor = mocks.mocks.responseErr[0];
    expect(errInterceptor).toBeDefined();

    const original = { url: '/protected', method: 'post', headers: { set: vi.fn() } };
    const fakeError = { config: original, response: { status: 401, data: { message: 'Unauthorized' } } };

    const result = await errInterceptor(fakeError);

    // Gọi đúng endpoint + body { refreshToken } (F-6), kèm AbortSignal timeout (W3 T-08).
    expect(mocks.mocks.post).toHaveBeenCalledWith(
      'http://localhost:3000/auth/refresh-token',
      { refreshToken: 'refresh-token-value' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // Lưu access token mới + refresh token mới (không clear session).
    expect(mocks.mocks.set).toHaveBeenCalledWith('new-access', 'new-refresh');
    expect(mocks.mocks.clear).not.toHaveBeenCalled();
    // Retry request gốc (instance(original) resolve response mới).
    expect(result).toBeDefined();
  });

  it('refresh treo quá 10s → abort → refresh failure → clear session', async () => {
    vi.useFakeTimers();
    try {
      const errInterceptor = mocks.mocks.responseErr[0];
      const original = { url: '/protected', method: 'post', headers: { set: vi.fn() } };
      const fakeError = { config: original, response: { status: 401, data: { message: 'Unauthorized' } } };

      // post treo vô hạn — chỉ reject khi signal abort (mô phỏng endpoint không bao giờ trả lời).
      mocks.mocks.post.mockImplementation(
        (_url: unknown, _body: unknown, config: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            config.signal.addEventListener('abort', () => {
              const e = new Error('Aborted');
              e.name = 'AbortError';
              reject(e);
            });
          }),
      );

      const promise = errInterceptor(fakeError);
      // Attach rejection handler NGAY khi promise được tạo — tránh window
      // unhandled rejection khi fake timers flush microtask trễ.
      const assertion = expect(promise).rejects.toMatchObject({ statusCode: 401 });
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
      // Timeout = refresh failure → clear session + không retry (W3 T-08).
      expect(mocks.mocks.clear).toHaveBeenCalled();
      expect(mocks.mocks.set).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('unwrap (envelope { success, data })', () => {
  const deviceInfo = { installationId: 'id', deviceFingerprint: 'fp', platform: 'web' as const, deviceName: 'test' };

  it('body có envelope → trả .data', async () => {
    mocks.mocks.instance.post.mockResolvedValue({
      data: { success: true, data: { accessToken: 'a', refreshToken: 'r' } },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    });
    const res = await chatApi.login({ email: 'a@b.c', password: 'p', deviceInfo });
    expect(res).toEqual({ accessToken: 'a', refreshToken: 'r' });
  });

  it('body không có envelope → trả nguyên body', async () => {
    mocks.mocks.instance.post.mockResolvedValue({
      data: { accessToken: 'a' },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {},
    });
    const res = await chatApi.login({ email: 'a@b.c', password: 'p', deviceInfo });
    expect(res).toEqual({ accessToken: 'a' });
  });
});

describe('toApiError (response interceptor) + ApiError shape', () => {
  it('response lỗi có body → ApiError statusCode/code/message/traceId/raw', async () => {
    const errInterceptor = mocks.mocks.responseErr[0];
    const original = { url: '/x', method: 'get', headers: { set: vi.fn() } };
    const fakeError = {
      config: original,
      response: {
        status: 400,
        data: { statusCode: 400, message: 'Bad request', error: 'BAD_REQUEST', traceId: 't-1' },
      },
    };
    await expect(errInterceptor(fakeError)).rejects.toMatchObject({
      statusCode: 400,
      code: 'BAD_REQUEST',
      message: 'Bad request',
      traceId: 't-1',
    });
  });

  it('response lỗi có body → là instanceof ApiError (raw = body)', async () => {
    const errInterceptor = mocks.mocks.responseErr[0];
    const body = { statusCode: 422, message: 'Invalid', error: 'VALIDATION' };
    const fakeError = { config: {}, response: { status: 422, data: body } };
    await expect(errInterceptor(fakeError)).rejects.toBeInstanceOf(ApiError);
    await expect(errInterceptor(fakeError)).rejects.toMatchObject({ raw: body });
  });

  it('network error (có request, không response) → code NETWORK, message gateway', async () => {
    const errInterceptor = mocks.mocks.responseErr[0];
    const fakeError = { config: {}, request: {} };
    await expect(errInterceptor(fakeError)).rejects.toMatchObject({
      statusCode: 0,
      code: 'NETWORK',
      message: 'Khong ket noi duoc den server. Kiem tra gateway dang chay (port 3000).',
    });
  });

  it('client error (không response/request) → code CLIENT, message từ error', async () => {
    const errInterceptor = mocks.mocks.responseErr[0];
    const fakeError = { config: {}, message: 'Request failed' };
    await expect(errInterceptor(fakeError)).rejects.toMatchObject({
      statusCode: 0,
      code: 'CLIENT',
      message: 'Request failed',
    });
  });

  it('ApiError shape: extends Error, name = ApiError, đủ field', () => {
    const err = new ApiError(429, 'RATE_LIMIT', 'Too many', 'trace-9', { raw: 1 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ApiError');
    expect(err.statusCode).toBe(429);
    expect(err.code).toBe('RATE_LIMIT');
    expect(err.message).toBe('Too many');
    expect(err.traceId).toBe('trace-9');
    expect(err.raw).toEqual({ raw: 1 });
  });
});