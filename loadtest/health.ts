/**
 * MAYogu LoadTest Tool — health endpoint (T-07, US-OBS-1).
 *
 * `GET /api/loadtest/health` → `{ status, db, redis, workers, version, uptimeSec, timestamp }`.
 * - DB down → `status:'degraded'|'down'`, db:'down' — KHÔNG 500, KHÔNG 'ok' giả (US-OBS-1).
 * - Redis down → `status:'degraded'|'down'`, redis:'down'.
 * - Redis không cấu hình (LOADTEST_REDIS_URL='') → redis:'disabled' — KHÔNG tính vào status.
 * - status rule (T-07 FIX-2): 'down' khi DB bắt buộc (dbRequired) và down, HOẶC khi db+redis cùng down;
 *   'degraded' khi 1 trong db/redis/workers down; 'ok' khi tất cả up (workers idle không tính).
 * - workers phản ánh aliveness thật (FIX-2): idle khi không run; running khi run + ≥1 worker alive;
 *   down khi run đang chạy nhưng 0 worker alive.
 * - `createHealthProbe` cache kết quả probe db/redis 10s (không đấm DB mỗi lần gọi — DESIGN §5.3).
 *   workers/uptime luôn tính mới từng call (phase đổi mỗi giây).
 */

import pkg from '../package.json';
import type { RunPhase } from './types';
import type { LoadTestCoordinator } from './coordinator';
import type { LoadtestStore } from './db/store';

export const LOADTEST_VERSION: string = pkg.version ?? '0.1.0';

export interface HealthDeps {
  store?: { enabled(): boolean; probe(): Promise<boolean>; required?(): boolean };
  coordinator: { phase: RunPhase; workerAlive: number };
  redis?: { configured(): boolean; ping(): Promise<boolean> };
  version: string;
  startedAt: number;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  db: 'up' | 'down';
  redis: 'up' | 'down' | 'disabled';
  workers: 'idle' | 'running' | 'down';
  version: string;
  uptimeSec: number;
  timestamp: number;
}

const RUNNING_PHASES: readonly RunPhase[] = ['provisioning', 'ramping', 'steady', 'cooldown', 'report'];

/** Probe db: 'up'/'down' — KHÔNG bao giờ throw (FIX-1: probe bắt lỗi, trả 'down'). */
async function probeDb(store: HealthDeps['store']): Promise<'up' | 'down'> {
  if (!store) return 'down';
  if (!store.enabled()) return 'down';
  try {
    return (await store.probe()) ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

/** Probe redis: 'up'/'down'/'disabled' — không cấu hình → 'disabled' (FIX-2, không tính vào status).
   *  ping() trả boolean (false = down) HOẶC throw — check cả 2 (FIX-2: không 'up' giả khi ping resolve false). */
async function probeRedis(redis: HealthDeps['redis']): Promise<'up' | 'down' | 'disabled'> {
  if (!redis || !redis.configured()) return 'disabled';
  try {
    const up = await redis.ping();
    return up ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

/** Workers phản ánh aliveness thật (FIX-2): idle khi không run; running khi run + ≥1 worker; down khi run + 0 worker. */
function deriveWorkers(phase: RunPhase, workerAlive: number): HealthReport['workers'] {
  if (!RUNNING_PHASES.includes(phase)) return 'idle';
  return workerAlive > 0 ? 'running' : 'down';
}

/** status rule (FIX-2): 'down' khi DB bắt buộc + down, hoặc db+redis cùng down; 'degraded' khi 1 trong 3 down; else 'ok'. */
export function computeHealthStatus(input: {
  db: 'up' | 'down';
  redis: 'up' | 'down' | 'disabled';
  workers: 'idle' | 'running' | 'down';
  dbRequired: boolean;
}): HealthReport['status'] {
  const dbDown = input.db === 'down';
  const redisDown = input.redis === 'down';
  const workersDown = input.workers === 'down';
  if ((input.dbRequired && dbDown) || (dbDown && redisDown)) return 'down';
  if (dbDown || redisDown || workersDown) return 'degraded';
  return 'ok';
}

/** Build health report từ deps — probe db/redis thật (không cache). */
export async function buildHealth(deps: HealthDeps): Promise<HealthReport> {
  const db = await probeDb(deps.store);
  const redis = await probeRedis(deps.redis);
  const workers = deriveWorkers(deps.coordinator.phase, deps.coordinator.workerAlive);
  const dbRequired = deps.store?.required?.() ?? false;
  const status = computeHealthStatus({ db, redis, workers, dbRequired });

  return {
    status,
    db,
    redis,
    workers,
    version: deps.version,
    uptimeSec: Math.max(0, Math.round((Date.now() - deps.startedAt) / 1000)),
    timestamp: Date.now(),
  };
}

/**
 * Health probe có cache 10s (DESIGN §5.3) — db/redis probe chậm, không gọi mỗi lần.
 * workers/uptime/version/timestamp luôn tính mới (phase đổi mỗi giây).
 */
export function createHealthProbe(deps: () => HealthDeps, ttlMs = 10_000): () => Promise<HealthReport> {
  let cache: { at: number; db: 'up' | 'down'; redis: 'up' | 'down' | 'disabled' } | null = null;

  return async () => {
    const d = deps();
    const now = Date.now();
    if (!cache || now - cache.at >= ttlMs) {
      const db = await probeDb(d.store);
      const redis = await probeRedis(d.redis);
      cache = { at: now, db, redis };
    }
    const workers = deriveWorkers(d.coordinator.phase, d.coordinator.workerAlive);
    const dbRequired = d.store?.required?.() ?? false;
    const status = computeHealthStatus({ db: cache.db, redis: cache.redis, workers, dbRequired });
    return {
      status,
      db: cache.db,
      redis: cache.redis,
      workers,
      version: d.version,
      uptimeSec: Math.max(0, Math.round((now - d.startedAt) / 1000)),
      timestamp: now,
    };
  };
}

/** Build deps từ coordinator + store (route handler dùng). */
export function healthDepsFrom(
  coordinator: LoadTestCoordinator,
  store: LoadtestStore | undefined,
  startedAt: number,
): HealthDeps {
  return {
    store: store
      ? { enabled: () => store.enabled, probe: () => store.probe(), required: () => store.dbRequired }
      : undefined,
    coordinator: { phase: coordinator.phase, workerAlive: coordinator.workerAlive },
    redis: { configured: () => coordinator.redisConfigured, ping: () => coordinator.redisHealth() },
    version: LOADTEST_VERSION,
    startedAt,
  };
}