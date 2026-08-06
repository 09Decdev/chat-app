/**
 * MAYogu LoadTest Tool — server-side sort cho bảng virtual users.
 * Whitelist cứng (KHÔNG chấp nhận chuỗi tuỳ ý — chống sort bừa/injection):
 * mọi field khác ngoài list → fallback mặc định index asc (nhất quán với
 * cách route /users clamp offset/limit — lenient query params).
 * Null luôn xếp CUỐI (cả asc lẫn desc) — dữ liệu chưa có không đứng đầu bảng.
 */

import type { UserPhase, VirtualUserRow } from './types';

export const USER_SORT_FIELDS = [
  'index',
  'email',
  'phase',
  'currentAction',
  'lastActionAt',
  'reconnectCount',
  'outboxPending',
] as const;

export type UserSortField = (typeof USER_SORT_FIELDS)[number];
export type UserSortDir = 'asc' | 'desc';

export const DEFAULT_SORT: { sortBy: UserSortField; sortDir: UserSortDir } = { sortBy: 'index', sortDir: 'asc' };

/** Chuẩn hoá sort param từ query string — không hợp lệ → mặc định index asc. */
export function normalizeSort(sortBy: unknown, sortDir: unknown): { sortBy: UserSortField; sortDir: UserSortDir } {
  const field = USER_SORT_FIELDS.includes(sortBy as UserSortField) ? (sortBy as UserSortField) : DEFAULT_SORT.sortBy;
  const dir: UserSortDir = sortDir === 'desc' ? 'desc' : 'asc';
  return { sortBy: field, sortDir: dir };
}

function fieldValue(row: VirtualUserRow, sortBy: UserSortField): number | string | null {
  switch (sortBy) {
    case 'index':
      return row.index;
    case 'email':
      return row.email;
    case 'phase':
      return row.phase;
    case 'currentAction':
      return row.currentAction;
    case 'lastActionAt':
      return row.lastActionAt;
    case 'reconnectCount':
      return row.reconnectCount;
    case 'outboxPending':
      return row.outboxPending;
  }
}

/** So sánh 2 row theo (sortBy, sortDir) — null/undefined luôn xếp cuối. */
export function compareUsers(a: VirtualUserRow, b: VirtualUserRow, sortBy: UserSortField, sortDir: UserSortDir): number {
  const va = fieldValue(a, sortBy);
  const vb = fieldValue(b, sortBy);
  const aNull = va === null || va === undefined;
  const bNull = vb === null || vb === undefined;
  if (aNull && bNull) return 0;
  if (aNull) return 1; // null cuối
  if (bNull) return -1;
  let cmp: number;
  if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
  else cmp = String(va).localeCompare(String(vb));
  return sortDir === 'desc' ? -cmp : cmp;
}

/** Sort ổn định (stable) toàn bộ rows theo (sortBy, sortDir). */
export function sortUsers(rows: VirtualUserRow[], sortBy: UserSortField, sortDir: UserSortDir): VirtualUserRow[] {
  return rows.sort((a, b) => compareUsers(a, b, sortBy, sortDir));
}

/** Gộp đếm phase từ nhiều worker (unfiltered counts) → 1 map tổng. */
export function mergePhaseCounts(
  counts: Array<Partial<Record<UserPhase, number>> | undefined>,
): Partial<Record<UserPhase, number>> {
  const out: Partial<Record<UserPhase, number>> = {};
  for (const c of counts) {
    if (!c) continue;
    for (const [phase, n] of Object.entries(c)) {
      out[phase as UserPhase] = (out[phase as UserPhase] ?? 0) + (n ?? 0);
    }
  }
  return out;
}
