/**
 * T4 — sanitizeLogText (DESIGN-loadtest-e2-connect-fail §3): control chars (F-3),
 * URL credential / key=value / token trần (F-5 bypass từng loại), cap length (F-4).
 */
import { describe, it, expect } from 'vitest';
import { sanitizeLogText } from '../sanitize';

const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

describe('sanitizeLogText — control chars (F-3)', () => {
  it('strip \n \r\n và control chars → space, KHÔNG còn dòng mới (chống log injection dòng giả)', () => {
    const out = sanitizeLogText('ok\n[lt][ERROR] forged\r\nnext\x00line\x1fend');
    expect(out).not.toMatch(/\n/);
    expect(out).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(out).toBe('ok [lt][ERROR] forged next line end');
  });

  it('null/undefined → "" (không throw)', () => {
    expect(sanitizeLogText(null)).toBe('');
    expect(sanitizeLogText(undefined)).toBe('');
  });
});

describe('sanitizeLogText — URL credential (F-5)', () => {
  it('user:pass@host → user:***@host (đầu chuỗi)', () => {
    expect(sanitizeLogText('postgresql://appuser:s3cret@localhost/db')).toBe('postgresql://appuser:***@localhost/db');
  });

  it('user:pass@host → user:***@host (nhúng giữa câu — bỏ anchor ^)', () => {
    expect(sanitizeLogText('cannot reach postgresql://appuser:s3cret@localhost/db now')).toBe(
      'cannot reach postgresql://appuser:***@localhost/db now',
    );
  });
});

describe('sanitizeLogText — key=value / query (F-5 bypass từng loại)', () => {
  it('query string: redact VALUE giữ key (?access_token=…&token=…)', () => {
    expect(sanitizeLogText('?access_token=abc&token=xyz')).toBe('?access_token=[REDACTED]&token=[REDACTED]');
  });

  it('KHÔNG cần word-boundary trước key (xaccess_token=…)', () => {
    expect(sanitizeLogText('xaccess_token=abc')).toBe('xaccess_token=[REDACTED]');
  });

  it('apiKey= / api_key= / jwt= / sid= / session_id= / password: / authorization: Bearer', () => {
    expect(sanitizeLogText('apiKey=sk-123')).toBe('apiKey=[REDACTED]');
    expect(sanitizeLogText('api_key=sk-123')).toBe('api_key=[REDACTED]');
    expect(sanitizeLogText('jwt=abc.def.ghi')).toBe('jwt=[REDACTED]');
    expect(sanitizeLogText('sid=x1y2z3')).toBe('sid=[REDACTED]');
    expect(sanitizeLogText('session_id=xyz')).toBe('session_id=[REDACTED]');
    expect(sanitizeLogText('password: TopSecret!')).toBe('password: [REDACTED]');
  });

  it('Authorization header + JWT sau Bearer đều bị redact (ST-10)', () => {
    const out = sanitizeLogText(`Authorization: Bearer ${JWT}`);
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out).toContain('[REDACTED]');
  });
});

describe('sanitizeLogText — token trần (F-5)', () => {
  it('JWT 3-part KHÔNG cần prefix eyJ', () => {
    expect(sanitizeLogText('session: abcdefgh.ijklmnop.qrstuvwx')).toBe('session: [REDACTED]');
  });

  it('token 2-part session (12+ . 12+)', () => {
    expect(sanitizeLogText('refresh abcdefghijkl.mnopqrstuvwx now')).toBe('refresh [REDACTED] now');
  });

  it('hex ≥ 32 (hex-40 refresh token)', () => {
    const hex40 = 'abcdef0123456789abcdef0123456789abcdef01';
    expect(sanitizeLogText(`token trần ${hex40}`)).toBe('token trần [REDACTED]');
  });
});

describe('sanitizeLogText — cap length (F-4)', () => {
  it('maxLen cắt đuôi', () => {
    expect(sanitizeLogText('x'.repeat(2000), 10)).toBe('x'.repeat(10));
    expect(sanitizeLogText('hello world', 5)).toBe('hello');
  });

  it('text sạch bình thường KHÔNG bị đổi', () => {
    expect(sanitizeLogText('connect_error: websocket error')).toBe('connect_error: websocket error');
  });
});
