/**
 * F-impersonate — state chat ĐỘC LẬP cho 1 virtual user (socket + axios riêng, không dùng
 * singleton useAuthStore/socketManager) → nhiều ô chat cùng lúc trên 1 trang.
 * Flow: impersonate(email) → token → open socket → my-room → (in_room: join+history) | idle.
 * Dùng chung cho Console (impersonation-pane) và Phòng marketing (marketing-chat-pane).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import axios from 'axios';
import { toast } from 'sonner';
import { loadtestApi, toApiError } from '@/lib/loadtest-api';
import { env } from '@/lib/env';

export type ImpersonatedStatus = 'loading' | 'error' | 'idle' | 'matching' | 'in_room';

export interface ImpersonatedMsg {
  id: string;
  userId: string;
  content: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  createdAt: string;
  /** MESSAGE | MEMBER_JOINED | MEMBER_LEFT | MEMBER_KICKED (history) — system row khác MESSAGE. */
  messageType?: string;
  _local?: 'pending';
  clientMsgId?: string;
}

export interface ImpersonatedUser {
  id: string;
  displayName: string;
  avatar: string;
}

const CHAT_SEND_MIN_MS = 2000;

export function useImpersonatedChat(email: string, opts: { historyLimit?: number } = {}) {
  const historyLimit = opts.historyLimit ?? 20;
  const [status, setStatus] = useState<ImpersonatedStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ImpersonatedMsg[]>([]);
  const [typingHint, setTypingHint] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [me, setMe] = useState<ImpersonatedUser | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const userIdRef = useRef('');
  const roomIdRef = useRef<string | null>(null);
  const lastSendAt = useRef(0);
  // True sau lần 'connect' đầu — tránh double-reconcile (reconcile chạy song song ngay sau io()).
  const initialReconciled = useRef(false);
  // Axios instance RIÊNG + unwrap envelope {success, data} (gateway wrap response giống chat-app api.ts).
  const api = useMemo(() => {
    const inst = axios.create({ baseURL: env.gatewayUrl, timeout: 10000 });
    inst.interceptors.response.use((res) => {
      const body = res.data as unknown;
      if (body && typeof body === 'object' && 'success' in (body as Record<string, unknown>)) {
        res.data = (body as { data: unknown }).data;
      }
      return res;
    });
    return inst;
  }, []);

  const loadHistory = useCallback(
    async (roomId: string) => {
      setHistoryLoading(true);
      try {
        const r = await api.get(`/content-service/chat/rooms/${encodeURIComponent(roomId)}/messages`, {
          params: { limit: historyLimit },
        });
        // Messages có thể là array trực tiếp hoặc {messages:[...]} / {data:[...]}.
        const data = r.data as unknown;
        const arr: ImpersonatedMsg[] = Array.isArray(data)
          ? (data as ImpersonatedMsg[])
          : Array.isArray((data as { messages?: ImpersonatedMsg[] })?.messages)
            ? (data as { messages: ImpersonatedMsg[] }).messages
            : Array.isArray((data as { data?: ImpersonatedMsg[] })?.data)
              ? (data as { data: ImpersonatedMsg[] }).data
              : [];
        setMessages(arr.slice().reverse());
      } catch {
        // ignore — realtime sẽ bù
      } finally {
        setHistoryLoading(false);
      }
    },
    [api, historyLimit],
  );

  const reconcile = useCallback(async () => {
    try {
      const r = await api.get('/content-service/chat/match/my-room');
      const roomId: string | undefined = r.data?.roomId;
      if (roomId) {
        roomIdRef.current = roomId;
        socketRef.current?.emit('chat:join', { roomId });
        setStatus('in_room');
        await loadHistory(roomId);
      } else {
        roomIdRef.current = null;
        setStatus('idle');
      }
    } catch {
      setStatus('idle');
    }
  }, [api, loadHistory]);

  const startMatching = useCallback(async () => {
    try {
      await api.post('/content-service/chat/match', {});
      setStatus('matching');
    } catch (e) {
      toast.error(toApiError(e).message);
    }
  }, [api]);

  // boot: impersonate → token → socket → reconcile
  useEffect(() => {
    initialReconciled.current = false; // reset cho email mới
    let cancelled = false;
    let typingTimer: ReturnType<typeof setTimeout> | null = null;
    setStatus('loading');
    setMessages([]);
    (async () => {
      try {
        const res = await loadtestApi.impersonate(email);
        if (cancelled) return;
        userIdRef.current = res.user.id;
        setMe({ id: res.user.id, displayName: res.user.displayName, avatar: res.user.avatar });
        api.defaults.headers.common['Authorization'] = `Bearer ${res.accessToken}`;
        const s = io(env.gatewayUrl, {
          path: env.socketPath ?? '/socket.io/',
          transports: ['websocket'],
          auth: { token: res.accessToken },
          extraHeaders: { Authorization: `Bearer ${res.accessToken}` },
        });
        socketRef.current = s;
        s.on('connect', () => {
          // Lần 'connect' đầu: skip (reconcile đã chạy song song sau io()). Chỉ reconcile lại khi RECONNECT.
          if (!initialReconciled.current) {
            initialReconciled.current = true;
            return;
          }
          void reconcile();
        });
        s.on('chat:message', (p: { message: ImpersonatedMsg; clientMsgId?: string }) => {
          if (!p?.message) return;
          if (p.clientMsgId) {
            setMessages((prev) =>
              prev.some((m) => m.clientMsgId === p.clientMsgId)
                ? prev.map((m) => (m.clientMsgId === p.clientMsgId ? { ...p.message } : m))
                : prev.some((m) => m.id === p.message.id)
                  ? prev
                  : [...prev, p.message],
            );
          } else {
            setMessages((prev) => (prev.some((m) => m.id === p.message.id) ? prev : [...prev, p.message]));
          }
        });
        s.on('chat:typing', (p: { userId?: string }) => {
          if (p?.userId && p.userId !== userIdRef.current) {
            setTypingHint('…đang gõ');
            if (typingTimer) clearTimeout(typingTimer);
            typingTimer = setTimeout(() => setTypingHint(null), 3000);
          }
        });
        s.on('chat:joined', (p: { roomId?: string }) => {
          if (p?.roomId) {
            roomIdRef.current = p.roomId;
            setStatus('in_room');
          }
        });
        s.on('matching:found', (p: { roomId?: string }) => {
          if (p?.roomId) {
            roomIdRef.current = p.roomId;
            s.emit('chat:join', { roomId: p.roomId });
            setStatus('in_room');
            void loadHistory(p.roomId);
          }
        });
        const closed = () => {
          roomIdRef.current = null;
          setStatus('idle');
          setMessages([]);
        };
        s.on('chat:room_closed', closed);
        s.on('roomExpired', closed);
        s.on('chat:error', (p: { code?: string; message?: string }) => {
          toast.error(`chat:error ${p?.code ?? ''}`.trim());
        });
        s.on('connect_error', (e: { message: string }) => {
          if (!cancelled) {
            setError(`socket: ${e.message}`);
            setStatus('error');
          }
        });
        // FAST PATH: reconcile (my-room REST + chat:join buffered + history REST) chạy song song
        // với socket connect — không chờ 'connect' event → pane boot nhanh hơn.
        void reconcile();
      } catch (e) {
        if (cancelled) return;
        setError(toApiError(e).message);
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
      if (typingTimer) clearTimeout(typingTimer);
      const s = socketRef.current;
      if (s) {
        s.removeAllListeners();
        s.disconnect();
      }
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  /** Gửi tin; trả false nếu bị chặn (chưa vào phòng / gửi quá nhanh / rỗng). */
  const send = useCallback((raw: string): boolean => {
    const content = raw.trim();
    const s = socketRef.current;
    const roomId = roomIdRef.current;
    if (!s || !roomId || !content) return false;
    const now = Date.now();
    if (now - lastSendAt.current < CHAT_SEND_MIN_MS) {
      toast.warning('Gửi quá nhanh — chờ 2 giây.');
      return false;
    }
    lastSendAt.current = now;
    const clientMsgId = `imp-${now}-${Math.random().toString(36).slice(2, 8)}`;
    setMessages((prev) => [
      ...prev,
      { id: clientMsgId, userId: userIdRef.current, content, createdAt: new Date(now).toISOString(), _local: 'pending', clientMsgId },
    ]);
    s.emit('chat:send', { roomId, content, clientMsgId });
    return true;
  }, []);

  const lastTypingAt = useRef(0);
  /** chat:typing throttle env.typingDebounceMs (giống chat-app thật) — gọi mỗi phím cũng an toàn. */
  const sendTyping = useCallback(() => {
    const s = socketRef.current;
    const roomId = roomIdRef.current;
    const now = Date.now();
    if (!s || !roomId || now - lastTypingAt.current < env.typingDebounceMs) return;
    lastTypingAt.current = now;
    s.emit('chat:typing', { roomId });
  }, []);

  return {
    status,
    error,
    messages,
    typingHint,
    historyLoading,
    me,
    /** Vào lại my-room (dùng sau khi tạo phòng chỉ định — phòng có thể đã tạo trước khi socket kịp nghe). */
    reconcile,
    startMatching,
    send,
    sendTyping,
  };
}
