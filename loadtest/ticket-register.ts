#!/usr/bin/env node
/**
 * MAYogu LoadTest Tool — Ticket Registration (tấn công đăng ký/mua vé).
 * ----------------------------------------------------------------------
 * Flow: lấy toàn bộ account trong pool (người dùng của community) →
 *       tìm event đang mở đăng ký + ticket type trong thời gian bán →
 *       bắn đồng loạt POST /content-service/tickets/register cho mọi account.
 *
 *   npx tsx loadtest/ticket-register.ts \
 *     [--pool-file <path>] [--gateway <url>] [--community-id <id>] \
 *     [--event-id <id>] [--ticket-type-id <id>] [--quantity 1] \
 *     [--concurrency 20] [--limit <n>] [--min-success-rate 90] \
 *     [--verify-members] [--all-events] [--auto-join] [--checkin] \
 *     [--checkin-concurrency <n>] [--report <path>]
 *
 * Phase 0 (--auto-join): pool account tự JOIN community (public auto-join) trước
 * khi register — không cần owner accept (community public). Idempotent (skip nếu đã member).
 *
 * Phase 2 (--checkin): sau khi register, bắn đồng loạt POST
 * /content-service/internal/distribution/check-in (path INTERNAL x-service-token)
 * theo ticketCode rút từ response 201. KHÔNG cần phân quyền per-user — ServiceTokenGuard
 * chỉ so x-service-token === INTERNAL_SERVICE_TOKEN. Cấp qua env LOADTEST_CONTENT_SERVICE_URL
 * (mặc định = gateway host + :3004) + LOADTEST_INTERNAL_SERVICE_TOKEN (phải khớp
 * INTERNAL_SERVICE_TOKEN của content-service — giống ticket-mayo).
 *
 * Không truyền event/ticket cụ thể → tool tự tìm:
 *   1. GET /content-service/event/open-registration/{communityId}
 *      → chỉ trả event PUBLISHED đang trong cửa sổ đăng ký (đòi user là member).
 *   2. GET /content-service/ticket-type/eventId/{eventId}
 *      → lọc ticket type có saleStartsAt ≤ now ≤ saleEndsAt và còn vé.
 * Cắm --event-id (và/hoặc --ticket-type-id) để bỏ qua bước tự tìm.
 *
 * --all-events (mặc định tắt): QUÉT MỌI event mở đăng ký — mỗi event lấy 1
 * ticket type đang bán, chia đều pool account cho từng event rồi bắn đồng loạt.
 * Summary trả thêm `events[]` (phân tích theo từng event) bên cạnh tổng hợp.
 *
 * Account nguồn (pool) phải là member của community — hoặc bật --auto-join để
 * tool tự join (public auto-join, không cần owner accept) trước khi register.
 *
 * Exit code: 0 = đạt min-success-rate (mặc định 90%) · 1 = không đạt · 2 = lỗi config/discovery.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { getEnv } from './config';
import { loadPoolFile, loginOneAccount, decodeSub } from './auth-factory';
import { requestJson, type HttpResult } from './http';
import { normalizeUrl, ltLog } from './util';
import type { TestAccount } from './types';

// ─── CLI args ──────────────────────────────────────────────────────────

interface Args {
  poolFile?: string;
  gateway?: string;
  communityId?: string;
  eventId?: string;
  ticketTypeId?: string;
  quantity: number;
  concurrency: number;
  limit?: number;
  verifyMembers: boolean;
  /** Quét mọi event mở đăng ký, mỗi event 1 ticket type (+ chia đều pool). */
  allEvents: boolean;
  report?: string;
  minSuccessRate: number;
  /** Phase 0: pool tự join community (public auto-join) trước khi register. */
  autoJoin: boolean;
  /** Phase 2: tự check-in vé sau khi register (path internal x-service-token, không cần per-user quyền). */
  checkin: boolean;
  checkinConcurrency?: number;
}

function parseArgs(argv: string[]): Args {
  const a = argv.slice(2);
  const get = (k: string): string | undefined => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    poolFile: get('pool-file'),
    gateway: get('gateway'),
    communityId: get('community-id'),
    eventId: get('event-id'),
    ticketTypeId: get('ticket-type-id'),
    quantity: get('quantity') ? Number(get('quantity')) : 1,
    concurrency: get('concurrency') ? Number(get('concurrency')) : 20,
    limit: get('limit') ? Number(get('limit')) : undefined,
    verifyMembers: a.includes('--verify-members'),
    allEvents: a.includes('--all-events'),
    report: get('report'),
    minSuccessRate: get('min-success-rate') ? Number(get('min-success-rate')) : 90,
    autoJoin: a.includes('--auto-join'),
    checkin: a.includes('--checkin'),
    checkinConcurrency: get('checkin-concurrency') ? Number(get('checkin-concurrency')) : undefined,
  };
}

/**
 * Options chạy ticket-register — cùng nguồn: CLI args (ticket-register.ts)
 * hoặc HTTP API (loadtest/routes/tickets.ts). Trường thiếu → dùng env
 * (LOADTEST_GATEWAY_URL / LOADTEST_COMMUNITY_ID / LOADTEST_POOL_FILE).
 */
export interface TicketRegistrationOptions {
  poolFile?: string;
  gateway?: string;
  communityId?: string;
  eventId?: string;
  ticketTypeId?: string;
  quantity: number;
  concurrency: number;
  limit?: number;
  verifyMembers: boolean;
  minSuccessRate: number;
  /** Quét mọi event mở đăng ký (mỗi event 1 ticket type) thay vì chỉ 1 event đầu. */
  allEvents?: boolean;
  /** Ghi report JSON ra file (CLI --report; API ghi vào reportsDir). */
  reportPath?: string;
  /** Phase 0: pool tự join community (public auto-join) trước khi register. */
  autoJoin?: boolean;
  /** Phase 2: sau khi register, bắn /internal/distribution/check-in (x-service-token) cho mọi vé 201. */
  checkin?: boolean;
  /** Concurrency riêng cho phase check-in (mặc định = concurrency register). */
  checkinConcurrency?: number;
}

/** Kết quả run — exitCode 0=đạt min-success-rate · 1=không đạt · 2=config/discovery lỗi. */
export interface TicketRunResult {
  exitCode: 0 | 1 | 2;
  summary?: RunSummary;
  /** Lỗi khi exitCode === 2 (config/discovery) — in cho CLI, trả JSON cho API. */
  error?: string;
}

