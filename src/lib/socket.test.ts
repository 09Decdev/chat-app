import { describe, it, expect, vi, beforeEach } from 'vitest';

const ioMock = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: ioMock }));

import { socketManager } from '@/lib/socket';

describe('socket handshake — KHÔNG token trong query (SEC-3 / F-8)', () => {
  function fakeSocket() {
    return {
      on: vi.fn(),
      emit: vi.fn(),
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(),
      connected: false,
      id: 'sock-1',
    };
  }

  beforeEach(() => {
    ioMock.mockReset();
    socketManager.disconnect();
  });

  it('connect() gửi Authorization header + auth.token, KHÔNG query.token', () => {
    ioMock.mockReturnValue(fakeSocket());
    socketManager.connect('test-token');

    expect(ioMock).toHaveBeenCalledTimes(1);
    const [url, opts] = ioMock.mock.calls[0];
    expect(url).toBe('http://localhost:3000');
    expect(opts.path).toBe('/socket.io/');
    expect(opts.query).toBeUndefined(); // SEC-3: token KHÔNG trong query string
    expect(opts.extraHeaders.Authorization).toBe('Bearer test-token');
    // W3 T-08: `auth` (CONNECT packet) — browser native WS bỏ extraHeaders trên websocket
    // transport → auth là nguồn token đáng tin cậy ở MỌI transport.
    expect(opts.auth).toEqual({ token: 'test-token' });
  });
});