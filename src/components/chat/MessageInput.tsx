import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { useChatStore } from '@/store/chat.store';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { env } from '@/lib/env';
import { cn } from '@/lib/utils';

export function MessageInput() {
  const joined = useChatStore((s) => s.joined);
  const send = useChatStore((s) => s.sendMessage);
  const emitTyping = useChatStore((s) => s.emitTyping);
  const typingUsers = useChatStore((s) => s.typingUsers);
  const members = useChatStore((s) => s.members);
  const [text, setText] = useState('');
  const [cooldown, setCooldown] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [text]);

  useEffect(() => {
    if (!cooldown) return;
    const t = setTimeout(() => setCooldown(false), env.messageMinIntervalMs);
    return () => clearTimeout(t);
  }, [cooldown]);

  // cleanup typing throttle timer khi unmount
  useEffect(() => () => { if (typingTimer.current) clearTimeout(typingTimer.current); }, []);

  const len = text.length;
  const over = len > env.messageMaxChars;
  const disabled = !joined || cooldown || over || text.trim().length === 0;

  function handleSend() {
    if (disabled) return;
    send(text);
    setText('');
    setCooldown(true);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  // Throttle: tối đa 1 emit mỗi typingDebounceMs. Pending thì chờ, không spam.
  function maybeEmitTyping() {
    if (!joined || typingTimer.current) return;
    typingTimer.current = setTimeout(() => {
      typingTimer.current = null;
      emitTyping();
    }, env.typingDebounceMs);
  }

  // Label typing indicator (loại trừ chính mình đã làm ở store).
  const typingNames = typingUsers
    .map((uid) => members.find((m) => m.userId === uid)?.displayName)
    .filter((n): n is string => !!n);
  const typingLabel =
    typingNames.length >= 3
      ? `${typingNames.length} người đang gõ`
      : typingNames.length === 2
        ? `${typingNames[0]} và ${typingNames[1]} đang gõ`
        : typingNames.length === 1
          ? `${typingNames[0]} đang gõ`
          : '';

  return (
    <div className="border-t border-border/60 bg-card/40 p-3 backdrop-blur">
      {typingLabel && (
        <div className="flex items-center gap-1.5 pb-2 text-xs text-muted-foreground">
          <span className="flex gap-[2px]">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current" />
          </span>
          <span className="tabular-nums">{typingLabel}</span>
        </div>
      )}
      <div className="flex items-end gap-2">
        <Textarea
          ref={taRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            maybeEmitTyping();
          }}
          onKeyDown={onKeyDown}
          rows={1}
          maxLength={env.messageMaxChars + 50}
          placeholder={joined ? 'Nhap tin nhan... (Enter de gui, Shift+Enter xuong dong)' : 'Dang vao phong...'}
          disabled={!joined}
          className="min-h-[44px] max-h-[140px]"
        />
        <div className="flex flex-col items-center gap-1">
          <Button
            variant="gradient"
            size="icon"
            disabled={disabled}
            onClick={handleSend}
            className="h-11 w-11 shrink-0 rounded-xl"
          >
            {cooldown ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
          <span className={cn('text-[10px] tabular-nums', over ? 'text-destructive' : 'text-muted-foreground/60')}>
            {len}/{env.messageMaxChars}
          </span>
        </div>
      </div>
    </div>
  );
}
