/**
 * MAYogu LoadTest Tool — cấu hình env + validation run + presets (CP-1).
 *
 * - Env đọc từ loadtest/.env (KV đơn giản, không thêm dependency dotenv).
 * - Allowlist test (SD-1): chặn cứng mọi gateway URL không nằm trong danh sách.
 * - Preset 1M/10M là preset có cảnh báo hạ tầng — server chặn cứng target > maxTarget
 *   (PRD §8: MVP = 10k-100k đúng trên 1 máy; 1M/10M cần cluster v1.1).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ActionProfile, RunConfig, StartRunRequest } from './types';
import { normalizeUrl, parseBool, ltLog, redactUrl } from './util';

/** loadtest/ dir (ESM-safe). */
export const LOADTEST_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Placeholder DB URL (C-2) — thay credential mặc định đã bị xoá; validateEnv fail-fast khi gặp. */
export const PLACEHOLDER_DB_URL = 'postgresql://USER:PASS@HOST:PORT/DB';
/** Default credential cũ (đã bị xoá khỏi code) — validateEnv vẫn chặn đúng chuỗi này. */
export const DEFAULT_DEV_DB_URL = 'postgresql://appuser:secret@localhost:5439/loadtest';

/**
 * Chặn đúng 2 chuỗi known-bad (T-03): placeholder + default credential cũ.
 * KHÔNG dùng substring match `appuser`/`:secret@` — sẽ false-positive lên URL
 * dev hợp lệ có username `appuser` + password thật (loadtest/.env).
 */
export function isKnownBadDbUrl(url: string): boolean {
  return url === PLACEHOLDER_DB_URL || url === DEFAULT_DEV_DB_URL;
}

export interface LoadTestEnv {
  port: number;
  /** Host API điều khiển — mặc định 127.0.0.1 (không expose ra ngoài máy). */
  host: string;
  allowlist: string[]; // gateway URLs được phép chạy (normalized http)
  gatewayUrl: string;
  otpSecret: string;
  /** Secret ký session token (auth.ts loadAuthSecret) — raw env, rỗng = fallback tự sinh (dev-only). */
  authSecret: string;
  redisUrl: string;
  maxTarget: number;
  maxDurationMin: number;
  maxRegisterRamp: number;
  workerCount: number; // 0 = auto
  maxSocketsPerWorker: number;
  maxPendingOutbox: number;
  dataDir: string;
  reportsDir: string;
  /** Chế độ "chỉ dùng pool file": path JSON account có sẵn (rỗng = hành vi cũ). Set → KHÔNG bao giờ register. */
  poolFile: string;
  databaseUrl: string;
  scrapeIntervalMs: number;
  registerRamp: number;
  /** Nội dung tĩnh cho REST driver: postId fixtures (rỗng → driver tự bỏ qua POST create). */
  fixturePostIds: string[];
  /** Giới hạn action like/comment/view/read vào đúng 1 community (rỗng = toàn app). */
  communityId: string;
  /** Tên phòng chat test (matching không cần — server tự tạo). */
  debug: boolean;
  /** Bắt buộc DB kết nối để server start (Q-2) — mặc định true. */
  dbRequired: boolean;
  /** CORS allowlist (T-06) — echo origin nếu khớp, KHÔNG `*` (SEC-2). Default http://localhost:5173 (R-7). */
  corsOrigins: string[];
  /** Register gate (SEC-6) — mặc định false (dev set true). */
  allowRegister: boolean;
  /** Rate-limit escape hatch (test/CI — PLAN R-6). */
  rateLimitDisabled: boolean;
  /** Số fail login/register trong window → 429 (mặc định 5). */
  rateLimitLoginFails: number;
  /** Cửa sổ fail window (ms) — mặc định 60s. */
  rateLimitWindowMs: number;
  /** Refill interval /start bucket (ms) — mặc định 10s (1 req/10s). */
  rateLimitStartMs: number;
  /** Write bucket (req/min) cho /allowlist POST, /cleanup, DELETE /runs — 0 = OFF (mặc định). */
  rateLimitWriteBucket: number;
  /** Tin X-Forwarded-For (chống spoof header — mặc định false). */
  trustProxy: boolean;
  /** Tổng timeout graceful shutdown (ms) — mặc định 10s (PRD §5.2). */
  shutdownTimeoutMs: number;
}

