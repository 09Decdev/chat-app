import { useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth.store';
import { routes } from '@/lib/env';

/**
 * F-impersonate — banner dính top khi operator đang truy cập 1 virtual user.
 * Cho phép thoát (clear chat auth + về lại Users page) từ bất kỳ route nào.
 */
export function ImpersonationBanner() {
  const impersonating = useAuthStore((s) => s.impersonating);
  const user = useAuthStore((s) => s.user);
  const exitImpersonate = useAuthStore((s) => s.exitImpersonate);
  const navigate = useNavigate();
  if (!impersonating || !user) return null;
  return (
    <div className="fixed inset-x-0 top-0 z-50 border-b border-primary/40 bg-primary/15 px-4 py-2 text-sm backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-2">
        <span className="font-medium">Đang truy cập user:</span>
        <span className="font-mono text-xs tracking-tight">{user.email ?? user.id}</span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto min-h-9"
          onClick={() => {
            exitImpersonate();
            navigate(routes.loadtestUsers);
          }}
        >
          <LogOut className="h-4 w-4" aria-hidden /> Thoát
        </Button>
      </div>
    </div>
  );
}
