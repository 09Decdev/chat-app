/**
 * Focused tests — chế độ pool-file (LOADTEST_POOL_FILE):
 * - loadPoolFile: nạp account từ file JSON (mảng [{email,password,...}] hoặc { accounts: [...] }).
 * - provisionAccounts có pool file → login qua mock gateway, KHÔNG BAO GIỜ register.
 * - Pool cạn (file có N < targetUsers) → fail run sớm (throw message rõ) trước mọi HTTP call.
 * - KHÔNG set pool file → hành vi cũ (env.poolFile = '').
 * KHÔNG dùng Postgres/Redis thật — mock gateway (mock-gateway.ts) + fake Redis stub.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Redis from 'ioredis';
import { getEnv } from '../config';
import { loadPoolFile, provisionAccounts } from '../auth-factory';
import type { RunConfig } from '../types';
import { startMockGateway } from './mock-gateway';

/** Fake Redis tối thiểu — pool-file path không dùng Redis. */
const fakeRedis = {
  set: async () => 'OK',
} as unknown as Redis;

function buildConfig(runId: string, gatewayUrl: string, targetUsers: number): RunConfig {
  return {
    runId, targetUsers, rampRate: 100, rampMode: 'rate', durationMin: 1, durationSec: 60,
    profile: { chat: 40, read: 30, comment: 20, like: 10, view: 0 },
    gatewayUrl, workerCount: 1, socketsPerWorker: targetUsers,
    registerRamp: 100, useExistingAccounts: true, freshAccounts: false, seed: 1, createdAt: Date.now(),
  };
}

/** Luôn override LOADTEST_POOL_FILE tường minh — cô lập khỏi loadtest/.env máy (cùng pattern config.test.ts). */
function buildEnv(gatewayUrl: string, dataDir: string, poolFile: string) {
  return getEnv({
    LOADTEST_ALLOWLIST: gatewayUrl,
    LOADTEST_GATEWAY_URL: gatewayUrl,
    LOADTEST_REDIS_URL: 'redis://mock.invalid:6379',
    LOADTEST_OTP_SECRET: 'pool-otp-secret-0123456789abcdef0123456789abcdef',
    LOADTEST_AUTH_SECRET: 'pool-auth-secret-0123456789abcdef0123456789abcdef',
    LOADTEST_DATA_DIR: dataDir,
    LOADTEST_RATE_LIMIT_DISABLED: 'true',
    LOADTEST_POOL_FILE: poolFile,
  });
}

function writePoolFile(dir: string, content: unknown): string {
  const p = path.join(dir, 'pool.json');
  fs.writeFileSync(p, JSON.stringify(content), 'utf8');
  return p;
}

