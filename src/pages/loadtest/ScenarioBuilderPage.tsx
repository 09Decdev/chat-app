import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Lock, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { AlertBanner } from '@/components/ui/alert-banner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLoadtestStore } from '@/store/loadtest.store';
import { PROFILE_KEYS, initEnabled, renormalizeProfile, type ProfileKey } from './scenario-profile';
import type { ActionProfile } from '@/types/loadtest';

const DEFAULT_YAML = `# phases:
duration: 1800
rampUp: 300
profiles:
  chat: 40
  read: 30
  comment: 20
  like: 10
  view: 0
  post: 0
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
  post: ${profile.post ?? 0}
`;
}

/**
 * Thay chỉ section `profiles:` trong YAML — giữ duration/rampUp/comment user đã sửa.
 * M6: buildYaml hardcode 1800/300 nên setProfileField/toggleAction dùng buildYaml sẽ ghi đè
 * edit duration/rampUp của user im lặng. Helper này chỉ swap block profiles.
 */
function replaceProfilesSection(yaml: string, profile: ActionProfile): string {
  const block = `profiles:\n  chat: ${profile.chat}\n  read: ${profile.read}\n  comment: ${profile.comment}\n  like: ${profile.like}\n  view: ${profile.view}\n  post: ${profile.post ?? 0}\n`;
  // Match `profiles:` + các dòng thụt lề theo sau (block), KHÔNG greedy-to-end — trước đây
  // xoá duration/rampUp nếu user đổi thứ tự cho profiles không ở cuối YAML.
  if (/^profiles:\s*$/m.test(yaml)) {
    return yaml.replace(/^profiles:\s*\n(?:[ \t]+\S[^\n]*\n)*/m, block);
  }
  return `${yaml.replace(/\n$/, '')}\n${block}`;
}

// ─── Lưu/Load kịch bản (localStorage cục bộ — thay stub "v1.1") ──────────────
const SCENARIO_KEY = 'lt-scenarios';
interface SavedScenario { fileName: string; yaml: string; savedAt: number; }
function readScenarios(): SavedScenario[] {
  try {
    const raw = localStorage.getItem(SCENARIO_KEY);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((s) => s && typeof s.fileName === 'string' && typeof s.yaml === 'string') : [];
  } catch {
    return [];
  }
}
function writeScenarios(list: SavedScenario[]): void {
  try {
    localStorage.setItem(SCENARIO_KEY, JSON.stringify(list));
  } catch {
    /* quota exceeded / private mode — bỏ qua */
  }
}

/**
 * Parse các giá trị profile từ YAML — null nếu section `profiles:` thiếu khóa/giá trị không phải số.
 * 2-way sync: YAML hợp lệ → cập nhật profiles; thiếu khóa → validation chặn save (không có trạng thái
 * "sửa mà không áp dụng").
 */
