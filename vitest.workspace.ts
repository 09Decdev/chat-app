import { defineWorkspace } from 'vitest/config';

/**
 * Vitest workspace (T-09 / UI-SPEC-prod-refactor §8.1) — chạy 2 project trong 1 lệnh:
 * 1. loadtest/vitest.config.ts — suite loadtest (node env, loadtest/__tests__).
 * 2. vitest.config.ts (root) — frontend tests (jsdom env, src).
 * Include 2 project không chồng nhau → không double-run.
 */
export default defineWorkspace([
  './loadtest/vitest.config.ts',
  './vitest.config.ts',
]);