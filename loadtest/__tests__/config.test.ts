import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// T-11: mock availableParallelism để assert resolveWorkerCount CHÍNH XÁC (diệt mutant min/max/||).
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, availableParallelism: vi.fn(() => 100) };
});

import {
  getEnv,
  validateEnv,
  newRunId,
  validateRunRequest,
  buildRunConfig,
  resolveWorkerCount,
  estimateInfra,
  loadDotEnv,
  loadSettings,
  saveSettings,
  mergedAllowlist,
  isKnownBadDbUrl,
  PRESETS,
  DEFAULT_PROFILE,
  PLACEHOLDER_DB_URL,
  DEFAULT_DEV_DB_URL,
  mergeEnvSources,
} from '../config';
import type { StartRunRequest } from '../types';
import { normalizeUrl, redactUrl } from '../util';

function baseReq(over: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    targetUsers: 10_000,
    rampRate: 200,
    rampMode: 'rate',
    durationMin: 30,
    profile: { ...DEFAULT_PROFILE },
    gatewayUrl: 'ws://localhost:3000',
    ...over,
  };
}

describe('config — env', () => {
  it('đọc env override + allowlist mặc định localhost', () => {
    const env = getEnv({
      LOADTEST_PORT: '3456',
      LOADTEST_MAX_TARGET: '50000',
      LOADTEST_ALLOWLIST: '',
    });
    expect(env.port).toBe(3456);
    expect(env.maxTarget).toBe(50_000);
    expect(env.allowlist).toContain('http://localhost:3000');
  });

  it('allowlist từ env phân tách phẩy, normalize ws→http', () => {
    const env = getEnv({ LOADTEST_ALLOWLIST: 'ws://test-01.mayogu.test, http://test-02.mayogu.test/' });
    expect(env.allowlist).toEqual(['http://test-01.mayogu.test', 'http://test-02.mayogu.test']);
  });
});

describe('config — validateRunRequest (SD-1 + giới hạn an toàn)', () => {
  it('chặn cứng gateway ngoài allowlist', () => {
    const env = getEnv({ LOADTEST_ALLOWLIST: 'http://localhost:3000' });
    const v = validateRunRequest(baseReq({ gatewayUrl: 'http://production.example.com' }), env);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('allowlist');
  });

  it('chấp nhận gateway trong allowlist', () => {
    const env = getEnv({ LOADTEST_ALLOWLIST: 'http://localhost:3000' });
    expect(validateRunRequest(baseReq(), env).ok).toBe(true);
  });

  it('chặn target > maxTarget (preset 1M/10M)', () => {
    const env = getEnv({ LOADTEST_MAX_TARGET: '200000' });
    const v = validateRunRequest(baseReq({ targetUsers: 1_000_000 }), env);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('vượt giới hạn an toàn');
  });

  it('chặn duration > 60 phút (access token 1h)', () => {
    const env = getEnv({ LOADTEST_MAX_DURATION_MIN: '60' });
    const v = validateRunRequest(baseReq({ durationMin: 90 }), env);
    expect(v.ok).toBe(false);
  });

  it('chặn profile tổng ≠ 100%', () => {
    const env = getEnv({});
    const v = validateRunRequest(baseReq({ profile: { chat: 40, read: 30, comment: 20, like: 5, view: 0 } }), env);
    expect(v.ok).toBe(false);
  });

  it('cảnh báo khi ramp chat vượt trần matching', () => {
    const env = getEnv({});
    const v = validateRunRequest(baseReq({ targetUsers: 100_000, durationMin: 5, profile: { chat: 100, read: 0, comment: 0, like: 0, view: 0 } }), env);
    expect(v.ok).toBe(true);
    expect(v.warnings.some((w) => w.includes('Matching engine'))).toBe(true);
  });
});

describe('config — buildRunConfig', () => {
  it('resolve workerCount + durationSec + seed', () => {
    const env = getEnv({ LOADTEST_WORKERS: '4' });
    const cfg = buildRunConfig(baseReq(), env);
    expect(cfg.workerCount).toBe(4);
    expect(cfg.socketsPerWorker).toBe(2500);
    expect(cfg.durationSec).toBe(1800);
    expect(cfg.runId).toMatch(/^lt/);
    expect(cfg.useExistingAccounts).toBe(true);
  });

  it('auto workerCount theo target', () => {
    const env = getEnv({ LOADTEST_WORKERS: '0' });
    expect(resolveWorkerCount(10_000, env)).toBeGreaterThanOrEqual(1);
  });
});

