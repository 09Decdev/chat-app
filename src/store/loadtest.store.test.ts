import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// ── Mock loadtest-api: store chỉ thao tác qua loadtestApi + toApiError ──
const mocks = vi.hoisted(() => ({
  loadtestApi: {
    getConfig: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    status: vi.fn(),
    metrics: vi.fn(),
  },
  toApiError: vi.fn(),
}));

vi.mock('@/lib/loadtest-api', () => ({
  loadtestApi: mocks.loadtestApi,
  toApiError: mocks.toApiError,
}));

// Set localStorage BEFORE import store (store đọc loadPrefs lúc khởi tạo).
localStorage.setItem('loadtest.prefs', JSON.stringify({ requireEnvConfirm: false }));

const { useLoadtestStore, useLoadtestPoll, selectTicks, RING_CAPACITY, DEFAULT_PROFILE } = await import(
  '@/store/loadtest.store'
);

import type { LoadTestTick } from '@/types/loadtest';

function makeTick(ts: number, phase: string): LoadTestTick {
  return {
    type: 'tick',
    runId: 'run-1',
    ts,
    phase: phase as LoadTestTick['phase'],
    elapsedSec: 1,
    counters: {
      usersCreated: 0,
      usersConnected: 0,
      usersActive: 0,
      usersQueued: 0,
      usersInRoom: 0,
      actionsTotal: 0,
      successTotal: 0,
      failTotal: 0,
      echoOk: 0,
      echoSent: 0,
      queueCount: 0,
      roomCount: 0,
      droppedOutbox: 0,
      reconnectCount: 0,
      rateLimitedNoEcho: 0,
      connectAttempts: 0,
      connectFails: 0,
      connectFailsByType: { timeout: 0, transport: 0, reject: 0, other: 0 },
      usersFailed: 0,
      reconcileCount: 0,
      reconnectTotalMs: 0,
      reconnectMaxMs: 0,
      usersLost: 0,
    },
    rates: { successRate: 1, echoRate: 1, connectFailRate: 0 },
    actionsPerSec: {},
    latency: { p50: 1, p95: 2, p99: 3 },
    errors: [],
    errorsByStage: {},
    server: { wsConnections: 1, wsMessagesEmitted: 1, wsMessagesPerSec: 1 },
    workers: { alive: 1, total: 1, cpuAvg: 0, rssAvgMb: 0 },
  };
}

describe('loadtest.store — constants + selectors', () => {
  it('RING_CAPACITY = 3600 (1 giờ @1s)', () => {
    expect(RING_CAPACITY).toBe(3600);
  });

  it('DEFAULT_PROFILE đúng shape + tổng 100', () => {
    expect(DEFAULT_PROFILE).toEqual({ chat: 40, read: 30, comment: 20, like: 10, view: 0, post: 0 });
    const total = Object.values(DEFAULT_PROFILE).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });

  it('selectTicks trả state.ticks (slice selector — chart)', () => {
    const ticks = [makeTick(1, 'steady')];
    const state = useLoadtestStore.getState();
    useLoadtestStore.setState({ ticks });
    expect(selectTicks(useLoadtestStore.getState())).toBe(ticks);
    // restore
    useLoadtestStore.setState({ ticks: state.ticks });
  });
});

describe('loadtest.store — prefs (loadPrefs path, L-7)', () => {
  it('requireEnvConfirm khởi tạo từ localStorage (loadPrefs)', () => {
    expect(useLoadtestStore.getState().requireEnvConfirm).toBe(false);
  });

  it('setRequireEnvConfirm roundtrip → state + localStorage', () => {
    useLoadtestStore.getState().setRequireEnvConfirm(true);
    expect(useLoadtestStore.getState().requireEnvConfirm).toBe(true);
    expect(JSON.parse(localStorage.getItem('loadtest.prefs')!)).toEqual({ requireEnvConfirm: true });

    useLoadtestStore.getState().setRequireEnvConfirm(false);
    expect(useLoadtestStore.getState().requireEnvConfirm).toBe(false);
    expect(JSON.parse(localStorage.getItem('loadtest.prefs')!)).toEqual({ requireEnvConfirm: false });
  });
});

describe('loadtest.store — config', () => {
  beforeEach(() => {
    mocks.loadtestApi.getConfig.mockReset();
    useLoadtestStore.setState({ config: null, configLoading: false, configError: null });
  });

  it('loadConfig success → config set', async () => {
    mocks.loadtestApi.getConfig.mockResolvedValue({ port: 3401, allowRegister: true });
    await useLoadtestStore.getState().loadConfig();
    const s = useLoadtestStore.getState();
    expect(s.config).toEqual({ port: 3401, allowRegister: true });
    expect(s.configLoading).toBe(false);
    expect(s.configError).toBeNull();
  });

  it('loadConfig failure → configError = message', async () => {
    mocks.loadtestApi.getConfig.mockRejectedValue(new Error('boom'));
    mocks.toApiError.mockReturnValue({ statusCode: 0, message: 'network down', kind: 'network' });
    await useLoadtestStore.getState().loadConfig();
    const s = useLoadtestStore.getState();
    expect(s.configError).toBe('network down');
    expect(s.configLoading).toBe(false);
  });
});

