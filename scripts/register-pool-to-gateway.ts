/**
 * MAYogu LoadTest Tool — register account pool (users_accounts.json) lên 1 gateway.
 *
 * CLI: npm run loadtest:register-pool -- --gateway <url> [--file <path>] [--limit <N>] [--ramp <n/s>]
 *   - Đọc file JSON array [{ email, password, ... }] (mặc định: LOADTEST_POOL_FILE trong .env).
 *   - Register từng account qua flow OTP-Seed 3 bước (verify-email → verify-sms-otp → complete)
 *     — giống AuthFactory, nhưng dùng EMAIL/PASSWORD CỤ THỂ từ file (không sinh mới).
 *   - Email đã tồn tại (EMAIL_EXISTS) → đếm skipped, KHÔNG phải fail (idempotent re-seed).
 *   - KHÔNG in password; rate limit theo --ramp (mặc định 100/s).
 *   - Chạy cho từng gateway: localhost + LAN trỏ cùng DB → chạy 1 lần là đủ (lần 2 toàn skipped).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Redis from 'ioredis';
import { getEnv } from '../loadtest/config';
import { seedOtp, seedSmsOtp } from '../loadtest/auth-factory';
import { requestJson } from '../loadtest/http';
import { genDateOfBirth, genDeviceInfo, genPhone, normalizeUrl, sleep } from '../loadtest/util';

interface PoolAccount {
  email: string;
  password: string;
  displayName?: string;
}

function parseArgs(argv: string[]): { gateway: string; file: string; limit: number; ramp: number; seed: number; concurrency: number; otpSecret: string; redisUrl: string } {
  const val = (name: string, def: string): string => {
    const i = argv.indexOf(name);
    return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : def;
  };
  const gateway = normalizeUrl(val('--gateway', 'http://localhost:3000'));
  const env = getEnv();
  const file = val('--file', env.poolFile || '');
  const limit = Number(val('--limit', '0')); // 0 = toàn bộ
  const ramp = Number(val('--ramp', '100'));
  const seed = Number(val('--seed', '1'));
  const concurrency = Number(val('--concurrency', '20'));
  // Override cho gateway ở máy khác (Redis/OTP_SECRET khác tool local — deployment env.properties).
  const otpSecret = val('--otp-secret', env.otpSecret || '');
  const redisUrl = val('--redis-url', env.redisUrl || '');
  if (!gateway) throw new Error('--gateway bắt buộc');
  if (!file) throw new Error('--file bắt buộc (hoặc set LOADTEST_POOL_FILE)');
  return { gateway, file, limit, ramp, seed, concurrency, otpSecret, redisUrl };
}

/** Register 1 account — trả về 'registered' | 'existed' | 'failed' + code. */
async function registerOne(
  redis: Redis,
  gateway: string,
  otpSecret: string,
  acc: PoolAccount,
  index: number,
  seed: number,
): Promise<{ status: 'registered' | 'existed' | 'failed'; code: string }> {
  const deviceInfo = genDeviceInfo(`seed${index}`, seed);
  const phone = genPhone(index, seed);
  const dob = genDateOfBirth();
  const fail = (code: string) => ({ status: 'failed' as const, code });

  // B1: verify email OTP -> registrationKey
  const otp = await seedOtp(redis, acc.email, otpSecret);
  const v1 = await requestJson<string>(gateway, '/auth/register/verify-email', {
    method: 'POST',
    body: { email: acc.email, otp },
    rawText: true,
  });
  const v1Body = parseRaw<{ registrationKey?: string }>(v1.data);
  if (!v1.ok || !v1Body?.registrationKey) {
    const code = v1.code || 'VERIFY_EMAIL_FAIL';
    if (/exists|EXISTS|used/i.test(code + ' ' + v1.message)) return { status: 'existed', code };
    return fail(code);
  }
  const registrationKey = v1Body.registrationKey;

  // B2: SMS OTP -> phoneKey
  const smsOtp = await seedSmsOtp(redis, acc.email, phone, otpSecret);
  const v2 = await requestJson<string>(gateway, '/auth/register/verify-sms-otp', {
    method: 'POST',
    body: { email: acc.email, phoneNumber: phone, otp: smsOtp, registrationKey },
    rawText: true,
  });
  const v2Body = parseRaw<{ phoneKey?: string }>(v2.data);
  if (!v2.ok || !v2Body?.phoneKey) return fail(v2.code || 'VERIFY_SMS_FAIL');
  const phoneKey = v2Body.phoneKey;

  // B3: complete — TẠO TÀI KHOẢN
  const res = await requestJson<unknown>(gateway, '/auth/register/complete', {
    method: 'POST',
    body: {
      email: acc.email,
      passwordHash: acc.password,
      phoneNumber: phone,
      phoneKey,
      registrationKey,
      dateOfBirth: dob,
      country: 'VN',
      deviceInfo,
      displayName: acc.displayName ?? acc.email.split('@')[0],
    },
  });
  if (res.ok) return { status: 'registered', code: '' };
  const code = res.code || `HTTP_${res.status}`;
  if (/exists|EXISTS|used/i.test(code + ' ' + res.message)) return { status: 'existed', code };
  return fail(code);
}

