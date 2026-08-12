import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Mail, Lock, ArrowRight } from 'lucide-react';
import { useAuthStore } from '@/store/auth.store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { routes } from '@/lib/env';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginForm() {
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!EMAIL_RE.test(email.trim()) || !password) {
      setError('Vui lòng nhap email hop le va mat khau.');
      return;
    }
    setLoading(true);
    const res = await login(email.trim(), password);
    setLoading(false);
    if (res.ok) {
      navigate(routes.home, { replace: true });
      return;
    }
    if (res.require2fa) {
      setNotice(res.error ?? null);
      return;
    }
    setError(res.error ?? 'Dang nhap that bai.');
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <div className="relative">
          <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="ban@example.com"
            className="pl-9"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={loading}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Mat khau</Label>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="password"
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

      {error && <p className="text-sm text-destructive">{error}</p>}
      {notice && <p className="text-sm text-amber-400">{notice}</p>}

      <Button type="submit" variant="gradient" className="w-full" disabled={loading}>
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <>
            Dang nhap <ArrowRight className="h-4 w-4" />
          </>
        )}
      </Button>
    </form>
  );
}