export function loadDotEnv(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const file = path.join(dir, '.env');
  if (!fs.existsSync(file)) return out;
  try {
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  } catch (e) {
    ltLog.warn(`Không đọc được loadtest/.env: ${String(e)}`);
  }
  return out;
}

let cachedEnv: LoadTestEnv | null = null;

/** C-4: in nguồn từng key (process.env / .env file / override) khi LOADTEST_DEBUG. */
function logEnvSources(
  processEnv: Record<string, string | undefined>,
  fromFile: Record<string, string>,
  overrides: Record<string, string>,
): void {
  const keys = new Set<string>();
  for (const k of Object.keys(processEnv)) if (k.startsWith('LOADTEST_')) keys.add(k);
  for (const k of Object.keys(fromFile)) keys.add(k);
  for (const k of Object.keys(overrides)) keys.add(k);
  const sorted = [...keys].sort();
  for (const key of sorted) {
    let source: string;
    if (key in overrides) source = 'override';
    else if (key in processEnv) source = 'process.env';
    else if (key in fromFile) source = '.env file';
    else source = 'default';
    ltLog.info(`[env] ${key} ← ${source}`);
  }
}

/**
 * Merge 3 nguồn env (T-03): process.env (cao nhất) > .env file > defaults.
 * `process.env` phải thắng .env file — shell env có thể override file.
 */
export function mergeEnvSources(
  processEnv: Record<string, string | undefined>,
  fromFile: Record<string, string>,
  overrides: Record<string, string>,
): Record<string, string | undefined> {
  return { ...fromFile, ...processEnv, ...overrides };
}

