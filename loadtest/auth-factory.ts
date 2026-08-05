/**
 * MAYogu LoadTest Tool — Auth Factory (AF-1..AF-4):
 * - OTP-Seed: ghi key `otp:register:{email}` + `register:sms:{email}` vào Redis test
 *   (HMAC-SHA256 với OTP_SECRET, đúng format mà auth-otp.service.ts:81-139 và
 *   auth-register.service.ts:439-523 đọc — TTL 300s).
 * - Register: flow 3 bước của gateway (không có endpoint 1 bước):
 *   verify-email -> verify-sms-otp -> complete (auth.controller.ts:233-297).
 * - Login: POST /auth/login (auth.controller.ts:71-85) — reuse account pool.
 * - Token pool: memory + disk (dataDir/accounts-{runId}.json) — AF-2.
 * - Register ramp ≤ env.maxRegisterRamp req/s (AF-3 — guest bucket 1000/8s).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Redis from 'ioredis';
import type { LoadTestEnv } from './config';
import type { RunConfig, TestAccount } from './types';
import { requestJson } from './http';
import { genDateOfBirth, genDeviceInfo, genPassword, genPhone, ltLog, normalizeUrl, sleep, uuidV4 } from './util';

const OTP_TTL_SECONDS = 300; // khớp auth-otp.service.ts:139

/** Số request register/login chạy song song (tuần tự = latency/request → 10k users mất hàng chục phút). */
const PROVISION_CONCURRENCY = Number(process.env.LOADTEST_PROVISION_CONCURRENCY) || 25;

/** Chạy tối đa `limit` task song song; mỗi task tự pacing qua limiter. */
async function runWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

export interface ProvisionSummary {
  accounts: TestAccount[];
  registered: number;
  loggedIn: number;
  failed: number;
  /** Chỉ đếm fail của bước REGISTER (không tính login) — dùng cho E1. */
  registerFailed: number;
  errors: Record<string, number>;
  /** runId cung cấp pool khi useExistingAccounts (PRD B4 — poolSourceRunId). */
  poolSourceRunId?: string;
  /** Outcome per-account (PRD B1 — giải bug "reuse pool log không đầy đủ" §1.9). */
  results?: AccountOutcome[];
}

/** Outcome per-account để ghi pool_accounts (status + lỗi + login info). */
export interface AccountOutcome {
  email: string;
  password: string;
  userId: string;
  displayName: string;
  deviceInfo: TestAccount['deviceInfo'];
  dateOfBirth: string;
  country: string;
  registeredAt: number | null;
  status: 'registered' | 'logged_in' | 'failed';
  lastErrorCode: string | null;
  lastLoginAt: number | null;
}

/** Seed key OTP cho 1 email — AF-1. */
export async function seedOtp(redis: Redis, email: string, otpSecret: string): Promise<string> {
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const otpHash = crypto.createHmac('sha256', otpSecret).update(otp).digest('hex');
  await redis.set(`otp:register:${email}`, JSON.stringify({ otpHash, attempt: 0 }), 'EX', OTP_TTL_SECONDS);
  return otp;
}

/** Seed key SMS OTP cho 1 email — khớp `register:sms:{email}` mà auth-register.service.ts:486-522 đọc. */
export async function seedSmsOtp(
  redis: Redis,
  email: string,
  phone: string,
  otpSecret: string,
): Promise<string> {
  const otp = String(Math.floor(100000 + Math.random() * 900000));
  const otpHash = crypto.createHmac('sha256', otpSecret).update(otp).digest('hex');
  await redis.set(`register:sms:${email}`, JSON.stringify({ otpHash, phone, attempt: 0 }), 'EX', OTP_TTL_SECONDS);
  return otp;
}

