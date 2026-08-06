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
import type { RunConfig, TestAccount, UserActionState, UserPhase, VirtualUserRow, WorkerTick, ErrorSample, ConnectFailType } from './types';
import { ACTION_TYPES, EMPTY_CONNECT_FAILS } from './types';
import { sanitizeLogText } from './sanitize';
import { normalizeSort, sortUsers } from './users-sort';
import type { LoadTestEnv } from './config';
import { BucketedHistogram, HISTOGRAM_BUCKETS } from './metrics';
import { RestDriver, type ActionResult } from './rest-actions';
import { genChatContent, genTopicTitle, jitter, ltLog, normalizeUrl, sleep, uuidV4 } from './util';
import * as os from 'node:os';

// Re-export cho backward compat (trước đây UserPhase khai báo tại đây).
export type { UserPhase, UserActionState };

const MATCH_WAIT_MS = 60_000; // timeout chờ matching:found (PRD AC3.2)
const ECHO_TTL_MS = 60_000; // echo TTL (SF-5)
const CHAT_SEND_MIN_MS = 2000; // 1 msg/2s/user (chat-message.service.ts:82-92)
const TYPING_DEBOUNCE_MS = 1500;
const TOPIC_MIN_MS = 15_000;
const VOTE_KICK_MIN_MS = 60_000; // pacing vote_kick start (không spam — F1)
const COOLDOWN_MS = 900_000; // CHAT_LEAVE_COOLDOWN_SECONDS 900
const REST_READ_INTERVAL_MS = 3000;
const REST_COMMENT_INTERVAL_MS = 10_000;
const REST_LIKE_INTERVAL_MS = 15_000;
const REST_VIEW_INTERVAL_MS = 5000;
/** F3: post chậm ~20s/user — tránh write storm vào content-service (research: post là write thật). */
const REST_POST_INTERVAL_MS = 20_000;
/** Cap số loại error code riêng biệt (S-4 R2): gateway bơm N code lạ → bucket 'OTHER' (chống map vô hạn). */
const MAX_ERROR_CODES = 20;

interface PendingMsg {
  clientMsgId: string;
  sentAt: number;
}

export type Profile = 'chat' | 'read' | 'comment' | 'like' | 'view' | 'post';

/** Chọn profile lúc sinh theo % (AC4.1). Tổng 0 (không action nào bật) → chat 100% (F1). */
export function pickProfile(profile: RunConfig['profile']): Profile {
  const r = Math.random() * 100;
  let acc = 0;
  const entries: [Profile, number][] = [
    ['chat', profile.chat],
    ['read', profile.read],
    ['comment', profile.comment],
    ['like', profile.like],
    ['view', profile.view],
    ['post', profile.post ?? 0],
  ];
  for (const [name, pct] of entries) {
    acc += pct;
    if (r < acc) return name;
  }
  return 'chat';
}

/** Phân loại connect_error (DESIGN-loadtest-e2-connect-fail §6 heuristic — PLAN T4):
 *  timeout (type==='TimeoutError' / /timeout/i) → transport (/xhr poll error|transport/i)
 *  → reject (/websocket error|server|handshake|reject/i — gồm auth-reject vì client
 *  không expose HTTP status, PRD §6.1) → other.
 *  KHÔNG throw với mọi input (null/string/thiếu field/control chars — ST-5); sai loại chỉ
 *  ảnh hưởng breakdown display, KHÔNG ảnh hưởng rate/auto-stop (R5). */
export function classifyConnectError(err: unknown): ConnectFailType {
  if (err !== null && typeof err === 'object') {
    if ((err as { type?: unknown }).type === 'TimeoutError') return 'timeout';
    const maybeMsg = (err as { message?: unknown }).message;
    return typeof maybeMsg === 'string' ? classifyByMessage(maybeMsg) : 'other';
  }
  return typeof err === 'string' ? classifyByMessage(err) : 'other';
}

function classifyByMessage(message: string): ConnectFailType {
  if (/timeout/i.test(message)) return 'timeout';
  if (/xhr poll error|transport/i.test(message)) return 'transport';
  if (/websocket error|server|handshake|reject/i.test(message)) return 'reject';
  return 'other';
}

