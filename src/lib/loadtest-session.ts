/**
 * LoadTest session expiry notice (T-09 / L-6) — UI-SPEC-prod-refactor §3.1.
 *
 * `expiresAt` là nguồn sự thật duy nhất (server SESSION_TTL_MS — KHÔNG hardcode "12 giờ"
 * ở client). Text động = static snapshot tại thời điểm mount (không live countdown trong
 * vùng role="alert" — tránh re-announce mỗi phút với screen reader).
 */

/** Cảnh báo trước 30 phút khi hết hạn. */
export const SESSION_WARN_BEFORE_MS = 30 * 60 * 1000;

/** Số ms còn lại cho tới lúc hết hạn (expiresAt - now). */
export function sessionRemainingMs(expiresAt: number, now = Date.now()): number {
  return expiresAt - now;
}

/** Có nên hiện cảnh báo? expiresAt null/0/expired → false; trong cửa sổ 30 phút → true. */
export function shouldWarnSession(expiresAt: number | null, now = Date.now()): boolean {
  if (!expiresAt || expiresAt <= 0) return false;
  const rem = sessionRemainingMs(expiresAt, now);
  return rem > 0 && rem <= SESSION_WARN_BEFORE_MS;
}

/**
 * Text động — snapshot tại thời điểm gọi (KHÔNG hardcode 12h).
 * < 1h → phút (cảnh báo chỉ hiện trong 30 phút cuối — "1 giờ" sai lệch, W3 T-08).
 */
export function sessionExpiryText(expiresAt: number, now = Date.now()): string {
  const rem = sessionRemainingMs(expiresAt, now);
  if (rem < 3600_000) {
    const minutes = Math.max(1, Math.round(rem / 60_000));
    return `Phiên loadtest hết hạn trong ${minutes} phút kể từ khi đăng nhập. Hãy lưu dữ liệu cần thiết — sau khi hết hạn bạn phải đăng nhập lại.`;
  }
  const hours = Math.max(1, Math.round(rem / 3600_000));
  return `Phiên loadtest hết hạn trong ${hours} giờ kể từ khi đăng nhập. Hãy lưu dữ liệu cần thiết — sau khi hết hạn bạn phải đăng nhập lại.`;
}