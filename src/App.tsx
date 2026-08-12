import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import LoginPage from '@/pages/LoginPage';
import ChatPage from '@/pages/ChatPage';
import { useAuthStore } from '@/store/auth.store';
import { connectChatSocket, disconnectChatSocket, useChatStore } from '@/store/chat.store';
import { routes } from '@/lib/env';
import { ImpersonationBanner } from '@/components/ImpersonationBanner';
import AppShell from '@/components/loadtest/app-shell';
import { RequireLoadtestAuth } from '@/components/loadtest/require-auth';
// Pages loadtest — React.lazy (FIX: tách khỏi bundle chính; vendor recharts/
// framer-motion/axios chỉ tải khi mở page tương ứng — xem manualChunks vite.config.ts).
const LoadtestLoginPage = lazy(() => import('@/pages/loadtest/LoginPage'));
const LoadtestRegisterPage = lazy(() => import('@/pages/loadtest/RegisterPage'));
const ControlPanelPage = lazy(() => import('@/pages/loadtest/ControlPanelPage'));
const LiveDashboardPage = lazy(() => import('@/pages/loadtest/LiveDashboardPage'));
const UsersPage = lazy(() => import('@/pages/loadtest/UsersPage'));
const ScenarioBuilderPage = lazy(() => import('@/pages/loadtest/ScenarioBuilderPage'));
const ReportPage = lazy(() => import('@/pages/loadtest/ReportPage'));
const SettingsPage = lazy(() => import('@/pages/loadtest/SettingsPage'));
const CleanupPage = lazy(() => import('@/pages/loadtest/CleanupPage'));
const HistoryPage = lazy(() => import('@/pages/loadtest/HistoryPage'));
const RunDetailPage = lazy(() => import('@/pages/loadtest/RunDetailPage'));
const ComparePage = lazy(() => import('@/pages/loadtest/ComparePage'));
const ImpersonationConsolePage = lazy(() => import('@/pages/loadtest/ImpersonationConsolePage'));
const FeedTestPage = lazy(() => import('@/pages/feed/FeedTestPage'));
const HomePage = lazy(() => import('@/pages/HomePage'));

/** Hydrate auth tu storage + ket noi/ngat socket theo trang thai dang nhap. */
function AuthGate() {
  const hydrate = useAuthStore((s) => s.hydrate);
  const accessToken = useAuthStore((s) => s.accessToken);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (isAuthenticated && accessToken) {
      connectChatSocket(accessToken);
    } else {
      disconnectChatSocket();
      useChatStore.getState().reset();
    }
  }, [isAuthenticated, accessToken]);

  return null;
}

export default function App() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      {/* Lớp 1 — app-level: bắt AuthGate, guard, router crash. KHÔNG resetKey (tránh crash-loop). */}
      <ErrorBoundary homePath={routes.home}>
        <TooltipProvider delayDuration={300}>
          <AuthGate />
          <ImpersonationBanner />
          <Suspense
            fallback={
              <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
                Đang tải…
              </div>
            }
          >
            <Routes>
              <Route path={routes.login} element={<LoginPage />} />
              <Route element={<ProtectedRoute />}>
                <Route path={routes.home} element={<HomePage />} />
                <Route path={routes.chat} element={<ChatPage />} />
                <Route path={routes.feed} element={<FeedTestPage />} />
              </Route>
              {/* LoadTest tool — gate admin auth (PRD C2): login/register public, /loadtest/* qua guard */}
              <Route path={routes.loadtestLogin} element={<LoadtestLoginPage />} />
              <Route path={routes.loadtestRegister} element={<LoadtestRegisterPage />} />
              <Route element={<RequireLoadtestAuth />}>
                <Route path={routes.loadtest} element={<AppShell />}>
                  <Route index element={<ControlPanelPage />} />
                  <Route path="live" element={<LiveDashboardPage />} />
                  <Route path="users" element={<UsersPage />} />
                  <Route path="scenario" element={<ScenarioBuilderPage />} />
                  <Route path="report" element={<ReportPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                  <Route path="cleanup" element={<CleanupPage />} />
                  <Route path="history" element={<HistoryPage />} />
                  <Route path="history/:runId" element={<RunDetailPage />} />
                  <Route path="compare" element={<ComparePage />} />
                  <Route path="console" element={<ImpersonationConsolePage />} />
                </Route>
              </Route>
              <Route path="*" element={<Navigate to={routes.home} replace />} />
            </Routes>
          </Suspense>
          <Toaster />
        </TooltipProvider>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
