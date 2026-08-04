/**
 * MAYogu LoadTest Tool — retention script (D-9, T-04).
 *
 * Xoá dữ liệu cũ hơn N ngày — thủ công, KHÔNG chạy nền (không setInterval).
 *
 *   npx tsx loadtest/db/cleanup.ts --older-than 30d
 *   npx tsx loadtest/db/cleanup.ts --older-than 12h
 *   npx tsx loadtest/db/cleanup.ts --older-than 1440m
 *
 * Phạm vi:
 *   - runs start_at < cutoff && status <> 'running' — cascade xoá
 *     metric_samples + log_events (FK ON DELETE CASCADE, schema.sql).
 *   - pools created_at < cutoff — cascade xoá pool_accounts.
 *   - KHÔNG đụng admin_users, KHÔNG đụng run đang chạy.
 *
 * Env: LOADTEST_DATABASE_URL (bắt buộc — placeholder → exit 1).
 */

import pg from 'pg';
import { getEnv, PLACEHOLDER_DB_URL } from '../config';

function parseOlderThan(args: string[]): number {
  const i = args.indexOf('--older-than');
  if (i === -1) throw new Error('Thiếu --older-than N (VD: --older-than 30d, 12h, 60m)');
  const raw = args[i + 1];
  if (!raw) throw new Error(`Thiếu giá trị --older-than (VD: --older-than 30d)`);
  const m = /^(\d+)([dhms])?$/.exec(raw);
  if (!m) throw new Error(`--older-than không hợp lệ: ${raw} (VD: 30d, 12h, 60m)`);
  const n = Number(m[1]);
  const unit = m[2] ?? 'd'; // mặc định ngày
  const mult: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
  return n * mult[unit];
}

function formatMs(ms: number): string {
  const days = ms / 86_400_000;
  if (days >= 1) return `${days}d`;
  const hours = ms / 3_600_000;
  if (hours >= 1) return `${hours}h`;
  return `${ms / 60_000}m`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const olderThan = parseOlderThan(args);
  const env = getEnv();
  if (!env.databaseUrl || env.databaseUrl === PLACEHOLDER_DB_URL) {
    console.error(
      '[lt][db] LOADTEST_DATABASE_URL chưa được cấu hình (placeholder). Set giá trị thật trong loadtest/.env',
    );
    process.exit(1);
  }
  const cutoff = Date.now() - olderThan;
  const client = new pg.Client({ connectionString: env.databaseUrl, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    // FIX-6 (T-04): 2 DELETE trong 1 transaction — fail giữa chừng → ROLLBACK,
    // không để orphaned rows (runs xoá rồi nhưng pools còn sót).
    await client.query('BEGIN');
    let runs: { rowCount: number | null };
    let pools: { rowCount: number | null };
    try {
      const r = await client.query(
        `DELETE FROM runs WHERE start_at < $1 AND status <> 'running' RETURNING run_id`,
        [cutoff],
      );
      const p = await client.query(`DELETE FROM pools WHERE created_at < $1 RETURNING pool_id`, [cutoff]);
      await client.query('COMMIT');
      runs = r;
      pools = p;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
    console.log(
      `[lt][db] cleanup older-than ${formatMs(olderThan)} (cutoff=${new Date(cutoff).toISOString()}): ` +
        `xoá ${runs.rowCount ?? 0} run (cascade metric_samples + log_events), ${pools.rowCount ?? 0} pool (cascade pool_accounts)`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(`[lt][db] cleanup fail: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});