/** Concurrency limiter — mapLimit (cùng pattern scripts/join-community.ts). */
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

// ─── Discover: event + ticket type ─────────────────────────────────────

export interface DiscoveredEvent {
  id: string;
  title: string;
  status: string;
  registrationStartTime: string | null;
  registrationEndTime: string | null;
  communityId: string;
  /** 'scheduled' | 'open' | 'closed' — EventResponseDto (event.respon.dto.ts). */
  registrationState?: string;
}

export interface DiscoveredTicketType {
  id: string;
  eventId: string;
  name: string;
  price: number;
  soldOut: boolean;
  remainingStock: number;
  saleStartsAt?: string | null;
  saleEndsAt?: string | null;
}

/** 1 "target" = (event, ticket type) — mỗi target nhận 1 phần pool account. */
interface DiscoverTarget {
  event: DiscoveredEvent;
  ticketType: DiscoveredTicketType;
}

/** Lấy DANH SÁCH event đang mở đăng ký trong community + lọc local (khớp validateTicketRegistration). */
async function fetchOpenEvents(gateway: string, communityId: string, token: string): Promise<{ events: DiscoveredEvent[]; ok: boolean; failMsg?: string }> {
  const res = await requestJson<{ data?: DiscoveredEvent[] }>(
    gateway,
    `/content-service/event/open-registration/${encodeURIComponent(communityId)}?page=1&limit=50`,
    { token, timeoutMs: 15_000 },
  );
  if (!res.ok) {
    return { events: [], ok: false, failMsg: `open-registration HTTP ${res.status} ${res.code} ${res.message}` };
  }
  const now = Date.now();
  const events = (res.data?.data ?? []).filter((e): e is DiscoveredEvent => {
    if (!e || !e.id) return false;
    if (e.status !== 'PUBLISHED' && e.status !== 'ONGOING') return false;
    const rs = e.registrationStartTime ? new Date(e.registrationStartTime).getTime() : 0;
    const re = e.registrationEndTime ? new Date(e.registrationEndTime).getTime() : Infinity;
    return now >= rs && now <= re;
  });
  return { events, ok: true };
}

/** Chọn 1 event (ưu tiên registrationState='open', không thì event đầu) — dùng cho chế độ đơn. */
async function discoverEvent(gateway: string, communityId: string, token: string): Promise<{ event: DiscoveredEvent | null; ok: boolean; failMsg?: string }> {
  const found = await fetchOpenEvents(gateway, communityId, token);
  if (!found.ok) return { event: null, ok: false, failMsg: found.failMsg };
  if (found.events.length === 0) {
    return { event: null, ok: false, failMsg: `không có event nào mở đăng ký trong community ${communityId}` };
  }
  // Ưu tiên event có registrationState='open' trước, rồi lấy event đầu (startTime asc theo server).
  const open = found.events.find((e) => e.registrationState === 'open');
  return { event: open ?? found.events[0], ok: true };
}

/** Lấy ticket type của event + lọc đang mở bán (sale window + còn vé). */
async function discoverTicketType(
  gateway: string,
  event: DiscoveredEvent,
  token: string,
): Promise<{ types: DiscoveredTicketType[]; failMsg?: string }> {
  const res = await requestJson<{ ticketTypes?: DiscoveredTicketType[] }>(
    gateway,
    `/content-service/ticket-type/eventId/${encodeURIComponent(event.id)}`,
    { token, timeoutMs: 15_000 },
  );
  if (!res.ok) {
    return { types: [], failMsg: `ticket-type/eventId HTTP ${res.status} ${res.code} ${res.message}` };
  }
  const now = Date.now();
  const types = (res.data?.ticketTypes ?? []).filter((t): t is DiscoveredTicketType => {
    if (!t || !t.id) return false;
    if (t.soldOut || t.remainingStock <= 0) return false;
    const ss = t.saleStartsAt ? new Date(t.saleStartsAt).getTime() : 0;
    const se = t.saleEndsAt ? new Date(t.saleEndsAt).getTime() : Infinity;
    return now >= ss && now <= se;
  });
  return { types };
}

// ─── Verify members (bước "lấy toàn bộ user trong community") ───────────

async function listCommunityMemberIds(gateway: string, communityId: string, token: string): Promise<{ userIds: Set<string>; total: number; ok: boolean; failMsg?: string }> {
  const userIds = new Set<string>();
  let page = 1;
  let total = 0;
  for (; ; page++) {
    const res = await requestJson<{ data?: Array<{ userId?: string }>; pagination?: { total?: number } }>(
      gateway,
      `/user-community/community-member?communityId=${encodeURIComponent(communityId)}&page=${page}&pageSize=30`,
      { token, timeoutMs: 15_000 },
    );
    if (!res.ok) {
      return { userIds, total, ok: false, failMsg: `community-member HTTP ${res.status} ${res.code} ${res.message}` };
    }
    const items = res.data?.data ?? [];
    for (const m of items) {
      if (typeof m?.userId === 'string' && m.userId) userIds.add(m.userId);
    }
    total = res.data?.pagination?.total ?? 0;
    if (items.length === 0 || userIds.size >= total) break;
  }
  return { userIds, total, ok: true };
}

// ─── Attack: 1 account → POST /tickets/register ───────────────────────

export type AttackOutcome =
  | 'REGISTERED' // 201 — vé đã tạo
  | 'QUEUED' // 202 — vào hàng đợi (hết vé trực tiếp → chờ queue)
  | 'RATE_LIMITED' // 429
  | 'CONFLICT' // 409 — queue đầy / hết vé / pending trùng
  | 'FORBIDDEN' // 403 — vượt quota / đã đăng ký free type
  | 'BAD_REQUEST' // 400 — ngoài cửa sổ / event chưa mở
  | 'NOT_FOUND' // 404 — event/ticket type không tồn tại
  | 'SERVER' // 5xx
  | 'LOGIN_FAIL' // login thất bại
  | 'NETWORK' // timeout/network
  | 'OTHER';

export interface AttackResult {
  account: string;
  userId: string;
  outcome: AttackOutcome;
  status: number;
  code: string;
  latencyMs: number;
  /** ticketCode rút từ response 201 REGISTERED — feeding phase check-in (internal path theo ticketCode). Rỗng khi không phải REGISTERED. */
  ticketCodes?: string[];
}

