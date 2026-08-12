/**
 * Palette chung cho biểu đồ loadtest (UsersPage + LiveDashboard) — màu NHẤT QUÁN.
 * Màu theo --chart-N (src/index.css) — không hardcode hex rải rác.
 */
import type { ActionType, ConnectFailType, UserPhase } from '@/types/loadtest';

export const CHART_COLORS = {
  1: 'hsl(var(--chart-1))',
  2: 'hsl(var(--chart-2))',
  3: 'hsl(var(--chart-3))',
  4: 'hsl(var(--chart-4))',
  5: 'hsl(var(--chart-5))',
  6: 'hsl(var(--chart-6))',
  7: 'hsl(var(--chart-7))',
  8: 'hsl(var(--chart-8))',
  9: 'hsl(var(--chart-9))',
} as const;

/**
 * Màu theo phase user — dùng cho donut, badge phase, bảng users.
 * FIX-8: darkened (giữ nguyên hue/saturation, hạ lightness) để badge đạt WCAG AA
 * ≥ 4.5:1 với chữ trắng — L60% gốc chỉ đạt 1.5–3.6:1. Dùng giá trị cụ thể thay vì
 * --chart-N (bảng màu chart giữ L60% cho line/area/donut — chỉ phase palette hạ độ sáng).
 */
export const PHASE_COLORS: Record<UserPhase, string> = {
  provisioned: 'hsl(258 80% 62%)', // chưa connect (chờ) — violet đậm hơn
  connecting: 'hsl(48 96% 27%)', // đang bắt tay — vàng đậm
  connected: 'hsl(199 89% 36%)', // socket OK, ngoài phòng — xanh da trời đậm
  queued: 'hsl(38 92% 32%)', // chờ matching — hổ phách đậm
  in_room: 'hsl(160 84% 28%)', // đang ngồi phòng — xanh lá đậm
  idle: 'hsl(var(--muted-foreground))', // rảnh
  cooldown: 'hsl(291 64% 51%)', // chờ cooldown — tím đậm
  failed: 'hsl(14 85% 44%)', // lỗi — đỏ đậm
};

/** Màu theo action — giữ nguyên mapping ACTION_SERIES cũ (không đổi nhận diện). */
export const ACTION_COLORS: Record<ActionType, string> = {
  chat: CHART_COLORS[1],
  read: CHART_COLORS[2],
  comment: CHART_COLORS[3],
  like: CHART_COLORS[4],
  view: CHART_COLORS[5],
  post: CHART_COLORS[9],
  topic: CHART_COLORS[6],
  typing: CHART_COLORS[7],
  vote_kick: CHART_COLORS[8],
  match_wait: 'hsl(280 70% 50%)', // queue-wait telemetry — tím
};

/** Màu percentile latency — khớp LATENCY_SERIES cũ. */
export const PERCENTILE_COLORS = {
  p50: CHART_COLORS[2],
  p95: CHART_COLORS[1],
  p99: CHART_COLORS[6],
} as const;

/**
 * Màu breakdown connect fail theo loại (UI-SPEC §4.3 — token --chart-N):
 * timeout --chart-4 (vàng) · transport --chart-2 (xanh da trời) ·
 * reject --chart-6 (đỏ) · other --chart-8 (tím nhạt).
 */
export const CONNECT_FAIL_COLORS: Record<ConnectFailType, string> = {
  timeout: CHART_COLORS[4],
  transport: CHART_COLORS[2],
  reject: CHART_COLORS[6],
  other: CHART_COLORS[8],
};
