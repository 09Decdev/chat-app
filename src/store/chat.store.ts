import { create } from 'zustand';
import { toast } from 'sonner';
import { chatApi, ApiError } from '@/lib/api';
import { socketManager, type SocketHandlers, type LeftRoomPayload } from '@/lib/socket';
import { env } from '@/lib/env';
import { matchingFlag, topicDraft as topicDraftStorage } from '@/lib/storage';
import { ChatErrorCode, SocketChatErrorCode, friendlyMessage } from '@/lib/constants';
import { useAuthStore } from './auth.store';
import type {
  ChatMessage,
  ChatPhase,
  RoomMember,
  MatchingFoundPayload,
  ChatMessagePayload,
  MemberLeftPayload,
  RoomClosedPayload,
  RoomExpiredPayload,
  ChatErrorPayload,
  TypingPayload,
  VoteKickStartedPayload,
  VoteKickVotedPayload,
  VoteKickResultPayload,
  TopicDto,
  TopicCreatedPayload,
  TopicUpdatedPayload,
  TopicDeletedPayload,
} from '@/types/chat';

export type LocalMessage = ChatMessage & { _local?: 'pending' | 'failed' };

export interface VoteKickState {
  active: boolean;
  targetUserId: string | null;
  initiatorId: string | null;
  currentVotes: number;
  requiredVotes: number;
  expiresAt: number | null;
}

const idleVoteKick: VoteKickState = {
  active: false,
  targetUserId: null,
  initiatorId: null,
  currentVotes: 0,
  requiredVotes: 0,
  expiresAt: null,
};

interface ChatState {
  phase: ChatPhase;
  roomId: string | null;
  roomEndsAt: number | null; // VÁ-4: absolute room end (epoch ms) — countdown = roomEndsAt - Date.now()
  members: RoomMember[];
  messages: LocalMessage[];
  nextCursor: string | null;
  loadingHistory: boolean;
  loadingOlder: boolean;
  queuePosition: number | null;
  queueSize: number | null;
  joined: boolean;
  socketConnected: boolean;
  cooldownUntil: number | null;
  requirePhoneVerify: boolean;
  lastSentAt: number | null;
  pendingTemp: string[];
  typingUsers: string[];
  voteKick: VoteKickState;

  // Topic (per-member topic trong phong chat — CHAT_API.md §10)
  topics: TopicDto[];
  topicDraft: string; // gia tri textarea trong EditTopicSheet
  topicSheetOpen: boolean;
  topicSheetMode: 'create' | 'edit';
  topicSaving: boolean;
  topicError: { code?: string; message: string } | null;
  topicRateLimitUntil: number | null; // epoch ms khi con rate-limit

  // lifecycle
  init: () => Promise<void>;
  startMatching: (topic?: string) => Promise<void>;
  cancelMatching: () => Promise<void>;
  leaveRoom: () => void;
  sendMessage: (content: string) => void;
  emitTyping: () => void;
  enterRoom: () => void;
  loadHistory: () => Promise<void>;
  loadOlder: () => Promise<void>;
  reset: () => void;
  startVoteKick: (targetUserId: string) => void;
  castVoteKick: () => void;

  // topic actions
  setTopicSheetOpen: (open: boolean, mode?: 'create' | 'edit') => void;
  setTopicDraft: (text: string) => void;
  submitTopic: () => Promise<void>;
  removeMyTopic: () => Promise<void>;

  // socket handlers
  onMatchingFound: (p: MatchingFoundPayload) => void;
  onJoined: (p: {
    roomId: string;
    roomEndsAt?: number | null;
    members?: { userId: string; displayName?: string | null; avatarUrl?: string | null }[];
  }) => void;
  onMessage: (p: ChatMessagePayload) => void;
  onTyping: (p: TypingPayload) => void;
  onMemberLeft: (p: MemberLeftPayload) => void;
  onRoomClosed: (p: RoomClosedPayload) => void;
  onRoomExpired: (p: RoomExpiredPayload) => void;
  onLeft: (p: LeftRoomPayload) => void;
  onChatError: (p: ChatErrorPayload) => void;
  onVoteKickStarted: (p: VoteKickStartedPayload) => void;
  onVoteKickVoted: (p: VoteKickVotedPayload) => void;
  onVoteKickResult: (p: VoteKickResultPayload) => void;
  onTopicCreated: (p: TopicCreatedPayload) => void;
  onTopicUpdated: (p: TopicUpdatedPayload) => void;
  onTopicDeleted: (p: TopicDeletedPayload) => void;
}

