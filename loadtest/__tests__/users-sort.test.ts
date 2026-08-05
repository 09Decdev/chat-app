/**
 * Unit tests — server-side sort bảng users (users-sort.ts).
 * Whitelist sortBy/sortDir: chuỗi lạ → mặc định index asc; null luôn xếp cuối.
 */
import { describe, it, expect } from 'vitest';
import { compareUsers, mergePhaseCounts, normalizeSort, sortUsers, USER_SORT_FIELDS } from '../users-sort';
import type { VirtualUserRow } from '../types';

function row(partial: Partial<VirtualUserRow>): VirtualUserRow {
  return {
    index: 0,
    email: 'a@test.local',
    phase: 'idle',
    currentAction: null,
    lastActionAt: null,
    lastActionMs: null,
    messagesSent: 0,
    messagesEchoed: 0,
    roomId: null,
    socketConnected: false,
    reconnectCount: 0,
    outboxPending: 0,
    lastError: null,
    ...partial,
  };
}

describe('normalizeSort — whitelist cứng', () => {
  it('mọi field trong whitelist đều nhận (7 field sortable)', () => {
    expect(USER_SORT_FIELDS).toEqual([
      'index',
      'email',
      'phase',
      'currentAction',
      'lastActionAt',
      'reconnectCount',
      'outboxPending',
    ]);
  });

  it('sortBy hợp lệ + asc/desc giữ nguyên', () => {
    expect(normalizeSort('phase', 'asc')).toEqual({ sortBy: 'phase', sortDir: 'asc' });
    expect(normalizeSort('lastActionAt', 'desc')).toEqual({ sortBy: 'lastActionAt', sortDir: 'desc' });
  });

  it('sortBy lạ (không trong whitelist) → mặc định index (sortDir vẫn giữ nếu hợp lệ)', () => {
    expect(normalizeSort('__proto__', 'desc')).toEqual({ sortBy: 'index', sortDir: 'desc' });
    expect(normalizeSort('email; DROP TABLE', 'asc')).toEqual({ sortBy: 'index', sortDir: 'asc' });
    expect(normalizeSort(undefined, undefined)).toEqual({ sortBy: 'index', sortDir: 'asc' });
  });

  it('sortDir lạ → asc (chỉ chấp nhận asc|desc)', () => {
    expect(normalizeSort('email', 'DESC')).toEqual({ sortBy: 'email', sortDir: 'asc' });
    expect(normalizeSort('email', 'random')).toEqual({ sortBy: 'email', sortDir: 'asc' });
  });
});

describe('compareUsers — null luôn cuối + thứ tự đúng', () => {
  it('index asc/desc', () => {
    const a = row({ index: 2 });
    const b = row({ index: 10 });
    expect(compareUsers(a, b, 'index', 'asc')).toBeLessThan(0);
    expect(compareUsers(a, b, 'index', 'desc')).toBeGreaterThan(0);
    expect(compareUsers(a, a, 'index', 'asc')).toBe(0);
  });

  it('email lexicographic asc/desc', () => {
    const a = row({ email: 'b@x' });
    const b = row({ email: 'a@x' });
    expect(compareUsers(a, b, 'email', 'asc')).toBeGreaterThan(0);
    expect(compareUsers(a, b, 'email', 'desc')).toBeLessThan(0);
  });

  it('phase + currentAction so sánh chuỗi', () => {
    const a = row({ phase: 'queued', currentAction: 'chat' });
    const b = row({ phase: 'in_room', currentAction: 'read' });
    expect(compareUsers(a, b, 'phase', 'asc')).toBeGreaterThan(0); // in_room < queued
    expect(compareUsers(a, b, 'currentAction', 'desc')).toBeGreaterThan(0); // read < chat
  });

  it('lastActionAt/reconnectCount/outboxPending số học', () => {
    const a = row({ lastActionAt: 100, reconnectCount: 5, outboxPending: 1 });
    const b = row({ lastActionAt: 200, reconnectCount: 2, outboxPending: 9 });
    expect(compareUsers(a, b, 'lastActionAt', 'asc')).toBeLessThan(0);
    expect(compareUsers(a, b, 'lastActionAt', 'desc')).toBeGreaterThan(0);
    expect(compareUsers(a, b, 'reconnectCount', 'desc')).toBeLessThan(0);
    expect(compareUsers(a, b, 'outboxPending', 'asc')).toBeLessThan(0);
  });

  it('null xếp cuối CẢ asc lẫn desc', () => {
    const a = row({ lastActionAt: null, currentAction: null });
    const b = row({ lastActionAt: 42, currentAction: 'chat' });
    expect(compareUsers(a, b, 'lastActionAt', 'asc')).toBeGreaterThan(0);
    expect(compareUsers(a, b, 'lastActionAt', 'desc')).toBeGreaterThan(0);
    expect(compareUsers(a, b, 'currentAction', 'asc')).toBeGreaterThan(0);
    expect(compareUsers(a, b, 'currentAction', 'desc')).toBeGreaterThan(0);
  });

  it('cả 2 null → bằng nhau', () => {
    const a = row({ currentAction: null });
    const b = row({ currentAction: null });
    expect(compareUsers(a, b, 'currentAction', 'asc')).toBe(0);
  });
});

describe('sortUsers — ổn định + tổng hợp', () => {
  it('index desc: số giảm dần', () => {
    const rows = [row({ index: 1 }), row({ index: 0 }), row({ index: 2 })];
    expect(sortUsers(rows, 'index', 'desc').map((r) => r.index)).toEqual([2, 1, 0]);
  });

  it('phase asc: failed < idle < in_room (lexicographic)', () => {
    const rows = [
      row({ phase: 'in_room' }),
      row({ phase: 'failed' }),
      row({ phase: 'idle' }),
    ];
    expect(sortUsers(rows, 'phase', 'asc').map((r) => r.phase)).toEqual(['failed', 'idle', 'in_room']);
  });

  it('lastActionAt desc: null (chưa hành động) ở cuối', () => {
    const rows = [row({ lastActionAt: null }), row({ lastActionAt: 30 }), row({ lastActionAt: 10 })];
    expect(sortUsers(rows, 'lastActionAt', 'desc').map((r) => r.lastActionAt)).toEqual([30, 10, null]);
  });
});

describe('mergePhaseCounts — gộp đếm phase từ nhiều worker', () => {
  it('cộng dồn + bỏ undefined', () => {
    const out = mergePhaseCounts([
      { in_room: 5, idle: 2 },
      undefined,
      { in_room: 3, queued: 1 },
      {},
    ]);
    expect(out).toEqual({ in_room: 8, idle: 2, queued: 1 });
  });

  it('mảng rỗng → {}', () => {
    expect(mergePhaseCounts([])).toEqual({});
  });
});
