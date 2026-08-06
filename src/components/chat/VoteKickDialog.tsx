import { useEffect, useState } from 'react';
import { useChatStore } from '@/store/chat.store';
import { useAuthStore } from '@/store/auth.store';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { UserAvatar } from './UserAvatar';

/** Popup vote-kick: hiện khi có user tạo vote (voteKick.active). Thay banner inline. */
export function VoteKickDialog() {
  const voteKick = useChatStore((s) => s.voteKick);
  const members = useChatStore((s) => s.members);
  const castVoteKick = useChatStore((s) => s.castVoteKick);
  const resetVoteKick = useChatStore((s) => s.resetVoteKick);
  const me = useAuthStore((s) => s.user);

  const [remaining, setRemaining] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [voted, setVoted] = useState(false);

  // Reset local state khi vote kết thúc (active → false)
  useEffect(() => {
    if (!voteKick.active) {
      setDismissed(false);
      setVoted(false);
    }
  }, [voteKick.active]);

  // Countdown
  useEffect(() => {
    if (!voteKick.active || !voteKick.expiresAt) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((voteKick.expiresAt! - Date.now()) / 1000));
      setRemaining(left);
      // Hết giờ mà server chưa emit result → tự reset về idle (không treo dialog vĩnh viễn)
      if (left <= 0) resetVoteKick();
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [voteKick.active, voteKick.expiresAt, resetVoteKick]);

  const open = voteKick.active && !!voteKick.targetUserId && !dismissed;
  const isTarget = !!me?.id && me.id === voteKick.targetUserId;
  const isInitiator = !!voteKick.initiatorId && !!me?.id && me.id === voteKick.initiatorId;
  const targetMember = members.find((m) => m.userId === voteKick.targetUserId);
  const targetName = targetMember?.displayName ?? 'Thanh vien';
  const canVote = !isTarget && !isInitiator && !voted && voteKick.currentVotes < voteKick.requiredVotes;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setDismissed(true);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>🗳️</span> Vote kick
          </DialogTitle>
          <DialogDescription>
            {isTarget
              ? 'Bạn đang bị các thành viên khác bỏ phiếu kick.'
              : isInitiator
                ? `Bạn đã bắt đầu vote kick ${targetName}. Đang chờ các thành viên khác bỏ phiếu.`
                : `Bỏ phiếu kick ${targetName} khỏi phòng?`}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
          <UserAvatar
            name={targetMember?.displayName}
            userId={voteKick.targetUserId ?? ''}
            url={targetMember?.avatarUrl}
            size="sm"
            ring
          />
          <div className="flex-1 text-sm">
            <p className="font-medium">{targetName}</p>
            <p className="text-xs text-muted-foreground">
              <span className="font-mono">
                {voteKick.currentVotes}/{voteKick.requiredVotes}
              </span>{' '}
              phiếu
            </p>
          </div>
          <span className="font-mono text-xs text-muted-foreground">{remaining}s</span>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" size="sm" onClick={() => setDismissed(true)}>
            Để sau
          </Button>
          {canVote && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                castVoteKick();
                setVoted(true);
              }}
            >
              Bỏ phiếu kick
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
