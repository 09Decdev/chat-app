import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Send, Loader2, X, MessageSquare } from 'lucide-react';
import { useChatStore } from '@/store/chat.store';
import { useAuthStore } from '@/store/auth.store';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { UserAvatar } from './UserAvatar';
import { env } from '@/lib/env';
import { cn } from '@/lib/utils';

interface MentionSelection {
  userId: string;
  tag: string; // '@Ten hien thi ' — để prune khi xóa khỏi text
}

interface CurrentMention {
  atIndex: number;
  token: string;
}

/** Tìm token `@...` đang gõ: ký tự @ ở đầu từ (sau space/đầu chuỗi), tới space/cuối chuỗi. */
function currentMention(text: string): CurrentMention | null {
  const at = text.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && text[at - 1] !== ' ') return null;
  const after = text.slice(at + 1);
  const spaceIdx = after.indexOf(' ');
  const token = spaceIdx === -1 ? after : after.slice(0, spaceIdx);
  if (!token) return null;
  // Chỉ gợi ý khi token chỉ gồm chữ/số (không chứa ký tự đặc biệt → đang gõ nội dung thường)
  if (!/^[\p{L}\p{N}_]+$/u.test(token)) return null;
  return { atIndex: at, token };
}

export function MessageInput() {
  const joined = useChatStore((s) => s.joined);
  const send = useChatStore((s) => s.sendMessage);
  const emitTyping = useChatStore((s) => s.emitTyping);
  const typingUsers = useChatStore((s) => s.typingUsers);
  const members = useChatStore((s) => s.members);
  const replyTarget = useChatStore((s) => s.replyTarget);
  const setReplyTarget = useChatStore((s) => s.setReplyTarget);
  const me = useAuthStore((s) => s.user?.id);

  const [text, setText] = useState('');
  const [cooldown, setCooldown] = useState(false);
  const [selected, setSelected] = useState<MentionSelection[]>([]);
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

  useEffect(() => () => { if (typingTimer.current) clearTimeout(typingTimer.current); }, []);

  const len = text.length;
  const over = len > env.messageMaxChars;
  const disabled = !joined || cooldown || over || text.trim().length === 0;

  // ── @mention gợi ý ─────────────────────────────────────────────────────
  const mention = currentMention(text);
  const suggestions = mention
    ? members
        .filter((m) => {
          if (!m.userId || m.userId === me) return false;
          if (selected.some((s) => s.userId === m.userId)) return false;
          const name = m.displayName ?? '';
          return name.toLowerCase().includes(mention.token.toLowerCase());
        })
        .slice(0, 5)
    : [];

  function selectMention(member: { userId: string; displayName: string | null }) {
    if (!mention) return;
    const tag = `@${member.displayName ?? member.userId} `;
    const next = `${text.slice(0, mention.atIndex)}${tag}${text.slice(mention.atIndex + mention.token.length + 1)}`;
    setText(next);
    setSelected((s) => [...s, { userId: member.userId, tag }]);
    taRef.current?.focus();
  }

  function cancelSelected(uid: string) {
    setSelected((s) => s.filter((x) => x.userId !== uid));
  }

  function handleSend() {
    if (disabled) return;
    // Prune mention đã bị xóa khỏi text
    const kept = selected.filter((s) => text.includes(s.tag));
    send(text, { mentions: kept.map((s) => s.userId) });
    setText('');
    setSelected([]);
    setCooldown(true);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

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

      {/* Reply preview — đang trả lời tin nào */}
      {replyTarget && (
        <div className="mb-2 flex items-center gap-2 rounded-lg border-l-4 border-primary bg-background/60 px-2.5 py-1.5">
          <MessageSquare className="h-3.5 w-3.5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold text-primary">
              {replyTarget.displayName ?? 'Thanh vien'}
            </div>
            <div className="line-clamp-1 max-w-full text-xs text-muted-foreground">
              {replyTarget.isDeleted ? '(Tin nhan da bi xoa)' : replyTarget.content}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setReplyTarget(null)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Huy tra loi"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Dropdown gợi ý @mention */}
      {suggestions.length > 0 && (
        <div className="mb-2 max-h-56 overflow-y-auto rounded-lg border border-border/60 bg-card shadow-lg">
          {suggestions.map((m) => (
            <button
              key={m.userId}
              type="button"
              onClick={() => selectMention(m)}
              className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-sm hover:bg-accent"
            >
              <UserAvatar name={m.displayName} userId={m.userId} url={m.avatarUrl} size="sm" />
              <span className="truncate">{m.displayName ?? m.userId}</span>
            </button>
          ))}
        </div>
      )}

      {/* Chips mention đã chọn (click X để bỏ) */}
      {selected.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {selected.map((s) => (
            <span
              key={s.userId}
              className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px] text-primary"
            >
              {s.tag.trim()}
              <button type="button" onClick={() => cancelSelected(s.userId)} className="rounded-full hover:bg-primary/25">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
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
          placeholder={joined ? 'Nhap tin nhan... (Enter de gui, @ de nhac ten)' : 'Dang vao phong...'}
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