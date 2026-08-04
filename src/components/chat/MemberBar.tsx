import { useChatStore } from '@/store/chat.store';
import { UserAvatar } from './UserAvatar';
import { env } from '@/lib/env';

export function MemberBar() {
  const members = useChatStore((s) => s.members);
  const voteKick = useChatStore((s) => s.voteKick);
  const startVoteKick = useChatStore((s) => s.startVoteKick);
  const slots = Array.from({ length: env.maxMembers }, (_, i) => members[i] ?? null);

  return (
    <div className="no-scrollbar flex items-center gap-3 overflow-x-auto border-b border-border/60 bg-card/30 px-4 py-2.5">
      {slots.map((m, i) => (
        <div key={i} className="group flex shrink-0 items-center gap-2">
          {m ? (
            <>
              <UserAvatar name={m.displayName} userId={m.userId} url={m.avatarUrl} size="sm" ring />
              <div className="hidden sm:block">
                <p className="text-xs font-medium leading-tight">
                  {m.isMe ? 'Ban' : m.displayName ?? 'Thanh vien'}
                </p>
                {m.isMe && <p className="text-[10px] leading-tight text-primary">ban</p>}
              </div>
              {!m.isMe && !voteKick.active && members.length >= 3 && (
                <button
                  onClick={() => startVoteKick(m.userId)}
                  className="hidden rounded px-1 text-[10px] text-muted-foreground/50 hover:bg-destructive/10 hover:text-destructive group-hover:inline"
                  title="Vote kick"
                >
                  ✕
                </button>
              )}
            </>
          ) : (
            <div className="flex h-8 w-8 items-center justify-center rounded-full border border-dashed border-border/70 text-muted-foreground/40">
              <span className="text-xs">+</span>
            </div>
          )}
        </div>
      ))}
      <span className="ml-auto shrink-0 rounded-full bg-primary/15 px-2.5 py-1 text-[11px] font-medium text-primary">
        {members.length}/{env.maxMembers}
      </span>
    </div>
  );
}