/** Map action → giai đoạn (report tách lỗi theo tầng). */
export function stageForAction(action: ErrorSample['action'], code?: string): ErrorSample['stage'] {
  switch (action) {
    case 'connect': return 'connect';
    case 'register': return 'register';
    case 'login': return 'login';
    case 'chat':
    case 'vote_kick':
      // Enqueue/matching phase nằm trong chat cycle — tách MATCH_* + CHAT_ALREADY_SEATED
      if (code === 'MATCH_TIMEOUT' || code === 'CHAT_ALREADY_SEATED' || code === 'CHAT_COOLDOWN_ACTIVE') return 'matching';
      return 'chat';
    case 'typing':
    case 'topic':
    case 'read':
    case 'comment':
    case 'like':
    case 'view':
    case 'post':
      return 'rest';
    default:
      return 'other';
  }
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
  /** Đã từng connect thành công (DESIGN §5.1 — F-1: cap 5 consecutive áp MỌI user, kể cả đã connected). */
  everConnected = false;
  /** Số connect_error LIÊN TIẾP chưa có connect thành công xen giữa — reset ở 'connect' (DESIGN §5.1). */
  consecutiveConnectFails = 0;
  cooldownUntil = 0;
  lastSendAt = 0;
  lastTypingAt = 0;
  lastTopicAt = 0;
  lastRestAt = 0;
  lastVoteKickAt = 0;
  voteKickCooldownUntil = 0;
  /** Thành viên trong phòng (userIds) — chọn target vote_kick (từ matching:found + member_join/left). */
  members: string[] = [];
  /** Vote kick đang active (mình start hoặc người khác start) — không start mới khi active. */
  activeVoteKick: { targetUserId: string; voted: boolean } | null = null;
  lastError: string | null = null;
  outbox = new Map<string, PendingMsg>();
  // ── Action state (bảng users — chỉ gán biến, KHÔNG log — hot path) ──
  currentAction: UserActionState | null = null;
  lastActionAt: number | null = null;
  lastActionMs: number | null = null;
  messagesSent = 0;
  messagesEchoed = 0;
  /** Số lần enqueue bị 409 CHAT_ALREADY_SEATED (state reconcile — không phải fail). */
  reconcileCount = 0;
  /** Tổng thời gian hồi phục (disconnect → connect OK) — reconnect quality. */
  reconnectTotalMs = 0;
  reconnectMaxMs = 0;
  /** Chaos: user đang bị ngắt mạnh (chaos disconnect_all) — chờ backoff rồi connect lại. */
  chaosDisconnectedAt = 0;
  /** Soak: lần refresh token gần nhất (per-user 50phut — token TTL 1h, refresh trước khi hết hạn). */
  lastTokenRefreshAt = 0;
  /** Soak: refresh đang in-flight — chống re-entry từ scheduler 100ms. */
  tokenRefreshInFlight = false;
  private socket: Socket | null = null;
  private wsUrl: string;
  private netLatencyMs = 0;
  private netJitterMs = 0;
  private netDropRate = 0;
  /** Epoch ms lúc disconnect gần nhất — đo time-to-reconnect ở 'connect' tiếp theo. */
  private lastDisconnectAt = 0;

  constructor(index: number, account: TestAccount, profile: Profile, gatewayUrl: string, network?: RunConfig['network']) {
    this.index = index;
    this.account = account;
    this.profile = profile;
    this.wsUrl = normalizeUrl(gatewayUrl).replace(/^http/, 'ws');
    // Network impairment — deterministic per-user (index): phân tán latency quanh giá trị config
    if (network?.latencyMs && network.latencyMs > 0) {
      const j = network.jitterMs ?? 0;
      const spread = (index % 7) - 3; // -3..3
      this.netLatencyMs = Math.max(0, network.latencyMs + Math.round((spread * j) / 3));
    } else if (network?.jitterMs && network.jitterMs > 0) {
      this.netLatencyMs = Math.round(network.jitterMs / 2);
    }
    this.netJitterMs = network?.jitterMs ?? 0;
    this.netDropRate = Math.min(100, Math.max(0, network?.dropRate ?? 0));
  }

  /** Network impairment: delay trước mỗi emit (latency + jitter ngẫu nhiên quanh giá trị user). */
  private async netDelay(): Promise<void> {
    if (this.netLatencyMs <= 0) return;
    const j = this.netJitterMs > 0 ? (Math.random() * 2 - 1) * this.netJitterMs : 0;
    const d = Math.max(0, Math.round(this.netLatencyMs + j));
    if (d > 0) await sleep(d);
  }

  /** Network impairment: % message bị drop ngẫu nhiên (mô phỏng packet loss). */
  private shouldDrop(): boolean {
    return this.netDropRate > 0 && Math.random() * 100 < this.netDropRate;
  }

  /** Đánh dấu bắt đầu action (gán biến rẻ — gọi từ action scheduler). */
  markActionStart(action: UserActionState) {
    this.currentAction = action;
    this.lastActionAt = Date.now();
  }

  /** Kết thúc action (ms = độ dài vừa đo). currentAction chỉ về 'idle' nếu đúng action đang chạy. */
  markActionEnd(action: UserActionState, ms: number) {
    this.lastActionMs = ms;
    if (this.currentAction === action) this.currentAction = 'idle';
  }

  /** Đưa currentAction về 'idle' bất kể action nào đang chạy — dùng khi phase chuyển sang
   *  idle/cooldown ngoài markActionEnd (MATCH_TIMEOUT, enqueue fail): bảng users không
   *  hiển thị "Đang chat" cho user thực tế đang rảnh. */
  resetAction() {
    this.currentAction = 'idle';
  }

  connect() {
    if (this.socket) return;
    this.phase = 'connecting';
    const token = this.account.accessToken;
    this.socket = io(this.wsUrl, {
      path: '/socket.io/',
      transports: ['websocket'], // SF-1: bỏ polling giảm overhead
      // SEC-3 (F-8): token qua Authorization header + socket.io `auth` (CONNECT packet) —
      // KHÔNG đưa vào query string (gateway đọc auth.token → query → header —
      // websocket.gateway.ts:147-150). `auth` phủ cả `ws` package path.
      auth: { token },
      extraHeaders: { Authorization: `Bearer ${token}` },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10_000,
      timeout: 20_000,
    });
    const s = this.socket;

    s.on('connect', () => {
      if (this.phase === 'failed') {
        // S-2 (R2): connect in-flight về muộn sau cutover — 'failed' là TERMINAL (F-1:
        // "tối đa 5 fail/user" là tiền đề số học E2) — KHÔNG resurrect, KHÔNG reset cap.
        this.socket?.disconnect();
        return;
      }
      this.socketConnected = true;
      this.phase = this.roomId ? 'in_room' : 'connected';
      this.runtimeStats.connectAttempts++;
      this.everConnected = true;
      this.consecutiveConnectFails = 0; // streak thành công → reset cap (DESIGN §5.1)
      // Reconnect quality: đo thời gian hồi phục (disconnect → connect OK) — chaos/network yếu
      if (this.lastDisconnectAt > 0) {
        const dt = Date.now() - this.lastDisconnectAt;
        this.reconnectTotalMs += dt;
        this.reconnectMaxMs = Math.max(this.reconnectMaxMs, dt);
        this.lastDisconnectAt = 0;
      }
      // Reconcile trên reconnect (PRD §1.2): nếu đang trong phòng → re-join
      if (this.roomId) {
        s.emit('chat:join', { roomId: this.roomId });
      }
    });

    s.on('disconnect', (reason: Socket.DisconnectReason) => {
      this.socketConnected = false;
      if (this.phase === 'failed') return; // failed terminal — không đếm gì
      if (reason === 'io server disconnect') {
        // F-T7-2: kênh reject THẬT của gateway (websocket.gateway.ts client.disconnect()).
        // Client đã nhận 'connect' (attempt đếm ở đó) rồi bị drop — socket.io-client v4.8.3
        // KHÔNG retry reason này (destroy() chặn manager) → TERMINAL: 1 reject-fail + cutover NGAY
        // (KHÔNG reconnectCount++, KHÔNG tăng connectAttempts — attempt đã đếm ở 'connect').
        this.phase = 'failed';
        this.lastError = sanitizeLogText('io server disconnect (gateway reject) — phase failed', 160);
        this.runtimeStats.connectFails++;
        this.runtimeStats.connectFailsByType.reject++;
        this.onError?.('reject', 'io server disconnect', 'connect'); // M4: errorSamples action 'connect'
        this.socket?.io?.reconnection(false); // chặn mọi retry — an toàn kép
        return;
      }
      // Các reason khác (transport close/error, ping timeout, parse error) KHÔNG đếm —
      // socket.io tự retry (kênh C engine-level) — connect_error + cap-5 bao phủ (F-T7-2).
      this.phase = 'connecting';
      this.reconnectCount++;
      this.lastDisconnectAt = Date.now(); // reconnect quality: đo thời gian hồi phục
    });

    s.on('connect_error', (err: Error) => {
      if (this.phase === 'failed') return; // sau cutover: không đếm gì (DESIGN §5.1)
      this.lastError = sanitizeLogText(`connect_error: ${err.message}`, 160); // F-2: sink sanitize
      // mỗi lần thử reconnect (thành công hay không) đều là 1 attempt → fail rate chính xác
      this.runtimeStats.connectAttempts++;
      this.runtimeStats.connectFails++;
      const t = classifyConnectError(err); // T4: phân loại (DESIGN §6)
      this.runtimeStats.connectFailsByType[t]++;
      this.consecutiveConnectFails++;
      this.onError?.(t, err.message, 'connect'); // M4: errorSamples action 'connect' (sanitize trong recordError)
      if (this.consecutiveConnectFails >= 5) {
        // Cap 5 consecutive cho MỌI user (F-1 — DESIGN §5.1): user token hết hạn giữa run
        // (đã từng connected) cũng cutover → 1 user hỏng vĩnh viễn sinh TỐI ĐA 5 fail,
        // không tái hiện E2 false-positive. Transient thật (fail < 5 rồi success) vẫn retry vô hạn.
        this.phase = 'failed';
        this.socket?.disconnect();
        // R4: chặn manager retry. socket.io-client 4.8.3: Manager.reconnect() là private
        // no-arg (API v3); API public để tắt reconnect là reconnection(false) — DESIGN ghi
        // io.reconnect(false), implement theo API v4 (cùng intent).
        this.socket?.io?.reconnection(false);
        // KHÔNG null this.socket (khác disconnect() :394-402) — tránh connect() re-invoke
        this.lastError = sanitizeLogText(`${this.lastError} | failed sau 5 connect_error liên tiếp (ngừng reconnect)`, 160);
      }
    });

    s.on('matching:found', (p: { roomId: string; roomEndsAt?: number | null; members?: { userId: string }[] }) => {
      if (!p?.roomId) return;
      this.roomId = p.roomId;
      this.roomEndsAt = p.roomEndsAt ?? null;
      this.phase = 'in_room';
      this.lastSendAt = Date.now(); // tránh send ngay vừa vào phòng
      // F1: capture members cho vote_kick targeting.
      const ids = (p.members ?? []).map((m) => m?.userId).filter((id): id is string => !!id);
      if (ids.length) this.members = ids;
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
          this.messagesEchoed++;
          this.markActionEnd('chat', Date.now() - pending.sentAt);
          this.onEchoOk?.(Date.now() - pending.sentAt);
        }
      }
    });

    s.on('chat:error', (p: { code?: string; message?: string }) => {
      this.lastError = sanitizeLogText(`chat:error ${p?.code ?? ''} ${p?.message ?? ''}`.trim(), 160); // F-2
      this.onError?.(`chat:${p?.code ?? 'ERROR'}`, this.lastError);
    });

    // ─── vote_kick + member tracking (F1 — mô phỏng vote kick như app thật) ───
    s.on('chat:member_join', (p: { member?: { userId?: string }; roomEndsAt?: number | null }) => {
      const id = p?.member?.userId;
      if (id && !this.members.includes(id)) this.members = [...this.members, id];
      if (typeof p?.roomEndsAt === 'number') this.roomEndsAt = p.roomEndsAt;
    });
    s.on('chat:member_left', (p: { userId?: string }) => {
      const id = p?.userId;
      if (id) this.members = this.members.filter((m) => m !== id);
    });
    s.on('chat:vote_kick:started', (p: { targetUserId?: string; initiatorId?: string }) => {
      if (!p?.targetUserId) return;
      this.activeVoteKick = { targetUserId: p.targetUserId, voted: false };
      const me = this.account.userId;
      // Không phải initiator/target → có thể vote (70%) — mô phỏng tham gia vote.
      if (me && p.initiatorId !== me && p.targetUserId !== me && this.socket?.connected && this.roomId && Math.random() < 0.7) {
        this.markActionStart('vote_kick');
        this.socket.emit('chat:vote_kick:vote', { roomId: this.roomId });
        this.markActionEnd('vote_kick', 0);
        if (this.activeVoteKick) this.activeVoteKick.voted = true;
        this.onVoteKickVote?.();
      }
    });
    s.on('chat:vote_kick:result', (p: { targetUserId?: string; result?: string }) => {
      this.activeVoteKick = null;
      this.voteKickCooldownUntil = Date.now() + 30_000; // tránh spam start lại ngay sau 1 vote
      if (p?.result === 'KICKED' && p.targetUserId && p.targetUserId !== this.account.userId) {
        this.members = this.members.filter((m) => m !== p.targetUserId);
      }
    });

    s.on('roomExpired', () => this.leaveRoom('ROOM_EXPIRED'));
    s.on('chat:room_closed', () => this.leaveRoom('ROOM_CLOSED'));
  }

  /** Sự kiện ngoài (worker runtime) — tránh callback lồng nhau. */
  onEchoOk: ((latencyMs: number) => void) | null = null;
  onError: ((code: string, message: string, action?: ErrorSample['action']) => void) | null = null;
  /** vote_kick vote (trên vote người khác start) — worker record action. */
  onVoteKickVote: (() => void) | null = null;
  /** Stats rẻ tiền cho auto-stop (connect attempts/fails) — đọc trong emitTick. */
  readonly runtimeStats = {
    connectAttempts: 0,
    connectFails: 0,
    connectFailsByType: { ...EMPTY_CONNECT_FAILS }, // T3 nối chỗ gọi (mặc định 'other') — T4 classify thật
  };

  private leaveRoom(reason: string) {
    this.roomId = null;
    this.roomEndsAt = null;
    this.outbox.clear();
    this.members = [];
    this.activeVoteKick = null;
    // FIX: reset queuedAt — enqueue kế tiếp sau cooldown 900s không kế thừa queuedAt cũ >60s
    // (nếu không, tick() đếm MATCH_TIMEOUT phantom trong lúc await enqueue in-flight).
    this.queuedAt = 0;
    this.cooldownUntil = Date.now() + COOLDOWN_MS;
    this.phase = 'cooldown';
    this.resetAction();
    this.lastError = sanitizeLogText(`leaveRoom(${reason})`, 160);
  }

  /** Chaos disconnect_all: ngắt mạnh socket (mô phỏng mất mạng di động).
   *  socket.disconnect() (client namespace) → socket.io KHÔNG auto-reconnect — chờ chaosResume.
   *  Handler 'disconnect' tự đếm reconnectCount + lastDisconnectAt (reconnect quality). */
  chaosDisconnect() {
    const s = this.socket;
    if (!s || !this.socketConnected) return;
    if (this.phase === 'failed') return;
    this.chaosDisconnectedAt = Date.now();
    s.disconnect();
  }

  /** Chaos kết thúc (hết block window / hết backoff) — connect lại thủ công. */
  chaosResume() {
    const s = this.socket;
    if (!s || this.socketConnected || this.phase === 'failed') return;
    if (!this.chaosDisconnectedAt) return;
    this.chaosDisconnectedAt = 0;
    // Recreate socket: `auth` object + Authorization header đều snapshot lúc io(), nên sau khi
    // refresh token (soak) phải tạo socket mới thì token mới mới vào CONNECT packet + header.
    // Path chaos (token không đổi) recreate cũng an toàn — đồng nhất 2 path, không rẽ nhánh.
    s.removeAllListeners();
    s.disconnect();
    this.socket = null;
    this.connect();
  }

  /** Scheduler 100ms — trả về 1 action cần chạy (null = chưa đến lúc). */
  tick(now: number, worker: WorkerRuntime): { action: 'send' | 'typing' | 'topic' | 'rest' | 'vote_kick' } | null {
    // Timeout chờ matching (AC3.2): 60s không thấy matching:found → backoff 30s rồi thử lại.
    // queuedAt > 0 bắt buộc: queuedAt=0 = enqueue ĐANG in-flight (phase 'queued' set trước await
    // ở ensureChatCycle, queuedAt chỉ gán sau khi enqueue thành công). Nếu không guard, `now - 0`
    // (~epoch ms) luôn > MATCH_WAIT_MS → MATCH_TIMEOUT phantom cho MỌI user đang chờ response
    // enqueue (tick đầu ramping run 10k: MATCH_TIMEOUT=3598 = usersActive — vật lý không thể).
    if (this.phase === 'queued' && this.queuedAt > 0 && now - this.queuedAt > MATCH_WAIT_MS) {
      this.phase = 'idle';
      this.resetAction(); // FIX-2: không còn chờ matching → bảng users không thấy "Đang chat"
      this.lastError = sanitizeLogText('MATCH_TIMEOUT: không nhận matching:found trong 60s', 160);
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
      // vote_kick (F1): paced 60s, 8% chance, ≥2 member, không active, hết cooldown.
      if (
        this.profile === 'chat' &&
        now - this.lastVoteKickAt >= VOTE_KICK_MIN_MS &&
        now >= this.voteKickCooldownUntil &&
        !this.activeVoteKick &&
        this.members.length >= 2 &&
        Math.random() < 0.08
      ) {
        this.lastVoteKickAt = now;
        return { action: 'vote_kick' };
      }
      return null;
    }
    // REST pacing ngoài phòng (kể cả cooldown — giữ tải)
    if ((this.phase === 'connected' || this.phase === 'cooldown' || this.phase === 'idle') && !this.restInFlight && now - this.lastRestAt >= this.restInterval()) {
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
      case 'post': return jitter(REST_POST_INTERVAL_MS);
      default: return jitter(REST_READ_INTERVAL_MS * 2); // chat user khi cooldown đọc nhẹ
    }
  }

  async sendChat(worker: WorkerRuntime) {
    if (this.sendInFlight) return; // tránh re-entry khi netDelay > CHAT_SEND_MIN_MS → burst emit + false NO_ECHO
    if (!this.socket?.connected || !this.roomId) return;
    // Network impairment: packet loss — KHÔNG emit (outbox chờ echo → NO_ECHO_TIMEOUT đo hệ thống
    // xử lý mạng yếu thế nào: retry/rate-limit/echo pipeline).
    if (this.shouldDrop()) return;
    this.sendInFlight = true;
    try {
      await this.netDelay();
      // Re-check sau netDelay (có thể 30s): socket có thể disconnect trong lúc chờ (chaos
      // disconnect_all / gateway drop). Không re-check → emit phantom vào outbox → 60s sau
      // NO_ECHO_TIMEOUT fires metric no-echo giả (m1).
      if (!this.socket?.connected || !this.roomId) return;
      const clientMsgId = uuidV4();
      const content = genChatContent(this.index);
      this.outbox.set(clientMsgId, { clientMsgId, sentAt: Date.now() });
      this.markActionStart('chat');
      this.socket.emit('chat:send', { roomId: this.roomId, content, clientMsgId });
      this.messagesSent++;
      // AC3.3: chỉ tính "attempt" ngay lúc emit — success/fail quyết định bởi echo/không-echo
      worker.onChatSent(this);
    } finally {
      this.sendInFlight = false;
    }
  }

  sendTyping(worker: WorkerRuntime) {
    if (this.typingInFlight) return;
    if (!this.socket?.connected || !this.roomId) return;
    if (this.shouldDrop()) return;
    this.typingInFlight = true;
    void this.netDelay()
      .then(() => {
        this.typingInFlight = false;
        if (!this.socket?.connected || !this.roomId) return;
        this.markActionStart('typing');
        this.socket.emit('chat:typing', { roomId: this.roomId });
        this.markActionEnd('typing', 0);
        worker.recordAction('typing', 0, true, this, 'chat:typing');
      })
      .catch(() => {
        this.typingInFlight = false;
      });
  }

  /** vote_kick (F1): start vote 1 thành viên ngẫu nhiên (chỉ khi in_room, ≥2 member, chưa active). */
  startVoteKick(worker: WorkerRuntime) {
    if (!this.socket?.connected || !this.roomId || this.activeVoteKick) return;
    const me = this.account.userId;
    const targets = this.members.filter((id) => id && id !== me);
    if (targets.length === 0) return;
    if (this.shouldDrop()) return; // packet loss — không emit
    const targetUserId = targets[Math.floor(Math.random() * targets.length)];
    this.markActionStart('vote_kick');
    this.socket.emit('chat:vote_kick:start', { roomId: this.roomId, targetUserId });
    this.activeVoteKick = { targetUserId, voted: false };
    this.markActionEnd('vote_kick', 0);
    worker.recordAction('vote_kick', 0, true, this, '');
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
    if (this.restInFlight) return; // FIX: call trước còn in-flight → không gửi request thứ 2 song song
    this.restInFlight = true;
    try {
      if (this.profile === 'chat') {
        // F1: 'read' không được chọn (0%) → user chat KHÔNG tự read khi cooldown — chỉ giữ chat.
        if ((worker.config?.profile?.read ?? 0) === 0) return;
        // chat profile ngoài phòng/cooldown: chỉ đọc nhẹ
        this.markActionStart('read');
        await worker.rest.readPostDetail(this.account.accessToken).then((r) => {
          this.markActionEnd('read', r.detail.latencyMs);
          worker.recordResult('read', r.detail, this);
        });
        return;
      }
      const driver = worker.rest;
      let res: ActionResult;
      switch (this.profile) {
        case 'read': {
          this.markActionStart('read');
          const r = await driver.readPostDetail(this.account.accessToken);
          this.markActionEnd('read', r.detail.latencyMs);
          worker.recordResult('read', r.detail, this);
          if (r.view) worker.recordResult('view', r.view, this);
          return;
        }
        case 'comment': {
          if (Math.random() < 0.6) {
            this.markActionStart('comment');
            res = await driver.createComment(this.account.accessToken, this.index);
            this.markActionEnd('comment', res.latencyMs);
            worker.recordResult('comment', res, this);
          } else {
            this.markActionStart('comment');
            res = await driver.readComments(this.account.accessToken);
            this.markActionEnd('comment', res.latencyMs);
            worker.recordResult('comment', res, this);
          }
          return;
        }
        case 'like': {
          this.markActionStart('like');
          res = await driver.likePost(this.account.accessToken);
          this.markActionEnd('like', res.latencyMs);
          worker.recordResult('like', res, this);
          return;
        }
        case 'view': {
          this.markActionStart('view');
          res = await driver.viewPost(this.account.accessToken);
          this.markActionEnd('view', res.latencyMs);
          worker.recordResult('view', res, this);
          return;
        }
        case 'post': {
          // F3: join community PUBLIC 1 lần (RestDriver nhớ state) rồi đăng bài — pacing 20s/user.
          this.markActionStart('post');
          res = await driver.createPost(this.account.accessToken, this.index);
          this.markActionEnd('post', res.latencyMs);
          worker.recordResult('post', res, this);
          return;
        }
      }
    } finally {
      this.restInFlight = false;
    }
  }

  /** Chat cycle: enqueue khi chưa có việc — gọi định kỳ từ scheduler. */
  async ensureChatCycle(worker: WorkerRuntime, now: number) {
    if (this.profile !== 'chat') return;
    if (this.phase === 'failed') return; // M7: user failed không enqueue lại (DESIGN §5.1)
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
        // state lệch: user thật sự đã ngồi — reconcile qua my-room ở chu kỳ sau.
        // KHÔNG đếm failTotal (409 nghiệp vụ — user đã seated sẵn, không phải lỗi hệ thống):
        // chỉ đếm reconcile + top-errors cho visibility.
        this.phase = 'connected';
        this.reconcileCount++;
        worker.recordReconcile(this);
      } else {
        this.phase = 'idle';
      }
      // FIX: reset queuedAt ở MỌI nhánh fail — queuedAt cũ >60s từ chu kỳ trước (leaveRoom/cooldown)
      // bị tick() coi là MATCH_TIMEOUT phantom trong lúc await enqueue in-flight (phase='queued').
      this.queuedAt = 0;
      this.resetAction(); // FIX-2: enqueue fail → không còn chờ matching — bảng users không thấy "Đang chat"
      this.lastError = sanitizeLogText(`enqueue: ${res.code}`, 160);
      worker.recordResult('chat', res, this);
    } else {
      this.phase = 'queued';
      this.queuedAt = now;
      this.markActionStart('chat'); // đang chờ matching — bảng users thấy đang "chat"
      worker.recordResult('chat', res, this);
    }
  }
  private lastEnqueueAt = 0;
  private queuedAt = 0;
  /** FIX: REST action đang in-flight — REST call có thể mất 30s (15s×2 retry) > interval 3s → không chồng request. */
  private restInFlight = false;
  /** sendChat đang in-flight (await netDelay) — chống re-entry khi netDelay > 2s (burst emit + false no-echo). */
  private sendInFlight = false;
  /** sendTyping đang in-flight — cùng lý do sendInFlight. */
  private typingInFlight = false;

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
    // FIX: reset queuedAt — chu kỳ chat sau reconnect không kế thừa queuedAt cũ (MATCH_TIMEOUT phantom)
    this.queuedAt = 0;
  }

  toRow(): VirtualUserRow {
    return {
      index: this.index,
      email: this.account.email,
      phase: this.phase,
      currentAction: this.currentAction,
      lastActionAt: this.lastActionAt,
      lastActionMs: this.lastActionMs,
      messagesSent: this.messagesSent,
      messagesEchoed: this.messagesEchoed,
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
    connectFailsByType: { ...EMPTY_CONNECT_FAILS }, // sum per-user runtimeStats trong emitTick (T4)
    usersFailed: 0, // T3 đếm phase 'failed' trong emitTick — init 0 (T1)
    reconcileCount: 0, // CHAT_ALREADY_SEATED — state reconcile, KHÔNG phải fail
    reconnectTotalMs: 0, // reconnect quality — sum per-user trong emitTick
    reconnectMaxMs: 0,
    usersLost: 0, // everConnected nhưng cuối cùng mất kết nối
  };
  private histograms = new Map<string, BucketedHistogram>();
  private actionOk = new Map<string, number>();
  private actionFail = new Map<string, number>();
  private errorCounters = new Map<string, number>();
  /** Error theo giai đoạn (connect/matching/chat/rest/...) — report tách tầng. */
  private errorCountersByStage = new Map<string, Map<string, number>>();
  private errorSamples: WorkerTick['errorSamples'] = [];
  private secCounters = new Map<number, Partial<Record<string, number>>>();
  private currentSecKey = 0;
  private currentSecCounters: Partial<Record<string, number>> = {};
  private scheduler: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private lastCpuUsage = process.cpuUsage();
  private lastCpuAt = Date.now();
  private lastPruneAt = 0;
  private lastSummaryAt = 0;
  /** F3 — paced connect theo rampRate (user/s chia đều cho worker). */
  private rampStartedAt = 0;
  private connectStarted = 0;
  /** Chaos: index các event đã apply (theo elapsedSec). */
  private chaosApplied = new Set<number>();
  /** Chaos: chặn reconnect tới khi hết block window (block_reconnect). */
  private chaosBlockUntil = 0;
  /** Soak: lần refresh token gần nhất (throttle 5s giữa các đợt refresh). */
  private lastRefreshAt = 0;
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
      (acc, i) => new VirtualUser(i, acc, pickProfile(config.profile), config.gatewayUrl, config.network),
    );
    for (const u of this.users) {
      u.onEchoOk = (latencyMs) => this.recordEchoOk(latencyMs);
      u.onError = (code, message, action) => this.recordError(code, message, u, action);
      u.onVoteKickVote = () => this.recordAction('vote_kick', 0, true, u, '');
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
    this.chaosTick(now);

    // Soak: refresh access token định kỳ per-user (50phut — token TTL 1h) để chạy quá 60 phút.
    // Worker-level 5s throttle giới hạn tần suất loop; per-user cadence + in-flight guard
    // chống re-entry. Reconnect (recreate socket) được stagger qua chaos backoff 3-15s/user.
    if (this.config && !this.paused && now - this.rampStartedAt >= 55 * 60_000 && now - this.lastRefreshAt >= 5_000) {
      this.lastRefreshAt = now;
      for (const u of this.users) {
        if (now - u.lastTokenRefreshAt >= 50 * 60_000) void this.maybeRefreshToken(u);
      }
    }

    // F3: paced connect theo rampRate — mỗi worker nhận rampRate/workerCount user/s.
    // F2: rampMode='burst' → connect TOÀN BỘ user ngay tick đầu (vòng while sẵn cạn user trong ~1 tick).
    if (this.config && !this.paused) {
      const ratePerWorker = Math.max(
        1,
        this.config.rampRate / Math.max(1, this.config.workerCount),
      );
      const budget =
        this.config.rampMode === 'burst'
          ? this.users.length
          : Math.floor(((now - this.rampStartedAt) / 1000) * ratePerWorker);
      while (this.connectStarted < Math.min(budget, this.users.length)) {
        const u = this.users[this.connectStarted];
        this.connectStarted++;
        u.connect();
      }
      if (this.connectStarted % 100 === 0 && this.connectStarted > 0 && this.connectStarted < this.users.length) {
        ltLog.info(`worker#${this.workerId}: đã connect ${this.connectStarted}/${this.users.length} users`, { workerId: this.workerId });
      }
    }

    // prune outbox toàn worker mỗi 1s (tránh O(users×outbox) mỗi 100ms)
    if (now - this.lastPruneAt > 1000) {
      this.lastPruneAt = now;
      for (const u of this.users) u.pruneOutbox(now, this);
    }

    for (const u of this.users) {
      if (this.paused) continue;
      if (u.phase === 'failed') continue; // M7: user failed không tham gia vòng lặp action (DESIGN §5.1)
      const next = u.tick(now, this);
      if (next) {
        switch (next.action) {
          case 'send': u.sendChat(this); break;
          case 'typing': u.sendTyping(this); break;
          case 'topic': void this.doTopic(u); break;
          case 'rest': void u.runRest(this); break;
          case 'vote_kick': u.startVoteKick(this); break;
        }
      }
      if (u.profile === 'chat') {
        void u.ensureChatCycle(this, now);
        if (now % 10_000 < 100) void u.ensureJoined(this); // reconcile định kỳ ~10s
      }
    }
  }

  /** Chaos scheduler (failure injection theo elapsedSec): apply event đúng giờ + resume đúng lúc. */
  private chaosTick(now: number) {
    const events = this.config?.chaos?.events;
    if (events?.length) {
      const elapsedSec = Math.floor((now - this.rampStartedAt) / 1000);
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (this.chaosApplied.has(i)) continue;
        if (elapsedSec < ev.atSec) continue;
        this.chaosApplied.add(i);
        if (ev.action === 'disconnect_all') {
          let n = 0;
          for (const u of this.users) {
            if (u.socketConnected) {
              u.chaosDisconnect();
              n++;
            }
          }
          ltLog.info(`worker#${this.workerId}: chaos disconnect_all @${elapsedSec}s — ngắt ${n} sockets`, { workerId: this.workerId });
        } else if (ev.action === 'block_reconnect') {
          this.chaosBlockUntil = now + Math.max(1, ev.durationSec ?? 60) * 1000;
          ltLog.info(`worker#${this.workerId}: chaos block_reconnect ${ev.durationSec ?? 60}s @${elapsedSec}s`, { workerId: this.workerId });
        }
      }
    }
    // Hết block window → cho phép connect lại (chaosResume ở loop dưới tự chạy)
    if (this.chaosBlockUntil > 0 && now >= this.chaosBlockUntil) {
      this.chaosBlockUntil = 0;
      ltLog.info(`worker#${this.workerId}: chaos block_reconnect hết hạn — resume`, { workerId: this.workerId });
    }
    // disconnect_all: connect lại sau backoff 3-15s/user (tránh thundering herd)
    if (this.chaosBlockUntil <= 0) {
      for (const u of this.users) {
        if (u.chaosDisconnectedAt > 0) {
          const backoff = 3000 + (u.index % 12) * 1000;
          if (now >= u.chaosDisconnectedAt + backoff) u.chaosResume();
        }
      }
    }
  }

  /** Soak: refresh access token trước khi hết hạn (1h) — recreate socket để token mới có hiệu lực. */
  private async maybeRefreshToken(u: VirtualUser) {
    // Per-user 50phut cadence + in-flight guard — scheduler 100ms có thể gọi lại khi refresh đang await.
    if (u.tokenRefreshInFlight) return;
    u.tokenRefreshInFlight = true;
    try {
      const res = await this.rest.refreshAccessToken(u.account.refreshToken);
      if (res.ok && res.accessToken) {
        u.account.accessToken = res.accessToken;
        u.lastTokenRefreshAt = Date.now(); // success → 50phut tới lần refresh kế tiếp
        // Socket giữ token cũ (auth + header snapshot lúc io()) → ngắt; chaosResume (sau backoff
        // 3-15s/user — tránh thundering herd) sẽ recreate socket với token mới.
        if (u.socketConnected) u.chaosDisconnect();
        else if (u.phase === 'failed') {
          // user failed vì token hết hạn — revive: chaosResume recreate socket với token mới.
          u.phase = 'connecting';
          u.chaosDisconnectedAt = Date.now();
        }
        ltLog.info(`worker#${this.workerId}: refresh token user#${u.index} — recreate socket với token mới`, { workerId: this.workerId });
      } else {
        // fail → retry sau 5phut (không đợi 50phut — có thể lỗi tạm, muốn phục hồi sớm).
        u.lastTokenRefreshAt = Date.now() - 45 * 60_000;
        u.lastError = sanitizeLogText(`refresh token fail: ${res.error ?? res.code ?? 'unknown'}`, 160);
        ltLog.warn(`worker#${this.workerId}: refresh token fail user#${u.index} (${res.code})`, { workerId: this.workerId });
      }
    } finally {
      u.tokenRefreshInFlight = false;
    }
  }

  private async doTopic(u: VirtualUser) {
    if (!u.roomId || !this.config) return;
    u.markActionStart('topic');
    const res = await this.rest.setTopic(u.account.accessToken, u.roomId, genTopicTitle(u.index));
    u.markActionEnd('topic', res.latencyMs);
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
  onChatSent(_u: VirtualUser) {
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
      // T-07/S-12: action bị BỎ QUA (feed trống) — đếm 1 lần vào error counter, KHÔNG gọi
      // recordAction (trước đây recordAction(fail) đếm recordError lần 2 + vào failTotal →
      // success rate sai dù design nói "bị bỏ qua").
      this.recordError('NO_POST_FIXTURE', 'Chưa có post fixture trong feed', u);
      u.lastError = sanitizeLogText(`${action}:${res.code}`, 160);
      return;
    }
    this.recordAction(action, res.latencyMs, res.ok, u, res.code || '');
    if (!res.ok) {
      u.lastError = sanitizeLogText(`${action}:${res.code}`, 160);
    }
  }

  /** Cap số loại error code riêng biệt (S-4 R2): gateway bơm N code lạ → bucket 'OTHER' (chống map vô hạn). */
  recordError(code: string, message: string, u: VirtualUser, action: ErrorSample['action'] = 'chat', stage?: ErrorSample['stage']) {
    code = sanitizeLogText(code, 64); // F-4: cap 64 — TOP ERRORS/report file không bị bloat
    message = sanitizeLogText(message, 160); // F-2/F-3: errorSamples sạch (thay slice(0,160))
    const key = this.errorCounters.has(code) || this.errorCounters.size < MAX_ERROR_CODES ? code : 'OTHER';
    this.errorCounters.set(key, (this.errorCounters.get(key) ?? 0) + 1);
    const st = stage ?? stageForAction(action, code);
    let byStage = this.errorCountersByStage.get(st);
    if (!byStage) {
      byStage = new Map();
      this.errorCountersByStage.set(st, byStage);
    }
    byStage.set(key, (byStage.get(key) ?? 0) + 1);
    this.errorSamples.push({ ts: Date.now(), action, stage: st, code, message, userId: u.account.email });
    if (this.errorSamples.length > 20) this.errorSamples.shift();
  }

  /** CHAT_ALREADY_SEATED (409) — user đã ngồi sẵn: đếm reconcile, KHÔNG vào failTotal/actionsTotal. */
  recordReconcile(u: VirtualUser) {
    this.counters.reconcileCount++;
    this.recordError('CHAT_ALREADY_SEATED', 'user đã ngồi phòng — reconcile qua my-room', u, 'chat', 'matching');
  }

  private emitTick(final = false) {
    if (!this.config) return;
    const now = Date.now();
    // đếm phase
    let connected = 0, active = 0, queued = 0, inRoom = 0, reconnect = 0, failed = 0;
    for (const u of this.users) {
      reconnect += u.reconnectCount; // cumulative — cộng cho mọi user (kể cả failed)
      if (u.phase === 'failed') { failed++; continue; } // failed không vào connected/active
      if (u.socketConnected) connected++;
      if (u.phase === 'in_room') { inRoom++; active++; }
      else if (u.phase === 'queued') queued++;
      else if (u.phase === 'connected' || u.phase === 'idle' || u.phase === 'cooldown') active++;
    }
    this.counters.usersConnected = connected;
    this.counters.usersActive = active;
    this.counters.usersQueued = queued;
    this.counters.usersInRoom = inRoom;
    this.counters.reconnectCount = reconnect;
    this.counters.usersFailed = failed; // phase 'failed' terminal (DESIGN §5.1) → đếm đúng 1 lần/user
    // Reconnect quality + usersLost (everConnected nhưng cuối tick không còn kết nối — kể cả failed)
    let reconnectTotalMs = 0, reconnectMaxMs = 0, usersLost = 0, reconcile = 0;
    for (const u of this.users) {
      reconnectTotalMs += u.reconnectTotalMs;
      reconnectMaxMs = Math.max(reconnectMaxMs, u.reconnectMaxMs);
      reconcile += u.reconcileCount;
      if (u.everConnected && !u.socketConnected) usersLost++;
    }
    this.counters.reconnectTotalMs = reconnectTotalMs;
    this.counters.reconnectMaxMs = reconnectMaxMs;
    this.counters.usersLost = usersLost;
    this.counters.reconcileCount = reconcile;
    // Periodic summary 10s/worker — dễ theo dõi worker đang làm gì.
    if (!final && now - this.lastSummaryAt > 10_000) {
      this.lastSummaryAt = now;
      ltLog.info(
        `worker#${this.workerId}: connected=${connected}/${this.users.length} inRoom=${inRoom} queued=${queued} ` +
          `reconnect=${reconnect} actions=${this.counters.actionsTotal} success=${this.counters.successTotal} fail=${this.counters.failTotal} ` +
          `echo=${this.counters.echoOk}/${this.counters.echoSent}`,
        { workerId: this.workerId },
      );
    }
    let cAttempts = 0, cFails = 0;
    const cByType = { ...EMPTY_CONNECT_FAILS };
    for (const u of this.users) {
      cAttempts += u.runtimeStats.connectAttempts;
      cFails += u.runtimeStats.connectFails;
      cByType.timeout += u.runtimeStats.connectFailsByType.timeout;
      cByType.transport += u.runtimeStats.connectFailsByType.transport;
      cByType.reject += u.runtimeStats.connectFailsByType.reject;
      cByType.other += u.runtimeStats.connectFailsByType.other;
    }
    this.counters.connectAttempts = cAttempts;
    this.counters.connectFails = cFails;
    this.counters.connectFailsByType = cByType; // P2 (R2): sum per-user — invariant sum(byType) == connectFails

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

    // Error theo giai đoạn (report tách tầng) — top-10 mỗi stage
    const errorsByStage: Record<string, { code: string; count: number }[]> = {};
    for (const [stage, byCode] of this.errorCountersByStage) {
      errorsByStage[stage] = [...byCode.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    }

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
      errorsByStage,
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

  /**
   * Truy vấn user (bảng virtualized). Filter: `filter` OR-match email/phase/roomId,
   * `phase` AND-match chính xác phase (dropdown). Sort theo whitelist (users-sort.ts).
   * phaseCounts: đếm phase của TOÀN BỘ user worker (không theo filter) — donut dashboard.
   */
  queryUsers(
    offset: number,
    limit: number,
    filter?: string,
    phase?: string,
    sortBy?: string,
    sortDir?: string,
  ): { rows: VirtualUserRow[]; total: number; phaseCounts: Partial<Record<UserPhase, number>> } {
    let users = this.users;
    if (filter) {
      const f = filter.toLowerCase();
      users = users.filter(
        (u) => u.account.email.toLowerCase().includes(f) || u.phase.includes(f) || (u.roomId ?? '').includes(f),
      );
    }
    if (phase) {
      const p = phase as UserPhase;
      users = users.filter((u) => u.phase === p);
    }
    // phaseCounts của toàn bộ user (không theo filter)
    const phaseCounts: Partial<Record<UserPhase, number>> = {};
    for (const u of this.users) phaseCounts[u.phase] = (phaseCounts[u.phase] ?? 0) + 1;
    const { sortBy: field, sortDir: dir } = normalizeSort(sortBy, sortDir);
    const rows = sortUsers(users.map((u) => u.toRow()), field, dir).slice(offset, offset + limit);
    return { rows, total: users.length, phaseCounts };
  }
}

export { ACTION_TYPES };
