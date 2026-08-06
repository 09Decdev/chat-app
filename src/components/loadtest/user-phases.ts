/**
 * User phases — nhãn + phân bố (donut) dùng chung UsersPage + LiveDashboard.
 * PHASE_COLORS (màu) ở chart-theme.ts — tránh khai báo 2 nơi.
 */
import type { LoadTestTick, UserActionState, UserPhase, VirtualUserRow } from '@/types/loadtest';
import { ACTION_LABELS } from '@/types/loadtest';
import { PHASE_COLORS } from './chart-theme';

export const USER_PHASE_ORDER: UserPhase[] = [
  'in_room',
  'queued',
  'connected',
  'connecting',
  'provisioned',
  'idle',
  'cooldown',
  'failed',
];

export const PHASE_LABELS: Record<UserPhase, string> = {
  in_room: 'Trong phòng',
  queued: 'Xếp hàng',
  connected: 'Đã kết nối',
  connecting: 'Đang kết nối',
  provisioned: 'Đã tạo',
  idle: 'Rảnh',
  cooldown: 'Chờ cooldown',
  failed: 'Lỗi',
};

export const ACTION_STATE_LABELS: Record<UserActionState, string> = {
  chat: 'Đang chat',
  read: 'Đọc bài',
  comment: 'Bình luận',
  like: 'Thích',
  view: 'Xem bài',
  post: 'Đăng bài',
  typing: 'Đang gõ',
  topic: 'Đổi chủ đề',
  vote_kick: 'Vote kick',
  idle: 'Rảnh',
};

/** Slice donut từ 1 row — dùng cho cả phaseCounts (API) lẫn tick counters. */
export interface PhaseSlice {
  key: UserPhase;
  label: string;
  value: number;
  color: string;
}

/** Chuyển phaseCounts (GET /users) → slices donut, bỏ phase 0. */
export function slicesFromPhaseCounts(counts: Partial<Record<UserPhase, number>>): PhaseSlice[] {
  return USER_PHASE_ORDER.filter((p) => (counts[p] ?? 0) > 0).map((p) => ({
    key: p,
    label: PHASE_LABELS[p],
    value: counts[p] ?? 0,
    color: PHASE_COLORS[p],
  }));
}

/**
 * Phân bố user theo phase từ tick counters (LiveDashboard — không cần gọi /users).
 * Rời rạc, không chồng lấp: in_room → queued → connected (idle) → chưa kết nối → failed.
 * failed (D7) lấy từ c.usersFailed, trừ khỏi notConnected — tổng donut = usersCreated.
 * Nếu chưa có user nào → [].
 */
export function slicesFromTick(tick: LoadTestTick | null | undefined): PhaseSlice[] {
  if (!tick) return [];
  const c = tick.counters;
  const total = c.usersCreated;
  if (total <= 0) return [];
  const connectedIdle = Math.max(0, c.usersConnected - c.usersInRoom - c.usersQueued);
  const notConnected = Math.max(0, total - c.usersConnected - (c.usersFailed ?? 0));
  const parts: { key: UserPhase; value: number }[] = [
    { key: 'in_room', value: c.usersInRoom },
    { key: 'queued', value: c.usersQueued },
    { key: 'connected', value: connectedIdle },
    { key: 'provisioned', value: notConnected },
    ...((c.usersFailed ?? 0) > 0 ? [{ key: 'failed' as const, value: c.usersFailed }] : []),
  ];
  return parts
    .filter((p) => p.value > 0)
    .map((p) => ({ key: p.key, label: PHASE_LABELS[p.key], value: p.value, color: PHASE_COLORS[p.key] }));
}

/** Phân bố phase từ rows hiện có (fallback nhỏ — page nhỏ). */
export function slicesFromRows(rows: VirtualUserRow[]): PhaseSlice[] {
  const counts: Partial<Record<UserPhase, number>> = {};
  for (const r of rows) counts[r.phase] = (counts[r.phase] ?? 0) + 1;
  return slicesFromPhaseCounts(counts);
}

export { PHASE_COLORS, ACTION_LABELS };
