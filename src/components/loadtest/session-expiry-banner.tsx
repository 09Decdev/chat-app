/**
 * SessionExpiryBanner (T-09 / L-6) — UI-SPEC-prod-refactor §3.2.
 *
 * Banner dismissible (per tab session — KHÔNG persist vào prefs), hiện khi `expiresAt` còn
 * ≤ 30 phút. Text động từ `expiresAt` (static snapshot tại mount — không live countdown
 * trong vùng role="alert" để tránh re-announce mỗi phút với screen reader).
 * KHÔNG refresh, KHÔNG chặn — khi hết hạn thật, luồng 401 hiện có tự logout.
 */
import { useEffect, useState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { useLoadtestAuthStore } from '@/store/loadtest-auth.store';
import { shouldWarnSession, sessionExpiryText } from '@/lib/loadtest-session';

function useSessionExpiryNotice(): { visible: boolean; text: string } {
  const expiresAt = useLoadtestAuthStore((s) => s.expiresAt);
  const [now, setNow] = useState(() => Date.now());

  // Re-check mỗi 60s — expiresAt không đổi khi verify, nhưng thời gian trôi nên cần tick.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  const visible = shouldWarnSession(expiresAt, now);
  const text = visible && expiresAt ? sessionExpiryText(expiresAt, now) : '';
  return { visible, text };
}

export default function SessionExpiryBanner() {
  const [dismissed, setDismissed] = useState(false);
  const { visible, text } = useSessionExpiryNotice();

  if (!visible || dismissed) return null;
  return (
    <AlertBanner
      variant="warning"
      title="Phiên đăng nhập sắp hết hạn"
      description={text}
      dismissible
      onDismiss={() => setDismissed(true)}
    />
  );
}