// ─── Auto check-in (phase 2: checker login → POST /tickets/check-in theo ticketId) ──

export type CheckinOutcome =
  | 'CHECKED_IN' // 200 — vé đã check-in (hoặc alreadyCheckedIn — idempotent)
  | 'CONFLICT' // 409 — vé không ở trạng thái VALID (đã hủy)
  | 'FORBIDDEN' // 403/401 — x-service-token sai/thiếu
  | 'BAD_REQUEST' // 400 — ticketCode rỗng / DTO sai
  | 'NOT_FOUND' // 404 — ticketCode không tồn tại
  | 'RATE_LIMITED' // 429
  | 'SERVER' // 5xx
  | 'NETWORK' // timeout/network
  | 'OTHER';

export interface CheckinResult {
  ticketCode: string;
  outcome: CheckinOutcome;
  status: number;
  code: string;
  latencyMs: number;
}

export interface CheckinRunSummary {
  checker: string;
  participants: number;
  durationMs: number;
  results: Record<CheckinOutcome, number>;
  byStatus: Record<string, number>;
  errors: Record<string, number>;
  actionOk: number; // CHECKED_IN
  actionFail: number;
  successRate: number; // CHECKED_IN / participants
  latencyMs: { avg: number; p50: number; p95: number; p99: number; max: number };
}

/** Summary phase 0 auto-join — chỉ có khi --auto-join chạy. */
export interface JoinRunSummary {
  communityId: string;
  participants: number;
  durationMs: number;
  joined: number; // public auto-join OK (member ngay)
  pending: number; // private/paid → chờ owner accept
  skip: number; // đã là member / đã gửi request
  fail: number; // login fail / network
  successRate: number; // (joined + skip) / participants
}

const TICKET_PATH = '/content-service/tickets/register';

async function attackOne(
  gateway: string,
  account: TestAccount,
  ticketTypeId: string,
  quantity: number,
): Promise<AttackResult> {
  const login = await loginOneAccount(gateway, account.email, account.password, account.deviceInfo);
  if (!login.ok) {
    return { account: account.email, userId: '', outcome: 'LOGIN_FAIL', status: 0, code: login.code ?? 'LOGIN_FAIL', latencyMs: 0 };
  }
  const r: HttpResult<unknown> = await requestJson(gateway, TICKET_PATH, {
    method: 'POST',
    token: login.accessToken,
    body: { ticketTypeId, quantity },
    timeoutMs: 30_000,
  });
  const outcome: AttackOutcome = classify(r);
  // Phase 2 feeding: rút ticketCode từ response 201 (đăng ký thành công ngay).
  const ticketCodes = outcome === 'REGISTERED' ? extractTicketCodes(r.data) : [];
  return { account: account.email, userId: decodeSub(login.accessToken), outcome, status: r.status, code: r.code, latencyMs: r.latencyMs, ticketCodes };
}

/** Rút ticketCode từ body POST /tickets/register (201). Body là mảng Ticket entity
 *  Prisma (registerAndFinalize trả thẳng) — có thể wrap { statusCode, data: [] } của
 *  controller (requestJson KHÔNG unwrap vì thiếu key `success`). */
function extractTicketCodes(body: unknown): string[] {
  const findArray = (v: unknown): unknown[] | null => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (Array.isArray(o.data)) return o.data;
      if (o.data && typeof o.data === 'object' && Array.isArray((o.data as Record<string, unknown>).tickets))
        return (o.data as Record<string, unknown>).tickets as unknown[];
      if (Array.isArray(o.tickets)) return o.tickets;
    }
    return null;
  };
  const arr = findArray(body);
  if (!arr) return [];
  const codes: string[] = [];
  for (const t of arr) {
    if (t && typeof t === 'object') {
      const o = t as Record<string, unknown>;
      const code = typeof o.ticketCode === 'string' ? o.ticketCode : '';
      if (code) codes.push(code);
    }
  }
  return codes;
}

function classify(r: HttpResult<unknown>): AttackOutcome {
  if (r.failClass === 'NETWORK') return 'NETWORK';
  switch (r.status) {
    case 201: return 'REGISTERED';
    case 202: return 'QUEUED';
    case 429: return 'RATE_LIMITED';
    case 409: return 'CONFLICT';
    case 403: return 'FORBIDDEN';
    case 400: return 'BAD_REQUEST';
    case 404: return 'NOT_FOUND';
    default:
      if (r.failClass === 'SERVER') return 'SERVER';
      if (r.failClass === 'OK') return 'OTHER';
      return 'OTHER';
  }
}

// ─── Check-in attack (INTERNAL path — x-service-token, không cần per-user quyền) ──
// Path /content-service/internal/distribution/check-in của content-service (ServiceTokenGuard).
// Body { ticketCode, checkerId, gateId? }. Response idempotent: 200 + alreadyCheckedIn nếu đã quét.

const CHECKIN_INTERNAL_PATH = '/content-service/internal/distribution/check-in';

function classifyCheckin(r: HttpResult<unknown>): CheckinOutcome {
  if (r.failClass === 'NETWORK') return 'NETWORK';
  switch (r.status) {
    case 200: return 'CHECKED_IN';
    case 429: return 'RATE_LIMITED';
    case 409: return 'CONFLICT';
    case 403: return 'FORBIDDEN';
    case 401: return 'FORBIDDEN';
    case 400: return 'BAD_REQUEST';
    case 404: return 'NOT_FOUND';
    default:
      if (r.failClass === 'SERVER') return 'SERVER';
      return 'OTHER';
  }
}

async function checkinOne(contentServiceUrl: string, serviceToken: string, ticketCode: string): Promise<CheckinResult> {
  const r: HttpResult<unknown> = await requestJson(contentServiceUrl, CHECKIN_INTERNAL_PATH, {
    method: 'POST',
    headers: { 'x-service-token': serviceToken },
    // Internal path: không có Bearer, không cần quyền CHECK_IN — chỉ ServiceTokenGuard.
    body: { ticketCode, checkerId: 'loadtest' },
    timeoutMs: 30_000,
  });
  return { ticketCode, outcome: classifyCheckin(r), status: r.status, code: r.code, latencyMs: r.latencyMs };
}

