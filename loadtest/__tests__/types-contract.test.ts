/**
 * T-11 (G-3) — Type 2-chiều: RUNTIME half — giá trị hằng số 2 module khớp nhau.
 * Compile-time half (gán chéo structural từng type) ở `types-contract.typecheck.ts`:
 * chạy qua `npm run loadtest:typecheck` — tsc fail = contract vỡ = test fail (G-3).
 */
import { describe, it, expect } from 'vitest';
import { ACTION_TYPES } from '../types';
import { ACTION_LABELS, RUNNING_PHASES, TERMINAL_PHASES, ACTIVE_PHASES } from '../../src/types/loadtest';

describe('T-11 — type 2-chiều: src/types/loadtest.ts ↔ loadtest/types.ts', () => {
  it('ACTION_TYPES (backend) ≡ khóa ACTION_LABELS (frontend) — mọi action đều có nhãn UI', () => {
    expect([...ACTION_TYPES].sort()).toEqual([...Object.keys(ACTION_LABELS)].sort());
  });

  it('ACTION_LABELS ánh xạ đúng (label = key) cho mọi action', () => {
    for (const a of ACTION_TYPES) expect(ACTION_LABELS[a]).toBe(a);
  });

  it('RUNNING/TERMINAL/ACTIVE phases (frontend) khớp state machine coordinator-state.ts', () => {
    expect(RUNNING_PHASES).toEqual(['provisioning', 'ramping', 'steady']);
    expect(TERMINAL_PHASES).toEqual(['finished', 'stopped', 'error']);
    expect(ACTIVE_PHASES).toEqual(['provisioning', 'ramping', 'steady', 'cooldown', 'report']);
  });
});
