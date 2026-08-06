/**
 * F2 — burst ramp mode: connect TOÀN BỘ user ngay tick đầu (schedulerTick).
 * Tách riêng khỏi socket-farm.test.ts để mỗi feature commit mang test của nó.
 */
import { describe, it, expect, vi } from 'vitest';
import { VirtualUser, WorkerRuntime } from '../socket-farm';
import { getEnv } from '../config';
import type { TestAccount, RunConfig } from '../types';
import type { ActionResult } from '../rest-actions';

const ioMock = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: ioMock }));

const TEST_ACCOUNT: TestAccount = {
  email: 'user1@test.local',
  password: 'Abc123!@',
  userId: 'u1',
  accessToken: 'tok-1',
  refreshToken: 'ref-1',
  displayName: 'User 1',
  deviceInfo: {
    installationId: '00000000-0000-4000-8000-000000000001',
    deviceFingerprint: 'a'.repeat(64),
    platform: 'web',
    deviceName: 'test',
  },
  dateOfBirth: '2000-01-01',
  country: 'VN',
  registeredAt: 0,
};

function makeUser(index: number, email: string): VirtualUser {
  const u = new VirtualUser(index, { ...TEST_ACCOUNT, email, userId: `u${index}` }, 'chat', 'http://localhost:3000');
  u.phase = 'connected';
  return u;
}

describe('F2 — burst ramp mode (schedulerTick connect)', () => {
  function fakeSocket() {
    return {
      on: vi.fn(),
      emit: vi.fn(),
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(),
      connected: false,
      io: { reconnection: vi.fn() },
    };
  }

  function rtWithUsers(n: number, config: Partial<RunConfig>) {
    ioMock.mockReset();
    ioMock.mockReturnValue(fakeSocket());
    const rt = new WorkerRuntime(0, getEnv());
    rt.config = { targetUsers: n, rampRate: 10, rampMode: 'rate', workerCount: 1, ...config } as unknown as RunConfig;
    rt.users = Array.from({ length: n }, (_, i) => makeUser(i, `ramp-${i}@test.local`));
    // user loop của schedulerTick sẽ chạy ensureChatCycle cho user chat — mock để không đấm mạng thật
    vi.spyOn(rt.rest, 'chatEnqueue').mockResolvedValue({ ok: true, latencyMs: 1, code: '', failClass: 'OK' } as ActionResult);
    return rt;
  }

  it('burst → connect TOÀN BỘ user trong tick đầu (connectStarted = users.length)', () => {
    const rt = rtWithUsers(5, { rampMode: 'burst' });
    (rt as unknown as { schedulerTick: () => void }).schedulerTick();
    expect(rt.users.every((u) => u.phase === 'connecting')).toBe(true);
    expect((rt as unknown as { connectStarted: number }).connectStarted).toBe(5);
  });

  it('rate → pacing theo budget elapsed×rate, KHÔNG connect hết tick đầu (hành vi cũ)', () => {
    const rt = rtWithUsers(10, { rampRate: 10, rampMode: 'rate' });
    const inner = rt as unknown as { schedulerTick: () => void; rampStartedAt: number; connectStarted: number };
    inner.rampStartedAt = Date.now() - 300; // 0.3s × 10/s = 3
    inner.schedulerTick();
    expect(inner.connectStarted).toBe(3);
    expect(rt.users[2].phase).toBe('connecting');
    expect(rt.users[3].phase).not.toBe('connecting'); // user thứ 4 CHƯA được ramp connect (tick đầu)
    inner.rampStartedAt = Date.now() - 1000; // budget 10 → cạn
    inner.schedulerTick();
    expect(inner.connectStarted).toBe(10);
    expect(rt.users[9].phase).toBe('connecting');
  });

  it('minutes → pacing giữ hành vi cũ (dùng rampRate thuần — parse/lưu, không đổi hành vi)', () => {
    const rt = rtWithUsers(10, { rampRate: 10, rampMode: 'minutes' });
    const inner = rt as unknown as { schedulerTick: () => void; rampStartedAt: number; connectStarted: number };
    inner.rampStartedAt = Date.now() - 300;
    inner.schedulerTick();
    expect(inner.connectStarted).toBe(3); // cùng budget như rate
  });
});