describe('config — validateEnv (T-03 fail-fast)', () => {
  it('production + thiếu key → errors (DB required, OTP, AUTH)', () => {
    const env = getEnv({
      LOADTEST_DB_REQUIRED: 'false',
      LOADTEST_DATABASE_URL: PLACEHOLDER_DB_URL,
      LOADTEST_OTP_SECRET: '',
      LOADTEST_AUTH_SECRET: '',
    });
    const errs = validateEnv(env, { production: true }).filter((p) => p.severity === 'error');
    expect(errs.some((p) => p.key === 'LOADTEST_DATABASE_URL')).toBe(true);
    expect(errs.some((p) => p.key === 'LOADTEST_OTP_SECRET')).toBe(true);
    expect(errs.some((p) => p.key === 'LOADTEST_AUTH_SECRET')).toBe(true);
  });

  it('dev + dbRequired=false + thiếu key → không error (chỉ warning)', () => {
    const env = getEnv({
      LOADTEST_DB_REQUIRED: 'false',
      LOADTEST_DATABASE_URL: PLACEHOLDER_DB_URL,
      LOADTEST_OTP_SECRET: '',
      LOADTEST_AUTH_SECRET: '',
    });
    const problems = validateEnv(env, { production: false });
    expect(problems.filter((p) => p.severity === 'error')).toHaveLength(0);
  });

  it('dbRequired=true (mặc định) + placeholder DB URL → error', () => {
    const env = getEnv({ LOADTEST_DATABASE_URL: PLACEHOLDER_DB_URL });
    const errs = validateEnv(env).filter((p) => p.severity === 'error');
    expect(errs.some((p) => p.key === 'LOADTEST_DATABASE_URL')).toBe(true);
  });

  it('sai prefix DB URL → error', () => {
    const env = getEnv({
      LOADTEST_DB_REQUIRED: 'true',
      LOADTEST_DATABASE_URL: 'mysql://foo:bar@localhost/db',
    });
    const errs = validateEnv(env).filter((p) => p.severity === 'error');
    expect(errs.some((p) => p.key === 'LOADTEST_DATABASE_URL')).toBe(true);
  });

  it('dev DB URL với username appuser + password thật → PASS (không false-positive — T-03)', () => {
    const env = getEnv({
      LOADTEST_DB_REQUIRED: 'true',
      LOADTEST_DATABASE_URL: 'postgresql://appuser:s3cret-pw-123@localhost:5439/loadtest',
    });
    const errs = validateEnv(env).filter((p) => p.severity === 'error');
    expect(errs.some((p) => p.key === 'LOADTEST_DATABASE_URL')).toBe(false);
  });

  it('default credential cũ (appuser:secret) → error (T-03)', () => {
    const env = getEnv({
      LOADTEST_DB_REQUIRED: 'true',
      LOADTEST_DATABASE_URL: DEFAULT_DEV_DB_URL,
    });
    const errs = validateEnv(env).filter((p) => p.severity === 'error');
    expect(errs.some((p) => p.key === 'LOADTEST_DATABASE_URL')).toBe(true);
  });

  it('REDIS_URL sai prefix → error', () => {
    const env = getEnv({
      LOADTEST_DB_REQUIRED: 'false',
      LOADTEST_DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      LOADTEST_REDIS_URL: 'http://localhost:6379',
    });
    const errs = validateEnv(env, { production: false }).filter((p) => p.severity === 'error');
    expect(errs.some((p) => p.key === 'LOADTEST_REDIS_URL')).toBe(true);
  });

  it('SEC-1: CORS_ORIGIN=* → validateEnv error (mở CORS mọi origin)', () => {
    const env = getEnv({
      LOADTEST_DB_REQUIRED: 'false',
      LOADTEST_DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      LOADTEST_CORS_ORIGIN: '*',
    });
    const errs = validateEnv(env, { production: false }).filter((p) => p.severity === 'error');
    expect(errs.some((p) => p.key === 'LOADTEST_CORS_ORIGIN')).toBe(true);
    expect(errs.find((p) => p.key === 'LOADTEST_CORS_ORIGIN')?.message).toBe(
      'CORS_ORIGIN không được phép là * — chỉ định origin cụ thể',
    );
  });

  it('SEC-1: CORS_ORIGIN chứa origin rỗng → validateEnv error', () => {
    const env = getEnv({
      LOADTEST_DB_REQUIRED: 'false',
      LOADTEST_DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      LOADTEST_CORS_ORIGIN: 'http://a.example,http://b.example',
    });
    // getEnv filter entry rỗng — ép entry rỗng qua env literal (defense-in-depth của validator)
    const errs = validateEnv({ ...env, corsOrigins: ['http://a.example', ''] }, { production: false }).filter(
      (p) => p.severity === 'error',
    );
    expect(errs.some((p) => p.key === 'LOADTEST_CORS_ORIGIN')).toBe(true);
  });

  it('SEC-1: CORS_ORIGIN hợp lệ (nhiều origin cụ thể) → KHÔNG error', () => {
    const env = getEnv({
      LOADTEST_DB_REQUIRED: 'false',
      LOADTEST_DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      LOADTEST_CORS_ORIGIN: 'http://a.example,http://b.example',
    });
    const errs = validateEnv(env, { production: false }).filter((p) => p.severity === 'error');
    expect(errs.some((p) => p.key === 'LOADTEST_CORS_ORIGIN')).toBe(false);
  });

  it('OTP/AUTH quá ngắn (< 32) → error', () => {
    const env = getEnv({
      LOADTEST_DB_REQUIRED: 'false',
      LOADTEST_DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      LOADTEST_OTP_SECRET: 'short',
      LOADTEST_AUTH_SECRET: 'short',
    });
    const errs = validateEnv(env, { production: false }).filter((p) => p.severity === 'error');
    expect(errs.some((p) => p.key === 'LOADTEST_OTP_SECRET')).toBe(true);
    expect(errs.some((p) => p.key === 'LOADTEST_AUTH_SECRET')).toBe(true);
  });

  it('message validateEnv CHÍNH XÁC (diệt string mutant)', () => {
    const env = getEnv({
      LOADTEST_DB_REQUIRED: 'false',
      LOADTEST_DATABASE_URL: 'mysql://foo:bar@localhost/db',
      LOADTEST_OTP_SECRET: 'short',
      LOADTEST_AUTH_SECRET: 'short',
      LOADTEST_REDIS_URL: 'http://localhost:6379',
    });
    const problems = validateEnv(env, { production: false });
    expect(problems.find((p) => p.key === 'LOADTEST_DATABASE_URL')?.message).toBe(
      'phải bắt đầu bằng postgres:// hoặc postgresql:// (hiện: mysql://foo:***@localhost/db...)',
    );
    expect(problems.find((p) => p.key === 'LOADTEST_OTP_SECRET')?.message).toBe('phải ≥ 32 ký tự (hiện 5)');
    expect(problems.find((p) => p.key === 'LOADTEST_AUTH_SECRET')?.message).toBe('phải ≥ 32 ký tự (hiện 5)');
    expect(problems.find((p) => p.key === 'LOADTEST_REDIS_URL')?.message).toBe(
      'phải bắt đầu bằng redis:// hoặc rediss:// (hiện: http://localhost:6379/...)',
    );
  });

  it('OTP/AUTH đúng biên 32 ký tự → không error', () => {
    const env = getEnv({
      LOADTEST_DB_REQUIRED: 'false',
      LOADTEST_DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      LOADTEST_OTP_SECRET: 'a'.repeat(32),
      LOADTEST_AUTH_SECRET: 'b'.repeat(32),
    });
    const errs = validateEnv(env, { production: false }).filter((p) => p.severity === 'error');
    expect(errs.some((p) => p.key === 'LOADTEST_OTP_SECRET')).toBe(false);
    expect(errs.some((p) => p.key === 'LOADTEST_AUTH_SECRET')).toBe(false);
  });

  it('warning mặc định khi thiếu OTP/AUTH (dev) — message chính xác', () => {
    const env = getEnv({
      LOADTEST_DB_REQUIRED: 'false',
      LOADTEST_DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      LOADTEST_OTP_SECRET: '',
      LOADTEST_AUTH_SECRET: '',
    });
    const problems = validateEnv(env, { production: false });
    expect(problems.find((p) => p.key === 'LOADTEST_OTP_SECRET')?.message).toBe(
      'thiếu — register sẽ fail (cần set trong loadtest/.env)',
    );
    expect(problems.find((p) => p.key === 'LOADTEST_AUTH_SECRET')?.message).toBe(
      'thiếu — sẽ dùng fallback tự sinh (dev-only)',
    );
  });

  it('production flag: opts.production=false THẮNG NODE_ENV=production (?? không phải ||)', () => {
    const env = getEnv({
      LOADTEST_DB_REQUIRED: 'false',
      LOADTEST_DATABASE_URL: PLACEHOLDER_DB_URL,
      LOADTEST_OTP_SECRET: '',
      LOADTEST_AUTH_SECRET: '',
    });
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      // ?? : opts.production=false (không nullish) → dùng false → KHÔNG production error
      const problems = validateEnv(env, { production: false });
      expect(problems.filter((p) => p.severity === 'error')).toHaveLength(0);
      // không opts → dùng NODE_ENV → production error xuất hiện
      const prodProblems = validateEnv(env);
      expect(prodProblems.filter((p) => p.severity === 'error').length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});

describe('config — newRunId (S-9/B-4 collision fix)', () => {
  it('2 lần gọi liên tiếp → id khác nhau', () => {
    expect(newRunId()).not.toBe(newRunId());
  });

  it('sau "restart" (module reload, runSeq reset) → id khác id cũ', async () => {
    const first = newRunId();
    vi.resetModules();
    const mod = await import('../config');
    const second = mod.newRunId();
    expect(second).not.toBe(first);
    expect(second).toMatch(/^lt[a-z0-9]{2,24}$/i);
  });
});

describe('util — normalizeUrl', () => {
  it('ws→http + bỏ trailing slash', () => {
    expect(normalizeUrl('ws://localhost:3000/')).toBe('http://localhost:3000');
    expect(normalizeUrl('https://x.com')).toBe('https://x.com');
  });
});

describe('util — redactUrl (T-03: không lộ password trong log/error)', () => {
  it('mask password trong DB URL có user:pass', () => {
    expect(redactUrl('postgresql://appuser:s3cret-pw@localhost:5439/loadtest')).toBe(
      'postgresql://appuser:***@localhost:5439/loadtest',
    );
  });
  it('URL không password → giữ nguyên', () => {
    expect(redactUrl('redis://localhost:6379')).toBe('redis://localhost:6379');
  });
  it('placeholder URL (port không phải số — URL không parse) → fallback regex vẫn mask', () => {
    expect(redactUrl(PLACEHOLDER_DB_URL)).toBe('postgresql://USER:***@HOST:PORT/DB');
  });
});

describe('config — env precedence (T-03: process.env > .env file > defaults)', () => {
  it('process.env thắng .env file', () => {
    const merged = mergeEnvSources(
      { LOADTEST_PORT: '7000' },
      { LOADTEST_PORT: '3401', LOADTEST_MAX_TARGET: '50000' },
      {},
    );
    expect(merged.LOADTEST_PORT).toBe('7000'); // shell env override được .env
    expect(merged.LOADTEST_MAX_TARGET).toBe('50000'); // .env file cung cấp giá trị
  });
  it('overrides (getEnv arg) thắng process.env', () => {
    const merged = mergeEnvSources({ LOADTEST_PORT: '7000' }, { LOADTEST_PORT: '3401' }, { LOADTEST_PORT: '8000' });
    expect(merged.LOADTEST_PORT).toBe('8000');
  });
});

// ─── T-11 (G-2): test mở rộng diệt mutant config.ts ────────────────────────

describe('config — loadDotEnv (T-11)', () => {
  it('parse .env đúng: comment, quotes, khoảng trắng, line invalid', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-dotenv-'));
    fs.writeFileSync(
      path.join(dir, '.env'),
      [
        '# comment',
        'KEY_A=value-a',
        'KEY_B="quoted value"',
        "KEY_C='single quoted'",
        '  KEY_D=  padded  ',
        'KEY_E=', // value rỗng
        'NO_EQUALS_LINE',
        '=orphan-key',
        '',
      ].join('\n'),
      'utf8',
    );
    const parsed = loadDotEnv(dir);
    expect(parsed.KEY_A).toBe('value-a');
    expect(parsed.KEY_B).toBe('quoted value');
    expect(parsed.KEY_C).toBe('single quoted');
    expect(parsed.KEY_D).toBe('padded');
    expect(parsed.KEY_E).toBe('');
    expect(parsed.NO_EQUALS_LINE).toBeUndefined();
  });

  it('quote LỆCH (chỉ mở không đóng / ngược) → KHÔNG strip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-dotenv-odd-'));
    fs.writeFileSync(
      path.join(dir, '.env'),
      ['A="open-only', 'B=close-only"', "C='mixed\"", 'D="double-single\'', 'E="'].join('\n'),
      'utf8',
    );
    const parsed = loadDotEnv(dir);
    expect(parsed.A).toBe('"open-only'); // chỉ startsWith(") → giữ nguyên
    expect(parsed.B).toBe('close-only"'); // chỉ endsWith(") → giữ nguyên
    expect(parsed.C).toBe("'mixed\""); // quote trái loại → giữ nguyên
    expect(parsed.D).toBe('"double-single\''); // mở " đóng ' → giữ nguyên
    expect(parsed.E).toBe(''); // " đơn → slice(1,-1) → rỗng
  });

  it('file không tồn tại → {}', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-dotenv-missing-'));
    expect(loadDotEnv(dir)).toEqual({});
  });
});