export function getEnv(overrides: Record<string, string> = {}): LoadTestEnv {
  if (cachedEnv && Object.keys(overrides).length === 0) return cachedEnv;
  const fromFile = loadDotEnv(LOADTEST_DIR);
  const env = mergeEnvSources(process.env, fromFile, overrides);

  const num = (key: string, def: number): number => {
    const v = env[key];
    if (v === undefined || v === '') return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };

  const allowlistRaw = (env.LOADTEST_ALLOWLIST ?? '').trim();
  const allowlist = allowlistRaw
    ? allowlistRaw.split(',').map((s) => normalizeUrl(s)).filter(Boolean)
    : [normalizeUrl('http://localhost:3000')]; // dev-only mặc định (SEC-7): production phải set LOADTEST_ALLOWLIST tường minh

  const corsOriginsRaw = (env.LOADTEST_CORS_ORIGIN ?? '').trim();
  const corsOrigins = corsOriginsRaw
    ? corsOriginsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : ['http://localhost:5173']; // R-7: Vite proxy gửi origin Vite

  const configuredWorkers = num('LOADTEST_WORKERS', 0);
  const debug = parseBool(env.LOADTEST_DEBUG);
  const dbRequired = parseBool(env.LOADTEST_DB_REQUIRED, true); // Q-2: DB luôn bắt buộc

  if (debug) logEnvSources(process.env, fromFile, overrides);

  const cfg: LoadTestEnv = {
    port: num('LOADTEST_PORT', 3401),
    host: env.LOADTEST_HOST || '127.0.0.1',
    allowlist,
    gatewayUrl: normalizeUrl(env.LOADTEST_GATEWAY_URL || 'http://localhost:3000'),
    otpSecret: env.LOADTEST_OTP_SECRET || '',
    authSecret: env.LOADTEST_AUTH_SECRET || '',
    redisUrl: env.LOADTEST_REDIS_URL || 'redis://localhost:6379',
    maxTarget: num('LOADTEST_MAX_TARGET', 200_000),
    maxDurationMin: num('LOADTEST_MAX_DURATION_MIN', 60),
    maxRegisterRamp: num('LOADTEST_MAX_REGISTER_RAMP', 100),
    workerCount: configuredWorkers,
    maxSocketsPerWorker: num('LOADTEST_MAX_SOCKETS_PER_WORKER', 10_000),
    maxPendingOutbox: num('LOADTEST_MAX_PENDING_OUTBOX', 1000),
    dataDir: env.LOADTEST_DATA_DIR || './loadtest/data',
    reportsDir: env.LOADTEST_REPORTS_DIR || './docs/loadtest-reports',
    poolFile: env.LOADTEST_POOL_FILE || '',
    databaseUrl: env.LOADTEST_DATABASE_URL || PLACEHOLDER_DB_URL,
    scrapeIntervalMs: num('LOADTEST_SCRAPE_METRICS_INTERVAL_MS', 5000),
    registerRamp: num('LOADTEST_REGISTER_RAMP', 100),
    fixturePostIds: (env.LOADTEST_FIXTURE_POST_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    communityId: env.LOADTEST_COMMUNITY_ID || '',
    debug,
    dbRequired,
    corsOrigins,
    allowRegister: parseBool(env.LOADTEST_ALLOW_REGISTER),
    rateLimitDisabled: parseBool(env.LOADTEST_RATE_LIMIT_DISABLED),
    rateLimitLoginFails: num('LOADTEST_RATE_LIMIT_LOGIN_FAILS', 5),
    rateLimitWindowMs: num('LOADTEST_RATE_LIMIT_WINDOW_MS', 60_000),
    rateLimitStartMs: num('LOADTEST_RATE_LIMIT_START_MS', 10_000),
    rateLimitWriteBucket: num('LOADTEST_RATE_LIMIT_WRITE_BUCKET', 0),
    trustProxy: parseBool(env.LOADTEST_TRUST_PROXY),
    shutdownTimeoutMs: num('LOADTEST_SHUTDOWN_TIMEOUT_MS', 10_000),
  };
  cachedEnv = cfg;
  return cfg;
}

// ─── Env fail-fast validation (T-03) ────────────────────────────────────────

export interface EnvProblem {
  key: string;
  message: string;
  severity: 'error' | 'warning';
}

/**
 * Validate env REQUIRED keys (T-03, Q-2). KHÔNG gọi trong getEnv() — worker.ts:11
 * gọi getEnv() trong child process không có DB/OTP; validate chỉ ở server.ts startup.
 * Strict khi: opts.production (NODE_ENV=production) HOẶC env.dbRequired (mặc định true).
 * Trả về danh sách vấn đề — caller (server.ts) log + exit khi có severity='error'.
 */
export function validateEnv(env: LoadTestEnv, opts: { production?: boolean } = {}): EnvProblem[] {
  const production = opts.production ?? process.env.NODE_ENV === 'production';
  const problems: EnvProblem[] = [];
  const err = (key: string, message: string) => problems.push({ key, message, severity: 'error' });
  const warn = (key: string, message: string) => problems.push({ key, message, severity: 'warning' });

  // LOADTEST_DATABASE_URL — bắt buộc khi dbRequired hoặc production (Q-2)
  if (env.dbRequired || production) {
    if (!env.databaseUrl || isKnownBadDbUrl(env.databaseUrl)) {
      err(
        'LOADTEST_DATABASE_URL',
        'bắt buộc cấu hình thật khi LOADTEST_DB_REQUIRED=true (hoặc production) — đang thiếu/placeholder/default credential',
      );
    }
  }
  if (env.databaseUrl && !/^postgres(ql)?:\/\//.test(env.databaseUrl)) {
    err('LOADTEST_DATABASE_URL', `phải bắt đầu bằng postgres:// hoặc postgresql:// (hiện: ${redactUrl(env.databaseUrl)}...)`);
  }

  // LOADTEST_OTP_SECRET — ≥ 32 ký tự (seed OTP register — E1)
  if (env.otpSecret && env.otpSecret.length < 32) {
    err('LOADTEST_OTP_SECRET', `phải ≥ 32 ký tự (hiện ${env.otpSecret.length})`);
  } else if (!env.otpSecret) {
    if (production) err('LOADTEST_OTP_SECRET', 'bắt buộc trong production (register sẽ fail — E1)');
    else warn('LOADTEST_OTP_SECRET', 'thiếu — register sẽ fail (cần set trong loadtest/.env)');
  }

  // LOADTEST_AUTH_SECRET — ≥ 32 ký tự; production bắt buộc (auth.ts fallback tự sinh chỉ dev)
  if (env.authSecret && env.authSecret.length < 32) {
    err('LOADTEST_AUTH_SECRET', `phải ≥ 32 ký tự (hiện ${env.authSecret.length})`);
  } else if (!env.authSecret) {
    if (production) err('LOADTEST_AUTH_SECRET', 'bắt buộc trong production (auth.ts fallback tự sinh chỉ dành cho dev)');
    else warn('LOADTEST_AUTH_SECRET', 'thiếu — sẽ dùng fallback tự sinh (dev-only)');
  }

  // LOADTEST_REDIS_URL — nếu set phải đúng prefix
  if (env.redisUrl && !/^redis(s)?:\/\//.test(env.redisUrl)) {
    err('LOADTEST_REDIS_URL', `phải bắt đầu bằng redis:// hoặc rediss:// (hiện: ${redactUrl(env.redisUrl)}...)`);
  }

  // LOADTEST_CORS_ORIGIN (SEC-1): chặn `*` (mở CORS cho mọi origin = ai cũng gọi API điều khiển
  // từ browser của họ) + entry rỗng. Mặc định http://localhost:5173 khi KHÔNG set.
  for (const origin of env.corsOrigins) {
    if (origin === '*') {
      err('LOADTEST_CORS_ORIGIN', 'CORS_ORIGIN không được phép là * — chỉ định origin cụ thể');
    } else if (!origin.trim()) {
      err('LOADTEST_CORS_ORIGIN', 'CORS_ORIGIN chứa origin rỗng — chỉ định origin cụ thể (ví dụ http://localhost:5173)');
    }
  }

  return problems;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Validate cấu hình run (bắt buộc trước mọi start). */
export function validateRunRequest(req: StartRunRequest, env: LoadTestEnv): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const gateway = normalizeUrl(req.gatewayUrl);
  if (!gateway) errors.push('gatewayUrl bắt buộc');
  else if (!env.allowlist.includes(gateway)) {
    errors.push(
      `Gateway ${gateway} KHÔNG nằm trong allowlist test. Chỉ được chạy: ${env.allowlist.join(', ')}`,
    );
  }

  if (!Number.isInteger(req.targetUsers) || req.targetUsers < 1000) {
    errors.push('targetUsers phải ≥ 1000');
  } else if (req.targetUsers > env.maxTarget) {
    errors.push(
      `targetUsers ${req.targetUsers} vượt giới hạn an toàn ${env.maxTarget} (preset 1M/10M cần cluster — v1.1). ` +
        `Override bằng LOADTEST_MAX_TARGET nếu thực sự có hạ tầng.`,
    );
  }

  if (!Number.isFinite(req.durationMin) || req.durationMin <= 0) {
    errors.push('durationMin phải > 0');
  } else if (req.durationMin > env.maxDurationMin) {
    errors.push(
      `durationMin ${req.durationMin} phút vượt tối đa ${env.maxDurationMin} phút (access token TTL 1h — PRD §5.3).`,
    );
  }

  if (!Number.isFinite(req.rampRate) || req.rampRate <= 0) {
    errors.push('rampRate phải > 0');
  } else if (req.rampRate > 2000) {
    warnings.push('rampRate > 2000/s có thể bão hòa event loop tool và matching engine (~100 user/s chat).');
  }

  const profile = req.profile;
  if (!profile) errors.push('profile bắt buộc');
  else {
    const sum = profile.chat + profile.read + profile.comment + profile.like + profile.view;
    if (Math.abs(sum - 100) > 0.001) {
      errors.push(`Tổng profile = ${sum}% — phải đúng 100%`);
    }
    if (profile.chat > 0 && req.targetUsers > 10_000) {
      // 10k chat user @ 100/s matching → ~100s seat; với target lớn cần thời gian
      const seatSec = req.targetUsers / 100;
      if (seatSec > req.durationMin * 60) {
        warnings.push(
          `Matching engine trần ~100 user/s: seat ${req.targetUsers} chat user mất ~${Math.ceil(seatSec / 60)} phút > duration.`,
        );
      }
    }
    for (const k of ['chat', 'read', 'comment', 'like', 'view'] as const) {
      if (!Number.isFinite(profile[k]) || profile[k] < 0) errors.push(`profile.${k} không hợp lệ`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Presets (CP-1): 1M/10M có warning hạ tầng; MVP mặc định 10k/50k/100k. */
export interface Preset {
  id: string;
  label: string;
  targetUsers: number;
  requiresCluster: boolean;
}

export const PRESETS: Preset[] = [
  { id: '10k', label: '10k', targetUsers: 10_000, requiresCluster: false },
  { id: '50k', label: '50k', targetUsers: 50_000, requiresCluster: false },
  { id: '100k', label: '100k', targetUsers: 100_000, requiresCluster: false },
  { id: '1M', label: '1M', targetUsers: 1_000_000, requiresCluster: true },
  { id: '10M', label: '10M', targetUsers: 10_000_000, requiresCluster: true },
];

export const DEFAULT_PROFILE: ActionProfile = { chat: 40, read: 30, comment: 20, like: 10, view: 0 };

/** Ước lượng hạ tầng cho UI (Màn 1 "ƯỚC LƯỢNG"). */
export function estimateInfra(targetUsers: number, _env: LoadTestEnv) {
  // ~2500 socket/worker cho stability (5k socket 1 process → GC pause > 5s → E3 kill)
  const workers = Math.min(Math.max(1, Math.ceil(targetUsers / 2_500)), 32);
  const ramGB = Math.ceil((targetUsers * 60 * 1024) / (1024 ** 3)); // ~60KB/socket (PRD §5.1)
  const seatMin = Math.ceil(targetUsers / 100 / 60); // matching ~100 user/s
  return { workers, ramGB, seatMin };
}

/** Resolve workerCount từ target nếu chưa cấu hình (auto). */
export function resolveWorkerCount(targetUsers: number, env: LoadTestEnv): number {
  if (env.workerCount > 0) return env.workerCount;
  const cpus = os.availableParallelism?.() ?? 4;
  // AUTO dùng ≤ 2500 users/worker (ổn định GC/heartbeat) — maxSocketsPerWorker chỉ là cap cứng.
  const perWorker = Math.min(env.maxSocketsPerWorker, 2_500);
  const byTarget = Math.ceil(targetUsers / perWorker);
  return Math.min(Math.max(1, Math.min(cpus - 1 || 1, byTarget)), 32);
}

// S-9/B-4: seed pid + counter để 2 run sau restart không trùng id (runSeq reset 0 mỗi restart).
const pidPart = (process.pid % 46656).toString(36).padStart(3, '0');
let runSeq = 0;

export function newRunId(): string {
  runSeq = (runSeq + 1) % 1296;
  const ts = Date.now().toString(36); // toàn bộ timestamp — không slice (B-4: slice(-6) wrap 25.2 ngày)
  return `lt${ts}${pidPart}${runSeq.toString(36).padStart(2, '0')}`;
}

/** Resolve RunConfig từ StartRunRequest (đã validate). */
export function buildRunConfig(req: StartRunRequest, env: LoadTestEnv): RunConfig {
  const workers = resolveWorkerCount(req.targetUsers, env);
  const socketsPerWorker = Math.ceil(req.targetUsers / workers);
  return {
    runId: newRunId(),
    targetUsers: req.targetUsers,
    rampRate: req.rampRate,
    rampMode: req.rampMode,
    durationMin: req.durationMin,
    durationSec: req.durationMin * 60,
    profile: { ...DEFAULT_PROFILE, ...req.profile },
    gatewayUrl: normalizeUrl(req.gatewayUrl),
    workerCount: workers,
    socketsPerWorker,
    registerRamp: Math.min(env.registerRamp, env.maxRegisterRamp),
    useExistingAccounts: !req.freshAccounts,
    freshAccounts: !!req.freshAccounts,
    seed: Date.now() % 1_000_000,
    createdAt: Date.now(),
  };
}

// ─── Settings file (allowlist bổ sung qua API Settings — SD-1) ─────────────

interface SettingsFile {
  allowlist: string[];
  updatedAt: number;
}

export function loadSettings(env: LoadTestEnv): SettingsFile {
  try {
    const p = path.join(env.dataDir, 'settings.json');
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8')) as SettingsFile;
    }
  } catch {
    // ignore
  }
  return { allowlist: [], updatedAt: 0 };
}

export function saveSettings(env: LoadTestEnv, s: SettingsFile) {
  fs.mkdirSync(env.dataDir, { recursive: true });
  fs.writeFileSync(path.join(env.dataDir, 'settings.json'), JSON.stringify(s, null, 2), 'utf8');
}

/** Allowlist thực tế = env allowlist + allowlist từ settings file (Màn 6). */
export function mergedAllowlist(env: LoadTestEnv): string[] {
  const settings = loadSettings(env);
  return [...new Set([...env.allowlist, ...settings.allowlist.map(normalizeUrl)])];
}
