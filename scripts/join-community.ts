#!/usr/bin/env node
/**
 * Tool: cho tất cả virtual user trong 1 pool (run) GỬI join-request vào community.
 * (Việc accept thì bạn tự làm — script chỉ tạo request, không cần owner creds.)
 *
 *   npx tsx scripts/join-community.ts --run-id lt-xxx \
 *     [--community-id <id>] [--gateway <url>] [--limit 100] [--concurrency 10]
 *
 * Mỗi user: login gateway → thử POST /join-request/community-public (public auto-join)
 *           → 4xx (private/paid) → POST /join-request {communityId} (pending, chờ owner accept).
 * Env (mặc định): LOADTEST_DATA_DIR, LOADTEST_COMMUNITY_ID, LOADTEST_GATEWAY_URL (production).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getEnv } from '../loadtest/config';
import { loginOneAccount } from '../loadtest/auth-factory';
import { normalizeUrl } from '../loadtest/util';
import type { TestAccount } from '../loadtest/types';

function parseArgs(argv: string[]) {
  const a = argv.slice(2);
  const get = (k: string): string | undefined => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    runId: get('run-id'),
    poolFile: get('pool-file'),
    communityId: get('community-id'),
    gateway: get('gateway'),
    limit: get('limit') ? Number(get('limit')) : undefined,
    concurrency: get('concurrency') ? Number(get('concurrency')) : 10,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 1 user: login → join (public auto-join, hoặc private pending — chờ owner accept). */
async function joinOne(gateway: string, account: TestAccount, communityId: string): Promise<'joined' | 'pending' | 'skip' | 'fail'> {
  const login = await loginOneAccount(gateway, account.email, account.password, account.deviceInfo);
  if (!login.ok) return 'fail';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${login.accessToken}`,
  };
  // Thử public auto-join trước (community public → member ngay, không cần accept).
  let res = await fetch(`${gateway}/user-community/join-request/community-public`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ communityId }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.ok) return 'joined';
  // 4xx → private/paid → tạo pending request (owner accept sau).
  res = await fetch(`${gateway}/user-community/join-request`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ communityId }),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.ok) return 'pending';
  // 409/400 "already exists" / "already member" → skip (đã gửi request / đã member — không phải fail).
  const body = await res.json().catch(() => null);
  const msg = String(body?.message ?? '').toLowerCase();
  if (res.status === 409 || res.status === 400 || msg.includes('already') || msg.includes('member') || msg.includes('exist')) return 'skip';
  return 'fail';
}

async function main() {
  const args = parseArgs(process.argv);
  const env = getEnv();
  const communityId = args.communityId ?? env.communityId;
  const gateway = normalizeUrl(args.gateway ?? env.gatewayUrl);
  if (!communityId) {
    console.error('Thiếu --community-id (hoặc env LOADTEST_COMMUNITY_ID)');
    process.exit(2);
  }
  if (!gateway) {
    console.error('Thiếu --gateway (hoặc env LOADTEST_GATEWAY_URL)');
    process.exit(2);
  }

  // Load pool accounts (disk file accounts-{runId}.json).
  const poolPath = args.poolFile
    ? args.poolFile
    : args.runId
      ? path.join(env.dataDir, `accounts-${args.runId}.json`)
      : null;
  if (!poolPath) {
    console.error('Thiếu --run-id <runId> (hoặc --pool-file <path>) — pool nào cần join?');
    console.error('List pool: ls $LOADTEST_DATA_DIR/accounts-*.json');
    process.exit(2);
  }
  let accounts: TestAccount[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(poolPath, 'utf8')) as unknown;
    // Pool có thể là ARRAY [{email,password}] hoặc {accounts:[...]} hoặc {users:[...]}.
    const pool = Array.isArray(raw)
      ? raw
      : ((raw as { accounts?: unknown[] })?.accounts ?? (raw as { users?: unknown[] })?.users ?? []);
    // Normalize: đảm bảo mỗi account có deviceInfo (file có thể chỉ có email/password).
    accounts = (pool as Array<{ email: string; password: string; deviceInfo?: TestAccount['deviceInfo'] }>).map((a) => ({
      email: a.email,
      password: a.password,
      deviceInfo: a.deviceInfo ?? {
        installationId: crypto.randomUUID(),
        deviceFingerprint: crypto.createHash('sha256').update(a.email).digest('hex'),
        platform: 'web',
        deviceName: 'join-community-script',
      },
    }));
  } catch (e) {
    console.error(`Không đọc được pool ${poolPath}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  if (args.limit && args.limit > 0) accounts = accounts.slice(0, args.limit);
  if (accounts.length === 0) {
    console.error('Pool rỗng.');
    process.exit(2);
  }

  console.log(`[join] gateway=${gateway}`);
  console.log(`[join] community=${communityId}`);
  console.log(`[join] accounts=${accounts.length} concurrency=${args.concurrency}`);

  let joined = 0, pending = 0, skip = 0, fail = 0, done = 0;
  await mapLimit(accounts, args.concurrency, async (acc) => {
    const r = await joinOne(gateway, acc, communityId);
    if (r === 'joined') joined++;
    else if (r === 'pending') pending++;
    else if (r === 'skip') skip++;
    else fail++;
    done++;
    if (done % 50 === 0 || done === accounts.length) {
      console.log(`[join] ${done}/${accounts.length}: joined=${joined} pending=${pending} skip=${skip} fail=${fail}`);
    }
    if (args.concurrency >= 50) await sleep(50); // nhẹ rate-limit
  });

  console.log('────────────────────────');
  console.log(`[join] XONG: joined=${joined} (public auto) | pending=${pending} (chờ owner accept) | skip=${skip} (đã là member/đã gửi) | fail=${fail}`);
  if (pending > 0) {
    console.log(`[join] → Bạn (owner) accept: PUT ${gateway}/user-community/join-request/${communityId}/accept-all`);
    console.log('        (hoặc Accept All trong app community owner).');
  }
}

main().catch((e) => {
  console.error(`[join] fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
