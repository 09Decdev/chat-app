/**
 * MAYogu LoadTest Tool — guards (B-3: dispatcher áp dụng, handler KHÔNG tự gọi guard).
 * - `requireAuth` — verify Bearer token (HMAC, không decode — giữ logic cũ).
 * - `registerGate` — LOADTEST_ALLOW_REGISTER (mặc định false) → 403.
 */

import * as http from 'node:http';
import type { LoadTestEnv } from './config';
import { verifySessionToken } from './auth';
import type { SessionUser } from './auth';

export type AuthResult = { ok: true; user: SessionUser } | { ok: false; message: string };

/** Verify Bearer token (HMAC, không decode) — ≤ 1ms, không DB lookup (PRD US-3). */
export function requireAuth(req: http.IncomingMessage, authSecret: string): AuthResult {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return { ok: false, message: 'Thiếu Authorization: Bearer <token>' };
  const result = verifySessionToken(m[1], authSecret);
  if (!result.ok) {
    return {
      ok: false,
      message: result.reason === 'expired' ? 'Phiên hết hạn, đăng nhập lại' : 'Token không hợp lệ',
    };
  }
  return { ok: true, user: { id: Number(result.payload.sub), username: result.payload.username } };
}

/** Register gate (SEC-6 / US-SEC-3): env.allowRegister=false → 403 (chạy TRƯỚC body validation). */
export function registerGate(env: LoadTestEnv): boolean {
  return env.allowRegister;
}