describe('loadPoolFile — nạp account từ file JSON', () => {
  it('mảng [{email,password}] → TestAccount[] (thiếu deviceInfo → tự sinh), password giữ nguyên', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-pool-array-'));
    try {
      const p = writePoolFile(dir, [
        { email: 'pool.a@test.invalid', password: 'PassA 1!' }, // password có space — không trim
        { email: 'pool.b@test.invalid', password: 'PassB2!' },
      ]);
      const accs = loadPoolFile(p, 'lt-pool-file');
      expect(accs).toHaveLength(2);
      expect(accs[0].email).toBe('pool.a@test.invalid');
      expect(accs[0].password).toBe('PassA 1!');
      expect(accs[0].deviceInfo.installationId).toBeTruthy();
      expect(accs[0].deviceInfo.deviceFingerprint).toHaveLength(64);
      expect(accs[0].deviceInfo.platform).toBe('web');
      expect(accs[0].country).toBe('VN');
      expect(accs[1].accessToken).toBe('');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dạng pool disk { accounts: [...] } → giữ deviceInfo/accessToken có sẵn', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-pool-disk-'));
    try {
      const deviceInfo = { installationId: 'inst-1', deviceFingerprint: 'f'.repeat(64), platform: 'web' as const, deviceName: 'seed' };
      const p = writePoolFile(dir, {
        runId: 'lt-old', targetUsers: 1, gatewayUrl: 'http://localhost:3000',
        accounts: [{ email: 'pool.c@test.invalid', password: 'PassC3!', userId: 'u-c', accessToken: 'at-c', refreshToken: 'rt-c', displayName: 'C', deviceInfo, dateOfBirth: '2000-01-01', country: 'VN', registeredAt: 1 }],
      });
      const accs = loadPoolFile(p, 'lt-pool-file');
      expect(accs).toHaveLength(1);
      expect(accs[0].userId).toBe('u-c');
      expect(accs[0].accessToken).toBe('at-c');
      expect(accs[0].refreshToken).toBe('rt-c');
      expect(accs[0].deviceInfo).toEqual(deviceInfo); // dữ nguyên — không sinh lại
      expect(accs[0].dateOfBirth).toBe('2000-01-01');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('file không tồn tại / sai cấu trúc / entry thiếu email → throw message rõ', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-pool-bad-'));
    try {
      expect(() => loadPoolFile(path.join(dir, 'missing.json'), 'lt-run')).toThrow(/Không đọc được pool file/);
      expect(() => loadPoolFile(writePoolFile(dir, { runId: 'x' }), 'lt-run')).toThrow(/không đúng cấu trúc/);
      expect(() => loadPoolFile(writePoolFile(dir, [{ password: 'NoEmail1!' }]), 'lt-run')).toThrow(/email bắt buộc/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('getEnv — LOADTEST_POOL_FILE', () => {
  it('set → env.poolFile = path; rỗng → \'\' (hành vi cũ)', () => {
    expect(getEnv({ LOADTEST_POOL_FILE: 'x/accounts.json' }).poolFile).toBe('x/accounts.json');
    expect(getEnv({ LOADTEST_POOL_FILE: '' }).poolFile).toBe('');
  });
});

describe('provisionAccounts — pool-file mode', () => {
  it('có pool file đủ account → login qua mock gateway, KHÔNG register', async () => {
    const gateway = await startMockGateway();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-pool-mode-'));
    try {
      const poolPath = writePoolFile(dir, [
        { email: 'pool.a@test.invalid', password: 'PassA1!' },
        { email: 'pool.b@test.invalid', password: 'PassB2!' },
      ]);
      const env = buildEnv(gateway.url, dir, poolPath);
      const config = buildConfig('lt-pool-mode', gateway.url, 2);
      const summary = await provisionAccounts(fakeRedis, config, env);

      expect(summary.registered).toBe(0);
      expect(summary.registerFailed).toBe(0);
      expect(summary.loggedIn).toBe(2);
      expect(summary.failed).toBe(0);
      expect(summary.accounts).toHaveLength(2);
      expect(summary.accounts[0].accessToken).toBeTruthy();
      expect(summary.accounts[0].refreshToken).toBeTruthy();
      // KHÔNG có bất kỳ request register nào
      const registers = gateway.requestLog.filter((r) => r.path.startsWith('/auth/register'));
      expect(registers).toHaveLength(0);
      const logins = gateway.requestLog.filter((r) => r.method === 'POST' && r.path === '/auth/login');
      expect(logins).toHaveLength(2);
    } finally {
      await gateway.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pool cạn (file 1 account, cần 2) → fail run sớm, KHÔNG gọi HTTP nào', async () => {
    const gateway = await startMockGateway();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-pool-short-'));
    try {
      const poolPath = writePoolFile(dir, [{ email: 'pool.a@test.invalid', password: 'PassA1!' }]);
      const env = buildEnv(gateway.url, dir, poolPath);
      const config = buildConfig('lt-pool-short', gateway.url, 2);
      await expect(provisionAccounts(fakeRedis, config, env)).rejects.toThrow(
        'chỉ có 1 account, cần 2',
      );
      expect(gateway.requestLog).toHaveLength(0); // fail sớm — chưa login/register request nào
    } finally {
      await gateway.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
