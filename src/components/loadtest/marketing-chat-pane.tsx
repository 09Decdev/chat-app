/**
 * Phòng marketing — 1 ô chat "đẹp để quay video" cho 1 account (socket riêng, chat tay).
 * Giống bubble của ChatRoom thật: avatar + tên + giờ, tin mình bên phải. KHÔNG có nút ghép phòng
 * (production — phòng tạo bằng API chỉ định, không vào hàng chờ chung).
 */
import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { format } from 'date-fns';
import { Send, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { UserAvatar } from '@/components/chat/UserAvatar';
import { useImpersonatedChat, type ImpersonatedMsg } from '@/hooks/useImpersonatedChat';
import { cn } from '@/lib/utils';

export interface MarketingChatPaneHandle {
  /** Đọc lại my-room → vào phòng (gọi sau khi tạo phòng chỉ định). */
  reconcile: () => void;
}

const SYSTEM_TEXT: Record<string, string> = {
  MEMBER_JOINED: 'đã vào phòng',
  MEMBER_LEFT: 'đã rời phòng',
  MEMBER_KICKED: 'đã bị mời ra khỏi phòng',
};

function timeOf(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : format(d, 'HH:mm');
}

export const MarketingChatPane = forwardRef<MarketingChatPaneHandle, { email: string; label?: string }>(
  function MarketingChatPane({ email, label }, ref) {
    const chat = useImpersonatedChat(email, { historyLimit: 50 });
    const { status, error, messages, typingHint, me, send, sendTyping, reconcile } = chat;
    const [input, setInput] = useState('');
    const scrollRef = useRef<HTMLDivElement>(null);

    useImperativeHandle(ref, () => ({ reconcile: () => void reconcile() }), [reconcile]);

    useEffect(() => {
      const el = scrollRef.current;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }, [messages, typingHint]);

    const submit = () => {
      if (send(input)) setInput('');
    };

    return (
      <section
        className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm"
        aria-label={`Ô chat ${me?.displayName || email}`}
      >
        <header className="flex items-center gap-2.5 border-b border-border px-3 py-2">
          <UserAvatar name={me?.displayName} userId={me?.id ?? email} url={me?.avatar || null} size="md" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{me?.displayName || email}</div>
            <div className="truncate text-xs text-muted-foreground">
              {label ? `${label} · ` : ''}
              {status === 'in_room' ? 'Trong phòng' : status === 'loading' ? 'Đang đăng nhập…' : status === 'error' ? 'Lỗi' : 'Chưa vào phòng'}
            </div>
          </div>
          <span
            className={cn('h-2.5 w-2.5 shrink-0 rounded-full', status === 'in_room' ? 'bg-emerald-500' : status === 'error' ? 'bg-destructive' : 'bg-muted-foreground/40')}
            aria-hidden
          />
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
          {status === 'loading' && (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> Đang tải…
            </div>
          )}
          {status === 'error' && <p className="text-sm text-destructive">{error}</p>}
          {(status === 'idle' || status === 'matching') && (
            <p className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
              Chưa ở trong phòng nào.
            </p>
          )}
          {status === 'in_room' &&
            messages.map((m) => <Bubble key={m.id} m={m} mine={m.userId === me?.id} />)}
          {status === 'in_room' && typingHint && (
            <p className="text-xs italic text-muted-foreground">Có người đang gõ…</p>
          )}
        </div>

        <form
          className="flex items-center gap-2 border-t border-border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              sendTyping();
            }}
            disabled={status !== 'in_room'}
            placeholder={status === 'in_room' ? 'Nhập tin nhắn…' : 'Chưa vào phòng'}
            className="h-10 rounded-full text-sm"
            aria-label={`Tin nhắn của ${me?.displayName || email}`}
          />
          <Button type="submit" size="icon" className="h-10 w-10 shrink-0 rounded-full" disabled={status !== 'in_room' || !input.trim()} aria-label="Gửi">
            <Send className="h-4 w-4" aria-hidden />
          </Button>
        </form>
      </section>
    );
  },
);

function Bubble({ m, mine }: { m: ImpersonatedMsg; mine: boolean }) {
  if (m.messageType && m.messageType !== 'MESSAGE') {
    return (
      <p className="text-center text-xs text-muted-foreground">
        {m.displayName || 'Một thành viên'} {SYSTEM_TEXT[m.messageType] ?? ''}
      </p>
    );
  }
  return (
    <div className={cn('flex gap-2', mine ? 'flex-row-reverse' : 'flex-row')}>
      {!mine && <UserAvatar name={m.displayName} userId={m.userId} url={m.avatarUrl} size="sm" className="mt-5" />}
      <div className={cn('flex max-w-[80%] flex-col', mine ? 'items-end' : 'items-start')}>
        <div className="mb-0.5 flex items-center gap-1.5 text-xs">
          {!mine && <span className="font-medium text-foreground/90">{m.displayName || 'Thành viên'}</span>}
          <span className="text-muted-foreground/70">{timeOf(m.createdAt)}</span>
        </div>
        <div
          className={cn(
            'whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm leading-relaxed',
            mine ? 'rounded-tr-sm bg-primary/20' : 'rounded-tl-sm bg-secondary',
            m._local === 'pending' && 'opacity-60',
          )}
        >
          {m.content}
        </div>
      </div>
    </div>
  );
}
