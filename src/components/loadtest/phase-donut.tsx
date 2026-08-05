/**
 * Donut phân bố user theo phase — dùng chung UsersPage + LiveDashboard.
 * HARD RULES: isAnimationActive={false}; màu theo PHASE_COLORS (chart-theme.ts).
 */
import { memo, useMemo } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { fmtCompact } from '@/lib/loadtest-format';
import type { PhaseSlice } from './user-phases';

interface PhaseDonutProps {
  slices: PhaseSlice[];
  /** Nhãn ở tâm (vd "4.2k users"). */
  centerLabel?: string;
  className?: string;
}

/** Legend rút gọn bên phải donut — màu theo slice. */
function DonutLegend({ slices }: { slices: PhaseSlice[] }) {
  return (
    <ul className="min-w-0 flex-1 space-y-1 text-xs" aria-label="Phân bố theo phase">
      {slices.map((s) => (
        <li key={s.key} className="flex items-center gap-2">
          <span
            className="inline-block h-2 w-2 shrink-0 rounded-full"
            style={{ background: s.color }}
            aria-hidden
          />
          <span className="truncate text-muted-foreground">{s.label}</span>
          <span className="ml-auto font-mono tabular-nums">{fmtCompact(s.value)}</span>
        </li>
      ))}
    </ul>
  );
}

const PhaseDonut = memo(function PhaseDonut({ slices, centerLabel, className }: PhaseDonutProps) {
  const total = useMemo(() => slices.reduce((acc, s) => acc + s.value, 0), [slices]);
  if (total <= 0) {
    return (
      <div className={`flex items-center justify-center text-sm text-muted-foreground ${className ?? ''}`}>
        Chưa có dữ liệu user
      </div>
    );
  }
  return (
    <div className={`flex h-full items-center gap-3 ${className ?? ''}`}>
      <div className="relative h-40 w-40 shrink-0" role="img" aria-label={`Phân bố user theo phase, tổng ${fmtCompact(total)}`}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius="68%"
              outerRadius="96%"
              paddingAngle={2}
              strokeWidth={0}
              isAnimationActive={false}
            >
              {slices.map((s) => (
                <Cell key={s.key} fill={s.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-xl font-semibold tabular-nums">{fmtCompact(total)}</span>
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            {centerLabel ?? 'users'}
          </span>
        </div>
      </div>
      <DonutLegend slices={slices} />
    </div>
  );
});

export { PhaseDonut };
