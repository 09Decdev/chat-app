import { useEffect, useRef } from 'react';
import { format, isSameDay } from 'date-fns';
import { Loader2 } from 'lucide-react';
import { useChatStore, type LocalMessage } from '@/store/chat.store';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { MessageBubble } from './MessageBubble';

function showHeaderFor(prev: LocalMessage | undefined, cur: LocalMessage): boolean {
  if (!prev) return true;
  if (prev.userId !== cur.userId) return true;
  const gap = new Date(cur.createdAt).getTime() - new Date(prev.createdAt).getTime();
  return gap > 5 * 60 * 1000;
}

function DayDivider({ date }: { date: Date }) {
  return (
    <div className="my-3 flex justify-center">
      <span className="rounded-full bg-card/60 px-3 py-1 text-[11px] text-muted-foreground backdrop-blur">
        {format(date, 'dd/MM')}
      </span>
    </div>
  );
}

export function MessageList() {
  const messages = useChatStore((s) => s.messages);
  const nextCursor = useChatStore((s) => s.nextCursor);
  const loadingHistory = useChatStore((s) => s.loadingHistory);
  const loadingOlder = useChatStore((s) => s.loadingOlder);
  const loadOlder = useChatStore((s) => s.loadOlder);
  const joined = useChatStore((s) => s.joined);

  const viewportRef = useRef<HTMLDivElement>(null);
  const prevLen = useRef(0);
  const nearBottomRef = useRef(true);
  const readTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastReadSentId = useRef('');

  // Read receipt: khi ở đáy (đang xem tin mới) → debounce 1.2s gửi mốc đọc = createdAt tin mới nhất.
  function scheduleSendRead() {
    const room = useChatStore.getState().roomId;
    if (!room || !useChatStore.getState().joined) return;
    const msgs = useChatStore.getState().messages.filter((m) => m.userId && !m.isDeleted);
    if (msgs.length === 0) return;
    const newest = msgs[msgs.length - 1];
    if (!newest || newest.id === lastReadSentId.current) return;
    lastReadSentId.current = newest.id;
    if (readTimer.current) clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => {
      useChatStore.getState().sendRead(room, newest.createdAt);
    }, 1200);
  }

  // scroll listener for load-older + near-bottom tracking + send-read
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const handler = () => {
      const near = vp.scrollHeight - vp.scrollTop - vp.clientHeight < 160;
      nearBottomRef.current = near;
      if (vp.scrollTop < 60 && nextCursor && !loadingOlder) void loadOlder();
      if (near) scheduleSendRead();
    };
    vp.addEventListener('scroll', handler, { passive: true });
    return () => vp.removeEventListener('scroll', handler);
  }, [nextCursor, loadingOlder, loadOlder]);

  // auto-scroll to bottom on new message (when near bottom) + send-read
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    if (messages.length > prevLen.current && nearBottomRef.current) {
      requestAnimationFrame(() => {
        if (viewportRef.current) viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
      });
      scheduleSendRead();
    }
    prevLen.current = messages.length;
  }, [messages]);

  // cleanup timer
  useEffect(() => () => { if (readTimer.current) clearTimeout(readTimer.current); }, []);

  if (loadingHistory && messages.length === 0) {
    return (
      <div className="flex-1 space-y-3 p-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className={i % 2 ? 'h-12 w-2/3' : 'h-12 w-1/2'} />
        ))}
      </div>
    );
  }

  let lastMsg: LocalMessage | undefined;
  let lastDate: Date | undefined;

  return (
    <ScrollArea className="flex-1" viewportRef={viewportRef}>
      <div className="py-3">
        {loadingOlder && (
          <div className="mb-2 flex justify-center">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}

        {messages.length === 0 && joined && (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            Phong vua tao. Hay bat dau tro chuyen!
          </div>
        )}

        {messages.map((m) => {
          const d = new Date(m.createdAt);
          const showDay = !lastDate || !isSameDay(lastDate, d);
          if (showDay) lastDate = d;
          const showHeader = showHeaderFor(lastMsg, m);
          lastMsg = m;
          return (
            <div key={m.id}>
              {showDay && <DayDivider date={d} />}
              <MessageBubble message={m} showHeader={showHeader} />
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
