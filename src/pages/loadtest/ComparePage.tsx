import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RunStatusBadge } from '@/components/loadtest/run-status-badge';
import { loadtestApi, toApiError } from '@/lib/loadtest-api';
import { fmtClock, fmtCompact, fmtMs, fmtNum } from '@/lib/loadtest-format';
import { routes } from '@/lib/env';
import { cn } from '@/lib/utils';
import type { LoadtestRunDetail, RunReport } from '@/types/loadtest';

interface MetricRow {
  label: string;
  a: number | null;
  b: number | null;
  fmt: (v: number) => string;
  better: 'low' | 'high';
  unit?: string;
}

/** Format delta (B−A) — fmtClock (Duration) clamp âm về 0 nên dùng abs + sign riêng. */
function fmtDelta(m: MetricRow, delta: number): string {
  const abs = Math.abs(delta);
  const val = m.label === 'Duration' ? fmtClock(Math.round(abs)) : m.fmt(abs);
  return `${delta > 0 ? '+' : delta < 0 ? '-' : ''}${val}`;
}

/** F4 — So sánh 2 run: metric summary + latency per-action cạnh nhau. */
export default function ComparePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const ids = params.get('ids')?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  const [a, setA] = useState<LoadtestRunDetail | null>(null);
  const [b, setB] = useState<LoadtestRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ids.length !== 2) {
      setError('Cần đúng 2 run để so sánh (?ids=A,B) — chọn từ trang Lịch sử.');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([loadtestApi.getRun(ids[0]), loadtestApi.getRun(ids[1])])
      .then(([ra, rb]) => {
        if (cancelled) return;
        setA(ra);
        setB(rb);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(toApiError(e).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // ids từ URL — chỉ re-fetch khi search params đổi.
  }, [params]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !a || !b) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
        <p className="text-sm text-muted-foreground">{error ?? 'Không tải được run để so sánh.'}</p>
        <Button className="min-h-12" onClick={() => navigate(routes.loadtestHistory)}>
          Về lịch sử run
        </Button>
      </div>
    );
  }

  const sa = a.report?.summary ?? null;
  const sb = b.report?.summary ?? null;

  const metrics: MetricRow[] = [
    { label: 'Success rate', a: sa?.successRate ?? null, b: sb?.successRate ?? null, fmt: (v) => v.toFixed(1), better: 'high', unit: '%' },
    { label: 'Echo rate', a: sa?.echoRate ?? null, b: sb?.echoRate ?? null, fmt: (v) => v.toFixed(1), better: 'high', unit: '%' },
    { label: 'Throughput peak', a: sa?.throughputPeak ?? null, b: sb?.throughputPeak ?? null, fmt: fmtCompact, better: 'high', unit: ' act/s' },
    { label: 'Throughput avg', a: sa?.throughputAvg ?? null, b: sb?.throughputAvg ?? null, fmt: fmtCompact, better: 'high', unit: ' act/s' },
    { label: 'Actions total', a: sa?.actionsTotal ?? null, b: sb?.actionsTotal ?? null, fmt: fmtCompact, better: 'high' },
    { label: 'Connect max', a: sa?.usersConnectedMax ?? null, b: sb?.usersConnectedMax ?? null, fmt: fmtCompact, better: 'high' },
    { label: 'Queue peak', a: sa?.queueCountPeak ?? null, b: sb?.queueCountPeak ?? null, fmt: fmtCompact, better: 'low' },
    { label: 'Reconnect', a: sa?.reconnectCount ?? null, b: sb?.reconnectCount ?? null, fmt: fmtNum, better: 'low' },
    { label: 'Users lost %', a: sa?.usersLostPct ?? null, b: sb?.usersLostPct ?? null, fmt: (v) => v.toFixed(1), better: 'low', unit: '%' },
    { label: 'Duration', a: a.durationSec ?? null, b: b.durationSec ?? null, fmt: (v) => fmtClock(Math.round(v)), better: 'low' },
  ];

  const actionUnion = Array.from(
    new Set([...(a.report?.perAction ?? []).map((x) => x.action), ...(b.report?.perAction ?? []).map((x) => x.action)]),
  );
  const findAction = (r: RunReport | null, action: string) => r?.perAction.find((x) => x.action === action);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" className="min-h-10" onClick={() => navigate(routes.loadtestHistory)}>
          <ArrowLeft className="h-4 w-4" aria-hidden /> Lịch sử
        </Button>
        <h1 className="text-base font-semibold">SO SÁNH 2 RUN</h1>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <RunHead detail={a} tag="A" />
        <RunHead detail={b} tag="B" />
      </div>

      {(!sa || !sb) && (
        <AlertBanner
          variant="warning"
          title="Thiếu report"
          description="Một hoặc cả hai run chưa có report (đang chạy / chưa finalize) — chỉ so sánh metric có sẵn."
        />
      )}

      <Card className="overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Metric</TableHead>
              <TableHead scope="col" className="text-right">Run A</TableHead>
              <TableHead scope="col" className="text-right">Run B</TableHead>
              <TableHead scope="col" className="text-right">Chênh (B−A)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {metrics.map((m) => {
              const delta = m.a != null && m.b != null ? m.b - m.a : null;
              const bBetter =
                delta != null && ((m.better === 'high' && delta > 0) || (m.better === 'low' && delta < 0));
              const bWorse =
                delta != null && ((m.better === 'high' && delta < 0) || (m.better === 'low' && delta > 0));
              return (
                <TableRow key={m.label}>
                  <TableCell className="text-sm">{m.label}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {m.a != null ? `${m.fmt(m.a)}${m.unit ?? ''}` : '—'}
                  </TableCell>
                  <TableCell
                    className={cn(
                      'text-right font-mono text-xs tabular-nums',
                      bBetter && 'text-success',
                      bWorse && 'text-destructive',
                    )}
                  >
                    {m.b != null ? `${m.fmt(m.b)}${m.unit ?? ''}` : '—'}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {delta != null ? fmtDelta(m, delta) : '—'}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>

      <Card className="overflow-hidden">
        <h2 className="border-b border-border p-4 text-sm font-medium">LATENCY P50/P95 THEO ACTION</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">action</TableHead>
              <TableHead scope="col" className="text-right">A p50</TableHead>
              <TableHead scope="col" className="text-right">A p95</TableHead>
              <TableHead scope="col" className="text-right">B p50</TableHead>
              <TableHead scope="col" className="text-right">B p95</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {actionUnion.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                  Không có dữ liệu per-action.
                </TableCell>
              </TableRow>
            ) : (
              actionUnion.map((action) => {
                const aa = findAction(a.report, action);
                const bb = findAction(b.report, action);
                return (
                  <TableRow key={action}>
                    <TableCell className="font-mono text-xs">{action}</TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">{aa ? fmtMs(aa.p50Ms) : '—'}</TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">{aa ? fmtMs(aa.p95Ms) : '—'}</TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">{bb ? fmtMs(bb.p50Ms) : '—'}</TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">{bb ? fmtMs(bb.p95Ms) : '—'}</TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

function RunHead({ detail, tag }: { detail: LoadtestRunDetail; tag: 'A' | 'B' }) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="font-mono">{tag}</Badge>
        <span className="font-mono text-xs tracking-tight">{detail.runId}</span>
        <RunStatusBadge status={detail.status} />
      </div>
      <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
        {fmtCompact(detail.targetUsers)} target · {detail.workerCount} worker
        {detail.durationSec != null ? ` · ${fmtClock(detail.durationSec)}` : ''}
      </p>
    </Card>
  );
}
