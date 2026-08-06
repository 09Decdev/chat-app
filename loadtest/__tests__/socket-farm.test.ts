/**
 * Unit tests — Socket Farm pure helpers (profile picker + test content).
 * VirtualUser cần socket.io-client thật — chỉ test phần thuần.
 */
import { describe, it, expect, vi } from 'vitest';
import { pickProfile, VirtualUser, WorkerRuntime, classifyConnectError } from '../socket-farm';
import { getEnv } from '../config';
import { genChatContent, genCommentContent, genTopicTitle, genPassword, genDateOfBirth, genDeviceInfo, uuidV4, randomHex } from '../util';
import type { ActionProfile, TestAccount, WorkerTick, RunConfig } from '../types';
import type { ActionResult, RestDriver } from '../rest-actions';

const ioMock = vi.hoisted(() => vi.fn());
vi.mock('socket.io-client', () => ({ io: ioMock }));

const PROFILE: ActionProfile = { chat: 40, read: 30, comment: 20, like: 10, view: 0 };

const TEST_ACCOUNT: TestAccount = {
  email: 'user1@test.local',
  password: 'Abc123!@',
  userId: 'u1',
  accessToken: 'tok-1',
  refreshToken: 'ref-1',
  displayName: 'User 1',
  deviceInfo: {
    installationId: '00000000-0000-4000-8000-000000000001',
    deviceFingerprint: 'a'.repeat(64),
    platform: 'web',
    deviceName: 'test',
  },
  dateOfBirth: '2000-01-01',
  country: 'VN',
  registeredAt: 0,
};

describe('socket handshake — KHÔNG token trong query (SEC-3 / F-8)', () => {
  it('VirtualUser.connect() gửi Authorization header + auth.token, KHÔNG query.token', () => {
    ioMock.mockReset();
    const fakeSocket = {
      on: vi.fn(),
      emit: vi.fn(),
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(),
      connected: false,
    };
    ioMock.mockReturnValue(fakeSocket);
    const u = new VirtualUser(0, TEST_ACCOUNT, 'chat', 'http://localhost:3000');
    u.connect();
    expect(ioMock).toHaveBeenCalledTimes(1);
    const [url, opts] = ioMock.mock.calls[0];
    expect(url).toBe('ws://localhost:3000');
    expect(opts.query).toBeUndefined(); // SEC-3: token KHÔNG trong query string
    expect(opts.extraHeaders.Authorization).toBe('Bearer tok-1');
    expect(opts.auth).toEqual({ token: 'tok-1' }); // W3 T-08: auth phủ ws package path
    // G2: cấu hình kết nối cố định — path chuẩn, websocket-only, reconnect bật (kills 151/152/158)
    expect(opts.path).toBe('/socket.io/');
    expect(opts.transports).toEqual(['websocket']);
    expect(opts.reconnection).toBe(true);
  });
});

describe('pickProfile (AC4.1)', () => {
  it('phân phối đúng theo % (sai số ~1%)', () => {
    const counts: Record<string, number> = { chat: 0, read: 0, comment: 0, like: 0, view: 0 };
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const p = pickProfile(PROFILE);
      counts[p]++;
    }
    for (const [k, v] of Object.entries(PROFILE)) {
      const pct = (counts[k] / N) * 100;
      expect(Math.abs(pct - v)).toBeLessThan(1.5);
    }
  });

  it('profile chat 100% → luôn chat', () => {
    const p: ActionProfile = { chat: 100, read: 0, comment: 0, like: 0, view: 0 };
    for (let i = 0; i < 100; i++) expect(pickProfile(p)).toBe('chat');
  });

  it('profile 0% → fallback read (không crash)', () => {
    const p: ActionProfile = { chat: 0, read: 0, comment: 0, like: 0, view: 0 };
    expect(pickProfile(p)).toBe('read');
  });
});

describe('test content (RD-3 — sạch profanity, prefix [lt])', () => {
  it('genChatContent có prefix [lt] và ổn định theo index', () => {
    const a = genChatContent(3);
    const b = genChatContent(3);
    expect(a.startsWith('[lt]')).toBe(true);
    expect(a).toBe(b);
    expect(genChatContent(4)).not.toBe(a);
  });

  it('genCommentContent có prefix [lt] + ≤ 2000 ký tự', () => {
    const c = genCommentContent(7);
    expect(c.startsWith('[lt]')).toBe(true);
    expect(c.length).toBeLessThanOrEqual(2000);
  });

  it('genTopicTitle 3–80 code point', () => {
    const t = genTopicTitle(12);
    expect(t.length).toBeGreaterThanOrEqual(3);
    expect(t.length).toBeLessThanOrEqual(80);
  });
});

