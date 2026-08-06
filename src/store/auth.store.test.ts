import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  chatApi: { login: vi.fn() },
  onAuthFailure: vi.fn(),
  doRefresh: vi.fn(),
  decodeJwt: vi.fn(),
  tokenStorage: {
    set: vi.fn(),
    clear: vi.fn(),
    accessToken: null as string | null,
    refreshToken: null as string | null,
  },
  deviceStorage: { getDeviceInfo: vi.fn(() => ({ installationId: 'id', deviceFingerprint: 'fp' })) },
}));

vi.mock('@/lib/api', () => ({
  chatApi: mocks.chatApi,
  onAuthFailure: mocks.onAuthFailure,
  doRefresh: mocks.doRefresh,
  ApiError: class ApiError extends Error {
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
  },
}));

vi.mock('@/lib/storage', () => ({
  tokenStorage: {
    get access() {
      return mocks.tokenStorage.accessToken;
    },
    get refresh() {
      return mocks.tokenStorage.refreshToken;
    },
    set: mocks.tokenStorage.set,
    clear: mocks.tokenStorage.clear,
  },
  deviceStorage: mocks.deviceStorage,
  matchingFlag: { get: () => false, set: () => {} },
  topicDraft: { get: () => '', set: () => {}, clear: () => {} },
}));

vi.mock('@/lib/jwt', () => ({ decodeJwt: mocks.decodeJwt }));

const { useAuthStore } = await import('@/store/auth.store');
const { ApiError } = await import('@/lib/api');

describe('auth.store — hydrate', () => {
  beforeEach(() => {
    mocks.tokenStorage.accessToken = null;
    mocks.tokenStorage.refreshToken = null;
    mocks.tokenStorage.set.mockClear();
    mocks.tokenStorage.clear.mockClear();
    mocks.chatApi.login.mockReset();
    mocks.decodeJwt.mockReset();
    mocks.doRefresh.mockReset();
    useAuthStore.setState({ user: null, accessToken: null, isAuthenticated: false, authReady: false });
  });

  it('không có token → authReady true, không authenticated', async () => {
    await useAuthStore.getState().hydrate();
    const s = useAuthStore.getState();
    expect(s.authReady).toBe(true);
    expect(s.isAuthenticated).toBe(false);
  });

  it('token hết hạn + refresh thất bại → clear + authReady true (không login lại)', async () => {
    mocks.tokenStorage.accessToken = 'tok.expired';
    mocks.decodeJwt.mockReturnValue({ sub: 'u1', exp: 1000 }); // 1000s → năm 1970, đã hết hạn
    mocks.doRefresh.mockResolvedValue(false);
    await useAuthStore.getState().hydrate();
    const s = useAuthStore.getState();
    expect(mocks.doRefresh).toHaveBeenCalled();
    expect(mocks.tokenStorage.clear).toHaveBeenCalled();
    expect(s.isAuthenticated).toBe(false);
    expect(s.authReady).toBe(true);
  });

  it('token hết hạn nhưng refresh còn sống → refresh thành công, KHÔNG logout', async () => {
    mocks.tokenStorage.accessToken = 'tok.expired';
    mocks.decodeJwt.mockReturnValue({ sub: 'u1', exp: 1000 });
    mocks.doRefresh.mockResolvedValue(true);
    mocks.tokenStorage.accessToken = 'tok.new'; // doRefresh (mock) đổi access mới
    await useAuthStore.getState().hydrate();
    const s = useAuthStore.getState();
    expect(mocks.doRefresh).toHaveBeenCalled();
    expect(mocks.tokenStorage.clear).not.toHaveBeenCalled();
    expect(s.isAuthenticated).toBe(true);
    expect(s.accessToken).toBe('tok.new');
    expect(s.user).toEqual({ id: 'u1' });
  });

  it('token hợp lệ → authenticated + user từ sub/email', async () => {
    mocks.tokenStorage.accessToken = 'tok.valid';
    mocks.decodeJwt.mockReturnValue({ sub: 'u1', email: 'a@b.c', exp: null });
    await useAuthStore.getState().hydrate();
    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(true);
    expect(s.accessToken).toBe('tok.valid');
    expect(s.user).toEqual({ id: 'u1', email: 'a@b.c' });
  });

  it('token không decode được → user fallback { id: "" }', async () => {
    mocks.tokenStorage.accessToken = 'tok.bad';
    mocks.decodeJwt.mockReturnValue(null);
    await useAuthStore.getState().hydrate();
    const s = useAuthStore.getState();
    expect(s.isAuthenticated).toBe(true);
    expect(s.user).toEqual({ id: '' });
  });
});

describe('auth.store — login', () => {
  it('login success → set token + isAuthenticated true', async () => {
    mocks.chatApi.login.mockResolvedValue({ accessToken: 'acc', refreshToken: 'ref' });
    mocks.decodeJwt.mockReturnValue({ sub: 'u1', email: 'a@b.c' });
    const res = await useAuthStore.getState().login('a@b.c', 'pass');
    expect(res).toEqual({ ok: true });
    expect(mocks.tokenStorage.set).toHaveBeenCalledWith('acc', 'ref');
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  it('login require2fa → ok:false + require2fa true', async () => {
    mocks.chatApi.login.mockResolvedValue({ require2fa: true });
    const res = await useAuthStore.getState().login('a@b.c', 'pass');
    expect(res).toMatchObject({ ok: false, require2fa: true });
    expect(res.error).toContain('2FA');
  });

  it('login không accessToken → ok:false', async () => {
    mocks.chatApi.login.mockResolvedValue({});
    const res = await useAuthStore.getState().login('a@b.c', 'pass');
    expect(res).toEqual({ ok: false, error: 'Dang nhap that bai.' });
  });

  it('login failure (ApiError) → ok:false + error message', async () => {
    mocks.chatApi.login.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'Sai mat khau', undefined, undefined));
    const res = await useAuthStore.getState().login('a@b.c', 'wrong');
    expect(res).toEqual({ ok: false, error: 'Sai mat khau' });
  });
});

describe('auth.store — logout', () => {
  it('logout → clear token + reset state', () => {
    useAuthStore.setState({ user: { id: 'u1' }, accessToken: 'acc', isAuthenticated: true });
    useAuthStore.getState().logout();
    const s = useAuthStore.getState();
    expect(mocks.tokenStorage.clear).toHaveBeenCalled();
    expect(s.accessToken).toBeNull();
    expect(s.isAuthenticated).toBe(false);
  });
});