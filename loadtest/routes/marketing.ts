/**
 * MAYogu LoadTest Tool — routes: Phòng marketing (quay video).
 * Operator chọn 2-6 account trong pool → server đăng nhập lấy userId → gọi content-service
 * POST /internal/chat/rooms (x-service-token) tạo phòng ĐÚNG các account đó, không qua hàng chờ.
 * Phòng curated: người lạ không được ghép vào. Operator chat tay qua Console (impersonate từng ô).
 */

import * as http from 'node:http';
import type { RouteCtx } from '../http-server';
import { requestJson } from '../http';
import { ltLog, normalizeUrl } from '../util';
import { loginOneAccount, decodeSub } from '../auth-factory';
import { findPoolAccount } from './run';

const CURATED_ROOM_PATH = '/content-service/internal/chat/rooms';
const MAX_MEMBERS = 6;

export const marketingHandlers = {
  /** GET /accounts?q=&limit= — account trong pool để chọn (KHÔNG trả password). */
  accounts: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (!ctx.store) return ctx.fail(res, 503, 'Chưa cấu hình database — không có pool account', { error: 'DB_UNAVAILABLE' });
    const limit = Number(ctx.url.searchParams.get('limit')) || 50;
    const r = await ctx.store.searchAccounts({ q: ctx.url.searchParams.get('q') ?? '', limit });
    if (!r.ok) return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
    return ctx.ok(res, { rows: r.rows });
  },

  /** POST /marketing-room {emails: string[2..6]} → { roomId, roomEndsAt, members } */
  createRoom: async (ctx: RouteCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const body = await ctx.readBody(req, res);
    if (body === undefined) return;
    const raw = Array.isArray(body.emails) ? body.emails : [];
    const emails = [...new Set(raw.map((e) => String(e ?? '').trim().toLowerCase()).filter(Boolean))];
    if (emails.length < 2 || emails.length > MAX_MEMBERS) {
      return ctx.fail(res, 400, `Cần chọn 2-${MAX_MEMBERS} account khác nhau`, { error: 'INVALID_MEMBERS' });
    }
    const { contentServiceUrl, internalServiceToken } = ctx.env;
    if (!contentServiceUrl || !internalServiceToken) {
      return ctx.fail(res, 400, 'Thiếu LOADTEST_CONTENT_SERVICE_URL hoặc LOADTEST_INTERNAL_SERVICE_TOKEN trong loadtest/.env', {
        error: 'CONTENT_SERVICE_NOT_CONFIGURED',
      });
    }

    // 1. Đăng nhập từng account → userId (cũng xác nhận account còn sống trên gateway này).
    const gatewayUrl = normalizeUrl(ctx.coordinator.config?.gatewayUrl ?? ctx.env.gatewayUrl);
    const members: Array<{ email: string; userId: string; displayName: string }> = [];
    for (const email of emails) {
      const found = await findPoolAccount(ctx, email);
      if (found === 'DB_ERROR') return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
      if (!found) return ctx.fail(res, 404, `Không tìm thấy account ${email}`, { error: 'NOT_FOUND' });
      const login = await loginOneAccount(gatewayUrl, found.acc.email, found.acc.password, found.acc.deviceInfo);
      if (!login.ok) {
        return ctx.fail(res, 502, `Đăng nhập ${email} thất bại (${login.code})`, { error: login.code ?? 'LOGIN_FAIL' });
      }
      const userId = decodeSub(login.accessToken) || found.memUserId;
      if (!userId) return ctx.fail(res, 502, `Không đọc được userId của ${email}`, { error: 'NO_USER_ID' });
      members.push({ email, userId, displayName: found.acc.displayName });
    }

    // 2. Tạo phòng chỉ định ở content-service.
    const r = await requestJson<{ roomId?: string; roomEndsAt?: number; data?: { roomId?: string; roomEndsAt?: number } }>(
      contentServiceUrl,
      CURATED_ROOM_PATH,
      {
        method: 'POST',
        headers: { 'x-service-token': internalServiceToken },
        body: { userIds: members.map((m) => m.userId) },
      },
    );
    if (!r.ok) {
      // content-service báo lỗi theo userId → đổi sang email cho operator dễ đọc.
      let message = r.message || `content-service trả ${r.status}`;
      for (const m of members) message = message.split(m.userId).join(m.email);
      const status = r.status === 409 || r.status === 400 ? r.status : 502;
      return ctx.fail(res, status, message, { error: r.code || 'CREATE_ROOM_FAILED' });
    }
    const data = r.data?.data ?? r.data;
    if (!data?.roomId) return ctx.fail(res, 502, 'content-service không trả roomId', { error: 'CREATE_ROOM_FAILED' });
    ltLog.info(`[marketing-room] tạo phòng ${data.roomId} cho ${emails.join(', ')}`);
    return ctx.ok(res, { roomId: data.roomId, roomEndsAt: data.roomEndsAt ?? null, members });
  },
};
