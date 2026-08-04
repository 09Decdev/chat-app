/**
 * MAYogu LoadTest Tool — migration runner (zero-dep, T-04).
 *
 * Quy ước migration file (loadtest/db/migrations/):
 *   - Tên: NNN_name.sql (NNN = 3 chữ số, sort tăng dần) — VD 001_init.sql.
 *   - Mỗi file = DDL thuần, KHÔNG PL/pgSQL có `;` nội bộ (statement chạy
 *     trong 1 client.query — simple query protocol, không param).
 *   - Blocks đánh dấu: `-- ==== UP ====` (apply) và `-- ==== DOWN ====`
 *     (rollback) — case-insensitive. Thiếu marker hoặc section rỗng → throw (R-1).
 *   - 001 = baseline: `CREATE TABLE IF NOT EXISTS` (baseline-detect R-4),
 *     marker `-- startup-safe` (B-5). Migration > 001 phải `ADD COLUMN IF NOT EXISTS`.
 *
 * Version tracking: bảng `schema_version` (version INTEGER PRIMARY KEY) —
 * runner tự tạo nếu thiếu (R-4, DB trống/bảng mất). applied = MAX(version).
 * Mỗi migration chạy trong transaction (BEGIN/COMMIT — lỗi → ROLLBACK + throw).
 * Concurrency guard: `pg_advisory_lock(hashtext('loadtest_migrations'))`.
 *
 * CLI (tsx loadtest/db/migrate.ts <up|down|status> [--steps N]):
 *   up       — apply mọi pending (scope 'all')
 *   down     — rollback 1 bước (hoặc --steps N)
 *   status   — in schema_version + danh sách pending
 *
 * R-1: KHÔNG nuốt lỗi — mọi failure throw; CLI exit code ≠ 0.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { getEnv, PLACEHOLDER_DB_URL } from '../config';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

const UP_RE = /^--\s*====\s*UP\s*====/i;
const DOWN_RE = /^--\s*====\s*DOWN\s*====/i;

export interface Migration {
  version: number;
  name: string;
  filename: string;
  up: string;
  down: string;
}

/** Client tối thiểu — pg.Client / PoolClient checkout từ pg.Pool / Db adapter đều hợp lệ. */
export interface MigrationClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

// ─── Migration file parsing ────────────────────────────────────────────────

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  if (!fs.existsSync(dir)) throw new Error(`Migrations dir không tồn tại: ${dir}`);
  const files = fs.readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  if (files.length === 0) throw new Error(`Không có migration nào trong ${dir}`);
  return files.map((f) => parseMigrationFile(dir, f));
}

function parseMigrationFile(dir: string, filename: string): Migration {
  const content = fs.readFileSync(path.join(dir, filename), 'utf8');
  const lines = content.split(/\r?\n/);
  const upIdx = lines.findIndex((l) => UP_RE.test(l));
  const downIdx = lines.findIndex((l) => DOWN_RE.test(l));
  if (upIdx === -1) throw new Error(`Migration ${filename}: thiếu marker '-- ==== UP ===='`);
  if (downIdx === -1) throw new Error(`Migration ${filename}: thiếu marker '-- ==== DOWN ===='`);
  if (downIdx <= upIdx) throw new Error(`Migration ${filename}: marker DOWN phải nằm sau UP`);
  const up = lines.slice(upIdx + 1, downIdx).join('\n').trim();
  const down = lines.slice(downIdx + 1).join('\n').trim();
  if (!up) throw new Error(`Migration ${filename}: UP section rỗng`);
  if (!down) throw new Error(`Migration ${filename}: DOWN section rỗng`);
  const m = /^(\d{3})_(.+)\.sql$/.exec(filename);
  if (!m) throw new Error(`Migration ${filename}: tên phải theo dạng NNN_name.sql`);
  return { version: Number(m[1]), name: m[2], filename, up, down };
}

// ─── Version tracking ──────────────────────────────────────────────────────

async function ensureVersionTable(client: MigrationClient): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version    INTEGER PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
}

async function getAppliedVersion(client: MigrationClient): Promise<number> {
  await ensureVersionTable(client);
  const res = await client.query(`SELECT COALESCE(MAX(version), 0) AS v FROM schema_version`);
  return Number(res.rows[0]?.v ?? 0);
}

// ─── Apply / rollback ──────────────────────────────────────────────────────

export interface RunMigrationsOptions {
  /**
   * 'baseline' (startup — B-5): chỉ đảm bảo 001, KHÔNG tự chạy migration
   * destructive phía sau; còn pending > 1 → fail-fast throw.
   * 'all' (CLI up): apply mọi pending.
   */
  scope?: 'baseline' | 'all';
}

