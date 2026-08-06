/**
 * Unit tests — db/int.ts helpers (T-05): BIGINT boundary + B-1 redaction.
 * Không cần Postgres — pure functions.
 */
import { describe, it, expect } from 'vitest';
import { parseBigInt, toEpochMs, isTransient, isBusinessError, redactSql, redactParams } from '../db/int';

describe('db/int — parseBigInt (D-7: BIGINT an toàn < 2^53)', () => {
  it('string epoch ms → number', () => {
    expect(parseBigInt('1720000000000')).toBe(1720000000000);
    expect(Number.isSafeInteger(parseBigInt('1720000000000'))).toBe(true);
  });
  it('bigint an toàn → number; > 2^53 → null (không sai số im lặng)', () => {
    expect(parseBigInt(9007199254740991n)).toBe(9007199254740991);
    expect(parseBigInt(9007199254740992n)).toBeNull();
  });
  it('number / null / undefined / rỗng', () => {
    expect(parseBigInt(42)).toBe(42);
    expect(parseBigInt(null)).toBeNull();
    expect(parseBigInt(undefined)).toBeNull();
    expect(parseBigInt('')).toBeNull();
  });
});

describe('db/int — toEpochMs (D-5: float → integer BIGINT)', () => {
  it('Math.trunc float mtimeMs', () => {
    expect(toEpochMs(1720000000000.999)).toBe(1720000000000);
    expect(toEpochMs('1720000000000.5')).toBe(1720000000000);
  });
  it('null/undefined → null', () => {
    expect(toEpochMs(null)).toBeNull();
    expect(toEpochMs(undefined)).toBeNull();
  });
});

describe('db/int — isTransient / isBusinessError (retry policy)', () => {
  it('transient → retry; business → KHÔNG retry', () => {
    expect(isTransient('ECONNRESET')).toBe(true);
    expect(isTransient('08006')).toBe(true);
    expect(isTransient('23505')).toBe(false); // unique
    expect(isTransient('23503')).toBe(false); // FK
    expect(isTransient('22P02')).toBe(false); // invalid input
    expect(isBusinessError('23505')).toBe(true);
    expect(isBusinessError('23503')).toBe(true);
    expect(isBusinessError('22P02')).toBe(true);
    expect(isBusinessError('ECONNRESET')).toBe(false);
  });
});

describe('db/int — redaction (B-1 / TH-11)', () => {
  it('redactParams: key nhạy cảm → [REDACTED], object khác giữ nguyên', () => {
    const red = redactParams([
      { password: 'plaintext', email: 'a@b.c' },
      { hash: 'scrypt-hash', token: 'jwt', refreshToken: 'rt', otpSecret: 's', displayName: 'x' },
      'plain-string',
      42,
      null,
    ]);
    expect(red).toEqual([
      { password: '[REDACTED]', email: 'a@b.c' },
      { hash: '[REDACTED]', token: '[REDACTED]', refreshToken: '[REDACTED]', otpSecret: '[REDACTED]', displayName: 'x' },
      'plain-string',
      42,
      null,
    ]);
  });
  it('redactParams undefined → undefined', () => {
    expect(redactParams(undefined)).toBeUndefined();
  });
  it('redactSql: literal chứa sensitive column → [REDACTED] (không lộ password)', () => {
    const sql = `INSERT INTO pool_accounts (email, password) VALUES ('a@b.c', 'SuperSecret123')`;
    const red = redactSql(sql);
    expect(red).not.toContain('SuperSecret123');
    expect(red).toContain('[REDACTED]');
  });
  it('redactSql: SQL không có sensitive column → giữ nguyên', () => {
    const sql = `SELECT run_id FROM runs WHERE run_id = 'lt-1'`;
    expect(redactSql(sql)).toBe(sql);
  });
  it('redactParams position-aware: flat param ở cột password → [REDACTED] (T-05)', () => {
    const red = redactParams(
      ['a@b.c', 'PlainTextPw123', 'u1', 'A'],
      `INSERT INTO pool_accounts (email, password, user_id, display_name) VALUES ($1, $2, $3, $4)`,
    );
    expect(red).toEqual(['a@b.c', '[REDACTED]', 'u1', 'A']);
  });
  it('redactParams position-aware: UPDATE cột password_hash → [REDACTED] (T-05)', () => {
    const red = redactParams(
      ['scrypt$abc', 'admin'],
      `UPDATE admin_users SET password_hash = $1 WHERE username = $2`,
    );
    expect(red).toEqual(['[REDACTED]', 'admin']);
  });
  it('redactParams: giá trị scrypt-hash dạng chuỗi → [REDACTED] (kể cả SQL không có cột sensitive)', () => {
    const red = redactParams(['scrypt$abc123xyz'], `SELECT * FROM x WHERE y = $1`);
    expect(red).toEqual(['[REDACTED]']);
  });
  it('redactParams: chuỗi hex/base64 dài ≥ 32 → [REDACTED]', () => {
    const red = redactParams(['a'.repeat(64), 'short']);
    expect(red).toEqual(['[REDACTED]', 'short']);
  });
  it('redactParams: param bình thường (run id) KHÔNG redact (T-05)', () => {
    const red = redactParams(['lt-run-1', 'running', 1000], `INSERT INTO runs (run_id, status, start_at) VALUES ($1, $2, $3)`);
    expect(red).toEqual(['lt-run-1', 'running', 1000]);
  });
});