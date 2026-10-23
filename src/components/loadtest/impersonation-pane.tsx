/**
 * F-impersonate — 1 pane chat cho 1 virtual user (ISOLATED: own socket + state).
 * Logic socket/REST ở hook useImpersonatedChat (dùng chung với Phòng marketing).
 * Sửa bug "vào StartScreen": pane explicit my-room → chat:join → vào phòng đúng nếu user đang in_room.
 */
import { useEffect, useRef, useState } from 'react';
import { X, Send, Maximize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { useImpersonatedChat } from '@/hooks/useImpersonatedChat';
import { cn } from '@/lib/utils';

export function ImpersonationPane({ email, onClose, onMaximize }: { email: string; onClose: () => void; onMaximize?: () => void }) {
  const { status, error, messages, typingHint, historyLoading, me, startMatching, send, sendTyping } = useImpersonatedChat(email);
  const [input, setInput] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  // auto-scroll to bottom
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, typingHint]);

  const submit = () => {
    if (send(input)) setInput('');
  };

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
            const mine = m.userId === me?.id;
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
                submit();
              } else {
                sendTyping();
              }
            }}
            placeholder="tin nhắn…"
            className="h-8 text-xs"
            aria-label={`Tin nhắn cho ${email}`}
          />
          <Button size="sm" className="h-8" onClick={submit} aria-label="Gửi">
            <Send className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      )}
    </div>
  );
}
