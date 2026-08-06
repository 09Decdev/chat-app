import React, { memo } from 'react';
import { TrendingDown, TrendingUp, Minus, Info } from 'lucide-react';
import { Area, AreaChart } from 'recharts';
import { Card } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export type StatVariant = 'default' | 'success' | 'warning' | 'error' | 'info';

export interface StatCardProps {
  title: string;
  value: string | number;
  unit?: string;
  delta?: number;
  trend?: 'up' | 'down' | 'flat';
  sparkline?: number[];
  /**
   * Sparkline thủ công (D8/PF2 — tile Connect fail): render trong slot h-6 thay recharts
   * khi `sparkline` không được truyền — tránh chart recharts thứ 5 re-render 1Hz.
   */
  sparklineNode?: React.ReactNode;
  variant?: StatVariant;
  hint?: string;
  className?: string;
}

const variantText: Record<StatVariant, string> = {
  default: 'text-foreground',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-destructive',
  info: 'text-info',
};

const trendIcon = {
  up: <TrendingUp className="h-4 w-4" aria-hidden />,
  down: <TrendingDown className="h-4 w-4" aria-hidden />,
  flat: <Minus className="h-4 w-4" aria-hidden />,
};

/**
 * KPI tile (UI-SPEC 1.4 #6) — không animation, sparkline recharts 60x24.
 */
const StatCard = memo(function StatCard({
  title,
  value,
  unit,
  delta,
  trend,
  sparkline,
  sparklineNode,
  variant = 'default',
  hint,
  className,
}: StatCardProps) {
  const sparkData = React.useMemo(
    () => (sparkline?.length ? sparkline.map((v, i) => ({ i, v })) : null),
    [sparkline],
  );
  return (
    <Card className={cn('min-h-24 p-4', className)}>
      <div className="flex items-center justify-between gap-1">
        <p className="text-xs text-muted-foreground">{title}</p>
        {hint && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`${title}: ${hint}`}
              >
                <Info className="h-3.5 w-3.5" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent>{hint}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <p className={cn('mt-1 text-lg font-semibold tabular-nums sm:text-2xl', variantText[variant])}>
        {value}
        {unit && <span className="ml-1 text-xs font-normal text-muted-foreground">{unit}</span>}
      </p>
      {delta !== undefined && (
        <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
          {trend ? trendIcon[trend] : null}
          <span className="tabular-nums">{delta}</span>
        </p>
      )}
      {sparkData && (
        <div className="pointer-events-none mt-2 h-6 w-full" aria-hidden>
          <AreaChart width={240} height={24} data={sparkData} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.15} />
                <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="v"
              stroke="hsl(var(--primary))"
              strokeWidth={1.5}
              fill="url(#sparkfill)"
              isAnimationActive={false}
              dot={false}
            />
          </AreaChart>
        </div>
      )}
      {sparklineNode && !sparkData && (
        <div className="pointer-events-none mt-2 h-6 w-full" aria-hidden>
          {sparklineNode}
        </div>
      )}
    </Card>
  );
});

export { StatCard };
