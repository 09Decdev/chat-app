import { create } from 'zustand';
import { chatApi, ApiError, onAuthFailure, doRefresh } from '@/lib/api';
import { tokenStorage, deviceStorage } from '@/lib/storage';
import { decodeJwt } from '@/lib/jwt';
import type { AuthUser } from '@/types/auth';

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  authReady: boolean;
  /** F-impersonate: true khi đang truy cập 1 virtual user (thoát → clear + về loadtest). */
  impersonating: boolean;
  hydrate: () => void;
  login: (email: string, password: string) => Promise<{ ok: boolean; require2fa?: boolean; error?: string }>;
  logout: () => void;
  impersonate: (data: { accessToken: string; refreshToken: string; user: { id: string; email: string; displayName: string; avatar: string } }) => void;
  exitImpersonate: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  isAuthenticated: false,
  authReady: false,
  impersonating: false,

  hydrate: async () => {
    const access = tokenStorage.access;
    if (!access) {
      set({ authReady: true });
      return;
    }
    const payload = decodeJwt(access);
    const exp = payload?.exp;
    if (exp && exp * 1000 < Date.now()) {
      // Access hết hạn nhưng refresh có thể còn sống — thử refresh TRƯỚC khi clear
      // (chỉ logout khi refresh thất bại). doRefresh không chạy qua interceptor 401
      // → không có vòng lặp.
      const ok = await doRefresh();
      if (!ok) {
        tokenStorage.clear();
        set({ authReady: true });
        return;
      }
      const next = tokenStorage.access;
      const p = next ? decodeJwt(next) : null;
      set({
        accessToken: next,
        isAuthenticated: !!next,
        user: p?.sub ? { id: p.sub, email: p.email } : { id: '' },
        authReady: true,
      });
      return;
    }
    set({
      accessToken: access,
      isAuthenticated: true,
      user: payload?.sub ? { id: payload.sub, email: payload.email } : { id: '' },
      authReady: true,
    });
  },

  login: async (email, password) => {
    const deviceInfo = deviceStorage.getDeviceInfo();
    try {
      const res = await chatApi.login({ email, password, deviceInfo });
      if (res.require2fa) {
        return {
          ok: false,
          require2fa: true,
          error: 'Tai khoan yeu cau xac minh 2 buoc (2FA). Vui long hoan thanh 2FA tai ung dung chinh.',
        };
      }
      if (!res.accessToken) return { ok: false, error: 'Dang nhap that bai.' };
      tokenStorage.set(res.accessToken, res.refreshToken);
      const payload = decodeJwt(res.accessToken);
      set({
        accessToken: res.accessToken,
        isAuthenticated: true,
        user: payload?.sub ? { id: payload.sub, email: payload.email } : { id: '' },
      });
      return { ok: true };
    } catch (e) {
      const err = e as ApiError;
      return { ok: false, error: err.message ?? 'Dang nhap that bai.' };
    }
  },

  logout: () => {
    tokenStorage.clear();
    set({ user: null, accessToken: null, isAuthenticated: false });
  },

  impersonate: ({ accessToken, refreshToken, user }) => {
    tokenStorage.set(accessToken, refreshToken);
    set({
      accessToken,
      isAuthenticated: true,
      authReady: true,
      impersonating: true,
      user: { id: user.id, email: user.email, displayName: user.displayName, avatarUrl: user.avatar },
    });
  },

  exitImpersonate: () => {
    tokenStorage.clear();
    set({ user: null, accessToken: null, isAuthenticated: false, impersonating: false });
  },
}));

onAuthFailure(() => {
  useAuthStore.setState({ user: null, accessToken: null, isAuthenticated: false });
});
