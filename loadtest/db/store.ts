/**
 * MAYogu LoadTest Tool — DB access layer (PostgreSQL qua pg driver thuần, không ORM).
 * Bảng: admin_users, runs, pools, pool_accounts, metric_samples, log_events, schema_version.
 *
 * Quy tắc (PRD-loadtest-run-database.md §2.4):
 * - Mọi write best-effort — lỗi DB KHÔNG làm chết run, retry tối đa 1 lần, log cảnh báo.
 * - Single-writer: chỉ coordinator ghi DB (worker không chạm DB).
 * - JSON payload lưu TEXT (schema.sql) — parse/stringify ở lớp này.
 *
 * T-05 (D-5/D-6/D-7/D-10, Q-2):
 * - `query<T>` trả `QueryResult<T>` = `{ ok: true; rows } | { ok: false; error }` —
 *   caller phân biệt "no rows" vs "DB fail" (không trả 0 giả).
 * - Retry ≥ 1 chỉ cho transient error; KHÔNG retry 23505/23503/22P02 (business error).
 * - B-1: QueryError KHÔNG bao giờ chứa sql/params/raw pg error (chống leak
 *   password/secret/hash — insertPoolAccounts/createAdmin).
 * - Bỏ global int8 type parser (OID 20) — parse BIGINT ở biên qua `parseBigInt`
 *   (db/int.ts) cho đúng cột int8 (epoch ms, an toàn < 2^53).
 * - `connect()` fail + `dbRequired` → THROW (server fail-fast, exit ≠ 0).
 */

import pg from 'pg';
import { ltLog, sleep } from '../util';
import { runMigrations } from './migrate';
import { parseBigInt, isTransient, isBusinessError } from './int';
import { toolMetrics } from '../tool-metrics';
import type { QueryResult } from './result';

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

/** Cột int8 (BIGINT, OID 20) — pg trả string, parse ở biên qua parseBigInt. */
const BIGINT_FIELDS = new Set(['createdAt', 'updatedAt', 'lastLoginAt', 'startAt', 'endAt', 'registeredAt', 'ts']);

function normalizeBigIntRows<T>(rows: T[]): T[] {
  for (const row of rows as Array<Record<string, unknown>>) {
    for (const key of BIGINT_FIELDS) {
      const v = row[key];
      if ((typeof v === 'string' || typeof v === 'bigint') && key in row) {
        row[key] = parseBigInt(v);
      }
    }
  }
  return rows;
}

export class LoadtestStore {
  private pool: pg.Pool | null = null;
  enabled = false;

  constructor(
    private connectionString: string,
    /** Bắt buộc DB (Q-2) — connect() throw khi fail (server exit ≠ 0). */
    readonly dbRequired = false,
  ) {}

