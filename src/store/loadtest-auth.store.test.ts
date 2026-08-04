import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadtestApi: {
    authLogin: vi.fn(),
    authRegister: vi.fn(),
    authLogout: vi.fn(),
    authMe: vi.fn(),
  },
  toApiError: vi.fn(),
  onLoadtestAuthFailure: vi.fn(),
  storage: {
    load: vi.fn(),
    save: vi.fn(),
    clear: vi.fn(),
  },
}));

vi.mock('@/lib/loadtest-api', () => ({
  loadtestApi: mocks.loadtestApi,
  toApiError: mocks.toApiError,
  onLoadtestAuthFailure: mocks.onLoadtestAuthFailure,
}));

vi.mock('@/lib/loadtest-auth-storage', () => ({
  loadtestAuthStorage: mocks.storage,
}));

const { useLoadtestAuthStore } = await import('@/store/loadtest-auth.store');

const validUser = { id: 1, username: 'admin', email: 'a@b.c', displayName: 'Admin', role: 'admin' };

describe('loadtest-auth.store — initialize (hydrate)', () => {
  beforeEach(() => {
    mocks.storage.load.mockReset();
    mocks.storage.save.mockReset();
    mocks.storage.clear.mockReset();
    mocks.loadtestApi.authMe.mockReset();
    mocks.loadtestApi.authLogin.mockReset();
    mocks.loadtestApi.authLogout.mockReset();
    mocks.toApiError.mockReset();
    // reset store về trạng thái ban đầu giữa các test
    useLoadtestAuthStore.setState({
      user: null,
      token: null,
      expiresAt: null,
      isAuthenticated: false,
      authReady: false,
      initialized: false,
    });
  });

  it('không có session → authReady, isAuthenticated false', async () => {
    mocks.storage.load.mockReturnValue(null);
    await useLoadtestAuthStore.getState().initialize();
    const s = useLoadtestAuthStore.getState();
    expect(s.authReady).toBe(true);
    expect(s.isAuthenticated).toBe(false);
  });

  it('session hết hạn → clear + isAuthenticated false', async () => {
    mocks.storage.load.mockReturnValue({
      token: 'tok',
      expiresAt: Date.now() - 1000,
      user: validUser,
    });
    await useLoadtestAuthStore.getState().initialize();
    const s = useLoadtestAuthStore.getState();
    expect(mocks.storage.clear).toHaveBeenCalled();
    expect(s.isAuthenticated).toBe(false);
    expect(s.authReady).toBe(true);
  });

  it('session hợp lệ → isAuthenticated true + authMe cập nhật user', async () => {
    mocks.storage.load.mockReturnValue({
      token: 'tok',
      expiresAt: Date.now() + 60_000,
      user: validUser,
    });
    mocks.loadtestApi.authMe.mockResolvedValue({ ...validUser, username: 'refreshed' });
    await useLoadtestAuthStore.getState().initialize();
    const s = useLoadtestAuthStore.getState();
    expect(s.isAuthenticated).toBe(true);
    expect(s.token).toBe('tok');
    expect(s.user?.username).toBe('refreshed');
    expect(mocks.loadtestApi.authMe).toHaveBeenCalledWith();
  });

  it('initialize 2 lần → chỉ chạy 1 lần (initialized guard)', async () => {
    mocks.storage.load.mockReturnValue(null);
    await useLoadtestAuthStore.getState().initialize();
    await useLoadtestAuthStore.getState().initialize();
    expect(mocks.storage.load).toHaveBeenCalledTimes(1);
  });
});

describe('loadtest-auth.store — login / logout / clearSession', () => {
  beforeEach(() => {
    useLoadtestAuthStore.setState({
      user: null,
      token: null,
      expiresAt: null,
      isAuthenticated: false,
      authReady: false,
      initialized: false,
    });
  });

  it('login success → save + isAuthenticated true', async () => {
    mocks.loadtestApi.authLogin.mockResolvedValue({
      token: 'tok.new',
      expiresAt: 999,
      user: validUser,
    });
    const res = await useLoadtestAuthStore.getState().login('admin', 'pass');
    expect(res).toEqual({ ok: true });
    expect(mocks.storage.save).toHaveBeenCalledWith({ token: 'tok.new', expiresAt: 999, user: validUser });
    const s = useLoadtestAuthStore.getState();
    expect(s.isAuthenticated).toBe(true);
    expect(s.token).toBe('tok.new');
  });

  it('login failure → ok:false + error message từ toApiError', async () => {
    mocks.loadtestApi.authLogin.mockRejectedValue(new Error('bad'));
    mocks.toApiError.mockReturnValue({ statusCode: 401, message: 'Sai mật khẩu' });
    const res = await useLoadtestAuthStore.getState().login('admin', 'wrong');
    expect(res).toEqual({ ok: false, error: 'Sai mật khẩu' });
    expect(useLoadtestAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('logout → clear session + state reset', async () => {
    mocks.loadtestApi.authLogout.mockResolvedValue({ loggedOut: true });
    useLoadtestAuthStore.setState({ token: 'tok', user: validUser, isAuthenticated: true, authReady: true });
    await useLoadtestAuthStore.getState().logout();
    const s = useLoadtestAuthStore.getState();
    expect(s.token).toBeNull();
    expect(s.user).toBeNull();
    expect(s.isAuthenticated).toBe(false);
    expect(mocks.storage.clear).toHaveBeenCalled();
  });

  it('logout khi server lỗi → vẫn clear client-side (best-effort)', async () => {
    mocks.loadtestApi.authLogout.mockRejectedValue(new Error('net'));
    useLoadtestAuthStore.setState({ token: 'tok', isAuthenticated: true });
    await useLoadtestAuthStore.getState().logout();
    expect(mocks.storage.clear).toHaveBeenCalled();
    expect(useLoadtestAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('clearSession → clear + state reset', () => {
    useLoadtestAuthStore.setState({ token: 'tok', user: validUser, isAuthenticated: true });
    useLoadtestAuthStore.getState().clearSession();
    const s = useLoadtestAuthStore.getState();
    expect(mocks.storage.clear).toHaveBeenCalled();
    expect(s.isAuthenticated).toBe(false);
    expect(s.authReady).toBe(true);
  });
});