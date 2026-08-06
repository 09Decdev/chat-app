/**
 * Client-side CSV export cho tick history (Live + RunDetail replay).
 * Không phụ thuộc backend — serialize tick in-memory (ring 3600 cho Live, loaded samples cho replay).
 * Lưu ý: replay export chỉ chứa các tick trang đã load (phân trang) — cho full run dùng Report page.
 */
import type { LoadTestTick } from '@/types/loadtest';

function esc(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function ticksToCsv(ticks: LoadTestTick[]): string {
  const header = [
    'ts_iso', 'elapsedSec', 'phase',
    'usersConnected', 'usersActive', 'usersInRoom', 'usersQueued', 'usersFailed',
    'actionsTotal', 'successTotal', 'failTotal', 'echoOk', 'echoSent',
    'queueCount', 'roomCount', 'droppedOutbox', 'reconnectCount', 'rateLimitedNoEcho',
    'successRate', 'echoRate', 'connectFailRate',
    'p50', 'p95', 'p99',
    'workersAlive', 'workersTotal', 'cpuAvg', 'rssAvgMb',
  ].join(',');
  const rows = ticks.map((t) =>
    [
      new Date(t.ts).toISOString(),
      t.elapsedSec,
      t.phase,
      t.counters.usersConnected,
      t.counters.usersActive,
      t.counters.usersInRoom,
      t.counters.usersQueued,
      t.counters.usersFailed,
      t.counters.actionsTotal,
      t.counters.successTotal,
      t.counters.failTotal,
      t.counters.echoOk,
      t.counters.echoSent,
      t.counters.queueCount,
      t.counters.roomCount,
      t.counters.droppedOutbox,
      t.counters.reconnectCount,
      t.counters.rateLimitedNoEcho,
      t.rates?.successRate,
      t.rates?.echoRate,
      t.rates?.connectFailRate,
      t.latency?.p50,
      t.latency?.p95,
      t.latency?.p99,
      t.workers?.alive,
      t.workers?.total,
      t.workers?.cpuAvg,
      t.workers?.rssAvgMb,
    ]
      .map(esc)
      .join(','),
  );
  return [header, ...rows].join('\n');
}

export function downloadTextFile(filename: string, content: string, mime = 'text/csv;charset=utf-8'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Firefox có thể hủy download nếu revoke ngay sau click — hoãn ~1s.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
