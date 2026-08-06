# FEATURE INVENTORY — MAYogu LoadTest Tool

> Trạng thái: snapshot code ngày 2026-08-05 (branch `refactor/prod-readiness`, sau W3).
> Mục đích: liệt kê CHÍNH XÁC tool đang có gì (kèm file:dòng) để quyết định thêm tính năng gì tiếp theo.
> Mọi claim đối chiếu code thật — KHÔNG có feature "theo PRD" nếu code chưa có.

---

## 1. Tổng quan kiến trúc

```
┌─────────────────────────── React Dashboard (Vite, port 5173) ───────────────────────────┐
│ pages/loadtest/* + components/loadtest/* + store/loadtest.store.ts (poll 1s)            │
└───────────────────────────────────┬──────────────────────────────────────────────────────┘
                                    │ HTTP /api/loadtest (Vite proxy, Bearer token)
┌───────────────────────────────────▼──────────────────────────────────────────────────────┐
│ API server (node:http, zero-dep, port 3401)  api-server.ts + routes/*                    │
│   guards: gate(register) → auth(HMAC Bearer) → rate-limit(429) → handler                 │
│   CORS allowlist, envelope { success, statusCode, data|message, requestId, timestamp }   │
├───────────────────────────────────┬──────────────────────────────────────────────────────┤
│ Coordinator  coordinator.ts       │ DbWriter  db/writer.ts ──────► Postgres (7 bảng)     │
│  state machine 9 phase            │  batch flush 30s/500 tick,                            │
│  aggregate tick 1s + scrape 5s    │  log_events subscribe, pool write/import,            │
│  auto-stop E1/E2/E3, kill-switch  │  crash-detect, finalize barrier                      │
├───────────────────────────────────┼──────────────────────────────────────────────────────┤
│ Worker Farm  worker-farm.ts       │ Redis (ioredis) — seed OTP `otp:register:*`,          │
│  fork child processes (tsx)       │  `register:sms:*` (TTL 300s) + đọc queue-count        │
│  heartbeat 5s, restart backoff 2s │  (queue-count thực tế qua REST gateway)               │
├───────────────────────────────────▼──────────────────────────────────────────────────────┤
│ WorkerRuntime  socket-farm.ts (per-process)  ──►  gateway-auth-service (port 3000)       │
│  VirtualUser × N (socket.io-client websocket-only)  +  RestDriver  rest-actions.ts        │
│  actions: chat/read/comment/like/view/typing/topic  (REST /content-service/*)             │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

- Backend: `loadtest/*.ts` (Node 22, TS qua tsx, **zero runtime dependency ngoài** `ioredis` + `pg` + `socket.io-client`).
- DB: Postgres 16 (`docker/compose.db.yml`, port 5439), schema `loadtest/db/schema.sql` + migration runner.
- Deploy: `docker/Dockerfile.loadtest` (node:22-alpine, HEALTHCHECK wget /health), `Dockerfile.frontend` + `nginx.conf`.
- Dashboard chạy cùng app chat (route `/loadtest/*`), auth riêng (admin_users table).

---

## 2. Feature inventory chi tiết

### 2.1 Config & env — `loadtest/config.ts`

| Env key | Mặc định | Ý nghĩa |
|---|---|---|
| `LOADTEST_PORT` | 3401 | Cổng HTTP API điều khiển (config.ts:168) |
| `LOADTEST_HOST` | `127.0.0.1` | Bind address — mặc định loopback, Docker phải `0.0.0.0` (config.ts:169) |
| `LOADTEST_ALLOWLIST` | `http://localhost:3000` | Danh sách gateway URL được phép chạy, chặn cứng mọi URL khác (config.ts:151-154) |
| `LOADTEST_GATEWAY_URL` | `http://localhost:3000` | Gateway mặc định (normalize ws→http) (config.ts:171) |
| `LOADTEST_OTP_SECRET` | '' | Secret seed OTP register (HMAC-SHA256) — bắt buộc ≥ 32 ký tự (config.ts:240-245) |
| `LOADTEST_AUTH_SECRET` | '' | Secret ký session token admin (config.ts:247-253) |
| `LOADTEST_REDIS_URL` | `redis://localhost:6379` | Redis seed OTP (config.ts:174) |
| `LOADTEST_MAX_TARGET` | 200_000 | Target tối đa/run — chặn preset 1M/10M (config.ts:175, 296-301) |
| `LOADTEST_MAX_DURATION_MIN` | 60 | Duration tối đa (access token TTL 1h) (config.ts:176, 303-309) |
| `LOADTEST_MAX_REGISTER_RAMP` | 100 | Ramp register tối đa (guest bucket 1000/8s) (config.ts:177) |
| `LOADTEST_WORKERS` | 0 = auto | Số worker process; auto = `min(cpu-1, ceil(target/10k), 32)` (config.ts:161, 368-373) |
| `LOADTEST_MAX_SOCKETS_PER_WORKER` | 10_000 | Socket tối đa/worker (config.ts:179) |
| `LOADTEST_MAX_PENDING_OUTBOX` | 1000 | Outbox pending/user (backpressure chat) (config.ts:180) |
| `LOADTEST_DATA_DIR` | `./loadtest/data` | Token pool file + auth-secret + settings.json (config.ts:181) |
| `LOADTEST_REPORTS_DIR` | `./docs/loadtest-reports` | Thư mục lưu report JSON/MD/CSV (config.ts:182) |
| `LOADTEST_DATABASE_URL` | placeholder | Postgres connection string — fail-fast nếu placeholder (config.ts:183, 226-237) |
| `LOADTEST_SCRAPE_METRICS_INTERVAL_MS` | 5000 | Chu kỳ scrape gateway /metrics (config.ts:184) |
| `LOADTEST_REGISTER_RAMP` | 100 | Ramp register/login reuse (req/s) (config.ts:185) |
| `LOADTEST_FIXTURE_POST_IDS` | '' | Fixture post ids; rỗng → driver tự lấy từ feed (config.ts:186-189) |
| `LOADTEST_PROVISION_CONCURRENCY` | 25 | Register/login song song khi provisioning (auth-factory.ts:25) |
| `LOADTEST_DEBUG` | 0 | In nguồn từng env key khi start (C-4) (config.ts:162, 107-125) |
| `LOADTEST_DB_REQUIRED` | true | DB bắt buộc — connect fail → server exit (config.ts:163, store.ts:171-178) |
| `LOADTEST_CORS_ORIGIN` | `http://localhost:5173` | CORS allowlist — cấm `*` (config.ts:156-159, 262-268) |
| `LOADTEST_ALLOW_REGISTER` | false | Register gate admin (SEC-6) (config.ts:193) |
| `LOADTEST_RATE_LIMIT_DISABLED` | 0 | Escape hatch tắt toàn bộ rate-limit (CI/test) (config.ts:194) |
| `LOADTEST_RATE_LIMIT_LOGIN_FAILS` | 5 | Số fail login/register trong window → 429 (config.ts:195) |
| `LOADTEST_RATE_LIMIT_WINDOW_MS` | 60_000 | Window fail (config.ts:196) |
| `LOADTEST_RATE_LIMIT_START_MS` | 10_000 | Refill /start bucket (1 req/10s) (config.ts:197) |
| `LOADTEST_RATE_LIMIT_WRITE_BUCKET` | 0 (OFF) | Bucket req/min cho write routes (config.ts:198) |
| `LOADTEST_TRUST_PROXY` | 0 | Tin X-Forwarded-For (chống spoof — chỉ sau reverse-proxy) (config.ts:199) |
| `LOADTEST_SHUTDOWN_TIMEOUT_MS` | 10_000 | Tổng timeout graceful shutdown (config.ts:200) |
| `LOGTEST_LOG_FILE` | '' (tắt) | File JSONL log + rotation 10MB × 5 (logger.ts:211-227) |
| `LOADTEST_LOG_JSON` | 0 | Console JSON 1 dòng (logger.ts:274-279) |

**Fail-fast validateEnv** (config.ts:220-271): chặn placeholder/default DB URL cũ (isKnownBadDbUrl, config.ts:30-32), `LOADTEST_DATABASE_URL` thiếu/không phải postgres://, OTP/AUTH secret < 32 ký tự (production bắt buộc), `CORS_ORIGIN='*'` hoặc origin rỗng. Severity error → server.ts:19-25 log + `process.exit(1)` TRƯỚC khi mở service.

**Validate run** (config.ts:282-339): gateway ∈ merged allowlist, targetUsers ≥ 1000 và ≤ maxTarget, durationMin ≤ maxDurationMin, profile tổng = 100%, cảnh báo rampRate > 2000/s và seat time > duration. **Presets** 10k/50k/100k/1M/10M (1M/10M `requiresCluster`) (config.ts:349-355). **estimateInfra** ước lượng workers/RAM/seat cho UI (config.ts:360-365). **newRunId** `lt{ts36}{pid36}{seq}` chống trùng sau restart (config.ts:376-383). **Settings file** `dataDir/settings.json` — allowlist bổ sung qua API Settings, `mergedAllowlist` = env + file (config.ts:415-436).

### 2.2 Auth & admin

| Feature | Nguồn | Mô tả |
|---|---|---|
| Session token HMAC-SHA256 | auth.ts:33-67 | `base64url(payload).base64url(hmac)`; verify bằng HMAC lại (timingSafeEqual), không decode; payload `{sub, username, exp}` |
| Session TTL 12h | auth.ts:15 | `SESSION_TTL_MS = 12h` — không refresh (MVP) |
| Secret persist qua restart | auth.ts:73-88 | env `LOADTEST_AUTH_SECRET` → `dataDir/auth-secret.json` tự sinh → fallback random (sessions mất khi restart) |
| Register admin | routes/auth.ts:13-34 | validate email + password strength (≥8 ký tự, 3/4 nhóm — db/password.ts:46-59), hash scrypt `scrypt$16384$8$1$salt$hash`, 409 nếu trùng username/email (23505), 503 nếu DB lỗi |
| Login admin | routes/auth.ts:36-57 | login bằng username HOẶC email; 401 chung "Sai username/email hoặc mật khẩu" (không lộ account tồn tại); `isActive=false` → 401; touchLastLogin |
| Logout / Me | routes/auth.ts:59-73 | logout stateless (client xoá token); /me trả admin info |
| Guard dispatcher | api-server.ts:216-247 | Thứ tự cố định: gate (403 REGISTER_DISABLED trước body validation) → auth (401) → rate-limit (429 + Retry-After) → handler |
| Rate-limit | rate-limit.ts | Login/register: FailWindow 5 fail/60s/IP (4xx = 1 fail, 2xx clear — api-server.ts:184-188); /start: TokenBucket 1/10s/IP; write routes: bucket OFF mặc định; sweep lazy >2048 entry/10 phút (FIX-8 xoá đúng prefix key) |
| Frontend auth | src/store/loadtest-auth.store.ts, src/lib/loadtest-api.ts:75-96, src/components/loadtest/require-auth.tsx | interceptor gắn Bearer, 401 → clearSession + redirect login; hydrate localStorage + verify /auth/me khi mount; LoginPage/RegisterPage ẩn CTA register khi `config.allowRegister=false`; SessionExpiryBanner cảnh báo ≤30 phút trước hết hạn (không refresh) |

### 2.3 Account provisioning (register + reuse pool)

**Register OTP-Seed** (auth-factory.ts:160-326): flow 3 bước khớp gateway:
1. `seedOtp` ghi Redis `otp:register:{email}` = HMAC-SHA256(OTP_SECRET) TTL 300s (auth-factory.ts:70-75) → POST `/auth/register/verify-email` → `registrationKey`
2. `seedSmsOtp` ghi `register:sms:{email}` TTL 300s (auth-factory.ts:78-88) → POST `/auth/register/verify-sms-otp` → `phoneKey`
3. POST `/auth/register/complete` → accessToken + refreshToken, userId từ `decodeSub` (auth-factory.ts:400-408)

- Email `loadtest.{runId}.{i}@mayogu.test`, password/genDeviceInfo/dateOfBirth/phone hợp lệ DTO gateway (util.ts:49-87).
- **SimpleRateLimiter** pacing registerRamp req/s (auth-factory.ts:133-150); **PROVISION_CONCURRENCY=25** song song.
- **Reuse pool — thứ tự 3 bước** (auth-factory.ts:172-203): (1) **DB pool** (`findPoolForRun` — writer.ts:232-253, SQL `findPool` ưu tiên account_count ≥ target rồi mới nhất — store.ts:503-513, tải ≤200k account, markPoolReused) → login lại; (2) **disk pool** (`accounts-{runId}.json` — `listPools` tìm khớp targetUsers+gateway, AF-4 backward compat); (3) **register mới**. Mỗi bước login fail toàn bộ → fallback bước sau.
- `loginAccounts` (auth-factory.ts:333-384): login lại với deviceInfo cũ; phát hiện `require2fa` → TWO_FA_REQUIRED; login fail KHÔNG tính vào E1 (chỉ registerFailed).
- `persistPool` ghi disk pool mới mỗi run (auth-factory.ts:386-397).
- E1: register fail > 50% (≥10 mẫu) → auto-stop (coordinator.ts:250-256).
- **Seed script** `npm run loadtest:seed-accounts -- <file> [--pool-id] [--gateway-url]` (seed-accounts.ts:135-253): đọc JSON array hoặc CSV (`email,password[,displayName]`), upsert pool `seed-*` idempotent `ON CONFLICT (pool_id, email) DO UPDATE`, INSERT chunk 500 (giới hạn 65.535 params), KHÔNG in password, deviceInfo hợp lệ DTO.
- Legacy pool JSON import 1 lần khi startup (writer.ts:334-407).

### 2.4 Run lifecycle

| Feature | Nguồn | Mô tả |
|---|---|---|
| State machine 9 phase | coordinator-state.ts:19-40 | `idle → provisioning → ramping → steady → cooldown → report → finished`; nhánh `error`/`stopped`; transition bất hợp lệ → throw |
| Start | coordinator.ts:169-193 | 409 nếu isRunning (provisioning..report); validate lại merged allowlist tại coordinator (double-check SD-1); `writeRunStart` AWAIT trước log (FK race fix); timers 1s×4 |
| Stop (graceful) | coordinator.ts:326-355 | broadcast stop → chờ worker done (tối đa 10s) → finishRun; provisioning → dừng ngay |
| Kill-switch | coordinator.ts:338-341, worker-farm.ts:149-158 | SIGKILL mọi worker + finishRun(force) |
| Pause/Resume | coordinator.ts:357-362 | broadcast pause/resume — chỉ dừng action, tick metrics vẫn chạy |
| Graceful shutdown | server.ts:58-80 | Đóng HTTP (closeAllConnections) → `coordinator.stop(true)` → `dbWriter.shutdown()` (finalize barrier + flush + pool.end), timeout `LOADTEST_SHUTDOWN_TIMEOUT_MS` |
| Worker restart | coordinator.ts:96-112 | Worker chết khi đang chạy → restart sau 2s backoff, prune tick/histogram cũ (C-1/C-2), đếm workerDeathTimes 60s |
| Finish run | coordinator.ts:587-657 | `finishRun` guard double-finalize + in-flight promise (B-2); `endPhaseFromStop`: natural→finished, auto→error, manual→stopped; buildReport → saveReportFiles → AWAIT writeRunFinish (không drop finalize) |
| Run idempotent start | coordinator.ts:176 | sau finished/stopped/error → về idle, cho start lại; 409 khi đang chạy |
| Crash-detect | store.ts:344-352, writer.ts:56-61 | Startup: run `running` còn sót của máy này → `error` (kèm reason crash-detect) |

### 2.5 Load generation

**Socket farm** (socket-farm.ts):
- **Virtual user lifecycle**: connect socket.io-client **websocket-only**, token qua `auth:{token}` + `Authorization` header (KHÔNG query string — SEC-3), reconnect 1s→10s ∞ lần, re-join room sau reconnect (socket-farm.ts:90-170).
- **Chat cycle**: enqueue → `matching:found` (timeout 60s → backoff 30s) → `chat:join` → `chat:send` kèm `clientMsgId` → **SUCCESS = echo `chat:message` cùng clientMsgId** (TTL 60s — AC3.3) → roomExpired/room_closed → cooldown 900s (CHAT_LEAVE_COOLDOWN) (socket-farm.ts:27-33, 234-259, 302-329).
- **Actions**: typing (1.5s debounce), topic (15s min, 20% random), REST pacing read 3s / comment 10s (60% tạo mới, 40% đọc list) / like 15s / view 5s (socket-farm.ts:224-232, 261-299); chat profile ngoài phòng chỉ đọc nhẹ.
- **Scheduler 100ms chung** cho toàn worker (không setInterval/user) (socket-farm.ts:467-507); paced connect theo rampRate/worker (F3); outbox giới hạn `maxPendingOutbox` (backpressure); prune outbox 1s → `NO_ECHO_TIMEOUT` = rate-limited/Kafka chậm tách riêng (`rateLimitedNoEcho`) (socket-farm.ts:251-259, 559-565).
- **Metrics per-second**: secCounters rolling 3s → actionsPerSec; connectAttempts/Fails cho E2; CPU% từ `process.cpuUsage`; histogram per action (socket-farm.ts:607-670).

**REST driver** (rest-actions.ts): feed phân trang `/content-service/post/getAll` (cache 30s, lấy ≤20 id), post detail, view, comment create/list, like toggle **≥30s/cặp user+post** (`LIKE_PACED_SKIP`), chat enqueue/cancel/my-room/queue-count, topic PUT. **Retry idempotent**: 5xx/NETWORK 1 lần, KHÔNG retry 4xx (rest-actions.ts:83-99). Nội dung prefix `[lt]` sạch profanity (util.ts:90-121). **NO_POST_FIXTURE**: feed trống → bỏ qua action, đếm + báo rõ (rest-actions.ts:74-81).

**Worker farm** (worker-farm.ts): fork child process (execArgv tsx), spawn đè handle cũ kill ngay (chống orphan), heartbeat `lastTickAt` theo tick → `checkHeartbeats` 5s → kill SIGKILL → restart (worker-farm.ts:161-172); query-users IPC với timeout 3s; worker.ts xử lý run/stop/pause/resume/query-users/ping + uncaughtException → fatal.

### 2.6 Metrics & auto-stop

| Feature | Nguồn | Mô tả |
|---|---|---|
| Histogram log-scale 48 bucket | metrics.ts:9-108 | 1ms→60s, O(1) insert, memory cố định, merge worker→coordinator; quantile P50/P95/P99 từ log-mid |
| Aggregation 1s | coordinator-state.ts:88-194 | Gộp N worker tick → LoadTestTick (counters, rates, top-10 errors, latency tổng, roomCount ≈ inRoom/6) |
| Ring buffer 3600 tick | coordinator.ts:25, 538-543 | 1h @1s cho dashboard + report |
| Auto-stop E1 | coordinator.ts:250-256 | Register fail > 50% (≥10) khi provisioning |
| Auto-stop E2 | coordinator.ts:507-523, coordinator-state.ts:56-64 | Connect fail > 30% (≥10 attempts) khi ramping/steady |
| Auto-stop E3 | coordinator.ts:494-505, 524-534 | Heartbeat timeout 5s → kill; >50% worker chết 60s; TOÀN BỘ worker chết (trừ pendingRestarts) → auto-stop ngay |
| Allowlist hard-block | config.ts:288-292, coordinator.ts:173-175 | Gateway ngoài merged allowlist → 400/409 — chặn tại validate + coordinator |
| Gateway scrape 5s | coordinator.ts:557-579 | Parse `ws_connections` + `ws_messages_emitted_total` từ gateway /metrics → `server.wsConnections/wsMessagesEmitted/wsMessagesPerSec` |
| Queue-count poll 1s | coordinator.ts:545-554, rest-actions.ts:193-197 | GET `/content-service/chat/match/queue-count` (không cần token) → tick.queueCount |
| Dashboard realtime | LiveDashboardPage.tsx | KPI 8 tile + sparkline, gauge success/echo, bottleneck heuristic queue tăng >1.5×/5 phút (LiveDashboardPage.tsx:43-52), top errors + virtualized dialog, server-side scrape card |

### 2.7 DB layer

**7 bảng** (schema.sql): `admin_users`, `runs`, `pools`, `pool_accounts`, `metric_samples`, `log_events`, `schema_version` — JSON payload lưu TEXT; FK cascade runs→metrics/logs, pools→pool_accounts.

| Feature | Nguồn | Mô tả |
|---|---|---|
| Migration runner | migrate.ts | File `NNN_name.sql` với marker `-- ==== UP ====`/`DOWN`; version trong schema_version; mỗi migration trong transaction + advisory lock; CLI `up|down|status [--steps N]`; startup scope `baseline` (chỉ 001, pending > 1 → fail-fast throw) |
| QueryResult ok/error | db/result.ts | `{ok:true, rows} | {ok:false, error:{code,message,context}}` — phân biệt "no rows" vs "DB fail" (không trả 0 giả) |
| Retry transient | store.ts:224-255 | Retry 1 lần chỉ cho ECONNRESET/08001/08006/57P01/57P02/40001; KHÔNG retry 23505/23503/22P02; đếm `dbRetry`/`dbWriteFail` |
| Redaction B-1 | db/int.ts:54-125 | `redactSql` (literal chuỗi trong SQL nhạy cảm), `redactParams` (position-aware + looksLikeSecret); QueryError không bao giờ chứa sql/params |
| Batch flush 30s/500 | writer.ts:20-21, 134-178 | MetricSample batch insert; fail → đưa batch về đầu hàng đợi, vượt 1000 → drop cũ nhất; final flush AWAIT (FIX-8) |
| Log events | writer.ts:194-220 | subscribe logger → insert log_events theo runId; reentrancy guard + suppress window 5s khi DB down (chống loop) |
| Crash-detect | store.ts:344-352 | startup: run `running` của máy này → `error` |
| Pool write | writer.ts:261-330 | upsert pools + pool_accounts per-account outcome (registered/logged_in/failed + errorCode); cập nhật pool nguồn khi reuse |
| Legacy pool import | writer.ts:334-407 | import `dataDir/accounts-*.json` idempotent (imported_from_file, mtimeMs→BIGINT trunc) |
| Retention script | db/cleanup.ts:43-82 | CLI `--older-than 30d|12h|60m`; xoá runs (cascade) + pools (cascade), 1 transaction, KHÔNG đụng run đang chạy/admin_users |
| BIGINT boundary | db/int.ts:14-27 | int8 (OID 20) parse an toàn < 2^53 |

### 2.8 API server — route table (28 routes, api-server.ts:68-105)

| Method | Path | Auth | Rate | Mô tả |
|---|---|---|---|---|
| GET | `/api/loadtest/health` | — | — | Health status ok/degraded/down + db/redis/workers/version/uptime (health.ts; probe cache 10s) |
| GET | `/metrics` | — | — | Tool metrics Prometheus (`lt_*_total` counters + gauges, tool-metrics.ts:50-66) |
| POST | `/api/loadtest/auth/login` | — | login | Đăng nhập admin → token + expiresAt |
| POST | `/api/loadtest/auth/register` | — | register | Đăng ký admin (gate 403 khi ALLOW_REGISTER=false) |
| POST | `/api/loadtest/auth/logout` | ✓ | — | Stateless logout |
| GET | `/api/loadtest/auth/me` | ✓ | — | Thông tin admin hiện tại |
| POST | `/api/loadtest/start` | ✓ | start | Start run — 400 validation / 409 đang chạy / 429 1 req/10s |
| POST | `/api/loadtest/stop` | ✓ | — | Stop graceful (`force` optional) |
| POST | `/api/loadtest/kill` | ✓ | — | Kill-switch (force) |
| POST | `/api/loadtest/pause` | ✓ | — | Pause |
| POST | `/api/loadtest/resume` | ✓ | — | Resume |
| GET | `/api/loadtest/status` | ✓ | — | Snapshot run (runId, phase, startAt, elapsedSec, isRunning, stopReason) |
| GET | `/api/loadtest/metrics` | ✓ | — | Tick history `?since&limit` (cap 7200) |
| GET | `/api/loadtest/users` | ✓ | — | Virtual user table `?offset&limit&filter` (virtualized qua workers) |
| GET | `/api/loadtest/errors` | ✓ | — | Top errors + 50 error samples |
| GET | `/api/loadtest/logs` | ✓ | — | Ring buffer 500 (limit ≤ 500) |
| GET | `/api/loadtest/report` | ✓ | — | Report run hiện tại (404 nếu chưa có) |
| GET | `/api/loadtest/report/export` | ✓ | — | Export `?format=json|md|csv` + Content-Disposition |
| GET | `/api/loadtest/config` | ✓ | — | Config cho UI (allowlist, presets, hasOtpSecret, allowRegister...) |
| GET | `/api/loadtest/allowlist` | ✓ | — | Allowlist merged (env + file) |
| POST | `/api/loadtest/allowlist` | ✓ | write | Ghi settings.json allowlist (rate write OFF mặc định) |
| GET | `/api/loadtest/pools` | ✓ | — | Pool list (DB trước, fallback disk file) |
| POST | `/api/loadtest/cleanup` | ✓ | write | Cleanup 3 tầng (dryRun mặc định true) |
| GET | `/api/loadtest/runs` | ✓ | — | Lịch sử run `?status&limit` (≤2000) |
| GET | `/api/loadtest/runs/:id/metrics` | ✓ | — | Metric samples từ DB (limit ≤ 20000 + total đếm riêng) |
| GET | `/api/loadtest/runs/:id/logs` | ✓ | — | Log events từ DB `?level&limit&offset` |
| GET | `/api/loadtest/runs/:id` | ✓ | — | Run detail (config + report từ summary_json) |
| DELETE | `/api/loadtest/runs/:id` | ✓ | write | Xóa run (cascade) |

Hạ tầng chung: envelope chuẩn (http-server.ts:89-101), body ≤ 1MB + 400/413 + destroy socket khi 413 (http-server.ts:104-130, 207-216), CORS echo origin + `Vary: Origin` (http-server.ts:59-68), requestId `X-Request-Id` + error context (api-server.ts:191-192), runId format-check `^lt[a-z0-9-]{2,24}$` trước decodeURIComponent (SB-2, http-server.ts:134-162), IP không tin X-Forwarded-For trừ TRUST_PROXY (http-server.ts:71-80), 500 generic không lộ message (api-server.ts:255-257).

### 2.9 Observability

| Feature | Nguồn | Mô tả |
|---|---|---|
| Structured JSONL logger | logger.ts:252-287 | Entry `{ts, level, msg, runId?, workerId?, requestId?, context?}`; sink file `LOGTEST_LOG_FILE` append + rotation 10MB → `.1`..`.5` (createJsonlSink, Windows-safe appendFileSync); console text/JSON theo LOADTEST_LOG_JSON |
| Ring buffer 500 + subscribe | logger.ts:62-75 | Dashboard `/logs` + DB log_events (giữ format text cũ) |
| Redaction | logger.ts:90-135, db/int.ts | `redactSensitiveFields` chặn field /authorization|password|refreshToken|token|otp|secret/i ở MỌI sink; `redactMsg` chặn `password=...` trong text; `redactUrl` che credential trong URL |
| Tool metrics | tool-metrics.ts:23-68 | Counters: `dbWriteFail, dbRetry, apiErrors, workerRestarts, runFinished`; gauges: `coordinator.rssMb, worker.alive`; snapshot 5s vào log (coordinator.ts:309-323); Prometheus text đủ `# TYPE/# HELP` + `_total` |
| traceId/runId/requestId | logger.ts:30-35, http-server.ts:25-27 | runId trong log run; requestId per request + X-Request-Id; workerId trong log worker |
| Health endpoint | health.ts:44-134 | Probe DB (query_timeout 2s) + Redis (commandTimeout 2s, ping) cache 10s; workers aliveness thật; KHÔNG 'ok' giả (TH-14) |

### 2.10 Frontend dashboard (9 pages + shell)

| Page | File | Chức năng chính |
|---|---|---|
| ControlPanel | ControlPanelPage.tsx | Preset chips (10k/50k/100k/1M/10M + custom), target/ramp rate/rampMode/duration/profile/gateway, ước lượng infra (workers/RAM/seat), cảnh báo allowlist/OTP/1M, timeline phase, start confirm + stop confirm dialog, 429 cooldown countdown, sticky CTA |
| LiveDashboard | LiveDashboardPage.tsx | KPI 8 tile + sparkline 60 tick, charts: connections (range 30m/1h/2h/all), latency P50/P95/P99 log-scale, actions/s stacked area, gauges success/echo, queue/rooms/reconnect/outbox, top errors + virtualized "Xem tất cả" dialog, server-side scrape card, bottleneck banner queue >1.5×/5 phút, worker chết banner (E3) |
| ScenarioBuilder | ScenarioBuilderPage.tsx | YAML editor (default template), profile sliders % (tổng = 100), regex validation (duration/rampUp/profiles), pacing khóa cứng hiển thị; Lưu/Load là **placeholder** (toast, v1.1) |
| Settings | SettingsPage.tsx | Allowlist CRUD (ws/http/https), OTP/Redis status (chỉ hiện "đã cấu hình", không in giá trị), giới hạn mặc định hiển thị, switch "bắt buộc xác nhận env" (localStorage prefs), auto-cleanup **disabled** (v1.1), nút mở Cleanup |
| Cleanup | CleanupPage.tsx | Quét dry-run tự động khi mount, 4 StatCard (user/post/redis/session), 3 tầng steps + baseline check, exec mode có cảnh báo xác nhận |
| History | HistoryPage.tsx | List run từ DB, filter status, search runId, xóa run (confirm dialog), vào RunDetail |
| RunDetail | RunDetailPage.tsx | 3 tabs: overview (KPI + replay charts từ metric_samples), report (per-action + bottlenecks), logs (level filter) |
| Report | ReportPage.tsx | Summary KPI, latency per action bảng, bottleneck candidates + EvidenceDialog (LineChart vùng nghi vấn + ReferenceArea/ReferenceLine), config snapshot, export JSON/MD/CSV qua axios blob (mang Bearer) |
| Login/Register | LoginPage.tsx, RegisterPage.tsx | Admin auth; ẩn CTA register khi gate đóng; password strength client-side; redirect `from` |
| Shell | app-shell.tsx | Sticky run header (pause/stop/logs từ mọi màn), desktop top nav + mobile bottom nav, ErrorBoundary reset theo pathname, banner reconnect |

Store: `loadtest.store.ts` — poll 1s (status + metrics `since` incremental), ring 3600, pollStatus offline/live/reconnecting; `profile` share Scenario→Control; prefs localStorage. API client: `loadtest-api.ts` — interceptor Bearer + 401 callback, `toApiError` đọc retryAfterSec (envelope + header), downloadReport qua blob.

### 2.11 Reports

| Feature | Nguồn | Mô tả |
|---|---|---|
| Build report | report.ts:34-120 | Summary (usersCreated, connect/active max, actions, successRate, echoRate, throughput avg/peak, queue peak) + perAction (count/success/fail/successRate/p50/p95/p99) + top 20 errors + bottlenecks + stopReason + noPostFixtureSkipped |
| Bottleneck detector | report.ts:132-194 | 4 luật: (1) echo rate < 95% (≥100 echo), (2) queue tăng liên tục > 5 phút (longestNonDecreasingRun, growth > 50), (3) P95 tăng > 2× so 5 phút đầu, (4) worker CPU > 85% — kèm evidence series |
| Markdown | report.ts:225-280 | Bảng summary + latency per action + bottlenecks + top errors + config JSON |
| CSV | report.ts:283-300 | Raw tick 1s: 22 cột counters/rates/latency/workers/server |
| Save files | report.ts:303-316 | `{reportsDir}/{runId}/report-{runId}.{json,md} + metrics-{runId}.csv` tự động mỗi finish |
| Export API | routes/run.ts:125-141 | `?format=json|md|csv` + Content-Disposition attachment |
| NO_POST_FIXTURE | report.ts:76-81, coordinator.ts:435-437 | Đếm từ raw worker errors trước top-10 cap; hiện section riêng trong MD + field trong JSON |

### 2.12 Testing & CI

- **Unit tests** (loadtest/__tests__, vitest): api-server, auth, config, coordinator-state, coordinator, contract, e2e-mock-gateway, health, int, logger, metrics, migrate, mock-gateway, provision-pool-reuse, rate-limit, report, rest-actions, seed-accounts, socket-farm, store, tool-metrics, types-contract (+ typecheck), worker-farm, writer — 24 file.
- **Contract test** (contract.test.ts): mọi route trong ROUTES → assert method+path + envelope chuẩn + 401 khi thiếu token (không cần Postgres).
- **E2E mock gateway** (e2e-mock-gateway.test.ts): coordinator.start + provisionAccounts với mock gateway (http+socket.io) + FakeRedis in-memory + recording DbWriter → run 12 users × 30s → report + pipeline DB đúng thứ tự.
- **Mutation testing** (stryker.config.mjs): 4 module pure — coordinator-state, metrics, config, report; ngưỡng break 70%.
- **CI** (.github/workflows/ci.yml): matrix ubuntu+windows, gitleaks-action (secret scan), Postgres 16 qua docker run (ubuntu leg), 3 test DB, gates: lint + typecheck root + typecheck loadtest + build + loadtest:test + workspace test + coverage frontend (threshold 70%), upload coverage artifact.

### 2.13 Security

- **Threat model 14 threats** (docs/THREAT-MODEL.md, TH-1..TH-14) — tất cả đã xử lý/accept+document: secret cleanup (T-01/T-02), CSP (TH-2/TH-13), brute-force rate-limit (TH-3), register gate (TH-4), CORS allowlist (TH-5), pool plaintext accept (TH-6), token không trong query (TH-7), generic 500 (TH-8), path traversal runId (TH-9), CSRF/DNS rebinding document (TH-10), log redaction (TH-11), shutdown finalize (TH-12), health no false-ok (TH-14).
- **CSP** (vite.config.ts `injectCspMeta`): `script-src 'self'` (không inline), connect-src explicit origins (không wildcard ws:), chỉ inject lúc build.
- **Socket auth**: token qua `auth` CONNECT packet + Bearer header, không query string (socket-farm.ts:100-101).
- **Redaction** tầng log/error/DB (logger.ts, db/int.ts).
- **.gitignore** chặn `loadtest/data/*` (giữ .gitkeep) + gitleaks pre-commit + CI scan; Dockerfile không nhận secret (chỉ -e/-v).

---

## 3. "Khoảng trống" (gaps) — bằng chứng trong code, chưa có

Mỗi gap 1 dòng (bằng chứng · gợi ý hướng thêm):

1. **Không chạy 2 run song song** — coordinator là singleton state machine, `start()` trả 409 khi isRunning (coordinator.ts:170, 120-122) · thêm run queue / multi-run isolated context.
2. **Retention không tự động** — chỉ có CLI thủ công `loadtest:db:cleanup` (db/cleanup.ts:43-82), Settings hiển thị "30 ngày" nhưng không có cơ chế; settings "Auto-cleanup sau run" disabled (SettingsPage.tsx:216-219) · thêm retention scheduler/timer trong server.
3. **Không dùng refresh token khi reuse pool** — mỗi run phải login lại toàn bộ (auth-factory.ts:333-384 chỉ login; accessToken cũ không dùng) · thêm refresh-token path cho pool account.
4. **Không có so sánh benchmark 2 run** — history chỉ xem từng run (routes/history.ts, HistoryPage.tsx) · thêm compare view / diff metrics.
5. **CSV export hạn chế** — chỉ raw ticks (report.ts:283-300); không có CSV per-action/summary; export chỉ từ report run hiện tại (`/report/export`, routes/run.ts:125-141), không export được từ RunDetail/History · thêm export ở run cũ + nhiều format.
6. **Không có alerting/notify** — không có webhook/telegram/email khi run finish/error (grep 0) · thêm notifier hook.
7. **Gateway scrape chỉ 2 metric** (ws_connections, ws_messages_emitted_total — coordinator.ts:564-570) + không kèm auth token (gateway /metrics có thể 401 → luôn 0) · mở rộng bộ metric + configurable token.
8. **Không có UI xem pools** — `loadtestApi.pools()` (loadtest-api.ts:213-215) không page nào gọi; không có màn pool reuse history · thêm PoolPage.
9. **`rampMode='minutes'` không có tác dụng thật** — chỉ lưu/hiển thị, paced connect dùng rampRate thuần (socket-farm.ts:472-482, grep rampMode) · hoặc tính rampRate = target/duration, hoặc bỏ option.
10. **Không có CLI/headless run** — mọi thao tác qua HTTP API (không script chạy run từ terminal) · thêm CLI run với report output.
11. **`freshAccounts` không có UI toggle** — ControlPanel luôn gửi `freshAccounts:false` (ControlPanelPage.tsx:143); không bấm được "register mới" từ UI · thêm switch/checkbox.
12. **ScenarioBuilder Lưu/Load là placeholder** (ScenarioBuilderPage.tsx:117-121), không persist scenario · lưu vào localStorage/DB.
13. **`vote_kick` có trong ActionType nhưng không có driver** — ACTION_TYPES types.ts:9, không implementation trong socket-farm/rest-actions · thêm action hoặc bỏ khỏi type.
14. **Chỉ có E1/E2/E3 auto-stop** — không có auto-stop theo success rate/echo rate khi steady (coordinator.ts:490-535) · thêm threshold configurable.
15. **Không có retention/rotation cho report files + token pool files** — docs/loadtest-reports tăng mãi (saveReportFiles report.ts:303-316) · thêm cleanup theo age.

---

## 4. Điểm yếu / bug còn sót (đọc code kỹ, có file:dòng)

### Major

1. **Race: `provisionAndLaunch` của run cũ "xuyên" vào run mới** · `loadtest/coordinator.ts:262` — Guard sau `await provisionAccounts` chỉ kiểm tra `this.phase`/`this.finishing`, KHÔNG kiểm tra `this.runId`. Kịch bản: run A đang provisioning → user stop (phase='stopped') → start run B (phase='provisioning' lại) → khi `provisionAccounts` của A trả về, guard PASS (phase đang là provisioning của B) → A gán `this.accounts`/spawnAll workers (đè handle của B qua C-1 kill) → phase chuyển ramping sớm + account/config lẫn lộn giữa 2 run; report/counters của B nhiễm dữ liệu A. **Sửa**: capture `const myRunId = this.runId` đầu hàm, sau await kiểm tra `myRunId === this.runId && !this.finishing && this.phase === 'provisioning'`.

### Minor

2. **`writePool` ghi đè `logged_in`/`failed` của POOL NGUỒN** · `loadtest/db/writer.ts:311-317` — Khi reuse, `upsertPool({...fromPoolRow(src), loggedIn: summary.loggedIn, failed: summary.failed, errorsJson})` thay toàn bộ số liệu pool nguồn bằng số liệu của riêng run reuse (vd pool 10k account được run 3k reuse → logged_in trở thành 3k, không nhất quán với accountCount 10k). **Sửa**: khi reuse chỉ cập nhật `reusedByRunIdsJson` + per-account, không ghi đè loggedIn/failed tổng.

3. **`markPoolReused` đánh dấu TOÀN BỘ pool_accounts thành `logged_in`** · `loadtest/db/store.ts:632-636` — `UPDATE pool_accounts SET status='logged_in', last_login_at=$now WHERE pool_id=$3` đánh cả account login FAIL trong run reuse → pool_accounts sai trạng thái; kèm theo bug #2 (không có per-account outcome cho DB reuse path vì `poolSourceRunId` chỉ set ở disk path — auth-factory.ts:190) nên `runs.pool_source_run_id` = NULL với reuse qua DB. **Sửa**: markPoolReused chỉ set `last_used_run_id`; để writePool cập nhật status/loginAt per-account; set poolSourceRunId ở DB path.

4. **Disk pool file hỏng làm CHẾT cả run** · `loadtest/auth-factory.ts:192-194` — `JSON.parse(fs.readFileSync(...))` không có try/catch (listPools đã guard parse ở 121-124 nhưng đoạn load lại không) → 1 file `accounts-*.json` corrupt khớp targetUsers+gateway → throw → `provisionAndLaunch` catch → finishRun auto error, thay vì fallback register. **Sửa**: bọc try/catch → log warn → fallback bước tiếp.

5. **`rampMode:'minutes'` không ảnh hưởng hành vi** · `loadtest/config.ts:393` + `loadtest/socket-farm.ts:472-482` — UI cho chọn "trong X phút" nhưng paced connect chỉ đọc `rampRate`; chế độ minutes chạy y hệt rate (mặc định 200/s). **Sửa**: resolve `rampRate = targetUsers/(durationMin*60)` khi minutes, hoặc bỏ option khỏi UI.

6. **Phone số trùng giữa 2 run cùng giây** · `loadtest/util.ts:73-77` + `loadtest/config.ts:403` — `genPhone(index, seed)` chỉ phụ thuộc (index, seed), `seed = Date.now() % 1_000_000` → 2 run start cùng giây có cùng phone cho cùng index (email khác nhau) → nếu gateway enforce phone unique, run sau fail register (verify-sms-otp/complete). **Sửa**: trộn runId vào seed phone.

7. **`/cleanup` khi Redis down → 500 generic** · `loadtest/routes/settings.ts:89-97` — `redis.connect()` throw không được catch → api-server trả 500 SERVER_ERROR thay vì lỗi rõ ràng 503. **Sửa**: try/catch → 503 + message.

8. **Cleanup chỉ đọc accounts từ disk pool** · `loadtest/routes/settings.ts:80-88` — nếu run reuse pool DB và file disk đã xoá → `accounts=[]` → không dọn user keys (`chat:ratelimit:{userId}`...), chỉ dọn OTP keys theo runId. **Sửa**: fallback đọc pool_accounts từ DB theo runId.

9. **Success rate mặc định 100% khi không có action** · `loadtest/report.ts:106` (+ coordinator-state.ts:183) — run chết trước khi có action nào → report "Success 100%" gây hiểu lầm. **Sửa**: mặc định 0 hoặc 'n/a'.

10. **E2 connect-fail rate tính cả reconnect attempt** · `loadtest/socket-farm.ts:128-133` — mỗi `connect_error` tăng CẢ `connectAttempts` lẫn `connectFails` → user reconnect thành công sau 3 lần fail = 75% fail rate → gateway chập chờn lan rộng có thể trigger E2 auto-stop (>30%) dù run vẫn ổn định về sau (có comment design intent, nhưng ngưỡng nhạy). **Sửa**: đếm theo "session connect" hoặc sliding window riêng cho E2.

11. **Dashboard hiện dữ liệu run cũ sau khi server restart** · `src/store/loadtest.store.ts:151-160` — phase về `idle`/`runId=''` nhưng `ticks`/`lastTick` trong store không được reset → LiveDashboard hiển thị số liệu run trước (nếu không F5). **Sửa**: khi nhận `status.runId === ''` và store.runId khác → resetRun().

12. **`successRate`/`echoRate` trong tick provisioning luôn 100** · `loadtest/coordinator.ts:421-424` — tick provisioning set rates 100/100 mặc định → KPI "Success 100%" trong lúc provisioning gây hiểu lầm nhẹ (không phải lỗi hệ thống). **Sửa**: để null/0 trong provisioning phase.

---

## Phụ lục: số liệu nhanh

- Backend files: 18 module chính (`loadtest/*.ts`) + 4 routes + 7 db files + 2 entry (server/worker) + 24 test files.
- Route count: **28** (4 public + 14 auth run/auth + 5 settings + 5 history).
- Env keys: **30 `LOADTEST_*` trong config.ts** + `LOADTEST_PROVISION_CONCURRENCY`, `LOADTEST_WORKER_ID`, `LOGTEST_LOG_FILE`, `LOADTEST_LOG_JSON` đọc trực tiếp từ process.env.
- DB: **7 bảng**, 1 migration (001_init.sql).
- NPM scripts (package.json): `loadtest:server`, `loadtest:typecheck`, `loadtest:test`, `loadtest:mutation`, `loadtest:db:up/down/status/cleanup`, `loadtest:seed-accounts`, `secret:scan`.
