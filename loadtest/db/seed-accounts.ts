/**
 * MAYogu LoadTest Tool — seed account pool vào DB (1 lần, tái sử dụng nhiều run).
 *
 * CLI: npm run loadtest:seed-accounts -- <path> [--pool-id <id>] [--gateway-url <url>]
 *   - <path>: file JSON array `[{ email, password, displayName?, userId?, dateOfBirth?, country? }]`
 *     hoặc CSV `email,password[,displayName]` (dòng đầu là header; auto-detect theo .json/.csv).
 *   - Tạo pool mới (pool_id = `seed-<YYYYMMDDHHMMSS>-<rand4>`) hoặc upsert vào pool có sẵn
 *     (--pool-id). Re-seed idempotent: ON CONFLICT (pool_id, email) DO UPDATE password/status.
 *   - Password lưu PLAINTEXT trong DB (THREAT-MODEL D-8 — bắt buộc để reuse login);
 *     script KHÔNG bao giờ in password.
 *   - Reuse login khi start vẫn bị rate-limit bởi LOADTEST_REGISTER_RAMP (xem README).
 *
 * Run sau đó tìm pool này qua DB (auth-factory provisionAccounts → DbWriter.findPoolForRun).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { getEnv, PLACEHOLDER_DB_URL } from '../config';
import { genDateOfBirth, normalizeUrl } from '../util';

/** 1 account đầu vào (JSON/CSV) — trước khi sinh deviceInfo + ghi DB. */
export interface SeedAccountInput {
  email: string;
  password: string;
  displayName?: string;
  userId?: string;
  dateOfBirth?: string;
  country?: string;
}

// ─── Parser (pure — unit test không cần DB) ─────────────────────────────────

/** Parse nội dung file account theo extension (.json | .csv) — throw với message rõ ràng. */
export function parseAccountList(content: string, filename: string): SeedAccountInput[] {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.json') return parseJsonAccounts(content);
  if (ext === '.csv') return parseCsvAccounts(content);
  throw new Error(`File không hỗ trợ: ${filename} (chỉ .json hoặc .csv)`);
}

