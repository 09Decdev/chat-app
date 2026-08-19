/**
 * Smoke test — Chat features: Reply / @Mention / Bookmark / Read receipt
 * ----------------------------------------------------------------------
 * Chạy backend thật theo 2 bước, chạy 2 user vào cùng phòng rồi verify end-to-end
 * (socket → gateway → Kafka → content-service → Redis/Postgres → broadcast ngược).
 *
 * CÁCH CHẠY (từ chat-app/):
 *   npm run smoke:chat-features
 *
 * Nguồn account (ưu tiên từ trên xuống):
 *   1. SMOKE_EMAIL1 + SMOKE_EMAIL2 + SMOKE_PASSWORD  → login 2 tài khoản có sẵn
 *   2. LOADTEST_POOL_FILE=<pool.json>                → nạp pool đã có + login
 *   3. Mặc định: register 2 account mới (cần LOADTEST_OTP_SECRET + Redis dùng chung
 *      với gateway để seed OTP — khớp loadtest auth-factory)
 *
 * Env cần: LOADTEST_GATEWAY_URL (mặc định http://localhost:3000), và 1 trong các
 * nguồn account trên. Toàn bộ env khác đọc từ loadtest/.env (đã có sẵn).
 *
 * Exit code: 0 = PASS hết, 1 = có FAIL.
 */

import { io, type Socket } from 'socket.io-client';
import { getEnv } from './config';
import { createRedis, provisionAccounts, loginOneAccount, decodeSub } from './auth-factory';
import { requestJson } from './http';
import { normalizeUrl, ltLog, randomHex, uuidV4 } from './util';
import type { TestAccount } from './types';

// ─── Types ───────────────────────────────────────────────────────────────

interface SmokeUser {
  email: string;
  password?: string;
  userId: string;
  accessToken: string;
  displayName: string;
}

interface SmokeMessage {
  id: string;
  roomId: string;
  userId: string;
  content: string | null;
  displayName: string | null;
  createdAt: string;
  replyToId?: string | null;
  replyToContent?: string | null;
  replyToUserId?: string | null;
  replyToSenderName?: string | null;
  mentionedUserIds?: string[];
}

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const MATCH_WAIT_MS = 60_000;
const EVENT_WAIT_MS = 10_000;

function deviceInfo() {
  return {
    installationId: uuidV4(),
    deviceFingerprint: randomHex(16),
    platform: 'web' as const,
    deviceName: 'smoke-chat-features',
  };
}

function waitEvent<T = any>(
  socket: Socket,
  event: string,
  predicate: (data: T) => boolean,
  timeoutMs: number,
  eventName = event,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event);
      reject(new Error(`timeout chờ '${eventName}' sau ${timeoutMs}ms`));
    }, timeoutMs);
    socket.on(event, function handler(data: T) {
      try {
        if (predicate(data)) {
          clearTimeout(timer);
          socket.off(event, handler);
          resolve(data);
        }
      } catch (err) {
        clearTimeout(timer);
        socket.off(event, handler);
        reject(err);
      }
    });
  });
}

function connectSocket(wsUrl: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(wsUrl, {
      path: '/socket.io/',
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
      forceNew: true,
      timeout: 8_000,
    });
    const timer = setTimeout(() => {
      s.close();
      reject(new Error('connect timeout 10s'));
    }, 10_000);
    s.once('connect', () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.once('connect_error', (e) => {
      clearTimeout(timer);
      reject(new Error(`connect_error: ${e.message}`));
    });
  });
}

/** Enqueue + chờ matching:found + chat:join + chat:joined. Trả roomId. */
async function enterRoom(
  socket: Socket,
  gateway: string,
  user: SmokeUser,
  tag: string,
): Promise<string> {
  const res = await requestJson<{ queued?: boolean; position?: number }>(
    gateway,
    '/content-service/chat/match',
    { method: 'POST', token: user.accessToken, body: {} },
  );
  if (!res.ok || !res.data?.queued) {
    throw new Error(`[${tag}] enqueue match FAILED code=${res.code} message=${res.message} data=${JSON.stringify(res.data)}`);
  }
  ltLog.info(`[${tag}] đã enqueue (position=${res.data.position}) — chờ matching:found...`);

  const matched = await waitEvent<{ roomId?: string }>(
    socket,
    'matching:found',
    (d) => !!d?.roomId,
    MATCH_WAIT_MS,
  );
  const roomId = matched.roomId!;
  socket.emit('chat:join', { roomId });
  await waitEvent(socket, 'chat:joined', (d: any) => d?.roomId === roomId, EVENT_WAIT_MS);
  ltLog.info(`[${tag}] vào phòng ${roomId}`);
  return roomId;
}

