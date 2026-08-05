import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { StatCard } from '@/components/ui/stat-card';
import { Gauge } from '@/components/ui/gauge';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ChartCard } from '@/components/loadtest/chart-card';
import { PhaseDonut } from '@/components/loadtest/phase-donut';
import { slicesFromTick } from '@/components/loadtest/user-phases';
import { CONNECT_FAIL_COLORS } from '@/components/loadtest/chart-theme';
import { connectFailBreakdown, connectFailVariant } from '@/components/loadtest/connect-fail';
import {
  ActionsStackedAreaChart,
  ActionRateBarChart,
  ConnectionsLineChart,
  LatencyLineChart,
  LogToggle,
  RangeSelect,
  type RangeKey,
} from '@/components/loadtest/charts';
import { loadtestApi } from '@/lib/loadtest-api';
import { fmtCompact, fmtNum } from '@/lib/loadtest-format';
import { useLoadtestStore } from '@/store/loadtest.store';
import { routes } from '@/lib/env';
import { TERMINAL_PHASES } from '@/types/loadtest';
import type { ErrorBucket, ErrorSample, LoadTestTick, RunPhase } from '@/types/loadtest';

/** Sparkline từ ring buffer (60 tick cuối). Counters giờ chứa cả field object (connectFailsByType — T1) → narrow về number. */
function useSpark(key: keyof LoadTestTick['counters'], n = 60) {
  const ticks = useLoadtestStore((s) => s.ticks);
  return useMemo(() => {
    const slice = ticks.slice(-n);
    return slice.map((t) => {
      const v = t.counters[key];
      return typeof v === 'number' ? v : 0;
    });
  }, [ticks, key, n]);
}

function rateVariant(v: number) {
  return v >= 95 ? 'success' : v >= 90 ? 'warning' : 'error';
}

/**
 * Sparkline rate connect fail — 60 tick cuối (UI-SPEC §3 D8/PF2).
 * Guard `?? 0`: tick replay cũ thiếu field → 0, không vẽ đoạn sai.
 */
function useRateSpark(n = 60) {
  const ticks = useLoadtestStore((s) => s.ticks);
  return useMemo(() => ticks.slice(-n).map((t) => t.rates.connectFailRate ?? 0), [ticks, n]);
}

