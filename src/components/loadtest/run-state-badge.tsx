import { memo } from 'react';
import { Badge } from '@/components/ui/badge';
import type { RunPhase } from '@/types/loadtest';

const PHASE_META: Record<RunPhase, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'success' | 'warning' }> = {
  idle: { label: 'IDLE', variant: 'secondary' },
  provisioning: { label: 'Provisioning', variant: 'warning' },
  ramping: { label: 'Ramping', variant: 'default' },
  steady: { label: 'Steady', variant: 'success' },
  cooldown: { label: 'Cooldown', variant: 'warning' },
  report: { label: 'Đang chốt số liệu', variant: 'warning' },
  finished: { label: 'Finished', variant: 'secondary' },
  stopped: { label: 'Stopped', variant: 'secondary' },
  error: { label: 'Error', variant: 'destructive' },
};

/** Badge phase run (UI-SPEC Màn 1 header) — provisioning pulse theo prefers-reduced-motion. */
const RunStateBadge = memo(function RunStateBadge({ phase, className }: { phase: RunPhase; className?: string }) {
  const meta = PHASE_META[phase] ?? PHASE_META.idle;
  const pulse = phase === 'provisioning' ? 'motion-safe:animate-pulse' : '';
  return (
    <Badge variant={meta.variant} className={`${pulse} ${className ?? ''}`}>
      {meta.label}
    </Badge>
  );
});

export { RunStateBadge, PHASE_META };
