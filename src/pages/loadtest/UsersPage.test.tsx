/**
 * UsersPage — render + sort call (server-side) + filter (debounce 300ms).
 * Mock loadtest-api + store (không cần server thật; poll tắt khi run idle).
 * FIX-1: header/cell cùng USERS_COLUMNS — test thứ tự cột khớp dữ liệu render.
 * FIX-3: request seq — response cũ (out-of-order) không ghi đè rows mới.
 * FIX-4: API lỗi → banner error (không hiển thị text empty-filter).
 * FIX-6: header + rows nằm CÙNG scroll container (không lệch khi cuộn ngang mobile).
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import UsersPage, { USERS_COLUMNS } from '@/pages/loadtest/UsersPage';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { UserPhase, VirtualUserRow } from '@/types/loadtest';

const mocks = vi.hoisted(() => ({
  users: vi.fn(),
  toApiError: vi.fn(),
}));

vi.mock('@/lib/loadtest-api', () => ({
  loadtestApi: { users: mocks.users },
  toApiError: mocks.toApiError,
}));

// Store state mutable — FIX-4 test cần isRunning=true (bảng render thay cho noRunYet).
const storeState = vi.hoisted(() => ({ phase: 'idle' as string, isRunning: false, runId: 'run-test' }));

// Store: run idle → không poll interval (test không dính timer).
vi.mock('@/store/loadtest.store', () => ({
  useLoadtestStore: (selector: (s: unknown) => unknown) => selector(storeState),
}));

function makeRow(index: number, email: string, phase: UserPhase): VirtualUserRow {
  return {
    index,
    email,
    phase,
    currentAction: phase === 'in_room' ? 'chat' : null,
    lastActionAt: phase === 'in_room' ? Date.now() - 5000 : null,
    lastActionMs: null,
    messagesSent: 0,
    messagesEchoed: 0,
    roomId: phase === 'in_room' ? 'room-1' : null,
    socketConnected: phase !== 'failed',
    reconnectCount: 0,
    outboxPending: 0,
    lastError: null,
  };
}

// jsdom không có layout → offsetHeight/offsetWidth = 0 → react-virtual đo scroll
// container 0px và render 0 row. Getter giả: virtualizer thấy container có kích thước.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() { return 600; } });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return 800; } });
});

const ROWS = [makeRow(0, 'a@test.local', 'in_room'), makeRow(1, 'b@test.local', 'queued')];

/** Scroll container chung của bảng (FIX-6): ancestor role="table" của 1 row. */
function tableOf(el: HTMLElement): Element | null {
  return el.closest('[role="table"]');
}

beforeEach(() => {
  storeState.phase = 'idle';
  storeState.isRunning = false;
  mocks.users.mockReset();
  mocks.users.mockResolvedValue({
    rows: ROWS,
    total: 2,
    offset: 0,
    limit: 500,
    sortBy: 'index',
    sortDir: 'asc',
    phaseCounts: { in_room: 1, queued: 1 },
  });
});

function renderPage() {
  return render(
    <TooltipProvider>
      <MemoryRouter><UsersPage /></MemoryRouter>
    </TooltipProvider>,
  );
}

