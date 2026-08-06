import { useState } from 'react';
import { Tag, Plus } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useChatStore } from '@/store/chat.store';
import { useAuthStore } from '@/store/auth.store';
import { env } from '@/lib/env';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TopicCard } from './TopicCard';
import type { TopicDto } from '@/types/chat';

/**
 * Container ngang 0-6 TopicCard + CTA [+ Chủ đề của bạn] khi mình chưa có.
 * Đặt giữa MemberBar và MessageList trong ChatRoom. Cuộn ngang, KHÔNG chiếm
 * chiều cao tin nhắn. (UX-FLOW WF-2, UI-SPEC §2.1)
 *
 * AnimatePresence wrap các `<motion.div key={userId}>` direct (spec §5.3) để
 * exit animation (fade-out 100ms khi xoá topic) hoạt động đúng — card phải là
 * direct child, không qua wrapper component.
 */
export function TopicStrip() {
  const phase = useChatStore((s) => s.phase);
  const topics = useChatStore((s) => s.topics);
  const loadingHistory = useChatStore((s) => s.loadingHistory);
  const joined = useChatStore((s) => s.joined);
  const setTopicSheetOpen = useChatStore((s) => s.setTopicSheetOpen);
  const removeMyTopic = useChatStore((s) => s.removeMyTopic);
  const me = useAuthStore((s) => s.user?.id);

  const [deleteTarget, setDeleteTarget] = useState<TopicDto | null>(null);

  if (phase !== 'in_room') return null;

  // Sắp xếp: topic của người khác giữ thứ tự, card MÌNH luôn cuối (UI-SPEC §2.1)
  const mine = me ? topics.find((t) => t.userId === me) : undefined;
  const others = topics.filter((t) => t.userId !== me);
  const ordered = [...others, ...(mine ? [mine] : [])];

  // Cửa sổ init: đang load history + chưa join + chưa có topic → skeleton
  const isLoading = loadingHistory && topics.length === 0 && !joined;

  return (
    <div className="border-b border-border/60 bg-card/30 px-4 py-2.5" aria-label="Chủ đề phòng">
      <div className="flex items-center gap-2 pb-2 text-xs text-muted-foreground">
        <Tag className="h-3.5 w-3.5 text-primary" />
        <span className="font-medium">Chủ đề phòng</span>
        <span className="ml-auto rounded-full bg-primary/15 px-2.5 py-1 text-[11px] font-medium tabular-nums text-primary">
          {topics.length}/{env.maxMembers}
        </span>
      </div>

      {isLoading ? (
        <div className="flex items-start gap-2 py-1" role="list" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[84px] w-[140px] shrink-0 rounded-lg" />
          ))}
        </div>
      ) : topics.length === 0 ? (
        <div className="flex items-center gap-2 rounded-lg bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <span className="flex-1">Chưa ai đặt chủ đề — bạn thì sao?</span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 px-2 text-xs"
            aria-label="Tạo chủ đề của bạn"
            onClick={() => setTopicSheetOpen(true, 'create')}
          >
            <Plus className="h-3.5 w-3.5" /> Tạo
          </Button>
        </div>
      ) : (
        <div className="no-scrollbar flex items-start gap-2 overflow-x-auto py-1" role="list">
          <AnimatePresence initial={false}>
            {ordered.map((topic) => (
              <motion.div
                key={topic.userId}
                className="shrink-0"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, scale: 0.96 }}
                transition={{ duration: 0.12 }}
              >
                <TopicCard
                  topic={topic}
                  onEdit={() => setTopicSheetOpen(true, 'edit')}
                  onAskDelete={() => setDeleteTarget(topic)}
                />
              </motion.div>
            ))}
          </AnimatePresence>
          {!mine && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 self-center border-dashed border-primary/50 text-primary hover:bg-primary/10"
              aria-label="Tạo chủ đề của bạn"
              onClick={() => setTopicSheetOpen(true, 'create')}
            >
              <Plus className="h-3.5 w-3.5" /> Chủ đề của bạn
            </Button>
          )}
        </div>
      )}

      {/* Confirm xoá — 1 dialog duy nhất ở strip (lift khỏi TopicCard để
          motion.div remain direct child của AnimatePresence). Spec §2.2 a11y. */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Xoá chủ đề của bạn?</DialogTitle>
            <DialogDescription>
              Chủ đề sẽ biến mất khỏi phòng. Bạn có thể tạo lại bất cứ lúc nào.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                Huỷ
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                setDeleteTarget(null);
                void removeMyTopic();
              }}
            >
              Xoá
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
