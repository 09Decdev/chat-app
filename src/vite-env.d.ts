/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GATEWAY_URL?: string;
  readonly VITE_SOCKET_PATH?: string;
  readonly VITE_REFRESH_ENDPOINT?: string;
  /** CSP connect-src bổ sung (space-separated origins) — chỉ dùng cho build output. */
  readonly VITE_CSP_CONNECT_SRC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
