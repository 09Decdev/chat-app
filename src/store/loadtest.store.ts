/**
 * LoadTest store (zustand) — single source cho toàn bộ tool (UI-SPEC §2/§4.1).
 * - config: GET /api/loadtest/config (1 lần mỗi session).
 * - run state: status + tick ring buffer 3600 (polling 1s — MVP không dùng WS push).
 * - prefs: localStorage (requireEnvConfirm).
 * Mọi component subscribe slice cụ thể — CẤM subscribe `s => s`.
 */
import { create } from 'zustand';
import { loadtestApi, toApiError, type LoadtestApiError } from '@/lib/loadtest-api';
import { loadPrefs, savePrefs } from '@/store/loadtest-prefs';
import type {
  ActionProfile,
  LoadTestConfig,
  LoadTestTick,
  PollStatus,
  RunPhase,
  StartRunRequest,
} from '@/types/loadtest';
import { TERMINAL_PHASES } from '@/types/loadtest';

export const RING_CAPACITY = 3600; // 1 giờ @1s — UI-SPEC 4.1
export const DEFAULT_PROFILE: ActionProfile = { chat: 40, read: 30, comment: 20, like: 10, view: 0, post: 0 };

interface LoadtestState {
  // config (server)
  config: LoadTestConfig | null;
  configLoading: boolean;
  configError: string | null;

  // run state
  runId: string;
  phase: RunPhase;
  startAt: number;
  elapsedSec: number;
  stopReason: string;
  isRunning: boolean;

  // live data
  lastTick: LoadTestTick | null;
  ticks: LoadTestTick[];
  pollStatus: PollStatus;

  // action profile (Scenario Builder → Control Panel)
  profile: ActionProfile;
  setProfile: (p: ActionProfile) => void;

  // prefs
  requireEnvConfirm: boolean;
  setRequireEnvConfirm: (v: boolean) => void;

  // actions
  loadConfig: () => Promise<void>;
  startRun: (req: StartRunRequest) => Promise<{ ok: boolean; runId?: string; error?: LoadtestApiError }>;
  stopRun: (force?: boolean) => Promise<{ ok: boolean; error?: LoadtestApiError }>;
  pauseRun: () => Promise<void>;
  resumeRun: () => Promise<void>;
  pollOnce: () => Promise<void>;
  resetRun: () => void;
}

export const useLoadtestStore = create<LoadtestState>((set, get) => ({
  config: null,
  configLoading: false,
  configError: null,

  runId: '',
  phase: 'idle',
  startAt: 0,
  elapsedSec: 0,
  stopReason: '',
  isRunning: false,

  lastTick: null,
  ticks: [],
  pollStatus: 'offline',

  profile: DEFAULT_PROFILE,
  setProfile: (p) => set({ profile: p }),

  requireEnvConfirm: loadPrefs().requireEnvConfirm,
  setRequireEnvConfirm: (v) => {
    set({ requireEnvConfirm: v });
    savePrefs({ ...loadPrefs(), requireEnvConfirm: v });
  },

  loadConfig: async () => {
    if (get().config || get().configLoading) return;
    set({ configLoading: true, configError: null });
    try {
      const config = await loadtestApi.getConfig();
      set({ config, configLoading: false });
    } catch (e) {
      set({ configError: toApiError(e).message, configLoading: false });
    }
  },

  startRun: async (req) => {
    try {
      const res = await loadtestApi.start(req);
      set({
        runId: res.runId,
        phase: 'provisioning',
        startAt: Date.now(),
        elapsedSec: 0,
        stopReason: '',
        isRunning: true,
        lastTick: null,
        ticks: [],
        pollStatus: 'connecting',
      });
      return { ok: true, runId: res.runId };
    } catch (e) {
      return { ok: false, error: toApiError(e) };
    }
  },

  stopRun: async (force = false) => {
    try {
      await loadtestApi.stop(force);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: toApiError(e) };
    }
  },

  pauseRun: async () => {
    try {
      await loadtestApi.pause();
    } catch {
      // best-effort — trạng thái từ poll tiếp theo
    }
  },

  resumeRun: async () => {
    try {
      await loadtestApi.resume();
    } catch {
      // best-effort
    }
  },

  pollOnce: async () => {
    const st = get();
    // Run đã kết thúc — không poll thêm (FROZEN, chờ tick cuối).
    if (TERMINAL_PHASES.includes(st.phase)) return;
    try {
      const [status, metrics] = await Promise.all([
        loadtestApi.status(),
        loadtestApi.metrics(st.lastTick?.ts ?? 0),
      ]);
      const lastTick = metrics.ticks.length > 0 ? metrics.ticks[metrics.ticks.length - 1] : status.lastTick ?? null;
      set((s) => ({
        runId: status.runId || s.runId,
        phase: status.phase,
        startAt: status.startAt || s.startAt,
        elapsedSec: status.elapsedSec,
        stopReason: status.stopReason ?? '',
        isRunning: status.isRunning,
        lastTick: lastTick ?? s.lastTick,
        ticks: [...s.ticks, ...metrics.ticks].slice(-RING_CAPACITY),
        pollStatus: 'live',
      }));
    } catch {
      // E9 — mất kết nối dữ liệu live: giữ giá trị cuối, chờ reconnect.
      set((s) => ({
        pollStatus: s.pollStatus === 'live' ? 'reconnecting' : s.pollStatus === 'offline' ? 'offline' : s.pollStatus,
      }));
    }
  },

  resetRun: () => {
    set({
      runId: '',
      phase: 'idle',
      startAt: 0,
      elapsedSec: 0,
      stopReason: '',
      isRunning: false,
      lastTick: null,
      ticks: [],
      pollStatus: 'offline',
    });
  },
}));

/** Hook polling 1s — chạy khi AppShell mount, tự dừng khi run kết thúc. */
export function useLoadtestPoll() {
  return useLoadtestStore((s) => s.pollOnce);
}

/** Slice selector: tick array cố định — dùng cho chart (cấm subscribe toàn store). */
export function selectTicks(state: LoadtestState): LoadTestTick[] {
  return state.ticks;
}
