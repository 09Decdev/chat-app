/**
 * MAYogu LoadTest Tool — shared types (coordinator ↔ worker ↔ HTTP API).
 * Contract bám UI-SPEC `LoadTestTick` (docs/UI-SPEC-loadtest-tool.md §4.1).
 */

/** Action types đo trong kịch bản (ActionType trong UI-SPEC tick). */
export type ActionType = 'chat' | 'read' | 'comment' | 'like' | 'view' | 'typing' | 'topic' | 'vote_kick';

export const ACTION_TYPES: ActionType[] = ['chat', 'read', 'comment', 'like', 'view', 'typing', 'topic', 'vote_kick'];

/** Phase của run (CP-3 — state machine Coordinator). */
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
  chat: number; // % user làm chat cycle (enqueue → matching → send/echo)
  read: number;
  comment: number;
  like: number;
  view: number;
}

/** Cấu hình 1 run — đúng form Control Panel (Màn 1). */
export interface RunConfig {
  runId: string;
  targetUsers: number; // 10k-100k MVP
  rampRate: number; // user/s connect + action start
  rampMode: 'rate' | 'minutes';
  durationMin: number; // ≤ 60 (access token 1h)
  durationSec: number; // = durationMin * 60 (đã resolve)
  profile: ActionProfile; // tổng 100
  gatewayUrl: string; // ws:// hoặc http:// — phải nằm trong allowlist
  workerCount: number;
  socketsPerWorker: number;
  registerRamp: number; // req/s register (≤ 100)
  useExistingAccounts: boolean; // false = register mới; true = login lại từ token pool
  freshAccounts: boolean; // --fresh: bỏ token pool disk, register lại
  seed: number; // hạt ngẫu nhiên ổn định cho id/user
  createdAt: number;
}

/** Cấu hình tiêu chuẩn do UI bấm (trước khi server resolve runId/workerCount...). */
export interface StartRunRequest {
  targetUsers: number;
  rampRate: number;
  rampMode: 'rate' | 'minutes';
  durationMin: number;
  profile: ActionProfile;
  gatewayUrl: string;
  freshAccounts?: boolean;
}

/** 1 account test đã provision (AF-2 token pool). */
export interface TestAccount {
  email: string;
  password: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  displayName: string;
  deviceInfo: {
    installationId: string;
    deviceFingerprint: string;
    platform: 'web';
    deviceName: string;
  };
  dateOfBirth: string; // ISO yyyy-mm-dd — ≥16 tuổi
  country: string;
  registeredAt: number;
}

/** Metrics 1s từ 1 worker → coordinator (IPC 'tick'). */
export interface WorkerTick {
  type: 'tick';
  workerId: number;
  ts: number; // epoch ms của đầu giây
  phase: RunPhase;
  counters: {
    usersTotal: number; // user được giao cho worker
    usersCreated: number;
    usersConnected: number; // socket đang connected
    usersActive: number; // đang trong vòng lặp action/chat cycle
    usersQueued: number; // đang chờ matching
    usersInRoom: number;
    actionsTotal: number;
    successTotal: number;
    failTotal: number;
    echoOk: number; // chat send có echo khớp clientMsgId
    echoSent: number; // chat send đã gửi chờ echo
    droppedOutbox: number; // outbox đầy
    reconnectCount: number;
    rateLimitedNoEcho: number; // send không echo (rate-limit silent drop / Kafka chậm)
    connectAttempts: number; // socket connect attempts (auto-stop E2)
    connectFails: number; // connect_error count
  };
  actionsPerSec: Partial<Record<ActionType, number>>;
  /** Kết quả theo action (cumulative) — AC6.1 per-action success rate. */
  actionOk: Partial<Record<ActionType, number>>;
  actionFail: Partial<Record<ActionType, number>>;
  errors: Record<string, number>; // code → count (đã cộng dồn)
  errorSamples: ErrorSample[]; // tối đa 20 mẫu mới nhất
  histograms: Partial<Record<ActionType, number[]>>; // bucket counts (log-scale, 48 buckets)
  histogramBucketCount: number;
  cpuPct: number;
  rssMb: number;
}

/** Mẫu lỗi 1 action (bảng top errors / user detail). */
export interface ErrorSample {
  ts: number;
  action: ActionType | 'register' | 'login' | 'connect';
  code: string; // HTTP status / error code / socket error
  message: string; // rút gọn
  userId: string;
}

/** Trạng thái 1 user ảo (bảng user virtualized — Màn 3 khung v1.1). */
export interface VirtualUserRow {
  index: number; // thứ tự trong run (0..target-1)
  email: string;
  phase: 'provisioned' | 'connecting' | 'connected' | 'queued' | 'in_room' | 'idle' | 'cooldown' | 'failed';
  roomId: string | null;
  socketConnected: boolean;
  reconnectCount: number;
  outboxPending: number;
  lastError: string | null;
}

/** Tick 1s tổng hợp (coordinator → HTTP polling → dashboard) — UI-SPEC §4.1. */
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
    queueCount: number; // từ Redis match:queue (server-side)
    roomCount: number; // ước lượng từ usersInRoom / 6 (room capacity)
    droppedOutbox: number;
    reconnectCount: number;
    rateLimitedNoEcho: number;
  };
  rates: { successRate: number; echoRate: number };
  actionsPerSec: Partial<Record<ActionType, number>>;
  latency: { p50: number; p95: number; p99: number };
  errors: { code: string; count: number }[];
  server: { wsConnections: number; wsMessagesEmitted: number; wsMessagesPerSec: number };
  workers: { alive: number; total: number; cpuAvg: number };
}

/** Báo cáo 1 action trong report (RE-1). */
export interface ActionReport {
  action: ActionType;
  count: number;
  success: number;
  fail: number;
  successRate: number; // 0-100
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

/** Bottleneck candidate (RE-2 / AC6.2). */
export interface BottleneckCandidate {
  level: 'High' | 'Med' | 'Low';
  title: string;
  detail: string;
  evidence: { ts: number; value: number; threshold?: number }[];
}

/** Report cuối run — khớp Màn 5. */
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
    throughputAvg: number; // action/s trung bình
    throughputPeak: number;
    queueCountPeak: number;
  };
  perAction: ActionReport[];
  errors: { code: string; count: number }[];
  bottlenecks: BottleneckCandidate[];
  stopReason?: string;
}

/** Message IPC coordinator → worker. */
export type WorkerCommand =
  | { type: 'run'; config: RunConfig; accounts: TestAccount[]; workerIndex: number }
  | { type: 'stop'; reason: string; force: boolean }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'query-users'; requestId: number; offset: number; limit: number; filter?: string }
  | { type: 'ping' };

/** Message IPC worker → coordinator. */
export type WorkerMessage =
  | { type: 'ready'; workerId: number; pid: number }
  | { type: 'tick'; tick: WorkerTick }
  | { type: 'users-response'; requestId: number; rows: VirtualUserRow[]; total: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; msg: string }
  | { type: 'done'; reason: string; status: 'finished' | 'stopped' | 'error' }
  | { type: 'fatal'; error: string };