function sendAndWaitEcho(
  socket: Socket,
  roomId: string,
  content: string,
  opts: { replyToId?: string; mentions?: string[] } = {},
): Promise<SmokeMessage> {
  const clientMsgId = uuidV4();
  const p = waitEvent<{ message?: SmokeMessage; clientMsgId?: string }>(
    socket,
    'chat:message',
    (d) => d?.message?.id !== undefined && d.clientMsgId === clientMsgId,
    EVENT_WAIT_MS,
  ).then((d) => d.message!);
  socket.emit('chat:send', { roomId, content, clientMsgId, ...opts });
  return p;
}

// ─── Auth ────────────────────────────────────────────────────────────────

async function resolveUsers(env: ReturnType<typeof getEnv>): Promise<SmokeUser[]> {
  const gateway = normalizeUrl(env.gatewayUrl);
  const di = deviceInfo();

  // 1) Login với tài khoản có sẵn (SMOKE_EMAIL1/2 + SMOKE_PASSWORD)
  const e1 = process.env.SMOKE_EMAIL1?.trim();
  if (e1) {
    const e2 = process.env.SMOKE_EMAIL2?.trim();
    const password = process.env.SMOKE_PASSWORD ?? '';
    if (!e2 || !password) {
      throw new Error('SMOKE_EMAIL1 đặt nhưng thiếu SMOKE_EMAIL2 hoặc SMOKE_PASSWORD');
    }
    const users: SmokeUser[] = [];
    for (const email of [e1, e2]) {
      const r = await loginOneAccount(gateway, email, password, di);
      if (!r.ok) {
        throw new Error(`login ${email} FAILED ${r.code ?? ''} ${r.require2fa ? '(cần 2FA)' : ''}`);
      }
      users.push({
        email,
        password,
        userId: decodeSub(r.accessToken),
        accessToken: r.accessToken,
        displayName: email.split('@')[0],
      });
      ltLog.info(`login OK: ${email} (userId=${users[users.length - 1].userId})`);
    }
    return users;
  }

  // 2) Pool file có sẵn
  if (env.poolFile) {
    const { loadPoolFile } = await import('./auth-factory');
    const poolRunId = 'smoke-' + uuidV4().slice(0, 8);
    const accounts = loadPoolFile(env.poolFile, poolRunId).slice(0, 2);
    if (accounts.length < 2) {
      throw new Error(`pool file "${env.poolFile}" có <2 account`);
    }
    return provisionAndLogin(gateway, accounts, di);
  }

  // 3) Mặc định: register 2 account mới (seed OTP vào Redis chung với gateway)
  if (!env.otpSecret) {
    throw new Error(
      'Không có nguồn account: đặt SMOKE_EMAIL1/2+PASSWORD (login) hoặc LOADTEST_OTP_SECRET (register mới). Xem đầu file.',
    );
  }
  const config = {
    runId: 'smoke-' + uuidV4().slice(0, 8),
    profile: { chat: 100, read: 0, comment: 0, like: 0, view: 0, post: 0 },
    durationMin: 1,
    rampRate: 1,
    rampMode: 'rate' as const,
    gatewayUrl: gateway,
    targetUsers: 2,
    freshAccounts: true,
    workerCount: 1,
    socketsPerWorker: 2,
    registerRamp: Math.min(env.registerRamp, env.maxRegisterRamp),
    useExistingAccounts: false,
    seed: Date.now() % 1_000_000,
    createdAt: Date.now(),
    durationSec: 60,
  };
  ltLog.info('Register 2 account mới qua OTP seed...');
  const redis = createRedis(env);
  try {
    const summary = await provisionAccounts(redis, config as any, env);
    if (summary.accounts.length < 2) {
      throw new Error(`register chỉ được ${summary.accounts.length} account — xem lỗi: ${JSON.stringify(Object.entries(summary.errors).slice(0, 3))}`);
    }
    return summary.accounts.slice(0, 2).map((a: TestAccount) => ({
      email: a.email,
      password: a.password,
      userId: a.userId,
      accessToken: a.accessToken,
      displayName: a.displayName,
    }));
  } finally {
    redis.disconnect();
  }
}

