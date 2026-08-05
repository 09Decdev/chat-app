/**
 * Focused tests — provisionAccounts DB pool reuse path (AF-4 + seed-accounts):
 * - useExistingAccounts + loadPoolFromDb trả account → LOGIN qua mock gateway, KHÔNG register.
 * - loadPoolFromDb trả null (không có pool DB) + không có disk pool → fallback register.
 * KHÔNG cần Postgres/Redis thật — mock gateway (mock-gateway.ts) + fake Redis stub.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Redis from 'ioredis';
import { getEnv } from '../config';
import { provisionAccounts } from '../auth-factory';
import type { RunConfig, TestAccount } from '../types';
import { startMockGateway } from './mock-gateway';
import { normalizeUrl } from '../util';

/** Fake Redis tối thiểu — login path không dùng Redis; register path chỉ cần set (seed OTP). */
const fakeRedis = {
  set: async () => 'OK',
} as unknown as Redis;

function seedDeviceInfo(i: number): TestAccount['deviceInfo'] {
  const n = String(i).padStart(12, '0');
  return {
    installationId: `00000000-0000-4000-8000-${n}`,
    deviceFingerprint: 'a'.repeat(64),
    platform: 'web',
    deviceName: 'seed',
  };
}

function buildConfig(runId: string, gatewayUrl: string, targetUsers: number): RunConfig {
  return {
    runId, targetUsers, rampRate: 100, rampMode: 'rate', durationMin: 1, durationSec: 60,
    profile: { chat: 40, read: 30, comment: 20, like: 10, view: 0 },
    gatewayUrl, workerCount: 1, socketsPerWorker: targetUsers,
    registerRamp: 100, useExistingAccounts: true, freshAccounts: false, seed: 1, createdAt: Date.now(),
  };
}

function buildEnv(gatewayUrl: string, dataDir: string) {
  return getEnv({
    LOADTEST_ALLOWLIST: gatewayUrl,
    LOADTEST_GATEWAY_URL: gatewayUrl,
    LOADTEST_REDIS_URL: 'redis://mock.invalid:6379',
    LOADTEST_OTP_SECRET: 'seed-otp-secret-0123456789abcdef0123456789abcdef',
    LOADTEST_AUTH_SECRET: 'seed-auth-secret-0123456789abcdef0123456789abcdef',
    LOADTEST_DATA_DIR: dataDir,
    LOADTEST_RATE_LIMIT_DISABLED: 'true',
  });
}

describe('provisionAccounts — DB pool reuse (useExistingAccounts)', () => {
  it('loadPoolFromDb trả account → login qua mock gateway, KHÔNG register', async () => {
    const gateway = await startMockGateway();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-reuse-db-'));
    try {
      const env = buildEnv(gateway.url, dataDir);
      const config = buildConfig('lt-reuse-db', gateway.url, 2);
      const seedAccounts: TestAccount[] = [
        { email: 'seed.a@mayogu.test', password: 'SeedPass123!', userId: 'u-seed-a', accessToken: '', refreshToken: '', displayName: 'Seed A', deviceInfo: seedDeviceInfo(1), dateOfBirth: '2000-01-01', country: 'VN', registeredAt: 1 },
        { email: 'seed.b@mayogu.test', password: 'SeedPass456!', userId: 'u-seed-b', accessToken: '', refreshToken: '', displayName: 'Seed B', deviceInfo: seedDeviceInfo(2), dateOfBirth: '2000-02-02', country: 'VN', registeredAt: 1 },
      ];
      const loadCalls: Array<[string, number]> = [];
      const summary = await provisionAccounts(fakeRedis, config, env, undefined, undefined, async (gw, tu) => {
        loadCalls.push([gw, tu]);
        return seedAccounts;
      });

      // 1. loadPoolFromDb được gọi đúng gateway + targetUsers
      expect(loadCalls).toEqual([[normalizeUrl(gateway.url), 2]]);
      // 2. KHÔNG register — toàn bộ account login lại qua pool
      expect(summary.registered).toBe(0);
      expect(summary.registerFailed).toBe(0);
      expect(summary.loggedIn).toBe(2);
      expect(summary.failed).toBe(0);
      expect(summary.accounts).toHaveLength(2);
      expect(summary.accounts[0].accessToken).toBeTruthy();
      expect(summary.accounts[0].refreshToken).toBeTruthy();
      expect(summary.poolSourceRunId).toBeUndefined(); // DB pool — poolId do DbWriter quản lý
      // 3. Mock gateway nhận đúng request: login ×2, register ×0
      const logins = gateway.requestLog.filter((r) => r.method === 'POST' && r.path === '/auth/login');
      expect(logins).toHaveLength(2);
      const registers = gateway.requestLog.filter((r) => r.path.startsWith('/auth/register'));
      expect(registers).toHaveLength(0);
    } finally {
      await gateway.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('loadPoolFromDb trả null + không có disk pool → fallback register', async () => {
    const gateway = await startMockGateway();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-reuse-fallback-'));
    try {
      const env = buildEnv(gateway.url, dataDir);
      const config = buildConfig('lt-reuse-fallback', gateway.url, 2);
      const summary = await provisionAccounts(fakeRedis, config, env, undefined, undefined, async () => null);

      expect(summary.registered).toBe(2);
      expect(summary.loggedIn).toBe(0);
      expect(summary.accounts).toHaveLength(2);
      // Register = 3 bước × 2 users (verify-email → verify-sms-otp → complete)
      const registers = gateway.requestLog.filter((r) => r.path.startsWith('/auth/register'));
      expect(registers.length).toBeGreaterThanOrEqual(6);
      const logins = gateway.requestLog.filter((r) => r.method === 'POST' && r.path === '/auth/login');
      expect(logins).toHaveLength(0);
    } finally {
      await gateway.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
