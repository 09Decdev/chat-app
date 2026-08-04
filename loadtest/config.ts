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
import { normalizeUrl, parseBool, ltLog } from './util';

/** loadtest/ dir (ESM-safe). */
export const LOADTEST_DIR = fileURLToPath(new URL('.', import.meta.url));

export interface LoadTestEnv {
  port: number;
  /** Host API điều khiển — mặc định 127.0.0.1 (không expose ra ngoài máy). */
  host: string;
  allowlist: string[]; // gateway URLs được phép chạy (normalized http)
  gatewayUrl: string;
  otpSecret: string;
  redisUrl: string;
  maxTarget: number;
  maxDurationMin: number;
  maxRegisterRamp: number;
  workerCount: number; // 0 = auto
  maxSocketsPerWorker: number;
  maxPendingOutbox: number;
  dataDir: string;
  reportsDir: string;
  databaseUrl: string;
  scrapeIntervalMs: number;
  registerRamp: number;
  /** Nội dung tĩnh cho REST driver: postId fixtures (rỗng → driver tự bỏ qua POST create). */
  fixturePostIds: string[];
  /** Tên phòng chat test (matching không cần — server tự tạo). */
  debug: boolean;
}

function loadDotEnv(dir: string): Record<string, string> {
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

export function getEnv(overrides: Record<string, string> = {}): LoadTestEnv {
  if (cachedEnv && Object.keys(overrides).length === 0) return cachedEnv;
  const fromFile = loadDotEnv(LOADTEST_DIR);
  const env = { ...process.env, ...fromFile, ...overrides };

  const num = (key: string, def: number): number => {
    const v = env[key];
    if (v === undefined || v === '') return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };

  const allowlistRaw = (env.LOADTEST_ALLOWLIST ?? '').trim();
  const allowlist = allowlistRaw
    ? allowlistRaw.split(',').map((s) => normalizeUrl(s)).filter(Boolean)
    : [normalizeUrl('http://localhost:3000')]; // dev-only mặc định

  const configuredWorkers = num('LOADTEST_WORKERS', 0);

  const cfg: LoadTestEnv = {
    port: num('LOADTEST_PORT', 3401),
    host: env.LOADTEST_HOST || '127.0.0.1',
    allowlist,
    gatewayUrl: normalizeUrl(env.LOADTEST_GATEWAY_URL || 'http://localhost:3000'),
    otpSecret: env.LOADTEST_OTP_SECRET || '',
    redisUrl: env.LOADTEST_REDIS_URL || 'redis://localhost:6379',
    maxTarget: num('LOADTEST_MAX_TARGET', 200_000),
    maxDurationMin: num('LOADTEST_MAX_DURATION_MIN', 60),
    maxRegisterRamp: num('LOADTEST_MAX_REGISTER_RAMP', 100),
    workerCount: configuredWorkers,
    maxSocketsPerWorker: num('LOADTEST_MAX_SOCKETS_PER_WORKER', 10_000),
    maxPendingOutbox: num('LOADTEST_MAX_PENDING_OUTBOX', 1000),
    dataDir: env.LOADTEST_DATA_DIR || './loadtest/data',
    reportsDir: env.LOADTEST_REPORTS_DIR || './docs/loadtest-reports',
    databaseUrl: env.LOADTEST_DATABASE_URL || 'postgresql://appuser:secret@localhost:5439/loadtest',
    scrapeIntervalMs: num('LOADTEST_SCRAPE_METRICS_INTERVAL_MS', 5000),
    registerRamp: num('LOADTEST_REGISTER_RAMP', 100),
    fixturePostIds: (env.LOADTEST_FIXTURE_POST_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    debug: parseBool(env.LOADTEST_DEBUG),
  };
  cachedEnv = cfg;
  return cfg;
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
export function estimateInfra(targetUsers: number, env: LoadTestEnv) {
  const workers = Math.min(Math.max(1, Math.ceil(targetUsers / 10_000)), 32);
  const ramGB = Math.ceil((targetUsers * 60 * 1024) / (1024 ** 3)); // ~60KB/socket (PRD §5.1)
  const seatMin = Math.ceil(targetUsers / 100 / 60); // matching ~100 user/s
  return { workers, ramGB, seatMin };
}

/** Resolve workerCount từ target nếu chưa cấu hình (auto). */
export function resolveWorkerCount(targetUsers: number, env: LoadTestEnv): number {
  if (env.workerCount > 0) return env.workerCount;
  const cpus = os.availableParallelism?.() ?? 4;
  const byTarget = Math.ceil(targetUsers / env.maxSocketsPerWorker);
  return Math.min(Math.max(1, Math.min(cpus - 1 || 1, byTarget)), 32);
}

let runSeq = 0;

export function newRunId(): string {
  runSeq += 1;
  const ts = Date.now().toString(36).slice(-6);
  return `lt${ts}${runSeq.toString(36).padStart(2, '0')}`;
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
