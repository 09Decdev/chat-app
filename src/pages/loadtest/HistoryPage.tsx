import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Eye, GitCompare, RotateCw, Search, Trash2 } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { RunStatusBadge } from '@/components/loadtest/run-status-badge';
import { loadtestApi, toApiError } from '@/lib/loadtest-api';
import { fmtClock, fmtCompact, fmtDateTime } from '@/lib/loadtest-format';
import { routes } from '@/lib/env';
import { cn } from '@/lib/utils';
import type { LoadtestRunSummary } from '@/types/loadtest';

const STATUS_OPTIONS = [
  { value: 'all', label: 'Tất cả trạng thái' },
  { value: 'running', label: 'Running' },
  { value: 'finished', label: 'Finished' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'error', label: 'Error' },
] as const;

// F4 — trend metric qua các run (chỉ plot run có summary — đã terminal).
type TrendKey = 'successRate' | 'echoRate' | 'throughputPeak' | 'actionsTotal';
const TREND_METRICS: { key: TrendKey; label: string; fmt: (v: number) => string }[] = [
  { key: 'successRate', label: 'Success %', fmt: (v) => v.toFixed(1) },
  { key: 'echoRate', label: 'Echo %', fmt: (v) => v.toFixed(1) },
  { key: 'throughputPeak', label: 'Throughput peak', fmt: (v) => fmtCompact(v) },
  { key: 'actionsTotal', label: 'Actions total', fmt: (v) => fmtCompact(v) },
];
function trendFmt(key: TrendKey): (v: number) => string {
  return TREND_METRICS.find((m) => m.key === key)?.fmt ?? String;
}
function metricValue(s: LoadtestRunSummary['summary'], key: TrendKey): number {
  if (!s) return 0;
  return s[key] ?? 0;
}

