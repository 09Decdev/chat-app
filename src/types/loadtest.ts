/**
 * LoadTest tool — types khớp contract backend (loadtest/types.ts + docs/API-loadtest-tool.md).
 * KHÔNG tự đặt tên field khác — dùng đúng field/tên backend trả về.
 */

export type ActionType = 'chat' | 'read' | 'comment' | 'like' | 'view' | 'typing' | 'topic' | 'vote_kick';

/** Loại lỗi connect — khớp loadtest/types.ts ConnectFailType (DESIGN §2.1, T1). */
export type ConnectFailType = 'timeout' | 'transport' | 'reject' | 'other';
export type ConnectFailsByType = Record<ConnectFailType, number>;

export type RunPhase =
  | 'idle'
  | 'provisioning'
  | 'ramping'
  | 'steady'
  | 'cooldown'
  | 'report'
  | 'finished'
  | 'stopped'
  | 'error';

/** Profile action (% user theo hành vi) — tổng = 100. */
export interface ActionProfile {
  chat: number;
  read: number;
  comment: number;
  like: number;
  view: number;
}

export const ACTION_LABELS: Record<ActionType, string> = {
  chat: 'chat',
  read: 'read',
  comment: 'comment',
  like: 'like',
  view: 'view',
  typing: 'typing',
  topic: 'topic',
  vote_kick: 'vote_kick',
};

/** Trạng thái action hiện tại của 1 virtual user — khớp loadtest/types.ts (2-chiều contract). */
export type UserActionState = 'chat' | 'read' | 'comment' | 'like' | 'view' | 'typing' | 'topic' | 'idle';

/** Phase lifecycle 1 virtual user — khớp loadtest/types.ts (2-chiều contract). */
export type UserPhase = 'provisioned' | 'connecting' | 'connected' | 'queued' | 'in_room' | 'idle' | 'cooldown' | 'failed';

/** Row bảng virtual users — GET /api/loadtest/users — khớp loadtest/types.ts (2-chiều contract). */
export interface VirtualUserRow {
  index: number;
  email: string;
  phase: UserPhase;
  currentAction: UserActionState | null;
  lastActionAt: number | null;
  lastActionMs: number | null;
  messagesSent: number;
  messagesEchoed: number;
  roomId: string | null;
  socketConnected: boolean;
  reconnectCount: number;
  outboxPending: number;
  lastError: string | null;
}

/** Field sort hợp lệ của /users — whitelist khớp loadtest/users-sort.ts. */
export type UserSortField = 'index' | 'email' | 'phase' | 'currentAction' | 'lastActionAt' | 'reconnectCount' | 'outboxPending';
export type UserSortDir = 'asc' | 'desc';

/** Response GET /api/loadtest/users. */
export interface UsersResponse {
  rows: VirtualUserRow[];
  total: number;
  offset: number;
  limit: number;
  sortBy: UserSortField;
  sortDir: UserSortDir;
  phaseCounts: Partial<Record<UserPhase, number>>;
}

/** Body POST /api/loadtest/start. */
export interface StartRunRequest {
  targetUsers: number;
  rampRate: number;
  rampMode: 'rate' | 'minutes';
  durationMin: number;
  profile: ActionProfile;
  gatewayUrl: string;
  freshAccounts?: boolean;
}

export interface RunConfig {
  runId: string;
  targetUsers: number;
  rampRate: number;
  rampMode: 'rate' | 'minutes';
  durationMin: number;
  durationSec: number;
  profile: ActionProfile;
  gatewayUrl: string;
  workerCount: number;
  socketsPerWorker: number;
  registerRamp: number;
  useExistingAccounts: boolean;
  freshAccounts: boolean;
  seed: number;
  createdAt: number;
}

export interface LoadTestConfig {
  port: number;
  allowlist: string[];
  allowlistFromFile: string[];
  gatewayUrl: string;
  maxTarget: number;
  maxDurationMin: number;
  maxRegisterRamp: number;
  presets: { id: string; label: string; targetUsers: number; requiresCluster: boolean }[];
  hasOtpSecret: boolean;
  hasRedisConfigured: boolean;
  reportsDir: string;
  /** Register gate (T-06, SEC-6) — false → frontend ẩn CTA đăng ký (D-17). */
  allowRegister: boolean;
}