describe('config — getEnv defaults đầy đủ (T-11)', () => {
  it('mọi key mặc định đúng (không override)', () => {
    const env = getEnv({
      LOADTEST_DB_REQUIRED: 'false',
      LOADTEST_DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
      // Cô lập khỏi file loadtest/.env của máy (có thể set gateway khác) — '' → fallback default.
      LOADTEST_GATEWAY_URL: '',
      // dataDir máy trỏ ngoài repo (C:/MAYogu_VIASG/secrets — R-3) — '' → fallback default.
      LOADTEST_DATA_DIR: '',
    });
    expect(env.port).toBe(3401);
    expect(env.host).toBe('127.0.0.1');
    expect(env.gatewayUrl).toBe('http://localhost:3000');
    expect(env.maxTarget).toBe(200_000);
    expect(env.maxDurationMin).toBe(60);
    expect(env.maxRegisterRamp).toBe(100);
    expect(env.workerCount).toBe(0);
    expect(env.maxSocketsPerWorker).toBe(10_000);
    expect(env.maxPendingOutbox).toBe(1000);
    expect(env.scrapeIntervalMs).toBe(5000);
    expect(env.registerRamp).toBe(100);
    expect(env.fixturePostIds).toEqual([]);
    expect(env.dbRequired).toBe(false);
    expect(env.corsOrigins).toEqual(['http://localhost:5173']);
    expect(env.allowRegister).toBe(false);
    expect(env.rateLimitDisabled).toBe(false);
    expect(env.rateLimitLoginFails).toBe(5);
    expect(env.rateLimitWindowMs).toBe(60_000);
    expect(env.rateLimitStartMs).toBe(10_000);
    expect(env.rateLimitWriteBucket).toBe(0);
    expect(env.trustProxy).toBe(false);
    expect(env.shutdownTimeoutMs).toBe(10_000);
    expect(env.dataDir).toBe('./loadtest/data');
  });

  it('parse từng key override: fixture post ids, booleans, rate-limit, workers', () => {
    const env = getEnv({
      LOADTEST_FIXTURE_POST_IDS: ' post-1, post-2 ,,post-3 ',
      LOADTEST_ALLOW_REGISTER: 'true',
      LOADTEST_RATE_LIMIT_DISABLED: 'true',
      LOADTEST_RATE_LIMIT_LOGIN_FAILS: '3',
      LOADTEST_RATE_LIMIT_WINDOW_MS: '5000',
      LOADTEST_RATE_LIMIT_START_MS: '2000',
      LOADTEST_RATE_LIMIT_WRITE_BUCKET: '10',
      LOADTEST_TRUST_PROXY: 'true',
      LOADTEST_SHUTDOWN_TIMEOUT_MS: '20000',
      LOADTEST_WORKERS: '7',
      LOADTEST_MAX_SOCKETS_PER_WORKER: '500',
      LOADTEST_REGISTER_RAMP: '50',
      LOADTEST_GATEWAY_URL: 'ws://gateway.mayogu.test/',
      LOADTEST_CORS_ORIGIN: 'http://a.example, http://b.example',
    });
    expect(env.fixturePostIds).toEqual(['post-1', 'post-2', 'post-3']);
    expect(env.allowRegister).toBe(true);
    expect(env.rateLimitDisabled).toBe(true);
    expect(env.rateLimitLoginFails).toBe(3);
    expect(env.rateLimitWindowMs).toBe(5000);
    expect(env.rateLimitStartMs).toBe(2000);
    expect(env.rateLimitWriteBucket).toBe(10);
    expect(env.trustProxy).toBe(true);
    expect(env.shutdownTimeoutMs).toBe(20_000);
    expect(env.workerCount).toBe(7);
    expect(env.maxSocketsPerWorker).toBe(500);
    expect(env.registerRamp).toBe(50);
    expect(env.gatewayUrl).toBe('http://gateway.mayogu.test');
    expect(env.corsOrigins).toEqual(['http://a.example', 'http://b.example']);
  });

  it('LOADTEST_COMMUNITY_ID: rỗng → \'\' (toàn app), set → giá trị', () => {
    // Cô lập khỏi file loadtest/.env máy: override '' thắng .env file.
    expect(getEnv({ LOADTEST_COMMUNITY_ID: '' }).communityId).toBe('');
    expect(getEnv({ LOADTEST_COMMUNITY_ID: 'c-123' }).communityId).toBe('c-123');
  });

  it('giá trị number hỏng → fallback default (không NaN)', () => {
    const env = getEnv({ LOADTEST_PORT: 'not-a-number', LOADTEST_MAX_TARGET: 'abc' });
    expect(env.port).toBe(3401);
    expect(env.maxTarget).toBe(200_000);
  });

  it('giá trị number rỗng "" → fallback default; "0" → 0 (không fallback)', () => {
    const env = getEnv({ LOADTEST_PORT: '', LOADTEST_MAX_TARGET: '0' });
    expect(env.port).toBe(3401); // '' → default
    expect(env.maxTarget).toBe(0); // '0' → 0 hợp lệ
  });

  it('LOADTEST_DEBUG "true"/"false" → env.debug tương ứng', () => {
    expect(getEnv({ LOADTEST_DEBUG: 'true' }).debug).toBe(true);
    expect(getEnv({ LOADTEST_DEBUG: 'false' }).debug).toBe(false);
  });

  it('LOADTEST_GATEWAY_URL rỗng → default localhost:3000', () => {
    const env = getEnv({ LOADTEST_GATEWAY_URL: '' });
    expect(env.gatewayUrl).toBe('http://localhost:3000');
  });

  it('dbRequired mặc định true (Q-2); set false → false', () => {
    expect(getEnv({ LOADTEST_DATABASE_URL: 'postgresql://u:p@localhost:5432/db' }).dbRequired).toBe(true);
    expect(getEnv({ LOADTEST_DB_REQUIRED: 'false' }).dbRequired).toBe(false);
  });
});

