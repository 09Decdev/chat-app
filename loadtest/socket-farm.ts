/**
 * MAYogu LoadTest Tool — Socket Farm (SF-1..SF-5) + REST Driver runtime (worker-side).
 *
 * Worker process giữ N virtual user; mỗi user:
 * - connect socket.io-client (websocket-only, query token + Authorization header —
 *   đúng websocket.gateway.ts:142-149), reconnect 1s→10s, re-join room sau reconnect.
 * - chat cycle: enqueue → matching:found (timeout 60s) → chat:join → chat:joined →
 *   chat:send kèm clientMsgId → SUCCESS = echo chat:message cùng clientMsgId (TTL 60s)
 *   → roomExpired/room_closed → cooldown 900s (SF-4 pacing tôn trọng rate-limit thật).
 * - REST actions theo profile (read/comment/like/view) với pacing + jitter.
 *
 * Hiệu năng: 1 scheduler 100ms chung (không setInterval/user); outbox có giới hạn
 * (backpressure — PRD §5.1); histogram log-scale (metrics.ts).
 */

import { io, type Socket } from 'socket.io-client';
import type { RunConfig, TestAccount, VirtualUserRow, WorkerTick } from './types';
import { ACTION_TYPES } from './types';
import type { LoadTestEnv } from './config';
import { BucketedHistogram, HISTOGRAM_BUCKETS } from './metrics';
import { RestDriver, type ActionResult } from './rest-actions';
import { genChatContent, genTopicTitle, jitter, ltLog, normalizeUrl, sleep, uuidV4 } from './util';
import * as os from 'node:os';

export type UserPhase = 'provisioned' | 'connecting' | 'connected' | 'queued' | 'in_room' | 'idle' | 'cooldown' | 'failed';

const MATCH_WAIT_MS = 60_000; // timeout chờ matching:found (PRD AC3.2)
const ECHO_TTL_MS = 60_000; // echo TTL (SF-5)
const CHAT_SEND_MIN_MS = 2000; // 1 msg/2s/user (chat-message.service.ts:82-92)
const TYPING_DEBOUNCE_MS = 1500;
const TOPIC_MIN_MS = 15_000;
const COOLDOWN_MS = 900_000; // CHAT_LEAVE_COOLDOWN_SECONDS 900
const REST_READ_INTERVAL_MS = 3000;
const REST_COMMENT_INTERVAL_MS = 10_000;
const REST_LIKE_INTERVAL_MS = 15_000;
const REST_VIEW_INTERVAL_MS = 5000;

interface PendingMsg {
  clientMsgId: string;
  sentAt: number;
}

export type Profile = 'chat' | 'read' | 'comment' | 'like' | 'view';

/** Chọn profile lúc sinh theo % (AC4.1). */
export function pickProfile(profile: RunConfig['profile']): Profile {
  const r = Math.random() * 100;
  let acc = 0;
  const entries: [Profile, number][] = [
    ['chat', profile.chat],
    ['read', profile.read],
    ['comment', profile.comment],
    ['like', profile.like],
    ['view', profile.view],
  ];
  for (const [name, pct] of entries) {
    acc += pct;
    if (r < acc) return name;
  }
  return 'read';
}

/** 1 virtual user — vòng đời theo SE-2. */
export class VirtualUser {
  readonly index: number;
  readonly account: TestAccount;
  profile: Profile;
  phase: UserPhase = 'provisioned';
  roomId: string | null = null;
  roomEndsAt: number | null = null;
  socketConnected = false;
  reconnectCount = 0;
  cooldownUntil = 0;
  lastSendAt = 0;
  lastTypingAt = 0;
  lastTopicAt = 0;
  lastRestAt = 0;
  lastError: string | null = null;
  outbox = new Map<string, PendingMsg>();
  private socket: Socket | null = null;
  private wsUrl: string;

  constructor(index: number, account: TestAccount, profile: Profile, gatewayUrl: string) {
    this.index = index;
    this.account = account;
    this.profile = profile;
    this.wsUrl = normalizeUrl(gatewayUrl).replace(/^http/, 'ws');
  }

