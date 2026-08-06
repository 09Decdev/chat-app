#!/usr/bin/env node
/**
 * F3 — CLI one-shot runner cho CI.
 * Start run qua HTTP API → poll → report → exit 0 (thresholds pass) / 1 (fail) / 2 (lỗi).
 *
 *   npx tsx loadtest/cli.ts run --config run.json \
 *     [--server http://localhost:3401] [--admin-user U] [--admin-password P]
 *
 * Env: LOADTEST_CLI_SERVER, LOADTEST_ADMIN_USER, LOADTEST_ADMIN_PASSWORD.
 * Server phải đang chạy (npm run loadtest:server). run.json = StartRunRequest (+ optional thresholds).
 * Thresholds (vd {"p95Ms":500,"successRate":99,"echoRate":95}) → report.thresholdsPassed quyết định exit code.
 */

import * as fs from 'node:fs';
import type { StartRunRequest, RunReport } from './types';

interface CliArgs {
  configPath?: string;
  server: string;
  adminUser: string;
  adminPassword: string;
}

function parseArgs(argv: string[]): CliArgs {
  const a = argv[2] === 'run' ? argv.slice(3) : argv.slice(2);
  const get = (k: string): string | undefined => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    configPath: get('config'),
    server: (get('server') ?? process.env.LOADTEST_CLI_SERVER ?? 'http://localhost:3401').replace(/\/$/, ''),
    adminUser: get('admin-user') ?? process.env.LOADTEST_ADMIN_USER ?? '',
    adminPassword: get('admin-password') ?? process.env.LOADTEST_ADMIN_PASSWORD ?? '',
  };
}

async function fetchJson<T>(url: string, opts: { method: string; token?: string; body?: unknown }): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(url, {
    method: opts.method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json: { success?: boolean; data?: unknown; message?: string };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  // Server wrap mọi response trong envelope { success, data, message } (http-server okJson/failJson).
  if (!res.ok || !json.success) throw new Error(`HTTP ${res.status}: ${json.message ?? text.slice(0, 300)}`);
  return json.data as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  const args = parseArgs(process.argv);
  if (!args.configPath) {
    console.error('Cách dùng: npx tsx loadtest/cli.ts run --config <run.json> [--server URL] [--admin-user U] [--admin-password P]');
    return 2;
  }
  if (!args.adminUser || !args.adminPassword) {
    console.error('Thiếu --admin-user / --admin-password (hoặc env LOADTEST_ADMIN_USER / LOADTEST_ADMIN_PASSWORD)');
    return 2;
  }
  let config: StartRunRequest;
  try {
    config = JSON.parse(fs.readFileSync(args.configPath, 'utf8')) as StartRunRequest;
  } catch (e) {
    console.error(`Không đọc được config ${args.configPath}: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  const base = args.server;
  try {
    // 1. login
    const auth = await fetchJson<{ token: string }>(`${base}/api/loadtest/auth/login`, {
      method: 'POST',
      body: { username: args.adminUser, password: args.adminPassword },
    });

    // 2. start
    const startRes = await fetchJson<{ runId: string; warnings?: string[] }>(`${base}/api/loadtest/start`, {
      method: 'POST',
      token: auth.token,
      body: config,
    });
    const runId = startRes.runId;
    console.log(`[cli] run ${runId} started${startRes.warnings?.length ? ` (warnings: ${startRes.warnings.join('; ')})` : ''}`);

    // 3. poll cho tới khi không còn running (terminal) — có deadline chống hang CI.
    const deadline = Date.now() + config.durationMin * 60_000 + 120_000;
    let elapsed = 0;
    let running = true;
    while (running) {
      if (Date.now() > deadline) throw new Error('poll timeout — run không kết thúc trong thời gian dự kiến (deadline guard)');
      await sleep(2000);
      const st = await fetchJson<{ elapsedSec: number; isRunning: boolean }>(`${base}/api/loadtest/status`, {
        method: 'GET',
        token: auth.token,
      });
      running = st.isRunning;
      elapsed = st.elapsedSec;
      process.stdout.write(`\r[cli] ${runId}: ${elapsed}s ${running ? '…' : 'done'}   `);
    }
    console.log('');

    // 4. report
    const report = await fetchJson<RunReport>(`${base}/api/loadtest/report`, { method: 'GET', token: auth.token });

    // 5. eval thresholds → exit code
    const results = report.thresholdResults ?? [];
    const passed = report.thresholdsPassed ?? true;
    if (results.length === 0) {
      console.log(`[cli] run ${runId} kết thúc (${report.status}) — không có thresholds → PASS (exit 0)`);
    } else {
      for (const r of results) {
        console.log(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.metric}: ${r.actual}${r.unit} (ngưỡng ${r.threshold}${r.unit})`);
      }
      console.log(`[cli] run ${runId} ${report.status}: ${passed ? 'PASS' : 'FAIL'} thresholds`);
    }
    return passed ? 0 : 1;
  } catch (e) {
    console.error(`[cli] lỗi: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`[cli] fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  });
