/**
 * Unit tests — Socket Farm pure helpers (profile picker + test content).
 * VirtualUser cần socket.io-client thật — chỉ test phần thuần.
 */
import { describe, it, expect } from 'vitest';
import { pickProfile } from '../socket-farm';
import { genChatContent, genCommentContent, genTopicTitle, genPassword, genDateOfBirth, genDeviceInfo, uuidV4, randomHex } from '../util';
import type { ActionProfile } from '../types';

const PROFILE: ActionProfile = { chat: 40, read: 30, comment: 20, like: 10, view: 0 };

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
