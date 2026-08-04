import { describe, it, expect, vi } from 'vitest';
import {
  getEnv,
  validateEnv,
  newRunId,
  validateRunRequest,
  buildRunConfig,
  resolveWorkerCount,
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
