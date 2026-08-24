/**
 * TicketRegisterPage — UI chạy tool "đăng ký vé" (tấn công đăng ký hàng loạt).
 *
 * Fix A (root cause "lấy vé rồi nhưng giao diện không có gì cả"):
 * - TRƯỚC ĐÂY: filter `if (running) return <skeleton/>` unmount TOÀN BỘ trang khi đang chạy
 *   → scroll về đầu, CTA biến mất, kết quả không render nổi, state dễ mất giữa run.
 *   NHIỀU lần run này gọi 1 axios POST timeout 300s tới gateway PRODUCTION; nếu qua ~300s
 *   axios abort → catch chỉ set cái AlertBanner nhỏ, summary vẫn null → "giao diện trống".
 * - GIỜ: page luôn mount (form bị disable qua <fieldset>), có running panel inline + tổng
 *   thời gian, GIỮ kết quả cũ trong lúc chạy run mới, scroll-to-results sau khi xong,
 *   lỗi timeout/abort được phân biệt với hướng dẫn xem file report ticket-*.json,
 *   bọc kết quả bằng ErrorBoundary (lỗi render → fallback, không trắng trang).
 *
 * Bug B (revamp UI):
 * - Combobox "sổ ra để chọn" cho Community/Pool/Event/Ticket Type (dữ liệu từ
 *   /ticket-source/* + /pools + /config), Gateway prefill từ env server.
 * - Kết quả trực quan: Gauge tỷ lệ thành công + StatCard KPI + thanh outcome màu phân biệt
 *   + thông tin event/ticket nổi bật.
 */
import { useEffect, useRef, useState, type ReactNode, Component } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Loader2, Ticket } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { StatCard } from '@/components/ui/stat-card';
import { Gauge } from '@/components/ui/gauge';
import { AlertBanner } from '@/components/ui/alert-banner';
import { ComboBox, type ComboBoxOption } from '@/components/loadtest/combobox';
import { loadtestApi, toApiError } from '@/lib/loadtest-api';
import { fmtClock, fmtDateTime, fmtMs, fmtNum } from '@/lib/loadtest-format';
import {
  TICKET_OUTCOME_LABELS,
  TICKET_OUTCOME_ORDER,
  type TicketOutcome,
  type TicketRegisterRequest,
  type TicketRegisterResult,
  type LoadTestConfig,
  type LoadtestPool,
  type TicketSourceCommunity,
  type TicketSourceEvent,
  type TicketSourceTicketType,
} from '@/types/loadtest';

// ─── Render phòng thủ: server promise đặt field nào thiếu → '--' thay vì crash ──
const pnum = (n?: number | null): string => (typeof n === 'number' && Number.isFinite(n) ? fmtNum(n) : '--');
const pms = (n?: number | null): string => (typeof n === 'number' && Number.isFinite(n) ? fmtMs(n) : '--');
const psecs = (n?: number | null): string =>
  typeof n === 'number' && Number.isFinite(n) ? `${(n / 1000).toFixed(1)}s` : '--';
const ppct = (n?: number | null): string => (typeof n === 'number' && Number.isFinite(n) ? `${(n as number).toFixed(1)}%` : '--%');

const isTimeoutError = (e: unknown): boolean => {
  const ax = e as { code?: string; message?: string };
  return ax?.code === 'ECONNABORTED' || ax?.code === 'ERR_CANCELED' || /timeout/i.test(ax?.message ?? '');
};

/** ErrorBoundary cục bộ cho khu KẾT QUẢ — lỗi render chỉ hạ fallback, không hạ nguyên trang. */
class ResultsErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.error('[TicketRegisterPage] lỗi render KẾT QUẢ:', err);
  }
  render() {
    if (this.state.failed) {
      return (
        <AlertBanner
          variant="destructive"
          title="Không hiển thị được kết quả"
          description="Có lỗi khi render vùng kết quả. Dữ liệu thô vẫn nằm trong file report ticket-*.json — xem thư mục reportsDir trên server để kiểm tra."
        />
      );
    }
    return this.props.children;
  }
}

// ─── Form state (lưu cục bộ localStorage — run lại không phải gõ lại) ──────
const FORM_KEY = 'lt-ticket-register-form';