  connect() {
    if (this.socket) return;
    this.phase = 'connecting';
    const token = this.account.accessToken;
    this.socket = io(this.wsUrl, {
      path: '/socket.io/',
      transports: ['websocket'], // SF-1: bỏ polling giảm overhead
      query: { token },
      extraHeaders: { Authorization: `Bearer ${token}` },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
      timeout: 20_000,
    });
    const s = this.socket;

    s.on('connect', () => {
      this.socketConnected = true;
      this.phase = this.roomId ? 'in_room' : 'connected';
      this.runtimeStats.connectAttempts++;
      // Reconcile trên reconnect (PRD §1.2): nếu đang trong phòng → re-join
      if (this.roomId) {
        s.emit('chat:join', { roomId: this.roomId });
      }
    });

    s.on('disconnect', () => {
      this.socketConnected = false;
      if (this.phase !== 'failed') {
        this.phase = 'connecting';
        this.reconnectCount++;
      }
    });

    s.on('connect_error', (err: Error) => {
      this.lastError = `connect_error: ${err.message}`;
      // mỗi lần thử reconnect (thành công hay không) đều là 1 attempt → fail rate chính xác
      this.runtimeStats.connectAttempts++;
      this.runtimeStats.connectFails++;
    });

    s.on('matching:found', (p: { roomId: string; roomEndsAt?: number | null }) => {
      if (!p?.roomId) return;
      this.roomId = p.roomId;
      this.roomEndsAt = p.roomEndsAt ?? null;
      this.phase = 'in_room';
      this.lastSendAt = Date.now(); // tránh send ngay vừa vào phòng
      s.emit('chat:join', { roomId: p.roomId });
    });

    s.on('chat:joined', (p: { roomId: string; roomEndsAt?: number | null }) => {
      if (!p?.roomId) return;
      this.roomId = p.roomId;
      this.roomEndsAt = p.roomEndsAt ?? null;
      this.phase = 'in_room';
      this.lastSendAt = Date.now();
    });

    s.on('chat:message', (p: { clientMsgId?: string }) => {
      if (p?.clientMsgId) {
        const pending = this.outbox.get(p.clientMsgId);
        if (pending) {
          // AC3.3: SUCCESS = echo chat:message cùng clientMsgId — đo latency end-to-end
          this.outbox.delete(p.clientMsgId);
          this.onEchoOk?.(Date.now() - pending.sentAt);
        }
      }
    });

    s.on('chat:error', (p: { code?: string; message?: string }) => {
      this.lastError = `chat:error ${p?.code ?? ''} ${p?.message ?? ''}`.trim();
      this.onError?.(`chat:${p?.code ?? 'ERROR'}`, this.lastError);
    });

    s.on('roomExpired', () => this.leaveRoom('ROOM_EXPIRED'));
    s.on('chat:room_closed', () => this.leaveRoom('ROOM_CLOSED'));
  }

  /** Sự kiện ngoài (worker runtime) — tránh callback lồng nhau. */
  onEchoOk: ((latencyMs: number) => void) | null = null;
  onError: ((code: string, message: string) => void) | null = null;
  /** Stats rẻ tiền cho auto-stop (connect attempts/fails) — đọc trong emitTick. */
  readonly runtimeStats = { connectAttempts: 0, connectFails: 0 };

  private leaveRoom(reason: string) {
    this.roomId = null;
    this.roomEndsAt = null;
    this.outbox.clear();
    this.cooldownUntil = Date.now() + COOLDOWN_MS;
    this.phase = 'cooldown';
    this.lastError = `leaveRoom(${reason})`;
  }

