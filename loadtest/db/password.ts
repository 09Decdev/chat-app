/**
 * MAYogu LoadTest Tool — password hashing (scrypt, node:crypto) + strength validation.
 * Format hash: `scrypt$N$r$p$salt$hash` (N được lưu trong chuỗi) — khớp db/init.ts
 * (PRD A1: không cần bcrypt/argon2). Nâng N lên 2^17 (OWASP hiện hành) — verify đọc N
 * từ hash đã lưu nên hash cũ (2^14) vẫn verify được.
 */

import * as crypto from 'node:crypto';

/** 2^17 — OWASP scrypt params (trước đây 2^14 thấp hơn khuyến nghị). */
const SCRYPT_N = 131072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
/** scryptSync maxmem: 128·N·r = 128MiB với N=2^17,r=8 — set 256MiB cho dư (hash cũ N nhỏ hơn vẫn OK). */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/** Hash password bằng scrypt theo format `scrypt$N$r$p$salt$hash`. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }).toString('hex');
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
    const actual = crypto.scryptSync(password, salt, KEY_LEN, { N: n, r, p, maxmem: SCRYPT_MAXMEM }).toString('hex');
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