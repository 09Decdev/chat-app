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
          <div className="absolute inset-0 flex items-center justify-center rounded-md bg-muted/30 text-sm text-muted-foreground">
            Đang kết nối dữ liệu live...
          </div>
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
