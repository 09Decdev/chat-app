import { motion } from 'framer-motion';
import { Pencil, Trash2 } from 'lucide-react';
import { formatDistanceToNowStrict } from 'date-fns';
import { vi } from 'date-fns/locale';
import { useAuthStore } from '@/store/auth.store';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { UserAvatar } from './UserAvatar';
import type { TopicDto } from '@/types/chat';

interface TopicCardProps {
  topic: TopicDto;
  /** mine only — mở sheet mode 'edit' */
  onEdit?: () => void;
  /** mine only — mở confirm xoá (xử lý bởi TopicStrip) */
  onAskDelete?: () => void;
}

/** Thời gian tương đối tiếng Việt: "Vừa xong" / "2 phút trước". */
function relativeTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'Vừa xong';
  try {
    return formatDistanceToNowStrict(new Date(ts), { addSuffix: true, locale: vi });
  } catch {
    return '';
  }
}

/**
 * Card 1 topic (presentational). 2 biến thể:
 * - others: read-only, viền border/60, nền card/40; tap/hover xem full title qua native tooltip.
 * - mine: viền primary, nền primary/5, chip "Bạn", nút [Sửa]/[Xoá].
 *
 * Wrap bởi `<motion.div>` ở TopicStrip để AnimatePresence exit hoạt động đúng
 * (spec §5.3 — motion.div phải là direct child có key). Title fade-swap khi
 * cập nhật dùng motion.span key=title (remount → initial opacity → animate).
 */
export function TopicCard({ topic, onEdit, onAskDelete }: TopicCardProps) {
  const me = useAuthStore((s) => s.user?.id);
  const isMine = !!me && topic.userId === me;
  const name = isMine ? 'Bạn' : topic.displayName ?? 'Thành viên';

  return (
    <div
      role="listitem"
      aria-label={`Chủ đề của ${name}`}
      className={
        isMine
          ? 'relative w-[140px] shrink-0 rounded-lg border border-primary bg-primary/5 p-2.5'
          : 'relative w-[140px] shrink-0 rounded-lg border border-border/60 bg-card/40 p-2.5'
      }
    >
      {isMine && (
        <Badge className="absolute right-2 top-2 h-5 px-1.5 text-[10px] leading-none">Bạn</Badge>
      )}
      <div className="flex items-center gap-2">
        <UserAvatar
          name={topic.displayName}
          userId={topic.userId}
          url={topic.avatarUrl}
          size="sm"
          ring={isMine}
        />
        <p className="truncate text-xs font-medium leading-tight">{name}</p>
      </div>

      <p title={topic.title} className="mt-1.5 line-clamp-1 text-sm leading-snug">
        <motion.span
          key={topic.title}
          initial={{ opacity: 0.4 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.1 }}
        >
          {topic.title}
        </motion.span>
      </p>

      <p className="mt-1 text-[10px] tabular-nums text-muted-foreground/70">
        {relativeTime(topic.createdAt)}
      </p>

      {isMine && (
        <div className="mt-1 flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            aria-label="Sửa chủ đề của bạn"
            onClick={onEdit}
          >
            <Pencil className="h-3.5 w-3.5" /> Sửa
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
            aria-label="Xoá chủ đề của bạn"
            onClick={onAskDelete}
          >
            <Trash2 className="h-3.5 w-3.5" /> Xoá
          </Button>
        </div>
      )}
    </div>
  );
}