export async function runMigrations(
  client: MigrationClient,
  opts: RunMigrationsOptions = {},
): Promise<{ applied: string[] }> {
  const scope = opts.scope ?? 'all';
  const migrations = loadMigrations();
  await client.query(`SELECT pg_advisory_lock(hashtext('loadtest_migrations'))`);
  try {
    const applied = await getAppliedVersion(client);
    const pending = migrations.filter((m) => m.version > applied);
    const done: string[] = [];

    if (scope === 'baseline') {
      const baseline = pending[0];
      if (baseline && baseline.version === 1) {
        await applyOne(client, baseline);
        done.push(baseline.filename);
      }
      const current = applied + done.length;
      const stillPending = migrations.filter((m) => m.version > current);
      if (stillPending.length > 0) {
        throw new Error(
          `Startup chỉ chạy baseline (B-5) — còn pending migration: ${stillPending
            .map((m) => m.filename)
            .join(', ')}. Chạy 'npm run loadtest:db:up' trước khi start.`,
        );
      }
    } else {
      for (const m of pending) {
        await applyOne(client, m);
        done.push(m.filename);
      }
    }
    return { applied: done };
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('loadtest_migrations'))`).catch(() => {});
  }
}

async function applyOne(client: MigrationClient, m: Migration): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(m.up);
    await client.query(`INSERT INTO schema_version (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`, [m.version]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

export interface RollbackOptions {
  /** Số bước rollback (mặc định 1). */
  steps?: number;
}

export async function rollbackOne(
  client: MigrationClient,
  opts: RollbackOptions = {},
): Promise<{ rolledBack: string[] }> {
  const steps = Math.max(1, Math.floor(opts.steps ?? 1));
  const migrations = loadMigrations();
  await client.query(`SELECT pg_advisory_lock(hashtext('loadtest_migrations'))`);
  try {
    const applied = await getAppliedVersion(client);
    const appliedMigrations = migrations.filter((m) => m.version <= applied);
    const toRollback = appliedMigrations.slice(-steps).reverse();
    const rolledBack: string[] = [];
    for (const m of toRollback) {
      await client.query('BEGIN');
      try {
        // DELETE version TRƯỚC khi chạy DOWN — DOWN drop schema_version chính nó.
        await client.query(`DELETE FROM schema_version WHERE version = $1`, [m.version]);
        await client.query(m.down);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
      rolledBack.push(m.filename);
    }
    return { rolledBack };
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('loadtest_migrations'))`).catch(() => {});
  }
}

export async function migrationStatus(
  client: MigrationClient,
): Promise<{ applied: number; pending: string[] }> {
  const migrations = loadMigrations();
  const applied = await getAppliedVersion(client);
  return { applied, pending: migrations.filter((m) => m.version > applied).map((m) => m.filename) };
}

// ─── CLI ───────────────────────────────────────────────────────────────────

/** Export cho unit test. `--steps N` phải là số nguyên ≥ 1 — sai → throw (FIX-5, T-04). */
export function parseSteps(args: string[]): number {
  const i = args.indexOf('--steps');
  if (i === -1) return 1;
  const raw = args[i + 1];
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--steps phải là số nguyên ≥ 1 (nhận: ${raw === undefined ? '(thiếu giá trị)' : JSON.stringify(raw)})`);
  }
  return n;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || !['up', 'down', 'status'].includes(cmd)) {
    console.error('Usage: npx tsx loadtest/db/migrate.ts <up|down|status> [--steps N]');
    process.exit(1);
  }
  const env = getEnv();
  if (!env.databaseUrl || env.databaseUrl === PLACEHOLDER_DB_URL) {
    console.error(
      '[lt][db] LOADTEST_DATABASE_URL chưa được cấu hình (placeholder). Set giá trị thật trong loadtest/.env',
    );
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: env.databaseUrl, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    if (cmd === 'up') {
      const res = await runMigrations(client, { scope: 'all' });
      console.log(
        `[lt][db] up: ${res.applied.length ? `applied ${res.applied.join(', ')}` : 'không có migration pending — đã up-to-date'}`,
      );
    } else if (cmd === 'down') {
      const res = await rollbackOne(client, { steps: parseSteps(args) });
      console.log(
        `[lt][db] down: ${res.rolledBack.length ? `rolled back ${res.rolledBack.join(', ')}` : 'không có gì để rollback'}`,
      );
    } else {
      const res = await migrationStatus(client);
      console.log(`[lt][db] status: schema_version=${res.applied}`);
      console.log(`[lt][db] pending: ${res.pending.length ? res.pending.join(', ') : '(none)'}`);
    }
  } finally {
    await client.end();
  }
}

// CLI entry — chỉ chạy khi execute trực tiếp (không phải khi import làm library).
const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`[lt][db] migrate fail: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}