/** SVG polyline thủ công (D8/PF2) — KHÔNG recharts: tránh chart thứ 5 re-render 1Hz trên máy đang chạy load gen. */
function RateSparkline({ values }: { values: number[] }) {
  const points = useMemo(() => {
    if (values.length < 2) return '';
    const W = 100;
    const H = 24;
    return values
      .map((v, i) => {
        const x = (i / (values.length - 1)) * W;
        const y = H - 2 - (Math.min(100, Math.max(0, v)) / 100) * (H - 4);
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }, [values]);
  if (!points) return null;
  return (
    <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="h-full w-full">
      <polyline
        points={points}
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Nghi vấn bottleneck E11: queue-count tăng liên tục > 5 phút. */
function useBottleneck(ticks: LoadTestTick[]) {
  return useMemo(() => {
    if (ticks.length < 2) return false;
    const last = ticks[ticks.length - 1];
    if (last.counters.queueCount === 0) return false;
    const fiveMinAgo = ticks.find((t) => t.ts <= last.ts - 5 * 60 * 1000);
    if (!fiveMinAgo) return false;
    return last.counters.queueCount > fiveMinAgo.counters.queueCount * 1.5;
  }, [ticks]);
}

interface ErrorRow {
  code: string;
  count: number;
  sample?: string;
}

function ErrorListDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [rows, setRows] = useState<ErrorRow[]>([]);
  const [loading, setLoading] = useState(false);
  const parentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    loadtestApi
      .errors()
      .then(({ top, samples }) => {
        const topRows: ErrorRow[] = (top ?? []).map((e: ErrorBucket) => ({ code: e.code, count: e.count }));
        const sampleRows: ErrorRow[] = (samples ?? []).map((s: ErrorSample) => ({
          code: s.code,
          count: 1,
          sample: `${s.action} · ${s.message}`,
        }));
        setRows([...topRows, ...sampleRows].slice(0, 500));
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [open]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 10,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">TẤT CẢ LỖI</DialogTitle>
        </DialogHeader>
        {loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Đang tải...</p>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">Không có lỗi nào</p>
        ) : (
          <div ref={parentRef} className="max-h-[60vh] overflow-auto" role="table" aria-label="Danh sách lỗi đầy đủ">
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const r = rows[item.index];
                return (
                  <div
                    key={item.key}
                    className="absolute left-0 top-0 flex w-full items-center gap-3 border-b border-border px-3 text-sm"
                    style={{ height: 40, transform: `translateY(${item.start}px)` }}
                    role="row"
                  >
                    <span className="font-mono text-xs tracking-tight text-destructive">{r.code}</span>
                    <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">{r.count}</span>
                    {r.sample && <span className="truncate text-xs text-muted-foreground">{r.sample}</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface ConnectFailBreakdownProps {
  tick: LoadTestTick | null;
  phase: RunPhase;
}

/**
 * Card CONNECT FAIL BREAKDOWN (UI-SPEC §4) — số lũy kế per-worker (BE-2, có thể tụt
 * khi worker restart). Empty states phân biệt theo UI-1: !tick → chờ · replay
 * (hasConnectData false) → lịch sử (KHÔNG "đang chờ") · attempts 0 → chờ user ·
 * totalFails 0 → sạch.
 */
function ConnectFailBreakdown({ tick, phase }: ConnectFailBreakdownProps) {
  const c = tick?.counters;
  const rate = tick?.rates.connectFailRate ?? 0;
  const attempts = c?.connectAttempts ?? 0;
  const usersFailed = c?.usersFailed ?? 0;
  const byType = c?.connectFailsByType;
  const breakdown = byType ? connectFailBreakdown(byType) : [];
  const totalFails = breakdown.reduce((acc, r) => acc + r.count, 0);
  const danger =
    !!tick && tick.hasConnectData !== false && rate >= 30 && (phase === 'ramping' || phase === 'steady');
  // X-2: toàn bộ worker restart (BE-2) → counter lũy kế về 0 NHƯNG window 60s vẫn đỏ —
  // không hiện "Không có connect fail"/"đang chờ" gây hiểu lầm khi tile đang cảnh báo.
  const cumulativeResetDanger = rate >= 30 && totalFails === 0;

  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-base font-medium">CONNECT FAIL BREAKDOWN</h3>
        <Badge variant="secondary">lũy kế</Badge>
      </div>
      {!tick ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Đang chờ tick đầu tiên...</p>
      ) : tick.hasConnectData === false ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Run lịch sử (trước bản fix) không lưu dữ liệu connect — hiển thị 0
        </p>
      ) : (
        <>
          {danger && (
            <AlertBanner
              variant="warning"
              title="Tỉ lệ connect fail ≥ 30% trong cửa sổ 60s — auto-stop E2 sắp kích hoạt"
              description="Run sẽ tự dừng khi window đủ ≥ 50 attempts và rate > 30%. Xem breakdown bên dưới để tìm nguyên nhân."
              className="mb-3"
            />
          )}
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-2">
                  attempts {fmtCompact(attempts)} · fails {fmtCompact(totalFails)}
                </span>
              </TooltipTrigger>
              <TooltipContent>(per worker từ khi worker khởi động — có thể giảm khi E3-restart)</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="cursor-help underline decoration-dotted underline-offset-2">
                  usersFailed {fmtCompact(usersFailed)}
                </span>
              </TooltipTrigger>
              <TooltipContent>(lọc Phase = Lỗi tại Virtual Users)</TooltipContent>
            </Tooltip>
          </div>
          {cumulativeResetDanger ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Số lũy kế về 0 sau worker restart — window 60s vẫn ghi nhận connect fail. Xem tile Connect fail.
            </p>
          ) : attempts === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Chưa có dữ liệu connect — đang chờ user connect đầu tiên...
            </p>
          ) : totalFails === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Không có connect fail trong run này</p>
          ) : (
            <>
              <div
                role="img"
                aria-label={`Phân bố connect fail theo loại: ${breakdown.map((b) => `${b.label} ${b.count}`).join(', ')}`}
              >
                <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
                  {breakdown.map((b) => (
                    <div key={b.key} style={{ width: `${b.pct}%`, background: CONNECT_FAIL_COLORS[b.key] }} />
                  ))}
                </div>
              </div>
              <ul className="mt-3 space-y-1 text-xs" aria-label="Phân bố connect fail theo loại">
                {breakdown.map((b) => (
                  <li key={b.key} className="flex items-center gap-2">
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: CONNECT_FAIL_COLORS[b.key] }}
                      aria-hidden
                    />
                    <span className="text-muted-foreground">{b.label}</span>
                    <span className="ml-auto font-mono tabular-nums">{fmtCompact(b.count)}</span>
                    <span className="w-14 text-right font-mono tabular-nums text-muted-foreground">
                      ({b.pct >= 10 ? Math.round(b.pct) : b.pct.toFixed(1)}%)
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Card>
  );
}

export default function LiveDashboardPage() {
  const navigate = useNavigate();
  const ticks = useLoadtestStore((s) => s.ticks);
  const lastTick = useLoadtestStore((s) => s.lastTick);
  const phase = useLoadtestStore((s) => s.phase);
  const stopReason = useLoadtestStore((s) => s.stopReason);

  const [range, setRange] = useState<RangeKey>('30m');
  const [logScale, setLogScale] = useState(false);
  const [errorsOpen, setErrorsOpen] = useState(false);
  const queueChartRef = useRef<HTMLDivElement>(null);

  const c = lastTick?.counters;
  const r = lastTick?.rates;
  const actionsTotal = lastTick
    ? Object.values(lastTick.actionsPerSec).reduce((acc, v) => acc + (v ?? 0), 0)
    : 0;

  const sparkConnections = useSpark('usersConnected');
  const sparkActions = useSpark('actionsTotal');
  const sparkSuccess = useSpark('successTotal');
  const sparkEcho = useSpark('echoOk');
  const rateSpark = useRateSpark();

  // Tile Connect fail (UI-SPEC §3 D4): `--` chỉ khi !lastTick HOẶC replay (hasConnectData false) —
  // KHÔNG dùng cumulative attempts → không tái xuất `--` giữa run sau worker restart (BE-2).
  const connectFailValue =
    lastTick && lastTick.hasConnectData !== false ? (lastTick.rates.connectFailRate ?? 0).toFixed(1) : '--';
  const showRateSpark = !!lastTick && lastTick.hasConnectData !== false;

  const frozen = TERMINAL_PHASES.includes(phase);
  const bottleneck = useBottleneck(ticks);
  const noRunYet = phase === 'idle' && ticks.length === 0;

  const scrollToQueue = useCallback(() => {
    queueChartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, []);

  if (noRunYet) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
        <p className="text-sm text-muted-foreground">Chưa có run nào — bắt đầu từ Control Panel.</p>
        <Button size="lg" className="min-h-12" onClick={() => navigate(routes.loadtest)}>
          Đi tới Cấu hình
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {frozen && (
        <AlertBanner
          variant="info"
          title="Run đã kết thúc — số liệu cuối cùng"
          action={{ label: 'Xem báo cáo >', onClick: () => navigate(routes.loadtestReport) }}
        />
      )}
      {phase === 'error' && (
        <AlertBanner
          variant="destructive"
          title={
            stopReason
              ? `Run tự dừng: ${stopReason}`
              : 'Run tự dừng: register/connect fail vượt ngưỡng (E1/E2)'
          }
          description={
            c
              ? `User tạo ${fmtNum(c.usersCreated)} · connect ${fmtNum(c.usersConnected)} · thất bại ${fmtNum(c.failTotal)}`
              : undefined
          }
          action={{ label: 'Xem báo cáo >', onClick: () => navigate(routes.loadtestReport) }}
        />
      )}
      {lastTick && lastTick.workers.alive < lastTick.workers.total && (
        <AlertBanner
          variant="destructive"
          title={`${lastTick.workers.alive}/${lastTick.workers.total} worker mất kết nối — đang tự restart (E3)`}
          description="> 50% worker chết trong 60s sẽ auto-stop."
        />
      )}

      {/* KPI grid 9 tiles (UI-SPEC §8.1 — xl:grid-cols-9) */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-9">
        <StatCard title="Connect" value={c ? fmtCompact(c.usersConnected) : '--'} sparkline={sparkConnections} />
        <StatCard title="Active" value={c ? fmtCompact(c.usersActive) : '--'} variant="success" />
        <StatCard title="Actions/s" value={fmtCompact(actionsTotal)} sparkline={sparkActions} />
        <StatCard
          title="Success"
          value={r ? r.successRate.toFixed(1) : '--'}
          unit="%"
          variant={r ? rateVariant(r.successRate) : 'default'}
          sparkline={sparkSuccess}
        />
        <StatCard
          title="Echo"
          value={r ? r.echoRate.toFixed(1) : '--'}
          unit="%"
          variant={r ? rateVariant(r.echoRate) : 'default'}
          hint="Chat success = echo chat:message (clientMsgId)"
          sparkline={sparkEcho}
        />
        <StatCard title="Queue" value={c ? fmtCompact(c.queueCount) : '--'} hint="Matching ~100 user/s" />
        <StatCard title="Rooms" value={c ? fmtCompact(c.roomCount) : '--'} />
        <StatCard
          title="ws_server"
          value={lastTick?.server ? fmtCompact(lastTick.server.wsConnections) : '--'}
          hint="Gateway /metrics — 5s"
        />
        <StatCard
          title="Connect fail"
          value={connectFailValue}
          unit="%"
          variant={connectFailVariant(lastTick)}
          hint="Tỉ lệ fail/attempt trong cửa sổ 60s. Auto-stop E2: > 30% và window ≥ 50 attempts. < 5% = healthy (AC-5). 0% khi window chưa đủ 50 attempts."
          className="col-span-2 md:col-span-4 xl:col-span-1"
          sparklineNode={showRateSpark ? <RateSparkline values={rateSpark} /> : undefined}
        />
      </div>

      {/* Hàng mới: phân bố phase (donut) + actions/s hiện tại theo loại */}
      <div className="grid gap-4 lg:grid-cols-12">
        <ChartCard title="USER THEO PHASE" frozen={frozen} className="lg:col-span-5" loading={!lastTick}>
          <PhaseDonut slices={slicesFromTick(lastTick)} centerLabel="users" />
        </ChartCard>
        <ChartCard title="ACTIONS/S HIỆN TẠI THEO LOẠI" frozen={frozen} className="lg:col-span-7" loading={!lastTick}>
          <ActionRateBarChart tick={lastTick} />
        </ChartCard>
      </div>

      {/* Hàng 2: connections + latency (trái 8) | gauge + queue (phải 4) */}
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-8">
          <div ref={queueChartRef}>
            <ChartCard
              title="ACTIVE CONNECTIONS"
              frozen={frozen}
              actions={<RangeSelect value={range} onChange={setRange} />}
              loading={!lastTick}
            >
              <div className="h-full" role="img" aria-label={`Biểu đồ kết nối, giá trị mới nhất ${c ? fmtNum(c.usersConnected) : '--'}`}>
                <ConnectionsLineChart ticks={ticks} range={range} />
              </div>
            </ChartCard>
          </div>
          <ChartCard
            title="LATENCY P50/P95/P99 (ms)"
            frozen={frozen}
            actions={<LogToggle value={logScale} onChange={setLogScale} />}
            loading={!lastTick}
          >
            <div className="h-full" role="img" aria-label="Biểu đồ latency P50/P95/P99 theo thời gian">
              <LatencyLineChart ticks={ticks} logScale={logScale} />
            </div>
          </ChartCard>
        </div>
        <div className="space-y-4 lg:col-span-4">
          <div className="grid grid-cols-2 gap-3">
            <Gauge label="Success rate" value={r?.successRate ?? 0} okThreshold={97} warnThreshold={90} />
            <Gauge
              label="Chat echo rate"
              value={r?.echoRate ?? 0}
              okThreshold={95}
              warnThreshold={90}
              hint="Rate-limited (no echo) tách khỏi lỗi thật"
            />
          </div>
          <Card className="p-4">
            <div className="grid grid-cols-2 gap-3">
              <StatCard title="Queue" value={c ? fmtNum(c.queueCount) : '--'} hint="Matching ~100 user/s" />
              <StatCard title="Rooms" value={c ? fmtNum(c.roomCount) : '--'} />
              <StatCard title="Reconnect" value={c ? fmtNum(c.reconnectCount) : '--'} />
              <StatCard title="Outbox dropped" value={c ? fmtNum(c.droppedOutbox) : '--'} hint="Ring buffer 1000 pending/user" />
            </div>
          </Card>
        </div>
      </div>

      {/* Hàng 3: actions/s (7) | top errors + connect fail breakdown (5) (UI-SPEC §8.2) */}
      <div className="grid gap-4 lg:grid-cols-12">
        <ChartCard title="ACTIONS/S THEO LOẠI" frozen={frozen} className="lg:col-span-7" loading={!lastTick}>
          <ActionsStackedAreaChart ticks={ticks} />
        </ChartCard>

        <div className="space-y-4 lg:col-span-5">
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-base font-medium">TOP ERRORS</h3>
              <Button variant="ghost" size="sm" className="min-h-10" onClick={() => setErrorsOpen(true)}>
                Xem tất cả <ChevronRight className="h-4 w-4" aria-hidden />
              </Button>
            </div>
            {!lastTick || lastTick.errors.length === 0 ? (
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
                  {lastTick.errors.slice(0, 10).map((e) => (
                    <TableRow key={e.code}>
                      <TableCell className="font-mono text-xs tracking-tight text-destructive">{e.code}</TableCell>
                      <TableCell className="text-right font-mono text-xs tabular-nums">{fmtNum(e.count)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>

          <ConnectFailBreakdown tick={lastTick} phase={phase} />
        </div>
      </div>

      {/* Server-side (gateway /metrics) */}
      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-base font-medium">SERVER-SIDE (gateway /metrics)</h3>
          <Badge variant="secondary">scrape 5s</Badge>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <StatCard title="ws_connections" value={lastTick?.server ? fmtCompact(lastTick.server.wsConnections) : '--'} />
          <StatCard title="msgs_emitted" value={lastTick?.server ? fmtCompact(lastTick.server.wsMessagesEmitted) : '--'} />
          <StatCard title="msgs/s" value={lastTick?.server ? fmtCompact(lastTick.server.wsMessagesPerSec) : '--'} />
        </div>
      </Card>

      {bottleneck && !frozen && (
        <AlertBanner
          variant="warning"
          title="Nghi vấn bottleneck: queue-count tăng liên tục > 5 phút"
          description="Matching engine trần ~100 user/s (MAX_POP=200/2s)."
          action={{ label: 'Xem bằng chứng', onClick: scrollToQueue }}
        />
      )}

      <ErrorListDialog open={errorsOpen} onOpenChange={setErrorsOpen} />
    </div>
  );
}
