import { memo, type ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface ChartCardProps {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  frozen?: boolean;
  className?: string;
  chartClassName?: string;
  loading?: boolean;
  empty?: boolean;
}

/** Skeleton shimmer thay chart trống khi run chưa có data (đồng bộ với --shimmer). */
function ChartSkeleton() {
  const bar = (w: string) => <div className="h-2.5 rounded bg-muted/70" style={{ width: w }} aria-hidden />;
  return (
    <div className="absolute inset-0 flex flex-col gap-3 overflow-hidden p-2" role="status" aria-label="Đang tải dữ liệu live...">
      <div className="flex h-full flex-col justify-center gap-3">
        <div className="flex items-end justify-between gap-3">
          {['25%', '40%', '30%', '20%'].map((w, i) => (
            <div key={i} className="flex h-24 flex-col items-center justify-end gap-1.5">
              {bar(w)}
              <div className="h-16 w-full rounded-t bg-muted/70" style={{ width: w }} />
            </div>
          ))}
        </div>
        <div className="flex gap-2">{bar('30%')}{bar('45%')}{bar('20%')}</div>
      </div>
      <span className="sr-only">Đang kết nối dữ liệu live...</span>
    </div>
  );
}

/**
 * Card bọc chart (UI-SPEC Màn 2) — chiều cao cố định h-56 md:h-64, không để
 * recharts đo lại mỗi tick. FROZEN: ring-1 + opacity (kênh 2 phân biệt LIVE/FROZEN).
 */
const ChartCard = memo(function ChartCard({
  title,
  actions,
  children,
  frozen,
  className,
  chartClassName,
  loading,
  empty,
}: ChartCardProps) {
  return (
    <Card
      className={cn('p-4', frozen && 'opacity-90 ring-1 ring-border', className)}
      data-frozen={frozen || undefined}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-medium">{title}</h3>
        {actions}
      </div>
      <div className={cn('relative h-56 w-full md:h-64', chartClassName)}>
        {loading ? (
          <ChartSkeleton />
        ) : empty ? (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            Chờ dữ liệu 1s đầu tiên...
          </div>
        ) : (
          children
        )}
      </div>
    </Card>
  );
});

export { ChartCard };
