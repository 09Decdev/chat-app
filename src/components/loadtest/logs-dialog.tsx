import { useEffect, useRef, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { loadtestApi } from '@/lib/loadtest-api';
import { fmtTickTime } from '@/lib/loadtest-format';
import { cn } from '@/lib/utils';

interface LogRow {
  ts: number;
  level: string;
  msg: string;
}

/** Logs viewer (ring 500 server) — poll 2s khi mở. */
export function LogsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [connected, setConnected] = useState(false);
  // Radix ScrollArea — element cuộn thật là Viewport (content div không scroll được).
  const viewportRef = useRef<HTMLDivElement>(null);
  // User đang ở bottom → mới auto-scroll theo log mới; đang đọc log cũ → không nhảy.
  const stickRef = useRef(true);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const fetchLogs = async () => {
      try {
        const res = await loadtestApi.logs(300);
        if (!alive) return;
        const el = viewportRef.current;
        if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        setLogs(res.logs);
        setConnected(true);
      } catch {
        if (alive) setConnected(false);
      }
    };
    void fetchLogs();
    const iv = window.setInterval(() => void fetchLogs(), 2000);
    return () => {
      alive = false;
      window.clearInterval(iv);
    };
  }, [open]);

  // User cuộn lên (rời bottom) → ngừng bám; cuộn về bottom → bám lại.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [open]);

  useEffect(() => {
    const el = viewportRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [logs, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            LOG RUN
            <span
              className={cn(
                'inline-block h-2 w-2 rounded-full',
                connected ? 'bg-success motion-safe:animate-pulse' : 'bg-destructive',
              )}
              aria-hidden
            />
            {connected ? 'live' : 'mất kết nối'}
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh]" viewportRef={viewportRef}>
          <div className="space-y-0.5 pr-3 font-mono text-xs leading-5" role="log" aria-label="Log của loadtest server">
            {logs.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">Chưa có log.</p>
            ) : (
              logs.map((l, i) => (
                <p key={i} className="flex gap-2 whitespace-pre-wrap break-all">
                  <span className="shrink-0 tabular-nums text-muted-foreground">{fmtTickTime(l.ts)}</span>
                  <span
                    className={cn(
                      'w-12 shrink-0',
                      l.level === 'error' ? 'text-destructive' : l.level === 'warn' ? 'text-warning' : 'text-info',
                    )}
                  >
                    {l.level}
                  </span>
                  <span className="text-foreground/80">{l.msg}</span>
                </p>
              ))
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
