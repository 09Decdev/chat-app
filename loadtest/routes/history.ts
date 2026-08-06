/**
 * MAYogu LoadTest Tool — history/replay routes (PRD D1): runs list/detail/metrics/logs/delete.
 * Handler nhận (ctx, req, res) — KHÔNG tự gọi guard (B-3).
 */

import * as http from 'node:http';
import type { RouteCtx } from '../http-server';
import { decodeRunIdParam } from '../http-server';
import { toRunSummary, toRunDetail, toMetricTick } from '../api-mappers';

export const historyHandlers = {
  runsList: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const status = ctx.url.searchParams.get('status') ?? undefined;
    const limit = Math.min(Math.max(1, Number(ctx.url.searchParams.get('limit') ?? 500)), 2000);
    const rows = await ctx.store!.listRuns({ status, limit });
    if (!rows.ok) return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
    return ctx.ok(res, { runs: rows.rows.map(toRunSummary), total: rows.rows.length });
  },

  runMetrics: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const runId = decodeRunIdParam(ctx.params.id);
    const limit = Math.min(Math.max(1, Number(ctx.url.searchParams.get('limit') ?? 3600)), 20000);
    const offset = Math.max(0, Number(ctx.url.searchParams.get('offset') ?? 0));
    const rows = await ctx.store!.listMetricSamples(runId, { limit, offset });
    if (!rows.ok) return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
    // D-6: countMetricSamples KHÔNG trả 0 giả khi DB lỗi — check ok trước khi cộng total.
    const total = await ctx.store!.countMetricSamples(runId);
    if (!total.ok) return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
    return ctx.ok(res, { runId, ticks: rows.rows.map(toMetricTick), total: total.rows[0]?.n ?? 0 });
  },

  runLogs: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const runId = decodeRunIdParam(ctx.params.id);
    const limit = Math.min(Math.max(1, Number(ctx.url.searchParams.get('limit') ?? 200)), 500);
    const offset = Math.max(0, Number(ctx.url.searchParams.get('offset') ?? 0));
    const level = ctx.url.searchParams.get('level') ?? undefined;
    const rows = await ctx.store!.listLogEvents(runId, { limit, offset, level });
    if (!rows.ok) return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
    return ctx.ok(res, { runId, logs: rows.rows, total: rows.rows.length });
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
    const deleted = await ctx.store!.deleteRun(runId);
    if (!deleted.ok) return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
    if (deleted.rows.length === 0) return ctx.fail(res, 404, `Run ${runId} không tồn tại`);
    return ctx.ok(res, { deleted: true, runId });
  },
};