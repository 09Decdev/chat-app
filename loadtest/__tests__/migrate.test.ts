/**
 * Integration tests — migration runner (loadtest/db/migrate.ts) trên Postgres
 * test riêng (`loadtest_test_migrate`, cùng instance postgres-loadtest port 5439).
 * Nếu không kết nối được DB → suite tự skip (CI chạy không cần Postgres).
 *
 * Test (G-8): up trên DB trống → 7 bảng + schema_version=1; up lại → idempotent
 * + không xoá dữ liệu cũ (R-4); down → version 0; up→down→up → 0 lỗi, schema
 * khôi phục đúng; status in đúng.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import { runMigrations, rollbackOne, migrationStatus, loadMigrations, parseSteps } from '../db/migrate';

const TEST_DB_URL =
  process.env.LOADTEST_TEST_MIGRATE_DATABASE_URL || 'postgresql://appuser:secret@localhost:5439/loadtest_test_migrate';

const EXPECTED_TABLES = [
  'admin_users',
  'log_events',
  'metric_samples',
  'pool_accounts',
  'pools',
  'runs',
  'schema_version',
];

const DROP_ALL = `DROP TABLE IF EXISTS metric_samples, log_events, pool_accounts, runs, pools, schema_version, admin_users CASCADE`;

// Probe DB tại module load (top-level await) — nếu không lên được thì skip toàn bộ suite.
let dbAvailable = false;
try {
  const probe = new pg.Client({ connectionString: TEST_DB_URL, connectionTimeoutMillis: 3000 });
  await probe.connect();
  await probe.query(DROP_ALL);
  await probe.end();
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

const describeDb = dbAvailable ? describe : describe.skip;

async function openClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: TEST_DB_URL });
  await client.connect();
  return client;
}

/** Reset DB về trạng thái trống (drop toàn bộ bảng migrations tạo ra). */
async function resetDb(): Promise<void> {
  const client = await openClient();
  try {
    await client.query(DROP_ALL);
  } finally {
    await client.end();
  }
}

async function listTables(client: pg.Client): Promise<string[]> {
  const res = await client.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  return res.rows.map((r) => r.table_name as string).sort();
}

/** Version hiện tại — tạo bảng schema_version nếu thiếu (giống runner, sau khi down bảng mất). */
async function currentVersion(client: pg.Client): Promise<number> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  );
  const res = await client.query(`SELECT COALESCE(MAX(version), 0) AS v FROM schema_version`);
  return Number(res.rows[0]?.v ?? 0);
}

describeDb('migrate — runner', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    // Khôi phục baseline — để DB test luôn có schema nếu tool khác dùng chung.
    const client = await openClient();
    try {
      await runMigrations(client, { scope: 'all' });
    } finally {
      await client.end();
    }
  });

  it('loadMigrations parse 001_init.sql thành công (UP + DOWN blocks)', () => {
    const migrations = loadMigrations();
    expect(migrations.length).toBe(1);
    expect(migrations[0].filename).toBe('001_init.sql');
    expect(migrations[0].version).toBe(1);
    expect(migrations[0].up).toContain('CREATE TABLE IF NOT EXISTS runs');
    expect(migrations[0].down).toContain('DROP TABLE IF EXISTS metric_samples');
  });

  it('up trên DB trống → 7 bảng + schema_version=1', async () => {
    const client = await openClient();
    try {
      const res = await runMigrations(client, { scope: 'all' });
      expect(res.applied).toEqual(['001_init.sql']);
      expect(await listTables(client)).toEqual(EXPECTED_TABLES);
      expect(await currentVersion(client)).toBe(1);
    } finally {
      await client.end();
    }
  });

  it('up lại → idempotent, không lỗi, version giữ 1', async () => {
    const client = await openClient();
    try {
      await runMigrations(client, { scope: 'all' });
      const res = await runMigrations(client, { scope: 'all' });
      expect(res.applied).toEqual([]); // không có gì pending
      expect(await currentVersion(client)).toBe(1);
    } finally {
      await client.end();
    }
  });

  it('up lại không xoá dữ liệu cũ (R-4 — baseline detect)', async () => {
    const client = await openClient();
    try {
      await runMigrations(client, { scope: 'all' });
      await client.query(
        `INSERT INTO runs (run_id, status, machine_id, start_at, gateway_url, target_users, worker_count, config_json, created_at, updated_at)
         VALUES ('lt-keep', 'finished', 'm', 1, 'http://localhost:3000', 1000, 1, '{}', 1, 1)`,
      );
      const res = await runMigrations(client, { scope: 'all' }); // up lại
      expect(res.applied).toEqual([]);
      const runs = await client.query(`SELECT run_id FROM runs WHERE run_id = 'lt-keep'`);
      expect(runs.rows.length).toBe(1); // dữ liệu cũ không mất khi up lại
    } finally {
      await client.end();
    }
  });

  it('down → schema_version lùi 0', async () => {
    const client = await openClient();
    try {
      await runMigrations(client, { scope: 'all' });
      const res = await rollbackOne(client);
      expect(res.rolledBack).toEqual(['001_init.sql']);
      expect(await currentVersion(client)).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('up → down → up trên DB test: 0 lỗi, schema_version + bảng khôi phục đúng', async () => {
    const client = await openClient();
    try {
      await runMigrations(client, { scope: 'all' }); // up
      await rollbackOne(client); // down — drop bảng (G-8 chấp nhận)
      expect(await currentVersion(client)).toBe(0);
      const res = await runMigrations(client, { scope: 'all' }); // up lại
      expect(res.applied).toEqual(['001_init.sql']);
      expect(await currentVersion(client)).toBe(1);
      expect(await listTables(client)).toEqual(EXPECTED_TABLES);
    } finally {
      await client.end();
    }
  });

  it('baseline scope (startup) — áp dụng 001, không lỗi; chạy lại no-op', async () => {
    const client = await openClient();
    try {
      await runMigrations(client, { scope: 'baseline' });
      expect(await currentVersion(client)).toBe(1);
      const res = await runMigrations(client, { scope: 'baseline' });
      expect(res.applied).toEqual([]);
    } finally {
      await client.end();
    }
  });

  it('migrationStatus in đúng version + pending', async () => {
    const client = await openClient();
    try {
      await runMigrations(client, { scope: 'all' });
      const st = await migrationStatus(client);
      expect(st.applied).toBe(1);
      expect(st.pending).toEqual([]);
    } finally {
      await client.end();
    }
  });
});

// ─── CLI arg validation (FIX-5, T-04) — KHÔNG cần Postgres ───────────────────

describe('migrate — parseSteps (CLI --steps N)', () => {
  it('không có --steps → 1', () => {
    expect(parseSteps(['down'])).toBe(1);
  });
  it('--steps N hợp lệ (≥ 1) → N', () => {
    expect(parseSteps(['down', '--steps', '3'])).toBe(3);
  });
  it('--steps 0 → throw (không im lặng coerce về 1)', () => {
    expect(() => parseSteps(['down', '--steps', '0'])).toThrow(/số nguyên ≥ 1/);
  });
  it('--steps abc → throw', () => {
    expect(() => parseSteps(['down', '--steps', 'abc'])).toThrow(/số nguyên ≥ 1/);
  });
  it('--steps -2 → throw', () => {
    expect(() => parseSteps(['down', '--steps', '-2'])).toThrow(/số nguyên ≥ 1/);
  });
  it('--steps 2.5 → throw (không phải số nguyên)', () => {
    expect(() => parseSteps(['down', '--steps', '2.5'])).toThrow(/số nguyên ≥ 1/);
  });
});