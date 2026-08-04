import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Lock } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { AlertBanner } from '@/components/ui/alert-banner';
import { useLoadtestStore } from '@/store/loadtest.store';
import type { ActionProfile } from '@/types/loadtest';

const PROFILE_KEYS = ['chat', 'read', 'comment', 'like', 'view'] as const;

const DEFAULT_YAML = `# phases:
duration: 1800
rampUp: 300
profiles:
  chat: 40
  read: 30
  comment: 20
  like: 10
  view: 0
`;

function buildYaml(profile: ActionProfile): string {
  return `# phases:
duration: 1800
rampUp: 300
profiles:
  chat: ${profile.chat}
  read: ${profile.read}
  comment: ${profile.comment}
  like: ${profile.like}
  view: ${profile.view}
`;
}

interface ValidationLine {
  level: 'error' | 'warning' | 'ok';
  text: string;
}

export default function ScenarioBuilderPage() {
  const navigate = useNavigate();
  const profile = useLoadtestStore((s) => s.profile);
  const setProfile = useLoadtestStore((s) => s.setProfile);

  const [fileName, setFileName] = useState('default-scenario.yaml');
  const [profiles, setProfiles] = useState<ActionProfile>({ ...profile });
  const [yaml, setYaml] = useState(() => buildYaml(profile));
  const [loading, setLoading] = useState(true);

  // Loading trạng thái mặc định (UI-SPEC Màn 4: "Đang tải kịch bản mặc định...").
  useEffect(() => {
    const t = window.setTimeout(() => setLoading(false), 250);
    return () => window.clearTimeout(t);
  }, []);

  const sum = PROFILE_KEYS.reduce((acc, k) => acc + (Number(profiles[k]) || 0), 0);

  const validation = useMemo<ValidationLine[]>(() => {
    const lines: ValidationLine[] = [];
    if (sum !== 100) {
      lines.push({ level: 'error', text: `Tổng profile = ${sum}% — cần đủ 100%` });
    } else {
      lines.push({ level: 'ok', text: `Tổng profile = 100% ✓` });
    }
    const dur = Number(yaml.match(/duration:\s*(\d+)/)?.[1] ?? 0);
    const ramp = Number(yaml.match(/rampUp:\s*(\d+)/)?.[1] ?? 0);
    if (dur > 3600) lines.push({ level: 'warning', text: `duration ${dur}s > 3600s (access token 1h — server sẽ chặn)` });
    if (ramp > 0 && ramp < 60) lines.push({ level: 'warning', text: `rampUp ${ramp}s quá nhanh — matching trần ~100 user/s (MAX_POP=200/2s)` });
    if (!/duration:\s*\d+/.test(yaml)) lines.push({ level: 'error', text: 'Thiếu khóa bắt buộc: duration' });
    if (!/rampUp:\s*\d+/.test(yaml)) lines.push({ level: 'error', text: 'Thiếu khóa bắt buộc: rampUp' });
    if (!/profiles:/.test(yaml)) lines.push({ level: 'error', text: 'Thiếu khóa bắt buộc: profiles' });
    return lines;
  }, [sum, yaml]);

  const hasErrors = validation.some((v) => v.level === 'error');

  const setProfileField = (k: keyof ActionProfile, v: number) => {
    setProfiles((prev) => ({ ...prev, [k]: v }));
  };

  const saveAndApply = () => {
    setProfile({ ...profiles });
    toast.success(`Đã áp dụng kịch bản ${fileName}`);
    navigate(-1);
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-11 w-64" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
        <p className="text-sm text-muted-foreground">Đang tải kịch bản mặc định...</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">KỊCH BẢN</h1>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={fileName}
            onChange={(e) => setFileName(e.target.value)}
            className="max-w-56 font-mono text-sm"
            aria-label="Tên file kịch bản"
          />
          <Button variant="outline" className="min-h-11" onClick={() => toast.success(`Đã lưu ${fileName} (cục bộ)`)}>
            Lưu
          </Button>
          <Button variant="outline" className="min-h-11" onClick={() => toast.info('Load kịch bản — v1.1')}>
            Load
          </Button>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-12">
        <div className="space-y-4 lg:col-span-8">
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-medium">EDITOR YAML</h2>
              {yaml.trim() === '' && (
                <Button variant="ghost" size="sm" className="min-h-10" onClick={() => setYaml(DEFAULT_YAML)}>
                  Tạo từ template
                </Button>
              )}
            </div>
            <Textarea
              value={yaml}
              onChange={(e) => setYaml(e.target.value)}
              spellCheck={false}
              className="min-h-64 font-mono text-xs leading-5"
              aria-label="Nội dung kịch bản YAML"
            />
            {yaml.trim() === '' && (
              <p className="mt-2 text-center text-xs text-muted-foreground">Editor rỗng — bấm "Tạo từ template"</p>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="mb-2 text-sm font-medium">KIỂM TRA</h2>
            {validation.length === 0 ? (
              <p className="text-sm text-muted-foreground">Chưa có kiểm tra.</p>
            ) : (
              <div className="space-y-2">
                {validation.map((v, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Badge variant={v.level === 'error' ? 'destructive' : v.level === 'warning' ? 'warning' : 'success'}>
                      {v.level === 'error' ? 'Lỗi' : v.level === 'warning' ? 'Cảnh báo' : 'OK'}
                    </Badge>
                    <span className="text-sm">{v.text}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-4 lg:col-span-4">
          <Card className="p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-medium">PROFILES (tổng phải = 100%)</h2>
              {sum === 100 ? <Badge variant="success">100%</Badge> : <Badge variant="destructive">{sum}%</Badge>}
            </div>
            <div className="space-y-3">
              {PROFILE_KEYS.map((k) => (
                <div key={k} className="flex items-center gap-3">
                  <Label htmlFor={`profile-${k}`} className="w-24">
                    {k}
                  </Label>
                  <Input
                    id={`profile-${k}`}
                    type="number"
                    min={0}
                    max={100}
                    value={profiles[k]}
                    onChange={(e) => setProfileField(k, Number(e.target.value))}
                    aria-describedby={sum !== 100 ? 'profile-sum-error' : undefined}
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                </div>
              ))}
            </div>
            {sum !== 100 && (
              <AlertBanner variant="warning" title={`Tổng profile = ${sum}% — cần đủ 100%`} className="mt-3" />
            )}
          </Card>

          <Card className="p-4">
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
              <Lock className="h-3.5 w-3.5" aria-hidden /> PACING
            </h2>
            <p className="text-sm">chat send ≥ 2s/user | typing 1.5s | topic 15s | cooldown 900s</p>
            <p className="mt-1 text-xs text-muted-foreground">Khóa cứng theo hệ thống — không sửa được</p>
          </Card>
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-16 z-30 border-t border-border bg-background/80 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:bottom-0">
        <div className="flex gap-3">
          <Button variant="outline" className="min-h-12 flex-1" onClick={() => navigate(-1)}>
            Hủy
          </Button>
          <Button className="min-h-12 flex-1" disabled={hasErrors} onClick={saveAndApply}>
            Lưu &amp; áp dụng
          </Button>
        </div>
      </div>
    </div>
  );
}
