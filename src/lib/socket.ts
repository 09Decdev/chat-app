import { io, type Socket } from 'socket.io-client';
import { env } from './env';
import type {
  MatchingFoundPayload,
  ChatMessagePayload,
  ChatSendPayload,
  MemberLeftPayload,
  RoomClosedPayload,
  RoomExpiredPayload,
  ChatErrorPayload,
  TypingPayload,
  VoteKickStartedPayload,
  VoteKickVotedPayload,
  VoteKickResultPayload,
  TopicCreatedPayload,
  TopicUpdatedPayload,
  TopicDeletedPayload,
} from '@/types/chat';

type Handler<T> = (payload: T) => void;

/** chat:left ack — gateway xác nhận đã rời phòng + thời gian hết cooldown (epoch ms). */
export interface LeftRoomPayload {
  roomId: string;
  cooldownEndsAt: number;
}

/** Tin nhan dang cho echo (Risk 1 — outbox trong memory, resend khi join lai room). */
interface PendingChatMessage {
  clientMsgId: string;
  roomId: string;
  content: string;
  fileId?: string | null;
  sentAt: number;
}

/** Tu bo sau TTL — tranh resend vinh vien khi server silent-skip (rate-limit/too-long). */
const PENDING_CHAT_TTL_MS = 60_000;

function genClientMsgId(): string {
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- legacy-compat guard: crypto.randomUUID not in older runtimes
    (crypto as any)?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  );
}

/** Cac event server → client (CHAT_API.md muc 5.2 + 10.6). */
export interface SocketHandlers {
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onConnectError?: (err: Error) => void;
  onMatchingFound?: Handler<MatchingFoundPayload>;
  onJoined?: Handler<{ roomId: string; roomEndsAt?: number | null }>;
  onMessage?: Handler<ChatMessagePayload>;
  onTyping?: Handler<TypingPayload>;
  onMemberLeft?: Handler<MemberLeftPayload>;
  onRoomClosed?: Handler<RoomClosedPayload>;
  onRoomExpired?: Handler<RoomExpiredPayload>;
  onLeft?: Handler<LeftRoomPayload>;
  onChatError?: Handler<ChatErrorPayload>;
  onVoteKickStarted?: Handler<VoteKickStartedPayload>;
  onVoteKickVoted?: Handler<VoteKickVotedPayload>;
  onVoteKickResult?: Handler<VoteKickResultPayload>;
  // Topic realtime (CHAT_API.md §10.6)
  onTopicCreated?: Handler<TopicCreatedPayload>;
  onTopicUpdated?: Handler<TopicUpdatedPayload>;
  onTopicDeleted?: Handler<TopicDeletedPayload>;
}

class SocketManager {
  private socket: Socket | null = null;
  private lastToken: string | null = null;
  private pendingChat = new Map<string, PendingChatMessage>();
  handlers: SocketHandlers = {};

  setHandlers(h: SocketHandlers) {
    this.handlers = h;
  }

  /** Ket noi voi token; idempotent neu da ket noi cung token. */
  connect(token: string) {
    if (this.socket?.connected && this.lastToken === token) return;
    this.disconnect();
    const socket = io(env.gatewayUrl, {
      path: env.socketPath,
      transports: ['websocket', 'polling'],
      // SEC-3 (F-8): token qua Authorization header + socket.io `auth` (CONNECT packet).
      // KHÔNG đưa vào query string (gateway đọc auth.token → query → header —
      // websocket.gateway.ts:147-150). Browser native WebSocket KHÔNG gửi extraHeaders trên
      // websocket transport — `auth` đảm bảo token tới gateway ở MỌI transport.
      auth: { token },
      extraHeaders: { Authorization: `Bearer ${token}` },
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });
    this.bind(socket);
    this.socket = socket;
    this.lastToken = token;
  }

