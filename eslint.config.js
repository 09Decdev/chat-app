// eslint flat config — T-10 (DevSecOps).
//
// Scope:
//   - src/**      frontend (React + TS): strict — no-console/no-debugger are ERRORS.
//                 (2 files keep pre-existing debug logging, see the override below —
//                 removal is T-08 scope, NOT this task.)
//   - loadtest/** CLI/Node runtime: the tool's logger intentionally sinks to
//                 console (loadtest/logger.ts) and the db/* CLI scripts print
//                 human output — no-console is OFF there.
//   - root config files (vite/vitest/tailwind/postcss/eslint): node env.
//
// Zero-dep on runtime: everything here is devDependencies.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

const noUnusedVars = [
  'error',
  { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
];

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'loadtest/reports/**', '*.tsbuildinfo'],
  },
  // ── Frontend ────────────────────────────────────────────────────────────────
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: globals.browser },
    plugins: { react, 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      'no-console': 'error',
      'no-debugger': 'error',
      '@typescript-eslint/no-unused-vars': noUnusedVars,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'react-refresh/only-export-components': ['error', { allowConstantExport: true }],
      // XSS sink control (T-12): MatchingScreen được refactor khỏi
      // dangerouslySetInnerHTML — rule này giữ chặn mọi sink mới.
      'react/no-danger': 'error',
    },
  },
  // Pre-existing debug logging / deliberate console sinks (T-08 kept these by
  // design — removal is a separate task; lint must stay green with 0 errors).
  {
    files: ['src/store/chat.store.ts', 'src/lib/socket.ts'],
    rules: { 'no-console': 'off' },
  },
  // ErrorBoundary console.error là PII-sanitized (T-08: prod chỉ log { name }, chi
  // tiết DEV-gated) — đây là control bảo mật, giữ nguyên.
  {
    files: ['src/components/ErrorBoundary.tsx'],
    rules: { 'no-console': 'off' },
  },
  // shadcn/ui primitives: export `cva` variants (`buttonVariants`...) bên cạnh
  // component là pattern chuẩn của thư viện — fast-refresh không áp dụng cho tĩnh UI.
  {
    files: ['src/components/ui/**/*.{ts,tsx}'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  // charts.tsx export helpers thuần (downsample/sliceRange) dùng chung — không phải
  // component; cho phép đúng tên để giữ fast-refresh cho các component khác trong file.
  {
    files: ['src/components/loadtest/charts.tsx'],
    rules: {
      'react-refresh/only-export-components': ['error', { allowConstantExport: true, allowExportNames: ['downsample', 'sliceRange', 'ACTION_SERIES', 'RANGE_OPTIONS'] }],
    },
  },
  // Countdown cooldown dùng dep-boolean `[stopCooldown > 0]` có chủ đích (interval
  // chạy liên tục khi đang cooldown) — refactor dep-array là việc chạm hành vi, ngoài T-10.
  {
    files: ['src/components/loadtest/app-shell.tsx', 'src/pages/loadtest/ControlPanelPage.tsx'],
    rules: { 'react-hooks/exhaustive-deps': 'off' },
  },
  // ── loadtest runtime (CLI tool — console is its interface) ─────────────────
  {
    files: ['loadtest/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: {
      'no-console': 'off',
      'no-debugger': 'error',
      '@typescript-eslint/no-unused-vars': noUnusedVars,
    },
  },
  // ── Root config files ───────────────────────────────────────────────────────
  {
    files: [
      'vite.config.ts',
      'vitest.config.ts',
      'vitest.workspace.ts',
      'tailwind.config.ts',
      'postcss.config.js',
      'eslint.config.js',
    ],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: {
      'no-console': 'off',
      'no-debugger': 'error',
      '@typescript-eslint/no-unused-vars': noUnusedVars,
    },
  },
);
