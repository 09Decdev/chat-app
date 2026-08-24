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
 *     [--verify-members] [--all-events] [--report <path>]
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
 * Account nguồn (pool) phải là member của community — dùng script
 * `npm run loadtest:join-community` trước nếu chưa join.
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
  return { account: account.email, userId: decodeSub(login.accessToken), outcome, status: r.status, code: r.code, latencyMs: r.latencyMs };
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

  printSummary(summary);

  if (opts.reportPath) {
    fs.mkdirSync(path.dirname(opts.reportPath), { recursive: true });
    fs.writeFileSync(opts.reportPath, JSON.stringify(summary, null, 2), 'utf8');
    console.log(`[ticket] report: ${opts.reportPath}`);
  }

  const pass = summary.successRate >= opts.minSuccessRate;
  console.log(`[ticket] ${pass ? 'PASS' : 'FAIL'} — success rate ${summary.successRate.toFixed(1)}% ≥ ${opts.minSuccessRate}%`);
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