describe('config — validateRunRequest message CHÍNH XÁC (T-11 — diệt string mutant)', () => {
  const env = getEnv({ LOADTEST_ALLOWLIST: 'http://localhost:3000', LOADTEST_MAX_DURATION_MIN: '60' });

  it('thiếu gatewayUrl → "gatewayUrl bắt buộc"', () => {
    const v = validateRunRequest({ ...baseReq(), gatewayUrl: '' }, env);
    expect(v.errors).toContain('gatewayUrl bắt buộc');
  });

  it('targetUsers < 1000 → "targetUsers phải ≥ 1000"', () => {
    expect(validateRunRequest(baseReq({ targetUsers: 999 }), env).errors).toEqual(['targetUsers phải ≥ 1000']);
    expect(validateRunRequest(baseReq({ targetUsers: 1000.5 }), env).errors).toEqual(['targetUsers phải ≥ 1000']);
  });

  it('targetUsers > maxTarget → message chính xác có "vượt giới hạn an toàn" + maxTarget', () => {
    const v = validateRunRequest(baseReq({ targetUsers: 500_000 }), env);
    expect(v.errors[0]).toBe(
      'targetUsers 500000 vượt giới hạn an toàn 200000 (preset 1M/10M cần cluster — v1.1). Override bằng LOADTEST_MAX_TARGET nếu thực sự có hạ tầng.',
    );
  });

  it('durationMin NaN/0/âm → "durationMin phải > 0"; quá max → message chính xác', () => {
    expect(validateRunRequest(baseReq({ durationMin: 0 }), env).errors).toContain('durationMin phải > 0');
    expect(validateRunRequest(baseReq({ durationMin: Number.NaN }), env).errors).toContain('durationMin phải > 0');
    const v = validateRunRequest(baseReq({ durationMin: 90 }), env);
    expect(v.errors[0]).toBe('durationMin 90 phút vượt tối đa 60 phút (access token TTL 1h — PRD §5.3).');
  });

  it('rampRate 0/âm → "rampRate phải > 0"; > 2000 → warning chính xác', () => {
    expect(validateRunRequest(baseReq({ rampRate: 0 }), env).errors).toContain('rampRate phải > 0');
    expect(validateRunRequest(baseReq({ rampRate: -5 }), env).errors).toContain('rampRate phải > 0');
    const v = validateRunRequest(baseReq({ rampRate: 5000 }), env);
    expect(v.warnings[0]).toBe('rampRate > 2000/s có thể bão hòa event loop tool và matching engine (~100 user/s chat).');
  });

  it('rampRate đúng biên 2000 → KHÔNG warning (điều kiện > 2000, không >=)', () => {
    const env2000 = getEnv({ LOADTEST_ALLOWLIST: 'http://localhost:3000' });
    expect(validateRunRequest(baseReq({ rampRate: 2000 }), env2000).warnings).toHaveLength(0);
    expect(validateRunRequest(baseReq({ rampRate: 2001 }), env2000).warnings.length).toBeGreaterThan(0);
  });

  it('thiếu profile → "profile bắt buộc"; tổng ≠ 100 → message chính xác', () => {
    const noProfile = { ...baseReq() } as StartRunRequest;
    delete (noProfile as { profile?: unknown }).profile;
    expect(validateRunRequest(noProfile, env).errors).toContain('profile bắt buộc');
    const v = validateRunRequest(baseReq({ profile: { chat: 40, read: 30, comment: 20, like: 5, view: 0 } }), env);
    expect(v.errors[0]).toBe('Tổng profile = 95% — phải đúng 100%');
  });

  it('profile field NaN/âm → "profile.{k} không hợp lệ"', () => {
    const v = validateRunRequest(baseReq({ profile: { chat: Number.NaN, read: 30, comment: 20, like: 10, view: 0 } }), env);
    expect(v.errors).toContain('profile.chat không hợp lệ');
    const neg = validateRunRequest(baseReq({ profile: { chat: 40, read: -1, comment: 20, like: 10, view: 0 } }), env);
    expect(neg.errors).toContain('profile.read không hợp lệ');
  });

  it('gateway ws:// được normalize rồi mới so allowlist', () => {
    const v = validateRunRequest(baseReq({ gatewayUrl: 'ws://localhost:3000' }), env);
    expect(v.ok).toBe(true);
  });

  it('cảnh báo matching seat: chat=0 → KHÔNG warning; target đúng biên 10_000 → KHÔNG warning; seat == duration → KHÔNG warning', () => {
    const e = getEnv({ LOADTEST_ALLOWLIST: 'http://localhost:3000' });
    const chat0 = validateRunRequest(baseReq({ targetUsers: 100_000, profile: { chat: 0, read: 50, comment: 30, like: 20, view: 0 } }), e);
    expect(chat0.warnings.some((w) => w.includes('Matching engine'))).toBe(false);
    const at10k = validateRunRequest(baseReq({ targetUsers: 10_000, profile: { chat: 100, read: 0, comment: 0, like: 0, view: 0 } }), e);
    expect(at10k.warnings.some((w) => w.includes('Matching engine'))).toBe(false);
    const seatEq = validateRunRequest(
      baseReq({ targetUsers: 60_000, durationMin: 10, profile: { chat: 100, read: 0, comment: 0, like: 0, view: 0 } }),
      e,
    );
    expect(seatEq.warnings.some((w) => w.includes('Matching engine'))).toBe(false); // seat 600s == duration 600s
    const over = validateRunRequest(
      baseReq({ targetUsers: 60_000, durationMin: 9, profile: { chat: 100, read: 0, comment: 0, like: 0, view: 0 } }),
      e,
    );
    expect(over.warnings.some((w) => w.includes('Matching engine'))).toBe(true); // seat 600s > 540s
  });
});

