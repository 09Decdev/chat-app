import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('..', import.meta.url)), // chat-app/
    include: ['loadtest/__tests__/**/*.test.ts'],
    environment: 'node',
  },
});
