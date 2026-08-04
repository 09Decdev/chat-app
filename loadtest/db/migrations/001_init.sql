-- =====================================================================
-- 001_init.sql — BASELINE schema (T-04)
-- -------------------------------------------------------------
-- Nguồn: loadtest/db/schema.sql (giữ nguyên làm reference — đừng xoá).
-- Migration này được sinh từ schema.sql; nếu sửa DDL, sửa CẢ 2 nơi
-- (hoặc khai báo migration mới 002_* với ADD COLUMN IF NOT EXISTS).
--
-- Quy ước migration file (runner loadtest/db/migrate.ts):
--   - Tên: NNN_name.sql (NNN 3 chữ số, sort tăng dần).
--   - Mỗi file = DDL thuần, KHÔNG PL/pgSQL có `;` nội bộ.
--   - Blocks `-- ==== UP ====` (apply) và `-- ==== DOWN ====` (rollback).
--   - 001 = baseline: `CREATE TABLE IF NOT EXISTS` (baseline-detect R-4 —
--     handle DB đã có bảng/thiếu cột), marker `-- startup-safe` (B-5 —
--     startup chỉ auto-apply 001, KHÔNG chạy migration destructive phía sau).
--   - Migration > 001 phải `ADD COLUMN IF NOT EXISTS` + có DOWN.
--
-- 7 bảng: admin_users, runs, pools, pool_accounts, metric_samples,
-- log_events, schema_version.
-- =====================================================================

-- ==== UP ====

-- Migration version (PRD §5.5 — runner đọc MAX(version) để quyết định pending)
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,           -- = 1
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- Admin accounts — dashboard quản trị (Module Admin Auth)
-- =====================================================================
CREATE TABLE IF NOT EXISTS admin_users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,        -- tên đăng nhập
  email         TEXT NOT NULL UNIQUE,        -- email đăng nhập/thứ 2
  password_hash TEXT NOT NULL,               -- scrypt$N$r$p$salt$hash (node:crypto)
  display_name  TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'admin', -- 'admin' | 'viewer' (Future)
  is_active     BOOLEAN NOT NULL DEFAULT TRUE, -- false = khóa tài khoản
  created_at    BIGINT NOT NULL,             -- epoch ms
  updated_at    BIGINT NOT NULL,             -- epoch ms
  last_login_at BIGINT                       -- epoch ms (null = chưa đăng nhập)
);

