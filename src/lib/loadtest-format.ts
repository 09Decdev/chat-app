/**
 * LoadTest — helpers format số/giờ (tabular-nums, font-mono theo UI-SPEC 1.2).
 */

/** 11982 → "11,982". */
export function fmtNum(n: number): string {
  return (n ?? 0).toLocaleString('en-US');
}

/** 11850 → "11.9k"; 8.2M. */
export function fmtCompact(n: number): string {
  if (!Number.isFinite(n)) return '--';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(n));
}

/** 120 → "120ms"; 1.2s cho >= 1000. */
export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/** 4523 giây → "01:15:23". */
export function fmtClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${String(h).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** epoch ms → "HH:MM:SS" (trục X chart). */
export function fmtTickTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** epoch ms → "2026-08-03 01:00". */
export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

/** epoch ms → "5 giây trước" / "3 phút trước" / "1 giờ trước" (null → '—'). Không import thư viện mới. */
export function fmtRelative(ts: number | null | undefined, now = Date.now()): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '—';
  const diffSec = Math.max(0, Math.round((now - ts) / 1000));
  if (diffSec < 1) return 'vừa xong';
  if (diffSec < 60) return `${diffSec} giây trước`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} phút trước`;
  return `${Math.floor(diffSec / 3600)} giờ trước`;
}

/** Duration phút → "30 phút" / "30–60 phút". */
export function fmtRange(startAt: number, endAt: number): string {
  const start = new Date(startAt);
  const end = new Date(endAt);
  const pad = (x: number) => String(x).padStart(2, '0');
  const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${hm(start)}–${hm(end)}`;
}

/** "TÔI XÁC NHẬN" — chuỗi xác nhận chặn cứng (SD-1). */
export const CONFIRM_PHRASE = 'TÔI XÁC NHẬN';

/**
 * Detect gateway target giống PRODUCTION cho UI cảnh báo (guard — KHÔNG chặn
 * input; chặn cứng vẫn ở server allowlist SD-1). Hostname local
 * (localhost/127.0.0.1) và TLD .test = test env; MỌI hostname khác
 * (api.mayogu.com, mayogu.com, IP public, ...) = production-like.
 * URL không parse được → false (không cảnh báo giả — server vẫn gác).
 */
export function isProductionLikeGateway(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === 'test' || host.endsWith('.test')) return false;
    return true;
  } catch {
    return false;
  }
}
