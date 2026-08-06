/**
 * Helpers tile "Connect fail" + card CONNECT FAIL BREAKDOWN (UI-SPEC §3/§4).
 * File riêng (thuần, test được) — không export từ LiveDashboardPage.tsx
 * (react-refresh only-export-components — file component chỉ export component).
 */
import type { StatVariant } from '@/components/ui/stat-card';
import type { ConnectFailType, ConnectFailsByType, LoadTestTick } from '@/types/loadtest';

export interface ConnectFailBreakdownRow {
  key: ConnectFailType;
  label: string;
  count: number;
  pct: number;
}

export const CONNECT_FAIL_KEYS: ConnectFailType[] = ['timeout', 'transport', 'reject', 'other'];

export const CONNECT_FAIL_LABELS: Record<ConnectFailType, string> = {
  timeout: 'timeout',
  transport: 'transport',
  reject: 'reject',
  other: 'other',
};

/**
 * Variant tile Connect fail (UI-SPEC §3 — D4/UI-3): `default` khi !tick / replay
 * (hasConnectData false) / chưa có attempt — KHÔNG hiện "0% healthy" giả.
 * rate >= 30 → error · >= 5 → warning · else success.
 */
export function connectFailVariant(tick: LoadTestTick | null | undefined): StatVariant {
  if (!tick || tick.hasConnectData === false || !tick.counters.connectAttempts) return 'default';
  const rate = tick.rates.connectFailRate ?? 0;
  if (rate >= 30) return 'error';
  if (rate >= 5) return 'warning';
  return 'success';
}

/**
 * Breakdown connect fail (UI-SPEC §4.3): tổng = **sum(byType)** (UI-2 — không dùng
 * connectFails trực tiếp cho % từng loại), sort desc, bỏ mục count 0.
 */
export function connectFailBreakdown(byType: ConnectFailsByType): ConnectFailBreakdownRow[] {
  const totalFails = CONNECT_FAIL_KEYS.reduce((acc, k) => acc + (byType[k] ?? 0), 0);
  if (totalFails <= 0) return [];
  return CONNECT_FAIL_KEYS.map((key) => ({
    key,
    label: CONNECT_FAIL_LABELS[key],
    count: byType[key] ?? 0,
    pct: ((byType[key] ?? 0) / totalFails) * 100,
  }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count);
}
