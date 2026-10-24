/**
 * MAYogu LoadTest Tool — routes: Phòng marketing (quay video).
 * Proxy các API nội bộ của content-service (x-service-token, LOADTEST_CONTENT_SERVICE_URL +
 * LOADTEST_INTERNAL_SERVICE_TOKEN): tìm user (kèm phòng hiện tại), liệt kê phòng, tạo phòng chỉ
 * định, thêm user vào phòng có sẵn. Gắn cờ inPool — account có trong pool mới mở được ô chat
 * (cần password để đăng nhập thay). Operator chat tay qua ô chat (impersonate từng account).
 */

import * as http from 'node:http';
import type { RouteCtx } from '../http-server';
import { requestJson } from '../http';
import { ltLog } from '../util';

const MAX_MEMBERS = 6;

/** Gọi content-service internal — trả { ok, status, data, message } (đã unwrap envelope). */
async function callContent<T>(ctx: RouteCtx, path: string, opts: { method?: 'GET' | 'POST'; body?: unknown } = {}) {
  return requestJson<T>(ctx.env.contentServiceUrl, `/content-service/internal${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'x-service-token': ctx.env.internalServiceToken },
    body: opts.body,
    timeoutMs: 20_000,
  });
}

function requireContentService(ctx: RouteCtx, res: http.ServerResponse): boolean {
  if (ctx.env.contentServiceUrl && ctx.env.internalServiceToken) return true;
  ctx.fail(res, 400, 'Thiếu LOADTEST_CONTENT_SERVICE_URL hoặc LOADTEST_INTERNAL_SERVICE_TOKEN trong loadtest/.env', {
    error: 'CONTENT_SERVICE_NOT_CONFIGURED',
  });
  return false;
}

/** Trả lỗi content-service ra UI giữ nguyên message (409/404/400), còn lại 502. */
function failUpstream(ctx: RouteCtx, res: http.ServerResponse, r: { status: number; message: string; code: string }) {
  const status = [400, 404, 409].includes(r.status) ? r.status : 502;
  ctx.fail(res, status, r.message || `content-service trả ${r.status || r.code}`, { error: r.code || 'UPSTREAM_ERROR' });
}

/** Map email/userId → account trong pool (để UI biết account nào mở được ô chat). */
async function poolIndex(ctx: RouteCtx, emails: string[], userIds: string[]) {
  const byEmail = new Map<string, string>();
  const byUserId = new Map<string, string>();
  if (!ctx.store || (emails.length === 0 && userIds.length === 0)) return { byEmail, byUserId };
  const r = await ctx.store.findPoolAccountsByIdentity(emails, userIds);
  if (r.ok) {
    for (const row of r.rows) {
      byEmail.set(row.email, row.email);
      if (row.userId) byUserId.set(row.userId, row.email);
    }
  }
  return { byEmail, byUserId };
}

function parseUserIds(body: Record<string, unknown>, min: number): string[] | null {
  const raw = Array.isArray(body.userIds) ? body.userIds : [];
  const ids = [...new Set(raw.map((v) => String(v ?? '').trim()).filter(Boolean))];
  return ids.length >= min && ids.length <= MAX_MEMBERS ? ids : null;
}

interface ContentUser {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
  email: string | null;
  phoneNumber: string | null;
  matchedBy: string;
  roomId: string | null;
}

interface ContentRoom {
  roomId: string;
  memberCount: number;
  capacity: number;
  curated: boolean;
  createdAt: number | null;
  expiresAt: number | null;
  members: Array<{ userId: string; displayName: string | null; avatarUrl: string | null }>;
}

export const marketingHandlers = {
  /** GET /accounts?q=&limit= — account trong pool (KHÔNG trả password). */
  accounts: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (!ctx.store) return ctx.fail(res, 503, 'Chưa cấu hình database — không có pool account', { error: 'DB_UNAVAILABLE' });
    const limit = Number(ctx.url.searchParams.get('limit')) || 50;
    const r = await ctx.store.searchAccounts({ q: ctx.url.searchParams.get('q') ?? '', limit });
    if (!r.ok) return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
    return ctx.ok(res, { rows: r.rows });
  },

  /** GET /chat-users?q= — tìm user toàn hệ thống + phòng hiện tại + inPool/poolEmail. */
  searchUsers: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (!requireContentService(ctx, res)) return;
    const q = (ctx.url.searchParams.get('q') ?? '').trim();
    if (!q) return ctx.ok(res, { rows: [] });
    const limit = Math.min(Math.max(Number(ctx.url.searchParams.get('limit')) || 20, 1), 50);
    const r = await callContent<ContentUser[]>(ctx, `/chat/users/search?q=${encodeURIComponent(q)}&limit=${limit}`);
    if (!r.ok) return failUpstream(ctx, res, r);
    const users = Array.isArray(r.data) ? r.data : [];
    const { byEmail, byUserId } = await poolIndex(
      ctx,
      users.map((u) => (u.email ?? '').toLowerCase()).filter(Boolean),
      users.map((u) => u.id),
    );
    const rows = users.map((u) => {
      const poolEmail = byUserId.get(u.id) ?? (u.email ? byEmail.get(u.email.toLowerCase()) : undefined) ?? null;
      return { ...u, inPool: !!poolEmail, poolEmail };
    });
    return ctx.ok(res, { rows });
  },

  /** GET /chat-rooms — phòng đang hoạt động + thành viên (gắn inPool/poolEmail). */
  listRooms: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (!requireContentService(ctx, res)) return;
    const limit = Math.min(Math.max(Number(ctx.url.searchParams.get('limit')) || 100, 1), 500);
    const r = await callContent<ContentRoom[]>(ctx, `/chat/rooms?limit=${limit}`);
    if (!r.ok) return failUpstream(ctx, res, r);
    const rooms = Array.isArray(r.data) ? r.data : [];
    const { byUserId } = await poolIndex(ctx, [], rooms.flatMap((room) => room.members.map((m) => m.userId)));
    const rows = rooms.map((room) => ({
      ...room,
      members: room.members.map((m) => {
        const poolEmail = byUserId.get(m.userId) ?? null;
        return { ...m, inPool: !!poolEmail, poolEmail };
      }),
    }));
    return ctx.ok(res, { rows });
  },

  /** POST /chat-rooms {userIds: 2..6} — tạo phòng chỉ định (người lạ không vào được). */
  createRoom: async (ctx: RouteCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const body = await ctx.readBody(req, res);
    if (body === undefined) return;
    const userIds = parseUserIds(body, 2);
    if (!userIds) return ctx.fail(res, 400, `Cần chọn 2-${MAX_MEMBERS} người khác nhau`, { error: 'INVALID_MEMBERS' });
    if (!requireContentService(ctx, res)) return;
    const r = await callContent<{ roomId: string; roomEndsAt: number }>(ctx, '/chat/rooms', { method: 'POST', body: { userIds } });
    if (!r.ok) return failUpstream(ctx, res, r);
    if (!r.data?.roomId) return ctx.fail(res, 502, 'content-service không trả roomId', { error: 'CREATE_ROOM_FAILED' });
    ltLog.info(`[marketing] tạo phòng ${r.data.roomId} (${userIds.length} người)`);
    return ctx.ok(res, r.data);
  },

  /** POST /chat-rooms/:roomId/members {userIds: 1..6} — thêm vào phòng đang có. */
  addMembers: async (ctx: RouteCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const body = await ctx.readBody(req, res);
    if (body === undefined) return;
    const userIds = parseUserIds(body, 1);
    if (!userIds) return ctx.fail(res, 400, `Cần chọn 1-${MAX_MEMBERS} người khác nhau`, { error: 'INVALID_MEMBERS' });
    if (!requireContentService(ctx, res)) return;
    const roomId = ctx.params.roomId ?? '';
    const r = await callContent<{ roomId: string; roomEndsAt: number }>(
      ctx,
      `/chat/rooms/${encodeURIComponent(roomId)}/members`,
      { method: 'POST', body: { userIds } },
    );
    if (!r.ok) return failUpstream(ctx, res, r);
    ltLog.info(`[marketing] thêm ${userIds.length} người vào phòng ${roomId}`);
    return ctx.ok(res, r.data);
  },
};