function meId(): string {
  return useAuthStore.getState().user?.id ?? '';
}

function dedupeById(arr: LocalMessage[]): LocalMessage[] {
  const seen = new Set<string>();
  const out: LocalMessage[] = [];
  for (let i = arr.length - 1; i >= 0; i--) {
    if (seen.has(arr[i].id)) continue;
    seen.add(arr[i].id);
    out.unshift(arr[i]);
  }
  return out;
}

function upsertMemberProfile(msg: ChatMessage, members: RoomMember[]): RoomMember[] {
  const idx = members.findIndex((m) => m.userId === msg.userId);
  if (idx === -1) {
    return [...members, { userId: msg.userId, displayName: msg.displayName, avatarUrl: msg.avatarUrl }];
  }
  const m = members[idx];
  const next = {
    ...m,
    displayName: m.displayName ?? msg.displayName ?? null,
    avatarUrl: m.avatarUrl ?? msg.avatarUrl ?? null,
  };
  const copy = members.slice();
  copy[idx] = next;
  return copy;
}

function extractCooldownSeconds(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const v = o.retryAfterSeconds ?? o.retryAfter ?? o.ttl ?? o.cooldownSeconds ?? o.remainingSeconds;
  return typeof v === 'number' ? v : null;
}

const idleState = {
  phase: 'idle' as ChatPhase,
  roomId: null,
  roomEndsAt: null as number | null,
  members: [] as RoomMember[],
  messages: [] as LocalMessage[],
  nextCursor: null,
  joined: false,
  queuePosition: null,
  queueSize: null,
  requirePhoneVerify: false,
  pendingTemp: [] as string[],
  typingUsers: [] as string[],
  voteKick: idleVoteKick,
  topics: [] as TopicDto[],
  topicDraft: '',
  topicSheetOpen: false,
  topicSheetMode: 'create' as 'create' | 'edit',
  topicSaving: false,
  topicError: null as { code?: string; message: string } | null,
  topicRateLimitUntil: null as number | null,
};

/** Timer auto-hide cho từng user đang gõ (ephemeral, không cần persist). */
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
function clearAllTyping() {
  typingTimers.forEach((t) => clearTimeout(t));
  typingTimers.clear();
}

/** Poll số người trong hàng chờ khi đang matching (refresh mỗi 1s). */
let queueCountTimer: ReturnType<typeof setInterval> | null = null;
function stopQueueCountPoll() {
  if (queueCountTimer) {
    clearInterval(queueCountTimer);
    queueCountTimer = null;
  }
}

