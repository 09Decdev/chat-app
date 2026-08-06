import { defineConfig, type Plugin, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * CSP PROD — chỉ inject vào build output (plugin `injectCspMeta`, apply:'build').
 * Source index.html giữ SẠCH (không meta) → Vite dev (react-refresh inline preamble +
 * HMR ws) không bị chặn. UI-SPEC-prod-refactor §2.2:
 * - KHÔNG scheme-wildcard `ws:`/`wss:` trong connect-src (D-7).
 * - connect-src = explicit origins: 'self' + 2 font origins + gateway origin
 *   (VITE_GATEWAY_URL, build-time — nếu gateway deploy khác origin) + VITE_CSP_CONNECT_SRC.
 * nginx (T-12) KHÔNG set CSP header (tránh double-CSP intersection).
 */
const PROD_CSP_BASE =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://lh3.googleusercontent.com; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; object-src 'none'; base-uri 'self'; form-action 'self'";

// Chỉ dùng cho dev / smoke build — build PRODUCTION bắt buộc VITE_GATEWAY_URL
// (throw ở defineConfig dưới). src/lib/env.ts default `http://localhost:3000`
// vẫn giữ cho `vite` dev server (kết nối gateway local).
const DEFAULT_GATEWAY_URL = 'http://localhost:3000';

function injectCspMeta(env: Record<string, string>): Plugin {
  return {
    name: 'inject-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      const extra = new Set<string>();
      const explicit = (env.VITE_CSP_CONNECT_SRC ?? '').trim();
      if (explicit) for (const o of explicit.split(/\s+/)) if (o) extra.add(o);
      // Gateway origin — gateway-auth-service có thể deploy ở origin riêng (prod topology
      // không chốt); socket.io client kết nối trực tiếp env.gatewayUrl → phải nằm trong connect-src.
      // Build production đã throw nếu thiếu VITE_GATEWAY_URL (defineConfig) — fallback
      // DEFAULT_GATEWAY_URL chỉ chạm tới nếu env truyền explicit rỗng (an toàn tuyệt đối).
      const gw = (env.VITE_GATEWAY_URL ?? '').trim() || DEFAULT_GATEWAY_URL;
      if (gw) {
        try {
          const origin = new URL(gw).origin;
          if (origin && origin !== 'null') extra.add(origin);
        } catch {
          // URL không parse được — bỏ qua (connect-src giữ defaults).
        }
      }
      const connect = ["'self'", 'https://fonts.googleapis.com', 'https://fonts.gstatic.com', ...extra];
      const csp = PROD_CSP_BASE.replace(
        "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
        `connect-src ${connect.join(' ')}`,
      );
      return {
        html,
        tags: [
          {
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: csp },
            injectTo: 'head-prepend',
          },
        ],
      };
    },
  };
}

export default defineConfig(({ mode, command }) => {
  // loadEnv: đọc .env + process.env (import.meta.env KHÔNG tồn tại trong config file).
  const env = loadEnv(mode, process.cwd(), '');
  // Prod build BẮT BUỘC VITE_GATEWAY_URL — build default localhost:3000 sẽ làm
  // container prod kết nối gateway ngay trên browser của user (hỏng âm thầm) +
  // CSP connect-src mở rộng sang localhost. Deploy thật truyền qua docker
  // --build-arg (docker/Dockerfile.frontend). Dev (`vite` dev server, command
  // 'serve') và `vite preview` (command 'preview', không bundle) không qua nhánh này.
  if (command === 'build' && mode === 'production' && !(env.VITE_GATEWAY_URL ?? '').trim()) {
    throw new Error(
      'VITE_GATEWAY_URL bắt buộc khi build production. Ví dụ: ' +
        'docker build -f docker/Dockerfile.frontend --build-arg VITE_GATEWAY_URL=https://gateway.mayogu.test . ' +
        '(xem comment đầu docker/Dockerfile.frontend)',
    );
  }
  return {
    plugins: [react(), injectCspMeta(env)],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    // Tách vendor chunk (FIX: trước đây 1 chunk chứa recharts + framer-motion +
    // socket.io-client + axios + toàn bộ UI loadtest). Các page loadtest đã
    // React.lazy ở src/App.tsx — vendor này chỉ tải khi page tương ứng mở.
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom'],
            recharts: ['recharts'],
            'framer-motion': ['framer-motion'],
            'socket.io-client': ['socket.io-client'],
            axios: ['axios'],
          },
        },
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
  };
});