import { describe, it, expect } from 'vitest';
import {
  sessionRemainingMs,
  shouldWarnSession,
  sessionExpiryText,
  SESSION_WARN_BEFORE_MS,
} from '@/lib/loadtest-session';

const NOW = new Date(2026, 0, 1, 12, 0, 0).getTime();

describe('sessionRemainingMs', () => {
  it('expiresAt - now', () => {
    expect(sessionRemainingMs(NOW + 45 * 60_000, NOW)).toBe(45 * 60_000);
  });
  it('âm khi đã hết hạn', () => {
    expect(sessionRemainingMs(NOW - 5 * 60_000, NOW)).toBe(-5 * 60_000);
  });
});

describe('shouldWarnSession', () => {
  it('trong cửa sổ 30 phút → true', () => {
    expect(shouldWarnSession(NOW + 30 * 60_000, NOW)).toBe(true);
    expect(shouldWarnSession(NOW + 1 * 60_000, NOW)).toBe(true);
  });
  it('ngay cửa sổ (> 30 phút) → false', () => {
    expect(shouldWarnSession(NOW + SESSION_WARN_BEFORE_MS + 1, NOW)).toBe(false);
  });
  it('hết hạn / null / 0 → false', () => {
    expect(shouldWarnSession(NOW - 1, NOW)).toBe(false);
    expect(shouldWarnSession(null, NOW)).toBe(false);
    expect(shouldWarnSession(0, NOW)).toBe(false);
  });
});

describe('sessionExpiryText (W3 T-08 — phút khi < 1h, không nói "1 giờ")', () => {
  it('45 phút còn lại → "trong 45 phút"', () => {
    expect(sessionExpiryText(NOW + 45 * 60_000, NOW)).toContain('trong 45 phút');
    expect(sessionExpiryText(NOW + 45 * 60_000, NOW)).not.toContain('giờ');
  });
  it('30 phút còn lại → "trong 30 phút"', () => {
    expect(sessionExpiryText(NOW + 30 * 60_000, NOW)).toContain('trong 30 phút');
  });
  it('dưới 1 phút → tối thiểu "trong 1 phút" (không về 0)', () => {
    expect(sessionExpiryText(NOW + 10_000, NOW)).toContain('trong 1 phút');
  });
  it('≥ 1h vẫn dùng giờ', () => {
    expect(sessionExpiryText(NOW + 2 * 3600_000, NOW)).toContain('trong 2 giờ');
    expect(sessionExpiryText(NOW + 2 * 3600_000, NOW)).not.toContain('phút');
  });
});
