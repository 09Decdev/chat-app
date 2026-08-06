/**
 * F3 — post action (worker-side): pickProfile post + pacing ~20s/user + runRest createPost.
 * Tách riêng khỏi socket-farm.test.ts để mỗi feature commit mang test của nó.
 */
import { describe, it, expect, vi } from 'vitest';
import { VirtualUser, WorkerRuntime, pickProfile } from '../socket-farm';
import { getEnv } from '../config';
import type { ActionProfile, TestAccount } from '../types';
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
  return new VirtualUser(index, { ...TEST_ACCOUNT, email, userId: `u${index}` }, 'post', 'http://localhost:3000');
}

describe('F3 — post action (worker)', () => {
  it('profile post 100% → pickProfile luôn trả post', () => {
    const p: ActionProfile = { chat: 0, read: 0, comment: 0, like: 0, view: 0, post: 100 };
    for (let i = 0; i < 100; i++) expect(pickProfile(p)).toBe('post');
  });

  it('rest pacing ~20s/user: < 15s → chưa đến lúc, ≥ 25s → rest', () => {
    const u = makeUser(0, 'post@test.local');
    u.phase = 'connected';
    const rt = new WorkerRuntime(0, getEnv());
    const now = Date.now();
    u.lastRestAt = now - 5_000; // jitter min = 20s × 0.75 = 15s
    expect(u.tick(now, rt)).toBeNull();
    u.lastRestAt = now - 30_000; // jitter max = 20s × 1.25 = 25s
    expect(u.tick(now, rt)).toEqual({ action: 'rest' });
  });

  it('runRest profile post → createPost(token, index) + recordResult post', async () => {
    const u = makeUser(3, 'post@test.local');
    const rt = new WorkerRuntime(0, getEnv());
    const postSpy = vi.spyOn(rt.rest, 'createPost').mockResolvedValue({
      ok: true, latencyMs: 7, code: '', failClass: 'OK',
    } as ActionResult);
    const recordSpy = vi.spyOn(rt, 'recordResult');
    await u.runRest(rt);
    expect(postSpy).toHaveBeenCalledWith('tok-1', 3);
    expect(recordSpy).toHaveBeenCalledWith('post', expect.objectContaining({ ok: true }), u);
    expect(u.currentAction).toBe('idle');
  });

  it('post fail → recordResult post fail, KHÔNG throw (403 đếm fail, không crash)', async () => {
    const u = makeUser(1, 'post@test.local');
    const rt = new WorkerRuntime(0, getEnv());
    vi.spyOn(rt.rest, 'createPost').mockResolvedValue({
      ok: false, latencyMs: 10, code: 'PERMISSION_ERROR', failClass: 'FORBIDDEN',
    } as ActionResult);
    await expect(u.runRest(rt)).resolves.toBeUndefined();
    expect(u.lastError).toContain('PERMISSION_ERROR');
  });
});