/** pool file: login lại các account trong file. */
async function provisionAndLogin(gateway: string, accounts: TestAccount[], di: ReturnType<typeof deviceInfo>): Promise<SmokeUser[]> {
  const users: SmokeUser[] = [];
  for (const a of accounts) {
    const r = await loginOneAccount(gateway, a.email, a.password, di);
    if (!r.ok) {
      throw new Error(`login pool account ${a.email} FAILED ${r.code ?? ''}`);
    }
    users.push({
      email: a.email,
      password: a.password,
      userId: decodeSub(r.accessToken),
      accessToken: r.accessToken,
      displayName: a.displayName,
    });
  }
  return users;
}

// ─── Main ────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const env = getEnv();
  const gateway = normalizeUrl(env.gatewayUrl);
  const wsUrl = gateway.replace(/^http/, 'ws');
  const checks: Check[] = [];
  const pass = (name: string, detail?: string) => checks.push({ name, pass: true, detail });
  const fail = (name: string, detail: string) => checks.push({ name, pass: false, detail });
  let sockets: Socket[] = [];

  ltLog.info(`===== SMOKE chat features → gateway=${gateway} ws=${wsUrl} =====`);

  try {
    // 0. Auth 2 users
    const users = await resolveUsers(env);
    const [userA, userB] = users;
    ltLog.info(`User A=${userA.userId} User B=${userB.userId}`);

    // 1. Connect sockets
    const sokA = await connectSocket(wsUrl, userA.accessToken);
    const sokB = await connectSocket(wsUrl, userB.accessToken);
    sockets = [sokA, sokB];
    // Lấy roomId trước để gắn filter (chat:joined sẽ emit tiếp)
    ltLog.info('Socket A + B connected');

    // 2. Cả 2 enqueue + vào phòng (matching ghép 2 user với nhau)
    const roomIdA = await enterRoom(sokA, gateway, userA, 'A');
    const roomIdB = await enterRoom(sokB, gateway, userB, 'B');
    if (roomIdA !== roomIdB) {
      fail('match cùng phòng', `A=${roomIdA} B=${roomIdB} — KHÁC phòng`);
      // vẫn tiếp tục 1 phòng để test reply/mention/read
    }
    const roomId = roomIdA;

    // 3. chat:joined phải có key readReceipts (initial state — có thể rỗng)
    //    (enterRoom đã đợi chat:joined; verify các field qua cheatsheet tầng trên.)
    //    → verify REST members có đủ user.
    const membersRes = await requestJson<Array<{ userId: string }>>(
      gateway,
      `/content-service/chat/rooms/${roomId}/members`,
      { token: userA.accessToken },
    );
    const memberIds = (membersRes.data ?? []).map((m) => m.userId);
    if (membersRes.ok && memberIds.includes(userA.userId) && memberIds.includes(userB.userId)) {
      pass('GET /rooms/:id/members trả đủ 2 member', `${memberIds.length} members`);
    } else {
      fail('GET /rooms/:id/members', `ok=${membersRes.ok} code=${membersRes.code} members=${JSON.stringify(membersRes.data ?? null)}`);
    }

    // 4. A gửi tin → B reply kèm @mention
    const msgA = await sendAndWaitEcho(sokA, roomId, 'Xin chào, đây là tin để reply', {});
    if (msgA?.id) pass('A gửi tin (echo clientMsgId)', `msgId=${msgA.id}`);
    else fail('A gửi tin (echo clientMsgId)', 'không nhận echo');

    const msgB = await sendAndWaitEcho(
      sokB,
      roomId,
      `Reply cho @${userA.displayName}`,
      { replyToId: msgA.id, mentions: [userA.userId] },
    );

    // 5. Verify reply + mention trên tin B
    const replyOk = msgB?.replyToId === msgA.id && msgB.replyToUserId === userA.userId;
    const mentionOk = Array.isArray(msgB?.mentionedUserIds) && msgB!.mentionedUserIds.includes(userA.userId);
    if (replyOk) pass('Reply: message.replyToId + replyToUserId khớp', `replyToContent="${msgB?.replyToContent}"`);
    else fail('Reply: message.replyToId + replyToUserId khớp', JSON.stringify({ replyToId: msgB?.replyToId, replyToUserId: msgB?.replyToUserId }));
    if (mentionOk) pass('@Mention: mentionedUserIds chứa userId A', JSON.stringify(msgB?.mentionedUserIds));
    else fail('@Mention: mentionedUserIds chứa userId A', JSON.stringify(msgB?.mentionedUserIds));

    // 6. Read receipt: B emit chat:read → A nhận chat:read:update chứa watermark của B
    const msgANew = await sendAndWaitEcho(sokA, roomId, 'Tin mới để B đọc', {});
    sokB.emit('chat:read', { roomId, lastReadAt: msgANew.createdAt });
    const upd = await waitEvent<{ readReceipts?: Record<string, string> }>(
      sokA,
      'chat:read:update',
      (d) => !!d?.readReceipts?.[userB.userId],
      EVENT_WAIT_MS,
    );
    if (upd.readReceipts?.[userB.userId] === msgANew.createdAt) {
      pass('Read receipt: chat:read:update chứa watermark của B', `${userB.userId} → ${upd.readReceipts[userB.userId]}`);
    } else {
      fail('Read receipt: chat:read:update chứa watermark của B', JSON.stringify(upd.readReceipts ?? null));
    }

    // 7. Bookmark: A tim tin B (POST/GET/DELETE)
    const bmRes = await requestJson<{ id?: string }>(gateway, '/content-service/chat/bookmarks', {
      method: 'POST',
      token: userA.accessToken,
      body: { roomId, messageId: msgB.id },
    });
    const bmId = bmRes.data?.id;
    const listRes = await requestJson<{ data?: Array<{ id?: string; messageId?: string }> }>(
      gateway,
      '/content-service/chat/bookmarks?limit=20',
      { token: userA.accessToken },
    );
    const inList = (listRes.data?.data ?? []).some((b) => b.messageId === msgB.id);
    const delRes = await requestJson<{ deleted?: boolean }>(
      gateway,
      `/content-service/chat/bookmarks/${bmId ?? ''}`,
      { method: 'DELETE', token: userA.accessToken },
    );
    if (bmId) pass('Bookmark POST → id', bmId);
    else fail('Bookmark POST → id', `ok=${bmRes.ok} code=${bmRes.code} data=${JSON.stringify(bmRes.data)}`);
    if (listRes.ok && inList) pass('Bookmark GET list chứa tin đã tim', 'true');
    else fail('Bookmark GET list chứa tin đã tim', `ok=${listRes.ok} code=${listRes.code} data=${JSON.stringify(listRes.data)}`);
    if (delRes.ok && delRes.data?.deleted) pass('Bookmark DELETE → deleted=true', '');
    else fail('Bookmark DELETE → deleted=true', `ok=${delRes.ok} code=${delRes.code} data=${JSON.stringify(delRes.data)}`);

    // 8. Dọn: leave phòng (best-effort)
    sokA.emit('chat:leave', { roomId });
    sokB.emit('chat:leave', { roomId });
  } catch (err) {
    fail('SMOKE chạy lỗi', (err as Error).message);
    ltLog.error(`SMOKE error: ${(err as Error).message}`);
  } finally {
    for (const s of sockets) {
      try {
        s.disconnect();
      } catch {
        /* noop */
      }
    }
  }

  // ─── Báo cáo ───────────────────────────────────────────────────────────
  console.log('\n===== KẾT QUẢ SMOKE: chat features =====');
  let okCount = 0;
  for (const c of checks) {
    console.log(`${c.pass ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    if (c.pass) okCount++;
  }
  console.log(`\nPASS ${okCount}/${checks.length} — ${okCount === checks.length ? '🎉 TẤT CẢ PASS' : 'CÓ FAIL'}`);
  return okCount === checks.length ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    ltLog.error(`SMOKE fatal: ${(err as Error).message}`);
    process.exit(1);
  });