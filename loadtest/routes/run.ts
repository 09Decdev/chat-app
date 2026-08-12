/**
 * MAYogu LoadTest Tool — routes: run control + status (UI-SPEC Màn 1/2/5/6/7).
 * Handler nhận (ctx, req, res) — KHÔNG tự gọi guard (B-3: guards ở route table / dispatcher).
 */

import * as http from 'node:http';
import type { RouteCtx } from '../http-server';
import type { StartRunRequest, TestAccount, UserPhase } from '../types';
import { normalizeSort } from '../users-sort';
import { PRESETS, validateRunRequest, estimateInfra, mergedAllowlist } from '../config';
import { logHistory, ltLog, normalizeUrl } from '../util';
import { loginOneAccount, decodeSub } from '../auth-factory';
import { ticksToCsv, reportToMarkdown } from '../report';
import { createHealthProbe, healthDepsFrom, type HealthReport } from '../health';
import type { LoadTestCoordinator } from '../coordinator';

/** Whitelist phase cho query param /users?phase= (8 phase user — chuỗi lạ bị bỏ qua). */
const USER_PHASES: UserPhase[] = ['provisioned', 'connecting', 'connected', 'queued', 'in_room', 'idle', 'cooldown', 'failed'];

// T-07 FIX-1: probe cache 10s — 1 probe/server (keyed theo coordinator, không singleton module).
// KHÔNG gọi buildHealth (đấm DB/Redis mỗi poll). DB/Redis probe có timeout
// (store.probe query_timeout + Redis commandTimeout).
const healthProbes = new WeakMap<LoadTestCoordinator, () => Promise<HealthReport>>();

