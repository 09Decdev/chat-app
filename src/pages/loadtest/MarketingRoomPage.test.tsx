/**
 * MarketingRoomPage — chọn account (khôi phục từ localStorage) → "Tạo phòng" gửi đúng emails,
 * hiện ô chat cho từng người, báo lỗi server (vd account đang ở phòng khác).
 * Mock loadtest-api + MarketingChatPane (không mở socket thật).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MarketingRoomPage from '@/pages/loadtest/MarketingRoomPage';

const mocks = vi.hoisted(() => ({
  searchAccounts: vi.fn(),
  createMarketingRoom: vi.fn(),
  reconcile: vi.fn(),
  leave: vi.fn(),
}));

vi.mock('@/lib/loadtest-api', () => ({
  loadtestApi: { searchAccounts: mocks.searchAccounts, createMarketingRoom: mocks.createMarketingRoom },
  toApiError: (e: { message?: string }) => ({ message: e?.message ?? 'lỗi' }),
}));

vi.mock('@/components/loadtest/marketing-chat-pane', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    MarketingChatPane: forwardRef<unknown, { email: string }>(function Pane({ email }, ref) {
      useImperativeHandle(ref, () => ({ reconcile: mocks.reconcile, leave: mocks.leave }));
      return <div data-testid="pane">{email}</div>;
    }),
  };
});

function renderPage() {
  return render(
    <MemoryRouter>
      <MarketingRoomPage />
    </MemoryRouter>,
  );
}

describe('MarketingRoomPage', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.searchAccounts.mockResolvedValue({ rows: [] });
  });

  it('chưa chọn ai → nút tạo phòng bị khóa, không có ô chat', async () => {
    renderPage();
    await waitFor(() => expect(mocks.searchAccounts).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /Tạo phòng/ })).toBeDisabled();
    expect(screen.queryAllByTestId('pane')).toHaveLength(0);
  });

  it('đủ người → tạo phòng với me + các ô, ô chat đọc lại my-room', async () => {
    localStorage.setItem(
      'loadtest.marketingRoom',
      JSON.stringify({ me: 'Me@x', panes: ['a@x', 'b@x', '', 'c@x', ''], layout: 'grid' }),
    );
    mocks.createMarketingRoom.mockResolvedValue({ roomId: 'r1', roomEndsAt: 1, members: [{}, {}, {}, {}] });
    renderPage();

    expect(screen.getAllByTestId('pane').map((p) => p.textContent)).toEqual(['a@x', 'b@x', 'c@x']);
    fireEvent.click(screen.getByRole('button', { name: 'Tạo phòng 4 người' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Đã tạo phòng r1'));
    expect(mocks.createMarketingRoom).toHaveBeenCalledWith(['me@x', 'a@x', 'b@x', 'c@x']);
    expect(mocks.reconcile).toHaveBeenCalledTimes(3);
  });

  it('"Cho các ô rời phòng" (đã xác nhận) → mọi ô leave', () => {
    localStorage.setItem('loadtest.marketingRoom', JSON.stringify({ me: 'me@x', panes: ['a@x', 'b@x'] }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Cho các ô rời phòng/ }));
    expect(mocks.leave).toHaveBeenCalledTimes(2);
  });

  it('chọn trùng → báo lỗi, khóa nút', () => {
    localStorage.setItem('loadtest.marketingRoom', JSON.stringify({ me: 'a@x', panes: ['A@x'] }));
    renderPage();
    expect(screen.getByText('Có tài khoản bị chọn trùng.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Tạo phòng/ })).toBeDisabled();
  });

  it('server từ chối → hiện message', async () => {
    localStorage.setItem('loadtest.marketingRoom', JSON.stringify({ me: 'me@x', panes: ['a@x'] }));
    mocks.createMarketingRoom.mockRejectedValue({ message: 'User a@x đang ở phòng r9 — cần rời phòng trước' });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Tạo phòng 2 người' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('a@x đang ở phòng r9'));
  });
});
