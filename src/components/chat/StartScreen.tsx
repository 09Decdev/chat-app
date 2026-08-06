import { useEffect, useState, type ClipboardEvent } from 'react';
import { motion } from 'framer-motion';
import { toast } from 'sonner';
import { Sparkles, Users, Clock, ShieldOff, Phone, ArrowRight, Tag, X, AlertTriangle } from 'lucide-react';
import { useChatStore } from '@/store/chat.store';
import { useAuthStore } from '@/store/auth.store';
import { env } from '@/lib/env';
import { cn } from '@/lib/utils';
import { topicDraft as topicDraftStorage } from '@/lib/storage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';

function useCountdown(until: number | null) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!until) return null;
  const remain = Math.max(0, until - Date.now());
  if (remain <= 0) return null; // timestamp đã qua → hết cooldown, không trả chuỗi "0:00" truthy
  const m = Math.floor(remain / 60000);
  const s = Math.floor((remain % 60000) / 1000);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const RULES = [
  { icon: Users, text: '6 nguoi moi phong, tu dong ghep theo FIFO' },
  { icon: Clock, text: 'Phong ton tai 3 gio, tu dong dong khi het han' },
  { icon: ShieldOff, text: 'Roi phong tu y -> khoa 15 phut truoc khi ghep lai' },
  { icon: Sparkles, text: 'Dung profile goc, khong co nick an' },
];

const QUICK_CHIPS = ['Review phim', 'Đi phượt', 'Âm nhạc', 'Chuyện công sở', 'Du lịch rẻ', 'Hỏi chuyện đời'];

export function StartScreen() {
  const startMatching = useChatStore((s) => s.startMatching);
  const cooldownUntil = useChatStore((s) => s.cooldownUntil);
  const loading = useChatStore((s) => s.phase === 'matching');
  const email = useAuthStore((s) => s.user?.email);
  const remaining = useCountdown(cooldownUntil);

  // Draft topic — bền qua F5 (sessionStorage), KHÔNG bền qua đóng tab (I5)
  const [draft, setDraft] = useState(() => topicDraftStorage.get());
  useEffect(() => {
    topicDraftStorage.set(draft);
  }, [draft]);

  const cp = [...draft].length; // code point count (BR-03)
  const valid = cp >= env.topicMinCp && cp <= env.topicMaxCp;
  const underMin = cp > 0 && cp < env.topicMinCp;
  const overMax = cp > env.topicMaxCp;

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text');
    if ([...text].length > env.topicMaxCp) {
      e.preventDefault();
      const trimmed = Array.from(text).slice(0, env.topicMaxCp).join('');
      setDraft(trimmed);
      toast('Đã cắt còn 80 ký tự');
    }
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="w-full max-w-md text-center">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="relative mx-auto mb-6 flex h-28 w-28 items-center justify-center"
        >
          <span className="absolute inset-0 rounded-full bg-primary/20 blur-2xl" />
          <div className="brand-gradient flex h-24 w-24 items-center justify-center rounded-full shadow-2xl shadow-primary/40">
            <Users className="h-12 w-12 text-white" />
          </div>
        </motion.div>

        <h2 className="text-2xl font-bold">San sang chat?</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          He thoc se ghep ban vao phong 6 nguoi cung luc.
        </p>

        {/* Khối TopicInput (WF-1) — NẰM TRÊN nút [Tìm phòng]. Topic tuỳ chọn, KHÔNG chặn luồng chính (I6). */}
        <div className="mt-4 rounded-xl border border-border/60 bg-card/40 p-3 text-left">
          <div className="mb-2 flex items-center gap-2 text-sm">
            <Tag className="h-4 w-4 text-primary" />
            <Label htmlFor="topic-input" className="cursor-pointer">
              Chủ đề của bạn
            </Label>
            <span className="text-xs text-muted-foreground">(tuỳ chọn)</span>
            <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/60">{cp}/{env.topicMaxCp}</span>
          </div>

          <Input
            id="topic-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={onPaste}
            maxLength={env.topicMaxCp + 20}
            placeholder="VD: Tâm sự chuyện công sở..."
            className="bg-background/40"
            aria-describedby="topic-hint-start"
          />

          <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto">
            {QUICK_CHIPS.map((chip) => (
              <Button
                key={chip}
                variant="outline"
                size="sm"
                className="h-7 shrink-0 px-3 text-xs"
                onClick={() => setDraft(chip)}
              >
                <Sparkles className="h-3 w-3" /> {chip}
              </Button>
            ))}
          </div>

          {valid && draft && (
            <Badge className="mt-2 inline-flex items-center gap-1.5">
              <Tag className="h-3 w-3" />
              <span className="max-w-[260px] truncate">{draft}</span>
              <button
                type="button"
                onClick={() => setDraft('')}
                aria-label="Xoá chủ đề"
                className="rounded-sm p-0.5 hover:bg-primary/20"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}

          {cp > 0 && (underMin || overMax) && (
            <p
              id="topic-hint-start"
              className={cn(
                'mt-2 flex items-center gap-1.5 text-xs',
                underMin ? 'text-muted-foreground' : 'text-amber-300',
              )}
            >
              <AlertTriangle className="h-3 w-3" />
              {underMin ? 'Tối thiểu 3 ký tự' : 'Đã đạt giới hạn 80 ký tự'}
            </p>
          )}
        </div>

        {remaining ? (
          <div className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
            <p className="text-sm text-amber-300">Ban vua roi phong. Cho khoa con lai:</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-amber-200">{remaining}</p>
          </div>
        ) : (
          <Button
            variant="gradient"
            size="lg"
            className="mt-6 w-full text-base"
            disabled={loading}
            onClick={() => void startMatching(draft)}
          >
            {loading ? 'Dang tim phong...' : (
              <>
                Tim phong chat <ArrowRight className="h-5 w-5" />
              </>
            )}
          </Button>
        )}

        <ul className="mt-8 space-y-2.5 text-left">
          {RULES.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-start gap-3 rounded-lg bg-card/40 px-3 py-2 text-sm text-muted-foreground">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
                <Icon className="h-3.5 w-3.5" />
              </span>
              {text}
            </li>
          ))}
        </ul>

        {email && (
          <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-muted-foreground/60">
            <Phone className="h-3 w-3" /> Dang nhap: {email}
          </p>
        )}
      </div>
    </div>
  );
}
