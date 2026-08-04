import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      // LoadTest tool backend (npm run loadtest:server — port 3401 mặc định)
      '/api/loadtest': {
        target: 'http://127.0.0.1:3401',
        changeOrigin: true,
      },
    },
  },
});