describe('config — buildRunConfig nhánh (T-11)', () => {
  it('freshAccounts=true → useExistingAccounts=false; ngược lại true', () => {
    const env = getEnv({ LOADTEST_WORKERS: '2' });
    const fresh = buildRunConfig(baseReq({ freshAccounts: true }), env);
    expect(fresh.useExistingAccounts).toBe(false);
    expect(fresh.freshAccounts).toBe(true);
    const reuse = buildRunConfig(baseReq(), env);
    expect(reuse.useExistingAccounts).toBe(true);
  });

  it('registerRamp bị clamp theo maxRegisterRamp', () => {
    const env = getEnv({ LOADTEST_REGISTER_RAMP: '9999' });
    const cfg = buildRunConfig(baseReq(), env);
    expect(cfg.registerRamp).toBe(env.maxRegisterRamp);
  });

  it('profile merge với DEFAULT_PROFILE (field thiếu → default)', () => {
    const env = getEnv({});
    const cfg = buildRunConfig(baseReq({ profile: { chat: 100, read: 0, comment: 0, like: 0, view: 0 } }), env);
    expect(cfg.profile).toEqual({ chat: 100, read: 0, comment: 0, like: 0, view: 0, post: 0 });
  });

  it('seed + createdAt là số', () => {
    const env = getEnv({});
    const cfg = buildRunConfig(baseReq(), env);
    expect(Number.isFinite(cfg.seed)).toBe(true);
    expect(Number.isFinite(cfg.createdAt)).toBe(true);
  });
});