describe('loadtest.store — run lifecycle', () => {
  beforeEach(() => {
    mocks.loadtestApi.start.mockReset();
    mocks.loadtestApi.stop.mockReset();
    mocks.loadtestApi.pause.mockReset();
    mocks.loadtestApi.resume.mockReset();
    mocks.loadtestApi.status.mockReset();
    mocks.loadtestApi.metrics.mockReset();
    mocks.toApiError.mockReset();
    useLoadtestStore.getState().resetRun();
  });

  it('startRun success → phase provisioning + isRunning', async () => {
    mocks.loadtestApi.start.mockResolvedValue({ runId: 'run-1', warnings: [], estimate: {} });
    const res = await useLoadtestStore.getState().startRun({
      targetUsers: 1000,
      rampRate: 10,
      rampMode: 'rate',
      durationMin: 5,
      profile: DEFAULT_PROFILE,
      gatewayUrl: 'http://localhost:3000',
    });
    expect(res).toEqual({ ok: true, runId: 'run-1' });
    const s = useLoadtestStore.getState();
    expect(s.phase).toBe('provisioning');
    expect(s.isRunning).toBe(true);
    expect(s.pollStatus).toBe('connecting');
  });

  it('startRun → warnings trả về khi server gửi (không nuốt)', async () => {
    mocks.loadtestApi.start.mockResolvedValue({ runId: 'run-2', warnings: ['target vượt năng lực máy'], estimate: {} });
    const res = await useLoadtestStore.getState().startRun({
      targetUsers: 1000,
      rampRate: 10,
      rampMode: 'rate',
      durationMin: 5,
      profile: DEFAULT_PROFILE,
      gatewayUrl: 'http://localhost:3000',
    });
    expect(res).toEqual({ ok: true, runId: 'run-2', warnings: ['target vượt năng lực máy'] });
    expect(useLoadtestStore.getState().paused).toBe(false);
  });

  it('startRun failure → ok:false + error từ toApiError', async () => {
    mocks.loadtestApi.start.mockRejectedValue(new Error('rate limit'));
    mocks.toApiError.mockReturnValue({ statusCode: 429, message: 'Thử lại sau', retryAfterSec: 30 });
    const res = await useLoadtestStore.getState().startRun({
      targetUsers: 1000,
      rampRate: 10,
      rampMode: 'rate',
      durationMin: 5,
      profile: DEFAULT_PROFILE,
      gatewayUrl: 'http://localhost:3000',
    });
    expect(res).toEqual({ ok: false, error: { statusCode: 429, message: 'Thử lại sau', retryAfterSec: 30 } });
  });

  it('stopRun success → ok:true', async () => {
    mocks.loadtestApi.stop.mockResolvedValue({ stopped: true, force: false });
    const res = await useLoadtestStore.getState().stopRun();
    expect(res).toEqual({ ok: true });
    expect(mocks.loadtestApi.stop).toHaveBeenCalledWith(false);
  });

  it('stopRun force → /kill payload', async () => {
    mocks.loadtestApi.stop.mockResolvedValue({ stopped: true, force: true });
    await useLoadtestStore.getState().stopRun(true);
    expect(mocks.loadtestApi.stop).toHaveBeenCalledWith(true);
  });

  it('stopRun failure → ok:false + error', async () => {
    mocks.loadtestApi.stop.mockRejectedValue(new Error('x'));
    mocks.toApiError.mockReturnValue({ statusCode: 500, message: 'server err' });
    const res = await useLoadtestStore.getState().stopRun();
    expect(res).toEqual({ ok: false, error: { statusCode: 500, message: 'server err' } });
  });

  it('pollOnce ở terminal phase → không gọi api', async () => {
    useLoadtestStore.setState({ phase: 'finished' });
    await useLoadtestStore.getState().pollOnce();
    expect(mocks.loadtestApi.status).not.toHaveBeenCalled();
    expect(mocks.loadtestApi.metrics).not.toHaveBeenCalled();
  });

  it('pollOnce success → ticks + pollStatus live', async () => {
    useLoadtestStore.setState({ phase: 'steady', ticks: [], lastTick: null });
    mocks.loadtestApi.status.mockResolvedValue({
      runId: 'run-1',
      phase: 'steady',
      startAt: 1,
      elapsedSec: 2,
      isRunning: true,
      stopReason: null,
    });
    mocks.loadtestApi.metrics.mockResolvedValue({ runId: 'run-1', ticks: [makeTick(5, 'steady')] });
    await useLoadtestStore.getState().pollOnce();
    const s = useLoadtestStore.getState();
    expect(s.phase).toBe('steady');
    expect(s.pollStatus).toBe('live');
    expect(s.ticks).toHaveLength(1);
    expect(s.ticks[0].ts).toBe(5);
  });

  it('pollOnce failure → pollStatus reconnecting, giữ dữ liệu', async () => {
    useLoadtestStore.setState({ phase: 'steady', pollStatus: 'live', ticks: [makeTick(1, 'steady')] });
    mocks.loadtestApi.status.mockRejectedValue(new Error('net'));
    mocks.loadtestApi.metrics.mockRejectedValue(new Error('net'));
    await useLoadtestStore.getState().pollOnce();
    const s = useLoadtestStore.getState();
    expect(s.pollStatus).toBe('reconnecting');
    expect(s.ticks).toHaveLength(1);
  });

  it('pollOnce in-flight → bỏ qua tick khi request trước chưa xong (không chồng request)', async () => {
    useLoadtestStore.setState({ phase: 'steady', ticks: [], lastTick: null });
    let resolveStatus!: (v: unknown) => void;
    mocks.loadtestApi.status.mockReturnValue(
      new Promise((r) => {
        resolveStatus = r;
      }),
    );
    mocks.loadtestApi.metrics.mockResolvedValue({ runId: 'run-1', ticks: [] });
    const p1 = useLoadtestStore.getState().pollOnce();
    // Tick thứ 2 khi request trước còn treo → return ngay, không gọi api lần nữa.
    await useLoadtestStore.getState().pollOnce();
    expect(mocks.loadtestApi.status).toHaveBeenCalledTimes(1);
    resolveStatus({ runId: 'run-1', phase: 'steady', startAt: 1, elapsedSec: 2, isRunning: true, stopReason: null });
    await p1;
    // Hết in-flight → tick sau chạy bình thường.
    await useLoadtestStore.getState().pollOnce();
    expect(mocks.loadtestApi.status).toHaveBeenCalledTimes(2);
  });

  it('resetRun → state về idle', () => {
    useLoadtestStore.setState({ phase: 'steady', isRunning: true, paused: true, ticks: [makeTick(1, 'steady')] });
    useLoadtestStore.getState().resetRun();
    const s = useLoadtestStore.getState();
    expect(s.phase).toBe('idle');
    expect(s.isRunning).toBe(false);
    expect(s.paused).toBe(false);
    expect(s.ticks).toEqual([]);
    expect(s.pollStatus).toBe('offline');
  });

  it('setProfile → profile cập nhật', () => {
    useLoadtestStore.getState().setProfile({ ...DEFAULT_PROFILE, chat: 50, read: 20 });
    expect(useLoadtestStore.getState().profile.chat).toBe(50);
  });

  it('pauseRun → gọi loadtestApi.pause (best-effort) + paused = true khi thành công', async () => {
    mocks.loadtestApi.pause.mockResolvedValue({ ok: true });
    await useLoadtestStore.getState().pauseRun();
    expect(mocks.loadtestApi.pause).toHaveBeenCalledTimes(1);
    expect(useLoadtestStore.getState().paused).toBe(true);
  });

  it('pauseRun failure → không throw (best-effort), paused không đổi', async () => {
    useLoadtestStore.setState({ paused: false });
    mocks.loadtestApi.pause.mockRejectedValue(new Error('net'));
    await expect(useLoadtestStore.getState().pauseRun()).resolves.toBeUndefined();
    expect(useLoadtestStore.getState().paused).toBe(false);
  });

  it('resumeRun → gọi loadtestApi.resume (best-effort) + paused = false', async () => {
    useLoadtestStore.setState({ paused: true });
    mocks.loadtestApi.resume.mockResolvedValue({ ok: true });
    await useLoadtestStore.getState().resumeRun();
    expect(mocks.loadtestApi.resume).toHaveBeenCalledTimes(1);
    expect(useLoadtestStore.getState().paused).toBe(false);
  });

  it('resumeRun failure → không throw (best-effort)', async () => {
    mocks.loadtestApi.resume.mockRejectedValue(new Error('net'));
    await expect(useLoadtestStore.getState().resumeRun()).resolves.toBeUndefined();
  });

  it('useLoadtestPoll → slice selector trả về pollOnce từ store', () => {
    const { result } = renderHook(() => useLoadtestPoll());
    expect(result.current).toBe(useLoadtestStore.getState().pollOnce);
  });
});