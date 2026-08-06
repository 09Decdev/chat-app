/**
 * UsersPage — bảng virtual users (Màn 3 v1.1).
 * - Sort SERVER-side (whitelist backend /users?sortBy&sortDir) — 10k+ users.
 * - Filter: phase dropdown + search email (debounce 300ms).
 * - Virtualized: @tanstack/react-virtual + div overflow-auto (Radix ScrollArea
 *   không hợp với virtualizer — dùng div thường như ErrorListDialog).
 * - Poll 2.5s khi run ACTIVE (store isRunning) — dừng khi idle, không double-interval.
 * - Donut phase từ phaseCounts (API trả toàn bộ user, không theo filter).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, RefreshCw, Search, Users, Wifi, WifiOff } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RunStateBadge } from '@/components/loadtest/run-state-badge';
import { PhaseDonut } from '@/components/loadtest/phase-donut';
import { ACTION_COLORS, PHASE_COLORS } from '@/components/loadtest/chart-theme';
import {
  ACTION_STATE_LABELS,
  PHASE_LABELS,
  USER_PHASE_ORDER,
  slicesFromPhaseCounts,
  type PhaseSlice,
} from '@/components/loadtest/user-phases';
import { loadtestApi } from '@/lib/loadtest-api';
import { fmtCompact, fmtRelative } from '@/lib/loadtest-format';
import { useLoadtestStore } from '@/store/loadtest.store';
import { routes } from '@/lib/env';
import { cn } from '@/lib/utils';
import type { UserPhase, UserSortDir, UserSortField, VirtualUserRow } from '@/types/loadtest';

const PAGE_SIZE = 500; // cap server-side /users?limit=500
const POLL_MS = 2500;
const ROW_HEIGHT = 44;

/**
 * Danh sách cột DUY NHẤT (FIX-1) — header VÀ cell đều render từ đây, không khai báo 2 nơi
 * (trước đây sortable + static tách riêng → roomId/socket/reconnectCount/outbox/lastActionAt
 * render lệch cột so với header). Thứ tự = thứ tự hiển thị (khớp GRID_COLS).
 */
export type UsersColumnKey =
  | 'index' | 'email' | 'phase' | 'currentAction'
  | 'roomId' | 'socket' | 'reconnectCount' | 'outboxPending' | 'lastActionAt' | 'lastError';

export const USERS_COLUMNS: readonly { key: UsersColumnKey; label: string; sortable?: UserSortField }[] = [
  { key: 'index', label: '#', sortable: 'index' },
  { key: 'email', label: 'Email', sortable: 'email' },
  { key: 'phase', label: 'Phase', sortable: 'phase' },
  { key: 'currentAction', label: 'Action', sortable: 'currentAction' },
  { key: 'roomId', label: 'Room' },
  { key: 'socket', label: 'Socket' },
  { key: 'reconnectCount', label: 'Reconnect', sortable: 'reconnectCount' },
  { key: 'outboxPending', label: 'Outbox', sortable: 'outboxPending' },
  { key: 'lastActionAt', label: 'Hoạt động', sortable: 'lastActionAt' },
  { key: 'lastError', label: 'Lỗi gần nhất' },
];

const GRID_COLS = 'grid-cols-[56px_1.6fr_112px_104px_1fr_60px_80px_64px_110px_1.3fr]';

function badgeStyle(color: string): { color: string; backgroundColor: string } {
  return { color, backgroundColor: color.replace(')', ' / 0.15)') };
}

/** Trang đầu thay thế rows cũ; giữ các trang đã append phía sau (scroll ổn định khi poll). */
function mergeFirstPage(prev: VirtualUserRow[], fresh: VirtualUserRow[]): VirtualUserRow[] {
  if (prev.length <= fresh.length) return fresh;
  return [...fresh, ...prev.slice(fresh.length)];
}

