import { memo } from 'react';
import { Badge } from '@/components/ui/badge';
import type { RunStatusValue } from '@/types/loadtest';
import { cn } from '@/lib/utils';

const STATUS_META: Record<RunStatusValue, { label: string; variant: 'success' | 'secondary' | 'warning' | 'destructive' }> = {
  running: { label: 'Running', variant: 'success' },
  finished: { label: 'Finished', variant: 'secondary' },
  stopped: { label: 'Stopped', variant: 'warning' },
  error: { label: 'Error', variant: 'destructive' },
};

/** Badge trạng thái run từ DB (lịch sử) — running pulse theo prefers-reduced-motion. */
const RunStatusBadge = memo(function RunStatusBadge({ status, className }: { status: RunStatusValue; className?: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.finished;
  const pulse = status === 'running' ? 'motion-safe:animate-pulse' : '';
  return (
    <Badge variant={meta.variant} className={cn(pulse, className)}>
      {meta.label}
    </Badge>
  );
});

export { RunStatusBadge, STATUS_META };