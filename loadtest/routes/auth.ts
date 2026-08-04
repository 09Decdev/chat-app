/**
 * MAYogu LoadTest Tool — admin auth routes (PRD Module A).
 * Handler nhận (ctx, req, res) — KHÔNG tự gọi guard (B-3: guards ở route table / dispatcher).
 */

import * as http from 'node:http';
import type { RouteCtx } from '../http-server';
import { hashPassword, validatePasswordStrength, verifyPassword } from '../db/password';
import { createSessionToken } from '../auth';
import { ltLog } from '../util';

export const authHandlers = {
  register: async (ctx: RouteCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const body = await ctx.readBody(req, res);
    if (body === undefined) return;
    const username = String(body.username ?? '').trim();
    const email = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    if (!username || !email) return ctx.fail(res, 400, 'username và email bắt buộc');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return ctx.fail(res, 400, 'email không hợp lệ');
    const pwErr = validatePasswordStrength(password);
    if (pwErr) return ctx.fail(res, 400, pwErr);
    if (!ctx.store) return ctx.fail(res, 503, 'Database chưa được kết nối');
    const r = await ctx.store.createAdmin({ username, email, passwordHash: hashPassword(password) });
    if (!r.ok) {
      // 23505 = unique violation (trùng username/email) → 409; còn lại là DB fail → 503.
      if (r.error.code === '23505') return ctx.fail(res, 409, 'username hoặc email đã tồn tại');
      return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
    }
    const admin = r.rows[0];
    if (!admin) return ctx.fail(res, 409, 'username hoặc email đã tồn tại');
    ltLog.info(`[lt][auth] admin registered: ${username} (${email})`);
    return ctx.ok(res, { id: admin.id, username: admin.username, email: admin.email, displayName: admin.displayName, role: admin.role });
  },

  login: async (ctx: RouteCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const body = await ctx.readBody(req, res);
    if (body === undefined) return;
    const identifier = String(body.username ?? body.email ?? body.identifier ?? '').trim();
    const password = String(body.password ?? '');
    if (!identifier || !password) return ctx.fail(res, 400, 'username/email và password bắt buộc');
    if (!ctx.store) return ctx.fail(res, 503, 'Database chưa được kết nối');
    const r = await ctx.store.findAdminByLogin(identifier);
    if (!r.ok) return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
    const admin = r.rows[0];
    if (!admin || !admin.isActive || !verifyPassword(password, admin.passwordHash)) {
      // Không lộ thông tin account tồn tại hay không (PRD US-2)
      return ctx.fail(res, 401, 'Sai username/email hoặc mật khẩu');
    }
    void ctx.store.touchLastLogin(admin.id);
    const { token, expiresAt } = createSessionToken({ id: admin.id, username: admin.username }, ctx.authSecret);
    return ctx.ok(res, {
      token,
      expiresAt,
      user: { id: admin.id, username: admin.username, email: admin.email, displayName: admin.displayName, role: admin.role },
    });
  },

  logout: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // auth:true trong route table — dispatcher đã verify token.
    return ctx.ok(res, { loggedOut: true });
  },

  me: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (!ctx.store) return ctx.fail(res, 503, 'Database chưa được kết nối');
    const user = ctx.user;
    if (!user) return ctx.fail(res, 401, 'Tài khoản không tồn tại');
    const r = await ctx.store.getAdminById(user.id);
    if (!r.ok) return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
    const admin = r.rows[0];
    if (!admin) return ctx.fail(res, 401, 'Tài khoản không tồn tại');
    return ctx.ok(res, { id: admin.id, username: admin.username, email: admin.email, displayName: admin.displayName, role: admin.role });
  },
};