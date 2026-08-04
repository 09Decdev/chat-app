/**
 * LoadTest admin auth store (zustand) — PRD-loadtest-admin-auth Module A.
 * - hydrate: khôi phục session từ localStorage (PRD C5).
 * - verify: xác thực token qua /auth/me khi mount guard (PRD C2).
 * - 401 từ mọi request → clearSession (đăng ký qua onLoadtestAuthFailure).
 */
import { create } from 'zustand';
import { loadtestApi, toApiError, onLoadtestAuthFailure } from '@/lib/loadtest-api';
import { loadtestAuthStorage } from '@/lib/loadtest-auth-storage';
import type { LoadtestAdminUser } from '@/types/loadtest';

interface LoadtestAuthState {
  user: LoadtestAdminUser | null;
  token: string | null;
  expiresAt: number | null;
  isAuthenticated: boolean;
  authReady: boolean;
  initialized: boolean;
  initialize: () => Promise<void>;
  login: (identifier: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  register: (username: string, email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  clearSession: () => void;
}

export const useLoadtestAuthStore = create<LoadtestAuthState>((set, get) => ({
  user: null,
  token: null,
  expiresAt: null,
  isAuthenticated: false,
  authReady: false,
  initialized: false,

  initialize: async () => {
    if (get().initialized) return;
    set({ initialized: true });
    const saved = loadtestAuthStorage.load();
    if (!saved) {
      set({ authReady: true, isAuthenticated: false });
      return;
    }
    if (saved.expiresAt <= Date.now()) {
      loadtestAuthStorage.clear();
      set({ authReady: true, isAuthenticated: false });
      return;
    }
    set({ user: saved.user, token: saved.token, expiresAt: saved.expiresAt, isAuthenticated: true, authReady: true });
    // PRD C2: check /auth/me khi mount — token sai/gate → 401 → interceptor clear session.
    try {
      const me = await loadtestApi.authMe();
      set({ user: me });
    } catch {
      // 401 → clearSession đã chạy; lỗi network → giữ session tạm thời.
    }
  },

  login: async (identifier, password) => {
    try {
      const res = await loadtestApi.authLogin(identifier, password);
      loadtestAuthStorage.save({ token: res.token, expiresAt: res.expiresAt, user: res.user });
      set({ token: res.token, expiresAt: res.expiresAt, user: res.user, isAuthenticated: true, authReady: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: toApiError(e).message };
    }
  },

  register: async (username, email, password) => {
    try {
      await loadtestApi.authRegister(username, email, password);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: toApiError(e).message };
    }
  },

  logout: async () => {
    try {
      await loadtestApi.authLogout();
    } catch {
      // best-effort — token bị xóa client-side dù server lỗi
    }
    loadtestAuthStorage.clear();
    set({ user: null, token: null, expiresAt: null, isAuthenticated: false, authReady: true });
  },

  clearSession: () => {
    loadtestAuthStorage.clear();
    set({ user: null, token: null, expiresAt: null, isAuthenticated: false, authReady: true });
  },
}));

// Mọi request loadtest nhận 401 (gate/hết hạn) → clear session → guard redirect login.
onLoadtestAuthFailure(() => {
  useLoadtestAuthStore.getState().clearSession();
});