import { useNavigate } from 'react-router-dom';
import { MessageCircle, Newspaper, LogOut } from 'lucide-react';
import { useAuthStore } from '@/store/auth.store';
import { routes } from '@/lib/env';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/** Landing page sau login — chooser: vào chat hay xem feed. */
export default function HomePage() {
  const navigate = useNavigate();
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);

  return (
    <div className="min-h-screen bg-muted/30 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl flex flex-col gap-6">
        <header className="text-center">
          <h1 className="text-2xl font-bold">
            Chào{user?.email ? ` ${user.email}` : ''}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Chọn nơi bạn muốn vào</p>
        </header>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <button onClick={() => navigate(routes.chat)} className="text-left">
            <Card className="p-6 h-full hover:border-primary transition-colors cursor-pointer">
              <MessageCircle className="h-8 w-8 text-primary mb-3" />
              <div className="font-semibold text-lg">Vào chat</div>
              <div className="text-sm text-muted-foreground mt-1">
                Phòng chat ngẫu nhiên — ghép FIFO 6 người/phòng
              </div>
            </Card>
          </button>

          <button onClick={() => navigate(routes.feed)} className="text-left">
            <Card className="p-6 h-full hover:border-primary transition-colors cursor-pointer">
              <Newspaper className="h-8 w-8 text-primary mb-3" />
              <div className="font-semibold text-lg">Xem feed</div>
              <div className="text-sm text-muted-foreground mt-1">
                Bài viết community + khám phá — ranking + dwell tracking
              </div>
            </Card>
          </button>
        </div>

        <div className="text-center">
          <Button variant="ghost" size="sm" onClick={() => logout()}>
            <LogOut className="h-4 w-4 mr-1" /> Đăng xuất
          </Button>
        </div>
      </div>
    </div>
  );
}
