/**
 * Phòng marketing — quay video: chọn account của mình (dùng app trên điện thoại) + tối đa 5 account
 * trong pool → tạo phòng chỉ định (POST /marketing-room → content-service internal API, không qua
 * hàng chờ, người lạ không vào được) → hiện 5 ô chat để operator tự gõ dưới từng account.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minimize2, Loader2, Users, Smartphone, CheckCircle2, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { ComboBox, type ComboBoxOption } from '@/components/loadtest/combobox';
import { MarketingChatPane, type MarketingChatPaneHandle } from '@/components/loadtest/marketing-chat-pane';
import { loadtestApi, toApiError } from '@/lib/loadtest-api';
import { cn } from '@/lib/utils';

const PANE_COUNT = 5;
const STORAGE_KEY = 'loadtest.marketingRoom';

interface Saved {
  me: string;
  panes: string[];
  layout: Layout;
}
type Layout = 'grid' | 'row';

function loadSaved(): Saved {
  const empty: Saved = { me: '', panes: Array(PANE_COUNT).fill(''), layout: 'grid' };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const p = JSON.parse(raw) as Partial<Saved>;
    const panes = Array.from({ length: PANE_COUNT }, (_, i) => (typeof p.panes?.[i] === 'string' ? p.panes[i] : ''));
    return { me: typeof p.me === 'string' ? p.me : '', panes, layout: p.layout === 'row' ? 'row' : 'grid' };
  } catch {
    return empty;
  }
}

function save(s: Saved) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* private mode — bỏ qua */
  }
}

