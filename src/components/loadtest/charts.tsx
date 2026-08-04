/**
 * Charts Live Dashboard — UI-SPEC §4.2–4.4.
 * HARD RULES: isAnimationActive={false} MỌI series; React.memo; transform trong
 * useMemo; P50/P95/P99 phân biệt bằng dash-pattern + nhãn chữ, KHÔNG chỉ màu.
 */
import { memo, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { fmtCompact, fmtMs, fmtTickTime } from '@/lib/loadtest-format';
import type { ActionType, LoadTestTick } from '@/types/loadtest';
import { ACTION_LABELS } from '@/types/loadtest';

// ─── Chart chrome (UI-SPEC 1.1) ────────────────────────────────────────────
const AXIS_TICK = { fontSize: 12, fill: 'hsl(var(--muted-foreground))' } as const;
const GRID_STROKE = 'hsl(var(--border))';
const CURSOR_STROKE = 'hsl(var(--border))';

export const ACTION_SERIES: { key: ActionType; color: string }[] = [
  { key: 'chat', color: 'hsl(var(--chart-1))' },
  { key: 'read', color: 'hsl(var(--chart-2))' },
  { key: 'comment', color: 'hsl(var(--chart-3))' },
  { key: 'like', color: 'hsl(var(--chart-4))' },
  { key: 'view', color: 'hsl(var(--chart-5))' },
  { key: 'topic', color: 'hsl(var(--chart-6))' },
  { key: 'typing', color: 'hsl(var(--chart-7))' },
  { key: 'vote_kick', color: 'hsl(var(--chart-8))' },
];

/** Downsample đều (không lọc min/max — tránh sai dạng) — max 1800 điểm (4.8 #4). */
export function downsample<T>(data: T[], maxPoints: number): T[] {
  if (data.length <= maxPoints) return data;
  const step = data.length / maxPoints;
  const out: T[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(data[Math.min(data.length - 1, Math.floor(i * step))]);
  return out;
}

export type RangeKey = '5m' | '15m' | '30m' | '1h' | 'all';
export const RANGE_OPTIONS: { value: RangeKey; label: string; sec: number | null }[] = [
  { value: '5m', label: '5 phút', sec: 300 },
  { value: '15m', label: '15 phút', sec: 900 },
  { value: '30m', label: '30 phút', sec: 1800 },
  { value: '1h', label: '1 giờ', sec: 3600 },
  { value: 'all', label: 'Tất cả', sec: null },
];

export function sliceRange(ticks: LoadTestTick[], range: RangeKey): LoadTestTick[] {
  const opt = RANGE_OPTIONS.find((o) => o.value === range);
  if (!opt?.sec) return ticks;
  const cutoff = ticks.length > 0 ? ticks[ticks.length - 1].ts - opt.sec * 1000 : 0;
  return ticks.filter((t) => t.ts >= cutoff);
}

// ─── Tooltip 1 điểm (UI-SPEC 4.8 #5) ───────────────────────────────────────
interface TooltipRow {
  dataKey: string;
  name: string;
  value: number;
  color?: string;
  stroke?: string;
  dash?: string;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: { dataKey?: string | number; name?: string | number; value?: number; color?: string; stroke?: string; strokeDasharray?: string | number }[];
  label?: number | string;
  format?: (v: number) => string;
  showTotal?: boolean;
}

function ChartTooltip({ active, payload, label, format, showTotal }: ChartTooltipProps) {
  if (!active || !payload?.length) return null;
  const rows: TooltipRow[] = payload.map((p) => ({
    dataKey: String(p.dataKey ?? ''),
    name: String(p.name ?? ''),
    value: Number(p.value ?? 0),
    color: p.color,
    stroke: p.stroke,
    dash: p.strokeDasharray ? String(p.strokeDasharray) : undefined,
  }));
  const total = showTotal ? rows.reduce((acc, r) => acc + r.value, 0) : null;
  const fmt = format ?? ((v: number) => fmtCompact(v));
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="mb-1 font-mono tabular-nums tracking-tight">{label}</p>
      {rows.map((r) => (
        <p key={r.dataKey} className="flex items-center gap-2 whitespace-nowrap tabular-nums">
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ background: r.color ?? r.stroke ?? 'hsl(var(--border))' }}
            aria-hidden
          />
          <span className="flex-1">{r.name}</span>
          <span className="font-medium">{fmt(r.value)}</span>
        </p>
      ))}
      {total !== null && (
        <p className="mt-1 flex items-center justify-between gap-2 border-t border-border pt-1 font-medium tabular-nums">
          <span>Tổng</span>
          <span>{fmt(total)}</span>
        </p>
      )}
    </div>
  );
}

// ─── 4.2 Connections ───────────────────────────────────────────────────────
interface ConnectionsChartProps {
  ticks: LoadTestTick[];
  range: RangeKey;
}

const ConnectionsLineChart = memo(function ConnectionsLineChart({ ticks, range }: ConnectionsChartProps) {
  const data = useMemo(() => {
    const sliced = sliceRange(ticks, range);
    return downsample(
      sliced.map((t) => ({ ts: t.ts, connections: t.counters.usersConnected, active: t.counters.usersActive })),
      1800,
    );
  }, [ticks, range]);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID_STROKE} strokeWidth={1} vertical={false} />
        <XAxis
          dataKey="ts"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickFormatter={(v: number) => fmtTickTime(v)}
          tick={AXIS_TICK}
          minTickGap={48}
          tickMargin={6}
          stroke={GRID_STROKE}
        />
        <YAxis width={44} tickFormatter={(v: number) => fmtCompact(v)} tick={AXIS_TICK} allowDecimals={false} stroke={GRID_STROKE} />
        <Tooltip content={<ChartTooltip />} cursor={{ stroke: CURSOR_STROKE }} />
        <Line
          type="monotone"
          dataKey="connections"
          name="Connect"
          stroke="hsl(var(--chart-2))"
          strokeWidth={1.5}
          dot={false}
          activeDot={{ r: 3 }}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="active"
          name="Active"
          stroke="hsl(var(--chart-1))"
          strokeWidth={1.5}
          dot={false}
          activeDot={{ r: 3 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
});

/** Select range 5m/15m/30m/1h/Tất cả — client cắt mảng, không hỏi lại server. */
const RangeSelect = memo(function RangeSelect({ value, onChange }: { value: RangeKey; onChange: (v: RangeKey) => void }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as RangeKey)}>
      <SelectTrigger className="h-10 w-28" aria-label="Khoảng thời gian biểu đồ">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {RANGE_OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
});

