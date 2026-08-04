/**
 * MAYogu LoadTest Tool — routes: settings (config / allowlist / pools / cleanup).
 * Handler nhận (ctx, req, res) — KHÔNG tự gọi guard (B-3).
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import type { RouteCtx } from '../http-server';
import { PRESETS, loadSettings, saveSettings, mergedAllowlist } from '../config';
import { normalizeUrl } from '../util';
import { createRedis, listPools, poolPath } from '../auth-factory';
import { runCleanup, type CleanupResult } from '../cleanup';

export const settingsHandlers = {
  config: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const settings = loadSettings(ctx.env);
    return ctx.ok(res, {
      port: ctx.env.port,
      allowlist: mergedAllowlist(ctx.env),
      allowlistFromFile: settings.allowlist,
      gatewayUrl: ctx.env.gatewayUrl,
      maxTarget: ctx.env.maxTarget,
      maxDurationMin: ctx.env.maxDurationMin,
      maxRegisterRamp: ctx.env.maxRegisterRamp,
      presets: PRESETS,
      hasOtpSecret: !!ctx.env.otpSecret,
      hasRedisConfigured: !!ctx.env.redisUrl,
      reportsDir: ctx.env.reportsDir,
      // D-17: frontend ẩn CTA đăng ký khi false (additive — không phá toApiError).
      allowRegister: ctx.env.allowRegister,
    });
  },

  allowlistGet: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    return ctx.ok(res, { allowlist: mergedAllowlist(ctx.env), fromFile: loadSettings(ctx.env).allowlist });
  },

  allowlistPost: async (ctx: RouteCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const body = await ctx.readBody(req, res);
    if (body === undefined) return;
    const urls = Array.isArray(body.urls) ? (body.urls as unknown[]).filter((u): u is string => typeof u === 'string').map(normalizeUrl) : [];
    const s = loadSettings(ctx.env);
    s.allowlist = [...new Set(urls)];
    s.updatedAt = Date.now();
    saveSettings(ctx.env, s);
    return ctx.ok(res, { allowlist: mergedAllowlist(ctx.env) });
  },

  pools: async (ctx: RouteCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (ctx.store) {
      const pools = await ctx.store.listPools();
      if (!pools.ok) return ctx.fail(res, 503, 'Database lỗi', { error: 'DB_UNAVAILABLE' });
      if (pools.rows.length) {
        return ctx.ok(res, {
          pools: pools.rows.map((pl) => ({
            runId: pl.poolId,
            targetUsers: pl.targetUsers,
            gatewayUrl: pl.gatewayUrl,
            accountCount: pl.accountCount,
            registered: pl.registered,
            loggedIn: pl.loggedIn,
            failed: pl.failed,
            importedFromFile: pl.importedFromFile,
            mtimeMs: pl.createdAt,
          })),
        });
      }
    }
    // fallback: file JSON khi DB trống/chưa import (PRD §2.5)
    return ctx.ok(res, { pools: listPools(ctx.env.dataDir) });
  },

  cleanup: async (ctx: RouteCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const body = await ctx.readBody(req, res);
    if (body === undefined) return;
    const runId = String(body.runId ?? ctx.coordinator.runId ?? '');
    const dryRun = body.dryRun !== false;
    if (!runId) return ctx.fail(res, 400, 'runId bắt buộc');
    let accounts: { userId: string }[] = [];
    const pool = listPools(ctx.env.dataDir).find((p2) => p2.runId === runId);
    if (pool) {
      try {
        const parsed = JSON.parse(fs.readFileSync(poolPath(ctx.env.dataDir, runId), 'utf8')) as { accounts: { userId: string }[] };
        accounts = parsed.accounts ?? [];
      } catch {
        accounts = [];
      }
    }
    const redis = createRedis(ctx.env);
    try {
      await redis.connect();
      const result: CleanupResult = await runCleanup(redis, runId, accounts, dryRun);
      return ctx.ok(res, result);
    } finally {
      redis.disconnect();
    }
  },
};