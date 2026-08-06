/**
 * TẠM — mutation E2 (G2 hard-gate, fix/loadtest-e2-connect-fail): scope 3 module critical
 * của fix E2: coordinator-state (window 60s + auto-stop), sanitize (F-3/F-4/F-5), socket-farm
 * (connect/cap-5/classify/kênh B io-server-disconnect).
 * Chạy: `npx stryker run stryker.config.e2.mjs`
 * break=0 — G2 verdict tính THỦ CÔNG từ JSON report (>=60% + 0 live mutant critical).
 */
export default {
  mutate: [
    'loadtest/coordinator-state.ts',
    'loadtest/sanitize.ts',
    'loadtest/socket-farm.ts',
  ],
  testRunner: 'vitest',
  vitest: {
    configFile: 'loadtest/vitest.mutation.e2.config.ts',
  },
  concurrency: 2,
  maxConcurrentTestRunners: 2,
  timeoutMS: 60_000,
  timeoutFactor: 2,
  reporters: ['clear-text', 'progress', 'json'],
  jsonReporter: { fileName: 'reports/mutation/e2-mutation-report.json' },
  coverageAnalysis: 'perTest',
  thresholds: { break: 0 },
};
