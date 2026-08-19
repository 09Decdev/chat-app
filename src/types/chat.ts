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

  // Reply (quote) — snapshot lúc reply; replyToId bất biến, sống sót khi tin gốc bị xóa
  replyToId?: string | null;
  replyToContent?: string | null;
  replyToUserId?: string | null;
  replyToSenderName?: string | null;
  // @mention — [userId] được tag (server validate thành viên phòng)
  mentionedUserIds?: string[];
  // soft-delete (server trả isDeleted+deletedAt) — dùng để chặn reply vào tin đã xóa
  isDeleted?: boolean;
  deletedAt?: string | null;
  // Tim/like: tổng lượt tim + trạng thái "mình đã tim" (likedByMe chỉ có trong GET history)
  timCount?: number;
  likedByMe?: boolean;
}

/** Trang thai phong cua nguoi dung. */
export type ChatPhase = 'idle' | 'matching' | 'matched' | 'in_room';

/** Thanh vien trong phong - profile duoc bo sung dần khi co message. */
export interface RoomMember {
  userId: string;
  displayName: string | null;
  avatarUrl: string | null;
  isMe?: boolean;
  starCount?: number | null;
}

/** Read receipt: bản đồ {userId: lastReadAt-ISO} — watermark thời gian (so sánh message.createdAt <= lastReadAt). */
export type ReadReceipts = Record<string, string>;

/** chat:read:update payload — server broadcast bản đồ đầy đủ. */
export interface ChatReadUpdatePayload {
  roomId: string;
  readReceipts: ReadReceipts;
  /** Enrich: tên + avatar cho từng user (để client render avatar tick, không cần tra member list). */
  readReceiptDetails?: Array<{
    userId: string;
    lastReadAt: string;
    displayName: string | null;
    avatarUrl: string | null;
  }>;
  roomEndsAt?: number | null;
}

/** chat:tim:changed payload (like/unlike 1 tin) — client tự update count/liked trong list. */
export interface ChatTimChangedPayload {
  roomId: string;
  messageId: string;
  userId: string;
  liked: boolean;
  likeCount: number;
  roomEndsAt?: number | null;
}

/** Ket qua ghim: matching:found payload. */
export interface MatchingFoundPayload {
  roomId: string;
  members: { userId: string; displayName?: string | null; avatarUrl?: string | null }[];
  /** v1.2: snapshot topics trong phong (da enrich displayName/avatarUrl). */
  topics?: TopicDto[];
  /** VÁ-4: absolute room end time (epoch ms) — countdown = roomEndsAt - Date.now(). */
  roomEndsAt?: number | null;
  /** Read receipt initial state (best-effort — rỗng nếu chưa ai đọc). */
  readReceipts?: ReadReceipts;
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
  /** Reply: id tin bị reply — server tự resolve snapshot (replyToId bất biến). */
  replyToId?: string | null;
  /** @mention: [userId] — server validate từng id là thành viên phòng. */
  mentions?: string[];
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

// ─── Room search + media gallery (2026-08-07) ─────────────────────────────

/** 1 kết quả search tin nhắn (Postgres FTS). headline = '...<b>match</b>...' — client render bold. */
export interface SearchResultItem {
  id: string;
  userId: string;
  content: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  fileId: string | null;
  fileType: FileType | null;
  fileWidth: number | null;
  fileHeight: number | null;
  createdAt: string; // ISO
  rank: number;
  headline: string;
}

/** GET /chat/rooms/:roomId/messages/search response. */
export interface SearchMessagesPage {
  data: SearchResultItem[];
  nextCursor: string | null;
  hasNextPage: boolean;
}

/** 1 media item (ảnh/file) trong room — presignedUrl server-side enrich. */
export interface RoomMediaItem {
  messageId: string;
  fileId: string | null;
  fileType: FileType | null;
  fileWidth: number | null;
  fileHeight: number | null;
  mimeType: string | null;
  presignedUrl: string | null;
  senderId: string;
  senderDisplayName: string | null;
  senderAvatarUrl: string | null;
  createdAt: string; // ISO
}

/** GET /chat/rooms/:roomId/media response. */
export interface RoomMediaPage {
  data: RoomMediaItem[];
  nextCursor: string | null;
  members: RoomMember[] | null;
}

// ─── Vote Kick ──────────────────────────────────────────────────────────

export type VoteKickResult = 'KICKED' | 'TIMEOUT' | 'CANCELLED';
/** Lựa chọn phiếu kick: 'for' = đồng ý kick, 'against' = không đồng ý (phủ quyết). */
export type VoteKickChoice = 'for' | 'against';

export interface VoteKickStartedPayload {
  roomId: string;
  targetUserId: string;
  initiatorId: string;
  requiredVotes: number;
  currentVotes: number;
  currentAgainstVotes?: number;
  expiresAt: number;
}

export interface VoteKickVotedPayload {
  roomId: string;
  targetUserId: string;
  voterId: string;
  currentVotes: number;
  currentAgainstVotes?: number;
  requiredVotes: number;
}

export interface VoteKickResultPayload {
  roomId: string;
  targetUserId: string;
  result: VoteKickResult;
  currentVotes: number;
  currentAgainstVotes?: number;
  requiredVotes: number;
  reason?: string;
}

// ─── Bookmark (tim tin) + @mention members (2026-08-18) ────────────────────

/** Bookmark pointer-only — message null = tin gốc đã bị xóa/purge (hiện placeholder). */
export interface ChatBookmark {
  id: string;
  roomId: string;
  messageId: string;
  createdAt: string;
  message: Pick<ChatMessage, 'id' | 'userId' | 'content' | 'displayName' | 'avatarUrl' | 'fileId' | 'fileType' | 'createdAt'> | null;
}

/** GET /chat/rooms/:roomId/members — gợi ý @mention. */
export type RoomMembersResult = RoomMember[];