/** Màn 8 — Lịch sử run (PRD D2): list từ DB + filter status + search runId + xóa. */
export default function HistoryPage() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<LoadtestRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<LoadtestRunSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  // F4 — chọn 2 run để compare + metric cho trend chart.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [trendMetric, setTrendMetric] = useState<TrendKey>('successRate');

  const toggleSelect = useCallback((id: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) {
        n.delete(id);
      } else {
        if (n.size >= 2) n.clear(); // max 2 — chọn thứ 3 reset (tránh lẫn)
        n.add(id);
      }
      return n;
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await loadtestApi.listRuns(statusFilter === 'all' ? {} : { status: statusFilter });
      setRuns(res.runs);
    } catch (e) {
      setError(toApiError(e).message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return runs;
    return runs.filter((r) => r.runId.toLowerCase().includes(q));
  }, [runs, search]);

  // F4 — trend data: chỉ run có summary (terminal), sort theo thời gian.
  const trendData = useMemo(
    () =>
      filtered
        .filter((r) => r.summary)
        .map((r) => ({ runId: r.runId, t: r.startAt, v: metricValue(r.summary, trendMetric) }))
        .sort((a, b) => a.t - b.t),
    [filtered, trendMetric],
  );

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await loadtestApi.deleteRun(deleteTarget.runId);
      toast.success(`Đã xóa run ${deleteTarget.runId}`);
      setDeleteTarget(null);
      void load();
    } catch (e) {
      toast.error(toApiError(e).message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-base font-semibold">LỊCH SỬ RUN</h1>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="min-h-10"
            disabled={selected.size !== 2}
            onClick={() => navigate(`/loadtest/compare?ids=${encodeURIComponent([...selected].join(','))}`)}
            aria-label="So sánh 2 run đã chọn"
          >
            <GitCompare className="h-4 w-4" aria-hidden /> So sánh{selected.size > 0 ? ` (${selected.size}/2)` : ''}
          </Button>
          <Button variant="outline" size="sm" className="min-h-10" onClick={() => void load()} disabled={loading}>
            <RotateCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
            Làm mới
          </Button>
        </div>
      </div>

      <Card className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              type="search"
              placeholder="Tìm theo runId..."
              aria-label="Tìm theo runId"
              className="pl-9"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-full sm:w-48" aria-label="Lọc theo trạng thái">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Card>

      {trendData.length >= 2 && (
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">XU HƯỚNG ({trendData.length} run có summary)</h2>
            <Select value={trendMetric} onValueChange={(v) => setTrendMetric(v as TrendKey)}>
              <SelectTrigger className="w-44" aria-label="Metric xu hướng">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TREND_METRICS.map((m) => (
                  <SelectItem key={m.key} value={m.key}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="h-48" role="img" aria-label={`Xu hướng ${trendMetric} qua các run`}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trendData} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="t"
                  tickFormatter={(t: number) => new Date(t).toLocaleDateString()}
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={11}
                  tickMargin={4}
                />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} width={48} />
                <Tooltip
                  labelFormatter={(t: number) => new Date(t).toLocaleString()}
                  formatter={(v) => trendFmt(trendMetric)(Number(v))}
                />
                <Line type="monotone" dataKey="v" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {error && (
        <AlertBanner
          variant="destructive"
          title="Không tải được lịch sử run"
          description={error}
          action={{ label: 'Thử lại', onClick: () => void load() }}
        />
      )}

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card className="flex min-h-[40vh] flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {runs.length === 0 ? 'Chưa có run nào — chạy loadtest đầu tiên từ Control Panel.' : 'Không tìm thấy run khớp bộ lọc.'}
          </p>
          <Button size="lg" className="min-h-12" onClick={() => navigate(routes.loadtest)}>
            Đi tới Cấu hình
          </Button>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Trạng thái</TableHead>
                <TableHead scope="col">runId</TableHead>
                <TableHead scope="col">Bắt đầu</TableHead>
                <TableHead scope="col" className="text-right">
                  Thời lượng
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Target
                </TableHead>
                <TableHead scope="col">Gateway</TableHead>
                <TableHead scope="col">Lý do dừng</TableHead>
                <TableHead scope="col" className="text-right">
                  Thao tác
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => (
                <TableRow key={r.runId} className="cursor-pointer" onClick={() => navigate(`/loadtest/history/${encodeURIComponent(r.runId)}`)}>
                  <TableCell>
                    <RunStatusBadge status={r.status} />
                  </TableCell>
                  <TableCell className="font-mono text-xs tracking-tight">{r.runId}</TableCell>
                  <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">{fmtDateTime(r.startAt)}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {r.durationSec != null ? fmtClock(r.durationSec) : '--'}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{fmtCompact(r.targetUsers)}</TableCell>
                  <TableCell className="max-w-40 truncate font-mono text-xs text-muted-foreground">{r.gatewayUrl}</TableCell>
                  <TableCell className="max-w-48 truncate text-xs text-muted-foreground">{r.stopReason ?? '—'}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className={cn('h-11 w-11', selected.has(r.runId) && 'bg-primary/15 text-primary')}
                        aria-label={`Chọn ${r.runId} để so sánh`}
                        aria-pressed={selected.has(r.runId)}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSelect(r.runId);
                        }}
                      >
                        <GitCompare className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-11 w-11"
                        aria-label={`Xem chi tiết run ${r.runId}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/loadtest/history/${encodeURIComponent(r.runId)}`);
                        }}
                      >
                        <Eye className="h-4 w-4" aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-11 w-11 text-destructive hover:text-destructive"
                        aria-label={`Xóa run ${r.runId}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTarget(r);
                        }}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Dialog open={deleteTarget !== null} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">XÓA RUN?</DialogTitle>
            <DialogDescription>
              Run <span className="font-mono text-xs">{deleteTarget?.runId}</span> sẽ bị xóa vĩnh viễn cùng metrics và logs. Không thể hoàn tác.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" className="min-h-11" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Hủy
            </Button>
            <Button variant="destructive" className="min-h-11" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting ? 'Đang xóa...' : 'Xóa run'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <span className="text-xs text-muted-foreground">
        {filtered.length} / {runs.length} run
      </span>
    </div>
  );
}