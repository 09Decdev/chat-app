/**
 * ChartTooltip — format đơn vị (FIX-5: không lặp "120ms ms" khi format đã kèm đơn vị).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChartTooltip } from '@/components/loadtest/charts';
import { fmtMs } from '@/lib/loadtest-format';

const PAYLOAD = [{ dataKey: 'p50', name: 'P50', value: 120, color: '#fff' }];

describe('ChartTooltip — latency (FIX-5)', () => {
  it('format=fmtMs không kèm unit → "120ms", không lặp đơn vị "ms ms"', () => {
    render(<ChartTooltip active payload={PAYLOAD} label="12:00:00" format={fmtMs} />);
    expect(screen.getByText('120ms')).toBeInTheDocument();
    expect(screen.queryByText(/ms\s*ms/)).not.toBeInTheDocument();
  });

  it('unit prop vẫn hoạt động cho chart chưa format đơn vị (vd act/s)', () => {
    render(<ChartTooltip active payload={PAYLOAD} label="12:00:00" unit="act/s" />);
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('act/s')).toBeInTheDocument();
  });
});