-- =====================================================================
-- Run registry — 1 hàng / run (Module A1)
-- =====================================================================
CREATE TABLE IF NOT EXISTS runs (
  run_id            TEXT PRIMARY KEY,        -- = PRD-old: runId
  status            TEXT NOT NULL,           -- running | finished | stopped | error
  machine_id        TEXT NOT NULL,           -- os.hostname() — phân biệt run giữa máy
  start_at          BIGINT NOT NULL,         -- epoch ms
  end_at            BIGINT,                  -- epoch ms (null khi đang chạy)
  duration_sec      INTEGER,                 -- = PRD-old: durationSec
  gateway_url       TEXT NOT NULL,           -- = PRD-old: gatewayUrl
  target_users      INTEGER NOT NULL,        -- = PRD-old: targetUsers
  worker_count      INTEGER NOT NULL,        -- = PRD-old: workerCount
  config_json       TEXT NOT NULL,           -- toàn bộ RunConfig (types.ts:33-49)
  summary_json      TEXT,                    -- summary + perAction + errors + bottlenecks (RunReport)
  stop_reason       TEXT,                    -- = PRD-old: stopReason
  pool_source_run_id TEXT,                   -- run cung cấp pool khi reuse (PRD-old: poolSourceRunId)
  created_at        BIGINT NOT NULL,         -- epoch ms
  updated_at        BIGINT NOT NULL          -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_runs_status   ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_start_at ON runs(start_at DESC);

-- =====================================================================
-- Account pool — 1 pool = 1 run tạo pool (Module B1)
-- =====================================================================
CREATE TABLE IF NOT EXISTS pools (
  pool_id              TEXT PRIMARY KEY,     -- = PRD-old: poolId (= runId tạo pool)
  gateway_url          TEXT NOT NULL,        -- = PRD-old: gatewayUrl
  target_users         INTEGER NOT NULL,     -- = PRD-old: targetUsers
  account_count        INTEGER NOT NULL DEFAULT 0,
  registered           INTEGER NOT NULL DEFAULT 0,
  logged_in            INTEGER NOT NULL DEFAULT 0,
  failed               INTEGER NOT NULL DEFAULT 0,
  errors_json          TEXT,                 -- Record<code,count> (PRD-old: errorsJson)
  reused_by_run_ids_json TEXT,               -- runId[] đã reuse pool này (PRD-old: reusedByRunIdsJson)
  imported_from_file   TEXT,                 -- đường dẫn file JSON legacy đã import
  created_at           BIGINT NOT NULL       -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_pools_gateway ON pools(gateway_url, target_users);

-- Per-account outcome — giải bug "reuse pool ghi log không đầy đủ"
-- (PRD-loadtest-run-database.md §1.9; auth-factory.ts:149-190)
CREATE TABLE IF NOT EXISTS pool_accounts (
  id               SERIAL PRIMARY KEY,
  pool_id          TEXT NOT NULL REFERENCES pools(pool_id) ON DELETE CASCADE,
  email            TEXT NOT NULL,            -- email tài khoản test
  password         TEXT NOT NULL,            -- bắt buộc để reuse login (auth-factory.ts:164-167)
  user_id          TEXT NOT NULL DEFAULT '', -- = PRD-old: userId
  display_name     TEXT NOT NULL DEFAULT '', -- = PRD-old: displayName
  device_info_json TEXT NOT NULL DEFAULT '{}', -- = PRD-old: deviceInfoJson
  date_of_birth    TEXT NOT NULL DEFAULT '', -- = PRD-old: dateOfBirth
  country          TEXT NOT NULL DEFAULT 'VN',
  registered_at    BIGINT,                   -- epoch ms
  status           TEXT NOT NULL DEFAULT 'registered', -- registered | logged_in | failed
  last_error_code  TEXT,                     -- TWO_FA_REQUIRED | LOGIN_FAIL | THROTTLED | ...
  last_used_run_id TEXT,                     -- = PRD-old: lastUsedRunId
  last_login_at    BIGINT,                   -- epoch ms
  UNIQUE (pool_id, email)
);
CREATE INDEX IF NOT EXISTS idx_pool_accounts_pool   ON pool_accounts(pool_id);
CREATE INDEX IF NOT EXISTS idx_pool_accounts_status ON pool_accounts(status);

-- =====================================================================
-- MetricSample — ticks 1s tổng hợp (Module A2; types.ts:139-168 LoadTestTick)
-- KHÔNG lưu WorkerTick thô (tránh nhân số lượng worker).
-- =====================================================================
CREATE TABLE IF NOT EXISTS metric_samples (
  id                    SERIAL PRIMARY KEY,
  run_id                TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  ts                    BIGINT NOT NULL,     -- epoch ms đầu giây
  phase                 TEXT NOT NULL,        -- provisioning | ramping | steady | cooldown
  elapsed_sec           INTEGER NOT NULL,     -- = PRD-old: elapsedSec
  -- counters (LoadTestTick.counters)
  users_created         INTEGER NOT NULL DEFAULT 0,
  users_connected       INTEGER NOT NULL DEFAULT 0,
  users_active          INTEGER NOT NULL DEFAULT 0,
  users_queued          INTEGER NOT NULL DEFAULT 0,
  users_in_room         INTEGER NOT NULL DEFAULT 0,
  actions_total         INTEGER NOT NULL DEFAULT 0,
  success_total         INTEGER NOT NULL DEFAULT 0,
  fail_total            INTEGER NOT NULL DEFAULT 0,
  echo_ok               INTEGER NOT NULL DEFAULT 0,
  echo_sent             INTEGER NOT NULL DEFAULT 0,
  queue_count           INTEGER NOT NULL DEFAULT 0,
  room_count            INTEGER NOT NULL DEFAULT 0,
  dropped_outbox        INTEGER NOT NULL DEFAULT 0,
  reconnect_count       INTEGER NOT NULL DEFAULT 0,
  rate_limited_no_echo  INTEGER NOT NULL DEFAULT 0,
  -- rates
  success_rate          DOUBLE PRECISION NOT NULL DEFAULT 0,
  echo_rate             DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- payload JSON
  actions_per_sec_json  TEXT NOT NULL DEFAULT '{}', -- Partial<Record<ActionType, number>>
  latency_json          TEXT NOT NULL DEFAULT '{}', -- { p50, p95, p99 }
  errors_json           TEXT NOT NULL DEFAULT '[]', -- [{ code, count }]
  server_json           TEXT NOT NULL DEFAULT '{}', -- { wsConnections, wsMessagesEmitted, wsMessagesPerSec }
  workers_json          TEXT NOT NULL DEFAULT '{}'  -- { alive, total, cpuAvg }
);
CREATE INDEX IF NOT EXISTS idx_metric_samples_run ON metric_samples(run_id, ts);

-- =====================================================================
-- LogEvent — log bền vững của từng run (Module C1)
-- =====================================================================
CREATE TABLE IF NOT EXISTS log_events (
  id      SERIAL PRIMARY KEY,
  run_id  TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  ts      BIGINT NOT NULL,                   -- epoch ms
  level   TEXT NOT NULL,                     -- info | warn | error
  msg     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_events_run ON log_events(run_id, ts);

-- ==== DOWN ====

-- Rollback (G-8): drop theo thứ tự đảo ngược phụ thuộc FK.
-- Bảng reference runs trước (metric_samples, log_events), rồi pool_accounts
-- (reference pools), rồi runs/pools, rồi schema_version/admin_users.
DROP TABLE IF EXISTS metric_samples;
DROP TABLE IF EXISTS log_events;
DROP TABLE IF EXISTS pool_accounts;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS pools;
DROP TABLE IF EXISTS schema_version;
DROP TABLE IF EXISTS admin_users;