import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Eye, EyeOff, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { AlertBanner } from '@/components/ui/alert-banner';
import { loadtestApi, toApiError } from '@/lib/loadtest-api';
import { useLoadtestStore } from '@/store/loadtest.store';
import { routes } from '@/lib/env';
import { cn } from '@/lib/utils';
import { isProductionLikeGateway } from '@/lib/loadtest-format';

export default function SettingsPage() {
  const navigate = useNavigate();
  const config = useLoadtestStore((s) => s.config);
  const configLoading = useLoadtestStore((s) => s.configLoading);
  const requireEnvConfirm = useLoadtestStore((s) => s.requireEnvConfirm);
  const setRequireEnvConfirm = useLoadtestStore((s) => s.setRequireEnvConfirm);

  const [urls, setUrls] = useState<string[]>([]);
  const [newUrl, setNewUrl] = useState('');
  const [showSecrets, setShowSecrets] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // GET allowlist fail → không reset mảng (tránh "Lưu" ghi đè allowlist server bằng []), disable nút lưu.
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    loadtestApi
      .allowlist()
      .then(({ allowlist }) => {
        setUrls(allowlist);
        setLoadError(null);
      })
      .catch((e) => setLoadError(toApiError(e).message));
  }, []);

  const addUrl = () => {
    const v = newUrl.trim();
    if (!v) return;
    if (!/^(ws:\/\/|http:\/\/|https:\/\/)/i.test(v)) {
      toast.error('URL không hợp lệ — cần bắt đầu bằng ws:// hoặc http(s)://');
      return;
    }
    setUrls((prev) => [...new Set([...prev, v.replace(/\/+$/, '')])]);
    setNewUrl('');
  };

  const removeUrl = (u: string) => setUrls((prev) => prev.filter((x) => x !== u));

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await loadtestApi.saveAllowlist(urls);
      toast.success('Đã lưu cấu hình');
    } catch (e) {
      setSaveError(toApiError(e).message);
      toast.error('Lưu thất bại', { description: toApiError(e).message });
    } finally {
      setSaving(false);
    }
  };

  if (configLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-11 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">CÀI ĐẶT</h1>
      {saveError && (
        <AlertBanner variant="destructive" title="Không lưu được cấu hình" description={saveError} />
      )}
      {loadError && (
        <AlertBanner
          variant="destructive"
          title="Không đọc được allowlist từ server"
          description={`${loadError} — nút lưu bị khóa để không ghi đè cấu hình server bằng danh sách rỗng.`}
        />
      )}

      <div className="grid gap-4 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-7">
          <Card className="p-4">
            <h2 className="mb-2 text-sm font-medium">MÔI TRƯỜNG TEST (allowlist — chặn cứng SD-1)</h2>
            {urls.length === 0 && (
              <AlertBanner
                variant="warning"
                title="Chưa có môi trường test nào — tool sẽ chặn mọi run"
                className="mb-3"
              />
            )}
            <div className="space-y-2">
              {urls.map((u) => (
                <div key={u} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
                  <span className="truncate font-mono text-sm">{u}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 shrink-0"
                    aria-label={`Xóa ${u}`}
                    onClick={() => removeUrl(u)}
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              ))}
            </div>
            <div className="mt-3 flex gap-2">
              <Input
                placeholder="ws://test-…"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addUrl();
                }}
              />
              <Button variant="secondary" className="min-h-11 shrink-0" onClick={addUrl}>
                Thêm
              </Button>
            </div>
            {isProductionLikeGateway(newUrl) && (
              <AlertBanner
                variant="destructive"
                title="Đây có vẻ là PRODUCTION"
                description="Thêm gateway thật vào allowlist = cho phép chạy tải lớn lên hệ thống thật. Chạy test gateway trước, hoặc chỉ thêm nếu thực sự cần test production."
                className="mt-2"
              />
            )}
            <p className="mt-2 text-xs text-muted-foreground">URL ngoài danh sách sẽ bị chặn ở Màn 1</p>
          </Card>

          <Card className="p-4">
            <h2 className="mb-2 text-sm font-medium">SECRETS / TEST ENV</h2>
            {!config?.hasOtpSecret && (
              <AlertBanner
                variant="destructive"
                title="Thiếu OTP_SECRET — register sẽ fail (E1)"
                description="Kiểm tra đường dẫn file, định dạng KEY=VALUE trong loadtest/.env"
                className="mb-3"
              />
            )}
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="otp-secret">OTP_SECRET path</Label>
                <div className="flex gap-2">
                  <Input
                    id="otp-secret"
                    type={showSecrets ? 'text' : 'password'}
                    readOnly
                    value={config?.hasOtpSecret ? '••••••••' : ''}
                    placeholder={config?.hasOtpSecret ? 'Đã cấu hình trong loadtest/.env' : 'Thiếu — khai báo trong loadtest/.env'}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-11 w-11 shrink-0"
                    aria-label={showSecrets ? 'Ẩn secret' : 'Hiện secret'}
                    onClick={() => setShowSecrets((v) => !v)}
                  >
                    {showSecrets ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="redis-url">Redis (write)</Label>
                <Input
                  id="redis-url"
                  type={showSecrets ? 'text' : 'password'}
                  readOnly
                  value={config?.hasRedisConfigured ? '••••••••' : ''}
                  placeholder={config?.hasRedisConfigured ? 'Đã cấu hình trong loadtest/.env' : 'Thiếu — khai báo LOADTEST_REDIS_URL'}
                />
              </div>
              <p className="text-xs text-muted-foreground">Chỉ hiển thị dạng đăng ký, không in giá trị — sửa trực tiếp trong loadtest/.env</p>
            </div>
          </Card>
        </div>

        <div className="space-y-4 lg:col-span-5">
          <Card className="p-4">
            <h2 className="mb-2 text-sm font-medium">GIỚI HẠN MẶC ĐỊNH</h2>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="register-ramp">register ramp</Label>
                <Input id="register-ramp" type="number" readOnly value={config?.maxRegisterRamp ?? 100} />
                <p className="text-xs text-muted-foreground">req/s — guest bucket 1000/8s (chỉnh trong loadtest/.env)</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pacing">per-user pacing</Label>
                <Input id="pacing" type="number" readOnly value={100} />
                <p className="text-xs text-muted-foreground">action/s max (khóa cứng hệ thống)</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="max-duration">max duration</Label>
                <Input id="max-duration" type="number" readOnly value={config?.maxDurationMin ?? 60} />
                <p className="text-xs text-muted-foreground">phút — access token 1h</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="retention">report retention</Label>
                <Input id="retention" type="number" readOnly value={30} />
                <p className="text-xs text-muted-foreground">ngày</p>
              </div>
            </div>
          </Card>

          <Card className="p-4">
            <h2 className="mb-2 text-sm font-medium">AN TOÀN</h2>
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="env-confirm" className="leading-tight">
                  Bắt buộc xác nhận môi trường trước khi chạy
                </Label>
                <Switch
                  id="env-confirm"
                  checked={requireEnvConfirm}
                  onCheckedChange={setRequireEnvConfirm}
                  aria-label="Bắt buộc xác nhận môi trường trước khi chạy"
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="auto-cleanup" className={cn('leading-tight', 'text-muted-foreground')}>
                  Auto-cleanup sau run (v1.1)
                </Label>
                <Switch id="auto-cleanup" disabled aria-label="Auto-cleanup sau run (chưa hỗ trợ)" />
              </div>
              <Button variant="outline" className="w-full min-h-11" onClick={() => navigate(routes.loadtestCleanup)}>
                Mở công cụ Cleanup &gt;
              </Button>
            </div>
          </Card>
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 border-t border-border bg-background/80 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:bottom-0">
        <div className="flex gap-3">
          <Button variant="outline" className="min-h-12 flex-1" onClick={() => navigate(-1)}>
            Hủy
          </Button>
          <Button className="min-h-12 flex-1" disabled={saving || !!loadError} onClick={() => void save()}>
            {saving ? 'Đang lưu...' : 'Lưu cấu hình'}
          </Button>
        </div>
      </div>
    </div>
  );
}
