import React, { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Activity,
  FileBarChart,
  FlaskConical,
  History,
  LogOut,
  Pause,
  Play,
  Settings2,
  SlidersHorizontal,
  TerminalSquare,
  Trash2,
  Users,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { routes } from '@/lib/env';
import { fmtClock } from '@/lib/loadtest-format';
import { useLoadtestStore } from '@/store/loadtest.store';
import { useLoadtestAuthStore } from '@/store/loadtest-auth.store';
import { TERMINAL_PHASES, ACTIVE_PHASES } from '@/types/loadtest';
import { RunStateBadge } from '@/components/loadtest/run-state-badge';
import { StopRunConfirmDialog } from '@/components/loadtest/confirm-dialogs';
import { LogsDialog } from '@/components/loadtest/logs-dialog';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import SessionExpiryBanner from '@/components/loadtest/session-expiry-banner';

// ─── Sticky header run (UX-FLOW nav #2): truy cập được từ mọi màn khi run chạy ──

function RunStickyHeader() {
  const phase = useLoadtestStore((s) => s.phase);
  const runId = useLoadtestStore((s) => s.runId);
  const elapsedSec = useLoadtestStore((s) => s.elapsedSec);
  const stopRun = useLoadtestStore((s) => s.stopRun);
  const pauseRun = useLoadtestStore((s) => s.pauseRun);
  const resumeRun = useLoadtestStore((s) => s.resumeRun);
  const paused = useLoadtestStore((s) => s.paused);
  const [stopOpen, setStopOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  // 429 rate-limit cooldown (UI-SPEC §5.3) — sticky stop lỗi → toast + disable + countdown + progress.
  const [stopCooldown, setStopCooldown] = useState(0);
  const [stopCooldownTotal, setStopCooldownTotal] = useState(0);

  useEffect(() => {
    if (stopCooldown <= 0) return;
    const t = window.setInterval(() => setStopCooldown((s) => (s <= 1 ? 0 : s - 1)), 1000);
    return () => window.clearInterval(t);
  }, [stopCooldown > 0]);

  if (phase === 'idle') return null;
  const frozen = TERMINAL_PHASES.includes(phase);

  const onConfirmStop = async () => {
    setStopOpen(false);
    const res = await stopRun(false);
    // F-3: stop lỗi KHÔNG nuốt im lặng — toast (có retryAfterSec nếu 429).
    if (!res.ok) {
      toast.error('Không dừng được run', { description: res.error?.message });
      if (res.error?.retryAfterSec && res.error.retryAfterSec > 0) {
        setStopCooldownTotal(res.error.retryAfterSec);
        setStopCooldown(res.error.retryAfterSec);
      }
    }
  };

  return (
    <header className="glass sticky top-0 z-40 border-b border-border">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        <span className="text-sm font-medium">
          {frozen ? 'FROZEN' : 'LIVE'}: <span className="font-mono text-xs tracking-tight">{runId || '—'}</span>
        </span>
        <RunStateBadge phase={phase} />
        <span className="font-mono text-sm tabular-nums text-muted-foreground">{fmtClock(elapsedSec)}</span>
        {frozen ? (
          <Badge variant="secondary" className="ml-auto">
            Số liệu cuối
          </Badge>
        ) : (
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11"
              aria-label={paused ? 'Tiếp tục run' : 'Tạm dừng run'}
              onClick={() => (paused ? void resumeRun() : void pauseRun())}
            >
              {paused ? <Play className="h-4 w-4" aria-hidden /> : <Pause className="h-4 w-4" aria-hidden />}
              {paused ? 'Tiếp tục' : 'Tạm dừng'}
            </Button>
            <div className="relative">
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="min-h-11"
                aria-label={stopCooldown > 0 ? `Thử lại sau ${stopCooldown} giây` : 'Dừng run'}
                disabled={stopCooldown > 0}
                onClick={() => setStopOpen(true)}
              >
                {stopCooldown > 0 ? `Thử lại sau ${stopCooldown}s` : 'Dừng'}
              </Button>
              {stopCooldown > 0 && stopCooldownTotal > 0 && (
                <Progress
                  value={(stopCooldown / stopCooldownTotal) * 100}
                  className="absolute -bottom-1.5 left-0 right-0 h-1"
                />
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-11 w-11"
              aria-label="Xem log"
              onClick={() => setLogsOpen(true)}
            >
              <TerminalSquare className="h-4 w-4" aria-hidden />
            </Button>
          </div>
        )}
      </div>
      <StopRunConfirmDialog open={stopOpen} onOpenChange={setStopOpen} kill={false} onConfirm={onConfirmStop} />
      <LogsDialog open={logsOpen} onOpenChange={setLogsOpen} />
    </header>
  );
}

// ─── Bottom nav (mobile < lg) ──────────────────────────────────────────────

const NAV_ITEMS = [
  { to: routes.loadtest, label: 'Cấu hình', icon: Settings2 },
  { to: routes.loadtestScenario, label: 'Kịch bản', icon: FlaskConical },
  { to: routes.loadtestLive, label: 'Live', icon: Activity },
  { to: routes.loadtestUsers, label: 'Users', icon: Users },
  { to: routes.loadtestHistory, label: 'Lịch sử', icon: History },
  { to: routes.loadtestReport, label: 'Báo cáo', icon: FileBarChart },
  { to: routes.loadtestCleanup, label: 'Dọn dẹp', icon: Trash2 },
  { to: routes.loadtestSettings, label: 'Cài đặt', icon: SlidersHorizontal },
];

function MobileBottomNav() {
  const phase = useLoadtestStore((s) => s.phase);
  const reportEnabled = TERMINAL_PHASES.includes(phase);
  const tab = (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/80 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
      aria-label="Điều hướng chính"
    >
      <div className="flex overflow-x-auto no-scrollbar">
        {NAV_ITEMS.map(({ to, label, icon: Icon }) => {
          const disabled = to === routes.loadtestReport && !reportEnabled;
          const item = (
            <NavLink
              key={to}
              to={to}
              aria-disabled={disabled}
              tabIndex={disabled ? -1 : undefined}
              className={({ isActive }) =>
                cn(
                  'flex min-h-12 min-w-[4.5rem] flex-shrink-0 flex-col items-center justify-center gap-0.5 text-xs',
                  isActive ? 'text-primary' : 'text-muted-foreground',
                  disabled && 'pointer-events-none opacity-40',
                )
              }
            >
              <Icon className="h-5 w-5" aria-hidden />
              {label}
            </NavLink>
          );
          return disabled ? (
            <Tooltip key={to}>
              <TooltipTrigger asChild>
                <span className="flex items-center justify-center">{item}</span>
              </TooltipTrigger>
              <TooltipContent>Chưa có báo cáo — chạy run đầu tiên</TooltipContent>
            </Tooltip>
          ) : (
            <React.Fragment key={to}>{item}</React.Fragment>
          );
        })}
      </div>
    </nav>
  );
  return tab;
}

// ─── Top nav (desktop >= lg) ───────────────────────────────────────────────

function DesktopTopNav() {
  const phase = useLoadtestStore((s) => s.phase);
  const reportEnabled = TERMINAL_PHASES.includes(phase);
  const username = useLoadtestAuthStore((s) => s.user?.username);
  const logout = useLoadtestAuthStore((s) => s.logout);
  const navigate = useNavigate();

  const onLogout = async () => {
    await logout();
    navigate(routes.loadtestLogin, { replace: true });
  };

  return (
    <header className="glass sticky top-0 z-40 hidden border-b border-border lg:block">
      <div className="flex items-center gap-6 px-6 py-3">
        <Link to={routes.loadtest} className="brand-text text-sm font-semibold tracking-wide">
          MAYogu LoadTest
        </Link>
        <nav className="flex items-center gap-1" aria-label="Điều hướng chính">
          {NAV_ITEMS.map(({ to, label }) => {
            const disabled = to === routes.loadtestReport && !reportEnabled;
            return (
              <NavLink
                key={to}
                to={to}
                aria-disabled={disabled}
                tabIndex={disabled ? -1 : undefined}
                className={({ isActive }) =>
                  cn(
                    'rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isActive ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                    disabled && 'pointer-events-none opacity-40',
                  )
                }
              >
                {label}
              </NavLink>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <RunStateBadge phase={phase} />
          {ACTIVE_PHASES.includes(phase) && <span className="font-mono text-xs text-muted-foreground">run live</span>}
          <span className="hidden text-xs text-muted-foreground xl:inline">
            Admin: <span className="font-mono">{username ?? '—'}</span>
          </span>
          <Button variant="ghost" size="sm" className="min-h-10" onClick={() => void onLogout()} aria-label="Đăng xuất">
            <LogOut className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">Đăng xuất</span>
          </Button>
        </div>
      </div>
    </header>
  );
}

// ─── AppShell: poll 1s + layout chung ──────────────────────────────────────

function AppShell() {
  const pollOnce = useLoadtestStore((s) => s.pollOnce);
  const loadConfig = useLoadtestStore((s) => s.loadConfig);
  const phase = useLoadtestStore((s) => s.phase);
  const pollStatus = useLoadtestStore((s) => s.pollStatus);
  const username = useLoadtestAuthStore((s) => s.user?.username);
  const logout = useLoadtestAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const location = useLocation();
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    // F5/reload: store reset phase='idle' → ACTIVE_PHASES không include idle → poll interval không start.
    // Gọi pollOnce 1 lần trên mount để phát hiện run đang chạy (status.phase từ server).
    void loadConfig().then(() => void pollOnce());
  }, [loadConfig, pollOnce]);

  useEffect(() => {
    // Chỉ poll khi run đang active (provisioning→report) — idle chưa có run / terminal
    // đã kết thúc: không gửi 2 request vô ích mỗi giây từ khi login.
    if (!ACTIVE_PHASES.includes(phase)) return;
    if (timerRef.current !== null) return;
    timerRef.current = window.setInterval(() => {
      void pollOnce();
    }, 1000);
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [pollOnce, phase]);

  const onLogout = async () => {
    await logout();
    navigate(routes.loadtestLogin, { replace: true });
  };

  return (
    <div className="min-h-full">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[100] focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:shadow"
      >
        Bỏ qua tới nội dung
      </a>
      <DesktopTopNav />
      <RunStickyHeader />
      {/* User bar mobile — header desktop đã hiện admin + logout */}
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 pt-3 lg:hidden">
        <span className="text-xs text-muted-foreground">
          Admin: <span className="font-mono">{username ?? '—'}</span>
        </span>
        <Button variant="ghost" size="sm" className="min-h-10" onClick={() => void onLogout()} aria-label="Đăng xuất">
          <LogOut className="h-4 w-4" aria-hidden /> Đăng xuất
        </Button>
      </div>
      {pollStatus === 'reconnecting' && (
        <div className="px-4 pt-3">
          <div role="alert" className="rounded-lg border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
            Đang kết nối lại dữ liệu live...
          </div>
        </div>
      )}
      <div className="px-4 pt-3">
        <SessionExpiryBanner />
      </div>
      <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl px-4 pb-24 pt-4 focus:outline-none lg:px-6 lg:pb-10">
        {/* Lớp 2 — route-level: crash 1 trang loadtest → fallback, shell + nav + poll 1s sống.
            resetKey=pathname → chuyển trang tự reset. Bọc TRONG guard (guard trả <Outlet/>,
            redirect null không bao giờ crash → không chặn luồng login). */}
        <ErrorBoundary resetKey={location.pathname} homePath={routes.loadtest}>
          <Outlet />
        </ErrorBoundary>
      </main>
      <MobileBottomNav />
    </div>
  );
}

export default AppShell;