  /** Scheduler 100ms — trả về 1 action cần chạy (null = chưa đến lúc). */
  tick(now: number, worker: WorkerRuntime): { action: 'send' | 'typing' | 'topic' | 'rest' } | null {
    // Timeout chờ matching (AC3.2): 60s không thấy matching:found → backoff 30s rồi thử lại
    if (this.phase === 'queued' && now - this.queuedAt > MATCH_WAIT_MS) {
      this.phase = 'idle';
      this.lastError = 'MATCH_TIMEOUT: không nhận matching:found trong 60s';
      worker.recordAction('chat', MATCH_WAIT_MS, false, this, 'MATCH_TIMEOUT');
      this.cooldownUntil = now + 30_000; // tránh thundering herd retry 3s/user
      this.queuedAt = 0;
      return null;
    }
    if (this.phase === 'in_room') {
      if (
        now - this.lastSendAt >= CHAT_SEND_MIN_MS + jitter(400, 0.5) &&
        this.outbox.size < worker.env.maxPendingOutbox
      ) {
        this.lastSendAt = now;
        return { action: 'send' };
      }
      if (this.profile === 'chat' && now - this.lastTypingAt >= TYPING_DEBOUNCE_MS) {
        this.lastTypingAt = now;
        return { action: 'typing' };
      }
      if (this.profile === 'chat' && now - this.lastTopicAt >= TOPIC_MIN_MS && Math.random() < 0.2) {
        this.lastTopicAt = now;
        return { action: 'topic' };
      }
      return null;
    }
    // REST pacing ngoài phòng (kể cả cooldown — giữ tải)
    if ((this.phase === 'connected' || this.phase === 'cooldown' || this.phase === 'idle') && now - this.lastRestAt >= this.restInterval()) {
      this.lastRestAt = now;
      return { action: 'rest' };
    }
    return null;
  }

  private restInterval(): number {
    switch (this.profile) {
      case 'read': return jitter(REST_READ_INTERVAL_MS);
      case 'comment': return jitter(REST_COMMENT_INTERVAL_MS);
      case 'like': return jitter(REST_LIKE_INTERVAL_MS);
      case 'view': return jitter(REST_VIEW_INTERVAL_MS);
      default: return jitter(REST_READ_INTERVAL_MS * 2); // chat user khi cooldown đọc nhẹ
    }
  }

  sendChat(worker: WorkerRuntime) {
    if (!this.socket?.connected || !this.roomId) return;
    const clientMsgId = uuidV4();
    const content = genChatContent(this.index);
    this.outbox.set(clientMsgId, { clientMsgId, sentAt: Date.now() });
    this.socket.emit('chat:send', { roomId: this.roomId, content, clientMsgId });
    // AC3.3: chỉ tính "attempt" ngay lúc emit — success/fail quyết định bởi echo/không-echo
    worker.onChatSent(this);
  }

  sendTyping(worker: WorkerRuntime) {
    if (!this.socket?.connected || !this.roomId) return;
    this.socket.emit('chat:typing', { roomId: this.roomId });
    worker.recordAction('typing', 0, true, this, 'chat:typing');
  }

  /** Dọn outbox hết TTL → đếm no-echo (rate-limited / Kafka chậm) — PRD AC3.3. */
  pruneOutbox(now: number, worker: WorkerRuntime) {
    if (this.outbox.size === 0) return;
    for (const [id, p] of this.outbox) {
      if (now - p.sentAt > ECHO_TTL_MS) {
        this.outbox.delete(id);
        worker.onNoEcho(this, 'chat');
      }
    }
  }

  async runRest(worker: WorkerRuntime) {
    if (this.profile === 'chat') {
      // chat profile ngoài phòng/cooldown: chỉ đọc nhẹ
      await worker.rest.readPostDetail(this.account.accessToken).then((r) => {
        worker.recordResult('read', r.detail, this);
      });
      return;
    }
    const driver = worker.rest;
    let res: ActionResult;
    switch (this.profile) {
      case 'read': {
        const r = await driver.readPostDetail(this.account.accessToken);
        worker.recordResult('read', r.detail, this);
        if (r.view) worker.recordResult('view', r.view, this);
        return;
      }
      case 'comment': {
        if (Math.random() < 0.6) {
          res = await driver.createComment(this.account.accessToken, this.index);
          worker.recordResult('comment', res, this);
        } else {
          res = await driver.readComments(this.account.accessToken);
          worker.recordResult('comment', res, this);
        }
        return;
      }
      case 'like': {
        res = await driver.likePost(this.account.accessToken);
        worker.recordResult('like', res, this);
        return;
      }
      case 'view': {
        res = await driver.viewPost(this.account.accessToken);
        worker.recordResult('view', res, this);
        return;
      }
    }
  }

