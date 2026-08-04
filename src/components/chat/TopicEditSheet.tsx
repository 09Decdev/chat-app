import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { AlertTriangle, ArrowRight, Loader2, Sparkles, Trash2 } from 'lucide-react';
import { useChatStore } from '@/store/chat.store';
import { ChatErrorCode } from '@/lib/constants';
import { env } from '@/lib/env';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const QUICK_CHIPS = [
  'Review phim',
  'Đi phượt',
  'Âm nhạc',
  'Chuyện công sở',
  'Du lịch rẻ',
  'Hỏi chuyện đời',
];

/**
 * Bottom sheet tạo/sửa topic. Tái dụng Radix Dialog anchor đáy (KHÔNG cài
 * Drawer/Vaul — gap G2). Pattern VoteKickDialog nhưng override CSS đáy.
 * States: idle/validating/rate-limited(429)/room-full(409)/submitting.
 * 404/403 KHÔNG trong sheet — toast + exit (xử lý trong store).
 */
export function TopicEditSheet() {
  const open = useChatStore((s) => s.topicSheetOpen);
  const mode = useChatStore((s) => s.topicSheetMode);
  const draft = useChatStore((s) => s.topicDraft);
  const saving = useChatStore((s) => s.topicSaving);
  const error = useChatStore((s) => s.topicError);
  const rateLimitUntil = useChatStore((s) => s.topicRateLimitUntil);
  const setSheetOpen = useChatStore((s) => s.setTopicSheetOpen);
  const setDraft = useChatStore((s) => s.setTopicDraft);
  const submit = useChatStore((s) => s.submitTopic);
  const remove = useChatStore((s) => s.removeMyTopic);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Countdown rate-limit (pattern VoteKickDialog/StartScreen)
  useEffect(() => {
    if (!rateLimitUntil) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [rateLimitUntil]);

  const rateLeft = rateLimitUntil ? Math.max(0, Math.ceil((rateLimitUntil - now) / 1000)) : 0;
  const rateLimited = rateLeft > 0;

  const cp = [...draft].length; // code point count (BR-03)
  const invalid = cp < env.topicMinCp || cp > env.topicMaxCp;
  const overMax = cp > env.topicMaxCp;
  const underMin = cp > 0 && cp < env.topicMinCp;

  const isRoomFull = error?.code === ChatErrorCode.TOPIC_ROOM_FULL;
  const saveDisabled = invalid || saving || rateLimited;

  const counterColor =
    cp > env.topicMaxCp
      ? 'text-destructive'
      : cp >= env.topicMaxCp - 10
        ? 'text-amber-300'
        : 'text-muted-foreground/60';

  function applyChip(chip: string) {
    setDraft(chip);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      const len = taRef.current?.value.length ?? 0;
      taRef.current?.setSelectionRange(len, len);
    });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!saveDisabled) void submit();
    }
  }

  const saveLabel = saving ? 'Đang lưu...' : rateLimited ? `Chờ ${rateLeft}s` : 'Lưu';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!saving) setSheetOpen(o);
      }}
    >
      <DialogContent
        className={cn(
          'left-0 right-0 top-auto bottom-0 flex max-w-none translate-x-0 translate-y-0',
          'flex-col gap-4 rounded-t-2xl rounded-b-none border-b-0',
          'p-4 pb-[max(1rem,env(safe-area-inset-bottom))]',
          'sm:left-1/2 sm:right-auto sm:max-w-md sm:-translate-x-1/2',
          'sm:rounded-t-2xl sm:rounded-b-none',
        )}
        onOpenAutoFocus={(e) => {
          // Autofocus textarea + select-all text hiện tại (I7)
          e.preventDefault();
          const ta = taRef.current;
          if (ta) {
            ta.focus();
            if (mode === 'edit' && ta.value) ta.select();
          }
        }}
      >
        {/* Drag handle (visual, không có chức năng kéo — gap G2) */}
        <div className="mx-auto h-1.5 w-10 rounded-full bg-border" aria-hidden />

        <DialogHeader className="flex-row items-center justify-between space-y-0">
          <DialogTitle className="text-base font-semibold">
            {mode === 'edit' ? 'Sửa chủ đề của bạn' : 'Tạo chủ đề của bạn'}
          </DialogTitle>
          {/* Nút close (X) dùng default của DialogContent (dialog.tsx:41-44,
              absolute right-4 top-4). Spec §2.3 "giữ" default — KHÔNG thêm nút
              riêng tránh chồng. onOpenChange (Dialog root) đã chặn đóng khi
              đang saving. */}
        </DialogHeader>

        <DialogDescription className="sr-only">
          Đặt chủ đề ngắn (3-80 ký tự) để mọi người trong phòng biết bạn muốn trò chuyện gì.
        </DialogDescription>

        <Textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={env.topicMaxCp + 20}
          placeholder="VD: Tâm sự chuyện công sở, Review phim Việt..."
          aria-label="Tiêu đề chủ đề"
          aria-invalid={invalid && cp > 0}
          aria-describedby="topic-counter topic-hint"
          className="min-h-[60px] max-h-[120px] bg-background/40"
        />

        <div id="topic-counter" className="flex justify-end text-xs tabular-nums" aria-live="polite">
          <span className={counterColor}>
            {cp}/{env.topicMaxCp}
          </span>
        </div>

        <div className="no-scrollbar flex gap-2 overflow-x-auto">
          {QUICK_CHIPS.map((chip) => (
            <Button
              key={chip}
              variant="outline"
              size="sm"
              className="h-7 shrink-0 px-3 text-xs"
              onClick={() => applyChip(chip)}
              disabled={saving}
            >
              <Sparkles className="h-3 w-3" /> {chip}
            </Button>
          ))}
        </div>

        {cp > 0 && (underMin || overMax) && (
          <p
            id="topic-hint"
            className={cn(
              'flex items-center gap-1.5 text-xs',
              underMin ? 'text-muted-foreground' : 'text-destructive',
            )}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            {underMin ? 'Tối thiểu 3 ký tự' : 'Đã đạt giới hạn 80 ký tự'}
          </p>
        )}

        {error && (
          <div
            role="alert"
            className={cn(
              'flex items-center gap-2 rounded-lg border px-3 py-2 text-xs',
              error.code === ChatErrorCode.TOPIC_TITLE_INVALID
                ? 'border-destructive/30 bg-destructive/10 text-destructive'
                : 'border-amber-500/30 bg-amber-500/10 text-amber-300',
            )}
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="flex-1">
              {error.code === ChatErrorCode.TOPIC_RATE_LIMITED && rateLimited
                ? `Chờ ${rateLeft}s rồi sửa nhé`
                : error.code === ChatErrorCode.TOPIC_ROOM_FULL
                  ? 'Phòng đã đủ 6 chủ đề'
                  : error.code === ChatErrorCode.TOPIC_TITLE_INVALID
                    ? 'Chủ đề không hợp lệ (3-80 ký tự)'
                    : error.message}
            </span>
          </div>
        )}

        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          {mode === 'edit' && !isRoomFull && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setConfirmOpen(true)}
              disabled={saving}
            >
              <Trash2 className="h-4 w-4" /> Xoá topic
            </Button>
          )}

          {isRoomFull ? (
            <Button
              variant="outline"
              size="lg"
              className="flex-1"
              onClick={() => setSheetOpen(false)}
              disabled={saving}
            >
              Đóng
            </Button>
          ) : (
            <Button
              variant="gradient"
              size="lg"
              className="flex-1"
              disabled={saveDisabled}
              onClick={() => void submit()}
              aria-label="Lưu chủ đề"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowRight className="h-4 w-4" />
              )}
              {saveLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>

      {/* Confirm xoá — Dialog lồng cho a11y (khuyến nghị spec §2.3) */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
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
                setConfirmOpen(false);
                void remove();
              }}
            >
              Xoá
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