/** Bắn check-in đồng loạt cho N ticketCode qua internal path (1 x-service-token). */
async function attackCheckin(
  contentServiceUrl: string,
  serviceToken: string,
  ticketCodes: string[],
  concurrency: number,
): Promise<CheckinResult[]> {
  return mapLimit(ticketCodes, concurrency, (code) => checkinOne(contentServiceUrl, serviceToken, code));
}

// ─── Auto-join (Phase 0): pool tự vào community trước khi register ─────────
// Mirror scripts/join-community.ts: thử public auto-join trước, 4xx → private pending.

type JoinOutcome = 'JOINED' | 'PENDING' | 'SKIP' | 'FAIL';

async function joinOne(gateway: string, account: TestAccount, communityId: string): Promise<JoinOutcome> {
  const login = await loginOneAccount(gateway, account.email, account.password, account.deviceInfo);
  if (!login.ok) return 'FAIL';
  // 1. Public auto-join (community public → member ngay, không cần owner accept).
  const pubR: HttpResult<unknown> = await requestJson(gateway, '/user-community/join-request/community-public', {
    method: 'POST',
    token: login.accessToken,
    body: { communityId },
    timeoutMs: 15_000,
  });
  if (pubR.ok) return 'JOINED';
  // 2. 4xx → private/paid → tạo pending request (owner accept sau).
  const privR: HttpResult<unknown> = await requestJson(gateway, '/user-community/join-request', {
    method: 'POST',
    token: login.accessToken,
    body: { communityId },
    timeoutMs: 15_000,
  });
  if (privR.ok) return 'PENDING';
  // 3. 409/400 "already exists" / "already member" → đã trong group / đã gửi request → skip.
  const msg = (privR.message || '').toLowerCase();
  if (privR.status === 409 || privR.status === 400 || msg.includes('already') || msg.includes('member') || msg.includes('exist')) return 'SKIP';
  return 'FAIL';
}

async function attackJoin(gateway: string, accounts: TestAccount[], communityId: string, concurrency: number): Promise<JoinOutcome[]> {
  return mapLimit(accounts, concurrency, (acc) => joinOne(gateway, acc, communityId));
}

function summarizeCheckin(results: CheckinResult[], durationMs: number, checker: string): CheckinRunSummary {
  const res: Record<CheckinOutcome, number> = {
    CHECKED_IN: 0, CONFLICT: 0, FORBIDDEN: 0, BAD_REQUEST: 0, NOT_FOUND: 0,
    RATE_LIMITED: 0, SERVER: 0, NETWORK: 0, OTHER: 0,
  };
  const byStatus: Record<string, number> = {};
  const errors: Record<string, number> = {};
  const latencies: number[] = [];
  let actionOk = 0;
  let actionFail = 0;
  for (const r of results) {
    res[r.outcome]++;
    const st = String(r.status);
    byStatus[st] = (byStatus[st] ?? 0) + 1;
    if (r.outcome === 'CHECKED_IN') actionOk++;
    else actionFail++;
    if (r.code) errors[r.code] = (errors[r.code] ?? 0) + 1;
    if (r.latencyMs > 0) latencies.push(r.latencyMs);
  }
  latencies.sort((a, b) => a - b);
  const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  return {
    checker,
    participants: results.length,
    durationMs,
    results: res,
    byStatus,
    errors,
    actionOk,
    actionFail,
    successRate: (actionOk / Math.max(1, results.length)) * 100,
    latencyMs: {
      avg: Math.round(avg),
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies.length ? latencies[latencies.length - 1] : 0,
    },
  };
}

function printCheckinSummary(c: CheckinRunSummary): void {
  const pct = (n: number) => `${((n / Math.max(1, c.participants)) * 100).toFixed(1)}%`;
  const order: CheckinOutcome[] = ['CHECKED_IN', 'CONFLICT', 'FORBIDDEN', 'BAD_REQUEST', 'NOT_FOUND', 'RATE_LIMITED', 'SERVER', 'NETWORK', 'OTHER'];
  console.log('──────────────────────────────────────');
  console.log('[checkin] KẾT QUẢ: POST /content-service/internal/distribution/check-in (x-service-token)');
  console.log(`[checkin] checker     : ${c.checker}`);
  console.log(`[checkin] participants: ${c.participants}`);
  console.log(`[checkin] duration    : ${(c.durationMs / 1000).toFixed(1)}s (${(c.participants / Math.max(1, c.durationMs / 1000)).toFixed(0)} req/s)`);
  for (const o of order) {
    if (c.results[o] > 0) console.log(`  ${o.padEnd(13)} ${c.results[o]}  (${pct(c.results[o])})`);
  }
  console.log(`  SUCCESS(200): ${c.actionOk} (${pct(c.actionOk)}) | FAIL: ${c.actionFail} (${pct(c.actionFail)})`);
  console.log(`  success rate: ${c.successRate.toFixed(1)}%`);
  console.log(`  latency ms   : avg ${c.latencyMs.avg} | p50 ${c.latencyMs.p50} | p95 ${c.latencyMs.p95} | p99 ${c.latencyMs.p99} | max ${c.latencyMs.max}`);
  const topErr = Object.entries(c.errors).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (topErr.length > 0) {
    console.log('  top errors  :');
    for (const [code, count] of topErr) console.log(`    ${code}: ${count}`);
  }
}

// ─── Report ────────────────────────────────────────────────────────────

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((q / 100) * sorted.length) - 1));
  return sorted[idx];
}

export interface RunSummary {
  gateway: string;
  communityId: string | null;
  eventId: string | null;
  eventTitle: string | null;
  ticketTypeId: string | null;
  ticketTypeName: string | null;
  quantity: number;
  participants: number;
  startedAt: number;
  durationMs: number;
  results: Record<AttackOutcome, number>;
  byStatus: Record<string, number>;
  errors: Record<string, number>;
  actionOk: number;
  actionFail: number;
  successRate: number; // (REGISTERED + QUEUED) / participants
  latencyMs: { avg: number; p50: number; p95: number; p99: number; max: number };
  /** Chỉ có khi --all-events: phân tích theo từng event (aggregate ở ngoài vẫn là tổng). */
  events?: EventRunSummary[];
  /** Phase 2 auto check-in — chỉ có khi --checkin chạy thành công. */
  checkin?: CheckinRunSummary;
  /** Lý do phase check-in bị bỏ qua (khi --checkin bật nhưng skip) — để UI hiển thị thay vì im lặng. */
  checkinSkip?: string;
  /** Phase 0 auto-join community (--auto-join) — chỉ có khi chạy. */
  join?: JoinRunSummary;
}

