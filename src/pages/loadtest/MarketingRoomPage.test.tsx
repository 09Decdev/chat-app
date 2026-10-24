/**
 * MarketingRoomPage — tìm user (debounce) → chọn người rảnh → tạo phòng mới / thêm vào phòng có sẵn;
 * mở ô chat cho thành viên trong pool; báo lỗi server. Mock loadtest-api + MarketingChatPane.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MarketingRoomPage from '@/pages/loadtest/MarketingRoomPage';
import type { ChatAdminRoom, ChatAdminUser } from '@/lib/loadtest-api';

const mocks = vi.hoisted(() => ({
  searchChatUsers: vi.fn(),
  listChatRooms: vi.fn(),
  createChatRoom: vi.fn(),
  addChatRoomMembers: vi.fn(),
  reconcile: vi.fn(),
  leave: vi.fn(),
}));

vi.mock('@/lib/loadtest-api', () => ({
  loadtestApi: {
    searchChatUsers: mocks.searchChatUsers,
    listChatRooms: mocks.listChatRooms,
    createChatRoom: mocks.createChatRoom,
    addChatRoomMembers: mocks.addChatRoomMembers,
  },
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

const user = (id: string, over: Partial<ChatAdminUser> = {}): ChatAdminUser => ({
  id,
  displayName: `User ${id}`,
  avatarUrl: null,
  email: `${id}@x`,
  phoneNumber: null,
  matchedBy: 'name',
  roomId: null,
  inPool: false,
  poolEmail: null,
  ...over,
});

const room = (roomId: string, memberCount: number, members: ChatAdminRoom['members'] = []): ChatAdminRoom => ({
  roomId,
  memberCount,
  capacity: 6,
  curated: true,
  createdAt: null,
  expiresAt: null,
  members,
});

function renderPage() {
  return render(
    <MemoryRouter>
      <MarketingRoomPage />
    </MemoryRouter>,
  );
}

async function search(term: string) {
  fireEvent.change(screen.getByLabelText('Tìm user'), { target: { value: term } });
  await waitFor(() => expect(mocks.searchChatUsers).toHaveBeenCalledWith(term, 30));
}

describe('MarketingRoomPage', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocks.listChatRooms.mockResolvedValue({ rows: [] });
    mocks.searchChatUsers.mockResolvedValue({ rows: [] });
  });

  it('user đang ở phòng → không chọn được; người rảnh chọn được', async () => {
    mocks.searchChatUsers.mockResolvedValue({ rows: [user('a'), user('b', { roomId: 'r-busy-0001' })] });
    renderPage();
    await search('user');
    const list = await screen.findByRole('list', { name: 'Kết quả tìm user' });
    expect(within(list).getByRole('button', { name: /Đang ở phòng User b/ })).toBeDisabled();
    fireEvent.click(within(list).getByRole('button', { name: 'Chọn User a' }));
    expect(within(list).getByRole('button', { name: 'Đã chọn User a' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Tạo phòng 1 người' })).toBeDisabled(); // phòng mới cần ≥ 2
  });

  it('tạo phòng mới với người đã chọn → mở ô chat cho người trong pool', async () => {
    mocks.searchChatUsers.mockResolvedValue({
      rows: [user('a', { inPool: true, poolEmail: 'pool-a@x' }), user('b')],
    });
    mocks.createChatRoom.mockResolvedValue({ roomId: 'r-new-12345678', roomEndsAt: 1 });
    renderPage();
    await search('user');
    fireEvent.click(await screen.findByRole('button', { name: 'Chọn User a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chọn User b' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tạo phòng 2 người' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Đã tạo phòng …12345678 với 2 người'));
    expect(mocks.createChatRoom).toHaveBeenCalledWith(['a', 'b']);
    expect(screen.getAllByTestId('pane').map((p) => p.textContent)).toEqual(['pool-a@x']);
  });

  it('thêm vào phòng có sẵn (chọn đích từ danh sách phòng)', async () => {
    mocks.listChatRooms.mockResolvedValue({ rows: [room('r-old-00000001', 4)] });
    mocks.searchChatUsers.mockResolvedValue({ rows: [user('c')] });
    mocks.addChatRoomMembers.mockResolvedValue({ roomId: 'r-old-00000001', roomEndsAt: 1 });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Chọn làm đích' }));
    await search('c');
    fireEvent.click(await screen.findByRole('button', { name: 'Chọn User c' }));
    fireEvent.click(screen.getByRole('button', { name: 'Thêm 1 người vào phòng' }));
    await waitFor(() => expect(mocks.addChatRoomMembers).toHaveBeenCalledWith('r-old-00000001', ['c']));
  });

  it('server từ chối → hiện message', async () => {
    mocks.searchChatUsers.mockResolvedValue({ rows: [user('a'), user('b')] });
    mocks.createChatRoom.mockRejectedValue({ message: 'User b đang ở phòng r9 — cần rời phòng trước' });
    renderPage();
    await search('user');
    fireEvent.click(await screen.findByRole('button', { name: 'Chọn User a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Chọn User b' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tạo phòng 2 người' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('đang ở phòng r9'));
  });

  it('phòng đang hoạt động: click thành viên trong pool → mở ô chat; ngoài pool → không', async () => {
    mocks.listChatRooms.mockResolvedValue({
      rows: [
        room('r1', 2, [
          { userId: 'p', displayName: 'Pool P', avatarUrl: null, inPool: true, poolEmail: 'p@x' },
          { userId: 'x', displayName: 'Real X', avatarUrl: null, inPool: false, poolEmail: null },
        ]),
      ],
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Pool P' }));
    expect(screen.getAllByTestId('pane').map((p) => p.textContent)).toEqual(['p@x']);
    expect(screen.getByRole('button', { name: 'Real X' })).toBeDisabled();
  });

  it('"Cho các ô rời phòng" (đã xác nhận) → mọi ô leave', async () => {
    localStorage.setItem('loadtest.marketingRoom.v2', JSON.stringify({ panes: ['a@x', 'b@x'] }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: /Cho các ô rời phòng/ }));
    expect(mocks.leave).toHaveBeenCalledTimes(2);
  });
});