function UserRowCell({
  col,
  row,
  now,
  actionLabel,
  actionColor,
}: {
  col: (typeof USERS_COLUMNS)[number];
  row: VirtualUserRow;
  now: number;
  actionLabel: string;
  actionColor: string | undefined;
}) {
  switch (col.key) {
    case 'index':
      return <span className="font-mono text-xs tabular-nums text-muted-foreground">{row.index}</span>;
    case 'email':
      return (
        <span className="truncate font-mono text-xs" title={row.email}>
          {row.email}
        </span>
      );
    case 'phase':
      return (
        <span>
          <span
            className="inline-flex items-center rounded-full border border-transparent px-2 py-0.5 text-xs font-medium"
            style={badgeStyle(PHASE_COLORS[row.phase])}
          >
            {PHASE_LABELS[row.phase]}
          </span>
        </span>
      );
    case 'currentAction':
      return row.currentAction ? (
        <span className="truncate text-xs">
          <span
            className="inline-flex items-center rounded-full border border-transparent px-2 py-0.5 text-xs font-medium"
            style={actionColor ? badgeStyle(actionColor) : { color: 'hsl(var(--muted-foreground))' }}
          >
            {actionLabel}
          </span>
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      );
    case 'roomId':
      return (
        <span className="truncate font-mono text-xs text-muted-foreground" title={row.roomId ?? undefined}>
          {row.roomId ?? '—'}
        </span>
      );
    case 'socket':
      return (
        <span className="flex items-center" title={row.socketConnected ? 'Socket đã kết nối' : 'Socket đã ngắt'}>
          {row.socketConnected ? (
            <Wifi className="h-4 w-4 text-success" aria-label="Socket đã kết nối" />
          ) : (
            <WifiOff className="h-4 w-4 text-muted-foreground" aria-label="Socket đã ngắt" />
          )}
        </span>
      );
    case 'reconnectCount':
      return <span className="font-mono text-xs tabular-nums">{row.reconnectCount}</span>;
    case 'outboxPending':
      return <span className="font-mono text-xs tabular-nums">{row.outboxPending}</span>;
    case 'lastActionAt':
      return (
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {fmtRelative(row.lastActionAt, now)}
        </span>
      );
    case 'lastError':
      return row.lastError ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="block cursor-help truncate font-mono text-xs text-destructive" tabIndex={0}>
              {row.lastError}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p className="break-words font-mono text-xs">{row.lastError}</p>
          </TooltipContent>
        </Tooltip>
      ) : (
        <span className="text-muted-foreground">—</span>
      );
  }
}

function UserRow({ row, now }: { row: VirtualUserRow; now: number }) {
  const actionLabel = row.currentAction ? ACTION_STATE_LABELS[row.currentAction] : '—';
  const actionColor = row.currentAction && row.currentAction !== 'idle' ? ACTION_COLORS[row.currentAction] : undefined;
  return (
    <div
      className={cn('grid w-full items-center gap-2 border-b border-border px-3 text-sm', GRID_COLS)}
      style={{ height: ROW_HEIGHT }}
      role="row"
    >
      {USERS_COLUMNS.map((col) => (
        <UserRowCell key={col.key} col={col} row={row} now={now} actionLabel={actionLabel} actionColor={actionColor} />
      ))}
    </div>
  );
}

