import { Users, Sparkles, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { LoginForm } from '@/components/auth/LoginForm';

export default function LoginPage() {
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-md animate-fade-up">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="brand-gradient mb-4 flex h-16 w-16 items-center justify-center rounded-2xl shadow-lg shadow-primary/30">
            <Users className="h-8 w-8 text-white" />
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight">
            <span className="brand-text">Match Chat</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Phong chat ngau nhien &mdash; 6 nguoi moi phong
          </p>
        </div>

        <Card className="border-border/60">
          <CardHeader>
            <CardTitle className="text-xl">Dang nhap</CardTitle>
            <CardDescription>
              Dung tai khoan da xac minh so dien thoai de tham gia chat.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LoginForm />
          </CardContent>
        </Card>

        <ul className="mt-6 space-y-2 text-center text-xs text-muted-foreground/80">
          <li className="flex items-center justify-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-primary" /> Tu dong ghep, FIFO
          </li>
          <li className="flex items-center justify-center gap-1.5">
            <ShieldCheck className="h-3.5 w-3.5 text-primary" /> Phong ton tai 3 gio &middot; Khoa 15 phut khi roi
          </li>
        </ul>
      </div>
    </div>
  );
}
