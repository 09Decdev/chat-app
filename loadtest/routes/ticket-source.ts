/**
 * MAYogu LoadTest Tool — routes: ticket-source (dữ liệu nguồn cho dropdown UI ticket-register).
 *
 * Mục đích: cho UI (TicketRegisterPage) nguồn dữ liệu thật để đổ vào các ô combobox:
 *   - Cộng đồng   → GET {gateway}/user-community/community/all (phân trang pageSize 30)
 *   - Event       → GET {gateway}/content-service/event/open-registration/{communityId}
 *   - Ticket type → GET {gateway}/content-service/ticket-type/eventId/{eventId}
 *
 * Mọi cuộc gọi upstream dùng TOKEN EXPLORER = login account ĐẦU TIÊN của pool (giống
 * runTicketRegistration làm khi tự tìm event — không cần admin token của service thật).
 * Pool mặc định = env LOADTEST_POOL_FILE; UI có thể truyền `poolFile` khác (pool đã chọn).
 *
 * Handler nhận (ctx, req, res) — KHÔNG tự gọi guard (B-3: guards ở route table / dispatcher).
 * GET read-only → KHÔNG rate limit (xem đăng ký ở api-server.ts).
 */

import * as http from 'node:http';
import type { RouteCtx } from '../http-server';
import { loadPoolFile, loginOneAccount } from '../auth-factory';
import { requestJson } from '../http';
import { ltLog } from '../util';

/** Đọc query param từ ctx.url (URL object đã có searchParams). */
function q(url: URL, key: string): string {
  return url.searchParams.get(key)?.trim() ?? '';
}

/** Giới hạn số trang cộng đồng gộp (chống vòng lặp nếu upstream pagination lỗi). */
const MAX_COMMUNITY_PAGES = 50;
const COMMUNITY_PAGE_SIZE = 30;

type ExplorerResult = { ok: true; token: string } | { ok: false; msg: string };

/**
 * Explorer token: login account đầu pool (poolFile || env.poolFile).
 * Chính là cơ chế runTicketRegistration dùng để tự tìm event/ticket type.
 */
