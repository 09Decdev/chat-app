/**
 * Unit tests — routes/marketing.ts (Phòng marketing: tạo phòng chỉ định account trong pool).
 * Mock login gateway + fetch content-service; ctx giả (không cần DB/HTTP server).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as http from 'node:http';

vi.mock('../auth-factory', () => ({
  loginOneAccount: vi.fn(async (_gw: string, email: string) => ({
    ok: true,
    accessToken: `tok-${email}`,
    refreshToken: 'r',
  })),
  decodeSub: vi.fn((tok: string) => `uid-${tok.replace('tok-', '')}`),
}));

import { marketingHandlers } from '../routes/marketing';
import { loginOneAccount } from '../auth-factory';
import type { RouteCtx } from '../http-server';

interface Captured {
  status: number;
  body: Record<string, unknown>;
}

function makeCtx(body: unknown, envOver: Partial<RouteCtx['env']> = {}) {
  const captured: Captured = { status: 0, body: {} };
  const ctx = {
    env: { gatewayUrl: 'http://gw', contentServiceUrl: 'http://cs', internalServiceToken: 'svc', ...envOver },
    coordinator: { config: null, findAccountInMemory: () => null },
    store: {
      findAccountByEmail: vi.fn(async (email: string) => ({
        ok: true,
        rows: email.startsWith('missing')
          ? []
          : [{ email, password: 'p', displayName: email.split('@')[0], deviceInfoJson: '{}' }],
      })),
      searchAccounts: vi.fn(async () => ({ ok: true, rows: [{ email: 'a@x', userId: 'u', displayName: 'A', gatewayUrl: 'http://gw' }] })),
    },
    url: new URL('http://lt/api/loadtest/accounts?q=a'),
    readBody: async () => body as Record<string, unknown>,
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
const EMAILS = ['a@x', 'b@x', 'c@x', 'd@x', 'e@x', 'f@x'];

describe('marketing-room', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { roomId: 'r1', roomEndsAt: 123 } }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(loginOneAccount).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('đăng nhập từng account → gọi internal API với đúng userIds + service token', async () => {
    const { ctx, captured } = makeCtx({ emails: EMAILS.map((e) => e.toUpperCase()) });
    await marketingHandlers.createRoom(ctx, req, res);

    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({ roomId: 'r1', roomEndsAt: 123 });
    expect((captured.body.members as unknown[]).length).toBe(6);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://cs/content-service/internal/chat/rooms');
    expect((init.headers as Record<string, string>)['x-service-token']).toBe('svc');
    expect(JSON.parse(init.body as string)).toEqual({ userIds: EMAILS.map((e) => `uid-${e}`) });
  });

  it.each([[['a@x']], [['a@x', 'A@x']], [[...EMAILS, 'g@x']]])('%j → 400, không gọi gì', async (emails) => {
    const { ctx, captured } = makeCtx({ emails });
    await marketingHandlers.createRoom(ctx, req, res);
    expect(captured.status).toBe(400);
    expect(loginOneAccount).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('thiếu service token → 400 hướng dẫn cấu hình', async () => {
    const { ctx, captured } = makeCtx({ emails: ['a@x', 'b@x'] }, { internalServiceToken: '' });
    await marketingHandlers.createRoom(ctx, req, res);
    expect(captured.status).toBe(400);
    expect(String(captured.body.message)).toContain('LOADTEST_INTERNAL_SERVICE_TOKEN');
  });

  it('account không có trong pool → 404, không tạo phòng', async () => {
    const { ctx, captured } = makeCtx({ emails: ['a@x', 'missing@x'] });
    await marketingHandlers.createRoom(ctx, req, res);
    expect(captured.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('content-service 409 → giữ 409, đổi userId trong message sang email', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'User uid-b@x đang ở phòng r9 — cần rời phòng trước', error: 'CHAT_ALREADY_SEATED' }), { status: 409 }),
    );
    const { ctx, captured } = makeCtx({ emails: ['a@x', 'b@x'] });
    await marketingHandlers.createRoom(ctx, req, res);
    expect(captured.status).toBe(409);
    expect(captured.body.message).toBe('User b@x đang ở phòng r9 — cần rời phòng trước');
  });

  it('GET accounts → rows từ store, không có password', async () => {
    const { ctx, captured } = makeCtx(undefined);
    await marketingHandlers.accounts(ctx, req, res);
    expect(captured.status).toBe(200);
    expect(JSON.stringify(captured.body)).not.toContain('password');
  });
});