export const useChatStore = create<ChatState>((set, get) => ({
  ...idleState,
  loadingHistory: false,
  loadingOlder: false,
  socketConnected: false,
  cooldownUntil: null,
  lastSentAt: null,

  init: async () => {
    try {
      const { roomId, topics, roomEndsAt } = await chatApi.myRoom();
      console.log('%c[chat] init my-room', 'color:#a855f7', { roomId, topicsCount: topics?.length ?? 0 });
      if (roomId) {
        const me = meId();
        set({
          phase: 'in_room',
          roomId,
          roomEndsAt: roomEndsAt ?? null,
          members: [{ userId: me, displayName: null, avatarUrl: null, isMe: true }],
          joined: false,
          topics: topics ?? [],
        });
        socketManager.emit('chat:join', { roomId });
        await get().loadHistory();
      } else if (matchingFlag.get()) {
        set({ phase: 'idle', topics: [] });
        await get().startMatching();
      } else {
        set({ phase: 'idle', topics: [] });
      }
    } catch (e) {
      const err = e as ApiError;
      set({ phase: 'idle', topics: [] });
      toast.error(err.message ?? 'Khong tai duoc trang thai phong.');
    }
  },

  startMatching: async (topic?: string) => {
    const now = Date.now();
    if (get().cooldownUntil && now < (get().cooldownUntil ?? 0)) {
      toast.error(friendlyMessage(ChatErrorCode.COOLDOWN_ACTIVE, 'Dang khoa, vui long cho.'));
      return;
    }
    set({ phase: 'matching', queuePosition: null, queueSize: null, requirePhoneVerify: false });
    matchingFlag.set(true);

    // Bat dau poll so nguoi trong hang cho sau khi enqueue thanh cong.
    const startQueuePoll = () => {
      stopQueueCountPoll();
      const refreshQueueCount = async () => {
        if (get().phase !== 'matching') {
          stopQueueCountPoll();
          return;
        }
        try {
          const r = await chatApi.queueCount();
          if (get().phase === 'matching') set({ queueSize: r.count });
        } catch {
          /* ignore — poll tiếp vòng sau */
        }
      };
      void refreshQueueCount();
      queueCountTimer = setInterval(refreshQueueCount, 1000);
    };

    const handleEnqueueError = (e: unknown) => {
      const err = e as ApiError;
      matchingFlag.set(false);
      if (err.code === ChatErrorCode.COOLDOWN_ACTIVE) {
        // VÁ-4: ưu tiên cooldownEndsAt (absolute epoch ms từ server) — tránh countdown trôi đồng hồ;
        // fallback extractCooldownSeconds (TTL từ payload) như cũ.
        const raw = err.raw as Record<string, unknown> | undefined;
        const endsAt = typeof raw?.cooldownEndsAt === 'number' ? raw.cooldownEndsAt : null;
        const ttl = extractCooldownSeconds(err.raw);
        set({
          phase: 'idle',
          cooldownUntil: endsAt ?? now + (ttl ?? env.cooldownSeconds) * 1000,
          queuePosition: null,
        });
        toast.error(friendlyMessage(err.code, err.message));
      } else if (err.code === ChatErrorCode.ALREADY_SEATED) {
        void get().init();
      } else if (err.code === ChatErrorCode.PHONE_NOT_VERIFIED) {
        set({ phase: 'idle', requirePhoneVerify: true });
        toast.error(friendlyMessage(err.code, err.message));
      } else {
        set({ phase: 'idle' });
        toast.error(err.message ?? 'Khong vao duoc hang cho.');
      }
    };

    try {
      const res = await chatApi.enqueue(topic);
      set({ queuePosition: res.position });
      startQueuePoll();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === ChatErrorCode.TOPIC_TITLE_INVALID) {
        // E1: topic sai bound — khong chặn luong chinh, retry khong kèm topic
        toast.warning('Chủ đề không hợp lệ — đã xếp hàng không kèm chủ đề');
        try {
          const res = await chatApi.enqueue();
          set({ queuePosition: res.position });
          startQueuePoll();
        } catch (e2) {
          handleEnqueueError(e2);
        }
      } else {
        handleEnqueueError(e);
      }
    }
  },

  cancelMatching: async () => {
    try {
      await chatApi.cancel();
    } catch {
      /* ignore — van quay ve idle */
    }
    matchingFlag.set(false);
    stopQueueCountPoll();
    set({ phase: 'idle', queuePosition: null, queueSize: null });
  },

  leaveRoom: () => {
    const roomId = get().roomId;
    if (roomId) socketManager.emit('chat:leave', { roomId });
    matchingFlag.set(false);
    clearAllTyping();
    set({
      ...idleState,
      cooldownUntil: Date.now() + env.cooldownSeconds * 1000,
    });
    toast('Ban da roi phong. Khoa 15 phut truoc khi ghép lai.', { icon: '🔒' });
  },

  sendMessage: (content) => {
    const s = get();
    const me = meId();
    const roomId = s.roomId;
    if (!roomId || !me || !s.joined) return;
    const trimmed = content.trim();
    if (!trimmed || trimmed.length > env.messageMaxChars) return;
    const now = Date.now();
    if (s.lastSentAt && now - s.lastSentAt < env.messageMinIntervalMs) {
      toast.warning('Dang gui qua nhanh, vui long cho 2 giay.');
      return;
    }
    const tempId = `local:${now}:${Math.floor(now / 1000) % 1000}`;
    const tempMsg: LocalMessage = {
      id: tempId,
      roomId,
      userId: me,
      content: trimmed,
      displayName: null,
      avatarUrl: null,
      fileId: null,
      fileType: null,
      fileWidth: null,
      fileHeight: null,
      moderationStatus: 'ACTIVE',
      createdAt: new Date(now).toISOString(),
      _local: 'pending',
    };
    set((st) => ({
      messages: dedupeById([...st.messages, tempMsg]),
      lastSentAt: now,
      pendingTemp: [...st.pendingTemp, tempId],
    }));
    socketManager.sendChatMessage({ roomId, content: trimmed });
    window.setTimeout(() => {
      const cur = get();
      if (cur.pendingTemp.includes(tempId)) {
        set((st) => ({
          messages: st.messages.map((m) =>
            m.id === tempId && m._local === 'pending' ? { ...m, _local: 'failed' as const } : m,
          ),
          pendingTemp: st.pendingTemp.filter((id) => id !== tempId),
        }));
        toast.error('Tin nhan chua duoc xac nhan. Thu lai.');
      }
    }, 10000);
  },

  loadHistory: async () => {
    const roomId = get().roomId;
    if (!roomId) return;
    set({ loadingHistory: true });
    try {
      const page = await chatApi.messages(roomId, null);
      const reversed = page.messages.slice().reverse();
      console.log('%c[chat] loadHistory', 'color:#a855f7', {
        roomId,
        msgCount: reversed.length,
        membersBefore: get().members.length,
      });
      set((st) => {
        // Bổ sung profile cho members từ history (giúp reconnect hiện avatar
        // những người đã chat, vì matching:found không re-emit khi vào lại phòng).
        let members = st.members;
        for (const m of reversed) members = upsertMemberProfile(m, members);
        return {
          messages: reversed,
          nextCursor: page.nextCursor,
          members,
          loadingHistory: false,
        };
      });
      console.log('%c[chat] loadHistory done', 'color:#a855f7', { membersAfter: get().members.length, members: get().members });
    } catch (e) {
      const err = e as ApiError;
      set({ loadingHistory: false });
      toast.error(err.message ?? 'Khong tai duoc lich su tin nhan.');
    }
  },

  loadOlder: async () => {
    const s = get();
    if (!s.roomId || !s.nextCursor || s.loadingOlder) return;
    set({ loadingOlder: true });
    try {
      const page = await chatApi.messages(s.roomId, s.nextCursor);
      set((st) => ({
        messages: dedupeById([...page.messages.slice().reverse(), ...st.messages]),
        nextCursor: page.nextCursor,
        loadingOlder: false,
      }));
    } catch (e) {
      const err = e as ApiError;
      set({ loadingOlder: false });
      toast.error(err.message ?? 'Khong tai duoc tin nhan cu hon.');
    }
  },

  emitTyping: () => {
    const s = get();
    if (!s.roomId || !s.joined) return;
    socketManager.emit('chat:typing', { roomId: s.roomId });
  },

  onTyping: ({ userId, roomId }) => {
    const me = meId();
    if (userId === me) return; // không hiển thị typing của chính mình
    if (get().roomId !== roomId) return; // chỉ quan tâm phòng hiện tại
    set((st) => ({
      typingUsers: st.typingUsers.includes(userId) ? st.typingUsers : [...st.typingUsers, userId],
    }));
    // reset auto-hide: mỗi lần nhận typing → hẹn xóa sau typingHideMs
    const prev = typingTimers.get(userId);
    if (prev) clearTimeout(prev);
    typingTimers.set(
      userId,
      setTimeout(() => {
        typingTimers.delete(userId);
        set((st) => ({ typingUsers: st.typingUsers.filter((u) => u !== userId) }));
      }, env.typingHideMs),
    );
  },

  reset: () => {
    stopQueueCountPoll();
    clearAllTyping();
    set({ ...idleState, loadingHistory: false, loadingOlder: false, cooldownUntil: null, lastSentAt: null });
  },

  onMatchingFound: ({ roomId, members, topics, roomEndsAt }) => {
    const me = meId();
    console.log('%c[chat] matching:found', 'color:#22d3ee', { roomId, membersCount: members.length, members, topicsCount: topics?.length ?? 0 });
    matchingFlag.set(false);
    stopQueueCountPoll();
    clearAllTyping();
    // Clear draft topic o man xep hang (sessionStorage) — matching da thanh cong
    topicDraftStorage.clear();
    set({
      phase: 'matched',
      roomId,
      roomEndsAt: roomEndsAt ?? null,
      joined: false,
      members: members.map((m) => ({
        userId: m.userId,
        displayName: m.displayName ?? null,
        avatarUrl: m.avatarUrl ?? null,
        isMe: m.userId === me,
      })),
      messages: [],
      nextCursor: null,
      queuePosition: null,
      queueSize: null,
      typingUsers: [],
      topics: topics ?? [],
    });
  },

  enterRoom: () => {
    const roomId = get().roomId;
    set({ phase: 'in_room' });
    if (roomId) {
      socketManager.emit('chat:join', { roomId });
      void get().loadHistory();
    }
  },

  onJoined: ({ roomId, members, roomEndsAt }) => {
    console.log('%c[chat] chat:joined', 'color:#22d3ee', { roomId, membersCount: members?.length, members });
    if (get().roomId !== roomId) return;
    const me = meId();
    set((st) => ({
      joined: true,
      // VÁ-4: chat:joined có thể mang roomEndsAt (gateway đọc expiresAt) — làm mới countdown phòng
      ...(typeof roomEndsAt === 'number' ? { roomEndsAt } : {}),
      members:
        members && members.length
          ? members.map((m) => ({
              userId: m.userId,
              displayName: m.displayName ?? null,
              avatarUrl: m.avatarUrl ?? null,
              isMe: m.userId === me,
            }))
          : st.members,
    }));
    // Đã vào room → flush outbox (Risk 1): resend tin chưa có echo, dedupe bằng clientMsgId
    socketManager.resendPendingChat(roomId);
  },

  onMessage: ({ message }) => {
    const me = meId();
    set((st) => {
      // Risk 4: bỏ qua message của user không còn là member — 2 topic outbound
      // (chat.message.event vs chat.room.event) có thể lệch thứ tự: "member rời
      // phòng rồi message của họ đến sau". Chỉ filter khi đã có member list
      // (tránh xóa nhầm message trong lúc chưa nhận chat:joined).
      if (st.members.length > 0 && !st.members.some((m) => m.userId === message.userId)) {
        return st;
      }
      let replaced = false;
      const next = st.messages.map((m) => {
        if (!replaced && m._local && message.userId === me) {
          replaced = true;
          return message;
        }
        return m;
      });
      if (!replaced && !st.messages.some((m) => m.id === message.id)) {
        next.push(message);
      }
      return {
        messages: dedupeById(next),
        members: upsertMemberProfile(message, st.members),
      };
    });
  },

  onMemberLeft: ({ userId, reason }) => {
    const me = meId();
    if (userId === me) {
      clearAllTyping();
      set({ ...idleState });
      return;
    }
    const t = typingTimers.get(userId);
    if (t) clearTimeout(t);
    typingTimers.delete(userId);
    set((st) => ({
      members: st.members.filter((m) => m.userId !== userId),
      typingUsers: st.typingUsers.filter((u) => u !== userId),
    }));
    toast(`Mot thanh vien da roi phong.`, { icon: '👋', description: reason === 'VOLUNTARY' ? 'Tu rời' : undefined });
  },

  onRoomClosed: ({ reason }) => {
    clearAllTyping();
    set({ ...idleState });
    toast('Phong da dong.', { icon: '🔒', description: reason === 'ROOM_EXPIRED' ? 'Het 3 gio' : undefined });
  },

  onRoomExpired: () => {
    clearAllTyping();
    set({ ...idleState });
    toast('Phong da het han (3 gio).', { icon: '⏰' });
  },

  onLeft: ({ cooldownEndsAt }) => {
    // chat:left ack — cooldownEndsAt (epoch ms) từ gateway là giá trị server, chính xác hơn
    // guess local env.cooldownSeconds ở leaveRoom (VÁ-4 pattern: countdown = cooldownEndsAt - Date.now()).
    set({ cooldownUntil: cooldownEndsAt });
  },

  onChatError: ({ code, message }) => {
    if (code === SocketChatErrorCode.FORBIDDEN) {
      clearAllTyping();
      set({ ...idleState });
      toast.error(message || 'Ban khong con nam trong phong.');
    } else if (code === SocketChatErrorCode.LEAVE_FAILED) {
      toast.error(message || 'Roi phong that bai, thu lai.');
    } else if (code.startsWith('VOTE_')) {
      toast.error(message || 'Vote that bai.');
    } else {
      toast.error(message || 'Loi xu ly tac vu chat.');
    }
  },

  startVoteKick: (targetUserId) => {
    const roomId = get().roomId;
    if (!roomId) return;
    socketManager.emit('chat:vote_kick:start', { roomId, targetUserId });
  },

  castVoteKick: () => {
    const roomId = get().roomId;
    if (!roomId) return;
    socketManager.emit('chat:vote_kick:vote', { roomId });
  },

  // ─── Topic (per-member topic) ─────────────────────────────────────────
  setTopicSheetOpen: (open, mode) => {
    if (open) {
      const m = mode ?? 'create';
      if (m === 'edit') {
        const me = meId();
        const mine = get().topics.find((t) => t.userId === me);
        set({
          topicSheetOpen: true,
          topicSheetMode: 'edit',
          topicDraft: mine?.title ?? '',
          topicError: null,
          topicSaving: false,
          topicRateLimitUntil: null,
        });
      } else {
        set({
          topicSheetOpen: true,
          topicSheetMode: 'create',
          topicDraft: '',
          topicError: null,
          topicSaving: false,
          topicRateLimitUntil: null,
        });
      }
    } else {
      set({ topicSheetOpen: false, topicSaving: false, topicError: null, topicRateLimitUntil: null });
    }
  },

  setTopicDraft: (text) =>
    set((st) => ({
      topicDraft: text,
      // Xoa banner 400 validation khi user sửa; giữ banner 429/409 (context).
      topicError:
        st.topicError?.code === ChatErrorCode.TOPIC_TITLE_INVALID ? null : st.topicError,
    })),

  submitTopic: async () => {
    const s = get();
    const roomId = s.roomId;
    const title = s.topicDraft.trim();
    if (!roomId) return;
    const cp = [...title].length; // code point count (BR-03)
    if (cp < env.topicMinCp || cp > env.topicMaxCp) {
      set({ topicError: { code: ChatErrorCode.TOPIC_TITLE_INVALID, message: 'Chủ đề phải 3-80 ký tự.' } });
      return;
    }
    if (s.topicRateLimitUntil && Date.now() < (s.topicRateLimitUntil ?? 0)) return; // vẫn con rate-limit
    set({ topicSaving: true, topicError: null });
    try {
      const { topic } = await chatApi.setMyTopic(roomId, title);
      // Upsert theo userId (optimistic — realtime sẽ dedupe/confirm sau)
      set((st) => {
        const exists = st.topics.some((t) => t.userId === topic.userId);
        return {
          topics: exists
            ? st.topics.map((t) => (t.userId === topic.userId ? { ...t, ...topic } : t))
            : [...st.topics, topic],
          topicSaving: false,
          topicSheetOpen: false,
          topicDraft: '',
          topicError: null,
        };
      });
    } catch (e) {
      const err = e as ApiError;
      set({ topicSaving: false });
      if (err.code === ChatErrorCode.TOPIC_TITLE_INVALID) {
        set({ topicError: { code: err.code, message: 'Chủ đề không hợp lệ (3-80 ký tự).' } });
      } else if (err.code === ChatErrorCode.TOPIC_RATE_LIMITED) {
        set({
          topicError: { code: err.code, message: 'Chờ rồi sửa nhé.' },
          topicRateLimitUntil: Date.now() + env.topicRateLimitSeconds * 1000,
        });
      } else if (err.code === ChatErrorCode.TOPIC_ROOM_FULL) {
        set({ topicError: { code: err.code, message: 'Phòng đã đủ 6 chủ đề.' } });
      } else if (err.code === ChatErrorCode.ROOM_NOT_FOUND) {
        toast.error('Phòng không còn tồn tại');
        clearAllTyping();
        set({ ...idleState });
      } else if (err.code === ChatErrorCode.FORBIDDEN) {
        toast.error('Bạn không còn trong phòng');
        clearAllTyping();
        set({ ...idleState });
      } else {
        set({ topicError: { message: err.message ?? 'Lỗi khi lưu chủ đề.' } });
      }
    }
  },

  removeMyTopic: async () => {
    const roomId = get().roomId;
    if (!roomId) return;
    set({ topicSaving: true, topicError: null });
    try {
      await chatApi.removeMyTopic(roomId);
      const me = meId();
      set((st) => ({
        topics: st.topics.filter((t) => t.userId !== me),
        topicSaving: false,
        topicSheetOpen: false,
        topicDraft: '',
        topicError: null,
      }));
    } catch (e) {
      const err = e as ApiError;
      set({ topicSaving: false });
      if (err.code === ChatErrorCode.ROOM_NOT_FOUND) {
        toast.error('Phòng không còn tồn tại');
        clearAllTyping();
        set({ ...idleState });
      } else if (err.code === ChatErrorCode.FORBIDDEN) {
        toast.error('Bạn không còn trong phòng');
        clearAllTyping();
        set({ ...idleState });
      } else {
        set({ topicError: { message: err.message ?? 'Lỗi khi xoá chủ đề.' } });
      }
    }
  },

  onVoteKickStarted: (p) => {
    if (get().roomId !== p.roomId) return;
    set({
      voteKick: {
        active: true,
        targetUserId: p.targetUserId,
        initiatorId: p.initiatorId,
        currentVotes: p.currentVotes,
        requiredVotes: p.requiredVotes,
        expiresAt: p.expiresAt,
      },
    });
    const me = meId();
    if (p.targetUserId === me) {
      toast.warning('Ban dang bi vote kick!', { icon: '⚠️' });
    } else {
      toast('Co nguoi dang bi vote kick.', { icon: '🗳️' });
    }
  },

  onVoteKickVoted: (p) => {
    if (get().roomId !== p.roomId) return;
    set((st) => ({
      voteKick: { ...st.voteKick, currentVotes: p.currentVotes, requiredVotes: p.requiredVotes },
    }));
  },

  onVoteKickResult: (p) => {
    if (get().roomId !== p.roomId) return;
    const me = meId();
    set({ voteKick: idleVoteKick });
    if (p.result === 'KICKED') {
      if (p.targetUserId === me) {
        clearAllTyping();
        set({ ...idleState });
        toast.error('Ban da bi kick khoi phong.', { icon: '🚫' });
      } else {
        set((st) => ({
          members: st.members.filter((m) => m.userId !== p.targetUserId),
          typingUsers: st.typingUsers.filter((u) => u !== p.targetUserId),
        }));
        toast('Mot thanh vien da bi kick.', { icon: '🚫' });
      }
    } else if (p.result === 'TIMEOUT') {
      toast('Vote kick het han, khong du phieu.', { icon: '⏰' });
    } else if (p.result === 'CANCELLED') {
      toast('Vote kick da bi huy.', { icon: '❌' });
    }
  },

  // ─── Topic realtime (CHAT_API.md §10.6) ───────────────────────────────
  onTopicCreated: (p) => {
    if (get().roomId !== p.roomId) return; // chỉ phòng hiện tại
    set((st) => {
      // Dedupe theo userId — có thể trùng với matching:found.topics snapshot (I9)
      if (st.topics.some((t) => t.userId === p.topic.userId)) return st;
      return { topics: [...st.topics, p.topic] }; // thêm cuối dải
    });
  },

  onTopicUpdated: (p) => {
    if (get().roomId !== p.roomId) return;
    set((st) => ({
      topics: st.topics.map((t) => (t.userId === p.topic.userId ? { ...t, ...p.topic } : t)),
    }));
    if (p.userId === meId()) {
      // Mình sửa → đóng sheet (realtime đã xác nhận)
      set({ topicSheetOpen: false, topicDraft: '', topicSaving: false });
    }
  },

  onTopicDeleted: (p) => {
    if (get().roomId !== p.roomId) return;
    set((st) => ({
      topics: st.topics.filter((t) => t.userId !== p.userId),
    }));
    if (p.userId === meId()) {
      // Mình xoá → đóng sheet + clear draft
      set({ topicSheetOpen: false, topicDraft: '', topicSaving: false, topicError: null });
    }
  },
}));