describe('UsersPage', () => {
  it('render bảng với rows từ API (mặc định sortBy index asc)', async () => {
    renderPage();
    expect(await screen.findByText('a@test.local')).toBeInTheDocument();
    expect(screen.getByText('b@test.local')).toBeInTheDocument();
    // badge phase (table + donut legend đều hiển thị) + action label
    expect(screen.getAllByText('Trong phòng').length).toBeGreaterThan(0);
    expect(screen.getByText('Đang chat')).toBeInTheDocument();
    // gọi API mặc định index asc, không filter
    expect(mocks.users).toHaveBeenCalledWith({
      offset: 0,
      limit: 500,
      filter: undefined,
      phase: undefined,
      sortBy: 'index',
      sortDir: 'asc',
    });
  });

  it('click header sort → gọi lại API sortBy/sortDir; click lần 2 đảo desc', async () => {
    renderPage();
    await screen.findByText('a@test.local');

    fireEvent.click(screen.getByRole('button', { name: 'Phase' }));
    await waitFor(() =>
      expect(mocks.users).toHaveBeenLastCalledWith(
        expect.objectContaining({ sortBy: 'phase', sortDir: 'asc' }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Phase' }));
    await waitFor(() =>
      expect(mocks.users).toHaveBeenLastCalledWith(
        expect.objectContaining({ sortBy: 'phase', sortDir: 'desc' }),
      ),
    );
  });

  it('sort cột khác → chuyển về asc', async () => {
    renderPage();
    await screen.findByText('a@test.local');

    fireEvent.click(screen.getByRole('button', { name: 'Phase' }));
    await waitFor(() =>
      expect(mocks.users).toHaveBeenLastCalledWith(expect.objectContaining({ sortBy: 'phase', sortDir: 'asc' })),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() =>
      expect(mocks.users).toHaveBeenLastCalledWith(expect.objectContaining({ sortBy: 'reconnectCount', sortDir: 'asc' })),
    );
  });

  it('search email (debounce 300ms) → gọi API với filter', async () => {
    renderPage();
    await screen.findByText('a@test.local');

    fireEvent.change(screen.getByRole('textbox', { name: 'Tìm theo email' }), { target: { value: 'b@' } });
    await waitFor(
      () =>
        expect(mocks.users).toHaveBeenLastCalledWith(
          expect.objectContaining({ filter: 'b@', sortBy: 'index', sortDir: 'asc' }),
        ),
      { timeout: 2000 },
    );
  });

  it('empty state khi chưa có run', async () => {
    mocks.users.mockResolvedValue({ rows: [], total: 0, offset: 0, limit: 500, sortBy: 'index', sortDir: 'asc', phaseCounts: {} });
    renderPage();
    expect(await screen.findByText(/Chưa có run nào/)).toBeInTheDocument();
  });

  // ─── FIX-1: header + cell cùng nguồn USERS_COLUMNS — không lệch cột ───────────
  it('header order khớp USERS_COLUMNS; cell render ĐÚNG cột tương ứng (FIX-1)', async () => {
    const rich = makeRow(0, 'a@test.local', 'in_room');
    rich.roomId = 'room-42';
    rich.socketConnected = true;
    rich.reconnectCount = 7;
    rich.outboxPending = 3;
    rich.lastError = 'NO_ECHO_TIMEOUT';
    rich.lastActionAt = Date.now() - 5000;
    mocks.users.mockResolvedValue({
      rows: [rich], total: 1, offset: 0, limit: 500, sortBy: 'index', sortDir: 'asc', phaseCounts: { in_room: 1 },
    });
    renderPage();
    await screen.findByText('a@test.local');

    const rows = screen.getAllByRole('row');
    const header = rows[0];
    const headerCells = Array.from(header.querySelectorAll(':scope > *')) as HTMLElement[];
    expect(headerCells.length).toBe(USERS_COLUMNS.length);
    // Thứ tự header = thứ tự USERS_COLUMNS (canonical) — trước fix: Reconnect/Outbox/
    // Hoạt động đứng TRƯỚC Room/Socket trong header nhưng sau chúng trong cell.
    expect(headerCells.map((c) => c.textContent?.trim())).toEqual(USERS_COLUMNS.map((c) => c.label));

    const bodyCells = Array.from(rows[1].querySelectorAll(':scope > *')) as HTMLElement[];
    expect(bodyCells.length).toBe(USERS_COLUMNS.length);
    // Cột 5 (Room) nhận roomId; 6 (Socket) icon; 7 (Reconnect) 7; 8 (Outbox) 3;
    // 9 (Hoạt động) thời gian tương đối; 10 (Lỗi gần nhất) lastError.
    expect(bodyCells[4].textContent).toContain('room-42');
    expect(bodyCells[5].querySelector('[aria-label="Socket đã kết nối"]')).not.toBeNull();
    expect(bodyCells[6].textContent).toBe('7');
    expect(bodyCells[7].textContent).toBe('3');
    expect(bodyCells[8].textContent).toContain('giây trước');
    expect(bodyCells[9].textContent).toContain('NO_ECHO_TIMEOUT');
  });

  // ─── FIX-3: stale response race — request seq ────────────────────────────────
  it('response cũ (chậm hơn request mới) KHÔNG ghi đè rows (FIX-3)', async () => {
    let resolveOld!: (v: unknown) => void;
    const oldPromise = new Promise((r) => { resolveOld = r as (v: unknown) => void; });
    const freshRow = makeRow(0, 'fresh@test.local', 'idle');
    const oldRow = makeRow(1, 'old@test.local', 'idle');
    // Gọi 1 (mount): pending — "chậm". Gọi 2 (sort): resolve ngay — "mới".
    mocks.users
      .mockReturnValueOnce(oldPromise)
      .mockResolvedValueOnce({ rows: [freshRow], total: 1, offset: 0, limit: 500, sortBy: 'phase', sortDir: 'asc', phaseCounts: {} });
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Phase' })); // gọi 2 — fresh
    expect(await screen.findByText('fresh@test.local')).toBeInTheDocument();

    act(() => {
      resolveOld({ rows: [oldRow], total: 1, offset: 0, limit: 500, sortBy: 'index', sortDir: 'asc', phaseCounts: {} });
    });
    await waitFor(() => expect(screen.queryByText('old@test.local')).not.toBeInTheDocument());
    expect(screen.getByText('fresh@test.local')).toBeInTheDocument();
  });

  // ─── FIX-4: API lỗi → banner error riêng, KHÔNG hiển thị empty-filter ─────────
  it('API lỗi → banner error, không hiển thị "Không có user phù hợp bộ lọc" (FIX-4)', async () => {
    storeState.phase = 'steady';
    storeState.isRunning = true; // bảng render (không phải noRunYet)
    mocks.users.mockRejectedValue(new Error('network down'));
    renderPage();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('alert').textContent).toContain('Không lấy được danh sách user');
    expect(screen.queryByText('Không có user phù hợp bộ lọc')).not.toBeInTheDocument();
  });

  // ─── FIX-6: header + body CÙNG scroll container (cuộn ngang mobile không lệch) ──
  it('header và rows nằm trong CÙNG scroll container (FIX-6)', async () => {
    renderPage();
    await screen.findByText('a@test.local');
    const rows = screen.getAllByRole('row');
    const table = tableOf(rows[0]);
    expect(table).not.toBeNull();
    // mọi row (header + body) chung 1 role="table" (scroll container duy nhất)
    for (const r of rows) expect(tableOf(r)).toBe(table);
  });
});