/** Kết quả 1 event trong chế độ --all-events. */
export interface EventRunSummary {
  eventId: string;
  eventTitle: string;
  ticketTypeId: string;
  ticketTypeName: string;
  participants: number;
  durationMs: number;
  results: Record<AttackOutcome, number>;
  byStatus: Record<string, number>;
  errors: Record<string, number>;
  actionOk: number;
  actionFail: number;
  successRate: number;
  latencyMs: { avg: number; p50: number; p95: number; p99: number; max: number };
}

/** Tấn công 1 list account vào 1 ticket type → AttackResult[] (login + POST register). */
async function attackAccounts(
  gateway: string,
  accounts: TestAccount[],
  ticketTypeId: string,
  quantity: number,
  concurrency: number,
): Promise<AttackResult[]> {
  return mapLimit(accounts, concurrency, (acc) => attackOne(gateway, acc, ticketTypeId, quantity));
}

/** Gộp AttackResult[] → summary cho 1 nhóm (dùng chung cho từng event + aggregate). */
function summarizeResults(results: AttackResult[], participantCount: number): {
  results: Record<AttackOutcome, number>;
  byStatus: Record<string, number>;
  errors: Record<string, number>;
  actionOk: number;
  actionFail: number;
  latencyMs: { avg: number; p50: number; p95: number; p99: number; max: number };
} {
  const res: Record<AttackOutcome, number> = { REGISTERED: 0, QUEUED: 0, RATE_LIMITED: 0, CONFLICT: 0, FORBIDDEN: 0, BAD_REQUEST: 0, NOT_FOUND: 0, SERVER: 0, LOGIN_FAIL: 0, NETWORK: 0, OTHER: 0 };
  const byStatus: Record<string, number> = {};
  const errors: Record<string, number> = {};
  const latencies: number[] = [];
  let actionOk = 0;
  let actionFail = 0;
  for (const r of results) {
    res[r.outcome]++;
    const st = String(r.status);
    byStatus[st] = (byStatus[st] ?? 0) + 1;
    if (r.outcome === 'REGISTERED' || r.outcome === 'QUEUED') actionOk++;
    else actionFail++;
    if (r.code) errors[r.code] = (errors[r.code] ?? 0) + 1;
    if (r.latencyMs > 0) latencies.push(r.latencyMs);
  }
  latencies.sort((a, b) => a - b);
  const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  return {
    results: res,
    byStatus,
    errors,
    actionOk,
    actionFail,
    latencyMs: {
      avg: Math.round(avg),
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies.length ? latencies[latencies.length - 1] : 0,
    },
  };
}

