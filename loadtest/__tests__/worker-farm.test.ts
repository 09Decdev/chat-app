/**
 * T-07 FIX-3 — worker env KHÔNG kế thừa LOGTEST_LOG_FILE (JSONL sink multi-process unsafe).
 * Forked worker mỗi process giữ rotation counter riêng → append/rotate race trên cùng file.
 */
import { describe, it, expect } from 'vitest';
import { workerEnv } from '../worker-farm';

describe('worker-farm — workerEnv (FIX-3)', () => {
  it('worker env không kế thừa LOGTEST_LOG_FILE (gán \'\' để logger skip JSONL sink)', () => {
    const env = workerEnv(3);
    expect(env.LOGTEST_LOG_FILE).toBe('');
    expect(env.LOADTEST_WORKER_ID).toBe('3');
  });

  it('worker env giữ nguyên phần còn lại của process.env (chỉ bỏ LOG_FILE)', () => {
    const before = { ...process.env, LOADTEST_GATEWAY_URL: 'http://localhost:3000' };
    process.env.LOADTEST_GATEWAY_URL = 'http://localhost:3000';
    const env = workerEnv(1);
    expect(env.LOADTEST_GATEWAY_URL).toBe('http://localhost:3000');
    expect(env.LOADTEST_WORKER_ID).toBe('1');
    expect(env.LOGTEST_LOG_FILE).toBe('');
    // restore
    if (before.LOADTEST_GATEWAY_URL) process.env.LOADTEST_GATEWAY_URL = before.LOADTEST_GATEWAY_URL;
    else delete process.env.LOADTEST_GATEWAY_URL;
  });
});