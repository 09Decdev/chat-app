/**
 * T-11 (G-7) — Mock gateway cho E2E: HTTP server (node:http) + socket.io server TỐI THIỂU.
 * KHÔNG phụ thuộc gateway thật. Implement đúng contract tối thiểu mà loadtest tool cần:
 *   - POST /auth/register/{verify-email,verify-sms-otp,complete} → envelope + tokens (auth-factory AF-1)
 *   - POST /auth/login → tokens (AF-4)
 *   - GET /content-service/post/getAll + post detail/comments/like/view/topic → feed (RestDriver)
 *   - POST /content-service/chat/match → matching:found qua socket của user (matching engine giả)
 *   - GET /content-service/chat/match/{my-room,queue-count} → trạng thái match
 *   - GET /metrics → Prometheus text (coordinator scrapeGatewayMetrics DB-3)
 *   - socket.io: connection có auth token → chat:join → chat:joined; chat:send → echo chat:message (clientMsgId)
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketIoServer, type Socket } from 'socket.io';

export interface MockRequestLog {
  method: string;
  path: string;
  hasAuth: boolean;
}

export interface MockGateway {
  /** Base URL http://127.0.0.1:{port} — đưa vào allowlist + config.gatewayUrl. */
  url: string;
  port: number;
  /** Mọi request HTTP vào mock (để assert tool gọi đúng contract). */
  requestLog: MockRequestLog[];
  /** Số socket.io connection có auth token hợp lệ (assert "connect với auth" — SEC-3/F-8). */
  socketConnections: number;
  /** token (accessToken) → socket — mock matching engine emit qua đây. */
  tokenSockets: Map<string, Socket>;
  stop(): Promise<void>;
}

/** Fake JWT — payload.sub cho auth-factory.decodeSub (mock không verify chữ ký). */
function fakeAccessToken(sub: string): string {
  const b64u = (s: string) => Buffer.from(s).toString('base64url');
  return `${b64u('{"alg":"none"}')}.${b64u(JSON.stringify({ sub }))}.${b64u('mock-sig')}`;
}

const POSTS = Array.from({ length: 5 }, (_, i) => ({ id: `post-${i + 1}`, content: `[lt] mock post ${i + 1}` }));

