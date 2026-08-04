import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ChartCard } from '@/components/loadtest/chart-card';
import {
  ActionsStackedAreaChart,
  ConnectionsLineChart,
  LatencyLineChart,
  RangeSelect,
  type RangeKey,
} from '@/components/loadtest/charts';
import { RunStatusBadge } from '@/components/loadtest/run-status-badge';
import { loadtestApi, toApiError } from '@/lib/loadtest-api';
import { fmtClock, fmtCompact, fmtDateTime, fmtMs, fmtNum } from '@/lib/loadtest-format';
import { routes } from '@/lib/env';
import { cn } from '@/lib/utils';
import type { LoadtestLogEvent, LoadtestRunDetail, LoadTestTick } from '@/types/loadtest';

const LOG_LEVELS = [
  { value: 'all', label: 'Tất cả level' },
  { value: 'info', label: 'info' },
  { value: 'warn', label: 'warn' },
  { value: 'error', label: 'error' },
] as const;

function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xs tabular-nums tracking-tight text-foreground">{value}</dd>
    </div>
  );
}

/** Màn 9 — Run Detail (Replay) (PRD D3): KPI summary + chart từ metric_samples + logs từ DB. */
export default function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<LoadtestRunDetail | null>(null);
  const [ticks, setTicks] = useState<LoadTestTick[]>([]);
  const [logs, setLogs] = useState<LoadtestLogEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<RangeKey>('all');
  const [logLevel, setLogLevel] = useState<string>('all');

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    setTicks([]);
    setLogs([]);
    Promise.all([loadtestApi.getRun(runId), loadtestApi.getRunMetrics(runId), loadtestApi.getRunLogs(runId)])
      .then(([d, m, l]) => {
        if (cancelled) return;
        setDetail(d);
        setTicks(m.ticks);
        setLogs(l.logs);
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
  }, [runId]);

  const visibleLogs = useMemo(() => {
    if (logLevel === 'all') return logs;
    return logs.filter((l) => l.level === logLevel);
  }, [logs, logLevel]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error && !detail) {
    return (
      <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 text-center">
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button size="lg" className="min-h-12" onClick={() => navigate(routes.loadtestHistory)}>
          Về lịch sử run
        </Button>
      </div>
    );
  }

  if (!detail) return null;

  const report = detail.report;
  const summary = report?.summary;
  const isLive = detail.status === 'running';
  const hasTicks = ticks.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" className="min-h-10" onClick={() => navigate(routes.loadtestHistory)}>
          <ArrowLeft className="h-4 w-4" aria-hidden /> Lịch sử
        </Button>
        <h1 className="text-base font-semibold">
          RUN: <span className="font-mono text-xs tracking-tight">{detail.runId}</span>
        </h1>
        <RunStatusBadge status={detail.status} />
        <Badge variant={isLive ? 'success' : 'secondary'} className={isLive ? 'motion-safe:animate-pulse' : ''}>
          {isLive ? 'LIVE' : 'HISTORY'}
        </Badge>
        <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
          {fmtDateTime(detail.startAt)}
          {detail.endAt ? ` – ${fmtDateTime(detail.endAt)}` : ''}
          {detail.durationSec != null ? ` · ${fmtClock(detail.durationSec)}` : ''}
        </span>
      </div>

      {!isLive && detail.stopReason && (
        <AlertBanner variant="warning" title="Run kết thúc" description={detail.stopReason} />
      )}

      <Tabs defaultValue="overview">
        <TabsList aria-label="Chi tiết run">
          <TabsTrigger value="overview">Tổng quan</TabsTrigger>
          <TabsTrigger value="report">Báo cáo</TabsTrigger>
          <TabsTrigger value="logs">Logs ({logs.length})</TabsTrigger>
        </TabsList>

        {/* ─── Tổng quan: KPI + chart replay ─── */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <StatCard title="User đã tạo" value={summary ? fmtNum(summary.usersCreated) : '--'} />
            <StatCard title="Connect max" value={summary ? fmtCompact(summary.usersConnectedMax) : '--'} />
            <StatCard title="Active max" value={summary ? fmtCompact(summary.usersActiveMax) : '--'} />
            <StatCard title="Actions" value={summary ? fmtCompact(summary.actionsTotal) : '--'} />
            <StatCard
              title="Success"
              value={summary ? summary.successRate.toFixed(1) : '--'}
              unit="%"
              variant={summary ? (summary.successRate >= 97 ? 'success' : 'warning') : 'default'}
            />
            <StatCard
              title="Echo"
              value={summary ? summary.echoRate.toFixed(1) : '--'}
              unit="%"
              variant={summary ? (summary.echoRate >= 95 ? 'success' : 'warning') : 'default'}
            />
            <StatCard title="Throughput đỉnh" value={summary ? fmtCompact(summary.throughputPeak) : '--'} unit="act/s" />
            <StatCard title="Queue peak" value={summary ? fmtCompact(summary.queueCountPeak) : '--'} />
          </div>

          <ChartCard
            title="ACTIVE CONNECTIONS (replay)"
            actions={<RangeSelect value={range} onChange={setRange} />}
            empty={!hasTicks}
          >
            <div className="h-full" role="img" aria-label={`Biểu đồ kết nối replay, ${ticks.length} tick`}>
              <ConnectionsLineChart ticks={ticks} range={range} />
            </div>
          </ChartCard>

          <div className="grid gap-4 lg:grid-cols-12">
            <ChartCard title="ACTIONS/S THEO LOẠI (replay)" className="lg:col-span-7" empty={!hasTicks}>
              <ActionsStackedAreaChart ticks={ticks} />
            </ChartCard>
            <Card className="p-4 lg:col-span-5">
              <h3 className="mb-2 text-base font-medium">TOP ERRORS</h3>
              {!report || report.errors.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">Không có lỗi</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Mã lỗi</TableHead>
                      <TableHead scope="col" className="text-right">
                        Tần suất
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {report.errors.slice(0, 10).map((e) => (
                      <TableRow key={e.code}>
                        <TableCell className="font-mono text-xs tracking-tight text-destructive">{e.code}</TableCell>
                        <TableCell className="text-right font-mono text-xs tabular-nums">{fmtNum(e.count)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Card>
          </div>

          <ChartCard title="LATENCY P50/P95/P99 (replay)" empty={!hasTicks}>
            <div className="h-full" role="img" aria-label="Biểu đồ latency replay P50/P95/P99">
              <LatencyLineChart ticks={ticks} logScale={false} />
            </div>
          </ChartCard>
        </TabsContent>

        {/* ─── Báo cáo: summary + per-action + bottlenecks + config ─── */}
        <TabsContent value="report" className="space-y-4">
          {!report ? (
            <Card className="flex min-h-[30vh] flex-col items-center justify-center gap-3 p-8 text-center">
              <p className="text-sm text-muted-foreground">
                Run chưa có report (đang chạy hoặc DB chưa finalize). Xem số liệu live ở tab Tổng quan.
              </p>
              {isLive && (
                <Button variant="outline" className="min-h-11" onClick={() => navigate(routes.loadtestLive)}>
                  Mở Live Dashboard
                </Button>
              )}
            </Card>
          ) : (
            <>
              <div className="grid gap-4 lg:grid-cols-12">
                <Card className="p-4 lg:col-span-7">
                  <h2 className="mb-2 text-base font-medium">LATENCY P50/P95/P99 THEO ACTION</h2>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col">action</TableHead>
                        <TableHead scope="col" className="text-right">
                          p50
                        </TableHead>
                        <TableHead scope="col" className="text-right">
                          p95
                        </TableHead>
                        <TableHead scope="col" className="text-right">
                          p99
                        </TableHead>
                        <TableHead scope="col" className="text-right">
                          success
                        </TableHead>
                        <TableHead scope="col" className="text-right">
                          count
                        </TableHead>
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
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              </div>

              <Card className="p-4">
                <h2 className="mb-2 text-base font-medium">CẤU HÌNH RUN (snapshot)</h2>
                {detail.config ? (
                  <dl className="grid gap-x-6 md:grid-cols-2">
                    <KeyValue label="Target" value={fmtNum(detail.config.targetUsers)} />
                    <KeyValue label="Ramp" value={`${detail.config.rampRate}/s (${detail.config.rampMode})`} />
                    <KeyValue label="Duration" value={`${detail.config.durationMin} phút`} />
                    <KeyValue
                      label="Profile"
                      value={`chat ${detail.config.profile.chat} / read ${detail.config.profile.read} / comment ${detail.config.profile.comment} / like ${detail.config.profile.like}`}
                    />
                    <KeyValue label="Gateway" value={detail.config.gatewayUrl} />
                    <KeyValue label="Workers" value={`${detail.config.workerCount} (${detail.config.socketsPerWorker} socket/worker)`} />
                    <KeyValue label="Reuse pool" value={detail.config.useExistingAccounts ? 'Có' : 'Không'} />
                    <KeyValue label="Seed" value={String(detail.config.seed)} />
                  </dl>
                ) : (
                  <p className="py-4 text-center text-sm text-muted-foreground">Không có dữ liệu cấu hình.</p>
                )}
              </Card>
            </>
          )}
        </TabsContent>

        {/* ─── Logs ─── */}
        <TabsContent value="logs" className="space-y-4">
          <Card className="p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <h3 className="text-base font-medium">LOG EVENTS ({logs.length})</h3>
              <Select value={logLevel} onValueChange={setLogLevel}>
                <SelectTrigger className="w-full sm:w-44" aria-label="Lọc log theo level">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOG_LEVELS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {visibleLogs.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">Không có log nào.</p>
            ) : (
              <div className="scrollbar-thin mt-3 max-h-[60vh] overflow-auto font-mono text-xs">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col" className="w-36">
                        thời gian
                      </TableHead>
                      <TableHead scope="col" className="w-16">
                        level
                      </TableHead>
                      <TableHead scope="col">message</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleLogs.map((l) => (
                      <TableRow key={l.id}>
                        <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">{fmtDateTime(l.ts)}</TableCell>
                        <TableCell>
                          <Badge
                            variant={l.level === 'error' ? 'destructive' : l.level === 'warn' ? 'warning' : 'secondary'}
                            className="font-mono"
                          >
                            {l.level}
                          </Badge>
                        </TableCell>
                        <TableCell className="whitespace-pre-wrap break-all text-muted-foreground">{l.msg}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Card>
        </TabsContent>
      </Tabs>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {ticks.length} tick · {logs.length} log
        </span>
        <Link to={routes.loadtestHistory} className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline">
          Xem tất cả run <ChevronRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </div>
  );
}