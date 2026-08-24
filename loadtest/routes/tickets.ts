/**
 * MAYogu LoadTest Tool — routes: ticket-register (ĐĂNG KÝ VÉ — script CLI tái sử dụng).
 * Chạy IN-PROCESS qua `runTicketRegistration` (loadtest/ticket-register.ts) — KHÔNG spawn
 * process con, KHÔNG state riêng: nhận request → chạy hết → trả summary JSON.
 * Handler nhận (ctx, req, res) — KHÔNG tự gọi guard (B-3: guards ở route table / dispatcher).
 */

import * as http from 'node:http';
import * as path from 'node:path';
import type { RouteCtx } from '../http-server';
import { runTicketRegistration } from '../ticket-register';
import { ltLog } from '../util';

function toNum(v: unknown, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export const ticketHandlers = {
  /**
   * POST /api/loadtest/ticket-register
   * Body: { poolFile?, gateway?, communityId?, eventId?, ticketTypeId?, allEvents?,
   *         quantity?, concurrency?, limit?, verifyMembers?, minSuccessRate? }
   * Trường thiếu → fallback env của server (LOADTEST_POOL_FILE / GATEWAY_URL / COMMUNITY_ID).
   * allEvents=true (với communityId, không cắm event/ticket) → mọi event mở đăng ký,
   * mỗi event 1 ticket type, chia đều pool account; summary kèm events[] per-event.
   * Kết quả: { summary, exitCode, pass } — exitCode 0=đạt min-success-rate,
   * 1=không đạt, 2=config/discovery lỗi → HTTP 400 (kèm summary.error làm message).
   * Chạy đồng bộ (run trong ~vài chục giây tùy concurrency) — client dùng timeout dài.
   */
  run: async (ctx: RouteCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const body = await ctx.readBody(req, res);
    if (body === undefined) return;

    // limit: rỗng/0/không hợp lệ → undefined (tất cả account trong pool).
    const limitRaw = body.limit;
    const limitNum = Number(limitRaw);
    const limit =
      limitRaw === undefined || limitRaw === '' || !Number.isFinite(limitNum) || limitNum <= 0
        ? undefined
        : Math.floor(limitNum);

    const reportPath = path.join(ctx.env.reportsDir, `ticket-${Date.now().toString(36)}.json`);
    const result = await runTicketRegistration({
      poolFile: toStr(body.poolFile) || ctx.env.poolFile || undefined,
      gateway: toStr(body.gateway) || ctx.env.gatewayUrl,
      communityId: toStr(body.communityId) || ctx.env.communityId || undefined,
      eventId: toStr(body.eventId) || undefined,
      ticketTypeId: toStr(body.ticketTypeId) || undefined,
      quantity: toNum(body.quantity, 1),
      concurrency: toNum(body.concurrency, 20),
      limit,
      verifyMembers: body.verifyMembers === true,
      allEvents: body.allEvents === true,
      minSuccessRate: toNum(body.minSuccessRate, 90),
      reportPath,
    });

    if (result.exitCode === 2 || !result.summary) {
      ltLog.warn(`[tickets] ticket-register config/discovery lỗi: ${result.error ?? 'unknown'}`);
      return ctx.fail(res, 400, result.error ?? 'Cấu hình/discovery lỗi — xem server log', { error: 'TICKET_CONFIG_ERROR' });
    }

    const pass = result.exitCode === 0;
    ltLog.info(
      `[tickets] ticket-register xong: ${result.summary.participants} user, success ${result.summary.successRate.toFixed(1)}% (${pass ? 'PASS' : 'FAIL'})`,
    );
    return ctx.ok(res, { summary: result.summary, exitCode: result.exitCode, pass });
  },
};