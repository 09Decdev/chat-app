import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { loadtestApi, toApiError } from '@/lib/loadtest-api';
import { fmtClock, fmtCompact, fmtDateTime, fmtMs, fmtNum, fmtRange } from '@/lib/loadtest-format';
import { routes } from '@/lib/env';
import type { BottleneckCandidate, RunReport } from '@/types/loadtest';
import { cn } from '@/lib/utils';

function statusBadge(status: RunReport['status']): 'success' | 'warning' | 'destructive' {
  return status === 'finished' ? 'success' : status === 'stopped' ? 'warning' : 'destructive';
}

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xs tabular-nums tracking-tight text-foreground">{value}</dd>
    </div>
  );
}

/** EvidenceDialog: LineChart vùng nghi vấn + ReferenceArea (UI-SPEC Màn 5). */
function EvidenceDialog({
  open,
  onOpenChange,
  candidate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  candidate: BottleneckCandidate | null;
}) {
  const data = useMemo(() => {
    if (!candidate) return [];
    return candidate.evidence.map((e) => ({ ts: e.ts, value: e.value, threshold: e.threshold }));
  }, [candidate]);
  const minTs = data.length > 0 ? Math.min(...data.map((d) => d.ts)) : 0;
  const maxTs = data.length > 0 ? Math.max(...data.map((d) => d.ts)) : 0;
  const threshold = data.find((d) => d.threshold !== undefined)?.threshold;
  const hasThreshold = threshold !== undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-base">BẰNG CHỨNG VÙNG NGHI VẤN</DialogTitle>
        </DialogHeader>
        {data.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Không có dữ liệu bằng chứng cho candidate này.</p>
        ) : (
          <>
            <p className="text-sm">{candidate?.title}</p>
            <div className="h-56 w-full" role="img" aria-label={`Biểu đồ bằng chứng ${candidate?.title ?? ''}`}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="hsl(var(--border))" strokeWidth={1} vertical={false} />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    scale="time"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={(v: number) => fmtDateTime(v)}
                    tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
                    minTickGap={40}
                    stroke="hsl(var(--border))"
                  />
                  <YAxis width={48} tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} stroke="hsl(var(--border))" />
                  <Tooltip
                    content={({ active, payload, label }) =>
                      active && payload?.length ? (
                        <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
                          <p className="font-mono tabular-nums">{fmtDateTime(Number(label))}</p>
                          {payload.map((p) => (
                            <p key={String(p.dataKey)} className="tabular-nums">
                              {String(p.name)}: {Number(p.value).toFixed(2)}
                            </p>
                          ))}
                        </div>
                      ) : null
                    }
                  />
                  <ReferenceArea x1={minTs} x2={maxTs} fill="hsl(var(--warning) / 0.08)" stroke="hsl(var(--warning))" strokeDasharray="4 4" />
                  {hasThreshold && (
                    <ReferenceLine
                      y={threshold}
                      stroke="hsl(var(--destructive))"
                      strokeDasharray="6 4"
                      label={{ value: 'ngưỡng', fill: 'hsl(var(--destructive))', fontSize: 11 }}
                    />
                  )}
                  <Line
                    type="monotone"
                    dataKey="value"
                    name="giá trị"
                    stroke="hsl(var(--chart-1))"
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="text-xs text-muted-foreground">
              Vùng nghi vấn được đánh dấu {hasThreshold ? 'và đường ngưỡng' : ''} — dữ liệu từ tick 1s của run.
            </p>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function ReportPage() {
  const navigate = useNavigate();
  const [report, setReport] = useState<RunReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceIdx, setEvidenceIdx] = useState(0);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadtestApi
      .report()
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(toApiError(e).message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const doExport = async (format: 'json' | 'md' | 'csv') => {
    try {
      setExporting(true);
      await loadtestApi.downloadReport(format, report?.runId);
      toast.success(`Đã xuất report-${report?.runId ?? ''}.${format}`);
    } catch (e) {
      toast.error(toApiError(e).message);
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Skeleton className="h-5 w-40" /> Đang tổng hợp (≤ 30s)...
        </div>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error && !report) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button size="lg" className="min-h-12" onClick={() => navigate(routes.loadtest)}>
          Chạy run đầu tiên
        </Button>
      </div>
    );
  }

  if (!report) return null;

  const { summary } = report;
  const candidate = report.bottlenecks[evidenceIdx] ?? null;

  return (
    <div className="space-y-4">
      {report.status !== 'finished' && (
        <AlertBanner
          variant="warning"
          title="Số liệu partial — run bị dừng thủ công (kill-switch)"
          description={report.stopReason ? `Lý do: ${report.stopReason}` : undefined}
        />
      )}

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-base font-semibold">
            BÁO CÁO: <span className="font-mono text-xs tracking-tight">{report.runId}</span>
          </h1>
          <Badge variant={statusBadge(report.status)}>{report.status}</Badge>
          <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
            {fmtRange(report.startAt, report.endAt)} ({Math.round(report.durationSec / 60)} phút) · thực tế {fmtClock(report.durationSec)}
          </span>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard title="User đã tạo" value={fmtNum(summary.usersCreated)} />
        <StatCard title="Connect max" value={fmtCompact(summary.usersConnectedMax)} />
        <StatCard title="Active max" value={fmtCompact(summary.usersActiveMax)} />
        <StatCard title="Actions" value={fmtCompact(summary.actionsTotal)} />
        <StatCard title="Success" value={summary.successRate.toFixed(1)} unit="%" variant={summary.successRate >= 97 ? 'success' : 'warning'} />
        <StatCard title="Throughput đỉnh" value={fmtCompact(summary.throughputPeak)} unit="act/s" />
      </div>

      <div className="grid gap-4 lg:grid-cols-12">
        <Card className="p-4 lg:col-span-7">
          <h2 className="mb-2 text-base font-medium">LATENCY P50/P95/P99 THEO ACTION</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">action</TableHead>
                <TableHead scope="col" className="text-right">p50</TableHead>
                <TableHead scope="col" className="text-right">p95</TableHead>
                <TableHead scope="col" className="text-right">p99</TableHead>
                <TableHead scope="col" className="text-right">success</TableHead>
                <TableHead scope="col" className="text-right">count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.perAction.map((a) => (
                <TableRow key={a.action}>
                  <TableCell className="font-mono text-xs">{a.action}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{fmtMs(a.p50Ms)}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{fmtMs(a.p95Ms)}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{fmtMs(a.p99Ms)}</TableCell>
                  <TableCell className={cn('text-right font-mono text-xs tabular-nums', a.successRate < 95 ? 'text-destructive' : 'text-foreground')}>
                    {a.successRate.toFixed(1)}%
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{fmtCompact(a.count)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>

        <Card className="p-4 lg:col-span-5">
          <h2 className="mb-2 text-base font-medium">BOTTLENECK CANDIDATES</h2>
          {report.bottlenecks.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Không phát hiện bottleneck</p>
          ) : (
            <div className="space-y-3">
              {report.bottlenecks.map((b, i) => (
                <div key={i} className="rounded-lg border border-border p-3">
                  <Badge variant={b.level === 'High' ? 'destructive' : b.level === 'Med' ? 'warning' : 'secondary'} className="mb-1">
                    {b.level}
                  </Badge>
                  <p className="text-sm">{b.title}</p>
                  <p className="text-xs text-muted-foreground">→ {b.detail}</p>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-9 px-0"
                    onClick={() => {
                      setEvidenceIdx(i);
                      setEvidenceOpen(true);
                    }}
                  >
                    Xem bằng chứng &gt;
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card className="p-4">
        <h2 className="mb-2 text-base font-medium">CẤU HÌNH RUN (snapshot)</h2>
        <dl className="grid gap-x-6 md:grid-cols-2">
          <KeyValue label="Target" value={fmtNum(report.config.targetUsers)} />
          <KeyValue label="Ramp" value={`${report.config.rampRate}/s (${report.config.rampMode})`} />
          <KeyValue label="Duration" value={`${report.config.durationMin} phút`} />
          <KeyValue
            label="Profile"
            value={`chat ${report.config.profile.chat} / read ${report.config.profile.read} / comment ${report.config.profile.comment} / like ${report.config.profile.like}`}
          />
          <KeyValue label="Gateway" value={report.config.gatewayUrl} />
          <KeyValue label="Workers" value={`${report.config.workerCount} (${report.config.socketsPerWorker} socket/worker)`} />
        </dl>
      </Card>

      <Card className="p-4">
        <h2 className="mb-2 text-base font-medium">EXPORT</h2>
        <div className="flex flex-wrap items-center gap-2">
          {(['json', 'md', 'csv'] as const).map((f) => (
            <Button
              key={f}
              variant="outline"
              className="min-h-11"
              disabled={exporting}
              onClick={() => void doExport(f)}
            >
              {f === 'md' ? 'Markdown' : f.toUpperCase()}
            </Button>
          ))}
          <span className="text-xs text-muted-foreground">Lưu trữ 30 ngày theo runId</span>
        </div>
      </Card>

      <div className="fixed inset-x-0 bottom-16 z-30 border-t border-border bg-background/80 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:bottom-0">
        <Button variant="outline" className="w-full min-h-12" onClick={() => navigate(routes.loadtestCleanup)}>
          Dọn dẹp dữ liệu test &gt;
        </Button>
      </div>

      <EvidenceDialog
        open={evidenceOpen}
        onOpenChange={setEvidenceOpen}
        candidate={candidate}
      />
    </div>
  );
}
