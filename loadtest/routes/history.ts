/**
 * MAYogu LoadTest Tool — history/replay routes (PRD D1): runs list/detail/metrics/logs/delete.
 * Handler nhận (ctx, req, res) — KHÔNG tự gọi guard (B-3).
 */

import * as http from 'node:http';
import type { RouteCtx } from '../http-server';
import { decodeRunIdParam } from '../http-server';
import { toRunSummary, toRunDetail, toMetricTick } from '../api-mappers';

/**
 * Parse limit/offset query param — NaN/không phải số → 400 (trước đây NaN vào SQL
 * LIMIT/OFFSET → 22P02 → 503). limit bị clamp [1, maxLimit], offset >= 0.
 */
function parseLimitOffset(
  url: URL,
  defLimit: number,
  maxLimit: number,
): { ok: true; limit: number; offset: number } | { ok: false } {
  const limitRaw = Number(url.searchParams.get('limit') ?? defLimit);
  const offsetRaw = Number(url.searchParams.get('offset') ?? 0);
  if (!Number.isFinite(limitRaw) || !Number.isFinite(offsetRaw)) return { ok: false };
  return { ok: true, limit: Math.min(Math.max(1, limitRaw), maxLimit), offset: Math.max(0, offsetRaw) };
}

export const historyHandlers = {
  runsList: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const status = ctx.url.searchParams.get('status') ?? undefined;
    const lo = parseLimitOffset(ctx.url, 500, 2000);
    if (!lo.ok) return ctx.fail(res, 400, 'limit/offset phải là số');
    const rows = await ctx.store!.listRuns({ status, limit: lo.limit });
    if (!rows.ok) return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
    // total = tổng số run (không phải độ dài trang) — client phân trang đúng.
    const total = await ctx.store!.countRuns({ status });
    if (!total.ok) return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
    return ctx.ok(res, { runs: rows.rows.map(toRunSummary), total: total.rows[0]?.n ?? 0 });
  },

  runMetrics: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const runId = decodeRunIdParam(ctx.params.id);
    const lo = parseLimitOffset(ctx.url, 3600, 20000);
    if (!lo.ok) return ctx.fail(res, 400, 'limit/offset phải là số');
    const rows = await ctx.store!.listMetricSamples(runId, { limit: lo.limit, offset: lo.offset });
    if (!rows.ok) return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
    // D-6: countMetricSamples KHÔNG trả 0 giả khi DB lỗi — check ok trước khi cộng total.
    const total = await ctx.store!.countMetricSamples(runId);
    if (!total.ok) return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
    return ctx.ok(res, { runId, ticks: rows.rows.map(toMetricTick), total: total.rows[0]?.n ?? 0 });
  },

  runLogs: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const runId = decodeRunIdParam(ctx.params.id);
    const lo = parseLimitOffset(ctx.url, 200, 500);
    if (!lo.ok) return ctx.fail(res, 400, 'limit/offset phải là số');
    const level = ctx.url.searchParams.get('level') ?? undefined;
    const rows = await ctx.store!.listLogEvents(runId, { limit: lo.limit, offset: lo.offset, level });
    if (!rows.ok) return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
    // total = tổng số log (không phải độ dài trang) — client phân trang đúng.
    const total = await ctx.store!.countLogEvents(runId, { level });
    if (!total.ok) return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
    return ctx.ok(res, { runId, logs: rows.rows, total: total.rows[0]?.n ?? 0 });
  },

  runDetail: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const runId = decodeRunIdParam(ctx.params.id);
    const r = await ctx.store!.getRun(runId);
    if (!r.ok) return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
    if (r.rows.length === 0) return ctx.fail(res, 404, `Run ${runId} không tồn tại`);
    return ctx.ok(res, toRunDetail(r.rows[0]));
  },

  runDelete: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const runId = decodeRunIdParam(ctx.params.id);
    // Chặn xóa run đang chạy — coordinator còn flush tick/batch → mất tick cuối
    // (FK 23503) + finalizeRun UPDATE no-op âm thầm.
    if (runId === ctx.coordinator.runId && ctx.coordinator.isRunning) {
      return ctx.fail(res, 409, `Run ${runId} đang chạy — dừng run trước khi xóa`);
    }
    const deleted = await ctx.store!.deleteRun(runId);
    if (!deleted.ok) return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
    if (deleted.rows.length === 0) return ctx.fail(res, 404, `Run ${runId} không tồn tại`);
    return ctx.ok(res, { deleted: true, runId });
  },
};