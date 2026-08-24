/**
 * TicketRegisterPage — kiểm tra luồng form → chạy → hiển thị kết quả.
 * Pattern mock khớp SettingsPage.test.tsx (mock '@/lib/loadtest-api', render trong MemoryRouter).
 * Fix A: page KHÔNG unmount khi running (không còn skeleton thay thế toàn trang).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TicketRegisterPage from '@/pages/loadtest/TicketRegisterPage';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { TicketRegisterResult } from '@/types/loadtest';

const mocks = vi.hoisted(() => ({
  ticketRegister: vi.fn(),
  getConfig: vi.fn(),
  pools: vi.fn(),
  ticketSourceCommunities: vi.fn(),
  ticketSourceEvents: vi.fn(),
  ticketSourceTicketTypes: vi.fn(),
  toApiError: vi.fn(),
}));

vi.mock('@/lib/loadtest-api', () => ({
  loadtestApi: {
    ticketRegister: mocks.ticketRegister,
    getConfig: mocks.getConfig,
    pools: mocks.pools,
    ticketSourceCommunities: mocks.ticketSourceCommunities,
    ticketSourceEvents: mocks.ticketSourceEvents,
    ticketSourceTicketTypes: mocks.ticketSourceTicketTypes,
  },
  toApiError: mocks.toApiError,
}));

const MOCK_RESULT: TicketRegisterResult = {
  exitCode: 0,
  pass: true,
  summary: {
    gateway: 'http://localhost:3000',
    communityId: 'cmty-1',
    eventId: 'evt-1',
    eventTitle: 'Sự kiện test',
    ticketTypeId: 'tt-1',
    ticketTypeName: 'Vé VIP',
    quantity: 1,
    participants: 100,
    startedAt: Date.now(),
    durationMs: 5000,
    results: {
      REGISTERED: 90,
      QUEUED: 5,
      CONFLICT: 3,
      RATE_LIMITED: 1,
      FORBIDDEN: 1,
      BAD_REQUEST: 0,
      NOT_FOUND: 0,
      SERVER: 0,
      LOGIN_FAIL: 0,
      NETWORK: 0,
      OTHER: 0,
    },
    byStatus: { '201': 90, '202': 5, '409': 3, '429': 1, '403': 1 },
    errors: { SOME_ERROR: 2 },
    actionOk: 95,
    actionFail: 5,
    successRate: 95,
    latencyMs: { avg: 120, p50: 100, p95: 300, p99: 500, max: 900 },
  },
};

function mockSourceDefaults() {
  mocks.getConfig.mockResolvedValue({
    gatewayUrl: 'http://localhost:3000',
    poolFile: '',
    reportsDir: 'docs/loadtest-reports',
    allowRegister: true,
  });
  mocks.pools.mockResolvedValue({ pools: [] });
  mocks.ticketSourceCommunities.mockResolvedValue({ communities: [], gateway: 'http://localhost:3000' });
  mocks.ticketSourceEvents.mockResolvedValue({ events: [] });
  mocks.ticketSourceTicketTypes.mockResolvedValue({ ticketTypes: [] });
  mocks.toApiError.mockReturnValue({ message: 'lỗi API' });
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mockSourceDefaults();
});

function renderPage() {
  return render(
    <TooltipProvider>
      <MemoryRouter>
        <TicketRegisterPage />
      </MemoryRouter>
    </TooltipProvider>,
  );
}

describe('TicketRegisterPage', () => {
  it('chưa nhập community/event → nút chạy bị disabled, form không mất khi nhập', () => {
    renderPage();
    const runBtn = screen.getByRole('button', { name: 'Chạy ticket-register' });
    expect(runBtn).toBeDisabled();

    // Fix A: input ô nhập vẫn hiện (page không skeleton hoá), nhập thử kích hoạt nút.
    fireEvent.change(screen.getByLabelText('Community ID'), { target: { value: 'cmty-1' } });
    expect(screen.getByRole('button', { name: 'Chạy ticket-register' })).not.toBeDisabled();
  });

  it('nhập community-id + chạy → gọi API đúng body + hiển thị PASS và số liệu', async () => {
    mocks.ticketRegister.mockResolvedValue(MOCK_RESULT);
    renderPage();

    fireEvent.change(screen.getByLabelText('Community ID'), { target: { value: 'cmty-1' } });
    const runBtn = screen.getByRole('button', { name: 'Chạy ticket-register' });
    expect(runBtn).not.toBeDisabled();
    fireEvent.click(runBtn);

    expect(await screen.findByText('PASS — đạt min success rate')).toBeInTheDocument();
    expect(mocks.ticketRegister).toHaveBeenCalledTimes(1);
    const req = mocks.ticketRegister.mock.calls[0][0];
    expect(req).toMatchObject({
      communityId: 'cmty-1',
      eventId: undefined,
      ticketTypeId: undefined,
      quantity: 1,
      concurrency: 20,
      limit: undefined,
      verifyMembers: false,
      minSuccessRate: 90,
    });

    // Số liệu: success rate 95% (Gauge) + outcome theo account + latency p50.
    expect(screen.getByText('95.0%')).toBeInTheDocument();
    expect(screen.getByText('Đã đăng ký (201)')).toBeInTheDocument();
    expect(screen.getByText('100ms')).toBeInTheDocument();
    // Event name hiện ở banner KẾT QUẢ (có thể lặp ở card THÔNG TIN → getAllByText).
    expect(screen.getAllByText(/Sự kiện test/).length).toBeGreaterThan(0);

    // Fix A: kết quả render xong thì nút trở về trạng thái sẵn sàng, page vẫn hiện form.
    expect(screen.getByRole('button', { name: 'Chạy ticket-register' })).not.toBeDisabled();
  });

  it('API trả lỗi (exitCode=2 → HTTP 400) → hiện AlertBanner lỗi', async () => {
    mocks.ticketRegister.mockRejectedValue(new Error('nope'));
    mocks.toApiError.mockReturnValue({ message: 'Không tự tìm được event: cmty-1 không có event mở đăng ký' });
    renderPage();

    fireEvent.change(screen.getByLabelText('Community ID'), { target: { value: 'cmty-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Chạy ticket-register' }));

    expect(await screen.findByText('Lỗi chạy ticket-register')).toBeInTheDocument();
    expect(screen.getByText('Không tự tìm được event: cmty-1 không có event mở đăng ký')).toBeInTheDocument();
    expect(mocks.toApiError).toHaveBeenCalledTimes(1);
  });
});