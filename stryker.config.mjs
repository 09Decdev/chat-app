/**
 * T-11 (G-2) — Stryker mutation testing cho 4 module PURE của loadtest tool:
 *   loadtest/coordinator-state.ts, metrics.ts, config.ts, report.ts
 * Chạy: `npm run loadtest:mutation` (ngưỡng: break khi mutation score < 70% — G-2).
 * Runner: @stryker-mutator/vitest-runner (cùng vitest với unit test).
 * maxConcurrentTestRunners thấp — mutation chạy chậm, tránh quá tải CI.
 */
export default {
  mutate: [
    'loadtest/coordinator-state.ts',
    'loadtest/metrics.ts',
    'loadtest/config.ts',
    'loadtest/report.ts',
  ],
  testRunner: 'vitest',
  vitest: {
    configFile: 'loadtest/vitest.mutation.config.ts',
  },
  concurrency: 2,
  maxConcurrentTestRunners: 2,
  timeoutMS: 60_000,
  timeoutFactor: 2,
  reporters: ['clear-text', 'progress', 'html'],
  htmlReporter: { baseDir: 'reports/mutation/html' },
  coverageAnalysis: 'perTest',
  thresholds: { break: 70 },
};
