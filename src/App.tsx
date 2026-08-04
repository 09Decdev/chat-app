import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import LoginPage from '@/pages/LoginPage';
import ChatPage from '@/pages/ChatPage';
import { useAuthStore } from '@/store/auth.store';
import { connectChatSocket, disconnectChatSocket, useChatStore } from '@/store/chat.store';
import { routes } from '@/lib/env';
import AppShell from '@/components/loadtest/app-shell';
import { RequireLoadtestAuth } from '@/components/loadtest/require-auth';
import LoadtestLoginPage from '@/pages/loadtest/LoginPage';
import LoadtestRegisterPage from '@/pages/loadtest/RegisterPage';
import ControlPanelPage from '@/pages/loadtest/ControlPanelPage';
import LiveDashboardPage from '@/pages/loadtest/LiveDashboardPage';
import ScenarioBuilderPage from '@/pages/loadtest/ScenarioBuilderPage';
import ReportPage from '@/pages/loadtest/ReportPage';
import SettingsPage from '@/pages/loadtest/SettingsPage';
import CleanupPage from '@/pages/loadtest/CleanupPage';
import HistoryPage from '@/pages/loadtest/HistoryPage';
import RunDetailPage from '@/pages/loadtest/RunDetailPage';

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
      <TooltipProvider delayDuration={300}>
        <AuthGate />
        <Routes>
          <Route path={routes.login} element={<LoginPage />} />
          <Route element={<ProtectedRoute />}>
            <Route path={routes.chat} element={<ChatPage />} />
          </Route>
          {/* LoadTest tool — gate admin auth (PRD C2): login/register public, /loadtest/* qua guard */}
          <Route path={routes.loadtestLogin} element={<LoadtestLoginPage />} />
          <Route path={routes.loadtestRegister} element={<LoadtestRegisterPage />} />
          <Route element={<RequireLoadtestAuth />}>
            <Route path={routes.loadtest} element={<AppShell />}>
              <Route index element={<ControlPanelPage />} />
              <Route path="live" element={<LiveDashboardPage />} />
              <Route path="scenario" element={<ScenarioBuilderPage />} />
              <Route path="report" element={<ReportPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="cleanup" element={<CleanupPage />} />
              <Route path="history" element={<HistoryPage />} />
              <Route path="history/:runId" element={<RunDetailPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to={routes.chat} replace />} />
        </Routes>
        <Toaster />
      </TooltipProvider>
    </BrowserRouter>
  );
}