// ─── 4.3 Actions/s stacked ─────────────────────────────────────────────────
interface ActionsChartProps {
  ticks: LoadTestTick[];
}

const ActionsStackedAreaChart = memo(function ActionsStackedAreaChart({ ticks }: ActionsChartProps) {
  const [hidden, setHidden] = useState<Set<ActionType>>(new Set());
  const visible = ACTION_SERIES.filter((s) => !hidden.has(s.key));

  const data = useMemo(
    () =>
      downsample(
        ticks.map((t) => {
          const row: Record<string, number | string> = { ts: t.ts };
          for (const s of ACTION_SERIES) row[s.key] = t.actionsPerSec[s.key] ?? 0;
          return row;
        }),
        1800,
      ),
    [ticks],
  );

  const total = ticks.length > 0 ? ticks[ticks.length - 1].actionsPerSec : {};
  const totalSum = ACTION_SERIES.reduce((acc, s) => acc + (total[s.key] ?? 0), 0);

  const toggle = (key: ActionType) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-muted-foreground">actions/s: {fmtCompact(totalSum)}</span>
        {ACTION_SERIES.map((s) => (
          <button
            key={s.key}
            type="button"
            aria-pressed={!hidden.has(s.key)}
            onClick={() => toggle(s.key)}
            className={cn(
              'inline-flex min-h-8 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              hidden.has(s.key)
                ? 'border-border text-muted-foreground opacity-50'
                : 'border-border text-foreground',
            )}
          >
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} aria-hidden />
            {ACTION_LABELS[s.key]}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID_STROKE} strokeWidth={1} vertical={false} />
            <XAxis
              dataKey="ts"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(v: number) => fmtTickTime(v)}
              tick={AXIS_TICK}
              minTickGap={48}
              tickMargin={6}
              stroke={GRID_STROKE}
            />
            <YAxis width={44} tickFormatter={(v: number) => fmtCompact(v)} tick={AXIS_TICK} allowDecimals={false} stroke={GRID_STROKE} />
            <Tooltip content={<ChartTooltip showTotal />} cursor={{ stroke: CURSOR_STROKE }} />
            {visible.map((s) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={ACTION_LABELS[s.key]}
                stackId="a"
                stroke={s.color}
                strokeOpacity={0.6}
                fill={s.color}
                fillOpacity={0.85}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
});

// ─── 4.4 Latency P50/P95/P99 + log toggle ─────────────────────────────────
interface LatencyChartProps {
  ticks: LoadTestTick[];
  logScale: boolean;
}

const LATENCY_SERIES = [
  { key: 'p50', name: 'P50', color: 'hsl(var(--chart-2))', dash: undefined },
  { key: 'p95', name: 'P95', color: 'hsl(var(--chart-1))', dash: '6 4' },
  { key: 'p99', name: 'P99', color: 'hsl(var(--chart-6))', dash: '2 3' },
] as const;

const LatencyLineChart = memo(function LatencyLineChart({ ticks, logScale }: LatencyChartProps) {
  const data = useMemo(
    () =>
      downsample(
        ticks.map((t) => ({ ts: t.ts, p50: t.latency.p50, p95: t.latency.p95, p99: t.latency.p99 })),
        1800,
      ),
    [ticks],
  );
  const maxLat = data.length > 0 ? Math.max(...data.map((d) => d.p99), 1) : 1;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
        <CartesianGrid stroke={GRID_STROKE} strokeWidth={1} vertical={false} />
        <XAxis
          dataKey="ts"
          type="number"
          scale="time"
          domain={['dataMin', 'dataMax']}
          tickFormatter={(v: number) => fmtTickTime(v)}
          tick={AXIS_TICK}
          minTickGap={48}
          tickMargin={6}
          stroke={GRID_STROKE}
        />
        <YAxis
          width={44}
          scale={logScale ? 'log' : 'linear'}
          domain={logScale ? [1, maxLat * 1.1] : [0, maxLat * 1.1]}
          tickFormatter={(v: number) => fmtMs(v)}
          tick={AXIS_TICK}
          stroke={GRID_STROKE}
          allowDataOverflow
        />
        <Tooltip content={<ChartTooltip format={fmtMs} />} cursor={{ stroke: CURSOR_STROKE }} />
        {LATENCY_SERIES.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={s.color}
            strokeWidth={1.5}
            strokeDasharray={s.dash}
            dot={false}
            activeDot={{ r: 3 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
});

/** Toggle log/linear (UI-SPEC 4.4). */
const LogToggle = memo(function LogToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Button
      type="button"
      variant={value ? 'default' : 'outline'}
      size="sm"
      className="min-h-10"
      aria-pressed={value}
      onClick={() => onChange(!value)}
    >
      {value ? 'log' : 'linear'}
    </Button>
  );
});

export { ConnectionsLineChart, RangeSelect, ActionsStackedAreaChart, LatencyLineChart, LogToggle, ChartTooltip };
