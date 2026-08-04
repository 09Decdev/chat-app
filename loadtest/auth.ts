/**
 * MAYogu LoadTest Tool — Admin auth: session token HMAC-SHA256 (node:crypto, zero dep).
 *
 * Token format (PRD A2): `base64url(payload).base64url(hmac)` — payload `{ sub, username, exp }`.
 * Verify = HMAC lại (KHÔNG decode) — token giả mạo/thay đổi payload → 401 (PRD US-2).
 *
 * Secret: env `LOADTEST_AUTH_SECRET` hoặc persist `dataDir/auth-secret.json`
 * (sessions sống qua restart — PRD A3).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h (PRD A2 — MVP không refresh token)

export interface SessionUser {
  id: number;
  username: string;
}

export interface SessionPayload {
  sub: string;
  username: string;
  exp: number;
}

export type TokenVerifyResult =
  | { ok: true; payload: SessionPayload }
  | { ok: false; reason: 'expired' | 'invalid' };

/** Tạo session token HMAC-SHA256. */
export function createSessionToken(
  user: SessionUser,
  secret: string,
  ttlMs = SESSION_TTL_MS,
): { token: string; expiresAt: number } {
  const exp = Date.now() + ttlMs;
  const payload: SessionPayload = { sub: String(user.id), username: user.username, exp };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return { token: `${body}.${sig}`, expiresAt: exp };
}

/** Verify token (HMAC timing-safe) + kiểm tra hết hạn. Không phải decode đơn thuần. */
export function verifySessionToken(token: string, secret: string): TokenVerifyResult {
  const sep = token.indexOf('.');
  if (sep <= 0) return { ok: false, reason: 'invalid' };
  const body = token.slice(0, sep);
  const sig = token.slice(sep + 1);
  if (!body || !sig) return { ok: false, reason: 'invalid' };
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return { ok: false, reason: 'invalid' };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'invalid' };
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<SessionPayload>;
    if (typeof payload.sub !== 'string' || typeof payload.username !== 'string' || typeof payload.exp !== 'number') {
      return { ok: false, reason: 'invalid' };
    }
    if (payload.exp < Date.now()) return { ok: false, reason: 'expired' };
    return { ok: true, payload: payload as SessionPayload };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

/**
 * Load secret: env `LOADTEST_AUTH_SECRET` → file `dataDir/auth-secret.json` (tự sinh + persist
 * → sessions sống qua restart) → fallback secret ngẫu nhiên mỗi lần (sessions không sống qua restart).
 */
export function loadAuthSecret(dataDir: string): string {
  const fromEnv = process.env.LOADTEST_AUTH_SECRET;
  if (fromEnv) return fromEnv;
  const file = path.join(dataDir, 'auth-secret.json');
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { secret?: string };
      if (typeof parsed.secret === 'string' && parsed.secret) return parsed.secret;
    }
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ secret, createdAt: Date.now() }, null, 2), 'utf8');
    return secret;
  } catch {
    return crypto.randomBytes(32).toString('hex');
  }
}