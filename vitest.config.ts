import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Frontend vitest config (T-08; it will be extended in T-09 with coverage scope).
 * Covers only test files in src/. The loadtest suite keeps its own config
 * (loadtest/vitest.config.ts) and is run via the loadtest:test script.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    globals: false,
    coverage: {
      // Coverage scope (D-20): các file frontend mục tiêu G-1 W3 — KHÔNG đếm loadtest project.
      include: ['src/lib/loadtest-format.ts', 'src/store/loadtest.store.ts', 'src/store/loadtest-prefs.ts'],
      reporter: ['text', 'html', 'json-summary'],
      // G-1 W3: coverage ≥ 70% cho format helpers + store selectors.
      thresholds: { statements: 70, branches: 70, functions: 70, lines: 70 },
    },
  },
});