export async function startMockGateway(): Promise<MockGateway> {
  const handle: MockGateway = {
    url: '',
    port: 0,
    requestLog: [],
    socketConnections: 0,
    tokenSockets: new Map(),
    stop: async () => {},
  };
  /** token → roomId — matching engine giả (enqueue tạo match, my-room đọc lại). */
  const matched = new Map<string, string>();
  /** token → roomId đã match nhưng socket chưa kết nối (emit khi connect — tránh race). */
  const pendingMatch = new Map<string, string>();
  let wsConnections = 0;
  let wsMessages = 0;

  function authToken(req: http.IncomingMessage): string {
    return String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  }

  function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';
    const token = authToken(req);
    handle.requestLog.push({ method, path: url.pathname, hasAuth: token !== '' });

    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      // ── Auth register/login (auth-factory AF-1/AF-4) ───────────────────
      if (method === 'POST' && url.pathname === '/auth/register/verify-email') {
        return sendJson(res, 200, { success: true, registrationKey: 'rk-mock' });
      }
      if (method === 'POST' && url.pathname === '/auth/register/verify-sms-otp') {
        return sendJson(res, 200, { success: true, phoneKey: 'pk-mock' });
      }
      if (method === 'POST' && url.pathname === '/auth/register/complete') {
        const email = (() => {
          try {
            return String((JSON.parse(raw) as { email?: string }).email ?? 'user');
          } catch {
            return 'user';
          }
        })();
        return sendJson(res, 200, {
          success: true,
          data: { accessToken: fakeAccessToken(email), refreshToken: `rt-${email}` },
        });
      }
      if (method === 'POST' && url.pathname === '/auth/login') {
        return sendJson(res, 200, {
          success: true,
          data: { accessToken: fakeAccessToken('login-user'), refreshToken: 'rt-login' },
        });
      }

      // ── Feed + content (RestDriver RD-1..RD-4) ─────────────────────────
      if (method === 'GET' && url.pathname === '/content-service/post/getAll') {
        return sendJson(res, 200, { success: true, data: POSTS });
      }
      if (method === 'GET' && url.pathname.startsWith('/content-service/post/')) {
        return sendJson(res, 200, { success: true, data: { id: 'post-1', content: '[lt] mock detail' } });
      }
      if (method === 'POST' && url.pathname.endsWith('/view')) {
        return sendJson(res, 200, { success: true, data: {} });
      }
      if (url.pathname.startsWith('/content-service/comments/')) {
        if (method === 'GET') return sendJson(res, 200, { success: true, data: [] });
        return sendJson(res, 200, { success: true, data: { id: 'comment-1' } });
      }
      if (url.pathname.startsWith('/content-service/like/')) {
        return sendJson(res, 200, { success: true, data: {} });
      }

      // ── Chat matching (matching engine giả) ────────────────────────────
      if (method === 'POST' && url.pathname === '/content-service/chat/match') {
        if (!matched.has(token)) matched.set(token, `room-${matched.size + 1}`);
        const roomId = matched.get(token)!;
        const socket = handle.tokenSockets.get(token);
        if (socket?.connected) {
          socket.emit('matching:found', { roomId, roomEndsAt: Date.now() + 900_000 });
        } else {
          pendingMatch.set(token, roomId); // emit khi socket connect (tránh race)
        }
        return sendJson(res, 200, { success: true, data: { roomId } });
      }
      if (method === 'DELETE' && url.pathname === '/content-service/chat/match') {
        matched.delete(token);
        return sendJson(res, 200, { success: true, data: {} });
      }
      if (method === 'GET' && url.pathname === '/content-service/chat/match/my-room') {
        return sendJson(res, 200, { success: true, data: matched.has(token) ? { roomId: matched.get(token) } : {} });
      }
      if (method === 'GET' && url.pathname === '/content-service/chat/match/queue-count') {
        return sendJson(res, 200, { success: true, data: { count: 0 } });
      }
      if (method === 'PUT' && url.pathname.startsWith('/content-service/chat/rooms/')) {
        return sendJson(res, 200, { success: true, data: {} });
      }

      // ── Prometheus metrics (coordinator scrape DB-3) ───────────────────
      if (method === 'GET' && url.pathname === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        return res.end(`ws_connections ${wsConnections}\nws_messages_emitted_total ${wsMessages}\n`);
      }

      return sendJson(res, 404, { success: false, statusCode: 404, message: `mock: no route ${method} ${url.pathname}` });
    });
  });

  // ── Socket.io tối thiểu ──────────────────────────────────────────────────
  const io = new SocketIoServer(server, { cors: { origin: '*' } });
  io.use((socket, next) => {
    const token = String((socket.handshake.auth as { token?: unknown } | undefined)?.token ?? '');
    if (!token) return next(new Error('unauthorized'));
    handle.tokenSockets.set(token, socket);
    handle.socketConnections++;
    wsConnections++;
    const pendingRoom = pendingMatch.get(token);
    if (pendingRoom) {
      pendingMatch.delete(token);
      socket.emit('matching:found', { roomId: pendingRoom, roomEndsAt: Date.now() + 900_000 });
    }
    next();
  });
  io.on('connection', (socket) => {
    socket.on('chat:join', (p: { roomId?: string }) => {
      if (p?.roomId) socket.emit('chat:joined', { roomId: p.roomId, roomEndsAt: Date.now() + 900_000 });
    });
    socket.on('chat:send', (p: { roomId?: string; content?: string; clientMsgId?: string }) => {
      wsMessages++;
      // Echo về NGUỒN GỬI (client chỉ cần echo khớp clientMsgId — AC3.3).
      if (p?.clientMsgId) socket.emit('chat:message', { clientMsgId: p.clientMsgId, content: p.content, roomId: p.roomId });
    });
    // chat:typing / chat:error — mock không cần trả lời.
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  handle.url = `http://127.0.0.1:${port}`;
  handle.port = port;
  handle.stop = async () => {
    for (const s of handle.tokenSockets.values()) s.disconnect(true);
    handle.tokenSockets.clear();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  };
  return handle;
}
