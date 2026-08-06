/**
 * ScenarioBuilderPage (F1) — action checkboxes: keys + renormalize helpers.
 * Tách riêng khỏi component file vì react-refresh/only-export-components (file chỉ export component).
 */
import type { ActionProfile } from '@/types/loadtest';

export const PROFILE_KEYS = ['chat', 'read', 'comment', 'like', 'view', 'post'] as const;
export type ProfileKey = (typeof PROFILE_KEYS)[number];

/** Mặc định: action nào có % > 0 → bật; tất cả 0 → chỉ chat (F1). */
export function initEnabled(p: ActionProfile): Record<ProfileKey, boolean> {
  const anyOn = PROFILE_KEYS.some((k) => (p[k] ?? 0) > 0);
  const out = {} as Record<ProfileKey, boolean>;
  for (const k of PROFILE_KEYS) out[k] = anyOn ? (p[k] ?? 0) > 0 : k === 'chat';
  return out;
}

/** Renormalize % đều cho các action được chọn (tổng = 100). 0 action chọn → chat 100% (F1). */
export function renormalizeProfile(enabled: Record<ProfileKey, boolean>, current: ActionProfile): ActionProfile {
  const checked = PROFILE_KEYS.filter((k) => enabled[k]);
  const targets: ProfileKey[] = checked.length > 0 ? checked : ['chat'];
  const out: ActionProfile = { ...current };
  for (const k of PROFILE_KEYS) out[k] = 0;
  const share = Math.floor(100 / targets.length);
  let rem = 100;
  targets.forEach((k, i) => {
    const v = i === targets.length - 1 ? rem : share;
    out[k] = v;
    rem -= v;
  });
  return out;
}
