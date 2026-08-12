/**
 * F-impersonate — Console multi-pane: chia 1/2/4/6/8/10/14/16 ô, mỗi ô 1 virtual user
 * (socket riêng). Mỗi pane tự my-room → vào phòng đúng. Ô trống: chọn virtual user từ dropdown.
 * Phóng to: nút Maximize trên từng pane (fullscreen 1 ô) + nút "Full màn hình" (che nav, tất cả ô lớn).
 */
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Maximize2, Minimize2 } from 'lucide-react';
import { ImpersonationPane } from '@/components/loadtest/impersonation-pane';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { loadtestApi } from '@/lib/loadtest-api';
import type { VirtualUserRow } from '@/types/loadtest';

const LAYOUTS = [1, 2, 4, 6, 8, 10, 14, 16];

function cols(n: number): number {
  return n <= 2 ? n : n <= 4 ? 2 : n <= 9 ? 3 : 4;
}

export default function ImpersonationConsolePage() {
  const [searchParams] = useSearchParams();
  const initialEmail = searchParams.get('email') ?? '';
  const [count, setCount] = useState(4);
  const [emails, setEmails] = useState<(string | null)[]>(() => {
    const arr: (string | null)[] = Array(16).fill(null);
    if (initialEmail) arr[0] = initialEmail;
    return arr;
  });
  const [users, setUsers] = useState<VirtualUserRow[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  // F-expand: maximized = index ô đang phóng to fullscreen; full = che nav, tất cả ô lớn.
  const [maximized, setMaximized] = useState<number | null>(null);
  const [full, setFull] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await loadtestApi.users({ offset: 0, limit: 500, sortBy: 'index', sortDir: 'asc' });
        if (cancelled) return;
        setUsers(res.rows);
      } catch {
        // không có run / server lỗi → picker hiện thông báo
      } finally {
        if (!cancelled) setLoadingUsers(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const gridCols = cols(count);
  const visible = emails.slice(0, count);

  const setEmail = (i: number, v: string) =>
    setEmails((prev) => {
      const n = [...prev];
      n[i] = v || null;
      return n;
    });
  const clearSlot = (i: number) =>
    setEmails((prev) => {
      const n = [...prev];
      n[i] = null;
      return n;
    });

  // ── Phóng to 1 ô (fullscreen overlay) ──
  if (maximized !== null) {
    const email = emails[maximized] ?? '';
    return (
      <div className="fixed inset-0 z-[60] flex flex-col bg-background p-2">
        <div className="flex items-center justify-end gap-2 py-1">
          <Button variant="outline" size="sm" className="min-h-9" onClick={() => setMaximized(null)}>
            <Minimize2 className="h-4 w-4" aria-hidden /> Thu nhỏ
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          {email ? (
            <ImpersonationPane email={email} onClose={() => setMaximized(null)} onMaximize={() => setMaximized(null)} />
          ) : (
            <p className="text-sm text-muted-foreground">Ô trống.</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={full ? 'fixed inset-0 z-50 flex flex-col bg-background p-2' : 'flex h-[calc(100vh-8rem)] flex-col gap-3'}>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-base font-semibold">CONSOLE — truy cập nhiều user</h1>
        <span className="text-xs text-muted-foreground">Bố cục:</span>
        {LAYOUTS.map((n) => (
          <Button
            key={n}
            variant={count === n ? 'default' : 'outline'}
            size="sm"
            className="min-h-9 px-2.5"
            onClick={() => setCount(n)}
            aria-pressed={count === n}
          >
            {n}
          </Button>
        ))}
        <Button
          variant={full ? 'default' : 'outline'}
          size="sm"
          className="ml-auto min-h-9"
          onClick={() => setFull((v) => !v)}
          aria-pressed={full}
        >
          {full ? <Minimize2 className="h-4 w-4" aria-hidden /> : <Maximize2 className="h-4 w-4" aria-hidden />}
          {full ? 'Thoát full' : 'Full màn hình'}
        </Button>
        <span className="text-xs text-muted-foreground">{count} ô · mỗi ô 1 socket riêng</span>
      </div>

      <div
        className="grid min-h-0 flex-1 gap-2"
        style={{
          gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
          gridAutoRows: 'minmax(0, 1fr)',
        }}
      >
        {visible.map((email, i) => (
          <div key={i} className="min-h-0">
            {email ? (
              <ImpersonationPane email={email} onClose={() => clearSlot(i)} onMaximize={() => setMaximized(i)} />
            ) : (
              <SlotPicker users={users} loading={loadingUsers} onPick={(v) => setEmail(i, v)} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SlotPicker({
  users,
  loading,
  onPick,
}: {
  users: VirtualUserRow[];
  loading: boolean;
  onPick: (email: string) => void;
}) {
  return (
    <div className="flex h-full min-h-32 flex-col items-center justify-center gap-2 rounded border border-dashed border-border p-3 text-center">
      <p className="text-xs text-muted-foreground">Chọn virtual user</p>
      <Select onValueChange={(v) => onPick(v)}>
        <SelectTrigger className="h-9 w-full max-w-56 text-xs" aria-label="Chọn virtual user">
          <SelectValue placeholder={loading ? 'Đang tải…' : users.length === 0 ? 'Không có user' : '— chọn user —'} />
        </SelectTrigger>
        <SelectContent className="max-h-72">
          {users.map((u) => (
            <SelectItem key={u.email} value={u.email} className="text-xs">
              <span className="font-mono">#{u.index}</span> {u.email} <span className="text-muted-foreground">({u.phase})</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[10px] text-muted-foreground">
        {users.length === 0 && !loading ? 'Chưa có virtual user — chạy run trước, hoặc bấm LogIn ở trang Users.' : `${users.length} user (trang đầu)`}
      </p>
    </div>
  );
}
