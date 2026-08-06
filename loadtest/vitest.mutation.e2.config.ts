import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * TẠM — mutation E2 (G2 hard-gate, fix/loadtest-e2-connect-fail): chỉ include unit test
 * của 3 module critical của fix: coordinator-state, sanitize, socket-farm.
 * KHÔNG kéo theo E2/contract/api-server test — mỗi mutant chạy lại phải nhanh.
 *
 * G2 run 2 fix: root = loadtest/ (KHÔNG phải chat-app/) để vitest KHÔNG auto-load
 * vitest.workspace.ts ở repo root (workspace làm pool đổi sang forks + include bị
 * override → stryker dry run tìm 0 test). Import '../socket-farm' vẫn resolve theo
 * vị trí test file, không phụ thuộc root.
 */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)), // loadtest/
    include: [
      '__tests__/coordinator-state.test.ts',
      '__tests__/sanitize.test.ts',
      '__tests__/socket-farm.test.ts',
    ],
    environment: 'node',
  },
});