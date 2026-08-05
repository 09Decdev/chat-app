import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * T-11 (G-2) — vitest config RIÊNG cho mutation (stryker): chỉ chạy unit test của 4 module
 * được mutate (coordinator-state, metrics, config, report).
 * KHÔNG kéo theo E2E/contract/api-server test — mỗi mutant chạy lại toàn bộ suite phải nhanh.
 */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('..', import.meta.url)), // chat-app/
    include: [
      'loadtest/__tests__/coordinator-state.test.ts',
      'loadtest/__tests__/metrics.test.ts',
      'loadtest/__tests__/config.test.ts',
      'loadtest/__tests__/report.test.ts',
    ],
    environment: 'node',
  },
});