/** Tick 1s tổng hợp — UI-SPEC §4.1. */
export interface LoadTestTick {
  type: 'tick';
  runId: string;
  ts: number;
  phase: RunPhase;
  elapsedSec: number;
  counters: {
    usersCreated: number;
    usersConnected: number;
    usersActive: number;
    usersQueued: number;
    usersInRoom: number;
    actionsTotal: number;
    successTotal: number;
    failTotal: number;
    echoOk: number;
    echoSent: number;
    queueCount: number;
    roomCount: number;
    droppedOutbox: number;
    reconnectCount: number;
    rateLimitedNoEcho: number;
    connectAttempts: number; // cumulative per-worker, sum tick mới nhất (BE-2 — có thể tụt khi worker E3-restart)
    connectFails: number;
    connectFailsByType: ConnectFailsByType;
    usersFailed: number;
  };
  rates: { successRate: number; echoRate: number; connectFailRate: number }; // connectFailRate = window 60s
  /** FALSE trên DB-replay (MVP không persist connect) — UI phân biệt no-data vs 0 (UI-1). */
  hasConnectData?: boolean;
  actionsPerSec: Partial<Record<ActionType, number>>;
  latency: { p50: number; p95: number; p99: number };
  errors: { code: string; count: number }[];
  server: { wsConnections: number; wsMessagesEmitted: number; wsMessagesPerSec: number };
  workers: { alive: number; total: number; cpuAvg: number };
}

export interface RunStatus {
  runId: string;
  phase: RunPhase;
  startAt: number;
  elapsedSec: number;
  isRunning: boolean;
  stopReason: string;
  config?: RunConfig | null;
  lastTick?: LoadTestTick | null;
}

export interface ErrorSample {
  ts: number;
  action: string;
  code: string;
  message: string;
  userId: string;
}

export interface ErrorBucket {
  code: string;
  count: number;
}

export interface ActionReport {
  action: ActionType;
  count: number;
  success: number;
  fail: number;
  successRate: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface BottleneckCandidate {
  level: 'High' | 'Med' | 'Low';
  title: string;
  detail: string;
  evidence: { ts: number; value: number; threshold?: number }[];
}

export interface RunReport {
  runId: string;
  status: 'finished' | 'stopped' | 'error';
  startAt: number;
  endAt: number;
  durationSec: number;
  config: RunConfig;
  summary: {
    usersCreated: number;
    usersConnectedMax: number;
    usersActiveMax: number;
    actionsTotal: number;
    successTotal: number;
    failTotal: number;
    successRate: number;
    echoOk: number;
    echoSent: number;
    echoRate: number;
    throughputAvg: number;
    throughputPeak: number;
    queueCountPeak: number;
  };
  perAction: ActionReport[];
  errors: { code: string; count: number }[];
  bottlenecks: BottleneckCandidate[];
  stopReason?: string;
}

export interface CleanupStep {
  name: string;
  status: 'pending' | 'ok' | 'fail' | 'skipped';
  detail: string;
  count: number;
}

export interface CleanupResult {
  runId: string;
  dryRun: boolean;
  cleaned: boolean;
  steps: CleanupStep[];
  baseline: { otpKeys: number; userKeys: number };
}

/** Trạng thái nguồn dữ liệu live (polling 1s) — tương đương wsStatus UI-SPEC. */
export type PollStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export const RUNNING_PHASES: RunPhase[] = ['provisioning', 'ramping', 'steady'];
export const TERMINAL_PHASES: RunPhase[] = ['finished', 'stopped', 'error'];
export const ACTIVE_PHASES: RunPhase[] = ['provisioning', 'ramping', 'steady', 'cooldown', 'report'];

// ─── Admin Auth + History (PRD-loadtest-admin-auth, PRD-loadtest-run-database) ───

/** Trạng thái run trong DB (lịch sử) — khác RunPhase (phase runtime). */
export type RunStatusValue = 'running' | 'finished' | 'stopped' | 'error';

/** Admin account — auth/register/login/me (PRD Module A). */
export interface LoadtestAdminUser {
  id: number;
  username: string;
  email: string;
  displayName: string;
  role: string;
}

export interface LoadtestAuthResponse {
  token: string;
  expiresAt: number;
  user: LoadtestAdminUser;
}

/** Row lịch sử run — GET /runs (PRD D1). */
export interface LoadtestRunSummary {
  runId: string;
  status: RunStatusValue;
  machineId: string;
  startAt: number;
  endAt: number | null;
  durationSec: number | null;
  gatewayUrl: string;
  targetUsers: number;
  workerCount: number;
  stopReason: string | null;
  poolSourceRunId: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Detail run — GET /runs/{id}: config + report tái dựng từ summary_json. */
export interface LoadtestRunDetail extends LoadtestRunSummary {
  config: RunConfig | null;
  report: RunReport | null;
}

/** LogEvent — GET /runs/{id}/logs. */
export interface LoadtestLogEvent {
  id: number;
  runId: string;
  ts: number;
  level: string;
  msg: string;
}
