import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ArrowRight, Loader2, Lock, LogIn, UserRound } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertBanner } from '@/components/ui/alert-banner';
import { useLoadtestAuthStore } from '@/store/loadtest-auth.store';
import { loadtestApi } from '@/lib/loadtest-api';
import { routes } from '@/lib/env';

interface LoginLocationState {
  registered?: boolean;
  from?: string;
}

/** Màn L — Login admin (PRD-loadtest-admin-auth Màn L). */
export default function LoadtestLoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const isAuthenticated = useLoadtestAuthStore((s) => s.isAuthenticated);
  const login = useLoadtestAuthStore((s) => s.login);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // D-17: config allowRegister=false → ẩn CTA đăng ký (hết dead-end 403). Default true.
  const [allowRegister, setAllowRegister] = useState(true);

  useEffect(() => {
    let cancelled = false;
    loadtestApi
      .getConfig()
      .then((c) => {
        if (!cancelled) setAllowRegister(c.allowRegister !== false);
      })
      .catch(() => {
        // config lỗi (server chưa lên) → giữ CTA hiện (mặc định true) — 403 fallback vẫn chạy.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const state = location.state as LoginLocationState | null;

  if (isAuthenticated) return <Navigate to={routes.loadtest} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!identifier.trim() || !password) {
      setError('Vui lòng nhập username/email và mật khẩu.');
      return;
    }
    setLoading(true);
    const res = await login(identifier.trim(), password);
    setLoading(false);
    if (res.ok) {
      navigate(state?.from ?? routes.loadtest, { replace: true });
      return;
    }
    setError(res.error ?? 'Đăng nhập thất bại.');
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="brand-gradient mb-4 flex h-16 w-16 items-center justify-center rounded-2xl shadow-lg shadow-primary/30">
            <LogIn className="h-8 w-8 text-white" aria-hidden />
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight">
            <span className="brand-text">MAYogu LoadTest</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Đăng nhập quản trị để truy cập dashboard</p>
        </div>

        <Card className="p-6">
          {state?.registered && (
            <AlertBanner variant="success" title="Đăng ký thành công" description="Đăng nhập bằng tài khoản vừa tạo." className="mb-4" />
          )}
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="loadtest-identifier">Username / Email</Label>
              <div className="relative">
                <UserRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  id="loadtest-identifier"
                  autoComplete="username"
                  placeholder="admin"
                  className="pl-9"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  disabled={loading}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="loadtest-password">Mật khẩu</Label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  id="loadtest-password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  className="pl-9"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                />
              </div>
            </div>
            {error && <AlertBanner variant="destructive" title={error} />}
            <Button type="submit" variant="gradient" className="w-full min-h-12" disabled={loading}>
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <>
                  Đăng nhập <ArrowRight className="h-4 w-4" aria-hidden />
                </>
              )}
            </Button>
          </form>
          {allowRegister && (
            <p className="mt-4 text-center text-sm text-muted-foreground">
              Chưa có tài khoản?{' '}
              <Link to={routes.loadtestRegister} className="font-medium text-primary underline-offset-4 hover:underline">
                Đăng ký
              </Link>
            </p>
          )}
          {!allowRegister && (
            <p className="mt-4 text-center text-xs text-muted-foreground">
              Đăng ký đã bị tắt trên server này — set <code className="font-mono">LOADTEST_ALLOW_REGISTER=true</code> trong{' '}
              <code className="font-mono">loadtest/.env</code> để kích hoạt.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}