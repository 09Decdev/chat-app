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

describe('rest-actions — post action (F3: join community PUBLIC trước, rồi POST)', () => {
  it('createPost: join 1 lần + POST /content-service/post đúng payload ([lt] content, CLASSIC)', async () => {
    const spy = vi.spyOn(httpModule, 'requestJson')
      .mockResolvedValueOnce(result({ ok: true, status: 200, failClass: 'OK', data: { id: 'member-1' } }))
      .mockResolvedValueOnce(result({ ok: true, status: 201, failClass: 'OK', data: { id: 'post-1' } }));
    const driver = new RestDriver('http://localhost:3000', getEnv({ LOADTEST_COMMUNITY_ID: 'c-1' }));

    const r = await driver.createPost('tok', 7);
    expect(r.ok).toBe(true);
    expect(r.code).toBe('');
    // 1) join community-public với đúng communityId
    expect(spy).toHaveBeenNthCalledWith(
      1,
      'http://localhost:3000',
      '/user-community/join-request/community-public',
      expect.objectContaining({ method: 'POST', body: { communityId: 'c-1' } }),
    );
    // 2) POST post đúng payload
    const postCall = spy.mock.calls[1];
    expect(postCall[1]).toBe('/content-service/post');
    const opts = postCall[2] as { method: string; body: { communityId: string; content: string; layoutType: string } };
    expect(opts.method).toBe('POST');
    expect(opts.body.communityId).toBe('c-1');
    expect(opts.body.content.startsWith('[lt]')).toBe(true);
    expect(opts.body.content.length).toBeLessThanOrEqual(100_000); // CreatePostDto
    expect(opts.body.layoutType).toBe('CLASSIC');
  });

  it('join chỉ 1 lần/user: đã member (400 "already a member") → coi như OK, không join lại', async () => {
    const spy = vi.spyOn(httpModule, 'requestJson')
      .mockResolvedValueOnce(result({ status: 400, failClass: 'CLIENT', code: '2001', message: 'You are already a member of this group' }))
      .mockResolvedValue(result({ ok: true, status: 201, failClass: 'OK' }));
    const driver = new RestDriver('http://localhost:3000', getEnv({ LOADTEST_COMMUNITY_ID: 'c-1' }));

    const r1 = await driver.createPost('tok', 1);
    const r2 = await driver.createPost('tok', 2);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    const joinCalls = spy.mock.calls.filter(([, p]) => String(p).includes('join-request'));
    expect(joinCalls).toHaveLength(1); // token đã trong joinedCommunity — lần 2 không join lại
    expect(spy.mock.calls.filter(([, p]) => String(p).includes('/content-service/post')).length).toBe(2);
  });

  it('join fail (community không PUBLIC) → vẫn thử post; 403 → fail đếm được, không crash', async () => {
    vi.spyOn(httpModule, 'requestJson')
      .mockResolvedValueOnce(result({ status: 400, failClass: 'CLIENT', code: 'BAD_REQUEST', message: 'community accessType is not PUBLIC' }))
      .mockResolvedValue(result({ status: 403, failClass: 'FORBIDDEN', code: 'PERMISSION_ERROR', message: 'You do not have permission!' }));
    const driver = new RestDriver('http://localhost:3000', getEnv({ LOADTEST_COMMUNITY_ID: 'c-1' }));

    const r = await driver.createPost('tok', 1);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('PERMISSION_ERROR');
    expect(r.failClass).toBe('FORBIDDEN');
  });

  it('chưa set LOADTEST_COMMUNITY_ID → NO_COMMUNITY_ID, KHÔNG gọi join/post', async () => {
    const spy = vi.spyOn(httpModule, 'requestJson');
    const driver = new RestDriver('http://localhost:3000', getEnv({ LOADTEST_COMMUNITY_ID: '' }));

    const r = await driver.createPost('tok', 1);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('NO_COMMUNITY_ID');
    expect(spy).not.toHaveBeenCalled();
  });
});
