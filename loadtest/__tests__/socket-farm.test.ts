/**
 * Unit tests — Socket Farm pure helpers (profile picker + test content).
 * VirtualUser cần socket.io-client thật — chỉ test phần thuần.
 */
import { describe, it, expect, vi } from 'vitest';
import { pickProfile, VirtualUser, WorkerRuntime } from '../socket-farm';
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