export default function UsersPage() {
  const navigate = useNavigate();
  const phase = useLoadtestStore((s) => s.phase);
  const isRunning = useLoadtestStore((s) => s.isRunning);
  const runId = useLoadtestStore((s) => s.runId);

  const [rows, setRows] = useState<VirtualUserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [phaseCounts, setPhaseCounts] = useState<Partial<Record<UserPhase, number>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState('');
  const [phaseFilter, setPhaseFilter] = useState<'all' | UserPhase>('all');
  const [sortBy, setSortBy] = useState<UserSortField>('index');
  const [sortDir, setSortDir] = useState<UserSortDir>('asc');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const parentRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<number | null>(null);
  const nowRef = useRef(Date.now());
  /** FIX-3: seq tăng dần mỗi request — response cũ (poll chậm) bị bỏ, không ghi đè rows mới. */
  const reqSeqRef = useRef(0);
  nowRef.current = Date.now();

  // Debounce search 300ms
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(t);
  }, [search]);

  const fetchPage = useCallback(
    async (offset: number, append: boolean) => {
      const seq = ++reqSeqRef.current;
      if (offset === 0 && !append) setLoading(true);
      try {
        const res = await loadtestApi.users({
          offset,
          limit: PAGE_SIZE,
          filter: debouncedSearch || undefined,
          phase: phaseFilter === 'all' ? undefined : phaseFilter,
          sortBy,
          sortDir,
        });
        if (seq !== reqSeqRef.current) return; // stale — request mới hơn đã gửi
        setError(false);
        setTotal(res.total);
        setPhaseCounts(res.phaseCounts ?? {});
        setRows((prev) => {
          if (!append) return res.rows;
          if (res.offset === 0) return mergeFirstPage(prev, res.rows);
          const next = [...prev];
          for (let i = 0; i < res.rows.length; i++) next[res.offset + i] = res.rows[i];
          return next;
        });
      } catch {
        if (seq !== reqSeqRef.current) return;
        setError(true);
        // giữ dữ liệu cũ — poll sau tự phục hồi (không toast spam khi server offline)
      } finally {
        if (seq === reqSeqRef.current) setLoading(false);
      }
    },
    [debouncedSearch, phaseFilter, sortBy, sortDir],
  );

  // Reset + fetch khi sort/filter đổi (kể cả mount)
  useEffect(() => {
    setRows([]);
    setTotal(0);
    void fetchPage(0, false);
  }, [fetchPage]);

  // Poll 2.5s khi run active — dừng khi idle; không double-interval (ref pattern app-shell)
  useEffect(() => {
    if (!isRunning) {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current !== null) return;
    pollRef.current = window.setInterval(() => {
      void fetchPage(0, true);
    }, POLL_MS);
    return () => {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [isRunning, fetchPage]);

  const onSort = (key: UserSortField) => {
    if (sortBy === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(key);
      setSortDir('asc');
    }
  };

  // Infinite scroll: gần cuối → fetch trang kế (append) — 10k+ rows qua nhiều page
  const onScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el || loading || rows.length >= total) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 240) {
      void fetchPage(rows.length, true);
    }
  }, [fetchPage, loading, rows.length, total]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const donutSlices: PhaseSlice[] = useMemo(() => slicesFromPhaseCounts(phaseCounts), [phaseCounts]);
  const noRunYet = phase === 'idle' && !isRunning && rows.length === 0 && !loading;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Users className="h-5 w-5" aria-hidden /> VIRTUAL USERS
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {isRunning ? (
              <>
                Run <span className="font-mono">{runId || '—'}</span> đang chạy — tự làm mới mỗi {POLL_MS / 1000}s
              </>
            ) : rows.length > 0 || total > 0 ? (
              'Run đã kết thúc — dữ liệu cuối cùng'
            ) : (
              'Chưa có run nào'
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <RunStateBadge phase={phase} />
          <Badge variant="secondary" className="font-mono tabular-nums">
            {fmtCompact(total)} users
          </Badge>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-10"
            disabled={loading}
            onClick={() => void fetchPage(0, false)}
            aria-label="Làm mới danh sách user"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden />
            Làm mới
          </Button>
        </div>
      </div>

      {/* Phase distribution + filter */}
      <div className="grid gap-4 lg:grid-cols-12">
        <Card className="p-4 lg:col-span-5">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-base font-medium">PHÂN BỐ THEO PHASE</h3>
            <Badge variant="secondary">toàn bộ run</Badge>
          </div>
          <div className="h-44">
            <PhaseDonut slices={donutSlices} centerLabel="users" />
          </div>
        </Card>
        <Card className="p-4 lg:col-span-7">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative min-w-52 flex-1">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Tìm email..."
                className="pl-8"
                aria-label="Tìm theo email"
              />
            </div>
            <Select value={phaseFilter} onValueChange={(v) => setPhaseFilter(v as 'all' | UserPhase)}>
              <SelectTrigger className="h-10 w-44" aria-label="Lọc theo phase">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tất cả phase</SelectItem>
                {USER_PHASE_ORDER.map((p) => (
                  <SelectItem key={p} value={p}>
                    {PHASE_LABELS[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Badge variant="outline" className="font-mono tabular-nums">
              {fmtCompact(rows.length)}/{fmtCompact(total)}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Bấm tiêu đề cột để sort (server-side, 10k+ users) — click lại để đảo asc/desc.
          </p>
        </Card>
      </div>

      {/* Bảng virtualized */}
      <Card className="overflow-hidden">
        {noRunYet ? (
          <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 text-center">
            <p className="text-sm text-muted-foreground">Chưa có run nào — virtual users chỉ xuất hiện khi chạy run.</p>
            <Button size="lg" className="min-h-12" onClick={() => navigate(routes.loadtest)}>
              Đi tới Cấu hình
            </Button>
          </div>
        ) : (
          <>
            {error && (
              <div
                role="alert"
                className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive"
              >
                <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden />
                Không lấy được danh sách user — kiểm tra server
              </div>
            )}
            {/* FIX-6: header + rows CÙNG 1 scroll container (overflow-auto) — cuộn ngang
                mobile (<lg, grid ~586px) kéo cả header lẫn body, cột không lệch nhau.
                Header sticky top-0 trong chính container đó; virtualizer dùng container này. */}
            <div
              ref={parentRef}
              onScroll={onScroll}
              className="h-[62vh] overflow-auto"
              role="table"
              aria-label="Danh sách virtual users"
            >
              {/* Header bảng (sticky trong scroll container — render từ USERS_COLUMNS, khớp cell) */}
              <div
                role="row"
                className={cn('sticky top-0 z-10 grid items-center gap-2 border-b border-border bg-muted/60 px-3 text-xs font-medium text-muted-foreground backdrop-blur', GRID_COLS)}
                style={{ height: 36 }}
              >
                {USERS_COLUMNS.map((col) =>
                  col.sortable ? (
                    <button
                      key={col.key}
                      type="button"
                      onClick={() => onSort(col.sortable!)}
                      aria-sort={sortBy === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                      className={cn(
                        'inline-flex min-h-8 items-center gap-1 rounded px-1 text-left font-medium transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        sortBy === col.key && 'text-foreground',
                      )}
                    >
                      {col.label}
                      {sortBy === col.key &&
                        (sortDir === 'asc' ? (
                          <ArrowUp className="h-3 w-3" aria-hidden />
                        ) : (
                          <ArrowDown className="h-3 w-3" aria-hidden />
                        ))}
                    </button>
                  ) : (
                    <span
                      key={col.key}
                      className={cn('truncate', col.key === 'socket' && 'text-center')}
                      title={col.key === 'socket' ? 'Socket connected' : undefined}
                    >
                      {col.label}
                    </span>
                  ),
                )}
              </div>
              {loading && rows.length === 0 ? (
                <div className="space-y-2 p-3">
                  {[...Array(8)].map((_, i) => (
                    <Skeleton key={i} className="h-9 w-full" />
                  ))}
                </div>
              ) : rows.length === 0 ? (
                <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
                  {error
                    ? 'Không lấy được danh sách user — kiểm tra server'
                    : isRunning
                      ? 'Chưa có user nào — đang provisioning/connect...'
                      : 'Không có user phù hợp bộ lọc'}
                </div>
              ) : (
                <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                  {virtualizer.getVirtualItems().map((item) => (
                    <div
                      key={item.key}
                      className="absolute left-0 top-0 w-full"
                      style={{ height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
                      role="rowgroup"
                    >
                      <UserRow row={rows[item.index]} now={nowRef.current} />
                    </div>
                  ))}
                </div>
              )}
              {rows.length > 0 && rows.length < total && (
                <div className="sticky bottom-0 border-t border-border bg-background/80 px-3 py-1.5 text-center text-xs text-muted-foreground backdrop-blur">
                  Cuộn xuống để nạp thêm ({fmtCompact(rows.length)}/{fmtCompact(total)})
                </div>
              )}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