function parseJsonAccounts(content: string): SeedAccountInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`JSON không hợp lệ: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('JSON phải là mảng account [{ email, password, displayName?, ... }]');
  }
  return parsed.map((a, i) => validateAccount(a, i));
}

function parseCsvAccounts(content: string): SeedAccountInput[] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error('CSV rỗng — dòng đầu phải là header `email,password[,displayName]`');
  const splitCells = (l: string): string[] => l.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
  const header = splitCells(lines[0]);
  const emailIdx = header.indexOf('email');
  const passwordIdx = header.indexOf('password');
  if (emailIdx === -1 || passwordIdx === -1) {
    throw new Error(`CSV header phải chứa 'email' và 'password' (hiện: ${header.join(', ') || '(trống)'})`);
  }
  const displayNameIdx = header.indexOf('displayName');
  const out: SeedAccountInput[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCells(lines[i]);
    const email = cells[emailIdx]?.trim() ?? '';
    const password = cells[passwordIdx] ?? '';
    if (!email) throw new Error(`CSV dòng ${i + 1}: email rỗng`);
    if (!password) throw new Error(`CSV dòng ${i + 1}: password rỗng`);
    out.push({
      email,
      password,
      displayName: displayNameIdx >= 0 && cells[displayNameIdx] !== '' ? cells[displayNameIdx] : undefined,
    });
  }
  return out;
}

function validateAccount(raw: unknown, index: number): SeedAccountInput {
  if (typeof raw !== 'object' || raw === null) throw new Error(`Account #${index + 1} không phải object`);
  const a = raw as Record<string, unknown>;
  const email = a.email;
  const password = a.password;
  if (typeof email !== 'string' || email.trim() === '') {
    throw new Error(`Account #${index + 1}: email bắt buộc (string không rỗng)`);
  }
  if (typeof password !== 'string' || password === '') {
    throw new Error(`Account #${index + 1}: password bắt buộc (string không rỗng)`);
  }
  const opt = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  return {
    email: email.trim(),
    password, // không trim — password có thể chứa space ở đầu/cuối
    displayName: opt(a.displayName),
    userId: opt(a.userId),
    dateOfBirth: opt(a.dateOfBirth),
    country: opt(a.country),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** deviceInfo hợp lệ với DTO gateway (deviceInfo.dto.ts) — login reuse không bị reject. */
function genSeedDeviceInfo(): {
  installationId: string;
  deviceFingerprint: string;
  platform: 'web';
  deviceName: string;
} {
  return {
    installationId: crypto.randomUUID(),
    // randomBytes(32).toString('hex') = 64 hex — khớp SHA256_REGEX deviceInfo.dto.ts:33
    deviceFingerprint: crypto.randomBytes(32).toString('hex'),
    platform: 'web',
    deviceName: 'seed',
  };
}

function formatTs(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function rand4(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// ─── CLI ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fileArg = args[0];
  if (!fileArg || fileArg.startsWith('--')) {
    console.error('Usage: npm run loadtest:seed-accounts -- <path.json|csv> [--pool-id <id>] [--gateway-url <url>]');
    process.exit(1);
  }
  const flagValue = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const poolIdArg = flagValue('--pool-id');
  const gatewayUrl = normalizeUrl(flagValue('--gateway-url') || 'http://localhost:3000');

  if (!fs.existsSync(fileArg)) {
    console.error(`[lt][seed] File không tồn tại: ${fileArg}`);
    process.exit(1);
  }
  let content: string;
  try {
    content = fs.readFileSync(fileArg, 'utf8');
  } catch (err) {
    console.error(`[lt][seed] Đọc file fail: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  let accounts: SeedAccountInput[];
  try {
    accounts = parseAccountList(content, fileArg);
  } catch (err) {
    console.error(`[lt][seed] Parse fail: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (accounts.length === 0) {
    console.error('[lt][seed] Không có account nào trong file');
    process.exit(1);
  }

  const env = getEnv();
  if (!env.databaseUrl || env.databaseUrl === PLACEHOLDER_DB_URL) {
    console.error(
      '[lt][seed] LOADTEST_DATABASE_URL chưa được cấu hình (placeholder). Set giá trị thật trong loadtest/.env',
    );
    process.exit(1);
  }

  const poolId = poolIdArg ?? `seed-${formatTs(new Date())}-${rand4()}`;
  const client = new pg.Client({ connectionString: env.databaseUrl, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
  } catch (err) {
    console.error(`[lt][seed] Không kết nối được Postgres: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  try {
    const now = Date.now();
    // Upsert pool — re-seed cập nhật gateway/target/count, KHÔNG reset reused history.
    await client.query(
      `INSERT INTO pools (pool_id, gateway_url, target_users, account_count, registered, logged_in, failed, errors_json, reused_by_run_ids_json, imported_from_file, created_at)
       VALUES ($1, $2, $3, $3, $3, 0, 0, '{}', '[]', NULL, $4)
       ON CONFLICT (pool_id) DO UPDATE SET
         gateway_url = EXCLUDED.gateway_url,
         target_users = EXCLUDED.target_users,
         account_count = EXCLUDED.account_count,
         registered = EXCLUDED.registered`,
      [poolId, gatewayUrl, accounts.length, now],
    );

    // Multi-row INSERT — ON CONFLICT (pool_id, email) DO UPDATE (idempotent re-seed).
    const cols = ['pool_id', 'email', 'password', 'user_id', 'display_name', 'device_info_json', 'date_of_birth', 'country', 'registered_at', 'status'];
    const values: unknown[] = [];
    const placeholders: string[] = [];
    accounts.forEach((a, i) => {
      const base = i * cols.length;
      placeholders.push(`(${cols.map((_, j) => `$${base + j + 1}`).join(', ')})`);
      values.push(
        poolId, a.email, a.password, a.userId ?? '', a.displayName ?? '',
        JSON.stringify(genSeedDeviceInfo()),
        a.dateOfBirth ?? genDateOfBirth(), a.country ?? 'VN', now, 'registered',
      );
    });
    await client.query(
      `INSERT INTO pool_accounts (${cols.join(', ')}) VALUES ${placeholders.join(', ')}
       ON CONFLICT (pool_id, email) DO UPDATE SET
         password = EXCLUDED.password,
         display_name = EXCLUDED.display_name,
         user_id = EXCLUDED.user_id,
         device_info_json = EXCLUDED.device_info_json,
         date_of_birth = EXCLUDED.date_of_birth,
         country = EXCLUDED.country,
         status = 'registered'`,
      values,
    );
  } catch (err) {
    // B-1: chỉ in message (không có sql/params — parameterized query) — KHÔNG in password.
    console.error(`[lt][seed] Insert fail: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }

  // Summary KHÔNG in password (D-8 — plaintext chỉ để reuse login, không hiển thị).
  console.log(`[lt][seed] done: pool_id=${poolId} accounts=${accounts.length} gateway_url=${gatewayUrl} file=${fileArg}`);
}

// CLI entry — chỉ chạy khi execute trực tiếp (không phải khi import làm library).
const isMain =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(`[lt][seed] seed fail: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
