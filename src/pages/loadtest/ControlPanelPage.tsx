import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ChipGroup } from '@/components/ui/chip-group';
import { AlertBanner } from '@/components/ui/alert-banner';
import { StatCard } from '@/components/ui/stat-card';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { StartRunConfirmDialog, StopRunConfirmDialog } from '@/components/loadtest/confirm-dialogs';
import { useLoadtestStore } from '@/store/loadtest.store';
import { routes } from '@/lib/env';
import { fmtClock, fmtNum, isProductionLikeGateway } from '@/lib/loadtest-format';
import { TERMINAL_PHASES, CHAOS_ACTION_LABELS } from '@/types/loadtest';
import type { ChaosEvent, NetworkImpairment, StartRunRequest } from '@/types/loadtest';
import { cn } from '@/lib/utils';

const RAMP_RATES = [100, 200, 500, 1000];
const DURATIONS = [5, 10, 15, 30, 45, 60];

/** Draft event chaos — input là string (trống = chưa nhập), ép number khi gửi. */
interface ChaosEventDraft {
  atSec: string;
  action: ChaosEvent['action'];
  durationSec: string;
}

const CHAOS_ACTIONS = (Object.keys(CHAOS_ACTION_LABELS) as ChaosEvent['action'][]).map((value) => ({
  value,
  label: CHAOS_ACTION_LABELS[value],
}));

function profileLabel(p: { chat: number; read: number; comment: number; like: number; view: number }): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(p) as [string, number][]) {
    if (v > 0) parts.push(`${k} ${v}`);
  }
  return parts.join(' / ');
}

/** PhaseTimeline dạng thanh ngang (desktop Màn 1) — segments provisioning→ramping→steady→cooldown. */
const PHASE_STEPS = ['provisioning', 'ramping', 'steady', 'cooldown'] as const;