  /** Chat cycle: enqueue khi chưa có việc — gọi định kỳ từ scheduler. */
  async ensureChatCycle(worker: WorkerRuntime, now: number) {
    if (this.profile !== 'chat') return;
    if (this.phase === 'in_room' || this.phase === 'queued' || this.phase === 'connecting') return;
    if (now < this.cooldownUntil) return; // cooldown 900s sau leave (AC3.5) + backoff timeout
    // idle/connected/cooldown-qua → enqueue lại
    if (now - (this.lastEnqueueAt ?? 0) < 3000) return;
    this.lastEnqueueAt = now;
    this.phase = 'queued';
    const res = await worker.rest.chatEnqueue(this.account.accessToken);
    if (!res.ok) {
      if (res.failClass === 'THROTTLED') {
        // CHAT_COOLDOWN_ACTIVE (429): đúng cooldown 900s — không spam enqueue mỗi 3s
        this.phase = 'cooldown';
        this.cooldownUntil = Date.now() + COOLDOWN_MS;
      } else if (res.code === 'CHAT_ALREADY_SEATED') {
        // state lệch: user thật sự đã ngồi — reconcile qua my-room ở chu kỳ sau
        this.phase = 'connected';
      } else {
        this.phase = 'idle';
      }
      this.lastError = `enqueue: ${res.code}`;
      worker.recordResult('chat', res, this);
    } else {
      this.phase = 'queued';
      this.queuedAt = now;
      worker.recordResult('chat', res, this);
    }
  }
  private lastEnqueueAt = 0;
  private queuedAt = 0;

  async ensureJoined(worker: WorkerRuntime) {
    // reconnect/start: reconcile my-room (PRD §1.3) → nếu đang ngồi thì re-join
    if (!this.socket?.connected) return;
    if (this.phase === 'in_room' || this.phase === 'queued') return;
    const r = await worker.rest.chatMyRoom(this.account.accessToken);
    if (r.roomId) {
      this.roomId = r.roomId;
      this.phase = 'in_room';
      this.socket.emit('chat:join', { roomId: r.roomId });
    }
  }

  disconnect() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.socketConnected = false;
    this.outbox.clear();
  }

  toRow(): VirtualUserRow {
    return {
      index: this.index,
      email: this.account.email,
      phase: this.phase,
      roomId: this.roomId,
      socketConnected: this.socketConnected,
      reconnectCount: this.reconnectCount,
      outboxPending: this.outbox.size,
      lastError: this.lastError,
    };
  }
}

/** Worker runtime — vòng đời 1 worker process (chạy trong child_process fork). */
export class WorkerRuntime {
  readonly workerId: number;
  readonly env: LoadTestEnv;
  rest: RestDriver;
  config: RunConfig | null = null;
  accounts: TestAccount[] = [];
  users: VirtualUser[] = [];
  paused = false;
  stopping = false;

  // metrics (cumulative → tick)
  private counters = {
    usersCreated: 0, usersConnected: 0, usersActive: 0, usersQueued: 0, usersInRoom: 0,
    actionsTotal: 0, successTotal: 0, failTotal: 0, echoOk: 0, echoSent: 0,
    droppedOutbox: 0, reconnectCount: 0, rateLimitedNoEcho: 0,
    connectAttempts: 0, connectFails: 0,
  };
  private histograms = new Map<string, BucketedHistogram>();
  private actionOk = new Map<string, number>();
  private actionFail = new Map<string, number>();
  private errorCounters = new Map<string, number>();
  private errorSamples: WorkerTick['errorSamples'] = [];
  private secCounters = new Map<number, Partial<Record<string, number>>>();
  private currentSecKey = 0;
  private currentSecCounters: Partial<Record<string, number>> = {};
  private scheduler: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private lastCpuUsage = process.cpuUsage();
  private lastCpuAt = Date.now();
  private lastPruneAt = 0;
  /** F3 — paced connect theo rampRate (user/s chia đều cho worker). */
  private rampStartedAt = 0;
  private connectStarted = 0;
  onMessage: ((msg: unknown) => void) | null = null;

