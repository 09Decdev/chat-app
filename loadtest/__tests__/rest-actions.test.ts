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

describe('rest-actions — community scoping (LOADTEST_COMMUNITY_ID)', () => {
  it('communityId set → like dùng postId từ endpoint community', async () => {
    const spy = vi.spyOn(httpModule, 'requestJson')
      .mockResolvedValueOnce(result({ ok: true, status: 200, failClass: 'OK', data: { items: [{ id: 'p-1', communityId: 'c-1' }] } }))
      .mockResolvedValueOnce(result({ ok: true, status: 200, failClass: 'OK' }));
    const driver = new RestDriver('http://localhost:3000', getEnv({ LOADTEST_COMMUNITY_ID: 'c-1' }));

    const r = await driver.likePost('tok');
    expect(spy).toHaveBeenCalledWith('http://localhost:3000', '/content-service/post/communityId/c-1?page=1&limit=20', expect.anything());
    expect(spy).toHaveBeenCalledWith('http://localhost:3000', '/content-service/like/post/p-1', expect.anything());
    expect(r.ok).toBe(true);
  });

  it('communityId set → comment dùng postId từ endpoint community', async () => {
    const spy = vi.spyOn(httpModule, 'requestJson')
      .mockResolvedValueOnce(result({ ok: true, status: 200, failClass: 'OK', data: { items: [{ id: 'p-2', communityId: 'c-1' }] } }))
      .mockResolvedValueOnce(result({ ok: true, status: 200, failClass: 'OK' }));
    const driver = new RestDriver('http://localhost:3000', getEnv({ LOADTEST_COMMUNITY_ID: 'c-1' }));

    const r = await driver.createComment('tok', 0);
    expect(spy).toHaveBeenCalledWith('http://localhost:3000', '/content-service/post/communityId/c-1?page=1&limit=20', expect.anything());
    expect(spy).toHaveBeenCalledWith('http://localhost:3000', '/content-service/comments/posts/p-2', expect.anything());
    expect(r.ok).toBe(true);
  });

  it('403 (không member) → fallback getAll + lọc local theo communityId', async () => {
    const items = Array.from({ length: 25 }, (_, i) => ({
      id: i < 5 ? `other-${i}` : `post-${i}`,
      communityId: i < 5 ? 'other-comm' : 'c-1',
    }));
    const spy = vi.spyOn(httpModule, 'requestJson')
      .mockResolvedValueOnce(result({ status: 403, failClass: 'FORBIDDEN', code: 'COMMUNITY_NOT_MEMBER' }))
      .mockResolvedValueOnce(result({ ok: true, status: 200, failClass: 'OK', data: { data: items } }))
      .mockResolvedValueOnce(result({ ok: true, status: 200, failClass: 'OK' }));
    const driver = new RestDriver('http://localhost:3000', getEnv({ LOADTEST_COMMUNITY_ID: 'c-1' }));

    const r = await driver.likePost('tok');
    expect(r.ok).toBe(true);
    const likeCalls = spy.mock.calls.filter(([, path]) => String(path).startsWith('/content-service/like/post/'));
    expect(likeCalls).toHaveLength(1);
    expect(String(likeCalls[0][1])).toMatch(/^\/content-service\/like\/post\/post-\d+$/); // chỉ post của c-1
  });

  it('items rỗng → fallback getAll + lọc local theo communityId', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `post-${i}`, communityId: 'c-1' }));
    const spy = vi.spyOn(httpModule, 'requestJson')
      .mockResolvedValueOnce(result({ ok: true, status: 200, failClass: 'OK', data: { items: [] } }))
      .mockResolvedValueOnce(result({ ok: true, status: 200, failClass: 'OK', data: { data: items } }))
      .mockResolvedValueOnce(result({ ok: true, status: 200, failClass: 'OK' }));
    const driver = new RestDriver('http://localhost:3000', getEnv({ LOADTEST_COMMUNITY_ID: 'c-1' }));

    const r = await driver.likePost('tok');
    expect(r.ok).toBe(true);
    const likeCalls = spy.mock.calls.filter(([, path]) => String(path).startsWith('/content-service/like/post/'));
    expect(likeCalls).toHaveLength(1);
    expect(String(likeCalls[0][1])).toMatch(/^\/content-service\/like\/post\/post-\d+$/);
  });

  it('không set communityId → vẫn /getAll (hành vi cũ)', async () => {
    const spy = vi.spyOn(httpModule, 'requestJson')
      .mockResolvedValueOnce(result({ ok: true, status: 200, failClass: 'OK', data: { data: [{ id: 'p-1' }] } }))
      .mockResolvedValueOnce(result({ ok: true, status: 200, failClass: 'OK' }));
    const driver = new RestDriver('http://localhost:3000', getEnv({ LOADTEST_COMMUNITY_ID: '' }));

    const r = await driver.viewPost('tok');
    expect(spy).toHaveBeenCalledWith('http://localhost:3000', '/content-service/post/getAll', expect.anything());
    expect(spy).toHaveBeenCalledWith('http://localhost:3000', '/content-service/post/p-1/view', expect.anything());
    expect(r.ok).toBe(true);
  });
});
