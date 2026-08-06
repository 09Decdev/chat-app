/**
 * MAYogu LoadTest Tool — Cleanup (SD-4, Màn 7): quét + xóa dữ liệu test 3 tầng.
 *
 * Tầng 1 — API nghiệp vụ: xóa post/comment test. MVP CHƯA có admin bulk-delete API
 * trong user-community-service (chỉ change-status) → step này đánh dấu `skipped`
 * kèm hướng dẫn DB script (author là user test). Delete user: không có API admin,
 * ghi rõ giới hạn.
 * Tầng 2 — Redis: xóa theo namespace/key đã biết chắc chắn từ source:
 *   - `otp:register:loadtest.*` (auth-otp.service.ts:81)
 *   - `chat:ratelimit:{userId}` (chat-message.service.ts:83)
 *   - `chat:topic:ratelimit:{userId}` (chat-message.service.ts:327)
 *   - `evt:chat:{userId}:*` dedupe (chat-message.service.ts:24)
 *   - `user:{userId}:viewed_posts` (CLAUDE.md — Redis view)
 *   - `enforcement:user:{userId}` (CLAUDE.md)
 *   Chỉ xóa key của user/run DO TOOL TẠO (không quét wildcard rộng).
 * Tầng 3 — kiểm tra baseline sau xóa.
 *
 * Mọi thao tác đều có dry-run (không xóa gì).
 */

import Redis from 'ioredis';
import { ltLog } from './util';

/** Chỉ cần userId — cho phép cleanup chạy với pool rút gọn. */
export interface CleanupAccount {
  userId: string;
}

export interface CleanupStep {
  name: string;
  status: 'ok' | 'skipped' | 'fail';
  detail: string;
  count: number;
}

export interface CleanupResult {
  runId: string;
  dryRun: boolean;
  steps: CleanupStep[];
  baseline: { otpKeys: number; userKeys: number };
  cleaned: boolean;
}

async function scanKeys(redis: Redis, pattern: string, batch = 1000): Promise<string[]> {
  const out: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', batch);
    cursor = next;
    out.push(...keys);
  } while (cursor !== '0');
  return out;
}

/** Tầng 2 — Redis: xóa key của run + user test (không xóa key user thật). */
export async function cleanupRedisKeys(
  redis: Redis,
  runId: string,
  accounts: CleanupAccount[],
  dryRun: boolean,
): Promise<CleanupStep> {
  const keysToDelete = new Set<string>();

  // namespace email loadtest.{runId}.*
  const otpKeys = await scanKeys(redis, `otp:register:loadtest.${runId}.*`);
  for (const k of otpKeys) keysToDelete.add(k);
  const cooldownKeys = await scanKeys(redis, `otp:register:cooldown:loadtest.${runId}.*`);
  for (const k of cooldownKeys) keysToDelete.add(k);
  const rateKeys = await scanKeys(redis, `otp:register:rate:loadtest.${runId}.*`);
  for (const k of rateKeys) keysToDelete.add(k);

  // key theo userId — chỉ user của run này
  for (const acc of accounts) {
    if (!acc.userId) continue;
    keysToDelete.add(`chat:ratelimit:${acc.userId}`);
    keysToDelete.add(`chat:topic:ratelimit:${acc.userId}`);
    keysToDelete.add(`user:${acc.userId}:viewed_posts`);
    keysToDelete.add(`enforcement:user:${acc.userId}`);
    const evtKeys = await scanKeys(redis, `evt:chat:${acc.userId}:*`);
    for (const k of evtKeys) keysToDelete.add(k);
  }

  if (dryRun) {
    return {
      name: 'Tầng 2 — Redis keys (dry-run: chỉ đếm)',
      status: 'ok',
      detail: `Sẽ xóa ${keysToDelete.size} keys (otp/cooldown/rate: ${otpKeys.length + cooldownKeys.length + rateKeys.length}, user keys: ${keysToDelete.size - otpKeys.length - cooldownKeys.length - rateKeys.length})`,
      count: keysToDelete.size,
    };
  }

  if (keysToDelete.size > 0) {
    const arr = [...keysToDelete];
    // xóa theo lô 1000 — tránh lệnh quá lớn
    for (let i = 0; i < arr.length; i += 1000) {
      await redis.del(...arr.slice(i, i + 1000));
    }
  }
  return {
    name: 'Tầng 2 — Redis keys',
    status: 'ok',
    detail: `Đã xóa ${keysToDelete.size} keys`,
    count: keysToDelete.size,
  };
}

/** Tầng 3 — baseline check sau xóa. */
export async function cleanupBaselineCheck(
  redis: Redis,
  runId: string,
  accounts: CleanupAccount[],
): Promise<CleanupStep & { otpKeys: number; userKeys: number }> {
  const otpKeys = await scanKeys(redis, `otp:register:loadtest.${runId}.*`);
  const userKeys: string[] = [];
  for (const acc of accounts) {
    if (!acc.userId) continue;
    const evt = await scanKeys(redis, `evt:chat:${acc.userId}:*`);
    userKeys.push(...evt);
    userKeys.push(`chat:ratelimit:${acc.userId}`, `chat:topic:ratelimit:${acc.userId}`, `user:${acc.userId}:viewed_posts`, `enforcement:user:${acc.userId}`);
  }
  const leftover = otpKeys.length + userKeys.filter((k) => k.startsWith('evt')).length;
  const ok = otpKeys.length === 0 && leftover === 0;
  return {
    name: 'Tầng 3 — Kiểm tra baseline',
    status: ok ? 'ok' : 'fail',
    detail: ok
      ? 'Sạch: không còn otp:register:loadtest.* và key user test.'
      : `Còn sót: otp keys=${otpKeys.length}, user keys=${leftover}. Xóa tay hoặc chạy lại (idempotent).`,
    count: leftover,
    otpKeys: otpKeys.length,
    userKeys: leftover,
  };
}

/** Chạy cleanup 3 tầng cho 1 runId (accounts từ pool file nếu có). */
export async function runCleanup(
  redis: Redis,
  runId: string,
  accounts: CleanupAccount[],
  dryRun: boolean,
): Promise<CleanupResult> {
  const steps: CleanupStep[] = [];

  // Tầng 1 — API nghiệp vụ (giới hạn MVP — không có admin bulk-delete)
  steps.push({
    name: 'Tầng 1 — API nghiệp vụ: delete user/post/comment test',
    status: 'skipped',
    detail:
      'Không có admin bulk-delete trong user-community-service (chỉ PATCH change-status) và content-service. ' +
      'MVP: chạy DB script theo hướng dẫn (DELETE WHERE author email LIKE \'loadtest.{runId}.%@mayogu.test\' — chạy trong môi trường TEST, có backup).',
    count: 0,
  });

  // Tầng 2 — Redis
  const tier2 = await cleanupRedisKeys(redis, runId, accounts, dryRun);
  steps.push(tier2);

  // Tầng 3 — baseline
  const tier3 = await cleanupBaselineCheck(redis, runId, accounts);
  steps.push(tier3);

  const failed = steps.some((s) => s.status === 'fail');
  return {
    runId,
    dryRun,
    steps,
    baseline: { otpKeys: tier3.otpKeys, userKeys: tier3.userKeys },
    cleaned: !failed && !dryRun,
  };
}

export { ltLog };
