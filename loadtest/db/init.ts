/**
 * MAYogu LoadTest Tool — khởi tạo PostgreSQL database (schema + seed admin mặc định).
 *
 * Chạy từ repo root (chat-app/):
 *   npx tsx loadtest/db/init.ts                # mở DB + tạo schema + in danh sách bảng
 *   npx tsx loadtest/db/init.ts --seed-admin   # + seed admin mặc định (BẮT BUỘC LOADTEST_ADMIN_PASSWORD)
 *   npx tsx loadtest/db/init.ts --verify       # chỉ mở DB + in bảng + số hàng (không tạo schema)
 *
 * Driver: pg (Postgres). Cần instance postgres-loadtest (port 5439, db `loadtest`).
 *
 * Env:
 *   LOADTEST_DATABASE_URL     — connection string (bắt buộc — placeholder mặc định không kết nối được)
 *   LOADTEST_ADMIN_USERNAME   — username admin seed (mặc định admin)
 *   LOADTEST_ADMIN_EMAIL      — email admin seed (mặc định admin@loadtest.local)
 *   LOADTEST_ADMIN_PASSWORD   — password admin seed (BẮT BUỘC khi --seed-admin — không phát sinh ngẫu nhiên
 *                               nữa: password tự sinh không in ra → admin seed tự khóa, không có recovery)
 *   LOADTEST_SEED_ADMIN=1     — tương đương --seed-admin
 */

import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { hashPassword } from './password';
import { loadDotEnv } from '../config';
import { redactUrl } from '../util';
import { runMigrations } from './migrate';

const LOADTEST_DIR = fileURLToPath(new URL('..', import.meta.url)); // …/loadtest/
const DEFAULT_DB_URL = 'postgresql://USER:PASS@HOST:PORT/DB'; // placeholder (C-2) — không có giá trị thật

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
  // Đọc loadtest/.env (giống config.ts) — init.ts chạy standalone không qua getEnv().
  const fromFile = loadDotEnv(LOADTEST_DIR);
  const connectionString = process.env.LOADTEST_DATABASE_URL || fromFile.LOADTEST_DATABASE_URL || DEFAULT_DB_URL;
  if (connectionString === DEFAULT_DB_URL) {
    console.error(
      '[lt][db] LOADTEST_DATABASE_URL chưa được cấu hình — đang dùng placeholder (không kết nối được). ' +
        'Set giá trị thật, VD: postgresql://USER:PASS@HOST:PORT/DB',
    );
    process.exit(1);
  }
  const seedAdmin = args.includes('--seed-admin') || process.env.LOADTEST_SEED_ADMIN === '1';
  const verifyOnly = args.includes('--verify');

  const db = await openDb(connectionString);
  try {
    if (!verifyOnly) {
      // T-04: dùng migration runner thay vì đọc schema.sql trực tiếp.
      const migrationClient = {
        query: async (sql: string, params?: unknown[]) => {
          const rows = await db.query(sql, params);
          return { rows };
        },
      };
      await runMigrations(migrationClient, { scope: 'all' });
      console.log(`[lt][db] Schema applied: ${redactUrl(connectionString)}`);
    } else {
      console.log(`[lt][db] Verify mode — không tạo schema: ${redactUrl(connectionString)}`);
    }

    if (seedAdmin) {
      const username = process.env.LOADTEST_ADMIN_USERNAME || 'admin';
      const email = process.env.LOADTEST_ADMIN_EMAIL || 'admin@loadtest.local';
      const existing = await db.query<{ id: number }>(
        `SELECT id FROM admin_users WHERE username = $1 OR email = $2`,
        [username, email],
      );
      if (existing.length === 0) {
        // Fail-fast (không phát sinh ngẫu nhiên): password tự sinh không bao giờ được in ra
        // → admin seed tự khóa, không có recovery. Bắt buộc env LOADTEST_ADMIN_PASSWORD.
        const password = process.env.LOADTEST_ADMIN_PASSWORD || fromFile.LOADTEST_ADMIN_PASSWORD;
        if (!password) {
          console.error(
            '[lt][db] --seed-admin cần LOADTEST_ADMIN_PASSWORD (set trong loadtest/.env hoặc env shell) — ' +
              'password phát sinh ngẫu nhiên không in ra, admin seed sẽ tự khóa (không có recovery).',
          );
          process.exit(1);
        }
        const now = Date.now();
        await db.query(
          `INSERT INTO admin_users (username, email, password_hash, display_name, role, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'admin', TRUE, $5, $5)`,
          [username, email, hashPassword(password), 'LoadTest Admin', now],
        );
        console.log(`[lt][db] Seeded admin: username=${username} email=${email} (password từ LOADTEST_ADMIN_PASSWORD)`);
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