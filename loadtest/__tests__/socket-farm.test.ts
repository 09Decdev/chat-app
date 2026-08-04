/**
 * Unit tests — Socket Farm pure helpers (profile picker + test content).
 * VirtualUser cần socket.io-client thật — chỉ test phần thuần.
 */
import { describe, it, expect, vi } from 'vitest';
import { pickProfile, VirtualUser } from '../socket-farm';
import { genChatContent, genCommentContent, genTopicTitle, genPassword, genDateOfBirth, genDeviceInfo, uuidV4, randomHex } from '../util';
import type { ActionProfile, TestAccount } from '../types';

const ioMock = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: ioMock }));

const PROFILE: ActionProfile = { chat: 40, read: 30, comment: 20, like: 10, view: 0 };

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

describe('socket handshake — KHÔNG token trong query (SEC-3 / F-8)', () => {
  it('VirtualUser.connect() gửi Authorization header + auth.token, KHÔNG query.token', () => {
    ioMock.mockReset();
    const fakeSocket = {
      on: vi.fn(),
      emit: vi.fn(),
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(),
      connected: false,
    };
    ioMock.mockReturnValue(fakeSocket);
    const u = new VirtualUser(0, TEST_ACCOUNT, 'chat', 'http://localhost:3000');
    u.connect();
    expect(ioMock).toHaveBeenCalledTimes(1);
    const [url, opts] = ioMock.mock.calls[0];
    expect(url).toBe('ws://localhost:3000');
    expect(opts.query).toBeUndefined(); // SEC-3: token KHÔNG trong query string
    expect(opts.extraHeaders.Authorization).toBe('Bearer tok-1');
    expect(opts.auth).toEqual({ token: 'tok-1' }); // W3 T-08: auth phủ ws package path
  });
});

describe('pickProfile (AC4.1)', () => {
  it('phân phối đúng theo % (sai số ~1%)', () => {
    const counts: Record<string, number> = { chat: 0, read: 0, comment: 0, like: 0, view: 0 };
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const p = pickProfile(PROFILE);
      counts[p]++;
    }
    for (const [k, v] of Object.entries(PROFILE)) {
      const pct = (counts[k] / N) * 100;
      expect(Math.abs(pct - v)).toBeLessThan(1.5);
    }
  });

  it('profile chat 100% → luôn chat', () => {
    const p: ActionProfile = { chat: 100, read: 0, comment: 0, like: 0, view: 0 };
    for (let i = 0; i < 100; i++) expect(pickProfile(p)).toBe('chat');
  });

  it('profile 0% → fallback read (không crash)', () => {
    const p: ActionProfile = { chat: 0, read: 0, comment: 0, like: 0, view: 0 };
    expect(pickProfile(p)).toBe('read');
  });
});

describe('test content (RD-3 — sạch profanity, prefix [lt])', () => {
  it('genChatContent có prefix [lt] và ổn định theo index', () => {
    const a = genChatContent(3);
    const b = genChatContent(3);
    expect(a.startsWith('[lt]')).toBe(true);
    expect(a).toBe(b);
    expect(genChatContent(4)).not.toBe(a);
  });

  it('genCommentContent có prefix [lt] + ≤ 2000 ký tự', () => {
    const c = genCommentContent(7);
    expect(c.startsWith('[lt]')).toBe(true);
    expect(c.length).toBeLessThanOrEqual(2000);
  });

  it('genTopicTitle 3–80 code point', () => {
    const t = genTopicTitle(12);
    expect(t.length).toBeGreaterThanOrEqual(3);
    expect(t.length).toBeLessThanOrEqual(80);
  });
});

describe('account generators (AC2.1 — đúng contract gateway-auth-service)', () => {
  it('genPassword đạt isValidPassword (≥8 ký tự, ≥3/4 nhóm)', () => {
    for (let i = 0; i < 50; i++) {
      const p = genPassword();
      expect(p.length).toBeGreaterThanOrEqual(8);
      const has = (re: RegExp) => re.test(p);
      const groups = [has(/[a-z]/), has(/[A-Z]/), has(/[0-9]/), has(/[^a-zA-Z0-9]/)].filter(Boolean).length;
      expect(groups).toBeGreaterThanOrEqual(3);
    }
  });

  it('genDateOfBirth ≥ 16 tuổi (isAtLeast16)', () => {
    const dob = genDateOfBirth(); // 1995-2004
    const year = Number(dob.slice(0, 4));
    expect(year).toBeGreaterThanOrEqual(1995);
    expect(year).toBeLessThanOrEqual(2004);
  });

  it('genDeviceInfo đúng regex deviceInfo.dto.ts', () => {
    const d = genDeviceInfo('ltrun1', 5);
    expect(d.installationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(d.deviceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(d.platform).toBe('web');
    expect(d.deviceName.length).toBeLessThanOrEqual(100);
  });

  it('uuidV4 hợp lệ + randomHex 64 hex', () => {
    expect(uuidV4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(randomHex(32)).toMatch(/^[a-f0-9]{64}$/);
  });
});
