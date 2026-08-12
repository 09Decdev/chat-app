/**
 * Cau hinh runtime doc tu env (xem .env.example).
 * Tat ca gia tri mac dinh neu env khong khai bao.
 */

const gatewayUrl = (
  import.meta.env.VITE_GATEWAY_URL ?? "http://localhost:3000"
).replace(/\/+$/, "");

export const env = {
  gatewayUrl,
  socketPath: import.meta.env.VITE_SOCKET_PATH ?? "/socket.io/",
  refreshEndpoint: import.meta.env.VITE_REFRESH_ENDPOINT ?? "/auth/refresh-token",

  // Business rules (CHAT_API.md - muc 7 & 9)
  maxMembers: 6,
  roomDurationHours: 3,
  cooldownSeconds: 900, // CHAT_LEAVE_COOLDOWN_SECONDS mac dinh 900s
  messageMaxChars: 4000,
  messageMinIntervalMs: 2000, // 1 message / 2s / user
  historyPageSize: 50,
  typingDebounceMs: 1500, // emit chat:typing tối đa mỗi 1.5s (client-side throttle)
  typingHideMs: 3000, // auto-hide indicator sau 3s không nhận thêm typing

  // Chat topic (CHAT_API.md §10) — bounds theo code point sau NFC+trim+collapse
  topicMinCp: 3, // CHAT_TOPIC_TITLE_MIN
  topicMaxCp: 80, // CHAT_TOPIC_TITLE_MAX
  topicRateLimitSeconds: 15, // CHAT_TOPIC_RATE_LIMIT_SECONDS
} as const;

export const routes = {
  login: '/login',
  home: '/',
  chat: '/chat',
  // LoadTest tool (docs/UI-SPEC-loadtest-tool.md §2)
  loadtest: '/loadtest',
  loadtestLive: '/loadtest/live',
  loadtestUsers: '/loadtest/users',
  loadtestScenario: '/loadtest/scenario',
  loadtestReport: '/loadtest/report',
  loadtestSettings: '/loadtest/settings',
  loadtestCleanup: '/loadtest/cleanup',
  // LoadTest admin auth + history (PRD-loadtest-admin-auth)
  loadtestLogin: '/loadtest/login',
  loadtestRegister: '/loadtest/register',
  loadtestHistory: '/loadtest/history',
  feed: '/feed',
} as const;
