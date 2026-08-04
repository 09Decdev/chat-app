import { memo } from 'react';
import { format } from 'date-fns';
import { Loader2, AlertCircle, Image as ImageIcon } from 'lucide-react';
import type { LocalMessage } from '@/store/chat.store';
import { useAuthStore } from '@/store/auth.store';
import { UserAvatar } from './UserAvatar';
import { cn } from '@/lib/utils';

interface Props {
  message: LocalMessage;
  showHeader: boolean;
}

export const MessageBubble = memo(function MessageBubble({ message, showHeader }: Props) {
  const me = useAuthStore((s) => s.user?.id);
  const isMe = message.userId === me;
  const name = isMe && !message.displayName ? 'Ban' : message.displayName ?? 'Thanh vien';
  const showImage = message.fileType === 'IMAGE';

  return (
    <div className={cn('flex gap-2.5 px-3', isMe ? 'flex-row-reverse' : 'flex-row', showHeader ? 'mt-3' : 'mt-0.5')}>
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

        <div
          className={cn(
            'break-words rounded-2xl px-3.5 py-2 text-sm leading-relaxed',
            isMe ? 'rounded-tr-sm bg-primary/20' : 'rounded-tl-sm bg-secondary',
            message._local === 'failed' && 'border border-destructive/40 bg-destructive/10',
          )}
        >
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

        {message._local === 'pending' && (
          <span className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
            <Loader2 className="h-2.5 w-2.5 animate-spin" /> dang gui...
          </span>
        )}
        {message._local === 'failed' && (
          <span className="mt-0.5 flex items-center gap-1 text-[10px] text-destructive">
            <AlertCircle className="h-2.5 w-2.5" /> chua gui duoc
          </span>
        )}
      </div>
    </div>
  );
});