function PhaseTimeline({ phase }: { phase: string }) {
  const idx = PHASE_STEPS.indexOf(phase as (typeof PHASE_STEPS)[number]);
  return (
    <div className="space-y-2">
      {PHASE_STEPS.map((p, i) => {
        const done = idx > i || TERMINAL_PHASES.includes(phase as (typeof PHASE_STEPS)[number]);
        const active = idx === i;
        return (
          <div key={p} className="flex items-center gap-2">
            <span className="w-28 text-xs text-muted-foreground capitalize">{p}</span>
            <Progress
              value={done ? 100 : active ? 50 : 0}
              className={cn('h-2 flex-1', active && 'ring-1 ring-primary/50', done && 'opacity-70')}
            />
            <span className="w-10 text-right text-xs text-muted-foreground">{done ? 'xong' : active ? 'chạy' : ''}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function ControlPanelPage() {
  const navigate = useNavigate();
  const config = useLoadtestStore((s) => s.config);
  const configLoading = useLoadtestStore((s) => s.configLoading);
  const configError = useLoadtestStore((s) => s.configError);
  const loadConfig = useLoadtestStore((s) => s.loadConfig);
  const phase = useLoadtestStore((s) => s.phase);
  const elapsedSec = useLoadtestStore((s) => s.elapsedSec);
  const runId = useLoadtestStore((s) => s.runId);
  const lastTick = useLoadtestStore((s) => s.lastTick);
  const profile = useLoadtestStore((s) => s.profile);
  const startRun = useLoadtestStore((s) => s.startRun);
  const stopRun = useLoadtestStore((s) => s.stopRun);
  const pauseRun = useLoadtestStore((s) => s.pauseRun);
  const resumeRun = useLoadtestStore((s) => s.resumeRun);
  const resetRun = useLoadtestStore((s) => s.resetRun);
  const requireEnvConfirm = useLoadtestStore((s) => s.requireEnvConfirm);
  const paused = useLoadtestStore((s) => s.paused);

  const [preset, setPreset] = useState('10k');
  const [targetUsers, setTargetUsers] = useState(10_000);
  const [rampRate, setRampRate] = useState(200);
  const [rampMode, setRampMode] = useState<'rate' | 'minutes' | 'burst' | 'breakpoint'>('rate');
  const [durationMin, setDurationMin] = useState(30);
  // Gateway chạy — editable (server chặn URL ngoài allowlist + warning production giữ nguyên).
  const [gatewayInput, setGatewayInput] = useState('');
  useEffect(() => {
    if (config?.gatewayUrl && gatewayInput === '') setGatewayInput(config.gatewayUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.gatewayUrl]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [infraBannerDismissed, setInfraBannerDismissed] = useState(false);
  // 429 rate-limit cooldown (UI-SPEC §5.2) — disable nút + countdown "Thử lại sau Ns".
  const [startCooldown, setStartCooldown] = useState(0);
  const [stopCooldown, setStopCooldown] = useState(0);
  // Kịch bản nâng cao (network impairment + chaos) — mặc định tắt; chỉ gửi lên khi bật.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [netEnabled, setNetEnabled] = useState(false);
  const [latencyMs, setLatencyMs] = useState('');
  const [jitterMs, setJitterMs] = useState('');
  const [dropRate, setDropRate] = useState('');
  const [chaosEnabled, setChaosEnabled] = useState(false);
  const [chaosEvents, setChaosEvents] = useState<ChaosEventDraft[]>([]);

  const addChaosEvent = () =>
    setChaosEvents((evs) => [...evs, { atSec: '', action: 'disconnect_all', durationSec: '' }]);
  const removeChaosEvent = (i: number) => setChaosEvents((evs) => evs.filter((_, idx) => idx !== i));
  const updateChaosEvent = (i: number, patch: Partial<ChaosEventDraft>) =>
    setChaosEvents((evs) => evs.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));

  useEffect(() => {
    if (startCooldown <= 0) return;
    const t = window.setInterval(() => setStartCooldown((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => window.clearInterval(t);
  }, [startCooldown > 0]);

  useEffect(() => {
    if (stopCooldown <= 0) return;
    const t = window.setInterval(() => setStopCooldown((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => window.clearInterval(t);
  }, [stopCooldown > 0]);

  const running = ['provisioning', 'ramping', 'steady'].includes(phase);
  const formLocked = phase !== 'idle';

  const gatewayUrl = gatewayInput.trim() || config?.gatewayUrl || 'ws://test-01.mayogu.test';
  // Dropdown từ allowlist (Settings) — luôn thêm gateway mặc định của server nếu chưa nằm trong list
  const gatewayOptions = useMemo(() => {
    const list = config?.allowlist ? [...config.allowlist] : [];
    if (config?.gatewayUrl && !list.includes(config.gatewayUrl)) list.unshift(config.gatewayUrl);
    if (list.length === 0) list.push('ws://test-01.mayogu.test');
    return list;
  }, [config?.allowlist, config?.gatewayUrl]);
  const productionTarget = isProductionLikeGateway(gatewayUrl);
  const allowlistFail = !!config && !config.allowlist.includes(gatewayUrl.replace(/^ws:\/\//, 'http://'));
  const hugePreset = preset === '1M' || preset === '10M';
  const targetInvalid = !Number.isInteger(targetUsers) || targetUsers < 1000;
  const targetOverCap = !!config && targetUsers > config.maxTarget;

  const estimate = useMemo(() => {
    const workers = Math.min(Math.max(1, Math.ceil(targetUsers / 10_000)), 32);
    const ramGB = Math.ceil((targetUsers * 60 * 1024) / 1024 ** 3);
    const seatMin = Math.ceil(targetUsers / 100 / 60);
    return { workers, ramGB, seatMin };
  }, [targetUsers]);

  const onPresetChange = (v: string) => {
    setPreset(v);
    if (v !== 'custom') {
      const p = config?.presets.find((x) => x.id === v);
      if (p) {
        setTargetUsers(p.targetUsers);
        setStartError(null);
      }
    }
  };

  const onConfirmStart = async () => {
    setConfirmOpen(false);
    const req: StartRunRequest = {
      targetUsers,
      rampRate,
      rampMode,
      durationMin,
      profile,
      gatewayUrl,
      freshAccounts: false,
    };
    // Network impairment — chỉ gửi field đã nhập khi bật mô phỏng.
    if (netEnabled) {
      const network: NetworkImpairment = {};
      if (latencyMs.trim() !== '') network.latencyMs = Number(latencyMs);
      if (jitterMs.trim() !== '') network.jitterMs = Number(jitterMs);
      if (dropRate.trim() !== '') network.dropRate = Number(dropRate);
      if (Object.keys(network).length > 0) req.network = network;
    }
    // Chaos — lọc event không hợp lệ (atSec rỗng/âm; block_reconnect thiếu durationSec > 0).
    if (chaosEnabled) {
      const events = chaosEvents
        .map((e): ChaosEvent | null => {
          const atSec = Number(e.atSec);
          if (e.atSec.trim() === '' || !Number.isFinite(atSec) || atSec < 0) return null;
          if (e.action === 'block_reconnect') {
            const durationSec = Number(e.durationSec);
            if (e.durationSec.trim() === '' || !Number.isFinite(durationSec) || durationSec <= 0) return null;
            return { atSec, action: e.action, durationSec };
          }
          return { atSec, action: e.action };
        })
        .filter((e): e is ChaosEvent => e !== null);
      if (events.length > 0) req.chaos = { events };
    }
    const res = await startRun(req);
    if (res.ok && res.runId) {
      // E7: server chấp nhận run nhưng có cảnh báo (vd target vượt năng lực máy) — hiện, không nuốt.
      if (res.warnings && res.warnings.length > 0) {
        toast.warning('Run bắt đầu — có cảnh báo từ server', { description: res.warnings.join('; ') });
      }
      navigate(routes.loadtestLive);
    } else {
      const msg =
        res.error?.errors?.join('; ') ||
        res.error?.message ||
        'Không bắt đầu được run — kiểm tra cấu hình.';
      setStartError(msg);
      toast.error('Không bắt đầu được run', { description: msg });
      // 429 → disable + countdown "Thử lại sau Ns" (không spam lại 429).
      if (res.error?.retryAfterSec && res.error.retryAfterSec > 0) {
        setStartCooldown(res.error.retryAfterSec);
      }
    }
  };

  const onConfirmStop = async () => {
    setStopOpen(false);
    const res = await stopRun(false);
    if (!res.ok) {
      toast.error('Không dừng được run', { description: res.error?.message });
      if (res.error?.retryAfterSec && res.error.retryAfterSec > 0) {
        setStopCooldown(res.error.retryAfterSec);
      }
    }
  };

  const counters = lastTick?.counters;

  // ─── Loading ────────────────────────────────────────────────────────────
  if (configLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-11 w-64" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">MAYogu LoadTest</h1>
        <span className="text-xs text-muted-foreground">
          {running && runId ? `run ${runId} · ${fmtClock(elapsedSec)}` : 'sẵn sàng cấu hình'}
        </span>
      </div>

      {configError && (
        <AlertBanner
          variant="destructive"
          title="Không đọc được cấu hình từ loadtest server"
          description={`${configError} — chạy "npm run loadtest:server" (port 3401).`}
          action={{ label: 'Thử lại', onClick: () => void loadConfig() }}
        />
      )}

      {!running && (
        <p className="text-xs text-muted-foreground">Cấu hình xong bấm Bắt đầu</p>
      )}

      <div className="grid gap-4 lg:grid-cols-12">
        {/* Cột trái: preset + form */}
        <div className="space-y-4 lg:col-span-4">
          {config && (
            <Card className="p-4">
              <h2 className="mb-2 text-sm font-medium">PRESET</h2>
              <ChipGroup
                ariaLabel="Preset target"
                options={[
                  ...config.presets.map((p) => ({
                    value: p.id,
                    label: p.label,
                    warning: p.requiresCluster,
                    warningText: 'Preset cần cluster hạ tầng (v1.1) — cảnh báo hạ tầng',
                  })),
                  { value: 'custom', label: 'Custom' },
                ]}
                value={preset}
                onChange={onPresetChange}
                size="lg"
              />
            </Card>
          )}

          <Card className={cn('p-4', formLocked && 'pointer-events-none opacity-50')} aria-busy={formLocked}>
            <h2 className="mb-3 text-sm font-medium">CẤU HÌNH RUN</h2>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="target-users">Target users</Label>
                <Input
                  id="target-users"
                  type="number"
                  min={1000}
                  step={1000}
                  value={targetUsers}
                  disabled={preset !== 'custom'}
                  onChange={(e) => {
                    setTargetUsers(Number(e.target.value));
                    setPreset('custom');
                  }}
                  aria-describedby={targetInvalid ? 'target-error' : undefined}
                />
                {targetInvalid && (
                  <p id="target-error" className="text-xs text-destructive">
                    Target phải ≥ 1000
                  </p>
                )}
                {targetOverCap && !targetInvalid && (
                  <p className="text-xs text-warning">
                    Vượt giới hạn an toàn {fmtNum(config?.maxTarget ?? 0)} — server sẽ chặn (cần cluster).
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>Ramp-up</Label>
                <div className="flex gap-3">
                  <Select value={String(rampRate)} onValueChange={(v) => setRampRate(Number(v))}>
                    <SelectTrigger aria-label="Tốc độ ramp">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RAMP_RATES.map((r) => (
                        <SelectItem key={r} value={String(r)}>
                          {r}/s
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={rampMode}
                    onValueChange={(v) => setRampMode(v as 'rate' | 'minutes' | 'burst' | 'breakpoint')}
                  >
                    <SelectTrigger aria-label="Chế độ ramp">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="rate">theo tốc độ</SelectItem>
                      <SelectItem value="minutes">trong X phút</SelectItem>
                      <SelectItem value="burst">toàn bộ cùng lúc</SelectItem>
                      <SelectItem value="breakpoint">tìm điểm gãy (ramp tới gãy)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Duration</Label>
                <Select value={String(durationMin)} onValueChange={(v) => setDurationMin(Number(v))}>
                  <SelectTrigger aria-label="Thời lượng run">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DURATIONS.map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {d === 60 ? '60 phút (tối đa — access token 1h)' : `${d} phút`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Action profile</Label>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-between"
                  onClick={() => navigate(routes.loadtestScenario)}
                >
                  {profileLabel(profile)} <ChevronRight className="h-4 w-4" aria-hidden />
                </Button>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="gateway-url">Gateway (test)</Label>
                <Select value={gatewayUrl} onValueChange={setGatewayInput} disabled={formLocked}>
                  <SelectTrigger id="gateway-url" className="w-full" aria-label="Chọn gateway">
                    <SelectValue placeholder="Chọn gateway" />
                  </SelectTrigger>
                  <SelectContent>
                    {gatewayOptions.map((g) => (
                      <SelectItem key={g} value={g}>
                        {g}
                        {g === config?.gatewayUrl && ' (mặc định)'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p id="gateway-hint" className="text-xs text-muted-foreground">
                  Chọn từ môi trường đã thêm trong Cài đặt (allowlist — chặn cứng SD-1)
                </p>
              </div>
            </div>
          </Card>

          <Card className={cn('p-4', formLocked && 'pointer-events-none opacity-50')} aria-busy={formLocked}>
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
              aria-controls="advanced-scenario-panel"
            >
              <h2 className="text-sm font-medium">KỊCH BẢN NÂNG CAO</h2>
              <ChevronDown
                className={cn('h-4 w-4 text-muted-foreground transition-transform', advancedOpen && 'rotate-180')}
                aria-hidden
              />
            </button>
            {advancedOpen && (
              <div id="advanced-scenario-panel" className="mt-3 space-y-4">
                {/* Network impairment */}
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <Switch
                      id="net-enabled"
                      checked={netEnabled}
                      onCheckedChange={setNetEnabled}
                      aria-label="Bật mô phỏng mạng yếu"
                    />
                    <Label htmlFor="net-enabled">Bật mô phỏng mạng yếu</Label>
                  </div>
                  {netEnabled && (
                    <div className="grid grid-cols-3 gap-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="net-latency" className="text-xs">
                          Latency thêm (ms)
                        </Label>
                        <Input
                          id="net-latency"
                          type="number"
                          min={0}
                          max={30000}
                          placeholder="0–30000"
                          value={latencyMs}
                          onChange={(e) => setLatencyMs(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="net-jitter" className="text-xs">
                          Jitter ± (ms)
                        </Label>
                        <Input
                          id="net-jitter"
                          type="number"
                          min={0}
                          max={10000}
                          placeholder="0–10000"
                          value={jitterMs}
                          onChange={(e) => setJitterMs(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="net-drop" className="text-xs">
                          Drop rate (%)
                        </Label>
                        <Input
                          id="net-drop"
                          type="number"
                          min={0}
                          max={100}
                          placeholder="0–100"
                          value={dropRate}
                          onChange={(e) => setDropRate(e.target.value)}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Chaos (failure injection) */}
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <Switch
                      id="chaos-enabled"
                      checked={chaosEnabled}
                      onCheckedChange={setChaosEnabled}
                      aria-label="Bật chaos (failure injection)"
                    />
                    <Label htmlFor="chaos-enabled">Bật chaos (failure injection)</Label>
                  </div>
                  {chaosEnabled && (
                    <div className="space-y-2">
                      {chaosEvents.length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          Chưa có event — thêm event để chèn lỗi trong lúc chạy (tối đa 20).
                        </p>
                      )}
                      {chaosEvents.map((ev, i) => (
                        <div key={i} className="space-y-2 rounded-lg border border-border p-2">
                          <div className="flex items-start gap-2">
                            <div className="min-w-0 flex-1 space-y-1.5">
                              <Label htmlFor={`chaos-atsec-${i}`} className="text-xs">
                                Thời điểm (giây)
                              </Label>
                              <Input
                                id={`chaos-atsec-${i}`}
                                type="number"
                                min={0}
                                placeholder="vd 30"
                                value={ev.atSec}
                                onChange={(e) => updateChaosEvent(i, { atSec: e.target.value })}
                              />
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="mt-4 h-9 w-9"
                              onClick={() => removeChaosEvent(i)}
                              aria-label={`Xóa event ${i + 1}`}
                            >
                              <X className="h-4 w-4" aria-hidden />
                            </Button>
                          </div>
                          <div className="space-y-1.5">
                            <Label className="text-xs">Hành động</Label>
                            <Select
                              value={ev.action}
                              onValueChange={(v) => updateChaosEvent(i, { action: v as ChaosEvent['action'] })}
                            >
                              <SelectTrigger aria-label={`Hành động event ${i + 1}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {CHAOS_ACTIONS.map((o) => (
                                  <SelectItem key={o.value} value={o.value}>
                                    {o.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          {ev.action === 'block_reconnect' && (
                            <div className="space-y-1.5">
                              <Label htmlFor={`chaos-duration-${i}`} className="text-xs">
                                Thời gian chặn (giây)
                              </Label>
                              <Input
                                id={`chaos-duration-${i}`}
                                type="number"
                                min={1}
                                placeholder="vd 60"
                                value={ev.durationSec}
                                onChange={(e) => updateChaosEvent(i, { durationSec: e.target.value })}
                              />
                            </div>
                          )}
                        </div>
                      ))}
                      <Button type="button" variant="outline" size="sm" className="w-full" onClick={addChaosEvent}>
                        + Thêm event
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </Card>
        </div>

        {/* Cột phải: cảnh báo + ước lượng + tổng quan */}
        <div className="space-y-4 lg:col-span-8">
          {productionTarget && (
            <AlertBanner
              variant="destructive"
              title="Đây có vẻ là PRODUCTION"
              description="Tải lớn sẽ làm sập gateway thật. Chạy test gateway trước, hoặc thêm tường minh vào LOADTEST_ALLOWLIST."
              action={{ label: 'Mở Settings >', onClick: () => navigate(routes.loadtestSettings) }}
            />
          )}
          {allowlistFail && (
            <AlertBanner
              variant="destructive"
              title="Gateway không nằm trong danh sách test"
              description="Thêm vào Settings trước khi chạy — nút Bắt đầu bị ẩn (SD-1 chặn cứng)."
              action={{ label: 'Mở Settings >', onClick: () => navigate(routes.loadtestSettings) }}
            />
          )}
          {!config?.hasOtpSecret && (
            <AlertBanner
              variant="destructive"
              title="Thiếu OTP_SECRET hoặc quyền ghi Redis"
              description="Không thể register user test. Kiểm tra loadtest/.env (OTP_SECRET, LOADTEST_REDIS_URL)."
              action={{ label: 'Mở Settings >', onClick: () => navigate(routes.loadtestSettings) }}
            />
          )}
          {hugePreset && !infraBannerDismissed && (
            <AlertBanner
              variant="warning"
              title="Preset 1M cần ~32–40 workers + ≥64GB RAM"
              description="Máy hiện tại (~16 core / 64GB) chỉ đủ cho ≤ 100k. Đóng banner này chỉ có hiệu lực cho phiên này."
              dismissible
              onDismiss={() => setInfraBannerDismissed(true)}
            />
          )}
          {targetOverCap && !hugePreset && (
            <AlertBanner
              variant="warning"
              title="Target vượt năng lực máy"
              description="Run sẽ chậm hơn dự kiến — vẫn cho phép Bắt đầu (user tự chịu trách nhiệm)."
            />
          )}

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-medium">ƯỚC LƯỢNG</h2>
            <div className="grid grid-cols-3 gap-3">
              <StatCard title="Workers" value={estimate.workers} unit="workers" />
              <StatCard title="RAM ước tính" value={estimate.ramGB} unit="GB" />
              <StatCard
                title="Thời gian seat ước tính"
                value={estimate.seatMin}
                unit="phút"
                hint="Matching engine ~100 user/s (MAX_POP=200/2s)"
              />
            </div>
          </Card>

          {phase !== 'idle' && (
            <Card className="p-4">
              <h2 className="mb-3 text-sm font-medium">TỔNG QUAN NHANH</h2>
              <div className="grid grid-cols-3 gap-3">
                <StatCard title="User đã tạo" value={fmtNum(counters?.usersCreated ?? 0)} />
                <StatCard title="Đã connect" value={fmtNum(counters?.usersConnected ?? 0)} variant="info" />
                <StatCard title="Active" value={fmtNum(counters?.usersActive ?? 0)} variant="success" />
              </div>
            </Card>
          )}

          {phase !== 'idle' && (
            <Card className="hidden p-4 lg:block">
              <h2 className="mb-3 text-sm font-medium">TIMELINE PHASE</h2>
              <PhaseTimeline phase={phase} />
            </Card>
          )}

          {startError && (
            <AlertBanner
              variant="destructive"
              title="Server chặn run"
              description={startError}
              action={{ label: 'Đóng', onClick: () => setStartError(null) }}
            />
          )}
        </div>
      </div>

      {/* [bottom] CTA thumb-zone */}
      <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 border-t border-border bg-background/80 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:bottom-0">
        {phase === 'idle' && (
          <Button
            size="lg"
            className="w-full min-h-12"
            disabled={allowlistFail || targetInvalid || !config || startCooldown > 0}
            onClick={() => {
              // requireEnvConfirm = off → bỏ qua confirm dialog môi trường (pref Settings > An toàn).
              if (requireEnvConfirm) setConfirmOpen(true);
              else void onConfirmStart();
            }}
          >
            {startCooldown > 0 ? `Thử lại sau ${startCooldown}s` : 'BẮT ĐẦU'}
          </Button>
        )}
        {running && (
          <div className="space-y-2">
            <p className="text-center font-mono text-lg tabular-nums text-foreground">{fmtClock(elapsedSec)}</p>
            <div className="flex gap-3">
              <Button
                variant="outline"
                className="min-h-12 flex-1"
                onClick={() => (paused ? void resumeRun() : void pauseRun())}
              >
                {paused ? 'Tiếp tục' : 'Tạm dừng'}
              </Button>
              <Button
                variant="destructive"
                className="min-h-12 flex-1"
                disabled={stopCooldown > 0}
                onClick={() => setStopOpen(true)}
              >
                {stopCooldown > 0 ? `Thử lại sau ${stopCooldown}s` : 'Dừng'}
              </Button>
            </div>
          </div>
        )}
        {phase === 'cooldown' && (
          <p className="py-3 text-center text-sm text-warning">Đang chốt số liệu...</p>
        )}
        {TERMINAL_PHASES.includes(phase) && (
          <div className="flex gap-3">
            <Button size="lg" variant="outline" className="min-h-12 flex-1" onClick={() => resetRun()}>
              Run mới
            </Button>
            <Button size="lg" variant="default" className="min-h-12 flex-1" onClick={() => navigate(routes.loadtestReport)}>
              Xem báo cáo &gt;
            </Button>
          </div>
        )}
      </div>

      <StartRunConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        gatewayUrl={gatewayUrl}
        hugePreset={hugePreset || targetOverCap}
        onConfirm={onConfirmStart}
      />
      <StopRunConfirmDialog open={stopOpen} onOpenChange={setStopOpen} kill={false} onConfirm={onConfirmStop} />
    </div>
  );
}
