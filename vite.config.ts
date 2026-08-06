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
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; object-src 'none'; base-uri 'self'; form-action 'self'";

// Khớp src/lib/env.ts default (`import.meta.env.VITE_GATEWAY_URL ?? "http://localhost:3000"`).
// Build KHÔNG set VITE_GATEWAY_URL → chat vẫn kết nối localhost:3000 → CSP phải cho phép origin này.
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
      // VITE_GATEWAY_URL không set → dùng DEFAULT_GATEWAY_URL (khớp src/lib/env.ts) để build
      // default không mất kết nối chat.
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

export default defineConfig(({ mode }) => {
  // loadEnv: đọc .env + process.env (import.meta.env KHÔNG tồn tại trong config file).
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), injectCspMeta(env)],
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
  };
});