function parseYamlProfiles(yaml: string): ActionProfile | null {
  const section = yaml.match(/profiles:\s*([\s\S]*?)(?=\n\S|$)/);
  if (!section) return null;
  const out: ActionProfile = { chat: 0, read: 0, comment: 0, like: 0, view: 0, post: 0 };
  for (const k of PROFILE_KEYS) {
    const m = section[1].match(new RegExp(`^\\s*${k}:\\s*(\\d+)\\s*$`, 'm'));
    if (!m) return null;
    out[k] = Number(m[1]);
  }
  return out;
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
  const [enabled, setEnabled] = useState<Record<ProfileKey, boolean>>(() => initEnabled(profile));
  const [yaml, setYaml] = useState(() => buildYaml(profile));
  const [loading, setLoading] = useState(true);
  const [loadOpen, setLoadOpen] = useState(false);
  const [saved, setSaved] = useState<SavedScenario[]>(() => readScenarios());

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
    if (!parseYamlProfiles(yaml)) {
      lines.push({ level: 'error', text: 'profiles thiếu khóa hoặc giá trị không hợp lệ (cần đủ chat/read/comment/like/view/post)' });
    }
    return lines;
  }, [sum, yaml]);

  const hasErrors = validation.some((v) => v.level === 'error');

  const setProfileField = (k: keyof ActionProfile, v: number) => {
    const next = { ...profiles, [k]: v };
    setProfiles(next);
    // 2-way sync: chỉ thay section profiles — giữ duration/rampUp user đã sửa (M6).
    setYaml(replaceProfilesSection(yaml, next));
  };

  /** Bật/tắt action (F1): renormalize % đều cho các action được chọn; 0 action chọn → mặc định chat 100%. */
  const toggleAction = (k: ProfileKey) => {
    const next = { ...enabled, [k]: !enabled[k] };
    if (!PROFILE_KEYS.some((kk) => next[kk])) next.chat = true;
    setEnabled(next);
    const nextProfiles = renormalizeProfile(next, profiles);
    setProfiles(nextProfiles);
    setYaml(replaceProfilesSection(yaml, nextProfiles));
  };

  const onYamlChange = (v: string) => {
    setYaml(v);
    // 2-way sync: YAML hợp lệ → parse cập nhật profiles + enabled. YAML chưa hoàn chỉnh → giữ profiles,
    // validation hiện lỗi chặn save (không có trạng thái "sửa mà không áp dụng").
    const parsed = parseYamlProfiles(v);
    if (parsed) {
      setProfiles(parsed);
      setEnabled(initEnabled(parsed));
    }
  };

  const saveAndApply = () => {
    setProfile({ ...profiles });
    toast.success(`Đã áp dụng kịch bản ${fileName}`);
    navigate(-1);
  };

  const saveScenario = () => {
    if (!yaml.trim()) {
      toast.warning('YAML rỗng — không lưu được');
      return;
    }
    const name = fileName || 'default-scenario.yaml';
    const next: SavedScenario = { fileName: name, yaml, savedAt: Date.now() };
    const list = readScenarios().filter((s) => s.fileName !== name);
    list.unshift(next);
    writeScenarios(list);
    setSaved(list);
    toast.success(`Đã lưu kịch bản "${name}" (cục bộ)`);
  };

  const loadScenario = (s: SavedScenario) => {
    setFileName(s.fileName);
    onYamlChange(s.yaml);
    setLoadOpen(false);
    toast.success(`Đã load "${s.fileName}"`);
  };

  const deleteScenario = (name: string) => {
    const list = readScenarios().filter((s) => s.fileName !== name);
    writeScenarios(list);
    setSaved(list);
    toast.success(`Đã xoá "${name}"`);
  };

  // Tab → 2 khoảng trắng (indent) thay vì blur ra khỏi editor.
  const onYamlKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const ta = e.currentTarget;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const next = yaml.slice(0, start) + '  ' + yaml.slice(end);
    onYamlChange(next);
    requestAnimationFrame(() => {
      ta.selectionStart = ta.selectionEnd = start + 2;
    });
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
          <Button variant="outline" className="min-h-11" onClick={saveScenario}>
            Lưu
          </Button>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => {
              setSaved(readScenarios());
              setLoadOpen(true);
            }}
          >
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
              onChange={(e) => onYamlChange(e.target.value)}
              onKeyDown={onYamlKeyDown}
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
                  <Switch
                    id={`enable-${k}`}
                    checked={enabled[k]}
                    onCheckedChange={() => toggleAction(k)}
                    aria-label={`Bật action ${k}`}
                  />
                  <Label htmlFor={`enable-${k}`} className="w-20">
                    {k}
                  </Label>
                  <Input
                    id={`profile-${k}`}
                    type="number"
                    min={0}
                    max={100}
                    value={profiles[k]}
                    disabled={!enabled[k]}
                    onChange={(e) => setProfileField(k, Number(e.target.value))}
                    aria-describedby={sum !== 100 ? 'profile-sum-error' : undefined}
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Bật/tắt action cần chạy — % được chia đều (tổng 100). Bỏ chọn hết → mặc định chat 100%.
            </p>
            {sum !== 100 && (
              <AlertBanner variant="warning" title={`Tổng profile = ${sum}% — cần đủ 100%`} className="mt-3" />
            )}
          </Card>

          <Card className="p-4">
            <h2 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
              <Lock className="h-3.5 w-3.5" aria-hidden /> PACING
            </h2>
            <p className="text-sm">chat send ≥ 2s/user | typing 1.5s | topic 15s | vote_kick ~60s | cooldown 900s</p>
            <p className="mt-1 text-xs text-muted-foreground">Khóa cứng theo hệ thống — không sửa được</p>
          </Card>
        </div>
      </div>

      <Dialog open={loadOpen} onOpenChange={setLoadOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Kịch bản đã lưu (cục bộ)</DialogTitle>
          </DialogHeader>
          {saved.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Chưa có kịch bản nào — bấm "Lưu" để lưu.</p>
          ) : (
            <ul className="scrollbar-thin max-h-[50vh] space-y-1 overflow-auto">
              {saved.map((s) => (
                <li key={s.fileName} className="flex items-center gap-2 rounded-md border border-border p-2">
                  <button type="button" className="flex-1 text-left" onClick={() => loadScenario(s)}>
                    <span className="font-mono text-sm">{s.fileName}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{new Date(s.savedAt).toLocaleString()}</span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9"
                    aria-label={`Xoá ${s.fileName}`}
                    onClick={() => deleteScenario(s.fileName)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>

      <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-30 border-t border-border bg-background/80 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:bottom-0">
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
