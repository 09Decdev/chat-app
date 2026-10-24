/**
 * Unit tests — routes/marketing.ts (Phòng marketing): proxy content-service internal API
 * (x-service-token), gắn inPool từ pool DB, map lỗi upstream. ctx giả + fetch mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as http from 'node:http';
import { marketingHandlers } from '../routes/marketing';
import type { RouteCtx } from '../http-server';

interface Captured {
  status: number;
  body: Record<string, unknown>;
}

function makeCtx(opts: { body?: unknown; url?: string; params?: Record<string, string>; env?: Record<string, string> } = {}) {
  const captured: Captured = { status: 0, body: {} };
  const ctx = {
    env: { gatewayUrl: 'http://gw', contentServiceUrl: 'http://cs', internalServiceToken: 'svc', ...opts.env },
    coordinator: { config: null, findAccountInMemory: () => null },
    store: {
      findPoolAccountsByIdentity: vi.fn(async () => ({ ok: true, rows: [{ email: 'pool@x', userId: 'u-pool' }] })),
      searchAccounts: vi.fn(async () => ({ ok: true, rows: [] })),
    },
    url: new URL(opts.url ?? 'http://lt/api/loadtest/chat-users?q=nguyen'),
    params: opts.params ?? {},
    readBody: async () => (opts.body ?? {}) as Record<string, unknown>,
    ok: (_res: unknown, data: unknown) => {
      captured.status = 200;
      captured.body = data as Record<string, unknown>;
    },
    fail: (_res: unknown, status: number, message: string, extra?: Record<string, unknown>) => {
      captured.status = status;
      captured.body = { message, ...extra };
    },
  } as unknown as RouteCtx;
  return { ctx, captured };
}

const req = {} as http.IncomingMessage;
const res = {} as http.ServerResponse;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('marketing routes', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('chat-users: gọi content-service search kèm token, gắn inPool theo userId/email', async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        success: true,
        data: [
          { id: 'u-pool', email: 'POOL@x', roomId: null, matchedBy: 'name' },
          { id: 'u-real', email: 'real@x', roomId: 'r1', matchedBy: 'name' },
        ],
      }),
    );
    const { ctx, captured } = makeCtx({ url: 'http://lt/api/loadtest/chat-users?q=Nguyễn' });
    await marketingHandlers.searchUsers(ctx, req, res);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://cs/content-service/internal/chat/users/search?q=${encodeURIComponent('Nguyễn')}&limit=20`);
    expect((init.headers as Record<string, string>)['x-service-token']).toBe('svc');
    const rows = captured.body.rows as Array<{ id: string; inPool: boolean; poolEmail: string | null; roomId: string | null }>;
    expect(rows.map((r) => [r.id, r.inPool, r.poolEmail, r.roomId])).toEqual([
      ['u-pool', true, 'pool@x', null],
      ['u-real', false, null, 'r1'],
    ]);
  });

  it('chat-users: q rỗng → [] không gọi upstream', async () => {
    const { ctx, captured } = makeCtx({ url: 'http://lt/api/loadtest/chat-users?q=%20' });
    await marketingHandlers.searchUsers(ctx, req, res);
    expect(captured.body).toEqual({ rows: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('chat-rooms: gắn inPool cho từng thành viên', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ success: true, data: [{ roomId: 'r1', memberCount: 2, capacity: 6, curated: true, members: [{ userId: 'u-pool' }, { userId: 'u-x' }] }] }),
    );
    const { ctx, captured } = makeCtx({ url: 'http://lt/api/loadtest/chat-rooms' });
    await marketingHandlers.listRooms(ctx, req, res);
    const room = (captured.body.rows as Array<{ members: Array<{ userId: string; inPool: boolean }> }>)[0];
    expect(room.members.map((m) => [m.userId, m.inPool])).toEqual([
      ['u-pool', true],
      ['u-x', false],
    ]);
  });

  it('tạo phòng: dedupe userIds, POST /chat/rooms', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true, data: { roomId: 'r9', roomEndsAt: 5 } }, 201));
    const { ctx, captured } = makeCtx({ body: { userIds: ['a', 'a', 'b'] } });
    await marketingHandlers.createRoom(ctx, req, res);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://cs/content-service/internal/chat/rooms');
    expect(JSON.parse(init.body as string)).toEqual({ userIds: ['a', 'b'] });
    expect(captured.body).toEqual({ roomId: 'r9', roomEndsAt: 5 });
  });

  it.each([[['a']], [['a', 'b', 'c', 'd', 'e', 'f', 'g']]])('tạo phòng %j → 400', async (userIds) => {
    const { ctx, captured } = makeCtx({ body: { userIds } });
    await marketingHandlers.createRoom(ctx, req, res);
    expect(captured.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('thêm vào phòng: 409 upstream giữ nguyên message', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'Phòng đã có 6/6 người — không đủ chỗ cho 1 người', error: 'BUSINESS_LOGIC_ERROR' }, 409));
    const { ctx, captured } = makeCtx({ body: { userIds: ['a'] }, params: { roomId: 'r 1' } });
    await marketingHandlers.addMembers(ctx, req, res);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('http://cs/content-service/internal/chat/rooms/r%201/members');
    expect(captured.status).toBe(409);
    expect(captured.body.message).toContain('6/6');
  });

  it('thiếu token → 400 hướng dẫn cấu hình', async () => {
    const { ctx, captured } = makeCtx({ env: { internalServiceToken: '' } });
    await marketingHandlers.searchUsers(ctx, req, res);
    expect(captured.status).toBe(400);
    expect(String(captured.body.message)).toContain('LOADTEST_INTERNAL_SERVICE_TOKEN');
  });
});