  constructor(workerId: number, env: LoadTestEnv) {
    this.workerId = workerId;
    this.env = env;
    this.rest = new RestDriver(env.gatewayUrl, env);
    this.currentSecKey = Math.floor(Date.now() / 1000);
  }

  start(config: RunConfig, accounts: TestAccount[]) {
    if (this.config) {
      ltLog.warn(`worker#${this.workerId}: nhận run lần 2 — bỏ qua (đã start)`);
      return;
    }
    this.config = config;
    this.accounts = accounts;
    this.rest = new RestDriver(config.gatewayUrl, this.env);
    this.users = accounts.map(
      (acc, i) => new VirtualUser(i, acc, pickProfile(config.profile), config.gatewayUrl),
    );
    for (const u of this.users) {
      u.onEchoOk = (latencyMs) => this.recordEchoOk(latencyMs);
      u.onError = (code, message) => this.recordError(code, message, u);
      // F3: KHÔNG connect ngay — scheduler connect theo rampRate (paced)
    }
    this.rampStartedAt = Date.now();
    this.connectStarted = 0;
    // scheduler 100ms chung — tránh N timer/user
    this.scheduler = setInterval(() => this.schedulerTick(), 100);
    this.tickTimer = setInterval(() => this.emitTick(), 1000);
    this.currentSecKey = Math.floor(Date.now() / 1000);
    this.counters.usersCreated = accounts.length;
    ltLog.info(`worker#${this.workerId}: start ${accounts.length} users (profile chat:${config.profile.chat}%) ramp=${config.rampRate}/s`);
  }

  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }

  /** Stop (force=false: disconnect sạch; force=true: cắt ngay). */
  async stop(reason: string, force: boolean): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.scheduler) clearInterval(this.scheduler);
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (!force) {
      // cooldown ngắn: chờ echo dứt điểm (tối đa 5s)
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && this.hasPendingEcho()) await sleep(100);
    }
    for (const u of this.users) u.disconnect();
    this.emitTick(true);
    this.onMessage?.({ type: 'done', reason, status: 'stopped' });
    ltLog.info(`worker#${this.workerId}: stop (${reason})`);
  }

  private hasPendingEcho(): boolean {
    for (const u of this.users) if (u.outbox.size > 0) return true;
    return false;
  }

  private schedulerTick() {
    if (this.stopping) return;
    const now = Date.now();

    // F3: paced connect theo rampRate — mỗi worker nhận rampRate/workerCount user/s
    if (this.config && !this.paused) {
      const ratePerWorker = Math.max(
        1,
        this.config.rampRate / Math.max(1, this.config.workerCount),
      );
      const budget = Math.floor(((now - this.rampStartedAt) / 1000) * ratePerWorker);
      while (this.connectStarted < Math.min(budget, this.users.length)) {
        const u = this.users[this.connectStarted];
        this.connectStarted++;
        u.connect();
      }
    }

    // prune outbox toàn worker mỗi 1s (tránh O(users×outbox) mỗi 100ms)
    if (now - this.lastPruneAt > 1000) {
      this.lastPruneAt = now;
      for (const u of this.users) u.pruneOutbox(now, this);
    }

    for (const u of this.users) {
      if (this.paused) continue;
      const next = u.tick(now, this);
      if (next) {
        switch (next.action) {
          case 'send': u.sendChat(this); break;
          case 'typing': u.sendTyping(this); break;
          case 'topic': void this.doTopic(u); break;
          case 'rest': void u.runRest(this); break;
        }
      }
      if (u.profile === 'chat') {
        void u.ensureChatCycle(this, now);
        if (now % 10_000 < 100) void u.ensureJoined(this); // reconcile định kỳ ~10s
      }
    }
  }

  private async doTopic(u: VirtualUser) {
    if (!u.roomId || !this.config) return;
    const res = await this.rest.setTopic(u.account.accessToken, u.roomId, genTopicTitle(u.index));
    this.recordResult('topic', res, u);
  }

  // ─── Metrics ───────────────────────────────────────────────────────────

  recordAction(action: string, latencyMs: number, ok: boolean, u: VirtualUser, code: string) {
    this.counters.actionsTotal++;
    if (ok) {
      this.counters.successTotal++;
      this.actionOk.set(action, (this.actionOk.get(action) ?? 0) + 1);
    } else {
      this.counters.failTotal++;
      this.actionFail.set(action, (this.actionFail.get(action) ?? 0) + 1);
      if (code) this.recordError(code, code, u);
    }
    this.addLatency(action, latencyMs);
    // per-second counter
    const key = Math.floor(Date.now() / 1000);
    if (key !== this.currentSecKey) {
      this.secCounters.set(this.currentSecKey, this.currentSecCounters);
      this.currentSecKey = key;
      this.currentSecCounters = {};
      while (this.secCounters.size > 3) {
        const oldest = this.secCounters.keys().next().value as number;
        this.secCounters.delete(oldest);
      }
    }
    this.currentSecCounters[action] = (this.currentSecCounters[action] ?? 0) + 1;
  }

  /** Chat send attempt — chỉ đếm attempt (AC3.3: success quyết định bởi echo). */
  onChatSent(u: VirtualUser) {
    this.counters.actionsTotal++;
    this.counters.echoSent++;
    this.bumpPerSec('chat');
  }

  /** Echo chat:message khớp clientMsgId — success + latency end-to-end. */
  recordEchoOk(latencyMs: number) {
    this.counters.echoOk++;
    this.counters.successTotal++;
    this.actionOk.set('chat', (this.actionOk.get('chat') ?? 0) + 1);
    this.addLatency('chat', latencyMs);
    this.bumpPerSec('chat');
  }

  /** Không echo trong TTL — rate-limit silent drop / Kafka chậm (PRD §5.3 tách riêng). */
  onNoEcho(u: VirtualUser, action: string) {
    this.counters.rateLimitedNoEcho++;
    this.counters.failTotal++;
    this.actionFail.set(action, (this.actionFail.get(action) ?? 0) + 1);
    this.addLatency(action, ECHO_TTL_MS);
    this.recordError('NO_ECHO_TIMEOUT', 'chat send không nhận echo trong 60s (rate-limit/Kafka)', u);
  }

  private addLatency(action: string, latencyMs: number) {
    let h = this.histograms.get(action);
    if (!h) {
      h = new BucketedHistogram();
      this.histograms.set(action, h);
    }
    h.add(latencyMs);
  }

  private bumpPerSec(action: string) {
    const key = Math.floor(Date.now() / 1000);
    if (key !== this.currentSecKey) {
      this.secCounters.set(this.currentSecKey, this.currentSecCounters);
      this.currentSecKey = key;
      this.currentSecCounters = {};
      while (this.secCounters.size > 3) {
        const oldest = this.secCounters.keys().next().value as number;
        this.secCounters.delete(oldest);
      }
    }
    this.currentSecCounters[action] = (this.currentSecCounters[action] ?? 0) + 1;
  }

  recordResult(action: string, res: ActionResult, u: VirtualUser) {
    if (res.code === 'LIKE_PACED_SKIP') return; // không phải action thật
    if (res.code === 'NO_POST_FIXTURE') {
      this.recordError('NO_POST_FIXTURE', 'Chưa có post fixture trong feed', u);
    }
    this.recordAction(action, res.latencyMs, res.ok, u, res.code || '');
    if (!res.ok) {
      u.lastError = `${action}:${res.code}`;
    }
  }

  recordError(code: string, message: string, u: VirtualUser) {
    this.errorCounters.set(code, (this.errorCounters.get(code) ?? 0) + 1);
    this.errorSamples.push({ ts: Date.now(), action: 'chat', code, message: message.slice(0, 160), userId: u.account.email });
    if (this.errorSamples.length > 20) this.errorSamples.shift();
  }

  private emitTick(final = false) {
    if (!this.config) return;
    const now = Date.now();
    // đếm phase
    let connected = 0, active = 0, queued = 0, inRoom = 0, reconnect = 0;
    for (const u of this.users) {
      if (u.socketConnected) connected++;
      if (u.phase === 'in_room') { inRoom++; active++; }
      else if (u.phase === 'queued') queued++;
      else if (u.phase === 'connected' || u.phase === 'idle' || u.phase === 'cooldown') active++;
      reconnect += u.reconnectCount;
    }
    this.counters.usersConnected = connected;
    this.counters.usersActive = active;
    this.counters.usersQueued = queued;
    this.counters.usersInRoom = inRoom;
    this.counters.reconnectCount = reconnect;
    let cAttempts = 0, cFails = 0;
    for (const u of this.users) {
      cAttempts += u.runtimeStats.connectAttempts;
      cFails += u.runtimeStats.connectFails;
    }
    this.counters.connectAttempts = cAttempts;
    this.counters.connectFails = cFails;

    // actions/s = giây trước
    const prevKey = this.currentSecKey - 1;
    const actionsPerSec: Partial<Record<string, number>> = {};
    const prev = this.secCounters.get(prevKey);
    if (prev) {
      for (const k of Object.keys(prev)) actionsPerSec[k] = prev[k];
    }
    // CPU
    const cpu = process.cpuUsage(this.lastCpuUsage);
    this.lastCpuUsage = process.cpuUsage();
    const dt = (now - this.lastCpuAt) / 1000;
    this.lastCpuAt = now;
    const cpuPct = dt > 0 ? Math.min(100, Math.round(((cpu.user + cpu.system) / 1e6 / dt / Math.max(1, os.availableParallelism?.() ?? 4)) * 100)) : 0;

    const histograms: Partial<Record<string, number[]>> = {};
    for (const [action, h] of this.histograms) histograms[action] = h.buckets;

    const tick: WorkerTick = {
      type: 'tick',
      workerId: this.workerId,
      ts: now,
      phase: this.phase(),
      counters: { usersTotal: this.users.length, ...this.counters },
      actionsPerSec,
      actionOk: Object.fromEntries(this.actionOk) as WorkerTick['actionOk'],
      actionFail: Object.fromEntries(this.actionFail) as WorkerTick['actionFail'],
      errors: Object.fromEntries(this.errorCounters),
      errorSamples: [...this.errorSamples],
      histograms,
      histogramBucketCount: HISTOGRAM_BUCKETS,
      cpuPct,
      rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    };
    this.onMessage?.({ type: 'tick', tick });
    if (final) {
      // gửi 1 tick cuối đầy đủ histogram
      this.onMessage?.({ type: 'final-tick', tick });
    }
  }

  private phase(): 'provisioning' | 'ramping' | 'steady' | 'cooldown' | 'stopped' {
    if (this.stopping) return 'cooldown';
    if (!this.config) return 'provisioning';
    const connected = this.counters.usersConnected;
    const target = this.config.targetUsers;
    if (connected < target) return 'ramping';
    return 'steady';
  }

  queryUsers(offset: number, limit: number, filter?: string): { rows: VirtualUserRow[]; total: number } {
    let rows = this.users;
    if (filter) {
      const f = filter.toLowerCase();
      rows = rows.filter(
        (u) => u.account.email.toLowerCase().includes(f) || u.phase.includes(f) || (u.roomId ?? '').includes(f),
      );
    }
    return {
      rows: rows.slice(offset, offset + limit).map((u) => u.toRow()),
      total: rows.length,
    };
  }
}

export { ACTION_TYPES };
