import { memo } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface GaugeProps {
  label: string;
  value: number; // 0-100
  min?: number;
  max?: number;
  okThreshold: number;
  warnThreshold: number;
  format?: (v: number) => string;
  hint?: string;
  className?: string;
}

/**
 * Gauge arc 270° (UI-SPEC 1.4 #7) — SVG thuần, không recharts.
 * Luôn có chữ trạng thái + aria-label — không dựa màu đơn thuần.
 */
const Gauge = memo(function Gauge({
  label,
  value,
  min = 0,
  max = 100,
  okThreshold,
  warnThreshold,
  format,
  hint,
  className,
}: GaugeProps) {
  const pct = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
  const color =
    value >= okThreshold ? 'hsl(var(--success))' : value >= warnThreshold ? 'hsl(var(--warning))' : 'hsl(var(--destructive))';
  const statusText = value >= okThreshold ? 'Đạt ngưỡng' : value >= warnThreshold ? 'Cảnh báo' : 'Dưới ngưỡng';

  // Arc 270°: bắt đầu -225°, quét 270°.
  const R = 42;
  const CIRC = 2 * Math.PI * R;
  const ARC = (270 / 360) * CIRC;
  const dash = (ARC * pct) / 100;
  const fmt = format ?? ((v: number) => `${v.toFixed(1)}%`);

  return (
    <Card className={cn('flex flex-col items-center justify-center p-4', className)}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div
        className="relative mt-2"
        role="img"
        aria-label={`${label}: ${fmt(value)} — ${statusText}`}
      >
        <svg width="120" height="88" viewBox="0 0 120 88" className="block" aria-hidden>
          <circle
            cx="60"
            cy="60"
            r={R}
            fill="none"
            stroke="hsl(var(--secondary))"
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={`${ARC} ${CIRC}`}
            transform="rotate(-225 60 60)"
          />
          <circle
            cx="60"
            cy="60"
            r={R}
            fill="none"
            stroke={color}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${CIRC}`}
            transform="rotate(-225 60 60)"
          />
        </svg>
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center">
          <span className="text-2xl font-semibold tabular-nums text-foreground">{fmt(value)}</span>
        </div>
      </div>
      <p className="mt-1 text-xs font-medium" style={{ color }}>
        {statusText}
      </p>
      {hint && <p className="mt-1 text-center text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
});

export { Gauge };