  private bind(socket: Socket) {
    const tag = (t: string, data?: unknown) =>
      console.log('%c[chat-socket] ' + t, 'color:#a855f7', data ?? '');
    socket.on('connect', () => {
      tag('connected', socket.id);
      this.handlers.onConnect?.();
    });
    socket.on('disconnect', (reason: string) => {
      console.warn('[chat-socket] disconnect', reason);
      this.handlers.onDisconnect?.(reason);
    });
    socket.on('connect_error', (err: Error) => {
      console.error('[chat-socket] connect_error', err.message);
      this.handlers.onConnectError?.(err);
    });
    socket.on('matching:found', (p: MatchingFoundPayload) => {
      tag('matching:found', p);
      this.handlers.onMatchingFound?.(p);
    });
    socket.on('chat:joined', (p: { roomId: string; roomEndsAt?: number | null }) => {
      tag('chat:joined', p);
      this.handlers.onJoined?.(p);
    });
    socket.on('chat:message', (p: ChatMessagePayload) => {
      // Echo có clientMsgId → xác nhận message đã tới server → xóa khỏi outbox (Risk 1)
      if (p?.clientMsgId) this.pendingChat.delete(p.clientMsgId);
      tag('chat:message', p?.message?.id);
      this.handlers.onMessage?.(p);
    });
    socket.on('chat:typing', (p: TypingPayload) => {
      this.handlers.onTyping?.(p);
    });
    socket.on('chat:member_left', (p: MemberLeftPayload) => {
      tag('chat:member_left', p);
      this.handlers.onMemberLeft?.(p);
    });
    socket.on('chat:room_closed', (p: RoomClosedPayload) => {
      tag('chat:room_closed', p);
      this.handlers.onRoomClosed?.(p);
    });
    socket.on('roomExpired', (p: RoomExpiredPayload) => {
      tag('roomExpired', p);
      this.handlers.onRoomExpired?.(p);
    });
    socket.on('chat:left', (p: LeftRoomPayload) => {
      tag('chat:left', p);
      this.handlers.onLeft?.(p);
    });
    socket.on('chat:error', (p: ChatErrorPayload) => {
      console.error('[chat-socket] chat:error', p);
      this.handlers.onChatError?.(p);
    });
    socket.on('chat:vote_kick:started', (p: VoteKickStartedPayload) => {
      tag('chat:vote_kick:started', p);
      this.handlers.onVoteKickStarted?.(p);
    });
    socket.on('chat:vote_kick:voted', (p: VoteKickVotedPayload) => {
      tag('chat:vote_kick:voted', p);
      this.handlers.onVoteKickVoted?.(p);
    });
    socket.on('chat:vote_kick:result', (p: VoteKickResultPayload) => {
      tag('chat:vote_kick:result', p);
      this.handlers.onVoteKickResult?.(p);
    });
    socket.on('chat:topic:created', (p: TopicCreatedPayload) => {
      tag('chat:topic:created', p);
      this.handlers.onTopicCreated?.(p);
    });
    socket.on('chat:topic:updated', (p: TopicUpdatedPayload) => {
      tag('chat:topic:updated', p);
      this.handlers.onTopicUpdated?.(p);
    });
    socket.on('chat:topic:deleted', (p: TopicDeletedPayload) => {
      tag('chat:topic:deleted', p);
      this.handlers.onTopicDeleted?.(p);
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.lastToken = null;
    // Logout / đổi token — outbox của phiên cũ không còn hợp lệ
    this.pendingChat.clear();
  }

  /**
   * chat:send qua outbox (Risk 1): luôn gán clientMsgId + giữ lại cho đến khi có echo.
   * Gửi được ngay nếu socket đang connected; nếu không, chờ resend khi join lại room.
   */
  sendChatMessage(payload: ChatSendPayload) {
    const clientMsgId = genClientMsgId();
    this.pendingChat.set(clientMsgId, {
      clientMsgId,
      roomId: payload.roomId,
      content: payload.content,
      fileId: payload.fileId ?? null,
      sentAt: Date.now(),
    });
    if (this.socket?.connected) {
      this.socket.emit('chat:send', { ...payload, clientMsgId });
    }
  }

  /** Resend toàn bộ pending của room (gọi từ store khi đã chat:joined — đã trong room). */
  resendPendingChat(roomId: string) {
    const now = Date.now();
    for (const [clientMsgId, p] of this.pendingChat) {
      if (now - p.sentAt > PENDING_CHAT_TTL_MS) {
        this.pendingChat.delete(clientMsgId);
        continue;
      }
      if (p.roomId !== roomId) continue; // pending của room cũ — bỏ, không gửi nhầm phòng mới
      if (this.socket?.connected) {
        this.socket.emit('chat:send', {
          roomId: p.roomId,
          content: p.content,
          fileId: p.fileId,
          clientMsgId,
        });
      }
    }
  }

  emit(event: string, payload: unknown) {
    console.log('%c[chat-socket] emit ' + event, 'color:#22d3ee', payload);
    if (!this.socket?.connected) {
      console.warn('[chat-socket] emit skipped (socket not connected)', event);
      return;
    }
    this.socket.emit(event, payload);
  }

  get connected() {
    return !!this.socket?.connected;
  }
}

export const socketManager = new SocketManager();