describe('config — resolveWorkerCount / estimateInfra (T-11)', () => {
  it('workerCount cấu hình thắng auto', () => {
    const env = getEnv({ LOADTEST_WORKERS: '3' });
    expect(resolveWorkerCount(100_000, env)).toBe(3);
  });

  it('auto: clamp theo target/socketsPerWorker và 32', () => {
    const env = getEnv({ LOADTEST_WORKERS: '0', LOADTEST_MAX_SOCKETS_PER_WORKER: '100' });
    const w = resolveWorkerCount(100_000, env);
    expect(w).toBeGreaterThanOrEqual(1);
    expect(w).toBeLessThanOrEqual(32);
  });

  it('auto: giá trị CHÍNH XÁC với availableParallelism mock (diệt mutant min/max/||)', () => {
    const env = getEnv({ LOADTEST_WORKERS: '0', LOADTEST_MAX_SOCKETS_PER_WORKER: '100' });
    const fn = vi.mocked(os.availableParallelism);
    fn.mockReturnValue(100);
    // cpus-1 = 99 → min(99, byTarget=1000) = 99 → max(1, 99) → min(99, 32) = 32
    expect(resolveWorkerCount(100_000, env)).toBe(32);
    fn.mockReturnValue(8);
    // cpus-1 = 7 → min(7, 1000) = 7 → max(1, 7) → min(7, 32) = 7
    expect(resolveWorkerCount(100_000, env)).toBe(7);
    fn.mockReturnValue(1);
    // cpus-1 = 0 → || 1 → 1 → min(1, 1000) = 1 → max(1, 1) → 1
    expect(resolveWorkerCount(100_000, env)).toBe(1);
  });

  it('estimateInfra: workers/ramGB/seatMin', () => {
    const env = getEnv({});
    const e = estimateInfra(50_000, env);
    expect(e.workers).toBe(20); // 50k / 2500 per worker
    expect(e.ramGB).toBeGreaterThan(2);
    expect(e.seatMin).toBe(9); // 50000/100/60 → ceil(8.33)
  });
});