export default function MarketingRoomPage() {
  const initial = useMemo(loadSaved, []);
  const [me, setMe] = useState(initial.me);
  const [panes, setPanes] = useState<string[]>(initial.panes);
  const [layout, setLayout] = useState<Layout>(initial.layout);
  const [full, setFull] = useState(false);

  const [accounts, setAccounts] = useState<ComboBoxOption[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ roomId: string; count: number } | null>(null);
  const paneRefs = useRef<(MarketingChatPaneHandle | null)[]>([]);

  useEffect(() => save({ me, panes, layout }), [me, panes, layout]);

  const fetchAccounts = useCallback(async () => {
    setLoadingAccounts(true);
    setAccountsError(null);
    try {
      const res = await loadtestApi.searchAccounts('', 200);
      setAccounts(
        res.rows.map((r) => ({
          value: r.email,
          label: r.displayName ? `${r.displayName} — ${r.email}` : r.email,
          hint: r.gatewayUrl,
        })),
      );
    } catch (e) {
      setAccountsError(toApiError(e).message);
    } finally {
      setLoadingAccounts(false);
    }
  }, []);

  useEffect(() => {
    void fetchAccounts();
  }, [fetchAccounts]);

  const chosen = [me, ...panes].map((e) => e.trim().toLowerCase()).filter(Boolean);
  const duplicate = chosen.length !== new Set(chosen).size;
  const paneEmails = panes.map((e) => e.trim()).filter(Boolean);
  const canCreate = !!me.trim() && paneEmails.length >= 1 && !duplicate && !creating;

  const setPane = (i: number, v: string) =>
    setPanes((prev) => {
      const n = [...prev];
      n[i] = v;
      return n;
    });

  const createRoom = async () => {
    setCreating(true);
    setCreateError(null);
    setCreated(null);
    try {
      const res = await loadtestApi.createMarketingRoom(chosen);
      setCreated({ roomId: res.roomId, count: res.members.length });
      // Ô chat có thể đã mở trước khi phòng tạo → đọc lại my-room để vào phòng ngay.
      paneRefs.current.forEach((p) => p?.reconcile());
    } catch (e) {
      setCreateError(toApiError(e).message);
    } finally {
      setCreating(false);
    }
  };

  const gridClass =
    layout === 'row'
      ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-5'
      : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 lg:[&>*]:col-span-2 lg:[&>*:nth-child(4)]:col-start-2';

  const grid = (
    <div className={cn('grid min-h-0 flex-1 gap-3', gridClass, full ? 'auto-rows-fr' : 'auto-rows-[minmax(26rem,1fr)]')}>
      {panes.map((email, i) =>
        email.trim() ? (
          <MarketingChatPane
            key={email.trim().toLowerCase()}
            ref={(h) => {
              paneRefs.current[i] = h;
            }}
            email={email.trim().toLowerCase()}
            label={`Người ${i + 1}`}
          />
        ) : null,
      )}
    </div>
  );

  if (full) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-background p-3">
        {grid}
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
          Chọn tài khoản của bạn và tối đa 5 tài khoản khác → tạo phòng chỉ định (người lạ không vào được) → tự chat dưới từng
          tài khoản ở các ô bên dưới.
        </p>
      </div>

      <Card className="flex flex-col gap-4 p-4">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mk-me" className="flex items-center gap-1.5">
              <Smartphone className="h-4 w-4" aria-hidden /> Tài khoản của bạn (dùng trên điện thoại)
            </Label>
            <ComboBox
              id="mk-me"
              label="Tài khoản của bạn"
              allowCustom
              value={me}
              onValueChange={setMe}
              options={accounts}
              loading={loadingAccounts}
              error={accountsError}
              placeholder="Chọn hoặc gõ email"
              emptyText="Không thấy account — gõ email trực tiếp hoặc «Tải lại»."
              onRefresh={() => void fetchAccounts()}
            />
          </div>
          {panes.map((email, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Label htmlFor={`mk-p${i}`} className="flex items-center gap-1.5">
                <Users className="h-4 w-4" aria-hidden /> Người {i + 1} (ô chat trên máy tính)
              </Label>
              <ComboBox
                id={`mk-p${i}`}
                label={`Người ${i + 1}`}
                allowCustom
                value={email}
                onValueChange={(v) => setPane(i, v)}
                options={accounts}
                loading={loadingAccounts}
                error={accountsError}
                placeholder="Chọn hoặc gõ email"
                emptyText="Không thấy account — gõ email trực tiếp hoặc «Tải lại»."
                onRefresh={() => void fetchAccounts()}
              />
            </div>
          ))}
        </div>

        {duplicate && <p className="text-sm text-destructive">Có tài khoản bị chọn trùng.</p>}
        {createError && (
          <p className="text-sm text-destructive" role="alert">
            {createError}
          </p>
        )}
        {created && (
          <p className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400" role="status">
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            Đã tạo phòng {created.roomId} ({created.count} người). Mở app trên điện thoại vào mục chat — app sẽ tự vào phòng.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void createRoom()} disabled={!canCreate} className="min-h-10">
            {creating && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Tạo phòng {chosen.length} người
          </Button>
          <Button
            variant="outline"
            className="min-h-10"
            onClick={() => {
              if (!window.confirm('Cho 5 tài khoản trên máy tính rời phòng hiện tại? (Tài khoản trên điện thoại bạn tự rời trong app.)')) return;
              paneRefs.current.forEach((p) => p?.leave());
              setCreated(null);
            }}
            disabled={paneEmails.length === 0}
          >
            <LogOut className="h-4 w-4" aria-hidden /> Cho các ô rời phòng
          </Button>
          <span className="text-xs text-muted-foreground">
            Mọi tài khoản phải đang không ở phòng nào. Phòng tồn tại 3 giờ.
          </span>
          <div className="ml-auto flex items-center gap-1">
            <span className="text-xs text-muted-foreground">Bố cục:</span>
            <Button variant={layout === 'grid' ? 'default' : 'outline'} size="sm" onClick={() => setLayout('grid')} aria-pressed={layout === 'grid'}>
              3 + 2
            </Button>
            <Button variant={layout === 'row' ? 'default' : 'outline'} size="sm" onClick={() => setLayout('row')} aria-pressed={layout === 'row'}>
              1 hàng
            </Button>
            <Button variant="outline" size="sm" onClick={() => setFull(true)} disabled={paneEmails.length === 0}>
              <Maximize2 className="h-4 w-4" aria-hidden /> Full màn hình
            </Button>
          </div>
        </div>
      </Card>

      {paneEmails.length > 0 ? (
        grid
      ) : (
        <p className="text-sm text-muted-foreground">Chọn ít nhất 1 người để hiện ô chat.</p>
      )}
    </div>
  );
}
