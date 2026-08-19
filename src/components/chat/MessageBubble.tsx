import { memo } from 'react';
import { format } from 'date-fns';
import { Loader2, AlertCircle, Image as ImageIcon, MessageSquare, Heart } from 'lucide-react';
import type { LocalMessage } from '@/store/chat.store';
import { useChatStore } from '@/store/chat.store';
import { useAuthStore } from '@/store/auth.store';
import { UserAvatar } from './UserAvatar';
import { cn } from '@/lib/utils';

interface Props {
  message: LocalMessage;
  showHeader: boolean;
}

export const MessageBubble = memo(function MessageBubble({ message, showHeader }: Props) {
  const me = useAuthStore((s) => s.user?.id);
  const readReceipts = useChatStore((s) => s.readReceipts);
  const setReplyTarget = useChatStore((s) => s.setReplyTarget);
  const timMessage = useChatStore((s) => s.timMessage);
  const untimMessage = useChatStore((s) => s.untimMessage);

  const isMe = message.userId === me;
  const name = isMe && !message.displayName ? 'Ban' : message.displayName ?? 'Thanh vien';
  const showImage = message.fileType === 'IMAGE';

  // @mention: bị người khác tag thì highlight bubble
  const isMentioned =
    !isMe && !!me && Array.isArray(message.mentionedUserIds) && message.mentionedUserIds.includes(me);

  // Read receipt (tick cho tin mình): đã có ≥1 người khác có watermark >= createdAt
  const isReadByOther =
    isMe &&
    Object.entries(readReceipts).some(
      ([uid, w]) => uid !== me && w && new Date(w).getTime() >= new Date(message.createdAt).getTime(),
    );
  const confirmSent = !message._local;

  const canReply = !message.isDeleted && message.userId;
  const liked = message.likedByMe ?? false;
  const likeCount = message.timCount ?? 0;

  return (
    <div
      className={cn(
        'group flex gap-2.5 px-3',
        isMe ? 'flex-row-reverse' : 'flex-row',
        showHeader ? 'mt-3' : 'mt-0.5',
      )}
    >
      <div className="w-8 shrink-0">
        {showHeader && <UserAvatar name={message.displayName} userId={message.userId} url={message.avatarUrl} size="sm" />}
      </div>

      <div className={cn('flex max-w-[78%] flex-col', isMe ? 'items-end' : 'items-start')}>
        {showHeader && (
          <div className={cn('mb-1 flex items-center gap-1.5 text-xs', isMe ? 'flex-row-reverse' : 'flex-row')}>
            <span className="font-medium text-foreground/90">{name}</span>
            <span className="text-muted-foreground/70">{format(new Date(message.createdAt), 'HH:mm')}</span>
          </div>
        )}

        {/* Hành động nhanh (Reply / Lưu tin) — hiện khi hover */}
        {!message.isDeleted && (
          <div
            className={cn(
              'mb-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100',
              isMe ? 'flex-row-reverse' : 'flex-row',
            )}
          >
            {canReply && (
              <button
                type="button"
                title="Tra loi"
                onClick={() => setReplyTarget(message)}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <MessageSquare className="h-3 w-3" /> Tra loi
              </button>
            )}
            <button
              type="button"
              title="Tim tin nhan"
              onClick={() => timMessage(message.id)}
              className={cn(
                'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] hover:bg-accent',
                liked ? 'text-rose-500 hover:text-rose-600' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Heart className={cn('h-3 w-3', liked && 'fill-rose-500')} /> {likeCount}
            </button>
            {liked && (
              <button
                type="button"
                title="Bo tim"
                onClick={() => untimMessage(message.id)}
                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Heart className="h-3 w-3" /> Bo tim
              </button>
            )}
          </div>
        )}

        <div
          className={cn(
            'break-words rounded-2xl px-3.5 py-2 text-sm leading-relaxed',
            isMe ? 'rounded-tr-sm bg-primary/20' : 'rounded-tl-sm bg-secondary',
            isMentioned && 'ring-2 ring-primary/70',
            message._local === 'failed' && 'border border-destructive/40 bg-destructive/10',
          )}
        >
          {/* Reply quote: tin này là reply → hiện block trích tin gốc */}
          {message.replyToId && (
            <div className="mb-1.5 overflow-hidden rounded-lg border-l-4 border-primary bg-background/50 px-2 py-1">
              <div className="truncate text-xs font-semibold text-primary">{message.replyToSenderName ?? ''}</div>
              <div className="line-clamp-2 text-xs text-muted-foreground">
                {message.replyToContent ?? '(Tin nhan da bi xoa)'}
              </div>
            </div>
          )}

          <span className="whitespace-pre-wrap">{message.content}</span>

          {showImage && (
            <div className="mt-2 flex items-center gap-2 rounded-lg bg-background/40 px-2 py-1.5 text-xs text-muted-foreground">
              <ImageIcon className="h-3.5 w-3.5" />
              <span>Anh dinh kem</span>
              {message.fileWidth && message.fileHeight && (
                <span className="text-muted-foreground/60">
                  {message.fileWidth}x{message.fileHeight}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Trạng thái tin của mình: dang gui / loi / ✓ sent / ✓✓ da doc */}
        {isMe && (message._local === 'pending' || message._local === 'failed' || confirmSent || isReadByOther) && (
          <span className="mt-0.5 flex items-center gap-1 text-[10px]">
            {message._local === 'pending' && (
              <span className="flex items-center gap-1 text-muted-foreground">
                <Loader2 className="h-2.5 w-2.5 animate-spin" /> dang gui...
              </span>
            )}
            {message._local === 'failed' && (
              <span className="flex items-center gap-1 text-destructive">
                <AlertCircle className="h-2.5 w-2.5" /> chua gui duoc
              </span>
            )}
            {!message._local && (
              <span className={cn('tabular-nums', isReadByOther ? 'text-green-600' : 'text-muted-foreground')}>
                {isReadByOther ? '✓✓' : '✓'}
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  );
});