/**
 * LoadTest admin session — lưu token + user vào localStorage (PRD C5: dev tool,
 * chấp nhận cho MVP). Tách rời khỏi store để axios interceptor đọc không gây
 * vòng import (loadtest-api ↔ loadtest-auth.store).
 */
import type { LoadtestAdminUser } from '@/types/loadtest';

const KEY = 'loadtest.auth';

export interface LoadtestAuthSnapshot {
  token: string;
  expiresAt: number;
  user: LoadtestAdminUser;
}

export const loadtestAuthStorage = {
  load(): LoadtestAuthSnapshot | null {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<LoadtestAuthSnapshot>;
      if (typeof parsed.token !== 'string' || !parsed.token) return null;
      return {
        token: parsed.token,
        expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0,
        user: parsed.user ?? { id: 0, username: '', email: '', displayName: '', role: 'admin' },
      };
    } catch {
      return null;
    }
  },
  save(snapshot: LoadtestAuthSnapshot): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(snapshot));
    } catch {
      // ignore — localStorage có thể đầy/disabled
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
  },
};