  async connect(): Promise<void> {
    this.pool = new pg.Pool({
      connectionString: this.connectionString,
      max: 5,
      connectionTimeoutMillis: 3000,
    });
    try {
      await this.pool.query('SELECT 1');
      this.enabled = true;
      ltLog.info('[lt][db] connected (Postgres)');
    } catch (err) {
      this.enabled = false;
      const msg = err instanceof Error ? err.message : String(err);
      if (this.dbRequired) {
        // Fail-fast (Q-2): DB là bắt buộc — throw để server.ts exit code ≠ 0.
        throw new Error(`Không kết nối được Postgres (LOADTEST_DB_REQUIRED=true): ${msg}`);
      }
      ltLog.warn(
        `[lt][db] KHÔNG kết nối được Postgres: ${msg}. DB bị TẮT — run vẫn chạy, không ghi history ` +
          `(LOADTEST_DB_REQUIRED=false — override khẩn cấp).`,
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

  /** Health probe (T-07 — health endpoint): SELECT 1, không đếm lỗi, trả boolean.
   *  FIX-1: query_timeout 2s — DB treo không thể làm /health stall mãi mãi. */
  async probe(): Promise<boolean> {
    if (!this.enabled || !this.pool) return false;
    try {
      // @types/pg thiếu query_timeout trong QueryConfig — runtime pg hỗ trợ (cast qua).
      const probeQ = { text: 'SELECT 1', query_timeout: 2000 } as unknown as pg.QueryConfig;
      await this.pool.query(probeQ);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Startup: đảm bảo baseline schema 001 (T-04, B-5) — KHÔNG tự chạy migration
   * destructive phía sau. Baseline fail → throw (R-1, server fail-fast — T-05).
   * IDEMPOTENT — DB đã có schema → no-op.
   */
  async ensureSchema(): Promise<void> {
    if (!this.enabled || !this.pool) return;
    const client = await this.pool.connect();
    try {
      await runMigrations(client, { scope: 'baseline' });
    } finally {
      client.release();
    }
  }

  /**
   * Query helper — trả QueryResult<T> (T-05). Retry ≥ 1 chỉ cho transient error
   * (isTransient); KHÔNG retry business error (23505/23503/22P02). B-1: error
   * KHÔNG chứa sql/params/raw pg error. Write fail → đếm dbWriteFail (US-DB-2).
   */
  private async query<T>(sql: string, params: unknown[] = [], opts: { write?: boolean } = {}): Promise<QueryResult<T>> {
    if (!this.enabled || !this.pool) {
      if (opts.write) toolMetrics.inc('dbWriteFail');
      return {
        ok: false,
        error: { code: 'DB_DISABLED', message: 'DB chưa kết nối', context: opts.write ? 'write' : 'read' },
      };
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await this.pool.query(sql, params);
        return { ok: true, rows: normalizeBigIntRows(res.rows) as T[] };
      } catch (err) {
        const code = (err as { code?: string }).code ?? '';
        const message = err instanceof Error ? err.message : String(err);
        if (!isTransient(code)) {
          // B-1: error chỉ { code, message, context } — không sql/params.
          if (opts.write && !isBusinessError(code)) toolMetrics.inc('dbWriteFail');
          ltLog.warn(`[lt][db] query fail (${code || 'UNKNOWN'}): ${message}`);
          return { ok: false, error: { code: code || undefined, message, context: opts.write ? 'write' : 'read' } };
        }
        toolMetrics.inc('dbRetry');
        if (attempt === 1) {
          ltLog.warn(`[lt][db] query transient fail (${code}) — retry 1 lần`);
          await sleep(100);
          continue;
        }
      }
    }
    if (opts.write) toolMetrics.inc('dbWriteFail');
    return { ok: false, error: { code: 'RETRY_EXHAUSTED', message: 'query fail 2 lần', context: opts.write ? 'write' : 'read' } };
  }

  // ─── admin_users ─────────────────────────────────────────────────────────

  async createAdmin(input: {
    username: string;
    email: string;
    passwordHash: string;
    displayName?: string;
    role?: string;
    now?: number;
  }): Promise<QueryResult<AdminRow>> {
    const now = input.now ?? Date.now();
    return this.query<AdminRow>(
      `INSERT INTO admin_users (username, email, password_hash, display_name, role, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, $6, $6)
       RETURNING id, username, email, password_hash AS "passwordHash", display_name AS "displayName",
                 role, is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt",
                 last_login_at AS "lastLoginAt"`,
      [input.username, input.email, input.passwordHash, input.displayName ?? '', input.role ?? 'admin', now],
      { write: true },
    );
  }

  async findAdminByLogin(identifier: string): Promise<QueryResult<AdminRow>> {
    return this.query<AdminRow>(
      `SELECT id, username, email, password_hash AS "passwordHash", display_name AS "displayName",
              role, is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt",
              last_login_at AS "lastLoginAt"
       FROM admin_users WHERE username = $1 OR email = $1 LIMIT 1`,
      [identifier],
    );
  }

  async getAdminById(id: number): Promise<QueryResult<AdminRow>> {
    return this.query<AdminRow>(
      `SELECT id, username, email, password_hash AS "passwordHash", display_name AS "displayName",
              role, is_active AS "isActive", created_at AS "createdAt", updated_at AS "updatedAt",
              last_login_at AS "lastLoginAt"
       FROM admin_users WHERE id = $1 LIMIT 1`,
      [id],
    );
  }

  async touchLastLogin(id: number, now = Date.now()): Promise<QueryResult<void>> {
    return this.query(`UPDATE admin_users SET last_login_at = $1, updated_at = $1 WHERE id = $2`, [now, id], {
      write: true,
    });
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
  }): Promise<QueryResult<void>> {
    const now = input.now ?? Date.now();
    return this.query(
      `INSERT INTO runs (run_id, status, machine_id, start_at, gateway_url, target_users, worker_count, config_json, pool_source_run_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [
        input.runId, input.status, input.machineId, input.startAt, input.gatewayUrl,
        input.targetUsers, input.workerCount, input.configJson, input.poolSourceRunId ?? null, now,
      ],
      { write: true },
    );
  }

  async finalizeRun(
    runId: string,
    input: { status: string; stopReason?: string | null; summaryJson?: string | null; endAt: number; durationSec?: number | null },
  ): Promise<QueryResult<void>> {
    return this.query(
      `UPDATE runs SET status = $1, stop_reason = $2, summary_json = $3, end_at = $4, duration_sec = $5, updated_at = $4
       WHERE run_id = $6`,
      [input.status, input.stopReason ?? null, input.summaryJson ?? null, input.endAt, input.durationSec ?? null, runId],
      { write: true },
    );
  }

  /** Crash-detect (PRD B3): mọi run `running` còn sót của máy này → `error`. */
  async markRunsRunningAsError(machineId: string, reason: string): Promise<QueryResult<{ run_id: string }>> {
    return this.query<{ run_id: string }>(
      `UPDATE runs SET status = 'error', stop_reason = $1, updated_at = $2
       WHERE status = 'running' AND machine_id = $3
       RETURNING run_id`,
      [reason, Date.now(), machineId],
      { write: true },
    );
  }

  async listRuns(filter?: { status?: string; limit?: number }): Promise<QueryResult<RunRow>> {
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

  async getRun(runId: string): Promise<QueryResult<RunRow>> {
    return this.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = $1 LIMIT 1`, [runId]);
  }

  /** Xóa run — FK ON DELETE CASCADE xóa luôn metric_samples + log_events. */
  async deleteRun(runId: string): Promise<QueryResult<{ run_id: string }>> {
    return this.query<{ run_id: string }>(`DELETE FROM runs WHERE run_id = $1 RETURNING run_id`, [runId], {
      write: true,
    });
  }

  // ─── metric_samples ──────────────────────────────────────────────────────

  async insertMetricSamples(samples: Omit<MetricSampleRow, 'id'>[]): Promise<QueryResult<void>> {
    if (!samples.length) return { ok: true, rows: [] };
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
    return this.query(`INSERT INTO metric_samples (${cols.join(', ')}) VALUES ${placeholders.join(', ')}`, values, {
      write: true,
    });
  }

  async listMetricSamples(runId: string, opts?: { limit?: number; offset?: number }): Promise<QueryResult<MetricSampleRow>> {
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

  /** Đếm samples — KHÔNG trả 0 giả khi DB lỗi; caller phải check `ok` (D-6). */
  async countMetricSamples(runId: string): Promise<QueryResult<{ n: number }>> {
    return this.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM metric_samples WHERE run_id = $1`, [runId]);
  }

  // ─── log_events ──────────────────────────────────────────────────────────

  async insertLogEvent(runId: string, level: string, msg: string, ts = Date.now()): Promise<QueryResult<void>> {
    return this.query(`INSERT INTO log_events (run_id, ts, level, msg) VALUES ($1, $2, $3, $4)`, [runId, ts, level, msg], {
      write: true,
    });
  }

  async listLogEvents(runId: string, opts?: { limit?: number; offset?: number; level?: string }): Promise<QueryResult<LogEventRow>> {
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
  }): Promise<QueryResult<void>> {
    return this.query(
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
      { write: true },
    );
  }

  async getPool(poolId: string): Promise<QueryResult<PoolRow>> {
    return this.query<PoolRow>(
      `SELECT pool_id AS "poolId", gateway_url AS "gatewayUrl", target_users AS "targetUsers",
              account_count AS "accountCount", registered, logged_in AS "loggedIn", failed,
              errors_json AS "errorsJson", reused_by_run_ids_json AS "reusedByRunIdsJson",
              imported_from_file AS "importedFromFile", created_at AS "createdAt"
       FROM pools WHERE pool_id = $1 LIMIT 1`,
      [poolId],
    );
  }

  /**
   * Tìm pool tái sử dụng cho run — DB-based reuse (seed-accounts.ts).
   * Ưu tiên pool có account_count >= targetUsers (đủ dùng, mới nhất), nếu không có
   * thì lấy pool mới nhất của gateway (caller slice theo targetUsers; thiếu < 50% → register fallback).
   * Không có pool → ok:true, rows rỗng (caller phân biệt "no pool" vs "DB fail" — D-6).
   */
  async findPool(gatewayUrl: string, targetUsers: number): Promise<QueryResult<PoolRow>> {
    return this.query<PoolRow>(
      `SELECT pool_id AS "poolId", gateway_url AS "gatewayUrl", target_users AS "targetUsers",
              account_count AS "accountCount", registered, logged_in AS "loggedIn", failed,
              errors_json AS "errorsJson", reused_by_run_ids_json AS "reusedByRunIdsJson",
              imported_from_file AS "importedFromFile", created_at AS "createdAt"
       FROM pools WHERE gateway_url = $1
       ORDER BY (account_count >= $2) DESC, created_at DESC LIMIT 1`,
      [gatewayUrl, targetUsers],
    );
  }

  async listPools(): Promise<QueryResult<PoolRow>> {
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
  ): Promise<QueryResult<void>> {
    if (!accounts.length) return { ok: true, rows: [] };
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
    return this.query(
      `INSERT INTO pool_accounts (${cols.join(', ')}) VALUES ${placeholders.join(', ')} ON CONFLICT (pool_id, email) DO NOTHING`,
      values,
      { write: true },
    );
  }

  async updatePoolAccount(
    poolId: string,
    email: string,
    input: { status?: string; lastErrorCode?: string | null; lastUsedRunId?: string | null; lastLoginAt?: number | null },
  ): Promise<QueryResult<void>> {
    return this.query(
      `UPDATE pool_accounts SET status = COALESCE($1, status), last_error_code = $2, last_used_run_id = $3, last_login_at = COALESCE($4, last_login_at)
       WHERE pool_id = $5 AND email = $6`,
      [input.status ?? null, input.lastErrorCode ?? null, input.lastUsedRunId ?? null, input.lastLoginAt ?? null, poolId, email],
      { write: true },
    );
  }

  async listPoolAccounts(poolId: string, opts?: { limit?: number; offset?: number; status?: string }): Promise<QueryResult<PoolAccountRow>> {
    const where: string[] = [`pool_id = $1`];
    const params: unknown[] = [poolId];
    if (opts?.status) {
      params.push(opts.status);
      where.push(`status = $${params.length}`);
    }
    // Cap 100k — đủ tải toàn bộ pool seed cho reuse (target tối đa 200k); dashboard
    // phân trang vẫn dùng limit nhỏ (mặc định 200).
    const limit = Math.min(Math.max(1, opts?.limit ?? 200), 100_000);
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

  /**
   * Đánh dấu pool seed đã được 1 run reuse (DB-based reuse login):
   * - Append runId vào reused_by_run_ids_json (idempotent — không trùng).
   * - Cập nhật per-account last_used_run_id / last_login_at / status='logged_in'
   *   (outcome login thật của run được writePool ghi vào pool của run đó).
   */
  async markPoolReused(poolId: string, runId: string, now = Date.now()): Promise<QueryResult<void>> {
    const p = await this.query<PoolRow>(
      `SELECT pool_id AS "poolId", gateway_url AS "gatewayUrl", target_users AS "targetUsers",
              account_count AS "accountCount", registered, logged_in AS "loggedIn", failed,
              errors_json AS "errorsJson", reused_by_run_ids_json AS "reusedByRunIdsJson",
              imported_from_file AS "importedFromFile", created_at AS "createdAt"
       FROM pools WHERE pool_id = $1 LIMIT 1`,
      [poolId],
    );
    if (!p.ok) return { ok: false, error: p.error };
    if (!p.rows[0]) {
      return { ok: false, error: { code: 'POOL_NOT_FOUND', message: `pool ${poolId} không tồn tại`, context: 'write' } };
    }
    let reused: unknown;
    try {
      reused = JSON.parse(p.rows[0].reusedByRunIdsJson);
    } catch {
      reused = null;
    }
    const list = Array.isArray(reused) ? reused.filter((x): x is string => typeof x === 'string') : [];
    if (!list.includes(runId)) list.push(runId);
    const up = await this.query(`UPDATE pools SET reused_by_run_ids_json = $1 WHERE pool_id = $2`, [JSON.stringify(list), poolId], {
      write: true,
    });
    if (!up.ok) return up;
    return this.query(
      `UPDATE pool_accounts SET last_used_run_id = $1, last_login_at = $2, status = 'logged_in' WHERE pool_id = $3`,
      [runId, now, poolId],
      { write: true },
    );
  }
}