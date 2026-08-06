import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Check, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { AlertBanner } from '@/components/ui/alert-banner';
import { loadtestApi, toApiError } from '@/lib/loadtest-api';
import { CleanupConfirmDialog } from '@/components/loadtest/confirm-dialogs';
import { useLoadtestStore } from '@/store/loadtest.store';
import { fmtNum } from '@/lib/loadtest-format';
import type { CleanupResult } from '@/types/loadtest';
import { cn } from '@/lib/utils';

function StepBadge({ status }: { status: CleanupResult['steps'][number]['status'] }) {
  if (status === 'ok') {
    return (
      <Badge variant="success" className="gap-1">
        <Check className="h-3 w-3" aria-hidden /> ok
      </Badge>
    );
  }
  if (status === 'fail') {
    return (
      <Badge variant="destructive" className="gap-1">
        <X className="h-3 w-3" aria-hidden /> fail
      </Badge>
    );
  }
  return <Badge variant="secondary">{status === 'pending' ? 'pending' : 'skipped'}</Badge>;
}

export default function CleanupPage() {
  const navigate = useNavigate();
  const storeRunId = useLoadtestStore((s) => s.runId);
  const [runId, setRunId] = useState(storeRunId);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [mode, setMode] = useState<'dry' | 'exec'>('dry');
  const [scanning, setScanning] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const scan = async () => {
    if (!runId) {
      toast.error('Cần runId để dọn dẹp');
      return;
    }
    setScanning(true);
    setError(null);
    try {
      const res = await loadtestApi.cleanup(runId, true);
      setResult(res);
    } catch (e) {
      setError(toApiError(e).message);
    } finally {
      setScanning(false);
    }
  };

  useEffect(() => {
    void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const execute = async () => {
    if (!runId || !result) return;
    setExecuting(true);
    setError(null);
    try {
      const res = await loadtestApi.cleanup(runId, false);
      setResult(res);
      const allOk = res.steps.every((s) => s.status === 'ok' || s.status === 'skipped');
      if (allOk) toast.success('Dọn dẹp xong — hệ thống sạch');
      else toast.warning('Có bước chưa hoàn tất — xem chi tiết');
    } catch (e) {
      setError(toApiError(e).message);
    } finally {
      setExecuting(false);
    }
  };

  // Map per-step theo tên rõ ràng (backend cleanup.ts — 3 tầng): mỗi tile 1 nguồn,
  // KHÔNG gán chung user=post từ cùng biểu thức hay để step sau đè step trước.
  const stepCounts = (() => {
    const s = result?.steps ?? [];
    const counts = { user: 0, post: 0, redis: 0, session: 0 };
    for (const step of s) {
      if (step.name.startsWith('Tầng 1')) {
        counts.user = step.count; // user test (DB script — author loadtest.{runId}.*)
        counts.post = step.count; // post/comment test — cùng step API nghiệp vụ
      } else if (step.name.startsWith('Tầng 2')) {
        counts.redis = step.count; // Redis keys
      } else if (step.name.startsWith('Tầng 3')) {
        counts.session = step.count; // baseline leftover sau khi xóa
      }
    }
    return counts;
  })();

  const totalKeys = stepCounts.redis; // M5: 1 nguồn sự thật với tile (startsWith 'Tầng 2') — tránh lệch nếu tên step đổi format
  const isEmpty = result
    ? result.steps.every((s) => s.status !== 'fail') && totalKeys === 0 && result.baseline.userKeys === 0
    : false;

  if (scanning && !result) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-11 w-64" />
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-40 w-full" />
        <p className="text-sm text-muted-foreground">Đang quét dữ liệu test...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">
          CLEANUP: <span className="font-mono text-xs tracking-tight">{runId || 'chưa có runId'}</span>
        </h1>
        <div className="ml-auto flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className={cn('min-h-11', mode === 'dry' && 'border-primary text-primary')}
            aria-pressed={mode === 'dry'}
            onClick={() => setMode('dry')}
          >
            Dry-run
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className={cn('min-h-11', mode === 'exec' && 'ring-1 ring-destructive')}
            aria-pressed={mode === 'exec'}
            onClick={() => setMode('exec')}
          >
            Thực thi
          </Button>
        </div>
      </div>

      {!runId && (
        <div className="space-y-1.5">
          <Label htmlFor="run-id">Nhập runId cần dọn</Label>
          <div className="flex gap-2">
            <Input id="run-id" value={runId} onChange={(e) => setRunId(e.target.value)} placeholder="lt…" className="flex-1" />
            <Button variant="secondary" className="min-h-11" onClick={() => void scan()}>
              Quét
            </Button>
          </div>
        </div>
      )}

      {error && <AlertBanner variant="destructive" title="Lỗi cleanup" description={error} />}

      {result && isEmpty && (
        <Card className="p-6 text-center">
          <Badge variant="success">Không tìm thấy dữ liệu test — hệ thống sạch</Badge>
        </Card>
      )}

      {result && !isEmpty && (
        <>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <StatCard title="User" value={fmtNum(stepCounts.user)} hint={`email loadtest.${runId}.*`} />
            <StatCard title="Post/comment" value={fmtNum(stepCounts.post)} hint="prefix [lt]" />
            <StatCard title="Redis keys" value={fmtNum(stepCounts.redis)} hint="otp:register / match / chat" />
            <StatCard title="Session/device" value={fmtNum(stepCounts.session)} hint="baseline còn sót sau xóa" />
          </div>

          <Card className="p-4">
            <h2 className="mb-2 text-sm font-medium">BƯỚC THỰC HIỆN (3 tầng, chạy tuần tự)</h2>
            <div className="space-y-3">
              {result.steps.map((s, i) => (
                <div key={i} className="rounded-md border border-border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm">
                      {i + 1}. {s.name}
                    </p>
                    <StepBadge status={s.status} />
                  </div>
                  <p className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">{s.detail}</p>
                  {i === 2 && (
                    <ul className="mt-2 space-y-1 text-xs font-mono text-muted-foreground">
                      <li>✓ ZCARD match:queue:waiting = {s.status === 'ok' ? '0 (ok)' : '?'}</li>
                      <li>✓ user loadtest.* còn lại = {result.baseline.userKeys} {result.baseline.userKeys === 0 ? '(ok)' : '(còn sót)'}</li>
                      <li>✓ otp keys còn lại = {result.baseline.otpKeys} {result.baseline.otpKeys === 0 ? '(ok)' : '(còn sót)'}</li>
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </Card>

          <AlertBanner
            variant="destructive"
            title={`Cảnh báo: ${fmtNum(totalKeys)} redis keys sẽ bị xóa. Tiếp tục?`}
            description="Dry-run chỉ đọc và hiển thị — không xóa gì."
          />
        </>
      )}

      <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 border-t border-border bg-background/80 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:bottom-0">
        <div className="flex gap-3">
          <Button variant="outline" className="min-h-12 flex-1" onClick={() => navigate(-1)}>
            Quay lại
          </Button>
          <Button
            variant="destructive"
            className="min-h-12 flex-1"
            disabled={!result || executing || scanning || isEmpty}
            onClick={() => void (mode === 'dry' ? scan() : setConfirmOpen(true))}
          >
            {executing ? 'Đang xóa...' : mode === 'dry' ? 'Chạy dry-run' : 'Thực thi xóa'}
          </Button>
        </div>
      </div>

      <CleanupConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        runId={runId}
        redisKeys={totalKeys}
        onConfirm={() => {
          setConfirmOpen(false);
          void execute();
        }}
      />
    </div>
  );
}
