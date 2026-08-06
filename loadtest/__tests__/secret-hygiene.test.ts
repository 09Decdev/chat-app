/**
 * T7 (DESIGN-loadtest-e2-connect-fail §9) — ST-11: secret hygiene gate (pre-flight, F-6 debt).
 * `git ls-files` KHÔNG được track credential files:
 *   - users_accounts.json (root — pool production)
 *   - loadtest/data/accounts-*.json (14MB × 2 chứa accessToken + refreshToken 10k user production)
 *   - loadtest/data/auth-secret.json
 *   - mọi file đuôi .env (chỉ .env.example được phép — không chứa secret thật)
 * Chạy git ls-files (không cần gitleaks — npm run secret:scan giữ nguyên gate gitleaks riêng).
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** chat-app/loadtest/__tests__ → lên 2 cấp = repo root. */
const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

function trackedFiles(): string[] {
  try {
    return execSync('git ls-files', { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch (err) {
    throw new Error(`git ls-files fail (cwd=${REPO_ROOT}): ${String(err)}`);
  }
}

describe('ST-11 — secret hygiene gate (DESIGN §9 T7, F-6 debt)', () => {
  it('git ls-files không chứa users_accounts.json / accounts-*.json / auth-secret (crown jewel: refreshToken 10k user)', () => {
    const files = trackedFiles();
    expect(files.length).toBeGreaterThan(0); // repo có track file — scan có ý nghĩa
    const leaked = files.filter(
      (f) =>
        /users_accounts\.json$/i.test(f) ||
        /(^|\/)accounts-[^/]*\.json$/i.test(f) ||
        /auth-secret/i.test(f),
    );
    expect(leaked).toEqual([]);
  });

  it('không file nào đuôi .env được track — chỉ .env.example (mẫu, không secret)', () => {
    const envFiles = trackedFiles().filter((f) => /\.env(\.|$)/i.test(f));
    expect(envFiles.length).toBeGreaterThan(0); // .env.example tồn tại
    for (const f of envFiles) {
      expect(f).toMatch(/\.env\.example$/i); // mọi file .env* phải là .env.example
    }
  });
});
