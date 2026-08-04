/**
 * MAYogu LoadTest Tool — DB access layer (PostgreSQL qua pg driver thuần, không ORM).
 * Bảng: admin_users, runs, pools, pool_accounts, metric_samples, log_events, schema_version.
 *
 * Quy tắc (PRD-loadtest-run-database.md §2.4):
 * - Mọi write best-effort — lỗi DB KHÔNG làm chết run, retry tối đa 1 lần, log cảnh báo.
 * - Single-writer: chỉ coordinator ghi DB (worker không chạm DB).
 * - JSON payload lưu TEXT (schema.sql) — parse/stringify ở lớp này.
 */

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ltLog } from '../util';

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));

// pg trả BIGINT (int8, OID 20) dạng string — parse thành number (epoch ms / counter đều < 2^53, an toàn).
pg.types.setTypeParser(20, (v) => Number(v));

export interface AdminRow {
  id: number;
  username: string;
  email: string;
  passwordHash: string;
  displayName: string;
  role: string;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
}

export interface RunRow {
  runId: string;
  status: string;
  machineId: string;
  startAt: number;
  endAt: number | null;
  durationSec: number | null;
  gatewayUrl: string;
  targetUsers: number;
  workerCount: number;
  configJson: string;
  summaryJson: string | null;
  stopReason: string | null;
  poolSourceRunId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MetricSampleRow {
  runId: string;
  ts: number;
  phase: string;
  elapsedSec: number;
  usersCreated: number;
  usersConnected: number;
  usersActive: number;
  usersQueued: number;
  usersInRoom: number;
  actionsTotal: number;
  successTotal: number;
  failTotal: number;
  echoOk: number;
  echoSent: number;
  queueCount: number;
  roomCount: number;
  droppedOutbox: number;
  reconnectCount: number;
  rateLimitedNoEcho: number;
  successRate: number;
  echoRate: number;
  actionsPerSecJson: string;
  latencyJson: string;
  errorsJson: string;
  serverJson: string;
  workersJson: string;
}

export interface PoolRow {
  poolId: string;
  gatewayUrl: string;
  targetUsers: number;
  accountCount: number;
  registered: number;
  loggedIn: number;
  failed: number;
  errorsJson: string;
  reusedByRunIdsJson: string;
  importedFromFile: string | null;
  createdAt: number;
}

export interface PoolAccountRow {
  id: number;
  poolId: string;
  email: string;
  password: string;
  userId: string;
  displayName: string;
  deviceInfoJson: string;
  dateOfBirth: string;
  country: string;
  registeredAt: number | null;
  status: string;
  lastErrorCode: string | null;
  lastUsedRunId: string | null;
  lastLoginAt: number | null;
}

export interface LogEventRow {
  id: number;
  runId: string;
  ts: number;
  level: string;
  msg: string;
}

const RUN_COLUMNS = `run_id AS "runId", status, machine_id AS "machineId", start_at AS "startAt",
  end_at AS "endAt", duration_sec AS "durationSec", gateway_url AS "gatewayUrl",
  target_users AS "targetUsers", worker_count AS "workerCount", config_json AS "configJson",
  summary_json AS "summaryJson", stop_reason AS "stopReason", pool_source_run_id AS "poolSourceRunId",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

export class LoadtestStore {
  private pool: pg.Pool | null = null;
  enabled = false;

  constructor(private connectionString: string) {}

  async connect(): Promise<void> {
    try {
      this.pool = new pg.Pool({
        connectionString: this.connectionString,
        max: 5,
        connectionTimeoutMillis: 3000,
      });
      await this.pool.query('SELECT 1');
      this.enabled = true;
      ltLog.info('[lt][db] connected (Postgres)');
    } catch (err) {
      this.enabled = false;
      ltLog.warn(
        `[lt][db] KHÔNG kết nối được Postgres: ${err instanceof Error ? err.message : String(err)}. ` +
          `DB bị TẮT — run vẫn chạy, không ghi history.`,
      );
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end().catch(() => {});
      this.pool = null;
    }
    this.enabled = false;
  }

  /** Chạy schema.sql (idempotent — CREATE TABLE IF NOT EXISTS) + ghi schema_version 1. */
  async ensureSchema(): Promise<void> {
    if (!this.enabled || !this.pool) return;
    try {
      const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
      await this.pool.query(schema);
      await this.pool.query(`INSERT INTO schema_version (version) VALUES (1) ON CONFLICT (version) DO NOTHING`);
    } catch (err) {
      ltLog.warn(`[lt][db] ensureSchema fail: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Query helper — retry tối đa 1 lần (PRD §2.4), lỗi → trả [] + cảnh báo.
   *  Không retry lỗi nghiệp vụ (unique/FK violation — 23505/23503) vì retry chắc chắn fail. */
  private async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    if (!this.enabled || !this.pool) return [];
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await this.pool.query(sql, params);
        return res.rows as T[];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: string }).code ?? '';
        const isBusinessError = code === '23505' || code === '23503'; // unique / FK violation
        if (attempt === 1 && !isBusinessError) {
          ltLog.warn(`[lt][db] query fail (${msg}) — retry 1 lần`);
          continue;
        }
        if (attempt === 2) ltLog.warn(`[lt][db] query fail lần 2 — bỏ qua: ${msg}`);
        return [];
      }
    }
    return [];
  }

  // ─── admin_users ─────────────────────────────────────────────────────────

  async createAdmin(input: {
    username: string;
    email: string;
    passwordHash: string;
    displayName?: string;
    role?: string;
    now?: number;
  }): Promise<AdminRow | null> {
    const now = input.now ?? Date.now();
    const rows = await this.query<AdminRow>(
      `INSERT INTO admin_users (username, email, password_hash, display_name, role, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6, $6)
       RETURNING id, username, email, password_hash AS "passwordHash", display_name AS "displayName",
                 role, is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt",
                 last_login_at AS "lastLoginAt"`,
      [input.username, input.email, input.passwordHash, input.displayName ?? '', input.role ?? 'admin', now],
    );
    return rows[0] ?? null;
  }

  async findAdminByLogin(identifier: string): Promise<AdminRow | null> {
    const rows = await this.query<AdminRow>(
      `SELECT id, username, email, password_hash AS "passwordHash", display_name AS "displayName",
              role, is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt",
              last_login_at AS "lastLoginAt"
       FROM admin_users WHERE username = $1 OR email = $1 LIMIT 1`,
      [identifier],
    );
    return rows[0] ?? null;
  }

  async getAdminById(id: number): Promise<AdminRow | null> {
    const rows = await this.query<AdminRow>(
      `SELECT id, username, email, password_hash AS "passwordHash", display_name AS "displayName",
              role, is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt",
              last_login_at AS "lastLoginAt"
       FROM admin_users WHERE id = $1 LIMIT 1`,
      [id],
    );
    return rows[0] ?? null;
  }

  async touchLastLogin(id: number, now = Date.now()): Promise<void> {
    await this.query(`UPDATE admin_users SET last_login_at = $1, updated_at = $1 WHERE id = $2`, [now, id]);
  }

  // ─── runs ────────────────────────────────────────────────────────────────

  async insertRun(input: {
    runId: string;
    status: string;
    machineId: string;
    startAt: number;
    gatewayUrl: string;
    targetUsers: number;
    workerCount: number;
    configJson: string;
    poolSourceRunId?: string | null;
    now?: number;
  }): Promise<void> {
    const now = input.now ?? Date.now();
    await this.query(
      `INSERT INTO runs (run_id, status, machine_id, start_at, gateway_url, target_users, worker_count, config_json, pool_source_run_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [
        input.runId, input.status, input.machineId, input.startAt, input.gatewayUrl,
        input.targetUsers, input.workerCount, input.configJson, input.poolSourceRunId ?? null, now,
      ],
    );
  }

  async finalizeRun(
    runId: string,
    input: { status: string; stopReason?: string | null; summaryJson?: string | null; endAt: number; durationSec?: number | null },
  ): Promise<void> {
    await this.query(
      `UPDATE runs SET status = $1, stop_reason = $2, summary_json = $3, end_at = $4, duration_sec = $5, updated_at = $4
       WHERE run_id = $6`,
      [input.status, input.stopReason ?? null, input.summaryJson ?? null, input.endAt, input.durationSec ?? null, runId],
    );
  }

  /** Crash-detect (PRD B3): mọi run `running` còn sót của máy này → `error`. */
  async markRunsRunningAsError(machineId: string, reason: string): Promise<number> {
    const rows = await this.query<{ run_id: string }>(
      `UPDATE runs SET status = 'error', stop_reason = $1, updated_at = $2
       WHERE status = 'running' AND machine_id = $3
       RETURNING run_id`,
      [reason, Date.now(), machineId],
    );
    return rows.length;
  }

  async listRuns(filter?: { status?: string; limit?: number }): Promise<RunRow[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter?.status) {
      params.push(filter.status);
      where.push(`status = $${params.length}`);
    }
    const limit = Math.min(Math.max(1, filter?.limit ?? 500), 2000);
    const sql = `SELECT ${RUN_COLUMNS} FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY start_at DESC LIMIT ${limit}`;
    return this.query<RunRow>(sql, params);
  }

  async getRun(runId: string): Promise<RunRow | null> {
    const rows = await this.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = $1 LIMIT 1`, [runId]);
    return rows[0] ?? null;
  }

  /** Xóa run — FK ON DELETE CASCADE xóa luôn metric_samples + log_events. */
  async deleteRun(runId: string): Promise<boolean> {
    const rows = await this.query<{ run_id: string }>(`DELETE FROM runs WHERE run_id = $1 RETURNING run_id`, [runId]);
    return rows.length > 0;
  }

  // ─── metric_samples ──────────────────────────────────────────────────────

  async insertMetricSamples(samples: Omit<MetricSampleRow, 'id'>[]): Promise<void> {
    if (!samples.length) return;
    const cols = [
      'run_id', 'ts', 'phase', 'elapsed_sec', 'users_created', 'users_connected', 'users_active',
      'users_queued', 'users_in_room', 'actions_total', 'success_total', 'fail_total', 'echo_ok',
      'echo_sent', 'queue_count', 'room_count', 'dropped_outbox', 'reconnect_count',
      'rate_limited_no_echo', 'success_rate', 'echo_rate', 'actions_per_sec_json', 'latency_json',
      'errors_json', 'server_json', 'workers_json',
    ];
    const values: unknown[] = [];
    const placeholders: string[] = [];
    samples.forEach((s, i) => {
      const base = i * cols.length;
      placeholders.push(`(${cols.map((_, j) => `$${base + j + 1}`).join(', ')})`);
      values.push(
        s.runId, s.ts, s.phase, s.elapsedSec, s.usersCreated, s.usersConnected, s.usersActive,
        s.usersQueued, s.usersInRoom, s.actionsTotal, s.successTotal, s.failTotal, s.echoOk, s.echoSent,
        s.queueCount, s.roomCount, s.droppedOutbox, s.reconnectCount, s.rateLimitedNoEcho,
        s.successRate, s.echoRate, s.actionsPerSecJson, s.latencyJson, s.errorsJson, s.serverJson, s.workersJson,
      );
    });
    await this.query(`INSERT INTO metric_samples (${cols.join(', ')}) VALUES ${placeholders.join(', ')}`, values);
  }

  async listMetricSamples(runId: string, opts?: { limit?: number; offset?: number }): Promise<MetricSampleRow[]> {
    const limit = Math.min(Math.max(1, opts?.limit ?? 3600), 20000);
    const offset = Math.max(0, opts?.offset ?? 0);
    return this.query<MetricSampleRow>(
      `SELECT ts, phase, elapsed_sec AS "elapsedSec", users_created AS "usersCreated", users_connected AS "usersConnected",
              users_active AS "usersActive", users_queued AS "usersQueued", users_in_room AS "usersInRoom",
              actions_total AS "actionsTotal", success_total AS "successTotal", fail_total AS "failTotal",
              echo_ok AS "echoOk", echo_sent AS "echoSent", queue_count AS "queueCount", room_count AS "roomCount",
              dropped_outbox AS "droppedOutbox", reconnect_count AS "reconnectCount",
              rate_limited_no_echo AS "rateLimitedNoEcho", success_rate AS "successRate", echo_rate AS "echoRate",
              actions_per_sec_json AS "actionsPerSecJson", latency_json AS "latencyJson", errors_json AS "errorsJson",
              server_json AS "serverJson", workers_json AS "workersJson"
       FROM metric_samples WHERE run_id = $1 ORDER BY ts ASC LIMIT $2 OFFSET $3`,
      [runId, limit, offset],
    );
  }

  async countMetricSamples(runId: string): Promise<number> {
    const rows = await this.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM metric_samples WHERE run_id = $1`, [runId]);
    return rows[0]?.n ?? 0;
  }

  // ─── log_events ──────────────────────────────────────────────────────────

  async insertLogEvent(runId: string, level: string, msg: string, ts = Date.now()): Promise<void> {
    await this.query(`INSERT INTO log_events (run_id, ts, level, msg) VALUES ($1, $2, $3, $4)`, [runId, ts, level, msg]);
  }

  async listLogEvents(runId: string, opts?: { limit?: number; offset?: number; level?: string }): Promise<LogEventRow[]> {
    const where: string[] = [`run_id = $1`];
    const params: unknown[] = [runId];
    if (opts?.level) {
      params.push(opts.level);
      where.push(`level = $${params.length}`);
    }
    const limit = Math.min(Math.max(1, opts?.limit ?? 200), 500);
    const offset = Math.max(0, opts?.offset ?? 0);
    return this.query<LogEventRow>(
      `SELECT id, run_id AS "runId", ts, level, msg FROM log_events
       WHERE ${where.join(' AND ')} ORDER BY ts ASC, id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
  }

  // ─── pools ───────────────────────────────────────────────────────────────

  async upsertPool(input: {
    poolId: string;
    gatewayUrl: string;
    targetUsers: number;
    accountCount: number;
    registered: number;
    loggedIn: number;
    failed: number;
    errorsJson: string;
    reusedByRunIdsJson: string;
    importedFromFile?: string | null;
    createdAt?: number;
  }): Promise<void> {
    await this.query(
      `INSERT INTO pools (pool_id, gateway_url, target_users, account_count, registered, logged_in, failed, errors_json, reused_by_run_ids_json, imported_from_file, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (pool_id) DO UPDATE SET
         account_count = EXCLUDED.account_count,
         registered = EXCLUDED.registered,
         logged_in = EXCLUDED.logged_in,
         failed = EXCLUDED.failed,
         errors_json = EXCLUDED.errors_json,
         reused_by_run_ids_json = EXCLUDED.reused_by_run_ids_json,
         imported_from_file = COALESCE(pools.imported_from_file, EXCLUDED.imported_from_file)`,
      [
        input.poolId, input.gatewayUrl, input.targetUsers, input.accountCount, input.registered,
        input.loggedIn, input.failed, input.errorsJson, input.reusedByRunIdsJson,
        input.importedFromFile ?? null, input.createdAt ?? Date.now(),
      ],
    );
  }

  async getPool(poolId: string): Promise<PoolRow | null> {
    const rows = await this.query<PoolRow>(
      `SELECT pool_id AS "poolId", gateway_url AS "gatewayUrl", target_users AS "targetUsers",
              account_count AS "accountCount", registered, logged_in AS "loggedIn", failed,
              errors_json AS "errorsJson", reused_by_run_ids_json AS "reusedByRunIdsJson",
              imported_from_file AS "importedFromFile", created_at AS "createdAt"
       FROM pools WHERE pool_id = $1 LIMIT 1`,
      [poolId],
    );
    return rows[0] ?? null;
  }

  async listPools(): Promise<PoolRow[]> {
    return this.query<PoolRow>(
      `SELECT pool_id AS "poolId", gateway_url AS "gatewayUrl", target_users AS "targetUsers",
              account_count AS "accountCount", registered, logged_in AS "loggedIn", failed,
              errors_json AS "errorsJson", reused_by_run_ids_json AS "reusedByRunIdsJson",
              imported_from_file AS "importedFromFile", created_at AS "createdAt"
       FROM pools ORDER BY created_at DESC`,
    );
  }

  // ─── pool_accounts ───────────────────────────────────────────────────────

  async insertPoolAccounts(
    accounts: {
      poolId: string;
      email: string;
      password: string;
      userId: string;
      displayName: string;
      deviceInfo: unknown;
      dateOfBirth: string;
      country: string;
      registeredAt?: number | null;
      status: string;
      lastErrorCode?: string | null;
      lastUsedRunId?: string | null;
      lastLoginAt?: number | null;
    }[],
  ): Promise<void> {
    if (!accounts.length) return;
    const cols = [
      'pool_id', 'email', 'password', 'user_id', 'display_name', 'device_info_json', 'date_of_birth',
      'country', 'registered_at', 'status', 'last_error_code', 'last_used_run_id', 'last_login_at',
    ];
    const values: unknown[] = [];
    const placeholders: string[] = [];
    accounts.forEach((a, i) => {
      const base = i * cols.length;
      placeholders.push(`(${cols.map((_, j) => `$${base + j + 1}`).join(', ')})`);
      values.push(
        a.poolId, a.email, a.password, a.userId, a.displayName, JSON.stringify(a.deviceInfo ?? {}),
        a.dateOfBirth, a.country, a.registeredAt ?? null, a.status, a.lastErrorCode ?? null,
        a.lastUsedRunId ?? null, a.lastLoginAt ?? null,
      );
    });
    await this.query(
      `INSERT INTO pool_accounts (${cols.join(', ')}) VALUES ${placeholders.join(', ')} ON CONFLICT (pool_id, email) DO NOTHING`,
      values,
    );
  }

  async updatePoolAccount(
    poolId: string,
    email: string,
    input: { status?: string; lastErrorCode?: string | null; lastUsedRunId?: string | null; lastLoginAt?: number | null },
  ): Promise<void> {
    await this.query(
      `UPDATE pool_accounts SET status = COALESCE($1, status), last_error_code = $2, last_used_run_id = $3, last_login_at = COALESCE($4, last_login_at)
       WHERE pool_id = $5 AND email = $6`,
      [input.status ?? null, input.lastErrorCode ?? null, input.lastUsedRunId ?? null, input.lastLoginAt ?? null, poolId, email],
    );
  }

  async listPoolAccounts(poolId: string, opts?: { limit?: number; offset?: number; status?: string }): Promise<PoolAccountRow[]> {
    const where: string[] = [`pool_id = $1`];
    const params: unknown[] = [poolId];
    if (opts?.status) {
      params.push(opts.status);
      where.push(`status = $${params.length}`);
    }
    const limit = Math.min(Math.max(1, opts?.limit ?? 200), 500);
    const offset = Math.max(0, opts?.offset ?? 0);
    return this.query<PoolAccountRow>(
      `SELECT id, pool_id AS "poolId", email, password, user_id AS "userId", display_name AS "displayName",
              device_info_json AS "deviceInfoJson", date_of_birth AS "dateOfBirth", country,
              registered_at AS "registeredAt", status, last_error_code AS "lastErrorCode",
              last_used_run_id AS "lastUsedRunId", last_login_at AS "lastLoginAt"
       FROM pool_accounts WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
  }
}