/** Parse body rawText (gateway trả { success, registrationKey } — requestJson unwrap nhầm thành null). */
function parseRaw<T>(raw: string | null): T | null {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Tên pool file theo runId — AF-2 (disk cache). */
export function poolPath(dataDir: string, runId: string): string {
  return path.join(dataDir, `accounts-${runId}.json`);
}

export function listPools(dataDir: string): { runId: string; targetUsers: number; gatewayUrl: string; mtimeMs: number }[] {
  if (!fs.existsSync(dataDir)) return [];
  const out: { runId: string; targetUsers: number; gatewayUrl: string; mtimeMs: number }[] = [];
  for (const f of fs.readdirSync(dataDir)) {
    const m = /^accounts-(.+)\.json$/.exec(f);
    if (!m) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')) as {
        runId: string; targetUsers: number; gatewayUrl: string; accounts?: TestAccount[];
      };
      out.push({
        runId: parsed.runId ?? m[1],
        targetUsers: parsed.targetUsers ?? 0,
        gatewayUrl: parsed.gatewayUrl ?? '',
        mtimeMs: fs.statSync(path.join(dataDir, f)).mtimeMs,
      });
    } catch {
      // bỏ file hỏng
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export interface TokenBucket {
  take(): boolean;
}

/** Bucket đơn giản: tối đa rate req/s, chờ khi hết. */
export class SimpleRateLimiter {
  private intervalMs: number;
  private nextAt = 0;
  constructor(ratePerSec: number) {
    this.intervalMs = ratePerSec > 0 ? 1000 / ratePerSec : 0;
  }
  async acquire(): Promise<void> {
    if (this.intervalMs <= 0) return;
    const now = Date.now();
    if (this.nextAt <= now) {
      this.nextAt = now + this.intervalMs;
      return;
    }
    const wait = this.nextAt - now;
    this.nextAt += this.intervalMs;
    await sleep(wait);
  }
}

/**
 * Provision toàn bộ account cho 1 run:
 * - useExisting: tìm pool cùng targetUsers + gatewayUrl trên disk → login lại (AF-4).
 * - fresh (hoặc không có pool): register OTP-Seed theo ramp.
 * Trả về mảng account + summary (dashboard đếm register/login fail realtime).
 * shouldStop: callback kill-switch — dừng sớm vòng loop khi run bị hủy (SD-3).
 */
export async function provisionAccounts(
  redis: Redis,
  config: RunConfig,
  env: LoadTestEnv,
  onProgress?: (done: number, total: number) => void,
  shouldStop?: () => boolean,
): Promise<ProvisionSummary> {
  const gateway = normalizeUrl(config.gatewayUrl);
  const summary: ProvisionSummary = { accounts: [], registered: 0, loggedIn: 0, failed: 0, registerFailed: 0, errors: {} };
  const existing = config.useExistingAccounts
    ? listPools(env.dataDir).find((p) => p.targetUsers === config.targetUsers && p.gatewayUrl === gateway)
    : undefined;

  if (existing) {
    summary.poolSourceRunId = existing.runId;
    ltLog.info(`Auth Factory: tái sử dụng pool ${existing.runId} (${existing.targetUsers} users) — login lại...`);
    const pool = JSON.parse(
      fs.readFileSync(path.join(env.dataDir, `accounts-${existing.runId}.json`), 'utf8'),
    ) as { accounts: TestAccount[] };
    const accounts = pool.accounts.slice(0, config.targetUsers);
    const limiter = new SimpleRateLimiter(config.registerRamp); // dùng chung ramp cho login (AF-3)
    const results: AccountOutcome[] = [];
    let done = 0;
    await runWithConcurrency(accounts, PROVISION_CONCURRENCY, async (acc) => {
      if (shouldStop?.()) return;
      await limiter.acquire();
      const res = await requestJson<{ accessToken: string; refreshToken: string; require2fa?: boolean; tempToken?: string }>(
        gateway,
        '/auth/login',
        { method: 'POST', body: { email: acc.email, password: acc.password, deviceInfo: acc.deviceInfo } },
      );
      if (res.ok && res.data?.accessToken) {
        acc.accessToken = res.data.accessToken;
        acc.refreshToken = res.data.refreshToken ?? acc.refreshToken;
        summary.loggedIn++;
        summary.accounts.push(acc);
        results.push({
          email: acc.email, password: acc.password, userId: acc.userId, displayName: acc.displayName,
          deviceInfo: acc.deviceInfo, dateOfBirth: acc.dateOfBirth, country: acc.country,
          registeredAt: acc.registeredAt, status: 'logged_in', lastErrorCode: null, lastLoginAt: Date.now(),
        });
      } else if (res.ok && res.data?.require2fa) {
        summary.failed++;
        summary.errors['TWO_FA_REQUIRED'] = (summary.errors['TWO_FA_REQUIRED'] ?? 0) + 1;
        results.push({
          email: acc.email, password: acc.password, userId: acc.userId, displayName: acc.displayName,
          deviceInfo: acc.deviceInfo, dateOfBirth: acc.dateOfBirth, country: acc.country,
          registeredAt: acc.registeredAt, status: 'failed', lastErrorCode: 'TWO_FA_REQUIRED', lastLoginAt: null,
        });
      } else {
        summary.failed++;
        const code = res.code || 'LOGIN_FAIL';
        summary.errors[code] = (summary.errors[code] ?? 0) + 1;
        results.push({
          email: acc.email, password: acc.password, userId: acc.userId, displayName: acc.displayName,
          deviceInfo: acc.deviceInfo, dateOfBirth: acc.dateOfBirth, country: acc.country,
          registeredAt: acc.registeredAt, status: 'failed', lastErrorCode: code, lastLoginAt: null,
        });
      }
      done++;
      onProgress?.(done, accounts.length);
    });
    summary.results = results;
    if (summary.accounts.length === 0) {
      ltLog.warn('Login toàn bộ fail — fallback register mới.');
    } else {
      persistPool(env, config.runId, config, summary.accounts);
      return summary;
    }
  }

  ltLog.info(`Auth Factory: register ${config.targetUsers} users (OTP-Seed, ramp ${config.registerRamp}/s)...`);
  const limiter = new SimpleRateLimiter(config.registerRamp);
  const indices = Array.from({ length: config.targetUsers }, (_, i) => i);
  const results: AccountOutcome[] = [];
  let done = 0;
  await runWithConcurrency(indices, PROVISION_CONCURRENCY, async (i) => {
    if (shouldStop?.()) return;
    await limiter.acquire();
    const email = `loadtest.${config.runId}.${i}@mayogu.test`;
    const password = genPassword();
    const deviceInfo = genDeviceInfo(config.runId, i);
    const acc: TestAccount = {
      email,
      password,
      userId: '',
      accessToken: '',
      refreshToken: '',
      displayName: `[lt] User ${config.runId}.${i}`,
      deviceInfo,
      dateOfBirth: genDateOfBirth(),
      country: 'VN',
      registeredAt: Date.now(),
    };
    const failResult = (code: string): AccountOutcome => ({
      email: acc.email, password: acc.password, userId: acc.userId, displayName: acc.displayName,
      deviceInfo: acc.deviceInfo, dateOfBirth: acc.dateOfBirth, country: acc.country,
      registeredAt: null, status: 'failed', lastErrorCode: code, lastLoginAt: null,
    });
    try {
      // B2: verify email OTP -> registrationKey (seed OTP trực tiếp, bỏ qua send-otp).
      const otp = await seedOtp(redis, email, env.otpSecret);
      const v1 = await requestJson<string>(gateway, '/auth/register/verify-email', {
        method: 'POST',
        body: { email, otp },
        rawText: true, // gateway trả { success, registrationKey } — requestJson unwrap nhầm thành null
      });
      const v1Body = parseRaw<{ registrationKey?: string }>(v1.data);
      if (!v1.ok || !v1Body?.registrationKey) {
        summary.failed++;
        summary.registerFailed++;
        const code = v1.code || 'VERIFY_EMAIL_FAIL';
        summary.errors[code] = (summary.errors[code] ?? 0) + 1;
        results.push(failResult(code));
        done++;
        onProgress?.(done, config.targetUsers);
        return;
      }
      const registrationKey = v1Body.registrationKey;

      // B4: verify SMS OTP -> phoneKey (seed SMS OTP trực tiếp, bỏ qua send-sms-otp).
      const phone = genPhone(i, config.seed);
      const smsOtp = await seedSmsOtp(redis, email, phone, env.otpSecret);
      const v2 = await requestJson<string>(gateway, '/auth/register/verify-sms-otp', {
        method: 'POST',
        body: { email, phoneNumber: phone, otp: smsOtp, registrationKey },
        rawText: true,
      });
      const v2Body = parseRaw<{ phoneKey?: string }>(v2.data);
      if (!v2.ok || !v2Body?.phoneKey) {
        summary.failed++;
        summary.registerFailed++;
        const code = v2.code || 'VERIFY_SMS_FAIL';
        summary.errors[code] = (summary.errors[code] ?? 0) + 1;
        results.push(failResult(code));
        done++;
        onProgress?.(done, config.targetUsers);
        return;
      }
      const phoneKey = v2Body.phoneKey;

      // B5: complete — TẠO TÀI KHOẢN + trả token.
      const res = await requestJson<{ accessToken: string; refreshToken: string }>(
        gateway,
        '/auth/register/complete',
        {
          method: 'POST',
          body: {
            email,
            passwordHash: password,
            phoneNumber: phone,
            phoneKey,
            registrationKey,
            dateOfBirth: acc.dateOfBirth,
            country: acc.country,
            deviceInfo: acc.deviceInfo,
            displayName: acc.displayName,
          },
        },
      );
      if (res.ok && res.data?.accessToken) {
        acc.accessToken = res.data.accessToken;
        acc.refreshToken = res.data.refreshToken ?? '';
        acc.userId = decodeSub(res.data.accessToken);
        summary.registered++;
        summary.accounts.push(acc);
        results.push({
          email: acc.email, password: acc.password, userId: acc.userId, displayName: acc.displayName,
          deviceInfo: acc.deviceInfo, dateOfBirth: acc.dateOfBirth, country: acc.country,
          registeredAt: acc.registeredAt, status: 'registered', lastErrorCode: null, lastLoginAt: null,
        });
      } else {
        summary.failed++;
        summary.registerFailed++;
        const code = res.code || 'REGISTER_FAIL';
        summary.errors[code] = (summary.errors[code] ?? 0) + 1;
        results.push(failResult(code));
      }
    } catch (_err) {
      summary.failed++;
      summary.registerFailed++;
      summary.errors['EXCEPTION'] = (summary.errors['EXCEPTION'] ?? 0) + 1;
      results.push(failResult('EXCEPTION'));
    }
    done++;
    onProgress?.(done, config.targetUsers);
  });

  // Giữ kết quả login fail (fallback register) + kết quả register — per-account outcome đầy đủ
  summary.results = [...(summary.results ?? []), ...results];
  persistPool(env, config.runId, config, summary.accounts);
  return summary;
}

function persistPool(env: LoadTestEnv, runId: string, config: RunConfig, accounts: TestAccount[]) {
  try {
    fs.mkdirSync(env.dataDir, { recursive: true });
    fs.writeFileSync(
      poolPath(env.dataDir, runId),
      JSON.stringify({ runId, targetUsers: config.targetUsers, gatewayUrl: normalizeUrl(config.gatewayUrl), accounts }),
      'utf8',
    );
  } catch (e) {
    ltLog.warn(`Không ghi được token pool: ${String(e)}`);
  }
}

/** Lấy userId từ access token (payload.sub) — không verify (JWT middleware cùng cách). */
function decodeSub(token: string): string {
  try {
    const payload = token.split('.')[1];
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return String(json.sub ?? '');
  } catch {
    return '';
  }
}

/** Tạo Redis client riêng cho coordinator (ioredis). */
export function createRedis(env: LoadTestEnv): Redis {
  return new Redis(env.redisUrl, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: true,
    // T-07 FIX-1: commandTimeout — Redis treo không thể stall /health (redisHealth ping) mãi mãi.
    commandTimeout: 2000,
  });
}

export { uuidV4 };
