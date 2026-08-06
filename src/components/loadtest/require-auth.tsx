import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useLoadtestAuthStore } from '@/store/loadtest-auth.store';
import { routes } from '@/lib/env';

/**
 * Gate SPA dashboard loadtest (PRD C2): route /loadtest/* chưa đăng nhập →
 * redirect /loadtest/login (không render nội dung dashboard). Khôi phục session
 * từ localStorage + verify /auth/me khi mount.
 */
export function RequireLoadtestAuth() {
  const authReady = useLoadtestAuthStore((s) => s.authReady);
  const isAuthenticated = useLoadtestAuthStore((s) => s.isAuthenticated);
  const initialize = useLoadtestAuthStore((s) => s.initialize);
  const location = useLocation();

  useEffect(() => {
    void initialize();
  }, [initialize]);

  if (!authReady) {
    return (
      <div className="flex min-h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Đang kiểm tra phiên đăng nhập" />
      </div>
    );
  }
  if (!isAuthenticated) {
    return <Navigate to={routes.loadtestLogin} replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}