interface FormState {
  communityId: string;
  poolFile: string;
  gateway: string;
  /** Ghim thẳng event/ticket — bỏ trống → server tự tìm. */
  eventId: string;
  ticketTypeId: string;
  /** true → server quét MỌI event mở đăng ký, mỗi event 1 ticket type, chia đều pool. */
  allEvents: boolean;
  quantity: string;
  concurrency: string;
  limit: string;
  minSuccessRate: string;
  verifyMembers: boolean;
}

const FORM_DEFAULTS: FormState = {
  communityId: '',
  poolFile: '',
  gateway: '',
  eventId: '',
  ticketTypeId: '',
  allEvents: false,
  quantity: '1',
  concurrency: '20',
  limit: '',
  minSuccessRate: '90',
  verifyMembers: false,
};

function readForm(): FormState {
  try {
    const raw = localStorage.getItem(FORM_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<FormState>) : {};
    return { ...FORM_DEFAULTS, ...v };
  } catch {
    return FORM_DEFAULTS;
  }
}

function writeForm(f: FormState): void {
  try {
    localStorage.setItem(FORM_KEY, JSON.stringify(f));
  } catch {
    // quota / private mode — bỏ qua
  }
}

const toInt = (v: string, def: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
};

export default function TicketRegisterPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(readForm);
  const [running, setRunning] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [result, setResult] = useState<TicketRegisterResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Nguồn dữ liệu dropdown (Bug B) — GET /config, /pools, /ticket-source/*
  const [config, setConfig] = useState<LoadTestConfig | null>(null);
  const [pools, setPools] = useState<LoadtestPool[]>([]);
  const [communities, setCommunities] = useState<TicketSourceCommunity[]>([]);
  const [events, setEvents] = useState<TicketSourceEvent[]>([]);
  const [ticketTypes, setTicketTypes] = useState<TicketSourceTicketType[]>([]);
  const [loadingCommunities, setLoadingCommunities] = useState(false);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [loadingTicketTypes, setLoadingTicketTypes] = useState(false);
  const [errPools, setErrPools] = useState<string | null>(null);
  const [errCommunities, setErrCommunities] = useState<string | null>(null);
  const [errEvents, setErrEvents] = useState<string | null>(null);
  const [errTicketTypes, setErrTicketTypes] = useState<string | null>(null);
  /** events đã fetch cho community nào / types cho event nào — tránh fetch lại khi mở lại. */
  const [eventsFor, setEventsFor] = useState('');
  const [typesFor, setTypesFor] = useState('');

  const resultsRef = useRef<HTMLDivElement | null>(null);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    writeForm(form);
  }, [form]);

  useEffect(() => {
    if (!running) return;
    setElapsedSec(0);
    const id = window.setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  // ── Load nguồn dữ liệu lần đầu: config (prefill gateway) + pools + communities ──
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await loadtestApi.getConfig();
        if (alive) {
          setConfig(cfg);
          setForm((f) => (f.gateway.trim() ? f : { ...f, gateway: cfg.gatewayUrl }));
        }
      } catch {
        // config fail — nhẹ nhàng: gateway để trống, vẫn dùng env server khi chạy.
      }
      try {
        const r = await loadtestApi.pools();
        if (alive) setPools(r.pools ?? []);
      } catch (e) {
        if (alive) setErrPools(toApiError(e).message);
      }
      if (alive) void fetchCommunities(form.poolFile.trim() || undefined);
    })();
    return () => {
      alive = false;
    };
    // mount-once — fetchCommunities đọc form.poolFile tại mount (đã có từ localStorage).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchCommunities = async (poolFile?: string) => {
    setLoadingCommunities(true);
    setErrCommunities(null);
    try {
      const r = await loadtestApi.ticketSourceCommunities(poolFile || undefined);
      setCommunities(r.communities ?? []);
    } catch (e) {
      setErrCommunities(toApiError(e).message);
    } finally {
      setLoadingCommunities(false);
    }
  };

  const fetchEvents = async (communityId: string) => {
    const cid = communityId.trim();
    if (!cid) {
      setEvents([]);
      setEventsFor('');
      return;
    }
    setLoadingEvents(true);
    setErrEvents(null);
    try {
      const r = await loadtestApi.ticketSourceEvents(cid, form.poolFile.trim() || undefined);
      setEvents(r.events ?? []);
      setEventsFor(cid);
    } catch (e) {
      setErrEvents(toApiError(e).message);
    } finally {
      setLoadingEvents(false);
    }
  };

  const fetchTicketTypes = async (eventId: string) => {
    const eid = eventId.trim();
    if (!eid) {
      setTicketTypes([]);
      setTypesFor('');
      return;
    }
    setLoadingTicketTypes(true);
    setErrTicketTypes(null);
    try {
      const r = await loadtestApi.ticketSourceTicketTypes(eid, form.poolFile.trim() || undefined);
      setTicketTypes(r.ticketTypes ?? []);
      setTypesFor(eid);
    } catch (e) {
      setErrTicketTypes(toApiError(e).message);
    } finally {
      setLoadingTicketTypes(false);
    }
  };

  // ── Handlers chọn nguồn (đổi cha → xoá khoản con vì không còn đúng) ──
  const onCommunityChange = (v: string) => {
    set('communityId', v);
    set('eventId', '');
    set('ticketTypeId', '');
    setEvents([]);
    setEventsFor('');
    setTicketTypes([]);
    setTypesFor('');
    setErrEvents(null);
    setErrTicketTypes(null);
  };

  const onPoolChange = (v: string) => {
    const changed = v !== form.poolFile;
    set('poolFile', v);
    if (!changed) return;
    // Pool khác → bộ account khác → mọi lựa chọn cũ vô nghĩa.
    set('communityId', '');
    set('eventId', '');
    set('ticketTypeId', '');
    setCommunities([]);
    setEvents([]);
    setEventsFor('');
    setTicketTypes([]);
    setTypesFor('');
    setErrEvents(null);
    setErrTicketTypes(null);
    void fetchCommunities(v);
  };

  // ── Options cho từng combobox ──
  const poolOptions: ComboBoxOption[] = [
    {
      value: '',
      label: 'Pool mặc định của server',
      hint: config?.poolFile ? config.poolFile : 'LOADTEST_POOL_FILE chưa đặt — server dùng pool env',
    },
    ...pools
      .filter((p) => p.poolFile)
      .map((p) => ({
        value: p.poolFile as string,
        label: `${p.runId} — ${pnum(p.targetUsers)} users`,
        hint: (p.poolFile as string) || undefined,
        badge: typeof p.accountCount === 'number' ? `${p.accountCount} acc` : undefined,
      })),
  ];

  const communityOptions: ComboBoxOption[] = communities.map((c) => ({
    value: c.id,
    label: c.name || c.id,
    hint: `${c.code ? c.code + ' · ' : ''}${c.id}`,
  }));

  const eventOptions: ComboBoxOption[] = events.map((e) => ({
    value: e.id,
    label: e.title || e.id,
    hint: e.id,
    badge: e.registrationState ?? e.status ?? undefined,
  }));

  const ticketTypeOptions: ComboBoxOption[] = ticketTypes.map((t) => ({
    value: t.id,
    label: t.name || t.id,
    hint: `${pnum(t.price)}đ · còn ${pnum(t.remainingStock)}`,
    badge: t.soldOut ? 'HẾT VÉ' : `còn ${pnum(t.remainingStock)}`,
  }));

  const hasTarget = form.communityId.trim() !== '' || form.eventId.trim() !== '';

  const run = async () => {
    if (!hasTarget) {
      toast.error('Cần community-id hoặc event-id');
      return;
    }
    setRunning(true);
    setError(null);
    const req: TicketRegisterRequest = {
      communityId: form.communityId.trim() || undefined,
      poolFile: form.poolFile.trim() || undefined,
      gateway: form.gateway.trim() || undefined,
      eventId: form.eventId.trim() || undefined,
      ticketTypeId: form.ticketTypeId.trim() || undefined,
      allEvents: form.allEvents,
      quantity: toInt(form.quantity, 1),
      concurrency: toInt(form.concurrency, 20),
      limit: form.limit.trim() ? toInt(form.limit, 1) : undefined,
      verifyMembers: form.verifyMembers,
      minSuccessRate: toInt(form.minSuccessRate, 90),
    };
    try {
      const res = await loadtestApi.ticketRegister(req);
      setResult(res);
      const rate = ppct(res.summary?.successRate);
      toast.success(
        res.pass ? `Ticket-register xong — đạt ${rate}` : `Chưa đạt — success rate ${rate}`,
      );
      // scroll xuống khu KẾT QUẢ sau khi DOM đã render.
      window.setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
    } catch (e) {
      const ae = toApiError(e);
      if (ae.kind === 'network' && isTimeoutError(e)) {
        // Bug A: run đồng bộ 300s — quá đó axios abort còn server vẫn chạy phía sau.
        setError(
          `Chưa nhận được phản hồi trong 300s — server vẫn có thể đang chạy tiếp phía sau. Mở file report ${config?.reportsDir ?? 'docs/loadtest-reports'}/ticket-*.json hoặc log server để xem kết quả thực tế. Chạy lại với limit/concurrency nhỏ hơn nếu lần này bị timeout.`,
        );
      } else {
        setError(ae.message);
      }
    } finally {
      setRunning(false);
    }
  };

  const summary = result?.summary ?? null;
  const pass = result?.pass ?? false;
  const minRate = toInt(form.minSuccessRate, 90);
  const warnRate = Math.max(0, minRate - 20);

  /** Màu thanh outcome — class tồn tại literal để Tailwind JIT quét được. */
  const BAR_COLOR: Partial<Record<TicketOutcome, string>> = {
    REGISTERED: 'bg-success',
    QUEUED: 'bg-info',
    CONFLICT: 'bg-warning',
    FORBIDDEN: 'bg-destructive',
    BAD_REQUEST: 'bg-warning',
    NOT_FOUND: 'bg-destructive',
    RATE_LIMITED: 'bg-warning',
    SERVER: 'bg-destructive',
    LOGIN_FAIL: 'bg-warning',
    NETWORK: 'bg-warning',
  };

  return (
    <div className="space-y-4" aria-busy={running}>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="flex items-center gap-1.5 text-lg font-semibold">
          <Ticket className="h-4 w-4" aria-hidden /> ĐĂNG KÝ VÉ
        </h1>
        <Badge variant="secondary" className="ml-auto">ticket-register</Badge>
      </div>

      {running && (
        <Card className="border-info/40 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Loader2 className="h-5 w-5 shrink-0 animate-spin text-info" aria-hidden />
            <p className="text-sm font-medium">Đang bắn đăng ký vé…</p>
            <Badge variant="secondary" className="font-mono">{fmtClock(elapsedSec)}</Badge>
            <p className="w-full text-xs text-muted-foreground sm:w-auto sm:flex-1">
              Mỗi user: login + POST register. Run đồng bộ, có thể mất vài chục giây — nếu timeout, kết
              quả vẫn nằm trong file report <span className="font-mono">ticket-*.json</span>.
            </p>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <span>Community: <span className="font-mono">{form.communityId.trim() || '—'}</span></span>
            <span>Event: <span className="font-mono">{form.allEvents ? 'MỌI sự kiện mở đăng ký' : (form.eventId.trim() || '(tự tìm)')}</span></span>
            <span>Số vé/user: <span className="font-mono">{toInt(form.quantity, 1)}</span></span>
            <span>Concurrency: <span className="font-mono">{toInt(form.concurrency, 20)}</span></span>
            {form.limit.trim() !== '' && <span>Limit: <span className="font-mono">{toInt(form.limit, 1)}</span></span>}
          </div>
        </Card>
      )}

      <Card className="p-4">
        <h2 className="mb-3 text-sm font-medium">CẤU HÌNH CHẠY</h2>
        {/* fieldset disabled: page KHÔNG unmount khi running (Fix A) — chỉ khoá form. */}
        <fieldset disabled={running}>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tr-community">Community ID</Label>
              <ComboBox
                id="tr-community"
                label="Community ID"
                allowCustom
                value={form.communityId}
                onValueChange={onCommunityChange}
                options={communityOptions}
                loading={loadingCommunities}
                error={errCommunities}
                disabled={running}
                placeholder="Chọn từ danh sách hoặc gõ id"
                emptyText="Không thấy community — gõ id trực tiếp hoặc ấn «Tải lại»."
                onRefresh={() => void fetchCommunities(form.poolFile.trim() || undefined)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tr-pool">Pool file</Label>
              <ComboBox
                id="tr-pool"
                label="Pool file (trên server)"
                allowCustom={errPools != null}
                value={form.poolFile}
                onValueChange={onPoolChange}
                options={poolOptions}
                error={errPools}
                disabled={running}
                placeholder="Chọn pool hoặc dùng mặc định server"
                emptyText="Không có pool nào — chạy loadtest để tạo pool."
                onRefresh={async () => {
                  setErrPools(null);
                  try {
                    const r = await loadtestApi.pools();
                    setPools(r.pools ?? []);
                  } catch (e) {
                    setErrPools(toApiError(e).message);
                  }
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tr-event-id">Event ID (ghim thẳng — tùy chọn)</Label>
              <ComboBox
                id="tr-event-id"
                label="Event ID"
                allowCustom
                value={form.eventId}
                onValueChange={(v) => {
                  set('eventId', v);
                  set('ticketTypeId', '');
                  setTicketTypes([]);
                  setTypesFor('');
                  setErrTicketTypes(null);
                }}
                options={eventOptions}
                loading={loadingEvents}
                error={errEvents}
                disabled={running}
                placeholder={form.communityId.trim() ? 'Chọn từ danh sách hoặc gõ id' : 'Gõ id — để trống = tự tìm event mở đăng ký'}
                emptyText="Chưa có event nào mở đăng ký cho community này."
                onOpen={() => {
                  const cid = form.communityId.trim();
                  if (cid && eventsFor !== cid) void fetchEvents(cid);
                }}
                onRefresh={() => {
                  const cid = form.communityId.trim();
                  if (cid) void fetchEvents(cid);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tr-ticket-type-id">Ticket Type ID (ghim thẳng — tùy chọn)</Label>
              <ComboBox
                id="tr-ticket-type-id"
                label="Ticket Type ID"
                allowCustom
                value={form.ticketTypeId}
                onValueChange={(v) => set('ticketTypeId', v)}
                options={ticketTypeOptions}
                loading={loadingTicketTypes}
                error={errTicketTypes}
                disabled={running}
                placeholder={form.eventId.trim() ? 'Chọn từ danh sách hoặc gõ id' : 'Gõ id — để trống = tự tìm ticket type đang bán'}
                emptyText="Chưa có ticket type nào cho event này."
                onOpen={() => {
                  const eid = form.eventId.trim();
                  if (eid && typesFor !== eid) void fetchTicketTypes(eid);
                }}
                onRefresh={() => {
                  const eid = form.eventId.trim();
                  if (eid) void fetchTicketTypes(eid);
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tr-gateway">Gateway URL</Label>
              <div className="flex gap-2">
                <Input
                  id="tr-gateway"
                  value={form.gateway}
                  onChange={(e) => set('gateway', e.target.value)}
                  placeholder="Bỏ trống = dùng env server (LOADTEST_GATEWAY_URL)"
                  className="font-mono text-sm"
                  aria-label="Gateway URL"
                />
                {form.gateway.trim() === '' && (
                  <Badge variant="secondary" className="shrink-0 self-center font-mono text-[10px]">
                    env
                  </Badge>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tr-concurrency">Concurrency</Label>
              <Input
                id="tr-concurrency"
                type="number"
                min={1}
                value={form.concurrency}
                onChange={(e) => set('concurrency', e.target.value)}
                aria-label="Concurrency"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tr-quantity">Quantity / user</Label>
              <Input
                id="tr-quantity"
                type="number"
                min={1}
                value={form.quantity}
                onChange={(e) => set('quantity', e.target.value)}
                aria-label="Số lượng vé mỗi user"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tr-limit">Limit (số account — tùy chọn)</Label>
              <Input
                id="tr-limit"
                type="number"
                min={1}
                value={form.limit}
                onChange={(e) => set('limit', e.target.value)}
                placeholder="Bỏ trống = toàn bộ pool"
                aria-label="Limit số account"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tr-min-rate">Min success rate (%)</Label>
              <Input
                id="tr-min-rate"
                type="number"
                min={0}
                max={100}
                value={form.minSuccessRate}
                onChange={(e) => set('minSuccessRate', e.target.value)}
                aria-label="Min success rate"
              />
            </div>
            <div className="flex items-center gap-3 md:col-span-2">
              <Switch
                id="tr-all-events"
                checked={form.allEvents}
                onCheckedChange={(v) => {
                  set('allEvents', v);
                  if (v) {
                    // Quét mọi sự kiện → bỏ chốt cứng event/ticket (server tự tìm từng event).
                    set('eventId', '');
                    set('ticketTypeId', '');
                  }
                }}
                aria-label="Quét mọi sự kiện mở đăng ký"
              />
              <Label htmlFor="tr-all-events" className="text-sm">
                Quét mọi sự kiện mở đăng ký
                <span className="ml-2 text-xs text-muted-foreground">
                  mỗi event lấy 1 ticket type đang bán, chia đều pool account cho từng event — kết quả có thêm mục theo từng event
                </span>
              </Label>
            </div>
            <div className="flex items-center gap-3 md:col-span-2">
              <Switch
                id="tr-verify"
                checked={form.verifyMembers}
                onCheckedChange={(v) => set('verifyMembers', v)}
                aria-label="Verify members"
              />
              <Label htmlFor="tr-verify" className="text-sm">
                Verify members (kiểm tra pool account có phải member của community không)
              </Label>
            </div>
          </div>
        </fieldset>
        <p className="mt-3 text-xs text-muted-foreground">
          Pool accounts phải là member của community — chạy <span className="font-mono">npm run loadtest:join-community</span> trước nếu chưa join.
          Để community trống + ghim event-id/ticket-type-id để bỏ qua bước tự tìm.
        </p>
      </Card>

      {error && <AlertBanner variant="destructive" title="Lỗi chạy ticket-register" description={error} />}

      <ResultsErrorBoundary>
        <div ref={resultsRef}>
          {summary && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">KẾT QUẢ</span>
                {pass ? (
                  <Badge variant="success">PASS — đạt min success rate</Badge>
                ) : (
                  <Badge variant="destructive">FAIL — chưa đạt min success rate</Badge>
                )}
                <Badge variant="secondary" className="font-mono">{pnum(summary.participants)} user</Badge>
                {summary.gateway && (
                  <Badge variant="secondary" className="ml-auto hidden max-w-64 truncate font-mono text-[10px] sm:inline-flex">
                    {summary.gateway}
                  </Badge>
                )}
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-xs font-medium text-muted-foreground">Sự kiện:</span>
                <span className="font-mono text-xs">
                  {summary.eventTitle ?? '—'}
                  {summary.eventId ? ` (${summary.eventId})` : ''}
                </span>
                <span className="text-xs text-muted-foreground">·</span>
                <span className="text-xs font-medium text-muted-foreground">Vé:</span>
                <span className="font-mono text-xs">
                  {summary.ticketTypeName ?? '—'}
                  {summary.ticketTypeId ? ` (${summary.ticketTypeId})` : ''}
                </span>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
                <Gauge
                  label="Tỷ lệ thành công"
                  value={typeof summary.successRate === 'number' ? summary.successRate : 0}
                  okThreshold={minRate}
                  warnThreshold={warnRate}
                  hint={pass ? `Đạt ngưỡng ${ppct(minRate)}` : `Dưới ngưỡng ${ppct(minRate)} — cần chạy lại`}
                />
                <StatCard
                  title="Thành công (201+202)"
                  value={pnum(summary.actionOk)}
                  variant="success"
                  hint="REGISTERED (201) + QUEUED (202)"
                />
                <StatCard
                  title="Thất bại"
                  value={pnum(summary.actionFail)}
                  variant="error"
                  hint="mọi outcome còn lại"
                />
                <StatCard
                  title="Công suất"
                  value={pnum(Math.round(summary.participants / Math.max(1, summary.durationMs / 1000)))}
                  unit="req/s"
                  hint={`chạy ${psecs(summary.durationMs)}`}
                />
                <StatCard
                  title="Đăng ký thẳng (201)"
                  value={pnum(summary.results?.REGISTERED)}
                  variant="info"
                  hint="POST register thành công ngay"
                />
              </div>

              {summary.events && summary.events.length > 0 && (
                <div className="mt-4 space-y-3">
                  <h2 className="flex items-center gap-2 text-sm font-medium">
                    THEO TỪNG EVENT
                    <Badge variant="secondary" className="font-mono text-[10px]">
                      {summary.events.length} event
                    </Badge>
                  </h2>
                  {summary.events.map((e) => {
                    const hasOutcome = TICKET_OUTCOME_ORDER.some((o) => (e.results[o] ?? 0) > 0);
                    const okColor =
                      e.successRate >= minRate
                        ? 'text-success'
                        : e.successRate >= warnRate
                          ? 'text-warning'
                          : 'text-destructive';
                    return (
                      <Card key={e.eventId} className="p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-sm">{e.eventTitle}</span>
                          <span className="font-mono text-xs text-muted-foreground">{e.eventId}</span>
                          <Badge variant="secondary" className="ml-auto font-mono text-[10px]">
                            {pnum(e.participants)} user · {pnum(Math.round(e.participants / Math.max(1, e.durationMs / 1000)))} req/s
                          </Badge>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span className="text-xs font-medium">Vé:</span>
                          <span className="font-mono">{e.ticketTypeName}</span>
                          <span className="font-mono">{e.ticketTypeId}</span>
                          <span className="text-muted-foreground">·</span>
                          <span>success</span>
                          <span className={`font-mono font-semibold ${okColor}`}>{ppct(e.successRate)}</span>
                          <span className="text-muted-foreground">·</span>
                          <span>ok {pnum(e.actionOk)} / fail {pnum(e.actionFail)}</span>
                          <span className="text-muted-foreground">·</span>
                          <span>latency avg {pms(e.latencyMs?.avg)} / p95 {pms(e.latencyMs?.p95)}</span>
                        </div>
                        {hasOutcome && (
                          <ul className="mt-2 space-y-1">
                            {TICKET_OUTCOME_ORDER.filter((o) => (e.results[o] ?? 0) > 0).map((o) => (
                              <li key={o} className="flex items-center gap-2">
                                <span className="w-40 truncate text-xs text-muted-foreground">{TICKET_OUTCOME_LABELS[o]}</span>
                                <div
                                  className="h-2 w-24 overflow-hidden rounded-full bg-muted"
                                  role="meter"
                                  aria-label={`${TICKET_OUTCOME_LABELS[o]}: ${pnum(e.results[o])}`}
                                  aria-valuenow={Math.round(((e.results[o] ?? 0) / Math.max(1, e.participants)) * 100)}
                                  aria-valuemin={0}
                                  aria-valuemax={100}
                                >
                                  <div
                                    className={`h-full rounded-full ${BAR_COLOR[o] ?? 'bg-primary'}`}
                                    style={{ width: `${((e.results[o] ?? 0) / Math.max(1, e.participants)) * 100}%` }}
                                  />
                                </div>
                                <span className="w-12 text-right font-mono text-xs tabular-nums text-muted-foreground">
                                  {pnum(e.results[o])}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </Card>
                    );
                  })}
                </div>
              )}

              <div className="mt-4 grid gap-4 lg:grid-cols-12">
                <div className="space-y-4 lg:col-span-8">
                  <Card className="p-4">
                    <h2 className="mb-2 text-sm font-medium">OUTCOME THEO ACCOUNT</h2>
                    {TICKET_OUTCOME_ORDER.filter((o) => (summary.results[o] ?? 0) > 0).length === 0 ? (
                      <p className="text-sm text-muted-foreground">Không có kết quả.</p>
                    ) : (
                      <ul className="divide-y divide-border">
                        {TICKET_OUTCOME_ORDER.filter((o) => (summary.results[o] ?? 0) > 0).map((o) => {
                          const n = summary.results[o] ?? 0;
                          const pct = n / Math.max(1, summary.participants);
                          return (
                            <li key={o} className="flex items-center gap-2 py-2">
                              <span className="flex-1 text-sm">{TICKET_OUTCOME_LABELS[o]}</span>
                              <div
                                className="h-2.5 w-36 overflow-hidden rounded-full bg-muted sm:w-48"
                                role="meter"
                                aria-label={`${TICKET_OUTCOME_LABELS[o]}: ${ppct(pct * 100)}`}
                                aria-valuenow={Math.round(pct * 100)}
                                aria-valuemin={0}
                                aria-valuemax={100}
                              >
                                <div
                                  className={`h-full rounded-full ${BAR_COLOR[o] ?? 'bg-primary'}`}
                                  style={{ width: `${pct * 100}%` }}
                                />
                              </div>
                              <span className="w-14 text-right font-mono text-sm tabular-nums">{pnum(n)}</span>
                              <span className="w-14 text-right font-mono text-xs tabular-nums text-muted-foreground">
                                {ppct(pct * 100)}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </Card>

                  <Card className="p-4">
                    <h2 className="mb-2 text-sm font-medium">THEO HTTP STATUS</h2>
                    {Object.keys(summary.byStatus).length === 0 ? (
                      <p className="text-sm text-muted-foreground">—</p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(summary.byStatus)
                          .sort((a, b) => b[1] - a[1])
                          .map(([st, n]) => (
                            <Badge key={st} variant="secondary" className="font-mono">
                              HTTP {st}: {pnum(n)}
                            </Badge>
                          ))}
                      </div>
                    )}
                  </Card>
                </div>

                <div className="space-y-4 lg:col-span-4">
                  <Card className="p-4">
                    <h2 className="mb-2 text-sm font-medium">LATENCY (ms)</h2>
                    <div className="grid grid-cols-2 gap-2">
                      {(
                        [
                          ['avg', summary.latencyMs.avg],
                          ['p50', summary.latencyMs.p50],
                          ['p95', summary.latencyMs.p95],
                          ['p99', summary.latencyMs.p99],
                          ['max', summary.latencyMs.max],
                        ] as const
                      ).map(([k, v]) => (
                        <div key={k} className="rounded-md border border-border p-2">
                          <p className="text-xs text-muted-foreground">{k}</p>
                          <p className="font-mono text-sm tabular-nums">{pms(v)}</p>
                        </div>
                      ))}
                    </div>
                  </Card>

                  <Card className="p-4">
                    <h2 className="mb-2 text-sm font-medium">THÔNG TIN</h2>
                    <dl className="space-y-1 text-sm">
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Event</dt>
                        <dd className="font-mono text-xs">
                          {summary.eventTitle ?? '—'} {summary.eventId ? `(${summary.eventId})` : ''}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Ticket type</dt>
                        <dd className="font-mono text-xs">
                          {summary.ticketTypeName ?? '—'} {summary.ticketTypeId ? `(${summary.ticketTypeId})` : ''}
                        </dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Quantity</dt>
                        <dd className="font-mono text-xs">{pnum(summary.quantity)} vé/user</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Bắt đầu</dt>
                        <dd className="font-mono text-xs">{fmtDateTime(summary.startedAt)}</dd>
                      </div>
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Thời gian</dt>
                        <dd className="font-mono text-xs">{psecs(summary.durationMs)}</dd>
                      </div>
                    </dl>
                  </Card>

                  {summary.errors && Object.keys(summary.errors).length > 0 && (
                    <Card className="p-4">
                      <h2 className="mb-2 text-sm font-medium">TOP ERRORS</h2>
                      <ul className="space-y-1 font-mono text-xs text-muted-foreground">
                        {Object.entries(summary.errors)
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 8)
                          .map(([code, n]) => (
                            <li key={code} className="flex justify-between gap-2">
                              <span className="truncate">{code}</span>
                              <span className="tabular-nums">{pnum(n)}</span>
                            </li>
                          ))}
                      </ul>
                    </Card>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </ResultsErrorBoundary>

      <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 border-t border-border bg-background/80 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:bottom-0">
        <div className="flex gap-3">
          <Button variant="outline" className="min-h-12 flex-1" onClick={() => navigate(-1)}>
            Quay lại
          </Button>
          <Button className="min-h-12 flex-1" disabled={!hasTarget || running} onClick={() => void run()}>
            {running ? 'Đang chạy...' : 'Chạy ticket-register'}
          </Button>
        </div>
      </div>
    </div>
  );
}