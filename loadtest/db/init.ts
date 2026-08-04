/**
 * MAYogu LoadTest Tool — khởi tạo PostgreSQL database (schema + seed admin mặc định).
 *
 * Chạy từ repo root (chat-app/):
 *   npx tsx loadtest/db/init.ts                # mở DB + tạo schema + in danh sách bảng
 *   npx tsx loadtest/db/init.ts --seed-admin   # + seed admin mặc định (password phát sinh, in 1 lần)
 *   npx tsx loadtest/db/init.ts --verify       # chỉ mở DB + in bảng + số hàng (không tạo schema)
 *
 * Driver: pg (Postgres). Cần instance postgres-loadtest (port 5439, db `loadtest`).
 *
 * Env:
 *   LOADTEST_DATABASE_URL     — connection string (mặc định postgresql://appuser:secret@localhost:5439/loadtest)
 *   LOADTEST_ADMIN_USERNAME   — username admin seed (mặc định admin)
 *   LOADTEST_ADMIN_EMAIL      — email admin seed (mặc định admin@loadtest.local)
 *   LOADTEST_ADMIN_PASSWORD   — password admin seed (mặc định: phát sinh ngẫu nhiên, in ra console)
 *   LOADTEST_SEED_ADMIN=1     — tương đương --seed-admin
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { hashPassword } from './password';

const LOADTEST_DIR = fileURLToPath(new URL('..', import.meta.url)); // …/loadtest/
const DEFAULT_DB_URL = 'postgresql://appuser:secret@localhost:5439/loadtest';
const SCHEMA_PATH = path.join(LOADTEST_DIR, 'db', 'schema.sql');

/** Cửa sổ giao diện DB tối thiểu — vừa đủ cho schema + seed + verify. */
interface Db {
  exec(sql: string): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T[]>;
  close(): Promise<void>;
}

async function openDb(connectionString: string): Promise<Db> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  return {
    exec: async (sql: string) => {
      await client.query(sql);
    },
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => {
      const res = await client.query(sql, params);
      return res.rows as T[];
    },
    close: async () => {
      await client.end();
    },
  };
}

/** Password admin seed: env LOADTEST_ADMIN_PASSWORD hoặc phát sinh ngẫu nhiên (~16 ký tự). */
function genAdminPassword(): string {
  if (process.env.LOADTEST_ADMIN_PASSWORD) return process.env.LOADTEST_ADMIN_PASSWORD;
  return crypto.randomBytes(12).toString('base64url');
}

async function listTables(db: Db): Promise<{ name: string }[]> {
  return db.query<{ name: string }>(
    `SELECT table_name AS name
       FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name`,
  );
}

async function printVerify(db: Db): Promise<void> {
  const tables = await listTables(db);
  console.log(`[lt][db] Tables (${tables.length}):`);
  for (const t of tables) {
    const rows = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM "${t.name}"`,
    );
    console.log(`  - ${t.name}: ${rows[0]?.n ?? 0} rows`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const connectionString = process.env.LOADTEST_DATABASE_URL || DEFAULT_DB_URL;
  const seedAdmin = args.includes('--seed-admin') || process.env.LOADTEST_SEED_ADMIN === '1';
  const verifyOnly = args.includes('--verify');

  const db = await openDb(connectionString);
  try {
    if (!verifyOnly) {
      const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
      await db.exec(schema);
      await db.exec(`INSERT INTO schema_version (version) VALUES (1) ON CONFLICT (version) DO NOTHING`);
      console.log(`[lt][db] Schema applied: ${connectionString}`);
    } else {
      console.log(`[lt][db] Verify mode — không tạo schema: ${connectionString}`);
    }

    if (seedAdmin) {
      const username = process.env.LOADTEST_ADMIN_USERNAME || 'admin';
      const email = process.env.LOADTEST_ADMIN_EMAIL || 'admin@loadtest.local';
      const existing = await db.query<{ id: number }>(
        `SELECT id FROM admin_users WHERE username = $1 OR email = $2`,
        [username, email],
      );
      if (existing.length === 0) {
        const password = genAdminPassword();
        const now = Date.now();
        await db.query(
          `INSERT INTO admin_users (username, email, password_hash, display_name, role, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'admin', TRUE, $5, $5)`,
          [username, email, hashPassword(password), 'LoadTest Admin', now],
        );
        console.log(`[lt][db] Seeded admin: username=${username} email=${email}`);
        console.log(`[lt][db] PASSWORD (dev local only — lưu ở nơi an toàn): ${password}`);
      } else {
        console.log(`[lt][db] Admin ${username} hoặc email ${email} đã tồn tại — bỏ qua seed.`);
      }
    }

    await printVerify(db);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(`[lt][db] init fail: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});