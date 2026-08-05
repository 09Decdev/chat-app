/**
 * MAYogu LoadTest Tool — sanitizer chung cho MỌI sink message (DESIGN-loadtest-e2-connect-fail §3).
 *
 * Nguồn không tin cậy: text gateway-controlled (err.message từ middleware/engine.io,
 * code/message từ chat:error) có thể chứa control chars (log injection dòng giả — F-3),
 * URL credential / key=value / token trần (JWT, session 2-part, hex — F-5), và quá dài (F-4).
 *
 * THUẦN — không IO, không import gì (tránh cycle với logger) — test được đơn lẻ.
 */

const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const NEWLINES = /\r?\n/g;
/** URL credential: `user:pass@host` → `user:***@host` ở BẤT KỲ đâu trong text (F-5;
 *  DESIGN §3 gắn ^ — bỏ anchor để bắt URL nhúng giữa câu, khớp intent redactUrl). */
const URL_CREDENTIAL = /([^:]+:\/\/[^:]+):[^@]*@/;
/** Key nhạy cảm trong query string — value bị redact (F-5). */
const QUERY_SECRET_KEY = /(?:access_token|api[_-]?key|jwt|session_id?|sid|sig|token|secret|otp|password|passwd|pwd|authorization|refresh_token)/i;
/** Key nhạy cảm dạng key=value / key: value — KHÔNG cần word-boundary trước key (F-5). */
const KV_SECRET_KEY = /(?:access_token|api[_-]?key|jwt|session_id?|sid|sig|password|passwd|pwd|token|secret|otp|authorization|refreshToken|refresh_token)/i;
/** JWT 3-part — không bắt buộc prefix eyJ (F-5). */
const JWT_3PART = /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
/** Token 2-part session (`body.sig`). */
const TOKEN_2PART = /\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g;
/** Hex ≥ 32 (hex-40 refresh token). */
const HEX_40 = /\b[0-9a-fA-F]{32,}\b/g;

/**
 * Sanitize text từ nguồn không tin cậy trước mọi sink:
 *  1) strip control chars + newline → space (F-3 — chống log injection dòng giả)
 *  2) URL credential user:pass@host → user:***@host (F-5)
 *  2b) query secret keys — redact VALUE, giữ key (F-5; sửa regex DESIGN §3 vốn chỉ append
 *      '[REDACTED]' sau value — secret vẫn còn nguyên)
 *  3) key=value / key: value nhạy cảm — KHÔNG cần word-boundary trước key (F-5)
 *  4) token trần: JWT 3-part (không bắt buộc prefix eyJ) + 2-part session + hex ≥ 32 (F-5)
 *  5) cap length maxLen (F-4)
 */
export function sanitizeLogText(raw: unknown, maxLen = 1000): string {
  const s0 = raw === null || raw === undefined ? '' : String(raw);
  let s = s0.replace(CONTROL_CHARS, ' ').replace(NEWLINES, ' '); // 1
  s = s.replace(URL_CREDENTIAL, '$1:***@'); // 2
  s = s.replace(
    new RegExp(`([?&]${QUERY_SECRET_KEY.source}[^=]*=)[^&\\s]+`, 'gi'),
    '$1[REDACTED]', // 2b — giữ key, redact value
  );
  s = s.replace(
    new RegExp(`((${KV_SECRET_KEY.source})\\s*[=:]\\s*)([^\\s,;|&]+)`, 'gi'),
    '$1[REDACTED]', // 3 — value dừng ở query separator & — không nuốt param kế tiếp
  );
  s = s.replace(JWT_3PART, '[REDACTED]'); // 4a
  s = s.replace(TOKEN_2PART, '[REDACTED]'); // 4b
  s = s.replace(HEX_40, '[REDACTED]'); // 4c
  return s.slice(0, maxLen); // 5
}
