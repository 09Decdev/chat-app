/**
 * F-impersonate — 1 pane chat cho 1 virtual user (ISOLATED: own socket + state).
 * Không dùng singleton useAuthStore/socketManager → mỗi pane độc lập, multi-pane OK.
 * Flow: impersonate(email) → token → open socket → my-room → (in_room: join+history) | (idle: start matching).
 * Sửa bug "vào StartScreen": pane explicit my-room → chat:join → vào phòng đúng nếu user đang in_room.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import axios from 'axios';
import { X, Send, Maximize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { loadtestApi, toApiError } from '@/lib/loadtest-api';
import { env } from '@/lib/env';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

type PaneStatus = 'loading' | 'error' | 'idle' | 'matching' | 'in_room';

interface Msg {
  id: string;
  userId: string;
  content: string;
  displayName?: string | null;
  createdAt: string;
  _local?: 'pending';
  clientMsgId?: string;
}

const CHAT_SEND_MIN_MS = 2000;

export function ImpersonationPane({ email, onClose, onMaximize }: { email: string; onClose: () => void; onMaximize?: () => void }) {
  const [status, setStatus] = useState<PaneStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [typingHint, setTypingHint] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const tokenRef = useRef<string | null>(null);
  const userIdRef = useRef('');
  const roomIdRef = useRef<string | null>(null);
  const lastSendAt = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  // True sau lần 'connect' đầu — tránh double-reconcile (reconcile chạy song song ngay sau io()).
  const initialReconciled = useRef(false);
  // Axios instance RIÊNG per pane + unwrap envelope {success, data} (gateway wrap response giống chat-app api.ts).
  // Trước đây thiếu unwrap → my-room trả {success,data:{roomId}} → r.data.roomId undefined → bug vào StartScreen.
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

  const loadHistory = useCallback(async (roomId: string) => {
    setHistoryLoading(true);
    try {
      const r = await api.get(`/content-service/chat/rooms/${encodeURIComponent(roomId)}/messages`, { params: { limit: 20 } });
      // Sau unwrap interceptor, res.data = inner. Messages có thể là array trực tiếp hoặc {messages:[...]}.
      const data = r.data as unknown;
      const arr: Msg[] = Array.isArray(data)
        ? (data as Msg[])
        : Array.isArray((data as { messages?: Msg[] })?.messages)
          ? (data as { messages: Msg[] }).messages
          : Array.isArray((data as { data?: Msg[] })?.data)
            ? (data as { data: Msg[] }).data
            : [];
      setMessages(arr.slice().reverse());
    } catch {
      // ignore — realtime sẽ bù
    } finally {
      setHistoryLoading(false);
    }
  }, [api]);

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
    (async () => {
      try {
        const res = await loadtestApi.impersonate(email);
        if (cancelled) return;
        tokenRef.current = res.accessToken;
        userIdRef.current = res.user.id;
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
        s.on('chat:message', (p: { message: Msg; clientMsgId?: string }) => {
          if (!p?.message) return;
          if (p.clientMsgId) {
            setMessages((prev) => prev.map((m) => (m.clientMsgId === p.clientMsgId ? { ...p.message } : m)));
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
          if (p?.roomId) { roomIdRef.current = p.roomId; setStatus('in_room'); }
        });
        s.on('matching:found', (p: { roomId?: string }) => {
          if (p?.roomId) {
            roomIdRef.current = p.roomId;
            s.emit('chat:join', { roomId: p.roomId });
            setStatus('in_room');
            void loadHistory(p.roomId);
          }
        });
        s.on('chat:room_closed', () => { roomIdRef.current = null; setStatus('idle'); setMessages([]); });
        s.on('roomExpired', () => { roomIdRef.current = null; setStatus('idle'); setMessages([]); });
        s.on('chat:error', (p: { code?: string; message?: string }) => {
          toast.error(`chat:error ${p?.code ?? ''}`.trim());
        });
        s.on('connect_error', (e: { message: string }) => {
          if (!cancelled) { setError(`socket: ${e.message}`); setStatus('error'); }
        });
        // FAST PATH: reconcile (my-room REST + chat:join buffered + history REST) chạy song song
        // với socket connect — không chờ 'connect' event → pane boot nhanh hơn (trước đây chờ connect).
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
      if (s) { s.removeAllListeners(); s.disconnect(); }
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  // auto-scroll to bottom
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typingHint]);

  const send = useCallback(() => {
    const content = input.trim();
    const s = socketRef.current;
    const roomId = roomIdRef.current;
    if (!s || !roomId || !content) return;
    const now = Date.now();
    if (now - lastSendAt.current < CHAT_SEND_MIN_MS) {
      toast.warning('Gửi quá nhanh — chờ 2 giây.');
      return;
    }
    lastSendAt.current = now;
    const clientMsgId = `imp-${now}-${Math.random().toString(36).slice(2, 8)}`;
    const temp: Msg = {
      id: clientMsgId,
      userId: userIdRef.current,
      content,
      createdAt: new Date(now).toISOString(),
      _local: 'pending',
      clientMsgId,
    };
    setMessages((prev) => [...prev, temp]);
    s.emit('chat:send', { roomId, content, clientMsgId });
    setInput('');
  }, [input]);

  const sendTyping = useCallback(() => {
    const s = socketRef.current;
    const roomId = roomIdRef.current;
    if (s && roomId) s.emit('chat:typing', { roomId });
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col border border-border">
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1">
        <Badge
          variant={status === 'in_room' ? 'success' : status === 'matching' ? 'warning' : status === 'error' ? 'destructive' : 'secondary'}
          className="text-[10px]"
        >
          {status}
        </Badge>
        <span className="truncate font-mono text-[10px] text-muted-foreground" title={email}>{email}</span>
        {onMaximize && (
          <Button variant="ghost" size="icon" className="ml-auto h-6 w-6" onClick={onMaximize} aria-label="Phóng to pane">
            <Maximize2 className="h-3.5 w-3.5" aria-hidden />
          </Button>
        )}
        <Button variant="ghost" size="icon" className={cn('h-6 w-6', !onMaximize && 'ml-auto')} onClick={onClose} aria-label="Đóng pane">
          <X className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 py-1 text-[11px]">
        {status === 'loading' && <p className="text-muted-foreground">Đang tải…</p>}
        {status === 'error' && <p className="text-destructive">{error}</p>}
        {status === 'idle' && (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="text-muted-foreground">Không trong phòng.</p>
            <Button size="sm" className="min-h-9" onClick={() => void startMatching()}>Tìm phòng ghép</Button>
          </div>
        )}
        {status === 'matching' && <p className="text-muted-foreground">Đang ghép…</p>}
        {status === 'in_room' && historyLoading && messages.length === 0 && (
          <p className="text-muted-foreground">Đang tải tin nhắn…</p>
        )}
        {status === 'in_room' &&
          messages.map((m) => {
            const mine = m.userId === userIdRef.current;
            return (
              <div key={m.id} className={cn('my-0.5 rounded px-1.5 py-1', mine ? 'bg-primary/15 ml-6' : 'bg-muted mr-6')}>
                <span className="font-mono text-[9px] text-muted-foreground">{mine ? 'me' : (m.displayName || m.userId.slice(0, 6))}: </span>
                <span className={cn(m._local === 'pending' && 'opacity-50')}>{m.content}</span>
              </div>
            );
          })}
        <div ref={endRef} />
        {typingHint && <p className="text-[9px] italic text-muted-foreground">{typingHint}</p>}
      </div>

      {status === 'in_room' && (
        <div className="flex gap-1 border-t border-border p-1">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                send();
              } else {
                sendTyping();
              }
            }}
            placeholder="tin nhắn…"
            className="h-8 text-xs"
            aria-label={`Tin nhắn cho ${email}`}
          />
          <Button size="sm" className="h-8" onClick={send} aria-label="Gửi">
            <Send className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      )}
    </div>
  );
}
