/**
 * Phòng marketing — quay video:
 * 1. Tìm user toàn hệ thống (id/email/SĐT khớp chính xác, tên gần đúng bỏ dấu) — thấy ngay ai đang rảnh.
 * 2. Click chọn (chỉ user đang không ở phòng nào) → tạo phòng mới HOẶC thêm vào phòng đang có.
 * 3. Danh sách phòng đang hoạt động; account có trong pool mở được ô chat để gõ tay thay user đó.
 * API: content-service internal (qua loadtest server) — phòng chỉ định không nhận người lạ.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Maximize2,
  Minimize2,
  Loader2,
  Search,
  RefreshCw,
  X,
  Plus,
  MessageSquare,
  LogOut,
  CheckCircle2,
  Lock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { UserAvatar } from '@/components/chat/UserAvatar';
import { MarketingChatPane, type MarketingChatPaneHandle } from '@/components/loadtest/marketing-chat-pane';
import { loadtestApi, toApiError, type ChatAdminRoom, type ChatAdminUser } from '@/lib/loadtest-api';
import { cn } from '@/lib/utils';

const MAX_MEMBERS = 6;
const MAX_PANES = 6;
const STORAGE_KEY = 'loadtest.marketingRoom.v2';
const NEW_ROOM = '__new__';

type Layout = 'grid' | 'row';
interface Saved {
  panes: string[];
  layout: Layout;
}

function loadSaved(): Saved {
  try {
    const p = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Saved>;
    return {
      panes: Array.isArray(p.panes) ? p.panes.filter((e): e is string => typeof e === 'string').slice(0, MAX_PANES) : [],
      layout: p.layout === 'row' ? 'row' : 'grid',
    };
  } catch {
    return { panes: [], layout: 'grid' };
  }
}

function shortRoom(id: string) {
  return id.length > 10 ? `…${id.slice(-8)}` : id;
}

const MATCH_LABEL: Record<string, string> = { id: 'Khớp userId', email: 'Khớp email', phone: 'Khớp SĐT', name: 'Theo tên' };

export default function MarketingRoomPage() {
  const initial = useMemo(loadSaved, []);
  const [layout, setLayout] = useState<Layout>(initial.layout);
  const [panes, setPanes] = useState<string[]>(initial.panes);
  const [full, setFull] = useState(false);
  const paneRefs = useRef(new Map<string, MarketingChatPaneHandle>());

  // ── Tìm user ──
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ChatAdminUser[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  // ── Chọn + đích ──
  const [selected, setSelected] = useState<ChatAdminUser[]>([]);
  const [target, setTarget] = useState<string>(NEW_ROOM);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);

  // ── Phòng ──
  const [rooms, setRooms] = useState<ChatAdminRoom[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(false);
  const [roomsError, setRoomsError] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ panes, layout }));
    } catch {
      /* private mode */
    }
  }, [panes, layout]);

  const runSearch = useCallback(async (term: string) => {
    const seq = ++searchSeq.current;
    if (!term.trim()) {
      setResults([]);
      setSearchError(null);
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const res = await loadtestApi.searchChatUsers(term.trim(), 30);
      if (seq === searchSeq.current) setResults(res.rows);
    } catch (e) {
      if (seq === searchSeq.current) setSearchError(toApiError(e).message);
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void runSearch(q), 350);
    return () => clearTimeout(t);
  }, [q, runSearch]);

  const fetchRooms = useCallback(async () => {
    setRoomsLoading(true);
    setRoomsError(null);
    try {
      const res = await loadtestApi.listChatRooms();
      setRooms(res.rows);
    } catch (e) {
      setRoomsError(toApiError(e).message);
    } finally {
      setRoomsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRooms();
    const iv = setInterval(() => void fetchRooms(), 15000);
    return () => clearInterval(iv);
  }, [fetchRooms]);

  const targetRoom = rooms.find((r) => r.roomId === target) ?? null;
  const freeSlots = targetRoom ? targetRoom.capacity - targetRoom.memberCount : MAX_MEMBERS;
  const selectedIds = new Set(selected.map((u) => u.id));

  const pick = (u: ChatAdminUser) => {
    if (u.roomId || selectedIds.has(u.id) || selected.length >= MAX_MEMBERS) return;
    setSelected((prev) => [...prev, u]);
    setActionOk(null);
  };
  const unpick = (id: string) => setSelected((prev) => prev.filter((u) => u.id !== id));

  const openPane = (email: string) =>
    setPanes((prev) => (prev.includes(email) || prev.length >= MAX_PANES ? prev : [...prev, email]));
  const closePane = (email: string) => setPanes((prev) => prev.filter((e) => e !== email));

  const canSubmit =
    !busy && (target === NEW_ROOM ? selected.length >= 2 : selected.length >= 1 && selected.length <= freeSlots);

  const submit = async () => {
    setBusy(true);
    setActionError(null);
    setActionOk(null);
    const ids = selected.map((u) => u.id);
    try {
      const res =
        target === NEW_ROOM
          ? await loadtestApi.createChatRoom(ids)
          : await loadtestApi.addChatRoomMembers(target, ids);
      setActionOk(
        target === NEW_ROOM
          ? `Đã tạo phòng ${shortRoom(res.roomId)} với ${ids.length} người.`
          : `Đã thêm ${ids.length} người vào phòng ${shortRoom(res.roomId)}.`,
      );
      // Mở sẵn ô chat cho người có trong pool (còn chỗ)
      selected.forEach((u) => u.poolEmail && openPane(u.poolEmail));
      setSelected([]);
      setTarget(res.roomId);
      void fetchRooms();
      void runSearch(q);
      paneRefs.current.forEach((p) => p.reconcile());
    } catch (e) {
      setActionError(toApiError(e).message);
    } finally {
      setBusy(false);
    }
  };

  const gridClass =
    layout === 'row'
      ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-6'
      : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';

  const paneGrid = (
    <div className={cn('grid min-h-0 flex-1 gap-3', gridClass, full ? 'auto-rows-fr' : 'auto-rows-[minmax(26rem,1fr)]')}>
      {panes.map((email, i) => (
        <div key={email} className="relative min-h-0">
          <MarketingChatPane
            ref={(h) => {
              if (h) paneRefs.current.set(email, h);
              else paneRefs.current.delete(email);
            }}
            email={email}
            label={`Ô ${i + 1}`}
          />
          {!full && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1 h-7 w-7"
              onClick={() => closePane(email)}
              aria-label={`Đóng ô chat ${email}`}
            >
              <X className="h-4 w-4" aria-hidden />
            </Button>
          )}
        </div>
      ))}
    </div>
  );

  if (full) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-background p-3">
        {paneGrid}
        <Button
          variant="outline"
          size="sm"
          className="fixed bottom-3 right-3 min-h-9 opacity-30 hover:opacity-100 focus-visible:opacity-100"
          onClick={() => setFull(false)}
        >
          <Minimize2 className="h-4 w-4" aria-hidden /> Thoát full
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold">Phòng marketing</h1>
        <p className="text-sm text-muted-foreground">
          Tìm user → click chọn người đang rảnh → tạo phòng mới hoặc thêm vào phòng đang có. Người có trong pool mở được ô
          chat để bạn gõ tay thay họ.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── 1. Tìm user ── */}
        <Card className="flex min-h-0 flex-col gap-3 p-4">
          <h2 className="text-sm font-semibold">1. Tìm user</h2>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Tên (không cần dấu), email, SĐT hoặc userId"
              className="h-10 pl-9"
              aria-label="Tìm user"
            />
            {searching && (
              <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-label="Đang tìm" />
            )}
          </div>
          {searchError && <p className="text-sm text-destructive" role="alert">{searchError}</p>}
          <ul className="max-h-[26rem] min-h-0 divide-y divide-border overflow-y-auto rounded-md border border-border" aria-label="Kết quả tìm user">
            {results.length === 0 && (
              <li className="p-3 text-sm text-muted-foreground">{q.trim() ? (searching ? 'Đang tìm…' : 'Không có kết quả.') : 'Gõ để tìm.'}</li>
            )}
            {results.map((u) => {
              const busyUser = !!u.roomId;
              const chosen = selectedIds.has(u.id);
              const disabled = busyUser || chosen || selected.length >= MAX_MEMBERS;
              return (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => pick(u)}
                    disabled={disabled}
                    className={cn(
                      'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors',
                      disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-accent',
                      chosen && 'bg-primary/10 opacity-100',
                    )}
                    aria-label={`${chosen ? 'Đã chọn' : busyUser ? 'Đang ở phòng' : 'Chọn'} ${u.displayName ?? u.email ?? u.id}`}
                  >
                    <UserAvatar name={u.displayName} userId={u.id} url={u.avatarUrl} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{u.displayName || '(chưa đặt tên)'}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {[u.email, u.phoneNumber].filter(Boolean).join(' · ') || u.id}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className="text-[10px] text-muted-foreground">{MATCH_LABEL[u.matchedBy] ?? u.matchedBy}</span>
                      <div className="flex gap-1">
                        {u.inPool && <Badge variant="secondary" className="text-[10px]">Pool</Badge>}
                        {busyUser ? (
                          <Badge variant="warning" className="text-[10px]">Đang ở phòng {shortRoom(u.roomId!)}</Badge>
                        ) : chosen ? (
                          <Badge className="text-[10px]">Đã chọn</Badge>
                        ) : (
                          <Badge variant="success" className="text-[10px]">Rảnh</Badge>
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>

        {/* ── 2. Xếp vào phòng ── */}
        <Card className="flex flex-col gap-3 p-4">
          <h2 className="text-sm font-semibold">2. Xếp vào phòng ({selected.length}/{MAX_MEMBERS} người đã chọn)</h2>
          <div className="flex min-h-10 flex-wrap gap-2">
            {selected.length === 0 && <p className="text-sm text-muted-foreground">Click user ở bên trái để chọn.</p>}
            {selected.map((u) => (
              <span key={u.id} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary py-1 pl-1 pr-2 text-sm">
                <UserAvatar name={u.displayName} userId={u.id} url={u.avatarUrl} size="sm" className="h-6 w-6" />
                {u.displayName || u.email || u.id.slice(0, 8)}
                <button type="button" onClick={() => unpick(u.id)} className="rounded-full p-0.5 hover:bg-accent" aria-label={`Bỏ chọn ${u.displayName ?? u.id}`}>
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </span>
            ))}
          </div>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Đích</span>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              aria-label="Chọn phòng đích"
            >
              <option value={NEW_ROOM}>+ Tạo phòng mới (người lạ không vào được)</option>
              {rooms
                .filter((r) => r.memberCount < r.capacity)
                .map((r) => (
                  <option key={r.roomId} value={r.roomId}>
                    Phòng {shortRoom(r.roomId)} · {r.memberCount}/{r.capacity} · {r.members.map((m) => m.displayName || m.userId.slice(0, 6)).join(', ')}
                  </option>
                ))}
            </select>
          </label>

          {target !== NEW_ROOM && selected.length > freeSlots && (
            <p className="text-sm text-destructive">Phòng này chỉ còn {freeSlots} chỗ.</p>
          )}
          {actionError && <p className="text-sm text-destructive" role="alert">{actionError}</p>}
          {actionOk && (
            <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400" role="status">
              <CheckCircle2 className="h-4 w-4" aria-hidden /> {actionOk} Người dùng thật mở app vào mục chat là thấy phòng.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void submit()} disabled={!canSubmit} className="min-h-10">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
              {target === NEW_ROOM ? `Tạo phòng ${selected.length} người` : `Thêm ${selected.length} người vào phòng`}
            </Button>
            {selected.length > 0 && (
              <Button variant="ghost" onClick={() => setSelected([])} className="min-h-10">
                Bỏ chọn hết
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Phòng mới cần ít nhất 2 người. Chỉ chọn được người đang không ở phòng nào; phòng tồn tại 3 giờ.
          </p>
        </Card>
      </div>

      {/* ── 3. Phòng đang hoạt động ── */}
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">3. Phòng đang hoạt động ({rooms.length})</h2>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => void fetchRooms()} disabled={roomsLoading}>
            <RefreshCw className={cn('h-4 w-4', roomsLoading && 'animate-spin')} aria-hidden /> Tải lại
          </Button>
        </div>
        {roomsError && <p className="text-sm text-destructive" role="alert">{roomsError}</p>}
        {rooms.length === 0 && !roomsError && <p className="text-sm text-muted-foreground">Chưa có phòng nào.</p>}
        <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {rooms.map((r) => {
            const poolMembers = r.members.filter((m) => m.poolEmail);
            return (
              <li key={r.roomId} className={cn('rounded-lg border border-border p-3', target === r.roomId && 'ring-2 ring-primary')}>
                <div className="mb-2 flex items-center gap-2 text-sm">
                  <span className="font-mono font-medium">{shortRoom(r.roomId)}</span>
                  <Badge variant="secondary" className="text-[10px]">{r.memberCount}/{r.capacity}</Badge>
                  {r.curated && (
                    <Badge variant="outline" className="gap-1 text-[10px]">
                      <Lock className="h-3 w-3" aria-hidden /> Chỉ định
                    </Badge>
                  )}
                  {r.memberCount < r.capacity && (
                    <Button variant="link" size="sm" className="ml-auto h-auto p-0 text-xs" onClick={() => setTarget(r.roomId)}>
                      Chọn làm đích
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {r.members.map((m) => {
                    const open = !!m.poolEmail && panes.includes(m.poolEmail);
                    return (
                      <button
                        key={m.userId}
                        type="button"
                        disabled={!m.poolEmail}
                        onClick={() => m.poolEmail && (open ? closePane(m.poolEmail) : openPane(m.poolEmail))}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
                          open ? 'border-primary bg-primary/15' : 'border-border',
                          m.poolEmail ? 'hover:bg-accent' : 'cursor-default opacity-70',
                        )}
                        title={m.poolEmail ? (open ? 'Đóng ô chat' : 'Mở ô chat') : 'Không có trong pool — không mở được ô chat'}
                      >
                        {m.poolEmail && <MessageSquare className="h-3 w-3" aria-hidden />}
                        {m.displayName || m.userId.slice(0, 8)}
                      </button>
                    );
                  })}
                </div>
                {poolMembers.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2 h-8 text-xs"
                    onClick={() => poolMembers.forEach((m) => openPane(m.poolEmail!))}
                  >
                    Mở ô chat cả phòng ({poolMembers.length})
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      {/* ── 4. Ô chat ── */}
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">4. Ô chat ({panes.length}/{MAX_PANES})</h2>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <span className="text-xs text-muted-foreground">Bố cục:</span>
          <Button variant={layout === 'grid' ? 'default' : 'outline'} size="sm" onClick={() => setLayout('grid')} aria-pressed={layout === 'grid'}>
            3 cột
          </Button>
          <Button variant={layout === 'row' ? 'default' : 'outline'} size="sm" onClick={() => setLayout('row')} aria-pressed={layout === 'row'}>
            1 hàng
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={panes.length === 0}
            onClick={() => {
              if (!window.confirm('Cho tất cả tài khoản đang mở ô chat rời phòng hiện tại?')) return;
              paneRefs.current.forEach((p) => p.leave());
              setTimeout(() => void fetchRooms(), 1000);
            }}
          >
            <LogOut className="h-4 w-4" aria-hidden /> Cho các ô rời phòng
          </Button>
          <Button variant="outline" size="sm" onClick={() => setFull(true)} disabled={panes.length === 0}>
            <Maximize2 className="h-4 w-4" aria-hidden /> Full màn hình
          </Button>
        </div>
      </div>
      {panes.length > 0 ? (
        paneGrid
      ) : (
        <p className="text-sm text-muted-foreground">Mở ô chat từ danh sách phòng (thành viên có biểu tượng tin nhắn là người trong pool).</p>
      )}
    </div>
  );
}