/** Gan socket handlers + connect (goi tu App khi co accessToken). */
export function connectChatSocket(token: string) {
  socketManager.setHandlers(buildHandlers());
  socketManager.connect(token);
}
export function disconnectChatSocket() {
  socketManager.disconnect();
}

function buildHandlers(): SocketHandlers {
  return {
    onConnect: () => {
      useChatStore.setState({ socketConnected: true });
      const s = useChatStore.getState();
      if (s.phase === 'in_room' && s.roomId) {
        socketManager.emit('chat:join', { roomId: s.roomId });
        // Reconcile snapshot topics — bù event lỡ lúc offline (A-11, I10)
        void chatApi
          .myRoom()
          .then(({ topics, roomEndsAt }) => {
            if (useChatStore.getState().phase === 'in_room') {
              useChatStore.setState({ topics: topics ?? [], ...(typeof roomEndsAt === 'number' ? { roomEndsAt } : {}) });
            }
          })
          .catch(() => {
            /* ignore — realtime sẽ bù khi có event mới */
          });
        // Risk 5: bù tin lỡ — lấy lại trang history mới nhất sau reconnect
        // (kết hợp loadHistory; outbox resend ở onJoined)
        void useChatStore.getState().loadHistory();
      }
    },
    onDisconnect: () => useChatStore.setState({ socketConnected: false }),
    onConnectError: (err) => {
      const msg = err.message.toLowerCase();
      if (msg.includes('not authorized') || msg.includes('token') || msg.includes('jwt')) {
        toast.error('Xac thuc socket that bai. Dang nhap lai.');
      }
    },
    onMatchingFound: (p) => useChatStore.getState().onMatchingFound(p),
    onJoined: (p) => useChatStore.getState().onJoined(p),
    onMessage: (p) => useChatStore.getState().onMessage(p),
    onTyping: (p) => useChatStore.getState().onTyping(p),
    onMemberLeft: (p) => useChatStore.getState().onMemberLeft(p),
    onRoomClosed: (p) => useChatStore.getState().onRoomClosed(p),
    onRoomExpired: (p) => useChatStore.getState().onRoomExpired(p),
    onLeft: (p) => useChatStore.getState().onLeft(p),
    onChatError: (p) => useChatStore.getState().onChatError(p),
    onVoteKickStarted: (p) => useChatStore.getState().onVoteKickStarted(p),
    onVoteKickVoted: (p) => useChatStore.getState().onVoteKickVoted(p),
    onVoteKickResult: (p) => useChatStore.getState().onVoteKickResult(p),
    onTopicCreated: (p) => useChatStore.getState().onTopicCreated(p),
    onTopicUpdated: (p) => useChatStore.getState().onTopicUpdated(p),
    onTopicDeleted: (p) => useChatStore.getState().onTopicDeleted(p),
  };
}