async function getExplorerToken(ctx: RouteCtx, poolFileFromQuery?: string): Promise<ExplorerResult> {
  const file = poolFileFromQuery || ctx.env.poolFile;
  if (!file) {
    return { ok: false, msg: 'Chưa có pool file — chọn 1 pool ở ô Pool (hoặc set LOADTEST_POOL_FILE trong loadtest/.env).' };
  }
  let accounts: Parameters<typeof loadPoolFile>[0] extends never ? never : ReturnType<typeof loadPoolFile>;
  try {
    accounts = loadPoolFile(file, 'ticket-source');
  } catch (e) {
    return { ok: false, msg: `Không đọc được pool ${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (accounts.length === 0) return { ok: false, msg: 'Pool rỗng — không có account để dùng làm explorer.' };
  const first = accounts[0];
  const login = await loginOneAccount(ctx.env.gatewayUrl, first.email, first.password, first.deviceInfo);
  if (!login.ok) {
    return {
      ok: false,
      msg: `Login explorer ${first.email} thất bại (${login.code ?? 'LOGIN_FAIL'}) — cần account là member của community để tự tìm event/ticket.`,
    };
  }
  return { ok: true, token: login.accessToken };
}

export interface TicketSourceCommunityRow {
  id: string;
  name: string;
  code?: string;
}
export interface TicketSourceEventRow {
  id: string;
  title: string;
  status: string;
  registrationState?: string;
}
export interface TicketSourceTicketTypeRow {
  id: string;
  eventId: string;
  name: string;
  price: number;
  remainingStock: number;
  soldOut: boolean;
  saleStartsAt?: string | null;
  saleEndsAt?: string | null;
}

export const ticketSourceHandlers = {
  /** GET /api/loadtest/ticket-source/communities[?poolFile=...] → { communities, gateway }. */
  communities: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const poolFile = q(ctx.url, 'poolFile') || undefined;
    const ex = await getExplorerToken(ctx, poolFile);
    if (!ex.ok) return ctx.fail(res, 400, ex.msg, { error: 'EXPLORER_FAIL' });

    const out: TicketSourceCommunityRow[] = [];
    const seen = new Set<string>();
    let page = 1;
    for (; page <= MAX_COMMUNITY_PAGES; page++) {
      const r = await requestJson<{
        data?: Array<{ id?: string; name?: string; code?: string }>;
        pagination?: { totalPages?: number; total?: number };
      }>(ctx.env.gatewayUrl, `/user-community/community/all?page=${page}&pageSize=${COMMUNITY_PAGE_SIZE}`, {
        token: ex.token,
        timeoutMs: 15_000,
      });
      if (!r.ok) {
        ltLog.warn(`[ticket-source] community/all HTTP ${r.status}: ${r.message}`);
        if (page === 1) {
          return ctx.fail(res, 502, `Lấy danh sách cộng đồng thất bại (HTTP ${r.status}). Xem log loadtest server.`, {
            error: 'UPSTREAM_FAIL',
          });
        }
        break;
      }
      const rows = r.data?.data;
      if (!Array.isArray(rows)) break;
      for (const c of rows) {
        if (typeof c?.id === 'string' && c.id && typeof c?.name === 'string' && c.name && !seen.has(c.id)) {
          seen.add(c.id);
          out.push({ id: c.id, name: c.name, code: typeof c.code === 'string' ? c.code : undefined });
        }
      }
      const pag = r.data?.pagination;
      if (rows.length === 0 || !pag || page >= (pag.totalPages ?? page)) break;
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    ltLog.info(`[ticket-source] communities: ${out.length} (gateway ${ctx.env.gatewayUrl})`);
    ctx.ok(res, { communities: out, gateway: ctx.env.gatewayUrl });
  },

  /** GET /api/loadtest/ticket-source/events?communityId=...[&poolFile=...] → { events }. */
  events: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const communityId = q(ctx.url, 'communityId');
    if (!communityId) return ctx.fail(res, 400, 'Thiếu query communityId', { error: 'MISSING_PARAM' });
    const poolFile = q(ctx.url, 'poolFile') || undefined;
    const ex = await getExplorerToken(ctx, poolFile);
    if (!ex.ok) return ctx.fail(res, 400, ex.msg, { error: 'EXPLORER_FAIL' });

    const r = await requestJson<{
      data?: Array<{ id?: string; title?: string; status?: string; registrationState?: string }>;
    }>(ctx.env.gatewayUrl, `/content-service/event/open-registration/${encodeURIComponent(communityId)}?page=1&limit=50`, {
      token: ex.token,
      timeoutMs: 15_000,
    });
    if (!r.ok) {
      return ctx.fail(res, 502, `Không lấy được event của community (HTTP ${r.status}). ${r.message} — đảm bảo pool account đã join community.`, {
        error: 'UPSTREAM_FAIL',
      });
    }
    const events: TicketSourceEventRow[] = (r.data?.data ?? [])
      .filter((e): e is NonNullable<typeof e> & { id: string } => !!e && typeof e.id === 'string')
      .map((e) => ({
        id: e.id,
        title: typeof e.title === 'string' ? e.title : '',
        status: typeof e.status === 'string' ? e.status : '',
        registrationState: typeof e.registrationState === 'string' ? e.registrationState : undefined,
      }));
    ctx.ok(res, { events });
  },

  /** GET /api/loadtest/ticket-source/ticket-types?eventId=...[&poolFile=...] → { ticketTypes }. */
  ticketTypes: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const eventId = q(ctx.url, 'eventId');
    if (!eventId) return ctx.fail(res, 400, 'Thiếu query eventId', { error: 'MISSING_PARAM' });
    const poolFile = q(ctx.url, 'poolFile') || undefined;
    const ex = await getExplorerToken(ctx, poolFile);
    if (!ex.ok) return ctx.fail(res, 400, ex.msg, { error: 'EXPLORER_FAIL' });

    const r = await requestJson<{
      ticketTypes?: Array<{
        id?: string;
        eventId?: string;
        name?: string;
        price?: number;
        remainingStock?: number;
        soldOut?: boolean;
        saleStartsAt?: string | null;
        saleEndsAt?: string | null;
      }>;
    }>(ctx.env.gatewayUrl, `/content-service/ticket-type/eventId/${encodeURIComponent(eventId)}`, {
      token: ex.token,
      timeoutMs: 15_000,
    });
    if (!r.ok) {
      return ctx.fail(res, 502, `Không lấy được ticket type (HTTP ${r.status}). ${r.message}`, { error: 'UPSTREAM_FAIL' });
    }
    const ticketTypes: TicketSourceTicketTypeRow[] = (r.data?.ticketTypes ?? [])
      .filter((t): t is NonNullable<typeof t> & { id: string } => !!t && typeof t.id === 'string')
      .map((t) => ({
        id: t.id,
        eventId: typeof t.eventId === 'string' ? t.eventId : eventId,
        name: typeof t.name === 'string' ? t.name : '',
        price: typeof t.price === 'number' && Number.isFinite(t.price) ? t.price : 0,
        remainingStock: typeof t.remainingStock === 'number' && Number.isFinite(t.remainingStock) ? t.remainingStock : 0,
        soldOut: t.soldOut === true,
        saleStartsAt: typeof t.saleStartsAt === 'string' ? t.saleStartsAt : null,
        saleEndsAt: typeof t.saleEndsAt === 'string' ? t.saleEndsAt : null,
      }));
    ctx.ok(res, { ticketTypes });
  },
};