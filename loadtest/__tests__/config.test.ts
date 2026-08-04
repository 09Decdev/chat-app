import { describe, it, expect } from 'vitest';
import { getEnv, validateRunRequest, buildRunConfig, resolveWorkerCount, DEFAULT_PROFILE } from '../config';
import type { StartRunRequest } from '../types';
import { normalizeUrl } from '../util';

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

describe('util — normalizeUrl', () => {
  it('ws→http + bỏ trailing slash', () => {
    expect(normalizeUrl('ws://localhost:3000/')).toBe('http://localhost:3000');
    expect(normalizeUrl('https://x.com')).toBe('https://x.com');
  });
});
