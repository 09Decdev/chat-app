import { io, type Socket } from 'socket.io-client';
import { env } from './env';
import type {
  MatchingFoundPayload,
  ChatMessagePayload,
  ChatSendPayload,
  MemberLeftPayload,
  MemberJoinPayload,
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
  ChatReadUpdatePayload,
  ChatTimChangedPayload,
  ReadReceipts,
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
  /** Reply — giữ để resend đúng bản chất (KHÔNG để mất reply khi resend). */
  replyToId?: string | null;
  mentions?: string[];
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

/** Decode JWT `sub` (userId) từ token — để log xem socket đang kết nối bằng tài khoản nào. */
function decodeJwtSub(token: string | null): string | undefined {
  if (!token) return undefined;
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return json?.sub as string | undefined;
  } catch {
    return undefined;
  }
}

/** Cac event server → client (CHAT_API.md muc 5.2 + 10.6). */
export interface SocketHandlers {
  onConnect?: () => void;
  onDisconnect?: (reason: string) => void;
  onConnectError?: (err: Error) => void;
  onMatchingFound?: Handler<MatchingFoundPayload>;
  onJoined?: Handler<{ roomId: string; roomEndsAt?: number | null; readReceipts?: ReadReceipts }>;
  onMessage?: Handler<ChatMessagePayload>;
  onTyping?: Handler<TypingPayload>;
  onMemberLeft?: Handler<MemberLeftPayload>;
  onMemberJoin?: Handler<MemberJoinPayload>;
  onRoomClosed?: Handler<RoomClosedPayload>;
  onRoomExpired?: Handler<RoomExpiredPayload>;
  onLeft?: Handler<LeftRoomPayload>;
  onChatError?: Handler<ChatErrorPayload>;
  onVoteKickStarted?: Handler<VoteKickStartedPayload>;
  onVoteKickVoted?: Handler<VoteKickVotedPayload>;
  onVoteKickResult?: Handler<VoteKickResultPayload>;
  onReadReceiptsUpdate?: Handler<ChatReadUpdatePayload>;
  onTimChanged?: Handler<ChatTimChangedPayload>;
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
      tag('connected', { socketId: socket.id, tokenSub: decodeJwtSub(this.lastToken) });
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
      tag('chat:message', {
        id: p?.message?.id,
        userId: p?.message?.userId,
        displayName: p?.message?.displayName,
        content: p?.message?.content?.slice?.(0, 80),
        clientMsgId: p?.clientMsgId,
      });
      this.handlers.onMessage?.(p);
    });
    socket.on('chat:typing', (p: TypingPayload) => {
      this.handlers.onTyping?.(p);
    });
    socket.on('chat:member_left', (p: MemberLeftPayload) => {
      tag('chat:member_left', p);
      this.handlers.onMemberLeft?.(p);
    });
    socket.on('chat:member_join', (p: MemberJoinPayload) => {
      tag('chat:member_join', p);
      this.handlers.onMemberJoin?.(p);
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
    socket.on('chat:read:update', (p: ChatReadUpdatePayload) => {
      tag('chat:read:update', p);
      this.handlers.onReadReceiptsUpdate?.(p);
    });
    socket.on('chat:tim:changed', (p: ChatTimChangedPayload) => {
      tag('chat:tim:changed', p);
      this.handlers.onTimChanged?.(p);
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
    socket.on('star:received', (p: { fromUserId?: string; starCount?: number }) => {
      console.log('%c[chat-socket] ⭐ star:received', 'color:#f59e0b', p);
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
   * Trả về clientMsgId để store khớp echo với temp message (Risk 1).
   */
  sendChatMessage(payload: ChatSendPayload): string {
    const clientMsgId = genClientMsgId();
    this.pendingChat.set(clientMsgId, {
      clientMsgId,
      roomId: payload.roomId,
      content: payload.content,
      fileId: payload.fileId ?? null,
      sentAt: Date.now(),
      replyToId: payload.replyToId ?? null,
      mentions: payload.mentions,
    });
    if (this.socket?.connected) {
      console.log('%c[chat-socket] emit chat:send', 'color:#22d3ee', {
        roomId: payload.roomId,
        content: payload.content,
        clientMsgId,
        replyToId: payload.replyToId,
        mentionsCount: payload.mentions?.length ?? 0,
      });
      this.socket.emit('chat:send', { ...payload, clientMsgId });
    }
    return clientMsgId;
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
          replyToId: p.replyToId ?? undefined,
          mentions: p.mentions,
          clientMsgId,
        });
      }
    }
  }

  /** Read receipt: báo đã đọc tới createdAt (ISO) của tin mới nhất — debounce ở caller. */
  sendRead(roomId: string, lastReadAt: string) {
    if (!this.socket?.connected) return;
    console.log('%c[chat-socket] emit chat:read', 'color:#22d3ee', { roomId, lastReadAt });
    this.socket.emit('chat:read', { roomId, lastReadAt });
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
