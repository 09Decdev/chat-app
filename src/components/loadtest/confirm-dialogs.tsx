import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertBanner } from '@/components/ui/alert-banner';
import { CONFIRM_PHRASE } from '@/lib/loadtest-format';

// ─── SD-1: Confirm modal chặn cứng (gõ "TÔI XÁC NHẬN") ─────────────────────

export interface StartRunConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gatewayUrl: string;
  hugePreset: boolean; // preset 1M/10M — banner destructive trong modal
  onConfirm: () => void;
}

function StartRunConfirmDialog({ open, onOpenChange, gatewayUrl, hugePreset, onConfirm }: StartRunConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const valid = typed.trim() === CONFIRM_PHRASE;

  // Mỗi lần mở modal phải gõ lại (session-only) — reset state.
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">CẢNH BÁO MÔI TRƯỜNG TEST</DialogTitle>
          <DialogDescription>
            Bạn sắp chạy LOAD TEST trên: <span className="font-mono text-xs text-foreground">{gatewayUrl}</span>
            <br />
            Tool sẽ tạo user thật và gửi traffic thật. KHÔNG BAO GIỜ chạy trên production.
          </DialogDescription>
        </DialogHeader>
        {hugePreset && (
          <AlertBanner
            variant="destructive"
            title="Preset 1M/10M vượt năng lực 1 máy"
            description="Cần cluster (v1.1). Chạy trên máy này sẽ không đạt target và có thể quá tải tool."
          />
        )}
        <div className="space-y-2">
          <Label htmlFor="confirm-phrase" className="text-sm">
            Gõ chính xác chuỗi bên dưới để xác nhận: <span className="font-semibold text-foreground">{CONFIRM_PHRASE}</span>
          </Label>
          <Input
            id="confirm-phrase"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={CONFIRM_PHRASE}
            autoComplete="off"
            aria-describedby={valid ? undefined : 'confirm-phrase-hint'}
          />
          {!valid && (
            <p id="confirm-phrase-hint" className="text-xs text-muted-foreground">
              Phải gõ đúng chuỗi (kể cả dấu) để mở khóa nút Bắt đầu.
            </p>
          )}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" className="min-h-11" onClick={() => onOpenChange(false)}>
            Hủy
          </Button>
          <Button type="button" className="min-h-11" disabled={!valid} onClick={onConfirm}>
            Bắt đầu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── SD-3: Kill-switch / Stop confirm — alertdialog + đếm ngược 5s ──────────

export interface StopRunConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kill: boolean; // true = kill-switch khẩn (force)
  onConfirm: () => void;
}

function StopRunConfirmDialog({ open, onOpenChange, kill, onConfirm }: StopRunConfirmDialogProps) {
  const [countdown, setCountdown] = useState(5);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    setCountdown(5);
    const iv = window.setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          window.clearInterval(iv);
          // Focus vào nút Dừng ngay khi mở khóa (5.2 kill-switch).
          btnRef.current?.focus();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => window.clearInterval(iv);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        role="alertdialog"
        aria-labelledby="stop-dialog-title"
        className="max-w-md border-destructive/40"
      >
        <DialogHeader>
          <DialogTitle id="stop-dialog-title" className="text-base text-destructive">
            {kill ? 'KILL-SWITCH' : 'DỪNG RUN?'}
          </DialogTitle>
          <DialogDescription>
            Dừng toàn bộ worker ≤ 5s và disconnect socket ≤ 10s. Số liệu sẽ là partial.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" className="min-h-11" onClick={() => onOpenChange(false)}>
            Hủy
          </Button>
          <Button
            ref={btnRef}
            type="button"
            variant="destructive"
            className="min-h-11 min-w-36"
            disabled={countdown > 0}
            onClick={onConfirm}
          >
            {countdown > 0 ? `Dừng ngay (${countdown}s)` : 'Dừng ngay'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── SD-4: Cleanup confirm — chặn cứng (gõ "TÔI XÁC NHẬN") ─────────────────

export interface CleanupConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runId: string;
  redisKeys: number;
  onConfirm: () => void;
}

function CleanupConfirmDialog({ open, onOpenChange, runId, redisKeys, onConfirm }: CleanupConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const valid = typed.trim() === CONFIRM_PHRASE;

  // Mỗi lần mở modal phải gõ lại — reset state.
  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        role="alertdialog"
        aria-labelledby="cleanup-dialog-title"
        className="max-w-md border-destructive/40"
      >
        <DialogHeader>
          <DialogTitle id="cleanup-dialog-title" className="text-base text-destructive">
            XÓA DỮ LIỆU TEST?
          </DialogTitle>
          <DialogDescription>
            Sẽ xóa {redisKeys} redis keys và user/post/comment test của run{' '}
            <span className="font-mono text-xs text-foreground">{runId}</span>. Hành động không thể hoàn tác —
            chạy dry-run trước nếu chưa chắc chắn.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="cleanup-confirm-phrase" className="text-sm">
            Gõ chính xác chuỗi bên dưới để xác nhận: <span className="font-semibold text-foreground">{CONFIRM_PHRASE}</span>
          </Label>
          <Input
            id="cleanup-confirm-phrase"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={CONFIRM_PHRASE}
            autoComplete="off"
            aria-describedby={valid ? undefined : 'cleanup-confirm-phrase-hint'}
          />
          {!valid && (
            <p id="cleanup-confirm-phrase-hint" className="text-xs text-muted-foreground">
              Phải gõ đúng chuỗi (kể cả dấu) để mở khóa nút xóa.
            </p>
          )}
        </div>
        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" className="min-h-11" onClick={() => onOpenChange(false)}>
            Hủy
          </Button>
          <Button type="button" variant="destructive" className="min-h-11" disabled={!valid} onClick={onConfirm}>
            Xóa
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { StartRunConfirmDialog, StopRunConfirmDialog, CleanupConfirmDialog };