export const runHandlers = {
  health: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    // T-07 (US-OBS-1): DB down → status:'degraded'|'down', db:'down' — KHÔNG 500, KHÔNG 'ok' giả.
    let probe = healthProbes.get(ctx.coordinator);
    if (!probe) {
      probe = createHealthProbe(() => healthDepsFrom(ctx.coordinator, ctx.store, ctx.startedAt));
      healthProbes.set(ctx.coordinator, probe);
    }
    const report = await probe();
    return ctx.ok(res, report);
  },

  start: async (ctx: RouteCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const body = await ctx.readBody(req, res);
    if (body === undefined) return;
    const startReq: StartRunRequest = {
      targetUsers: Number(body.targetUsers),
      rampRate: Number(body.rampRate ?? 200),
      rampMode: (body.rampMode as 'rate' | 'minutes' | 'burst' | 'breakpoint') ?? 'rate',
      durationMin: Number(body.durationMin),
      profile: body.profile as StartRunRequest['profile'],
      gatewayUrl: String(body.gatewayUrl ?? ctx.env.gatewayUrl),
      // Boolean("false") === true — client gửi chuỗi "false" sẽ register ồ ạt; chỉ nhận boolean thật, mặc định an toàn.
      freshAccounts: typeof body.freshAccounts === 'boolean' ? body.freshAccounts : false,
      // Network impairment + chaos — validate ở validateRunRequest (sai shape → 400)
      network: (body.network as StartRunRequest['network']) ?? undefined,
      chaos: (body.chaos as StartRunRequest['chaos']) ?? undefined,
      thresholds: (body.thresholds as StartRunRequest['thresholds']) ?? undefined,
      stress: body.stress === true,
    };
    const envForGuard = { ...ctx.env, allowlist: mergedAllowlist(ctx.env) };
    const v = validateRunRequest(startReq, envForGuard);
    if (!v.ok) {
      return ctx.fail(res, 400, 'Cấu hình run không hợp lệ (SD-1 chặn cứng)', { errors: v.errors, warnings: v.warnings });
    }
    const result = await ctx.coordinator.start(startReq);
    if (!result.ok) return ctx.fail(res, 409, result.error ?? 'Không start được');
    return ctx.ok(res, {
      runId: result.config?.runId,
      config: result.config,
      warnings: v.warnings,
      estimate: estimateInfra(startReq.targetUsers, ctx.env),
    });
  },

  stop: async (ctx: RouteCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const body = await ctx.readBody(req, res);
    if (body === undefined) return;
    const force = body.force === true;
    await ctx.coordinator.stop(force);
    return ctx.ok(res, { stopped: true, force });
  },

  kill: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    await ctx.coordinator.stop(true);
    return ctx.ok(res, { stopped: true, force: true });
  },

  pause: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    ctx.coordinator.pause();
    return ctx.ok(res, { paused: true });
  },

  resume: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    ctx.coordinator.resume();
    return ctx.ok(res, { resumed: true });
  },

  status: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const s = ctx.coordinator.getRunSnapshot();
    return ctx.ok(res, {
      ...s,
      elapsedSec: s.startAt > 0 ? Math.round((Date.now() - s.startAt) / 1000) : 0,
      isRunning: ctx.coordinator.isRunning,
    });
  },

  metrics: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const since = Number(ctx.url.searchParams.get('since') ?? 0);
    const limit = Math.min(Number(ctx.url.searchParams.get('limit') ?? 3600), 7200);
    let ticks = ctx.coordinator.tickHistory;
    if (since > 0) ticks = ticks.filter((t) => t.ts > since);
    ticks = ticks.slice(-limit);
    return ctx.ok(res, { ticks, runId: ctx.coordinator.runId });
  },

  users: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const offset = Math.max(0, Number(ctx.url.searchParams.get('offset') ?? 0));
    const limit = Math.min(Math.max(1, Number(ctx.url.searchParams.get('limit') ?? 100)), 500);
    const filter = ctx.url.searchParams.get('filter') ?? undefined;
    // phase: whitelist 8 phase user — chuỗi lạ bỏ qua (filter không bắt buộc)
    const phaseRaw = ctx.url.searchParams.get('phase') ?? undefined;
    const phase = phaseRaw && USER_PHASES.includes(phaseRaw as UserPhase) ? (phaseRaw as UserPhase) : undefined;
    // sortBy/sortDir: whitelist cứng (users-sort.ts) — chuỗi lạ → mặc định index asc
    const sortBy = ctx.url.searchParams.get('sortBy') ?? undefined;
    const sortDir = ctx.url.searchParams.get('sortDir') ?? undefined;
    const result = await ctx.coordinator.queryUsers(offset, limit, filter, phase, sortBy, sortDir);
    const { sortBy: field, sortDir: dir } = normalizeSort(sortBy, sortDir);
    return ctx.ok(res, { rows: result.rows, total: result.total, offset, limit, sortBy: field, sortDir: dir, phaseCounts: result.phaseCounts });
  },

  errors: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const samples = ctx.coordinator.errorSamples ?? [];
    return ctx.ok(res, { top: ctx.coordinator.lastTick?.errors ?? [], samples });
  },

  logs: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const limit = Math.min(Math.max(1, Number(ctx.url.searchParams.get('limit') ?? 200)), 500);
    return ctx.ok(res, { logs: logHistory.slice(-limit) });
  },

  report: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (!ctx.coordinator.latestReport) {
      return ctx.fail(res, 404, 'Chưa có report — run chưa kết thúc');
    }
    return ctx.ok(res, ctx.coordinator.latestReport);
  },

  reportExport: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const format = String(ctx.url.searchParams.get('format') ?? 'json');
    if (!ctx.coordinator.latestReport) return ctx.fail(res, 404, 'Chưa có report');
    const r = ctx.coordinator.latestReport;
    if (format === 'md') {
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="report-${r.runId}.md"` });
      res.end(reportToMarkdown(r));
      return;
    }
    if (format === 'csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="metrics-${r.runId}.csv"` });
      res.end(ticksToCsv(r.runId, ctx.coordinator.tickHistory));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="report-${r.runId}.json"` });
    res.end(JSON.stringify(r, null, 2));
  },

  /** F-impersonate: re-login 1 virtual user → trả fresh token để operator mở chat-app như user đó. */
  impersonate: async (ctx: RouteCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const body = await ctx.readBody(req, res);
    if (body === undefined) return;
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!email) return ctx.fail(res, 400, 'email bắt buộc');
    // 1. Tìm account: memory (run active) → DB pool_accounts (run ended).
    let acc: { email: string; password: string; displayName: string; deviceInfo: TestAccount['deviceInfo'] } | null = null;
    let memUserId = '';
    const mem = ctx.coordinator.findAccountInMemory(email);
    if (mem) {
      acc = { email: mem.email, password: mem.password, displayName: mem.displayName, deviceInfo: mem.deviceInfo };
      memUserId = mem.userId;
    } else if (ctx.store) {
      const r = await ctx.store.findAccountByEmail(email);
      if (!r.ok) return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
      const row = r.rows[0];
      if (row) {
        let deviceInfo: TestAccount['deviceInfo'] | null = null;
        try {
          deviceInfo = JSON.parse(row.deviceInfoJson) as TestAccount['deviceInfo'];
        } catch {
          deviceInfo = null;
        }
        if (!deviceInfo || !deviceInfo.installationId || !deviceInfo.deviceFingerprint) {
          deviceInfo = { installationId: `imp-${email}`, deviceFingerprint: `imp-${email}`, platform: 'web', deviceName: 'loadtest-impersonate' };
        }
        acc = { email: row.email, password: row.password, displayName: row.displayName, deviceInfo };
      }
    }
    if (!acc) return ctx.fail(res, 404, `Không tìm thấy account ${email}`, { error: 'NOT_FOUND' });
    // 2. Re-login fresh (gateway multi-session OK — không đá user thật ra).
    const gatewayUrl = ctx.coordinator.config?.gatewayUrl ?? ctx.env.gatewayUrl;
    const login = await loginOneAccount(normalizeUrl(gatewayUrl), acc.email, acc.password, acc.deviceInfo);
    if (!login.ok) {
      const msg = login.require2fa ? 'Account yêu cầu 2FA — không impersonate được' : `Login fail (${login.code})`;
      return ctx.fail(res, login.require2fa ? 409 : 502, msg, { error: login.code ?? 'LOGIN_FAIL' });
    }
    // 3. Decode userId + profile từ JWT (payload có sub/displayName/avatar).
    const userId = decodeSub(login.accessToken) || memUserId;
    let displayName = acc.displayName;
    let avatar = '';
    try {
      const payload = JSON.parse(Buffer.from(login.accessToken.split('.')[1], 'base64url').toString('utf8')) as { displayName?: string; avatar?: string };
      displayName = payload.displayName ?? displayName;
      avatar = payload.avatar ?? '';
    } catch {
      // giữ default
    }
    ltLog.info(`[impersonate] mượn account ${email} (userId ${userId})`);
    return ctx.ok(res, { accessToken: login.accessToken, refreshToken: login.refreshToken, user: { id: userId, email, displayName, avatar } });
  },
};

export { PRESETS };