function printSummary(s: RunSummary): void {
  const pct = (n: number) => `${((n / Math.max(1, s.participants)) * 100).toFixed(1)}%`;
  const order: AttackOutcome[] = ['REGISTERED', 'QUEUED', 'CONFLICT', 'FORBIDDEN', 'BAD_REQUEST', 'NOT_FOUND', 'RATE_LIMITED', 'SERVER', 'NETWORK', 'LOGIN_FAIL', 'OTHER'];
  console.log('──────────────────────────────────────');
  console.log('[ticket] KẾT QUẢ: POST /content-service/tickets/register');
  console.log(`[ticket] event       : ${s.eventTitle ?? ''} (${s.eventId ?? '-'})`);
  console.log(`[ticket] ticket type : ${s.ticketTypeName ?? ''} (${s.ticketTypeId ?? '-'})`);
  console.log(`[ticket] quantity    : ${s.quantity} / user`);
  console.log(`[ticket] participants: ${s.participants}`);
  console.log(`[ticket] duration    : ${(s.durationMs / 1000).toFixed(1)}s (${(s.participants / Math.max(1, s.durationMs / 1000)).toFixed(0)} req/s)`);
  for (const o of order) {
    if (s.results[o] > 0) console.log(`  ${o.padEnd(13)} ${s.results[o]}  (${pct(s.results[o])})`);
  }
  console.log(`  SUCCESS(201+202): ${s.actionOk} (${pct(s.actionOk)}) | FAIL: ${s.actionFail} (${pct(s.actionFail)})`);
  console.log(`  success rate: ${s.successRate.toFixed(1)}%`);
  console.log(`  latency ms   : avg ${s.latencyMs.avg} | p50 ${s.latencyMs.p50} | p95 ${s.latencyMs.p95} | p99 ${s.latencyMs.p99} | max ${s.latencyMs.max}`);
  if (s.events && s.events.length > 0) {
    console.log('  ── theo từng event ──');
    for (const e of s.events) {
      const ep = (n: number) => `${((n / Math.max(1, e.participants)) * 100).toFixed(1)}%`;
      console.log(`  ${e.eventTitle} (${e.eventId}) · type ${e.ticketTypeName} (${e.ticketTypeId}) · ${e.participants} user · ${(e.durationMs / 1000).toFixed(1)}s`);
      const perEventLine = order.filter((o) => e.results[o] > 0).map((o) => `${o}=${e.results[o]} (${ep(e.results[o])})`).join(' ');
      if (perEventLine) console.log(`    ${perEventLine}`);
      console.log(`    SUCCESS ${e.actionOk} (${ep(e.actionOk)}) | rate ${e.successRate.toFixed(1)}% | latency avg ${e.latencyMs.avg} / p95 ${e.latencyMs.p95} | fail ${e.actionFail} (${e.errors ? Object.keys(e.errors).length : 0} err-code)`);
    }
    console.log('  ─────────────────────────');
  }
  if (s.join) {
    console.log(`  join: ${s.join.joined} joined (public) | ${s.join.pending} pending | ${s.join.skip} skip | ${s.join.fail} fail — ${(s.join.durationMs / 1000).toFixed(1)}s`);
    if (s.join.pending > 0) console.log(`    ⚠ ${s.join.pending} account join PENDING — community riêng tư cần owner duyệt; check-in vé vẫn chạy bình thường.`);
  }
  const topErr = Object.entries(s.errors).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (topErr.length > 0) {
    console.log('  top errors  :');
    for (const [code, count] of topErr) console.log(`    ${code}: ${count}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────

/**
 * Lõi ticket-register — dùng chung: CLI (main dưới) và HTTP API (loadtest/routes/tickets.ts).
 * In KẾT QUẢ ra console (CLI parity); trả { exitCode, summary?, error? } cho caller.
 * exitCode: 0=đạt min-success-rate · 1=không đạt · 2=config/discovery lỗi (error set).
 */
export async function runTicketRegistration(opts: TicketRegistrationOptions): Promise<TicketRunResult> {
  const env = getEnv();
  const gateway = normalizeUrl(opts.gateway?.trim() || env.gatewayUrl);
  const communityId = (opts.communityId?.trim() || env.communityId) ?? null;
  if (!gateway) {
    const err = 'Thiếu gateway (--gateway hoặc env LOADTEST_GATEWAY_URL)';
    console.error(err);
    return { exitCode: 2, error: err };
  }
  if (!communityId && !opts.eventId) {
    const err = 'Thiếu community-id (--community-id / env LOADTEST_COMMUNITY_ID) — cần tìm event mở đăng ký; hoặc cắm thẳng --event-id';
    console.error(err);
    return { exitCode: 2, error: err };
  }
  const quantity = Number.isFinite(opts.quantity) && opts.quantity >= 1 ? Math.floor(opts.quantity) : 1;
  const concurrency = Number.isFinite(opts.concurrency) && opts.concurrency >= 1 ? opts.concurrency : 20;
  if (quantity !== opts.quantity) {
    console.error(`--quantity ${opts.quantity} không hợp lệ (phải ≥ 1 nguyên) — dùng 1`);
  }

  const poolFile = opts.poolFile || env.poolFile;
  if (!poolFile) {
    const err = 'Thiếu --pool-file (hoặc env LOADTEST_POOL_FILE)';
    console.error(err);
    return { exitCode: 2, error: err };
  }
  const runId = 'ticket-' + Date.now().toString(36);
  let accounts: TestAccount[];
  try {
    accounts = loadPoolFile(poolFile, runId);
  } catch {
    // Fall back: pool dạng { users: [...] } (như scripts/join-community.ts).
    try {
      const raw = JSON.parse(fs.readFileSync(poolFile, 'utf8')) as unknown;
      const pool = Array.isArray(raw) ? raw : (raw as { users?: unknown[] })?.users ?? [];
      accounts = (pool as Array<{ email?: string; password?: string; deviceInfo?: TestAccount['deviceInfo'] }>).map((a, i) => ({
        email: a.email ?? '',
        password: a.password ?? '',
        userId: '',
        accessToken: '',
        refreshToken: '',
        displayName: '',
        deviceInfo: a.deviceInfo ?? {
          installationId: crypto.randomUUID(),
          deviceFingerprint: crypto.createHash('sha256').update(a.email ?? `acc-${i}`).digest('hex'),
          platform: 'web',
          deviceName: 'ticket-register-script',
        },
        dateOfBirth: '',
        country: 'VN',
        registeredAt: Date.now(),
      }));
      if (accounts.some((a) => !a.email || !a.password)) throw new Error('pool có account thiếu email/password');
    } catch (e) {
      const err = `Không đọc được pool ${poolFile}: ${e instanceof Error ? e.message : String(e)}`;
      console.error(err);
      return { exitCode: 2, error: err };
    }
  }
  if (opts.limit && opts.limit > 0) accounts = accounts.slice(0, opts.limit);
  if (accounts.length === 0) {
    const err = 'Pool rỗng.';
    console.error(err);
    return { exitCode: 2, error: err };
  }

  ltLog.info(`[ticket] gateway=${gateway} community=${communityId ?? '-'} accounts=${accounts.length} concurrency=${concurrency}`);
  const startedAt = Date.now();

  // Có cần "explorer" (account member dùng để tự tìm event/ticket type + verify member)?
  const needExplorer = !opts.ticketTypeId || opts.verifyMembers;
  let explorerToken = '';
  if (needExplorer) {
    // 0. Login account đầu làm explorer (cần token member của community để gọi open-registration / community-member).
    const explorer = await loginOneAccount(gateway, accounts[0].email, accounts[0].password, accounts[0].deviceInfo);
    if (!explorer.ok) {
      const err = `[ticket] login explorer ${accounts[0].email} FAILED (${explorer.code ?? ''}) — không thể tự tìm event. Dùng --event-id + --ticket-type-id.`;
      console.error(err);
      return { exitCode: 2, error: err };
    }
    explorerToken = explorer.accessToken;
  }

  // 0b. Auto-join (Phase 0): pool tự vào community trước khi register (public auto-join).
  let joinSummary: JoinRunSummary | undefined;
  if (opts.autoJoin && communityId) {
    const t0j = Date.now();
    console.log(`[join] ${accounts.length} account → join community ${communityId} (conn=${concurrency})`);
    const jres = await attackJoin(gateway, accounts, communityId, concurrency);
    let joined = 0, pending = 0, skip = 0, fail = 0;
    for (const o of jres) {
      if (o === 'JOINED') joined++;
      else if (o === 'PENDING') pending++;
      else if (o === 'SKIP') skip++;
      else fail++;
    }
    const dj = Date.now() - t0j;
    const sr = ((joined + skip) / Math.max(1, accounts.length)) * 100;
    joinSummary = { communityId, participants: accounts.length, durationMs: dj, joined, pending, skip, fail, successRate: sr };
    console.log(`[join] → ${joined} joined (public) | ${pending} pending | ${skip} skip | ${fail} fail — ${(dj / 1000).toFixed(1)}s (success ${(sr).toFixed(1)}%)`);
    if (pending > 0) ltLog.warn(`[join] ⚠ ${pending} account join PENDING — community riêng tư cần owner accept (PUT /user-community/join-request/${communityId}/accept-all). Register/check-in vẫn chạy.`);
  } else if (opts.autoJoin && !communityId) {
    ltLog.warn('[join] skip --auto-join: thiếu community-id');
  }

  // 1. Verify members (optional — bước "lấy toàn bộ user trong community").
  let memberIds = new Set<string>(); let memberTotal = 0;
  if (opts.verifyMembers && communityId) {
    const m = await listCommunityMemberIds(gateway, communityId, explorerToken);
    if (m.ok) {
      memberIds = m.userIds; memberTotal = m.total;
      console.log(`[ticket] verify-members: community có ${m.total} member`);
    } else {
      ltLog.warn(`[ticket] verify-members skip: ${m.failMsg}`);
    }
  }

  // 2. Xác định TẬP TARGET: (event, ticket type). Mỗi target nhận 1 phần pool account.
  //    - Cắm thẳng (ticketTypeId/eventId) đôi đường → 1 target.
  //    - --all-events → mọi event mở đăng ký, mỗi event lấy 1 ticket type đang bán.
  //    - mặc định → 1 target: event mở đăng ký đầu + ticket type mở bán đầu.
  const drivenPinner = (id: string): DiscoveredEvent => ({
    id,
    title: 'pinned',
    status: 'PUBLISHED',
    registrationStartTime: null,
    registrationEndTime: null,
    communityId: communityId ?? '',
  });
  const targets: DiscoverTarget[] = [];

  if (opts.ticketTypeId) {
    targets.push({
      event: drivenPinner(opts.eventId ?? ''),
      ticketType: { id: opts.ticketTypeId, eventId: opts.eventId ?? '', name: 'pinned', price: 0, soldOut: false, remainingStock: 1 },
    });
  } else if (opts.eventId) {
    // Ghim event, tự tìm ticket type đang bán của event đó.
    const ev = drivenPinner(opts.eventId);
    const tt = await discoverTicketType(gateway, ev, explorerToken);
    if (tt.failMsg) ltLog.warn(`[ticket] ticket-type warn: ${tt.failMsg}`);
    if (tt.types.length === 0) {
      const err = `[ticket] event ${ev.id} không có ticket type nào đang trong thời gian bán và còn vé — cắm --ticket-type-id hoặc mở bán sớm hơn.`;
      console.error(err);
      return { exitCode: 2, error: err };
    }
    targets.push({ event: ev, ticketType: tt.types[0] });
    console.log(`[ticket] ticket type mở bán: ${tt.types[0].name} (${tt.types[0].id}) price=${tt.types[0].price} stock=${tt.types[0].remainingStock}`);
  } else if (communityId && opts.allEvents) {
    // 2a. --all-events: mọi event mở đăng ký, mỗi event 1 ticket type đang bán.
    const found = await fetchOpenEvents(gateway, communityId, explorerToken);
    if (!found.ok) {
      const err = `[ticket] không lấy được danh sách event mở đăng ký: ${found.failMsg}\n        → cắm --event-id (và --ticket-type-id) nếu bạn đã có event/ticket cụ thể.`;
      console.error(err);
      return { exitCode: 2, error: err };
    }
    if (found.events.length === 0) {
      const err = `[ticket] không có event nào mở đăng ký trong community ${communityId}.\n        → mở đăng ký sớm hơn, hoặc cắm --event-id (và --ticket-type-id).`;
      console.error(err);
      return { exitCode: 2, error: err };
    }
    for (const ev of found.events) {
      const tt = await discoverTicketType(gateway, ev, explorerToken);
      if (tt.failMsg) ltLog.warn(`[ticket] event ${ev.id} ticket-type warn: ${tt.failMsg}`);
      if (tt.types.length > 0) targets.push({ event: ev, ticketType: tt.types[0] });
    }
    console.log(`[ticket] --all-events: ${found.events.length} event mở đăng ký → ${targets.length} target (event không có ticket type đang bán sẽ bỏ qua)`);
    if (targets.length === 0) {
      const err = 'Không event nào có ticket type đang bán — không có target để bắn.';
      console.error(err);
      return { exitCode: 2, error: err };
    }
  } else if (communityId) {
    // 2b. Chế độ đơn: event mở đăng ký đầu (ưu tiên registrationState='open') + type đang bán đầu.
    const found = await discoverEvent(gateway, communityId, explorerToken);
    if (!found.ok || !found.event) {
      const err = `[ticket] ${found.failMsg}\n        → cắm --event-id (và --ticket-type-id) nếu bạn đã có event/ticket cụ thể.`;
      console.error(err);
      return { exitCode: 2, error: err };
    }
    const ev = found.event;
    console.log(`[ticket] event mở đăng ký: ${ev.title} (${ev.id}) status=${ev.status}`);
    const tt = await discoverTicketType(gateway, ev, explorerToken);
    if (tt.failMsg) ltLog.warn(`[ticket] ticket-type warn: ${tt.failMsg}`);
    if (tt.types.length === 0) {
      const err = `[ticket] event ${ev.id} không có ticket type nào đang trong thời gian bán và còn vé — cắm --ticket-type-id hoặc mở bán sớm hơn.`;
      console.error(err);
      return { exitCode: 2, error: err };
    }
    targets.push({ event: ev, ticketType: tt.types[0] });
    console.log(`[ticket] ticket type mở bán: ${tt.types[0].name} (${tt.types[0].id}) price=${tt.types[0].price} stock=${tt.types[0].remainingStock}`);
  } else {
    const err = 'Không có community-id và cũng không có event/ticket cụ thể — không xác định được target.';
    console.error(err);
    return { exitCode: 2, error: err };
  }

  // 3. Chia đều pool account cho từng target + tấn công đồng loạt từng target.
  const base = Math.floor(accounts.length / targets.length);
  let remainder = accounts.length % targets.length;
  let cursor = 0;
  const perEvent: { target: DiscoverTarget; results: AttackResult[]; durationMs: number }[] = [];
  for (const target of targets) {
    const count = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    const slice = accounts.slice(cursor, cursor + count);
    cursor += count;
    const label = target.event.title !== 'pinned' ? target.event.title : target.event.id;
    console.log(`[ticket] BẮN ${slice.length} user → event ${label} (${target.event.id}) | ${target.ticketType.name} (${target.ticketType.id}) qty=${quantity} conn=${concurrency}`);
    const t0 = Date.now();
    const results = await attackAccounts(gateway, slice, target.ticketType.id, quantity, concurrency);
    perEvent.push({ target, results, durationMs: Date.now() - t0 });
  }

  // 4. Tổng hợp: per-event (events[]) + aggregate (toàn bộ results).
  const allResults: AttackResult[] = [];
  const eventSummaries: EventRunSummary[] = [];
  for (const { target, results, durationMs } of perEvent) {
    allResults.push(...results);
    const st = summarizeResults(results, results.length);
    eventSummaries.push({
      eventId: target.event.id,
      eventTitle: target.event.title !== 'pinned' ? target.event.title : target.event.id,
      ticketTypeId: target.ticketType.id,
      ticketTypeName: target.ticketType.name !== 'pinned' ? target.ticketType.name : target.ticketType.id,
      participants: results.length,
      durationMs,
      results: st.results,
      byStatus: st.byStatus,
      errors: st.errors,
      actionOk: st.actionOk,
      actionFail: st.actionFail,
      successRate: (st.actionOk / Math.max(1, results.length)) * 100,
      latencyMs: st.latencyMs,
    });
  }
  const agg = summarizeResults(allResults, allResults.length);
  const multi = eventSummaries.length > 1;
  const summary: RunSummary = {
    gateway,
    communityId,
    eventId: multi ? null : eventSummaries[0]?.eventId ?? null,
    eventTitle: multi ? `${eventSummaries.length} sự kiện` : eventSummaries[0]?.eventTitle ?? null,
    ticketTypeId: multi ? null : eventSummaries[0]?.ticketTypeId ?? opts.ticketTypeId ?? null,
    ticketTypeName: multi ? null : eventSummaries[0]?.ticketTypeName ?? null,
    quantity,
    participants: allResults.length,
    startedAt,
    durationMs: Date.now() - startedAt,
    results: agg.results,
    byStatus: agg.byStatus,
    errors: agg.errors,
    actionOk: agg.actionOk,
    actionFail: agg.actionFail,
    successRate: (agg.actionOk / Math.max(1, allResults.length)) * 100,
    latencyMs: agg.latencyMs,
    events: eventSummaries,
    join: joinSummary,
  };

  // verify-members overlap (userId lấy từ JWT sub sau mỗi lần login).
  if (opts.verifyMembers && memberIds.size > 0) {
    let poolMembers = 0; const seen = new Set<string>();
    for (const r of allResults) {
      if (r.userId && memberIds.has(r.userId) && !seen.has(r.userId)) { poolMembers++; seen.add(r.userId); }
    }
    console.log(`[ticket] verify-members: ${poolMembers}/${allResults.length} account trùng userId member community (community có ${memberTotal} member)`);
    console.log('        (giải thích: pool accounts là member → explorer gọi open-registration OK; tỷ lệ thấp = pool chưa join đủ — chạy loadtest:join-community.)');
  }

  // 5. Auto check-in (phase 2 tuỳ chọn): checker login 1 lần → bắn /tickets/check-in
  //    cho mọi ticketId thu được từ REGISTERED (201). DB-only (không signed token).
  if (opts.checkin) {
    // Thu ticketCode từ kết quả register (201 trả raw Prisma Ticket có ticketCode).
    const ticketCodes: string[] = [];
    for (const r of allResults) {
      if (r.outcome === 'REGISTERED' && r.ticketCodes) for (const c of r.ticketCodes) ticketCodes.push(c);
    }
    const contentServiceUrl = env.contentServiceUrl;
    const serviceToken = env.internalServiceToken;
    if (ticketCodes.length === 0) {
      summary.checkinSkip =
        'Không có ticketCode nào thu được từ vé đăng ký (201). Có thể register trả QUEUED 202 (async) hoặc response không chứa ticketCode — xem server log chi tiết.';
      ltLog.warn('[checkin] không có vé nào đăng ký thành công (201) → bỏ qua phase check-in');
    } else if (!contentServiceUrl) {
      summary.checkinSkip = 'Thiếu LOADTEST_CONTENT_SERVICE_URL (URL content-service, vd http://localhost:3004). Set trong loadtest/.env.';
      ltLog.warn('[checkin] thiếu contentServiceUrl → bỏ qua phase check-in');
    } else if (!serviceToken) {
      summary.checkinSkip =
        'Thiếu LOADTEST_INTERNAL_SERVICE_TOKEN (phải khớp INTERNAL_SERVICE_TOKEN của content-service). Set trong loadtest/.env — không cần phân quyền per-user.';
      ltLog.warn('[checkin] thiếu internalServiceToken → bỏ qua phase check-in');
    } else {
      const cc =
        Number.isFinite(opts.checkinConcurrency) && (opts.checkinConcurrency as number) >= 1
          ? Math.floor(opts.checkinConcurrency as number)
          : concurrency;
      console.log(`[checkin] ${ticketCodes.length} vé → POST internal/distribution/check-in (x-service-token, conn=${cc})`);
      const t0c = Date.now();
      const cresults = await attackCheckin(contentServiceUrl, serviceToken, ticketCodes, cc);
      summary.checkin = summarizeCheckin(cresults, Date.now() - t0c, 'internal');
      printCheckinSummary(summary.checkin);
    }
  }

  printSummary(summary);

  if (opts.reportPath) {
    fs.mkdirSync(path.dirname(opts.reportPath), { recursive: true });
    fs.writeFileSync(opts.reportPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(`[ticket] report: ${opts.reportPath}`);
  }

  let pass = summary.successRate >= opts.minSuccessRate;
  if (summary.checkin) pass = pass && summary.checkin.successRate >= opts.minSuccessRate;
  const checkinNote = summary.checkin ? ` | checkin ${summary.checkin.successRate.toFixed(1)}%` : '';
  console.log(`[ticket] ${pass ? 'PASS' : 'FAIL'} — success rate ${summary.successRate.toFixed(1)}% ≥ ${opts.minSuccessRate}%${checkinNote}`);
  return { exitCode: pass ? 0 : 1, summary };
}

// ─── CLI entry ─────────────────────────────────────────────────────────

/**
 * CLI wrapper — chỉ chạy khi gọi TRỰC TIẾP (npx tsx loadtest/ticket-register.ts);
 * KHÔNG chạy khi module bị import bởi HTTP API (routes/tickets.ts dùng runTicketRegistration).
 */
async function main(): Promise<number> {
  const args = parseArgs(process.argv);
  const env = getEnv();
  const res = await runTicketRegistration({
    poolFile: args.poolFile,
    gateway: args.gateway ?? env.gatewayUrl,
    communityId: args.communityId ?? env.communityId ?? undefined,
    eventId: args.eventId,
    ticketTypeId: args.ticketTypeId,
    quantity: args.quantity,
    concurrency: args.concurrency,
    limit: args.limit,
    verifyMembers: args.verifyMembers,
    allEvents: args.allEvents,
    minSuccessRate: args.minSuccessRate,
    reportPath: args.report,
    checkin: args.checkin,
    autoJoin: args.autoJoin,
    checkinConcurrency: args.checkinConcurrency,
  });
  return res.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`[ticket] fatal: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}