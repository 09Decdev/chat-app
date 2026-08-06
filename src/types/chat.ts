/** ChatMessage schema (CHAT_API.md - Phu luc). */
export type ModerationStatus = 'ACTIVE' | 'UNBANNED' | 'SOFT_LOCKED' | 'ADMIN_LOCKED';
export type FileType = 'IMAGE' | string;

export interface ChatMessage {
  id: string;
  roomId: string;
  userId: string;
  content: string;
  displayName: string | null;
  avatarUrl: string | null;
  fileId: string | null;
  fileType: FileType | null;
  fileWidth: number | null;
  fileHeight: number | null;
  moderationStatus: ModerationStatus;
  createdAt: string; // ISO 8601
}

/** Trang thai phong cua nguoi dung. */
export type ChatPhase = 'idle' | 'matching' | 'matched' | 'in_room';

/** Thanh vien trong phong - profile duoc bo sung dần khi co message. */
export interface RoomMember {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  isMe?: boolean;
}

/** Ket qua ghim: matching:found payload. */
export interface MatchingFoundPayload {
  roomId: string;
  members: { userId: string; displayName?: string | null; avatarUrl?: string | null }[];
  /** v1.2: snapshot topics trong phong (da enrich displayName/avatarUrl). */
  topics?: TopicDto[];
  /** VÁ-4: absolute room end time (epoch ms) — countdown = roomEndsAt - Date.now(). */
  roomEndsAt?: number | null;
}

/** Topic cua 1 thanh vien trong phong (CHAT_API.md §10). */
export interface TopicDto {
  userId: string;
  title: string;
  createdAt: number; // epoch ms
  updatedAt?: number; // epoch ms
  displayName?: string | null;
  avatarUrl?: string | null;
}

/** Realtime envelope: chat:topic:created/updated (topic day du). */
export interface TopicCreatedPayload {
  eventId?: string;
  type?: string;
  roomId: string;
  topic: TopicDto;
  userId: string;
  timestamp?: number;
}
/** Realtime envelope: chat:topic:updated (giu createdAt, updatedAt = now). */
export type TopicUpdatedPayload = TopicCreatedPayload;
/** Realtime envelope: chat:topic:deleted (topic = null, chi co userId). */
export interface TopicDeletedPayload {
  eventId?: string;
  type?: string;
  roomId: string;
  topic: null;
  userId: string;
  timestamp?: number;
}

/** Payload client → server cho chat:send (Risk 1: clientMsgId để server dedupe + client khớp outbox). */
export interface ChatSendPayload {
  roomId: string;
  content: string;
  fileId?: string | null;
  clientMsgId?: string;
}

/** chat:message payload (echo kèm clientMsgId khi client gửi kèm — Risk 1). */
export interface ChatMessagePayload {
  message: ChatMessage;
  clientMsgId?: string;
}

/** chat:member_left payload. */
export interface MemberLeftPayload {
  userId: string;
  reason: 'VOLUNTARY' | string;
}

/** chat:member_join payload — có người mới vào phòng (kèm profile để hiển thị ngay, CHAT_API.md 5.2). */
export interface MemberJoinPayload {
  roomId: string;
  member: { userId: string; displayName?: string | null; avatarUrl?: string | null };
  /** VÁ-4: absolute room end time (epoch ms) — làm mới countdown phòng. */
  roomEndsAt?: number | null;
}

/** chat:room_closed payload. */
export interface RoomClosedPayload {
  roomId: string;
  reason: 'ROOM_EXPIRED' | string;
}

/** roomExpired payload. */
export interface RoomExpiredPayload {
  roomId: string;
}

/** chat:typing payload (server → client). */
export interface TypingPayload {
  userId: string;
  roomId: string;
}

/** chat:error payload. */
export interface ChatErrorPayload {
  code: 'FORBIDDEN' | 'BAD_REQUEST' | 'LEAVE_FAILED' | string;
  message: string;
}

/** POST /chat/match response (unwrapped). */
export interface MatchEnqueueResult {
  queued: boolean;
  position: number;
}

/** GET /chat/match/queue-count response. */
export interface QueueCountResult {
  count: number;
}

/** DELETE /chat/match response. */
export interface MatchCancelResult {
  cancelled: boolean;
}

/** GET /chat/match/my-room response (unwrapped). */
export interface MyRoomResult {
  roomId: string | null;
  /** v1.2: snapshot topics trong phong (da enrich). [] neu khong co phong. */
  topics: TopicDto[];
  /** VÁ-4: absolute room end time (epoch ms) — countdown = roomEndsAt - Date.now(). null khi khong co phong. */
  roomEndsAt?: number | null;
}

/** PUT /chat/rooms/:roomId/my-topic response (unwrapped). */
export interface SetMyTopicResult {
  topic: TopicDto;
}

/** DELETE /chat/rooms/:roomId/my-topic response (unwrapped). */
export interface DeleteMyTopicResult {
  deleted: boolean;
}

/** GET /chat/rooms/:roomId/messages response (parsed defensively). */
export interface MessagesPage {
  messages: ChatMessage[];
  nextCursor: string | null;
}

// ─── Vote Kick ──────────────────────────────────────────────────────────

export type VoteKickResult = 'KICKED' | 'TIMEOUT' | 'CANCELLED';

export interface VoteKickStartedPayload {
  roomId: string;
  targetUserId: string;
  initiatorId: string;
  requiredVotes: number;
  currentVotes: number;
  expiresAt: number;
}

export interface VoteKickVotedPayload {
  roomId: string;
  targetUserId: string;
  voterId: string;
  currentVotes: number;
  requiredVotes: number;
}

export interface VoteKickResultPayload {
  roomId: string;
  targetUserId: string;
  result: VoteKickResult;
  currentVotes: number;
  requiredVotes: number;
  reason?: string;
}
