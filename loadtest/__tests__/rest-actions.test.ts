/**
 * Phase 4 council regression test — F-2: REST driver retry phải cover timeout/network.
 * Trước fix: exec() chỉ retry failClass='SERVER' → timeout/ECONNREFUSED (NETWORK) KHÔNG retry,
 * dù header comment tuyên bố "5xx/timeout retry 1×".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RestDriver } from '../rest-actions';
import * as httpModule from '../http';
import { getEnv } from '../config';

function result(over: Partial<httpModule.HttpResult> = {}): httpModule.HttpResult {
  return {
    ok: false, status: 0, data: null, code: '', message: '', failClass: 'NETWORK', latencyMs: 100,
    ...over,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('rest-actions — retry (F-2)', () => {
  it('timeout (NETWORK) → retried 1 lần; lần 2 ok → action thành công', async () => {
    const spy = vi.spyOn(httpModule, 'requestJson')
      .mockResolvedValueOnce(result({ code: 'TIMEOUT', message: 'timeout 15000ms' }))
      .mockResolvedValueOnce(result({ ok: true, status: 200, failClass: 'OK' }));
    const driver = new RestDriver('http://localhost:3000', getEnv({}));

    const r = await driver.readFeed('tok');
    expect(spy).toHaveBeenCalledTimes(2); // 1 retry
    expect(r.ok).toBe(true);
  });

  it('ECONNREFUSED (NETWORK) fail cả 2 lần → trả fail cuối (không retry vô hạn)', async () => {
    const spy = vi.spyOn(httpModule, 'requestJson')
      .mockResolvedValue(result({ code: 'NETWORK', message: 'fetch failed: ECONNREFUSED' }));
    const driver = new RestDriver('http://localhost:3000', getEnv({}));

    const r = await driver.readFeed('tok');
    expect(spy).toHaveBeenCalledTimes(2); // 1 retry, không 3+
    expect(r.ok).toBe(false);
    expect(r.failClass).toBe('NETWORK');
  });

  it('5xx SERVER → retried 1 lần (giữ hành vi cũ)', async () => {
    const spy = vi.spyOn(httpModule, 'requestJson')
      .mockResolvedValueOnce(result({ status: 503, failClass: 'SERVER', code: 'HTTP_503' }))
      .mockResolvedValueOnce(result({ ok: true, status: 200, failClass: 'OK' }));
    const driver = new RestDriver('http://localhost:3000', getEnv({}));

    const r = await driver.readFeed('tok');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(true);
  });

  it('4xx CLIENT → KHÔNG retry (RD-2 — retry client error vô ích)', async () => {
    const spy = vi.spyOn(httpModule, 'requestJson')
      .mockResolvedValue(result({ status: 400, failClass: 'CLIENT', code: 'HTTP_400' }));
    const driver = new RestDriver('http://localhost:3000', getEnv({}));

    const r = await driver.readFeed('tok');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(false);
    expect(r.failClass).toBe('CLIENT');
  });
});