/** Parse raw JSON response (gateway trả { success, data } — requestJson rawText giữ nguyên). */
function parseRaw<T>(data: unknown): T | null {
  if (data === null || data === undefined) return null;
  if (typeof data === 'string') {
    try {
      const j = JSON.parse(data);
      return (j?.data ?? j) as T;
    } catch {
      return null;
    }
  }
  return (data as { data?: unknown } | null)?.data ? ((data as { data: unknown }).data as T) : (data as T);
}

async function main(): Promise<void> {
  const { gateway, file, limit, ramp, seed, concurrency, otpSecret, redisUrl } = parseArgs(process.argv.slice(2));
  if (!otpSecret) throw new Error('Thiếu OTP_SECRET (--otp-secret hoặc LOADTEST_OTP_SECRET) — không OTP-Seed được');
  if (!redisUrl) throw new Error('Thiếu REDIS_URL (--redis-url hoặc LOADTEST_REDIS_URL)');

  let accounts: PoolAccount[];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    let j = JSON.parse(raw);
    if (j.accounts) j = j.accounts;
    if (!Array.isArray(j)) throw new Error('JSON phải là mảng account');
    accounts = j.map((a: Record<string, unknown>, i: number) => {
      if (typeof a.email !== 'string' || a.email === '' || typeof a.password !== 'string' || a.password === '') {
        throw new Error(`Account #${i + 1}: email + password bắt buộc`);
      }
      return { email: a.email.trim(), password: a.password, displayName: typeof a.displayName === 'string' ? a.displayName : undefined };
    });
  } catch (err) {
    console.error(`[lt][register-pool] Đọc file fail: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const targets = limit > 0 ? accounts.slice(0, limit) : accounts;
  if (targets.length === 0) {
    console.error('[lt][register-pool] Không có account nào để register');
    process.exit(1);
  }

  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    lazyConnect: true, // await connect() tường minh — command trước connect sẽ throw rõ ràng
  });
  redis.on('error', (e) => console.error(`[lt][register-pool] Redis error: ${e.message}`));
  try {
    await redis.connect();
  } catch (err) {
    console.error(`[lt][register-pool] Redis connect fail: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const limiter = { next: 0, ramp: Math.max(1, ramp) };
  const acquire = async () => {
    const now = Date.now();
    const wait = Math.max(0, limiter.next - now);
    if (wait > 0) await sleep(wait);
    limiter.next = Math.max(now, limiter.next) + 1000 / limiter.ramp;
  };

  let registered = 0;
  let existed = 0;
  let failed = 0;
  const failCodes = new Map<string, number>();
  const started = Date.now();
  const CONCURRENCY = Math.max(1, Math.min(100, concurrency));

  let idx = 0;
  const worker = async () => {
    for (;;) {
      const i = idx++;
      if (i >= targets.length) return;
      await acquire();
      const acc = targets[i];
      try {
        const r = await registerOne(redis, gateway, otpSecret, acc, i, seed);
        if (r.status === 'registered') registered++;
        else if (r.status === 'existed') existed++;
        else {
          failed++;
          failCodes.set(r.code, (failCodes.get(r.code) ?? 0) + 1);
          if (failed <= 5) console.error(`[lt][register-pool] fail #${i} ${acc.email}: ${r.code}`);
        }
      } catch (err) {
        failed++;
        const code = err instanceof Error ? err.message.slice(0, 80) : String(err);
        failCodes.set(code, (failCodes.get(code) ?? 0) + 1);
      }
      const done = registered + existed + failed;
      if (done % 500 === 0) {
        const rate = Math.round((done / ((Date.now() - started) / 1000)) * 10) / 10;
        console.log(`[lt][register-pool] ${done}/${targets.length} (registered=${registered} existed=${existed} failed=${failed}) ${rate}/s`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await redis.quit().catch(() => {});

  console.log(`[lt][register-pool] done gateway=${gateway} total=${targets.length} registered=${registered} existed=${existed} failed=${failed} (${Math.round((Date.now() - started) / 1000)}s)`);
  if (failCodes.size > 0) {
    const top = [...failCodes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    console.log(`[lt][register-pool] fail breakdown: ${top.map(([c, n]) => `${c}:${n}`).join(' · ')}`);
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`[lt][register-pool] fail: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
