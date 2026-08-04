import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ArrowLeft, Loader2, Lock, Mail, ShieldCheck, UserRound } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertBanner } from '@/components/ui/alert-banner';
import { useLoadtestAuthStore } from '@/store/loadtest-auth.store';
import { routes } from '@/lib/env';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Yêu cầu backend (db/password.ts validatePasswordStrength): ≥ 8 ký tự + đủ 3/4 nhóm. */
function validatePasswordStrength(password: string): string | null {
  if (password.length < 8) return 'Mật khẩu phải có ít nhất 8 ký tự';
  let groups = 0;
  if (/[a-z]/.test(password)) groups++;
  if (/[A-Z]/.test(password)) groups++;
  if (/[0-9]/.test(password)) groups++;
  if (/[^a-zA-Z0-9]/.test(password)) groups++;
  if (groups < 3) return 'Mật khẩu phải đủ 3/4 nhóm ký tự (chữ thường, chữ hoa, số, ký tự đặc biệt)';
  return null;
}

/** Màn R — Register admin (PRD-loadtest-admin-auth Màn R). Sau đăng ký → về Login kèm thông báo. */
export default function LoadtestRegisterPage() {
  const navigate = useNavigate();
  const isAuthenticated = useLoadtestAuthStore((s) => s.isAuthenticated);
  const register = useLoadtestAuthStore((s) => s.register);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isAuthenticated) return <Navigate to={routes.loadtest} replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const name = username.trim();
    const mail = email.trim().toLowerCase();
    if (!name) return setError('Vui lòng nhập username.');
    if (!EMAIL_RE.test(mail)) return setError('Email không hợp lệ.');
    const pwErr = validatePasswordStrength(password);
    if (pwErr) return setError(pwErr);
    if (password !== confirm) return setError('Mật khẩu xác nhận không khớp.');
    setLoading(true);
    const res = await register(name, mail, password);
    setLoading(false);
    if (res.ok) {
      navigate(routes.loadtestLogin, { replace: true, state: { registered: true } });
      return;
    }
    setError(res.error ?? 'Đăng ký thất bại.');
  }

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="brand-gradient mb-4 flex h-16 w-16 items-center justify-center rounded-2xl shadow-lg shadow-primary/30">
            <ShieldCheck className="h-8 w-8 text-white" aria-hidden />
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight">
            <span className="brand-text">Tạo tài khoản admin</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">Tool nội bộ — tài khoản mới có quyền admin</p>
        </div>

        <Card className="p-6">
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="loadtest-reg-username">Username</Label>
              <div className="relative">
                <UserRound className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  id="loadtest-reg-username"
                  autoComplete="username"
                  placeholder="admin"
                  className="pl-9"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={loading}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="loadtest-reg-email">Email</Label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  id="loadtest-reg-email"
                  type="email"
                  autoComplete="email"
                  placeholder="admin@loadtest.local"
                  className="pl-9"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="loadtest-reg-password">Mật khẩu</Label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  id="loadtest-reg-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="Tối thiểu 8 ký tự, đủ 3/4 nhóm"
                  className="pl-9"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="loadtest-reg-confirm">Xác nhận mật khẩu</Label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  id="loadtest-reg-confirm"
                  type="password"
                  autoComplete="new-password"
                  placeholder="••••••••"
                  className="pl-9"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={loading}
                />
              </div>
            </div>
            {error && <AlertBanner variant="destructive" title={error} />}
            <Button type="submit" variant="gradient" className="w-full min-h-12" disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : 'Đăng ký'}
            </Button>
          </form>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            <Link to={routes.loadtestLogin} className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline">
              <ArrowLeft className="h-4 w-4" aria-hidden /> Về trang đăng nhập
            </Link>
          </p>
        </Card>
      </div>
    </div>
  );
}