/**
 * Unit tests — Admin auth (PRD-loadtest-admin-auth Module A):
 * scrypt hash/verify, password strength, session token HMAC (valid/tampered/expired).
 */
import { describe, it, expect } from 'vitest';
import * as crypto from 'node:crypto';
import { hashPassword, verifyPassword, validatePasswordStrength } from '../db/password';
import { createSessionToken, verifySessionToken, SESSION_TTL_MS } from '../auth';

const SECRET = 'test-secret-0123456789abcdef';

describe('password — hash/verify (scrypt)', () => {
  it('hash đúng format scrypt$131072$8$1$salt$hash, không phải plaintext', () => {
    const h = hashPassword('Abc123!@');
    expect(h).toMatch(/^scrypt\$131072\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    expect(h).not.toContain('Abc123!@');
  });

  it('verify đúng password → true, sai password → false', () => {
    const h = hashPassword('Abc123!@');
    expect(verifyPassword('Abc123!@', h)).toBe(true);
    expect(verifyPassword('wrong-pass', h)).toBe(false);
  });

  it('verify hash cũ (N=16384, tạo bởi phiên bản trước) vẫn đúng — backward compat', () => {
    // Format lưu N trong chuỗi: scrypt$16384$8$1$salt$hash — verify phải đọc N từ hash, không hardcode.
    const salt = 'a'.repeat(32);
    const hash = crypto.scryptSync('Abc123!@', salt, 64).toString('hex');
    const oldHash = `scrypt$16384$8$1$${salt}$${hash}`;
    expect(verifyPassword('Abc123!@', oldHash)).toBe(true);
    expect(verifyPassword('wrong-pass', oldHash)).toBe(false);
  });

  it('verify hash hỏng/format lạ → false (không throw)', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'bcrypt$10$abc')).toBe(false);
    expect(verifyPassword('x', '')).toBe(false);
  });
});

describe('password — strength (≥8 ký tự + 3/4 nhóm)', () => {
  it('password < 8 ký tự → 400 message', () => {
    expect(validatePasswordStrength('Ab1!')).toContain('8 ký tự');
  });

  it('chỉ 2 nhóm ký tự → fail', () => {
    expect(validatePasswordStrength('abcdefgh')).toContain('3/4');
  });

  it('đủ 3 nhóm (thường + hoa + số) → pass', () => {
    expect(validatePasswordStrength('abcDEF123')).toBeNull();
  });

  it('đủ 3 nhóm (thường + hoa + số + đặc biệt) → pass', () => {
    expect(validatePasswordStrength('Ab!cdefgh')).toBeNull();
  });
});

describe('session token — HMAC (PRD US-2)', () => {
  it('create + verify roundtrip → payload đúng, exp = now + 12h', () => {
    const { token, expiresAt } = createSessionToken({ id: 7, username: 'admin' }, SECRET);
    const result = verifySessionToken(token, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.sub).toBe('7');
      expect(result.payload.username).toBe('admin');
      expect(result.payload.exp).toBe(expiresAt);
      expect(expiresAt - Date.now()).toBeGreaterThan(SESSION_TTL_MS - 1000);
    }
  });

  it('token giả mạo / đổi payload → invalid (verify HMAC, không phải decode)', () => {
    const { token } = createSessionToken({ id: 7, username: 'admin' }, SECRET);
    const [body] = token.split('.');
    // forge payload sub=999 với cùng body format, không có chữ ký đúng
    const forgedPayload = Buffer.from(JSON.stringify({ sub: '999', username: 'admin', exp: Date.now() + 100000 })).toString('base64url');
    const forged = `${forgedPayload}.${body}`;
    const result = verifySessionToken(forged, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid');
  });

  it('sai secret → invalid', () => {
    const { token } = createSessionToken({ id: 7, username: 'admin' }, SECRET);
    expect(verifySessionToken(token, 'other-secret').ok).toBe(false);
  });

  it('token hết hạn → reason expired', () => {
    const { token } = createSessionToken({ id: 7, username: 'admin' }, SECRET, -1000); // TTL âm → đã hết hạn
    const result = verifySessionToken(token, SECRET);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('token rác / sai format → invalid', () => {
    expect(verifySessionToken('', SECRET).ok).toBe(false);
    expect(verifySessionToken('abc', SECRET).ok).toBe(false);
    expect(verifySessionToken('a.b.c', SECRET).ok).toBe(false);
  });
});