describe('config — settings file allowlist (SD-1, T-11)', () => {
  it('saveSettings → loadSettings roundtrip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-settings-'));
    const env = getEnv({ LOADTEST_DATA_DIR: dir });
    saveSettings(env, { allowlist: ['http://extra.example'], updatedAt: 123 });
    const loaded = loadSettings(env);
    expect(loaded.allowlist).toEqual(['http://extra.example']);
    expect(loaded.updatedAt).toBe(123);
  });

  it('file hỏng (không phải JSON) → default { allowlist: [], updatedAt: 0 }', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-settings-bad-'));
    fs.writeFileSync(path.join(dir, 'settings.json'), '{not json', 'utf8');
    const env = getEnv({ LOADTEST_DATA_DIR: dir });
    expect(loadSettings(env)).toEqual({ allowlist: [], updatedAt: 0 });
  });

  it('mergedAllowlist: env + settings, dedupe, normalize ws→http', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-settings-merge-'));
    const env = getEnv({ LOADTEST_DATA_DIR: dir, LOADTEST_ALLOWLIST: 'http://localhost:3000, ws://extra.example' });
    saveSettings(env, { allowlist: ['http://extra.example/', 'http://from-file.example'], updatedAt: 0 });
    expect(mergedAllowlist(env)).toEqual(['http://localhost:3000', 'http://extra.example', 'http://from-file.example']);
  });
});

describe('config — misc (T-11)', () => {
  it('isKnownBadDbUrl: placeholder + default credential cũ → true; dev thật → false', () => {
    expect(isKnownBadDbUrl(PLACEHOLDER_DB_URL)).toBe(true);
    expect(isKnownBadDbUrl(DEFAULT_DEV_DB_URL)).toBe(true);
    expect(isKnownBadDbUrl('postgresql://user:real@localhost:5432/db')).toBe(false);
    expect(isKnownBadDbUrl('')).toBe(false);
  });

  it('PRESETS: 1M/10M requiresCluster, label đúng', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(['10k', '50k', '100k', '1M', '10M']);
    expect(PRESETS.find((p) => p.id === '1M')?.requiresCluster).toBe(true);
    expect(PRESETS.find((p) => p.id === '10M')?.requiresCluster).toBe(true);
    expect(PRESETS.find((p) => p.id === '10k')?.targetUsers).toBe(10_000);
    expect(DEFAULT_PROFILE).toEqual({ chat: 40, read: 30, comment: 20, like: 10, view: 0, post: 0 });
  });
});
