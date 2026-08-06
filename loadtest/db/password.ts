/**
 * MAYogu LoadTest Tool — password hashing (scrypt, node:crypto) + strength validation.
 * Format hash: `scrypt$16384$8$1$<salt>$<hash>` — khớp db/init.ts (PRD A1: không cần bcrypt/argon2).
 */

import * as crypto from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

/** Hash password bằng scrypt theo format `scrypt$N$r$p$salt$hash`. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEY_LEN).toString('hex');
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash}`;
}

/** Verify password với hash đã lưu (parsing format + timingSafeEqual). */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = parts[4];
    const expected = parts[5];
    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p) || !salt || !expected) return false;
    const actual = crypto.scryptSync(password, salt, KEY_LEN, { N: n, r, p }).toString('hex');
    const a = Buffer.from(actual, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Yêu cầu mật khẩu admin: ≥ 8 ký tự + đủ 3/4 nhóm ký tự (chữ thường, chữ hoa, số, ký tự đặc biệt).
 * Chuẩn genPassword (util.ts:57-70) — PRD US-1: password < 8 hoặc không đủ 3/4 nhóm → 400.
 * Trả về message lỗi (null = hợp lệ).
 */
export function validatePasswordStrength(password: string): string | null {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Password phải có ít nhất 8 ký tự';
  }
  let groups = 0;
  if (/[a-z]/.test(password)) groups++;
  if (/[A-Z]/.test(password)) groups++;
  if (/[0-9]/.test(password)) groups++;
  if (/[^a-zA-Z0-9]/.test(password)) groups++;
  if (groups < 3) {
    return 'Password phải đủ 3/4 nhóm ký tự (chữ thường, chữ hoa, số, ký tự đặc biệt)';
  }
  return null;
}