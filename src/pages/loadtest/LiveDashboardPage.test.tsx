/**
 * LiveDashboardPage — T6 connect metrics (UI-SPEC §6).
 * Mock store (tick mutable) + loadtest-api — không cần server thật.
 * Test 6 trường hợp: tile/không danger · danger strip · attempts 0 (D4) ·
 * totalFails 0 · donut failed slice · replay hasConnectData=false (UI-1).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LiveDashboardPage from '@/pages/loadtest/LiveDashboardPage';
import { connectFailBreakdown, connectFailVariant } from '@/components/loadtest/connect-fail';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { LoadTestTick } from '@/types/loadtest';

const mocks = vi.hoisted(() => ({
  errors: vi.fn(),
}));

vi.mock('@/lib/loadtest-api', () => ({
  loadtestApi: { errors: mocks.errors },
}));

// Store state mutable — mỗi test set tick/phase riêng (pattern UsersPage.test.tsx).
const storeState = vi.hoisted(() => ({
  ticks: [] as LoadTestTick[],
  lastTick: null as LoadTestTick | null,
  phase: 'steady' as string,
  stopReason: '',
}));

vi.mock('@/store/loadtest.store', () => ({
  useLoadtestStore: (selector: (s: unknown) => unknown) => selector(storeState),
}));

function makeTick(
  over: {
    counters?: Partial<LoadTestTick['counters']>;
    rates?: Partial<LoadTestTick['rates']>;
    hasConnectData?: boolean;
  } = {},
): LoadTestTick {
  return {
    type: 'tick',
    runId: 'run-1',
    ts: Date.now(),
    phase: 'steady',
    elapsedSec: 1,
    counters: {
      usersCreated: 1234,
      usersConnected: 900,
      usersActive: 500,
      usersQueued: 100,
      usersInRoom: 400,
      actionsTotal: 0,
      successTotal: 0,
      failTotal: 0,
      echoOk: 0,
      echoSent: 0,
      queueCount: 0,
      roomCount: 0,
      droppedOutbox: 0,
      reconnectCount: 0,
      rateLimitedNoEcho: 0,
      connectAttempts: 12400,
      connectFails: 1107,
      connectFailsByType: { timeout: 750, transport: 340, reject: 12, other: 5 },
      usersFailed: 42,
      ...over.counters,
    },
    rates: { successRate: 95, echoRate: 90, connectFailRate: 12.4, ...over.rates },
    hasConnectData: over.hasConnectData,
    actionsPerSec: {},
    latency: { p50: 1, p95: 2, p99: 3 },
    errors: [],
    server: { wsConnections: 1, wsMessagesEmitted: 1, wsMessagesPerSec: 1 },
    workers: { alive: 1, total: 1, cpuAvg: 0 },
  };
}

function setState(tick: LoadTestTick | null, phase: string, stopReason = '') {
  storeState.lastTick = tick;
  storeState.ticks = tick ? [tick] : [];
  storeState.phase = phase;
  storeState.stopReason = stopReason;
}

function renderPage() {
  return render(
    <TooltipProvider>
      <MemoryRouter>
        <LiveDashboardPage />
      </MemoryRouter>
    </TooltipProvider>,
  );
}

beforeEach(() => {
  storeState.ticks = [];
  storeState.lastTick = null;
  storeState.phase = 'steady';
  mocks.errors.mockReset();
  mocks.errors.mockResolvedValue({ top: [], samples: [] });
});

// ─── Unit: connectFailVariant (UI-SPEC §3 D4/UI-3) ─────────────────────────
describe('connectFailVariant', () => {
  it('null / replay (hasConnectData false) / attempts 0 → default (KHÔNG "0% healthy" giả)', () => {
    expect(connectFailVariant(null)).toBe('default');
    expect(connectFailVariant(makeTick({ hasConnectData: false }))).toBe('default');
    expect(connectFailVariant(makeTick({ counters: { connectAttempts: 0 } }))).toBe('default');
  });

  it('rate >= 30 → error · >= 5 → warning · < 5 → success', () => {
    expect(connectFailVariant(makeTick({ rates: { connectFailRate: 32 } }))).toBe('error');
    expect(connectFailVariant(makeTick({ rates: { connectFailRate: 12.4 } }))).toBe('warning');
    expect(connectFailVariant(makeTick({ rates: { connectFailRate: 3 } }))).toBe('success');
    expect(connectFailVariant(makeTick({ rates: { connectFailRate: 30 } }))).toBe('error');
    expect(connectFailVariant(makeTick({ rates: { connectFailRate: 5 } }))).toBe('warning');
  });
});

// ─── Unit: connectFailBreakdown (UI-SPEC §4.3 — sum(byType), UI-2) ─────────
describe('connectFailBreakdown', () => {
  it('tổng = sum(byType) (không dùng connectFails), sort desc, bỏ mục 0', () => {
    const rows = connectFailBreakdown({ timeout: 750, transport: 340, reject: 12, other: 5 });
    expect(rows.reduce((acc, r) => acc + r.count, 0)).toBe(1107);
    expect(rows.map((r) => r.key)).toEqual(['timeout', 'transport', 'reject', 'other']);
    expect(rows.map((r) => r.count)).toEqual([750, 340, 12, 5]);
    // pct chính xác cho từng loại
    expect(rows[0].pct).toBeCloseTo((750 / 1107) * 100, 5);
    expect(rows[3].pct).toBeCloseTo((5 / 1107) * 100, 5);
  });

  it('mọi loại 0 → []', () => {
    expect(connectFailBreakdown({ timeout: 0, transport: 0, reject: 0, other: 0 })).toEqual([]);
  });
});

// ─── Component: UI-SPEC §6 ─────────────────────────────────────────────────
describe('LiveDashboardPage — connect metrics (T6)', () => {
  it('tick đủ dữ liệu → tile 12.4% (warning), summary fails 1.1k (=sum byType), legend (68%), không danger strip, donut slice Lỗi + tổng = usersCreated', () => {
    setState(makeTick(), 'steady');
    renderPage();

    // Tile Connect fail (D1/D4): value 12.4 + unit %, variant warning (12.4 >= 5)
    const value = screen.getByText('12.4');
    expect(value.textContent).toContain('%');
    expect(value.className).toContain('text-warning');

    // Summary (UI-2): fails = sum(byType) = 1107 → 1.1k
    expect(screen.getByText(/fails 1\.1k/)).toBeInTheDocument();

    // Legend: pct >= 10 → Math.round; < 10 → 1 chữ số
    expect(screen.getByText('(68%)')).toBeInTheDocument();
    expect(screen.getByText('(31%)')).toBeInTheDocument();
    expect(screen.getByText('(1.1%)')).toBeInTheDocument();
    expect(screen.getByText('(0.5%)')).toBeInTheDocument();

    // Không danger strip (rate 12.4 < 30)
    expect(screen.queryByText(/auto-stop E2 sắp kích hoạt/)).not.toBeInTheDocument();

    // Donut (D7): slice "Lỗi" + tổng center = usersCreated (1234 → 1.2k)
    expect(screen.getByText('Lỗi')).toBeInTheDocument();
    expect(screen.getByText('1.2k')).toBeInTheDocument();
  });

  it('rate 32 + phase steady → danger strip hiển thị (E2 auto-stop sắp kích hoạt), tile error', () => {
    setState(makeTick({ rates: { connectFailRate: 32 } }), 'steady');
    renderPage();

    expect(screen.getByText(/auto-stop E2 sắp kích hoạt/)).toBeInTheDocument();
    expect(screen.getByRole('alert').textContent).toContain('≥ 50 attempts');
    const value = screen.getByText('32.0');
    expect(value.className).toContain('text-destructive');
  });

  it('attempts 0 (live) → tile 0.0% variant default (D4: không `--` vì lastTick tồn tại), không "0% healthy" giả', () => {
    setState(
      makeTick({
        counters: {
          connectAttempts: 0,
          connectFails: 0,
          connectFailsByType: { timeout: 0, transport: 0, reject: 0, other: 0 },
          usersFailed: 0,
        },
        rates: { connectFailRate: 0 },
      }),
      'steady',
    );
    renderPage();

    const value = screen.getByText('0.0');
    expect(value.textContent).toContain('%');
    expect(value.className).toContain('text-foreground'); // default — KHÔNG text-success
    expect(screen.getByText(/đang chờ user connect đầu tiên/)).toBeInTheDocument();
  });

  it('totalFails = 0 (attempts > 0) → "Không có connect fail trong run này", không legend', () => {
    setState(
      makeTick({
        counters: {
          connectAttempts: 12400,
          connectFails: 0,
          connectFailsByType: { timeout: 0, transport: 0, reject: 0, other: 0 },
          usersFailed: 0,
        },
        rates: { connectFailRate: 0 },
      }),
      'steady',
    );
    renderPage();

    expect(screen.getByText('Không có connect fail trong run này')).toBeInTheDocument();
    expect(screen.queryByText('timeout')).not.toBeInTheDocument();
  });

  it('replay (hasConnectData false, terminal phase) → tile -- + text lịch sử, KHÔNG "đang chờ" (UI-1)', () => {
    setState(makeTick({ hasConnectData: false }), 'finished');
    renderPage();

    expect(screen.getByText('--')).toBeInTheDocument();
    expect(
      screen.getByText(/Run lịch sử \(trước bản fix\) không lưu dữ liệu connect/),
    ).toBeInTheDocument();
    // KHÔNG empty state "đang chờ" nào cho run đã đóng băng
    expect(screen.queryByText('Đang chờ tick đầu tiên...')).not.toBeInTheDocument();
    expect(
      screen.queryByText('Chưa có dữ liệu connect — đang chờ user connect đầu tiên...'),
    ).not.toBeInTheDocument();
  });

  it('chưa có tick → card empty state #1 "Đang chờ tick đầu tiên..."', () => {
    setState(null, 'provisioning');
    renderPage();
    expect(screen.getByText('Đang chờ tick đầu tiên...')).toBeInTheDocument();
  });

  // ─── Phase 4 council: X-2 (restart) + X-5 (stopReason) ─────────────────────
  it('X-2: toàn bộ worker restart → lũy kế 0 nhưng window đỏ → text restart, KHÔNG "Không có connect fail"', () => {
    setState(
      makeTick({
        counters: {
          connectAttempts: 120, // worker restart — counter về nhỏ
          connectFails: 0,
          connectFailsByType: { timeout: 0, transport: 0, reject: 0, other: 0 },
          usersFailed: 0,
        },
        rates: { connectFailRate: 32 }, // window 60s vẫn đỏ
      }),
      'steady',
    );
    renderPage();

    expect(screen.getByText(/Số lũy kế về 0 sau worker restart/)).toBeInTheDocument();
    expect(screen.queryByText('Không có connect fail trong run này')).not.toBeInTheDocument();
    expect(screen.queryByText(/đang chờ user connect đầu tiên/)).not.toBeInTheDocument();
    // Tile vẫn đỏ (window 32%) — không bị che
    expect(screen.getByText('32.0')).toBeInTheDocument();
  });

  it('X-5: banner phase error hiển thị stopReason thật (E3-stop không còn text E1/E2)', () => {
    setState(makeTick(), 'error', 'E3: toàn bộ worker chết');
    renderPage();

    // frozen banner cũng role="alert" — assert title của banner error trực tiếp
    expect(screen.getByText('Run tự dừng: E3: toàn bộ worker chết')).toBeInTheDocument();
    expect(screen.queryByText(/register\/connect fail vượt ngưỡng/)).not.toBeInTheDocument();
  });

  it('X-5: phase error không có stopReason → fallback text E1/E2 cũ', () => {
    setState(makeTick(), 'error', '');
    renderPage();

    expect(
      screen.getByText('Run tự dừng: register/connect fail vượt ngưỡng (E1/E2)'),
    ).toBeInTheDocument();
  });
});