describe('account generators (AC2.1 — đúng contract gateway-auth-service)', () => {
  it('genPassword đạt isValidPassword (≥8 ký tự, ≥3/4 nhóm)', () => {
    for (let i = 0; i < 50; i++) {
      const p = genPassword();
      expect(p.length).toBeGreaterThanOrEqual(8);
      const has = (re: RegExp) => re.test(p);
      const groups = [has(/[a-z]/), has(/[A-Z]/), has(/[0-9]/), has(/[^a-zA-Z0-9]/)].filter(Boolean).length;
      expect(groups).toBeGreaterThanOrEqual(3);
    }
  });

  it('genDateOfBirth ≥ 16 tuổi (isAtLeast16)', () => {
    const dob = genDateOfBirth(); // 1995-2004
    const year = Number(dob.slice(0, 4));
    expect(year).toBeGreaterThanOrEqual(1995);
    expect(year).toBeLessThanOrEqual(2004);
  });

  it('genDeviceInfo đúng regex deviceInfo.dto.ts', () => {
    const d = genDeviceInfo('ltrun1', 5);
    expect(d.installationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(d.deviceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(d.platform).toBe('web');
    expect(d.deviceName.length).toBeLessThanOrEqual(100);
  });

  it('uuidV4 hợp lệ + randomHex 64 hex', () => {
    expect(uuidV4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(randomHex(32)).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ─── Action state + toRow (bảng users v1.1) ────────────────────────────────

function makeUser(index: number, email: string, phase: VirtualUser['phase'] = 'connected') {
  const u = new VirtualUser(index, { ...TEST_ACCOUNT, email, userId: `u${index}` }, 'chat', 'http://localhost:3000');
  u.phase = phase;
  return u;
}

// ─── T3 — cap retry 5 consecutive MỌI user (F-1) + skip user failed (M7) ─────

/** Tạo user đã connect() với socket giả — trả về handlers để mô phỏng event socket.io. */
function connectUser(index: number, email: string) {
  ioMock.mockReset();
  const handlers = new Map<string, (p?: unknown) => void>();
  const manager = { reconnection: vi.fn() };
  const socket = {
    on: vi.fn((evt: string, h: (p?: unknown) => void) => handlers.set(evt, h)),
    emit: vi.fn(),
    removeAllListeners: vi.fn(),
    disconnect: vi.fn(),
    connected: false,
    io: manager,
  };
  ioMock.mockReturnValue(socket);
  const u = makeUser(index, email);
  u.connect();
  return { u, handlers, socket, manager };
}

function fireConnectErrors(handlers: Map<string, (p?: unknown) => void>, n: number) {
  for (let i = 0; i < n; i++) handlers.get('connect_error')?.({ message: `err-${i}` } as Error);
}

describe('T3 — cap retry 5 consecutive MỌI user (F-1, DESIGN §5.1)', () => {
  it('(T3-1) user CHƯA từng connected: 5 connect_error liên tiếp → phase failed, counters đúng', () => {
    const { u, handlers } = connectUser(0, 'never@test.local');
    expect(u.phase).toBe('connecting');
    expect(u.everConnected).toBe(false);
    fireConnectErrors(handlers, 5);
    expect(u.phase).toBe('failed');
    expect(u.consecutiveConnectFails).toBe(5);
    expect(u.runtimeStats.connectAttempts).toBe(5);
    expect(u.runtimeStats.connectFails).toBe(5);
    expect(u.runtimeStats.connectFailsByType.other).toBe(5); // T3 nối chỗ gọi — mặc định 'other'
  });

  it('(T3-2/F-1) user ĐÃ everConnected: 5 connect_error liên tiếp → phase failed (cap áp mọi user)', () => {
    const { u, handlers } = connectUser(0, 'ever@test.local');
    handlers.get('connect')?.(); // đã từng connect thành công
    expect(u.everConnected).toBe(true);
    expect(u.consecutiveConnectFails).toBe(0);
    fireConnectErrors(handlers, 5);
    // F-1 regression: trước đây điều kiện !everConnected bỏ qua user này → retry vô hạn.
    expect(u.phase).toBe('failed');
    expect(u.runtimeStats.connectAttempts).toBe(6); // 1 success + 5 fail
    expect(u.runtimeStats.connectFails).toBe(5);
    expect(u.lastError).toContain('failed sau 5 connect_error');
  });

  it('(R4/e) dừng reconnect THẬT: socket.disconnect() + io.reconnection(false), connect() không re-invoke, không còn fail mới', () => {
    const { u, handlers, socket, manager } = connectUser(0, 'stop@test.local');
    fireConnectErrors(handlers, 5);
    expect(u.phase).toBe('failed');
    // 1) chặn manager retry — socket.io-client 4.8.3: Manager.reconnection(false)
    //    (DESIGN ghi io.reconnect(false) — API v3; v4 private no-arg — implement theo v4)
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.reconnection).toHaveBeenCalledWith(false);
    // 2) connect_error sau failed: KHÔNG đếm gì (guard đầu handler)
    fireConnectErrors(handlers, 3);
    expect(u.runtimeStats.connectAttempts).toBe(5);
    expect(u.runtimeStats.connectFails).toBe(5);
    expect(u.consecutiveConnectFails).toBe(5);
    expect(u.phase).toBe('failed');
    // 3) KHÔNG null this.socket → connect() lần nữa không tạo socket mới (no re-invoke)
    u.connect();
    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(u.phase).toBe('failed');
  });

  it('(T3-3) consecutive reset: fail 3 → connect OK → fail 4 KHÔNG failed (reset), fail 5 → failed', () => {
    const { u, handlers } = connectUser(0, 'transient@test.local');
    fireConnectErrors(handlers, 3);
    expect(u.consecutiveConnectFails).toBe(3);
    expect(u.phase).not.toBe('failed');
    handlers.get('connect')?.(); // thành công → reset streak
    expect(u.consecutiveConnectFails).toBe(0);
    expect(u.everConnected).toBe(true);
    // fail thứ 2 trong streak mới: nếu KHÔNG reset (3+2=5) đã cutover nhầm — đây là điểm chứng minh
    fireConnectErrors(handlers, 2);
    expect(u.consecutiveConnectFails).toBe(2);
    expect(u.phase).not.toBe('failed');
    fireConnectErrors(handlers, 2); // tổng 4 trong streak mới
    expect(u.consecutiveConnectFails).toBe(4);
    expect(u.phase).not.toBe('failed'); // transient vẫn retry — chưa tới cap
    fireConnectErrors(handlers, 1); // fail thứ 5 trong streak mới → cutover
    expect(u.phase).toBe('failed');
    expect(u.consecutiveConnectFails).toBe(5);
    expect(u.runtimeStats.connectFails).toBe(8); // 3 trước reset + 5 sau reset
  });

  it('(T3-4) emitTick: usersFailed = số user failed — đếm 1 lần/user, không đổi qua các tick', () => {
    const rt = new WorkerRuntime(0, getEnv());
    rt.config = { targetUsers: 3 } as RunConfig;
    const u1 = makeUser(0, 'fail-a@test.local');
    u1.phase = 'failed';
    const u2 = makeUser(1, 'fail-b@test.local');
    u2.phase = 'failed';
    const u3 = makeUser(2, 'ok@test.local', 'connected');
    rt.users = [u1, u2, u3];
    const msgs: unknown[] = [];
    rt.onMessage = (msg) => msgs.push(msg);
    (rt as unknown as { emitTick: (final?: boolean) => void }).emitTick();
    (rt as unknown as { emitTick: (final?: boolean) => void }).emitTick();
    expect(msgs).toHaveLength(2);
    const tick1 = (msgs[0] as { type: string; tick: WorkerTick }).tick.counters;
    const tick2 = (msgs[1] as { type: string; tick: WorkerTick }).tick.counters;
    expect(tick1.usersFailed).toBe(2);
    expect(tick2.usersFailed).toBe(2); // không đếm lại qua tick
    expect(tick1.usersConnected).toBe(0); // failed không vào connected/active
    expect(tick1.usersActive).toBe(1); // chỉ user connected còn lại
  });

  it('(T3-5/M7) scheduler bỏ qua user failed — không enqueue, không REST, phase giữ failed', () => {
    const { u, handlers } = connectUser(0, 'skip@test.local');
    u.profile = 'chat';
    fireConnectErrors(handlers, 5);
    expect(u.phase).toBe('failed');
    // user failed có mọi điều kiện "sẵn sàng enqueue" — nếu không guard sẽ bị resurrect về queued
    u.cooldownUntil = 0;
    (u as unknown as { lastEnqueueAt: number }).lastEnqueueAt = 0;
    // user khỏe mạnh cùng worker — chứng minh guard chỉ chặn failed, không chặn cả loop
    const healthy = makeUser(1, 'healthy@test.local', 'idle');
    healthy.profile = 'chat';
    healthy.cooldownUntil = 0;
    (healthy as unknown as { lastEnqueueAt: number }).lastEnqueueAt = 0;
    healthy.lastRestAt = Date.now(); // tránh REST pacing trong tick này
    const rt = new WorkerRuntime(0, getEnv());
    rt.users = [u, healthy];
    const enqueueSpy = vi.spyOn(rt.rest, 'chatEnqueue');
    const readSpy = vi.spyOn(rt.rest, 'readPostDetail').mockResolvedValue({
      detail: { ok: true, latencyMs: 5, code: '', failClass: 'OK' },
      view: null,
    } as unknown as Awaited<ReturnType<RestDriver['readPostDetail']>>);
    (rt as unknown as { schedulerTick: () => void }).schedulerTick();
    expect(u.phase).toBe('failed'); // không bị resurrect về queued
    expect(readSpy).not.toHaveBeenCalled(); // failed user không REST
    // user khỏe vẫn chạy bình thường — ensureChatCycle enqueue OK
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(healthy.phase).toBe('queued');
  });

  it('(T3-6) disconnect() sau failed không đổi phase', () => {
    const { u, handlers } = connectUser(0, 'd@test.local');
    fireConnectErrors(handlers, 5);
    expect(u.phase).toBe('failed');
    u.disconnect(); // worker stop path — removeAllListeners + socket.disconnect + null
    expect(u.phase).toBe('failed');
  });

  it('(S-2) connect về muộn sau failed — KHÔNG resurrect, KHÔNG reset cap', () => {
    const { u, handlers, socket } = connectUser(0, 'late@test.local');
    fireConnectErrors(handlers, 5);
    expect(u.phase).toBe('failed');
    // connect in-flight về sau cutover (race gateway flip-flop — S-2 R2)
    handlers.get('connect')?.();
    expect(u.phase).toBe('failed'); // không resurrect về connected/in_room
    expect(u.consecutiveConnectFails).toBe(5); // không reset cap — chu kỳ cap không khởi động lại
    expect(u.everConnected).toBe(false);
    expect(u.socketConnected).toBe(false);
    expect(socket.disconnect).toHaveBeenCalledTimes(2); // cutover + đóng socket connect-muộn
  });
});

describe('T4 — classifyConnectError (DESIGN §6 heuristic — PLAN T4)', () => {
  it('timeout: type===\'TimeoutError\' + /timeout/i', () => {
    expect(classifyConnectError({ type: 'TimeoutError', message: 'timeout' })).toBe('timeout');
    expect(classifyConnectError(new Error('connection timeout after 20000ms'))).toBe('timeout');
    expect(classifyConnectError('plain timeout string')).toBe('timeout');
  });

  it('transport: /xhr poll error|transport/i', () => {
    expect(classifyConnectError(new Error('xhr poll error'))).toBe('transport');
    expect(classifyConnectError({ message: 'websocket transport failed' })).toBe('transport');
  });

  it('reject: /websocket error|server|handshake|reject/i (gồm auth-reject)', () => {
    expect(classifyConnectError(new Error('websocket error'))).toBe('reject');
    expect(classifyConnectError(new Error('invalid token: handshake rejected'))).toBe('reject');
    expect(classifyConnectError(new Error('unexpected server response'))).toBe('reject');
  });

  it('other: không khớp heuristic', () => {
    expect(classifyConnectError(new Error('connection refused'))).toBe('other');
  });

  it('thứ tự spec: timeout → transport → reject', () => {
    expect(classifyConnectError({ message: 'xhr poll error with timeout' })).toBe('timeout');
    expect(classifyConnectError({ message: 'websocket error: transport failed' })).toBe('transport');
  });

  it('fuzz (ST-5): không throw với mọi input, luôn 1 trong 4 loại', () => {
    const inputs: unknown[] = [
      null, undefined, 42, 'plain string', {}, { message: null }, { message: 123 },
      { message: 'x'.repeat(10_000) }, { message: 'a\nb\x00c' }, [], new Error('xhr poll error'),
    ];
    for (const input of inputs) {
      expect(['timeout', 'transport', 'reject', 'other']).toContain(classifyConnectError(input));
    }
    expect(classifyConnectError({ message: 'x'.repeat(10_000) })).toBe('other');
  });
});

describe('T4 — byType sum + recordError sanitize/cap + lastError sink (P2/F-4/S-3/S-4)', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

  function rtCollectingTick(users: VirtualUser[]) {
    const rt = new WorkerRuntime(0, getEnv());
    rt.config = { targetUsers: users.length } as RunConfig;
    rt.users = users;
    const msgs: unknown[] = [];
    rt.onMessage = (m) => msgs.push(m);
    return { rt, msgs };
  }

  it('(P2) emitTick sum byType per-user — invariant sum(byType) == connectFails', () => {
    const { u, handlers } = connectUser(0, 'inv@test.local');
    handlers.get('connect_error')?.({ message: 'timeout after 20000ms' } as Error); // timeout
    handlers.get('connect_error')?.(new Error('xhr poll error')); // transport
    handlers.get('connect_error')?.(new Error('xhr poll error')); // transport
    handlers.get('connect_error')?.(new Error('invalid token: handshake rejected')); // reject
    handlers.get('connect_error')?.(new Error('websocket error')); // reject — fail thứ 5 → cutover
    expect(u.phase).toBe('failed');
    const { rt, msgs } = rtCollectingTick([u]);
    (rt as unknown as { emitTick: () => void }).emitTick();
    const counters = (msgs[0] as { tick: WorkerTick }).tick.counters;
    expect(counters.connectFailsByType).toEqual({ timeout: 1, transport: 2, reject: 2, other: 0 });
    const sum = Object.values(counters.connectFailsByType).reduce((a, b) => a + b, 0);
    expect(sum).toBe(counters.connectFails); // invariant card breakdown
    expect(counters.usersFailed).toBe(1);
  });

  it('(S-3) lastError từ connect_error sanitize + cap 160 (F-2)', () => {
    const { u, handlers } = connectUser(0, 's3@test.local');
    const evil = 'sneaky\nnext(err) password=TopSecret!' + 'y'.repeat(500);
    handlers.get('connect_error')?.({ message: evil } as Error);
    expect(u.lastError).not.toMatch(/\n/);
    expect(u.lastError!.length).toBeLessThanOrEqual(160);
    expect(u.lastError).not.toContain('TopSecret');
    expect(u.lastError).toContain('password=[REDACTED]');
  });

  it('(M4/ST-6) recordError action \'connect\' + message sanitize', () => {
    const u = makeUser(0, 'a@test.local');
    const { rt, msgs } = rtCollectingTick([u]);
    rt.recordError('E_CODE', `forged\n[lt][ERROR] fake password=TopSecret! token=${JWT}`, u, 'connect');
    (rt as unknown as { emitTick: () => void }).emitTick();
    const tick = (msgs[0] as { tick: WorkerTick }).tick;
    expect(tick.errorSamples[0].action).toBe('connect');
    expect(tick.errorSamples[0].message).not.toMatch(/\n/);
    expect(tick.errorSamples[0].message).not.toContain('TopSecret');
    expect(tick.errorSamples[0].message).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(tick.errorSamples[0].message.length).toBeLessThanOrEqual(160);
    expect(tick.errorSamples[0].code).toBe('E_CODE');
  });

  it('(F-4) code quá dài → cap 64 (TOP ERRORS không bị bloat)', () => {
    const u = makeUser(0, 'a@test.local');
    const { rt, msgs } = rtCollectingTick([u]);
    rt.recordError('X'.repeat(100), 'msg', u);
    (rt as unknown as { emitTick: () => void }).emitTick();
    const errors = (msgs[0] as { tick: WorkerTick }).tick.errors;
    const code = Object.keys(errors)[0];
    expect(code.length).toBeLessThanOrEqual(64);
  });

  it('(S-4) errorCounters cap: > 20 code lạ → đếm vào OTHER, map bounded', () => {
    const u = makeUser(0, 'a@test.local');
    const { rt, msgs } = rtCollectingTick([u]);
    for (let i = 0; i < 30; i++) rt.recordError(`CODE_${i}`, 'msg', u);
    (rt as unknown as { emitTick: () => void }).emitTick();
    const errors = (msgs[0] as { tick: WorkerTick }).tick.errors;
    expect(Object.keys(errors).length).toBeLessThanOrEqual(21); // 20 code + bucket OTHER
    expect(errors.OTHER).toBe(10); // 10 code vượt cap chảy vào OTHER
    expect(errors.CODE_0).toBe(1);
    expect(errors.CODE_19).toBe(1);
  });

  it('(F-4/ST-6) chat:error code/message độc → lastError + errorSamples sạch (backward compat action chat)', () => {
    const { u, handlers } = connectUser(0, 'f4@test.local');
    const { rt, msgs } = rtCollectingTick([u]);
    u.onError = (code, message, action) => rt.recordError(code, message, u, action); // wiring như start()
    handlers.get('chat:error')?.({ code: 'X\nEVIL=' + 'A'.repeat(100), message: 'bad\ntoken=xyz' });
    expect(u.lastError).not.toMatch(/\n/);
    expect(u.lastError!.length).toBeLessThanOrEqual(160);
    (rt as unknown as { emitTick: () => void }).emitTick();
    const tick = (msgs[0] as { tick: WorkerTick }).tick;
    expect(tick.errorSamples[0].action).toBe('chat'); // default backward compat
    expect(tick.errorSamples[0].code.length).toBeLessThanOrEqual(64);
    expect(tick.errorSamples[0].message).not.toContain('token=xyz');
    // G2 (kills 262/263): code/message KHÔNG được drop khỏi lastError/errorSamples
    expect(u.lastError).toContain('X');
    expect(u.lastError).toContain('token=[REDACTED]');
    expect(tick.errorSamples[0].code).toContain('X');
  });
});

describe('F-T7-2 — kênh B: io server disconnect (gateway reject thật)', () => {
  it('accept-then-drop: connect rồi io server disconnect → 1 fail reject + phase failed NGAY + usersFailed=1', () => {
    const { u, handlers, socket } = connectUser(0, 'kb@test.local');
    handlers.get('connect')?.(); // gateway accept — attempt đếm ở đây
    expect(u.runtimeStats.connectAttempts).toBe(1);
    handlers.get('disconnect')?.('io server disconnect');
    // cutover NGAY (kênh B terminal — KHÔNG cần chờ cap 5; socket.io v4.8.3 không retry reason này)
    expect(u.phase).toBe('failed');
    expect(u.runtimeStats.connectAttempts).toBe(1); // KHÔNG tăng attempt — đã đếm ở 'connect'
    expect(u.runtimeStats.connectFails).toBe(1); // 1 reject-fail
    expect(u.runtimeStats.connectFailsByType.reject).toBe(1);
    expect(u.reconnectCount).toBe(0); // KHÔNG reconnectCount++
    expect(u.socketConnected).toBe(false);
    expect(u.lastError).toContain('io server disconnect');
    expect(socket.io.reconnection).toHaveBeenCalledWith(false); // chặn mọi retry (an toàn kép)
    // connect_error sau failed: không đếm (guard) — không fail thêm
    handlers.get('connect_error')?.({ message: 'x' } as Error);
    expect(u.runtimeStats.connectFails).toBe(1);
    // usersFailed == 1 qua emitTick
    const rt = new WorkerRuntime(0, getEnv());
    rt.config = { targetUsers: 1 } as RunConfig;
    rt.users = [u];
    const msgs: unknown[] = [];
    rt.onMessage = (m) => msgs.push(m);
    (rt as unknown as { emitTick: () => void }).emitTick();
    const counters = (msgs[0] as { tick: WorkerTick }).tick.counters;
    expect(counters.usersFailed).toBe(1);
    expect(counters.connectFails).toBe(1);
    expect(counters.connectFailsByType).toEqual({ timeout: 0, transport: 0, reject: 1, other: 0 });
  });

  it('các reason khác (transport close/error, ping timeout, parse error, io client disconnect) KHÔNG đếm fail', () => {
    const { u, handlers } = connectUser(0, 'kbc@test.local');
    handlers.get('connect')?.();
    const reasons = ['transport close', 'transport error', 'ping timeout', 'parse error', 'io client disconnect'] as const;
    for (const reason of reasons) {
      handlers.get('disconnect')?.(reason);
      expect(u.phase).not.toBe('failed');
      expect(u.runtimeStats.connectFails).toBe(0); // không fail giả từ disconnect tự nhiên/drain
    }
    expect(u.reconnectCount).toBe(5); // retry kênh C bình thường (reconnectCount++)
    expect(u.runtimeStats.connectFailsByType.reject).toBe(0);
    expect(u.phase).toBe('connecting'); // G2: non-terminal disconnect → phase 'connecting' (kills 202)
  });

  it('io server disconnect không có connect trước (server drop ngay) vẫn đếm đúng 1 reject-fail', () => {
    const { u, handlers } = connectUser(0, 'kbd@test.local');
    handlers.get('disconnect')?.('io server disconnect');
    expect(u.phase).toBe('failed');
    expect(u.runtimeStats.connectAttempts).toBe(0); // chưa có connect — attempt 0
    expect(u.runtimeStats.connectFails).toBe(1);
    expect(u.runtimeStats.connectFailsByType.reject).toBe(1);
  });
});

describe('VirtualUser — action state + toRow', () => {
  it('toRow() trả đủ field mới với giá trị mặc định (chưa hành động)', () => {
    const u = makeUser(3, 'user3@test.local');
    const row = u.toRow();
    expect(row).toMatchObject({
      index: 3,
      email: 'user3@test.local',
      phase: 'connected',
      currentAction: null,
      lastActionAt: null,
      lastActionMs: null,
      messagesSent: 0,
      messagesEchoed: 0,
      roomId: null,
      socketConnected: false,
      reconnectCount: 0,
      outboxPending: 0,
      lastError: null,
    });
  });

  it('markActionStart gán currentAction + lastActionAt; markActionEnd → idle + lastActionMs', () => {
    const u = makeUser(0, 'a@test.local');
    const before = Date.now();
    u.markActionStart('chat');
    expect(u.currentAction).toBe('chat');
    expect(u.lastActionAt).toBeGreaterThanOrEqual(before);
    u.markActionEnd('chat', 150);
    expect(u.currentAction).toBe('idle');
    expect(u.lastActionMs).toBe(150);
  });

  it('markActionEnd action khác đang chạy → không ghi đè currentAction (chỉ cập nhật lastActionMs)', () => {
    const u = makeUser(0, 'a@test.local');
    u.markActionStart('typing');
    u.markActionEnd('chat', 500); // chat không phải action đang chạy
    expect(u.currentAction).toBe('typing');
    expect(u.lastActionMs).toBe(500);
  });

  it('sendChat: currentAction=chat + messagesSent++, echo → messagesEchoed++ + idle (AC3.3)', () => {
    ioMock.mockReset();
    const handlers = new Map<string, (p: unknown) => void>();
    const fakeSocket = {
      on: vi.fn((evt: string, h: (p: unknown) => void) => handlers.set(evt, h)),
      emit: vi.fn(),
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(),
      connected: true,
    };
    ioMock.mockReturnValue(fakeSocket);
    const u = makeUser(0, 'a@test.local');
    u.connect();
    u.roomId = 'room-1';
    const rt = new WorkerRuntime(0, getEnv());
    u.sendChat(rt);
    expect(u.messagesSent).toBe(1);
    expect(u.currentAction).toBe('chat');
    expect(u.lastActionAt).not.toBeNull();
    // echo khớp clientMsgId
    const sent = fakeSocket.emit.mock.calls.find((c) => c[0] === 'chat:send')!;
    const clientMsgId = sent[1].clientMsgId;
    handlers.get('chat:message')?.({ clientMsgId });
    expect(u.messagesEchoed).toBe(1);
    expect(u.currentAction).toBe('idle');
    expect(u.lastActionMs).toBeGreaterThanOrEqual(0);
    expect(u.lastActionMs).toBeLessThan(60_000); // G2: latency = now - sentAt (kills 255)
  });

  it('toRow phản ánh action state + counters đang chạy', () => {
    const u = makeUser(1, 'b@test.local', 'in_room');
    u.markActionStart('chat');
    u.messagesSent = 3;
    u.messagesEchoed = 2;
    u.roomId = 'room-9';
    u.reconnectCount = 4;
    u.lastError = 'NO_ECHO_TIMEOUT';
    expect(u.toRow()).toMatchObject({
      phase: 'in_room',
      currentAction: 'chat',
      messagesSent: 3,
      messagesEchoed: 2,
      roomId: 'room-9',
      reconnectCount: 4,
      lastError: 'NO_ECHO_TIMEOUT',
    });
  });

  // ─── FIX-2: currentAction không kẹt 'chat' khi phase rời queued ───────────────

  it('MATCH_TIMEOUT → phase idle + currentAction về idle (FIX-2)', () => {
    const u = makeUser(0, 'a@test.local');
    u.phase = 'queued';
    u.markActionStart('chat'); // đang chờ matching — bảng users thấy "Đang chat"
    (u as unknown as { queuedAt: number }).queuedAt = Date.now() - 61_000; // > MATCH_WAIT_MS 60s
    const rt = new WorkerRuntime(0, getEnv());
    u.tick(Date.now(), rt);
    expect(u.phase).toBe('idle');
    expect(u.currentAction).toBe('idle');
    expect(u.toRow().currentAction).toBe('idle'); // dashboard không còn "Đang chat" cho user rảnh
    expect(u.lastError).toContain('MATCH_TIMEOUT');
  });

  it('enqueue fail THROTTLED (429) → phase cooldown + currentAction idle (FIX-2)', async () => {
    const u = makeUser(0, 'a@test.local');
    u.profile = 'chat';
    u.phase = 'idle';
    u.markActionStart('chat');
    u.cooldownUntil = 0;
    (u as unknown as { lastEnqueueAt: number }).lastEnqueueAt = 0;
    const rt = new WorkerRuntime(0, getEnv());
    vi.spyOn(rt.rest, 'chatEnqueue').mockResolvedValue({
      ok: false, latencyMs: 10, code: 'CHAT_COOLDOWN_ACTIVE', failClass: 'THROTTLED',
    } as ActionResult);
    await u.ensureChatCycle(rt, Date.now());
    expect(u.phase).toBe('cooldown');
    expect(u.cooldownUntil).toBeGreaterThan(0);
    expect(u.toRow().currentAction).toBe('idle');
    expect(u.lastError).toContain('CHAT_COOLDOWN_ACTIVE');
  });

  it('enqueue fail thường → phase idle + currentAction idle (FIX-2)', async () => {
    const u = makeUser(0, 'a@test.local');
    u.profile = 'chat';
    u.phase = 'idle';
    u.markActionStart('chat');
    u.cooldownUntil = 0;
    (u as unknown as { lastEnqueueAt: number }).lastEnqueueAt = 0;
    const rt = new WorkerRuntime(0, getEnv());
    vi.spyOn(rt.rest, 'chatEnqueue').mockResolvedValue({
      ok: false, latencyMs: 5, code: 'ERR_UPSTREAM', failClass: 'SERVER',
    } as ActionResult);
    await u.ensureChatCycle(rt, Date.now());
    expect(u.phase).toBe('idle');
    expect(u.toRow().currentAction).toBe('idle');
  });
});

describe('WorkerRuntime.queryUsers — filter + sort + phaseCounts', () => {
  function rtWithUsers() {
    const rt = new WorkerRuntime(0, getEnv());
    rt.users = [
      makeUser(0, 'b@test.local', 'in_room'),
      makeUser(1, 'c@test.local', 'queued'),
      makeUser(2, 'a@test.local', 'idle'),
      makeUser(3, 'b-2@test.local', 'in_room'),
    ];
    return rt;
  }

  it('sortBy index desc (default asc khi thiếu)', () => {
    const rt = rtWithUsers();
    expect(rt.queryUsers(0, 10, undefined, undefined, 'index', 'desc').rows.map((r) => r.index)).toEqual([3, 2, 1, 0]);
    expect(rt.queryUsers(0, 10).rows.map((r) => r.index)).toEqual([0, 1, 2, 3]);
  });

  it('sortBy phase asc + total đúng', () => {
    const rt = rtWithUsers();
    const res = rt.queryUsers(0, 10, undefined, undefined, 'phase', 'asc');
    expect(res.rows.map((r) => r.phase)).toEqual(['idle', 'in_room', 'in_room', 'queued']);
    expect(res.total).toBe(4);
  });

  it('sortBy lạ → mặc định index asc (whitelist)', () => {
    const rt = rtWithUsers();
    expect(rt.queryUsers(0, 10, undefined, undefined, 'DROP TABLE users', 'asc').rows.map((r) => r.index)).toEqual([0, 1, 2, 3]);
  });

  it('filter email + sort kết hợp', () => {
    const rt = rtWithUsers();
    const res = rt.queryUsers(0, 10, 'b', undefined, 'email', 'asc');
    expect(res.rows.map((r) => r.email)).toEqual(['b-2@test.local', 'b@test.local']);
    expect(res.total).toBe(2);
  });

  it('filter + offset/limit phân trang đúng', () => {
    const rt = rtWithUsers();
    const res = rt.queryUsers(1, 1, 'b', undefined, 'index', 'asc');
    expect(res.rows.map((r) => r.email)).toEqual(['b-2@test.local']);
    expect(res.total).toBe(2);
  });

  it('phase param lọc chính xác + kết hợp filter email', () => {
    const rt = rtWithUsers();
    const byPhase = rt.queryUsers(0, 10, undefined, 'in_room', 'index', 'asc');
    // index asc: b@ (index 0) trước b-2@ (index 3)
    expect(byPhase.rows.map((r) => r.email)).toEqual(['b@test.local', 'b-2@test.local']);
    expect(byPhase.total).toBe(2);
    const both = rt.queryUsers(0, 10, 'c@', 'in_room', 'index', 'asc');
    expect(both.rows).toEqual([]); // email chứa 'c@' nhưng phase khác in_room
    expect(both.total).toBe(0);
  });

  it('phaseCounts đếm TOÀN BỘ user (không theo filter)', () => {
    const rt = rtWithUsers();
    const res = rt.queryUsers(0, 10, 'b');
    expect(res.total).toBe(2); // filter trả 2
    expect(res.phaseCounts).toEqual({ in_room: 2, queued: 1, idle: 1 }); // nhưng counts = 4 user
  });
});

// ─── G2 (hard-gate fix E2) — diệt mutant critical: connect handler state ────

describe('G2 — connect handler: state sau connect + re-join (173/174/179)', () => {
  it('connect thành công lần đầu: socketConnected true, phase connected, KHÔNG emit chat:join (chưa có room)', () => {
    const { u, handlers, socket } = connectUser(0, 'g2a@test.local');
    handlers.get('connect')?.();
    expect(u.socketConnected).toBe(true); // mutant → false
    expect(u.phase).toBe('connected'); // mutant → '' (174)
    expect(socket.emit).not.toHaveBeenCalled(); // mutant 179 true → emit chat:join với roomId null
  });

  it('reconnect có roomId: phase in_room + emit chat:join (reconcile PRD §1.2)', () => {
    const { u, handlers, socket } = connectUser(0, 'g2b@test.local');
    u.roomId = 'room-1';
    handlers.get('connect')?.();
    expect(u.phase).toBe('in_room'); // mutant → '' (174)
    expect(socket.emit).toHaveBeenCalledWith('chat:join', { roomId: 'room-1' }); // mutant 179 false → không emit
  });
});

describe('G2 — disconnect sau cutover: phase failed là TERMINAL, không resurrect (186)', () => {
  it('sau cap-5: disconnect ("io client disconnect") → phase giữ failed, reconnectCount không tăng', () => {
    const { u, handlers } = connectUser(0, 'g2d@test.local');
    fireConnectErrors(handlers, 5);
    expect(u.phase).toBe('failed');
    handlers.get('disconnect')?.('io client disconnect'); // socket.disconnect() sau cutover bắn reason này
    expect(u.phase).toBe('failed'); // mutant → 'connecting' (resurrect)
    expect(u.reconnectCount).toBe(0); // mutant → 1
    expect(u.runtimeStats.connectFails).toBe(5);
  });

  it('sau kênh B: io server disconnect lần 2 → không đếm reject thêm (guard chặn)', () => {
    const { u, handlers } = connectUser(0, 'g2e@test.local');
    u.onError = vi.fn(); // mở sink errorSamples — 'reject'/'io server disconnect'/'connect' (kills 196 strings)
    handlers.get('disconnect')?.('io server disconnect');
    expect(u.phase).toBe('failed');
    expect(u.runtimeStats.connectFails).toBe(1);
    expect(u.onError).toHaveBeenCalledWith('reject', 'io server disconnect', 'connect');
    handlers.get('disconnect')?.('io server disconnect'); // guard phase==='failed' phải chặn
    expect(u.phase).toBe('failed');
    expect(u.runtimeStats.connectFails).toBe(1); // mutant → 2
    expect(u.runtimeStats.connectFailsByType.reject).toBe(1); // mutant → 2
    expect(u.onError).toHaveBeenCalledTimes(1); // lần 2 bị guard chặn
  });
});

describe('G2 — emitTick: byType sum + phase counting (780/785/754/756/757/758/759)', () => {
  function rtWith(users: VirtualUser[]) {
    const rt = new WorkerRuntime(0, getEnv());
    rt.config = { targetUsers: users.length } as RunConfig;
    rt.users = users;
    const msgs: unknown[] = [];
    rt.onMessage = (m) => msgs.push(m);
    return { rt, msgs };
  }

  it('2 users mixed byType → connectAttempts/Fails đúng + sum(byType) == connectFails (780/785)', () => {
    const a = connectUser(0, 'g2suma@test.local');
    a.u.onError = vi.fn(); // mở sink errorSamples — action 'connect' (kills 215:38 string)
    a.handlers.get('connect_error')?.({ type: 'TimeoutError', message: 'timeout' } as unknown as Error); // timeout
    expect(a.u.onError).toHaveBeenCalledWith('timeout', 'timeout', 'connect');
    a.handlers.get('connect_error')?.(new Error('xhr poll error')); // transport
    a.handlers.get('connect_error')?.(new Error('connection refused')); // other
    const b = connectUser(1, 'g2sumb@test.local');
    b.handlers.get('connect_error')?.(new Error('invalid token: handshake rejected')); // reject
    b.handlers.get('connect_error')?.(new Error('websocket error')); // reject
    b.handlers.get('connect_error')?.(new Error('conn refused 1')); // other
    b.handlers.get('connect_error')?.(new Error('conn refused 2')); // other
    const { rt, msgs } = rtWith([a.u, b.u]);
    (rt as unknown as { emitTick: () => void }).emitTick();
    const counters = (msgs[0] as { tick: WorkerTick }).tick.counters;
    expect(counters.connectAttempts).toBe(7); // mutant -= → -1
    expect(counters.connectFails).toBe(7);
    expect(counters.connectFailsByType).toEqual({ timeout: 1, transport: 1, reject: 2, other: 3 });
    const sum = Object.values(counters.connectFailsByType).reduce((x, y) => x + y, 0);
    expect(sum).toBe(counters.connectFails); // SEC-1 invariant — mutant other -= → -1
  });

  it('emitTick đếm phase đúng cho mọi phase (754/757/758/759)', () => {
    const users = [
      makeUser(0, 'g2p0@test.local', 'in_room'),
      makeUser(1, 'g2p1@test.local', 'queued'),
      makeUser(2, 'g2p2@test.local', 'connected'),
      makeUser(3, 'g2p3@test.local', 'idle'),
      makeUser(4, 'g2p4@test.local', 'cooldown'),
      makeUser(5, 'g2p5@test.local', 'failed'),
      makeUser(6, 'g2p6@test.local', 'connecting'), // không thuộc nhóm active — mutant 759 true mới tính
    ];
    users[0].reconnectCount = 2; // sum reconnect chính xác
    const { rt, msgs } = rtWith(users);
    (rt as unknown as { emitTick: () => void }).emitTick();
    const counters = (msgs[0] as { tick: WorkerTick }).tick.counters;
    expect(counters.usersInRoom).toBe(1);
    expect(counters.usersQueued).toBe(1);
    expect(counters.usersActive).toBe(4); // in_room + connected + idle + cooldown
    expect(counters.usersFailed).toBe(1);
    expect(counters.usersConnected).toBe(0); // chưa ai fire connect
    expect(counters.reconnectCount).toBe(2); // mutant -= → -2
  });

  it('emitTick: user đã connect → usersConnected = 1 (756)', () => {
    const { u, handlers } = connectUser(0, 'g2conn@test.local');
    handlers.get('connect')?.();
    expect(u.socketConnected).toBe(true);
    const { rt, msgs } = rtWith([u]);
    (rt as unknown as { emitTick: () => void }).emitTick();
    expect((msgs[0] as { tick: WorkerTick }).tick.counters.usersConnected).toBe(1); // mutant false → 0
  });

  it('emitTick: user phase connecting (ngoài nhóm active) KHÔNG đếm active (kills 759 !== mutants)', () => {
    // mutant `u.phase === 'idle'` → `!==`: connecting không thuộc {connected,idle,cooldown}
    // lại được đếm qua !B — test chỉ có user connecting để lộ sự khác biệt (không có idle bù trừ).
    const { rt, msgs } = rtWith([makeUser(0, 'g2connonly@test.local', 'connecting')]);
    (rt as unknown as { emitTick: () => void }).emitTick();
    const counters = (msgs[0] as { tick: WorkerTick }).tick.counters;
    expect(counters.usersActive).toBe(0); // mutant !== → 1
    expect(counters.usersConnected).toBe(0);
  });

  it('emitTick chưa có config → không emit gì (kills 749 guard)', () => {
    const rt = new WorkerRuntime(0, getEnv());
    rt.users = [makeUser(0, 'g2noconfig@test.local')];
    const msgs: unknown[] = [];
    rt.onMessage = (m) => msgs.push(m);
    (rt as unknown as { emitTick: () => void }).emitTick();
    expect(msgs).toHaveLength(0); // mutant `if (!this.config)` → false → emit tick nhầm
  });
});

describe('G2 — recordError cap errorSamples (745)', () => {
  it('30 mẫu qua recordError → errorSamples giữ 20, không phình', () => {
    const u = makeUser(0, 'g2cap@test.local');
    const rt = new WorkerRuntime(0, getEnv());
    rt.config = { targetUsers: 1 } as RunConfig;
    rt.users = [u];
    const msgs: unknown[] = [];
    rt.onMessage = (m) => msgs.push(m);
    for (let i = 0; i < 30; i++) rt.recordError(`C${i}`, 'msg', u);
    (rt as unknown as { emitTick: () => void }).emitTick();
    const tick = (msgs[0] as { tick: WorkerTick }).tick;
    expect(tick.errorSamples).toHaveLength(20); // mutant không shift → 30; mutant >= → 19
    expect(tick.errorSamples[0].code).toBe('C10'); // FIFO shift đúng
  });
});

describe('G2 — matching:found / chat:joined / room lifecycle handlers (231/240/266/267)', () => {
  it('matching:found → phase in_room + roomId + emit chat:join', () => {
    const { u, handlers, socket } = connectUser(0, 'g2mf@test.local');
    handlers.get('matching:found')?.({ roomId: 'room-m', roomEndsAt: 1234 });
    expect(u.phase).toBe('in_room');
    expect(u.roomId).toBe('room-m');
    expect(u.roomEndsAt).toBe(1234);
    expect(socket.emit).toHaveBeenCalledWith('chat:join', { roomId: 'room-m' });
  });

  it('chat:joined → phase in_room + roomId + roomEndsAt 1234 (kills 243 ?? → &&)', () => {
    const { u, handlers } = connectUser(0, 'g2cj@test.local');
    handlers.get('chat:joined')?.({ roomId: 'room-j', roomEndsAt: 1234 });
    expect(u.phase).toBe('in_room');
    expect(u.roomId).toBe('room-j');
    expect(u.roomEndsAt).toBe(1234); // mutant `p.roomEndsAt && null` → null ≠ 1234
  });

  it('matching:found thiếu roomId → KHÔNG đổi state, KHÔNG emit (kills 232 guard)', () => {
    const { u, handlers, socket } = connectUser(0, 'g2mfguard@test.local');
    handlers.get('matching:found')?.({ roomEndsAt: 1234 }); // mutant !p?.roomId → false → vẫn đổi state
    expect(u.phase).toBe('connecting'); // giữ nguyên — mutant → 'in_room'
    expect(u.roomId).toBeNull();
    expect(socket.emit).not.toHaveBeenCalled();
    // payload undefined → KHÔNG throw (mutant p?.roomId → p.roomId → TypeError)
    expect(() => handlers.get('matching:found')?.()).not.toThrow();
  });

  it('chat:joined thiếu roomId → KHÔNG đổi state (kills 241 guard)', () => {
    const { u, handlers } = connectUser(0, 'g2cjguard@test.local');
    handlers.get('chat:joined')?.({ roomEndsAt: 1234 });
    expect(u.phase).toBe('connecting'); // mutant → 'in_room'
    expect(u.roomId).toBeNull();
    // payload undefined → KHÔNG throw (mutant p?.roomId → p.roomId → TypeError)
    expect(() => handlers.get('chat:joined')?.()).not.toThrow();
  });

  it('roomExpired → leaveRoom: cooldown + outbox sạch + roomId null', () => {
    const { u, handlers } = connectUser(0, 'g2re@test.local');
    u.roomId = 'room-x';
    u.outbox.set('m1', { clientMsgId: 'm1', sentAt: Date.now() });
    handlers.get('roomExpired')?.();
    expect(u.phase).toBe('cooldown');
    expect(u.roomId).toBeNull();
    expect(u.outbox.size).toBe(0);
    expect(u.cooldownUntil).toBeGreaterThan(0);
    expect(u.lastError).toContain('ROOM_EXPIRED');
  });

  it('chat:room_closed → leaveRoom: cooldown', () => {
    const { u, handlers } = connectUser(0, 'g2rc@test.local');
    u.roomId = 'room-y';
    handlers.get('chat:room_closed')?.();
    expect(u.phase).toBe('cooldown');
    expect(u.roomId).toBeNull();
    expect(u.lastError).toContain('ROOM_CLOSED');
  });
});

describe('G2 — echo: id lạ không crash + trim chat:error (251/262)', () => {
  it('chat:message clientMsgId KHÔNG trong outbox → không throw, không đếm echo (251)', () => {
    ioMock.mockReset();
    const handlers = new Map<string, (p?: unknown) => void>();
    const fakeSocket = {
      on: vi.fn((evt: string, h: (p?: unknown) => void) => handlers.set(evt, h)),
      emit: vi.fn(),
      removeAllListeners: vi.fn(),
      disconnect: vi.fn(),
      connected: true,
    };
    ioMock.mockReturnValue(fakeSocket);
    const u = makeUser(0, 'g2echo@test.local');
    u.connect();
    handlers.get('chat:message')?.({ clientMsgId: 'khong-ton-tai' }); // mutant if(pending)=true → pending.sentAt throw
    expect(u.messagesEchoed).toBe(0);
    // payload undefined → KHÔNG throw (mutant p?.clientMsgId → p.clientMsgId → TypeError)
    expect(() => handlers.get('chat:message')?.()).not.toThrow();
    expect(u.messagesEchoed).toBe(0);
  });

  it('chat:error payload undefined → không throw, fallback code ERROR + message rỗng (kills 262/263 chaining + fallback)', () => {
    const { u, handlers } = connectUser(0, 'g2ctnone@test.local');
    u.onError = vi.fn(); // mở sink — template `chat:${p?.code ?? 'ERROR'}` phải evaluate
    expect(() => handlers.get('chat:error')?.()).not.toThrow(); // mutant p?.code/p?.message → TypeError
    expect(u.lastError).toBe('chat:error'); // mutant `p?.message ?? ''` → 'Stryker was here!' → khác
    expect(u.onError).toHaveBeenCalledWith('chat:ERROR', 'chat:error'); // mutant 'ERROR' → '' → khác
  });

  it('echo thành công → onEchoOk nhận latency thật < 60s (kills 256 +)', () => {
    const { u, handlers } = connectUser(0, 'g2echo2@test.local');
    const onEchoOk = vi.fn();
    u.onEchoOk = onEchoOk;
    u.outbox.set('m1', { clientMsgId: 'm1', sentAt: Date.now() - 1000 });
    handlers.get('chat:message')?.({ clientMsgId: 'm1' });
    expect(u.messagesEchoed).toBe(1);
    expect(onEchoOk).toHaveBeenCalledTimes(1);
    expect(onEchoOk.mock.calls[0][0] as number).toBeLessThan(60_000); // mutant + → ~1.7e12 ms
  });

  it('chat:error message có trailing space → trim đúng (262 MethodExpression trim)', () => {
    const { u, handlers } = connectUser(0, 'g2ct@test.local');
    handlers.get('chat:error')?.({ message: 'boom ' });
    expect(u.lastError).toBe('chat:error  boom'); // mutant bỏ trim → 'chat:error  boom ' (giữ trailing space)
  });
});

describe('G2 — classifyConnectError corner inputs (76/78/80)', () => {
  it('type TimeoutError nhưng message không chứa "timeout" → vẫn timeout (nhánh type-only)', () => {
    expect(classifyConnectError({ type: 'TimeoutError', message: 'connection refused' })).toBe('timeout');
  });

  it('message non-string coerce khớp heuristic → KHÔNG classify (other) (78)', () => {
    expect(classifyConnectError({ message: { toString: () => 'handshake rejected' } })).toBe('other');
  });

  it('err non-string non-object (Symbol) → KHÔNG throw, trả other (80)', () => {
    expect(classifyConnectError(Symbol('timeout'))).toBe('other');
  });
});
