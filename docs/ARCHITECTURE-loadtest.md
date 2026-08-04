# ARCHITECTURE — Refactor LoadTest Tool (backend + frontend)

**Status**: Proposed — chờ review
**Version**: 0.1 — 2026-08-04
**Repo**: `C:\MAYogu_VIASG\chat-app`
**Phạm vi**: Toàn bộ "loadtest tool" — backend `loadtest/` (coordinator + API + DB + auth + worker farm) và frontend dashboard `src/` (React).
**Mục tiêu**: Refactor code "tạm bợ" thành dự án mở rộng được: kiến trúc rõ ràng (hexagonal/clean cho backend, layered cho frontend), type-safe, error handling chuẩn, single source of truth, mỗi phase refactor độc lập shippable.
**Tài liệu tham chiếu**: `docs/PRD-loadtest-tool.md`, `docs/PRD-loadtest-run-database.md`, `docs/PRD-loadtest-admin-auth.md`, `docs/UI-SPEC-loadtest-tool.md`, `docs/API-loadtest-tool.md`.

---

## 1. Hiện trạng & vấn đề

### 1.1 Kiến trúc hiện tại

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  npm run loadtest:server  →  tsx loadtest/server.ts                          │
│                                                                              │
│  server.ts  (composition root thủ công — server.ts:26-39)                    │
│    ├─ getEnv() → LoadTestEnv (singleton cache — config.ts:68)                │
│    ├─ LoadtestStore (Postgres pg — store.ts:126)                             │
│    │    └─ DbWriter (batch 30s/500 tick — writer.ts:19-20)                    │
│    ├─ LoadTestCoordinator (GOD CLASS 537 dòng — coordinator.ts:32)           │
│    │    ├─ vòng đời run + state machine (coordinator-state.ts:19-40)         │
│    │    ├─ aggregateTick 1s + auto-stop E1/E2/E3 (coordinator.ts:302-407)    │
│    │    ├─ WorkerFarm (fork child_process — worker-farm.ts:55)                │
│    │    │    └─ worker.ts → socket-farm.ts (694 dòng: VirtualUser + Runtime) │
│    │    ├─ AuthFactory (Redis OTP-seed + register/login — auth-factory.ts)   │
│    │    └─ buildReport + saveReportFiles (report.ts)                          │
│    └─ ApiServer (GOD CLASS 532 dòng — api-server.ts:35)                      │
│         ├─ node:http thuần, routing bằng so chuỗi (api-server.ts:128-382)    │
│         ├─ auth HMAC inline (api-server.ts:112-124, 386-439)                 │
│         └─ mapping helpers cuối file (api-server.ts:444-531)                 │
│                                                                              │
│  util.ts: logger global mutable + ring buffer 500 (util.ts:6-49)             │
└──────────────────────────────────────────────────────────────────────────────┘

Frontend (React 18 + Vite + Tailwind + zustand + axios + Recharts):
  src/App.tsx:56-70  →  /loadtest/* qua RequireLoadtestAuth (require-auth.tsx:12)
  src/lib/loadtest-api.ts (21 method phẳng) + interceptor Bearer (49-70)
  src/store/loadtest-auth.store.ts + loadtest.store.ts (poll 1s — 165-192)
  src/pages/loadtest/* (10 trang) + src/components/loadtest/* (8 component)
  Vite proxy /api/loadtest → 3401 (vite.config.ts:15-22)
```

### 1.2 Bảng các điểm "tạm bợ" cụ thể (file:dòng)

| # | Vấn đề | Dẫn chứng (file:dòng) | Hệ quả |
|---|--------|------------------------|--------|
| 1.2.1 | **Timestamp float → BIGINT** — `importLegacyPools` dùng `fs.statSync(filePath).mtimeMs` (float) làm `created_at` cho cột `pools.created_at BIGINT` | `db/writer.ts:256`; cột `created_at BIGINT` ở `db/schema.sql:74` | Log spam `query fail (invalid input syntax for type bigint: "1785752359549.027") — retry 1 lần`, insert bị bỏ im lặng → pool legacy không import được |
| 1.2.2 | **Retry vô nghĩa** — query helper retry 1 lần cho mọi lỗi khác `23505/23503`; lỗi định thức (vd `22P02` invalid syntax) retry 100% vẫn fail | `db/store.ts:173-192` | Retry phí phạm, không chẩn đoán được; lỗi `22P02` chỉ nên báo/làm rõ, không retry |
| 1.2.3 | **Parser int8 toàn cục** — `pg.types.setTypeParser(20, v => Number(v))` biến mọi BIGINT thành number; giá trị > 2^53 mất chính xác | `db/store.ts:19` | Không type-safe; chỉ nên parse ngay ở biên (boundary) cho các cột đã biết là epoch ms |
| 1.2.4 | **File JSON + DB song song (2 nguồn sự thật)** — `persistPool` vẫn ghi `accounts-*.json`; `listPools` đọc file; API `/pools` fallback file→DB | `auth-factory.ts:353-364`, `auth-factory.ts:105-126`, `api-server.ts:312-333` | Phải sync 2 nơi; reuse pool đọc file thay vì DB (PRD B4 chưa hoàn thành) |
| 1.2.5 | **server.ts gắn mọi thứ** — bootstrapping thủ công, không DI, không testable | `server.ts:26-39` | Không test được luồng khởi động; đổi DB/logger phải sửa server.ts |
| 1.2.6 | **God classes** — `api-server.ts` (532 dòng), `coordinator.ts` (537 dòng), `socket-farm.ts` (694 dòng) | `api-server.ts:35`, `coordinator.ts:32`, `socket-farm.ts:367` | Khó đọc, khó test, khó mở rộng; trộn orchestration + HTTP + mapping + auth |
| 1.2.7 | **Thiếu tách lớp / thiếu port** — `api-server.ts` gọi thẳng `store.*`, `coordinator.*`, `loadSettings`, `runCleanup`, `createRedis` | `api-server.ts:148-333` | Không thể swap implement (SQLite↔Postgres, memory↔persist, secret) |
| 1.2.8 | **Thiếu type-safe ở DB** — `query<T>` trả `[]` khi lỗi; caller không phân biệt "không có dữ liệu" vs "DB fail" | `db/store.ts:173-192` | Mất dữ liệu im lặng; `countMetricSamples` trả 0 khi DB lỗi |
| 1.2.9 | **`readBody` swallow lỗi parse** — JSON hỏng → `{}` thay vì 400 | `api-server.ts:95-105` | Request sai body không bị chặn, lỗi khó hiểu |
| 1.2.10 | **Envelope không nhất quán** — `ok()` không có `message`/`timestamp`; `fail()` không có `error` code/`timestamp` | `api-server.ts:87-93` | Khác chuẩn PRD `{ success, statusCode, message, data, metadata, timestamp }`; frontend phải tự đoán |
| 1.2.11 | **Logger global mutable** — `logHistory` + `subscribeLog` là module-level; log_events ghi 1 hàng/1 log (không batch) | `util.ts:6-49`; `db/writer.ts:133-136` | Không inject/test được; run nhiều log → ngập DB |
| 1.2.12 | **Config singleton cache** — `getEnv` cache toàn cục, không thể tạo 2 config trong test | `config.ts:68` | Test khó; thay đổi env thời gian chạy không có hiệu lực |
| 1.2.13 | **Metric flush 30s heuristics** — hard-code `FLUSH_INTERVAL_MS=30_000`, `MAX_PENDING_TICKS=500`; crash mất ≤30s/500 tick; `flushTicks` dùng `flushing` flag — lời gọi trùng bị bỏ | `db/writer.ts:19-20, 107-117` | Không cấu hình được; mất dữ liệu khi SIGKILL |
| 1.2.14 | **Session lưu localStorage** — token + user trong localStorage, XSS đọc được | `src/lib/loadtest-auth-storage.ts:16-46` | Rủi ro XSS (đã hỏi trong PRD §8; cần chốt lại) |
| 1.2.15 | **Dead code** — `checkHeartbeats` không được gọi; worker gửi `final-tick` nhưng coordinator không xử lý | `worker-farm.ts:138-149`; `socket-farm.ts:663-665` vs `coordinator.ts:265-298` | Hệ thống "chết" mang nhầm tưởng đang bảo vệ |
| 1.2.16 | **runId collision risk** — `newRunId` dùng `Date.now().toString(36).slice(-6)` + module counter (reset khi restart) | `config.ts:219-225` | 2 run cùng 6 ký tự đầu trong 1 giây sau restart → trùng PK |
| 1.2.17 | **PRD drift** — PRD chọn SQLite, code đã dùng Postgres (`pg`, DDL Postgres, env `postgresql://`) | `db/store.ts:13`; `db/schema.sql:1-13`; `loadtest/.env.example` | Tài liệu và code lệch; cần chốt lại DB thật |
| 1.2.18 | **Không rate-limit, CORS `*`** | `api-server.ts:75-79` | Auth/start/allowlist bị gọi ồ ạt; CORS mở cho mọi origin |
| 1.2.19 | **Frontend single store + api phẳng** — `loadtest.store.ts` quản lý config+run+ticks+prefs; `loadtestApi` 21 method; `unwrap` naïve | `src/store/loadtest.store.ts:47-82`; `src/lib/loadtest-api.ts:79-195` | Không chia miền; tái sử dụng kém |
| 1.2.20 | **Frontend fetch không phân trang** — `RunDetailPage` `Promise.all` toàn bộ metrics+logs; `HistoryPage` lấy toàn bộ runs | `src/pages/loadtest/RunDetailPage.tsx:56-80`; `HistoryPage.tsx:38-53` | Run dài → tải MB dữ liệu, UI đơ |
| 1.2.21 | **Duplicate validation** — `validatePasswordStrength` viết lại ở frontend | `src/pages/loadtest/RegisterPage.tsx:15-24` vs `db/password.ts:46-58` | 2 nơi lệch chuẩn |
| 1.2.22 | **Log lệch định dạng** — `logHistory` lưu dòng `[lt][LEVEL][ts] ...` trong khi `log_events` lưu raw msg | `util.ts:31` vs `db/writer.ts:133-136` | Khó truy vết giữa 2 nguồn |

---

## 2. Kiến trúc mục tiêu

### 2.1 Nguyên tắc

**Backend — Hexagonal / Clean Architecture** (port & adapter, dependency rule):

- **Domain (pure)**: state machine, metric/histogram, report, error codes, run config — KHÔNG import infra, không IO.
- **Application (use cases + ports)**: orchestrate run, auth, allowlist, cleanup, persistence contract.
- **Infrastructure (adapters)**: Postgres repos, Redis, HTTP server, worker farm, HMAC token, logger.
- **Composition root duy nhất**: `main/bootstrap.ts` — nơi duy nhất nối các implement.

**Frontend — Layered** (feature folder):

- `pages/` → `hooks/` (data-fetching) → `stores/` (zustand) → `api/` (axios) → `types/`.
- Không gọi API trực tiếp trong component; không self-subscribe toàn store.

5 nguyên tắc kiến trúc khiến dự án "mở rộng được":

1. **Type-safe ở boundary**: mọi số epoch phải là integer khi chạm DB (BIGINT); không bao giờ insert float vào BIGINT.
2. **Retry chỉ cho lỗi transient**: lỗi định thức phải fail nhanh + log rõ ràng.
3. **Single source of truth**: DB là nguồn query; memory ring buffer chỉ phục vụ dashboard LIVE; file JSON chỉ là artifact export/import 1 lần.
4. **Envelope + error code chuẩn** cho mọi endpoint.
5. **Composition root duy nhất** + DI qua constructor injection (không global singleton).

### 2.2 Diagram backend mục tiêu

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Driving adapters (infrastructure/http)                                     │
│   http/server.ts · router.ts · middleware/{auth,rate-limit,body}            │
│   controllers/{auth,run,live,history,pool,cleanup}.ts                       │
├──────────────────────────────────────────────────────────────────────────────┤
│  Application (application/)                                                 │
│   use-cases: start-run · stop-run · manage-allowlist · cleanup · auth       │
│   ports: RunRepository · MetricRepository · PoolRepository · LogRepository  │
│          AdminRepository · AccountProvisioner · SessionService              │
├──────────────────────────────────────────────────────────────────────────────┤
│  Domain (domain/ — PURE, không import infra)                                │
│   run-phase · run-config · tick · metrics · report · errors · types         │
├──────────────────────────────────────────────────────────────────────────────┤
│  Driven adapters (infrastructure/)                                          │
│   db/repositories/* (Postgres) · redis/ · auth/hmac-token ·                 │
│   workers/{worker-farm, socket-farm, rest-driver} · logging/logger          │
└──────────────────────────────────────────────────────────────────────────────┘
                                ▲
                main/bootstrap.ts (composition root — nối tất cả)
```

### 2.3 Quy tắc phụ thuộc (dependency rule)

| Tầng | Được import | Bị cấm import |
|------|-------------|----------------|
| `domain/` | — (chỉ stdlib, không IO) | `infrastructure/*`, `application/ports`, `pg`, `ioredis`, `node:http` |
| `application/` | `domain/`, `application/ports` (interface) | `infrastructure/*` |
| `infrastructure/` | `domain/`, `application/ports`, `application/use-cases` | — |
| `main/bootstrap.ts` | mọi thứ | — (chỉ nơi này được import cụ thể) |

**Luật nghiêm ngặt**: không file nào trong `application/` import từ `infrastructure/`; không use-case `new` implement cụ thể — mọi thứ qua port interface + constructor injection.

### 2.4 Ranh giới module

| Module | Trách nhiệm | KHÔNG được làm |
|--------|--------------|----------------|
| `domain/metrics.ts` | Histogram, counter, quantile | Ghi DB, đọc env |
| `domain/run-phase.ts` | Transition, auto-stop decision | Gọi WorkerFarm |
| `application/coordination/run-orchestrator.ts` | Điều phối run (thay `coordinator.ts`) | SQL, socket, HTTP |
| `application/ports/run.repository.ts` | Interface ghi/đọc run | SQL |
| `infrastructure/db/repositories/run.postgres.ts` | Implement SQL | Business logic |
| `infrastructure/http/controllers/*` | Parse request, gọi use-case, trả envelope | SQL, business logic |
| `infrastructure/workers/*` | Fork process, socket, REST driver | DB |

---

## 3. Cấu trúc thư mục mục tiêu

### 3.1 Backend (`loadtest/`)

```
loadtest/
├── src/
│   ├── main/
│   │   ├── bootstrap.ts           ← server.ts hiện tại (composition root)
│   │   └── worker-entry.ts        ← worker.ts hiện tại
│   ├── config/
│   │   ├── index.ts               ← loadConfig() → Config (không singleton cache)
│   │   ├── env.ts                 ← đọc .env + process.env (giữ loadDotEnv)
│   │   ├── schema.ts              ← validate + type (thay config.ts:20-115)
│   │   └── run-request.ts         ← validateRunRequest + presets + estimate (config.ts:126-248)
│   ├── domain/
│   │   ├── types.ts               ← RunConfig, TestAccount, LoadTestTick, RunReport...
│   │   ├── run-phase.ts           ← coordinator-state.ts:19-74 (transition, auto-stop)
│   │   ├── aggregate.ts           ← coordinator-state.ts:88-194 (aggregateTicks)
│   │   ├── metrics.ts             ← metrics.ts
│   │   ├── report.ts              ← report.ts (buildReport + bottleneck + export)
│   │   └── errors.ts              ← AppError, ErrorCode, mapErrorCode
│   ├── application/
│   │   ├── ports/
│   │   │   ├── run.repository.ts
│   │   │   ├── metric.repository.ts
│   │   │   ├── pool.repository.ts
│   │   │   ├── log.repository.ts
│   │   │   ├── admin.repository.ts
│   │   │   ├── session.service.ts
│   │   │   └── account-provisioner.ts
│   │   └── use-cases/
│   │       ├── run-orchestrator.ts   ← coordinator.ts (tách phần orchestration)
│   │       ├── auth.ts               ← register/login/logout/me
│   │       ├── allowlist.ts
│   │       ├── cleanup.ts
│   │       └── history.ts            ← listRun/getRun/deleteRun/listMetrics/listLogs
│   ├── infrastructure/
│   │   ├── http/
│   │   │   ├── server.ts             ← ApiServer (listen/close)
│   │   │   ├── router.ts             ← map method+path → handler (thay api-server.ts:128-382)
│   │   │   ├── response.ts           ← ok/fail/error envelope chuẩn
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts           ← requireAuth/requireRole
│   │   │   │   ├── rate-limit.ts
│   │   │   │   └── body.ts           ← readBody + size limit + 400
│   │   │   └── controllers/
│   │   │       ├── auth.controller.ts
│   │   │       ├── run.controller.ts
│   │   │       ├── live.controller.ts
│   │   │       ├── history.controller.ts
│   │   │       ├── pool.controller.ts
│   │   │       └── cleanup.controller.ts
│   │   ├── db/
│   │   │   ├── pool.ts               ← pg.Pool lifecycle
│   │   │   ├── int.ts                ← toEpochMs/toInt64 coercion (fix BIGINT)
│   │   │   ├── migrations/           ← 001_base.sql, 002_*.sql...
│   │   │   └── repositories/
│   │   │       ├── run.postgres.ts
│   │   │       ├── metric.postgres.ts
│   │   │       ├── pool.postgres.ts
│   │   │       ├── log.postgres.ts
│   │   │       └── admin.postgres.ts
│   │   ├── redis/
│   │   │   └── redis.ts              ← createRedis + OTP seed (auth-factory.ts:70-88, 378-384)
│   │   ├── auth/
│   │   │   └── hmac-token.ts         ← auth.ts (giữ nguyên logic, thêm version/tokenType)
│   │   ├── workers/
│   │   │   ├── worker-farm.ts
│   │   │   ├── socket-farm.ts
│   │   │   ├── rest-driver.ts        ← rest-actions.ts
│   │   │   └── http-client.ts        ← http.ts
│   │   └── logging/
│   │       ├── logger.ts             ← interface Logger + console impl + ring buffer
│   │       └── log-sink.ts           ← subscriber ghi log_events (batch)
│   └── shared/
│       ├── time.ts                   ← nowSec, jitter, sleep
│       ├── url.ts                    ← normalizeUrl
│       ├── random.ts                 ← uuidV4, genPassword, genDeviceInfo, genPhone...
│       └── text.ts                   ← genChatContent, genCommentContent
├── db/                               ← giữ script init/verify (chạy riêng)
│   ├── init.ts
│   ├── password.ts
│   └── schema.sql                    ← base (đổi thành migrations/001_base.sql)
├── __tests__/
├── tsconfig.json
├── vitest.config.ts
└── .env.example
```

### 3.2 Frontend — khuyến nghị: **giữ trong `src/loadtest/`** (feature folder), KHÔNG tách `loadtest-ui/`

**Khuyến nghị rõ ràng**: giữ trong `src/loadtest/` (di chuyển từ vị trí rải rác hiện tại). Lý do:

1. **Dùng chung bộ shadcn/ui `@/components/ui/*`** (Card, Button, Table, Dialog, Tabs, Select...) — tách ra phải copy ~15 component + tailwind config + vite config.
2. **Cùng Vite dev server + proxy `/api/loadtest`** (`vite.config.ts:15-22`) — tách = 2 dev server, 2 node_modules.
3. **Đã tách biệt ở tầng route + auth** (`App.tsx:56-70`, `RequireLoadtestAuth`) — ranh giới đã gọn.
4. Chi phí tách (`loadtest-ui/` riêng) chỉ đáng trả khi tool **deploy độc lập** hoặc chia team — đưa vào v1.1 khi có nhu cầu thật.

**Cấu trúc mục tiêu**:

```
src/
├── loadtest/                        ← feature folder (thay vì rải rác prefix loadtest-)
│   ├── api/
│   │   ├── client.ts                ← axios instance + interceptors (loadtest-api.ts:27-70)
│   │   ├── auth.ts                  ← register/login/logout/me
│   │   ├── run.ts                   ← start/stop/pause/resume/status/metrics/errors/logs/report
│   │   ├── history.ts               ← listRuns/getRun/getRunMetrics/getRunLogs/deleteRun
│   │   └── pool.ts                  ← pools/allowlist/cleanup/config
│   ├── hooks/
│   │   ├── use-loadtest-query.ts    ← generic {data,error,loading,refetch} pattern
│   │   └── use-run-history.ts       ← HistoryPage + RunDetailPage data
│   ├── stores/
│   │   ├── auth.store.ts            ← loadtest-auth.store.ts
│   │   ├── live.store.ts            ← loadtest.store.ts (chỉ phần LIVE: status/ticks/poll)
│   │   └── prefs.store.ts           ← requireEnvConfirm (tách khỏi live store)
│   ├── pages/
│   │   ├── login.tsx
│   │   ├── register.tsx
│   │   ├── control-panel.tsx
│   │   ├── live-dashboard.tsx
│   │   ├── scenario-builder.tsx
│   │   ├── report.tsx
│   │   ├── settings.tsx
│   │   ├── cleanup.tsx
│   │   ├── history.tsx
│   │   └── run-detail.tsx
│   ├── components/
│   │   ├── app-shell.tsx
│   │   ├── require-auth.tsx
│   │   ├── charts.tsx
│   │   ├── run-state-badge.tsx
│   │   ├── run-status-badge.tsx
│   │   ├── confirm-dialogs.tsx
│   │   └── logs-dialog.tsx
│   ├── lib/
│   │   ├── session-storage.ts       ← loadtest-auth-storage.ts
│   │   ├── format.ts                ← loadtest-format.ts
│   │   └── validators.ts            ← password strength (1 nguồn duy nhất)
│   └── types.ts                     ← types/loadtest.ts
├── components/ui/                   ← giữ nguyên (shadcn dùng chung)
├── App.tsx                          ← route /loadtest/* → src/loadtest/*
└── lib/env.ts                       ← routes.loadtest* (giữ)
```

---

## 4. Backend design

### 4.1 Modules & stereotype

| Module | Sterotype | Nội dung |
|--------|-----------|----------|
| `config` | Value object + factory | `Config` bất biến, `loadConfig(overrides)` — KHÔNG global cache (bỏ `config.ts:68`) |
| `domain` | Pure logic | State machine, metrics, report, errors, types |
| `application/use-cases` | Service | Orchestration, không import infra |
| `application/ports` | Interface | Contract cho infra |
| `infrastructure/http` | Driving adapter | Server, router, middleware, controllers, envelope |
| `infrastructure/db` | Driven adapter | Repositories Postgres, migrations, int coercion |
| `infrastructure/workers` | Driven adapter | Worker farm, socket, REST, http client |
| `infrastructure/logging` | Driven adapter | Logger interface + console impl + ring buffer + log sink |
| `main/bootstrap` | Composition root | Duy nhất nối mọi thứ |

### 4.2 DI / ports

- Không dùng framework DI — dùng **constructor injection** (`class RunOrchestrator { constructor(private deps: RunDeps) {} }`).
- Mỗi port 1 interface: `RunRepository`, `MetricRepository`, `PoolRepository`, `LogRepository`, `AdminRepository`, `SessionService`, `AccountProvisioner`.
- Implement Postgres ở `infrastructure/db/repositories/*`; đăng ký tại `main/bootstrap.ts`.
- `DbWriter` hiện tại (`db/writer.ts`) → gộp thành `application/use-cases/run-orchestrator.ts` + 2 adapter `RunRepository`/`MetricRepository`/`LogRepository` (ghi run + batch metric + log).

### 4.3 Error handling chuẩn

- **Typed errors** trong `domain/errors.ts`:

```
AppError extends Error
  ├─ code: ErrorCode        // chuỗi ổn định (VD: 'RUN_NOT_FOUND')
  ├─ statusCode: number     // 400/401/403/404/409/422/503
  ├─ details?: unknown      // errors[]/warnings[] cho validation
```

- **Error code table** (dùng chung backend + frontend):

| ErrorCode | HTTP | Khi nào |
|-----------|------|---------|
| `AUTH_REQUIRED` | 401 | Thiếu token |
| `AUTH_EXPIRED` | 401 | Token hết hạn |
| `INVALID_CREDENTIALS` | 401 | Sai username/email/password (không lộ account tồn tại) |
| `VALIDATION_FAILED` | 400 | `validateRunRequest` fail / body sai |
| `INVALID_JSON` | 400 | Body không parse được (thay `readBody` swallow — api-server.ts:95-105) |
| `USERNAME_TAKEN` / `EMAIL_TAKEN` | 409 | Register trùng unique |
| `RUN_ALREADY_RUNNING` | 409 | `start` khi đang chạy |
| `RUN_NOT_FOUND` | 404 | `/runs/{id}` không tồn tại |
| `REPORT_NOT_FOUND` | 404 | Chưa có report |
| `GATEWAY_NOT_ALLOWED` | 400 | Gateway ngoài allowlist |
| `DB_UNAVAILABLE` | 503 | Store `enabled=false` |
| `INTERNAL` | 500 | Lỗi không xác định |

- **Envelope** (chuẩn PRD):

```json
// success
{ "success": true, "statusCode": 200, "message": "Run started", "data": { ... }, "metadata": { "page": 1, "limit": 10, "total": 100 }, "timestamp": "2026-08-04T10:00:00.000Z" }
// error
{ "success": false, "statusCode": 404, "message": "Run ltxxx không tồn tại", "error": "RUN_NOT_FOUND", "details": null, "timestamp": "2026-08-04T10:00:00.000Z", "path": "/api/loadtest/runs/ltxxx", "traceId": "..." }
```

- `traceId`: sinh mỗi request (randomUUID), in vào log, trả trong error envelope.

### 4.4 Logging chuẩn

- Interface `Logger { info/warn/error(msg, fields?) }` — inject vào mọi class; bỏ global `util.ts:6-49`.
- Implement: `ConsoleLogger` (+ format `[lt][LEVEL][time]`), `RingBufferLogger` (thay `logHistory`), `DbLogSink` (batch insert `log_events` — thay `db/writer.ts:133-136` ghi 1 hàng/1 log).
- **Structured fields**: `{ runId, workerId, phase }` ở mọi log trong run; `log_events` lưu `msg` thuần + `meta_json` (không lệch định dạng như 1.2.22).
- Log level: `error`/`warn` luôn in; `info`/`debug` theo `verbose` flag.

### 4.5 Transaction / retry policy + fix BIGINT

**Fix bug BIGINT (gốc 1.2.1/1.2.2):**

1. **Coerce ở boundary** — helper `infrastructure/db/int.ts`:

```ts
// toEpochMs(x: number | string | null): number | null
//   - number → Math.trunc(x) (ép float thành int — fix 1.2.1)
//   - string  → Number(x) rồi trunc
//   - null    → null
// Áp dụng cho MỌI param đổ vào cột BIGINT: created_at, updated_at, ts,
// start_at, end_at, registered_at, last_login_at, last_used_run_id...
```

2. **Sửa nguồn float**: `db/writer.ts:256` `createdAt: fs.statSync(filePath).mtimeMs` → `createdAt: toEpochMs(fs.statSync(filePath).mtimeMs)`. Tương tự mọi `mtimeMs` đưa vào DB (không chỉ display — `auth-factory.ts:119`).
3. **Retry chỉ cho lỗi transient** — thay `db/store.ts:173-192`:

```
isTransient(code):
  - connection-level: ECONNRESET, ETIMEDOUT, 08001, 08006, 57P01, 57P02, 40001
  - KHÔNG retry: 22P02 (invalid_text_representation = bigint bug), 23505, 23503, 42P01...
  - retry tối đa 2 lần, backoff 100ms/300ms
  - lỗi định thức → log rõ ràng (kèm SQL + param) TRƯỢC khi trả []/throw
```

4. **Không trả `[]` khi lỗi DB** — `query<T>` trả `Result<T>` (kiểu `{ ok: true; rows } | { ok: false; error }`) hoặc throw `AppError('DB_UNAVAILABLE')`; caller quyết định. `countMetricSamples` không được trả 0 khi DB fail (1.2.8).
5. **Bỏ type parser toàn cục** `store.ts:19` — parse int8 tại repository (cột đã biết); hoặc giữ parser nhưng bó trong `pg` config của riêng loadtest (không ảnh hưởng module khác).

**Transaction policy:**

- Run row: `start()` insert `status='running'` (giữ — PRD A1/B3); `finishRun()` finalize + flush ticks còn lại `UPDATE ... WHERE run_id` trong 1 transaction.
- Metric batch: `INSERT ... VALUES (...),(...)` — không cần transaction (1 statement).
- Pool + pool_accounts: `upsertPool` + `insertPoolAccounts` trong 1 transaction (đảm bảo pool không mồ côi account).
- **Single-writer giữ nguyên** (chỉ coordinator ghi — `db/writer.ts:3-5` khớp PRD §2.4); không thêm lock.

---

## 5. API contract đầy đủ

**Prefix**: `/api/loadtest` (giữ nguyên — Vite proxy `vite.config.ts:15-22` đã trỏ). **Versioning**: coi prefix hiện tại là **v1**; thêm header `X-API-Version: 1`; breaking change sau này → `/api/loadtest/v2` (không đổi v1 khi frontend chưa nâng). **Auth**: `Authorization: Bearer <token>` cho mọi route trừ `GET /health`, `POST /auth/register`, `POST /auth/login`.

**Rate-limit** (middleware `rate-limit.ts`):
- `POST /auth/login`, `POST /auth/register`: 10 req/phút/IP (chống brute force).
- `POST /start`, `POST /allowlist`, `POST /cleanup`, `DELETE /runs/{id}`: 30 req/phút.
- GET/polling: không giới hạn (không ảnh hưởng poll 1s).

### 5.1 Public

| Method | Path | Request | Response data | Error |
|--------|------|---------|---------------|-------|
| GET | `/health` | — | `{ status: 'ok' }` | — |
| POST | `/auth/register` | `{ username, email, password }` | `{ id, username, email, displayName, role }` | `VALIDATION_FAILED` 400, `USERNAME_TAKEN`/`EMAIL_TAKEN` 409, `DB_UNAVAILABLE` 503 |
| POST | `/auth/login` | `{ username\|email, password }` | `{ token, expiresAt, user }` | `INVALID_CREDENTIALS` 401, `DB_UNAVAILABLE` 503 |

### 5.2 Auth (protected)

| Method | Path | Request | Response data | Error |
|--------|------|---------|---------------|-------|
| POST | `/auth/logout` | — | `{ loggedOut: true }` | `AUTH_REQUIRED` 401 |
| GET | `/auth/me` | — | `{ id, username, email, displayName, role }` | `AUTH_REQUIRED` 401, `AUTH_EXPIRED` 401 |

### 5.3 Run control (protected)

| Method | Path | Request | Response data | Error |
|--------|------|---------|---------------|-------|
| GET | `/config` | — | `{ port, allowlist, allowlistFromFile, gatewayUrl, maxTarget, maxDurationMin, maxRegisterRamp, presets, hasOtpSecret, hasRedisConfigured, reportsDir }` | `AUTH_REQUIRED` 401 |
| POST | `/start` | `StartRunRequest` (types.ts:52-60) | `{ runId, config, warnings, estimate: { workers, ramGB, seatMin } }` | `VALIDATION_FAILED` 400, `GATEWAY_NOT_ALLOWED` 400, `RUN_ALREADY_RUNNING` 409, `DB_UNAVAILABLE` 503 |
| POST | `/stop` | `{}` hoặc `{ force: false }` | `{ stopped: true, force: false }` | `AUTH_REQUIRED` 401, `VALIDATION_FAILED` 400 |
| POST | `/kill` | `{ force: true }` | `{ stopped: true, force: true }` | `AUTH_REQUIRED` 401 |
| POST | `/pause` | — | `{ paused: true }` | `AUTH_REQUIRED` 401 |
| POST | `/resume` | — | `{ resumed: true }` | `AUTH_REQUIRED` 401 |

### 5.4 Live (protected — polling 1s)

| Method | Path | Request | Response data | Error |
|--------|------|---------|---------------|-------|
| GET | `/status` | — | `{ runId, phase, startAt, config, lastTick, stopReason, elapsedSec, isRunning }` | `AUTH_REQUIRED` 401 |
| GET | `/metrics` | `since?` (ts ms), `limit?` (≤7200, mặc định 3600) | `{ ticks: LoadTestTick[], runId }` | `AUTH_REQUIRED` 401 |
| GET | `/users` | `offset?`, `limit?` (≤500), `filter?` | `{ rows, total, offset, limit }` | `AUTH_REQUIRED` 401 |
| GET | `/errors` | — | `{ top: [{code,count}], samples: ErrorSample[] }` | `AUTH_REQUIRED` 401 |
| GET | `/logs` | `limit?` (≤500) | `{ logs: [{ts,level,msg}] }` | `AUTH_REQUIRED` 401 |
| GET | `/report` | — | `RunReport` | `REPORT_NOT_FOUND` 404 |
| GET | `/report/export` | `format=json\|md\|csv` | file (Content-Disposition) | `REPORT_NOT_FOUND` 404, `VALIDATION_FAILED` 400 |

### 5.5 History (protected — từ DB)

| Method | Path | Request | Response data | Error |
|--------|------|---------|---------------|-------|
| GET | `/runs` | `status?`, `limit?` (≤2000, mặc định 500) | `metadata: { total }`, `data: { runs: RunSummary[] }` | `AUTH_REQUIRED` 401 |
| GET | `/runs/{id}` | — | `RunDetail` (config + report tái dựng từ JSON) | `RUN_NOT_FOUND` 404 |
| GET | `/runs/{id}/metrics` | `limit?` (≤20000), `offset?` | `metadata: { total }`, `data: { runId, ticks }` | `RUN_NOT_FOUND` 404 |
| GET | `/runs/{id}/logs` | `limit?` (≤500), `offset?`, `level?` | `metadata: { total }`, `data: { runId, logs }` | `RUN_NOT_FOUND` 404 |
| DELETE | `/runs/{id}` | — | `{ deleted: true, runId }` | `RUN_NOT_FOUND` 404 |

### 5.6 Pool / settings (protected)

| Method | Path | Request | Response data | Error |
|--------|------|---------|---------------|-------|
| GET | `/allowlist` | — | `{ allowlist, fromFile }` | `AUTH_REQUIRED` 401 |
| POST | `/allowlist` | `{ urls: string[] }` | `{ allowlist }` | `VALIDATION_FAILED` 400 |
| GET | `/pools` | — | `{ pools: PoolSummary[] }` (DB trước, file fallback) | `AUTH_REQUIRED` 401 |
| POST | `/cleanup` | `{ runId, dryRun }` | `CleanupResult` | `VALIDATION_FAILED` 400 |

**Lưu ý chuyển đổi**: `/pools` hiện fallback file (`api-server.ts:312-333`) — target: DB là nguồn chính, file chỉ là "importedFromFile" dấu vết; bỏ fallback khi migration pool JSON hoàn tất (Phase 5).

---

## 6. DB schema + migration

### 6.1 Chốt lại drift: **Postgres** (không SQLite)

PRD ghi SQLite (`PRD-loadtest-run-database.md:23, 66-77`) nhưng code đã triển khai Postgres (`db/store.ts:13` `pg`; `db/schema.sql` DDL Postgres; `loadtest/.env.example` `LOADTEST_DATABASE_URL=postgresql://...`; `package.json` có `pg`/`@types/pg`). **Quyết định đề xuất: giữ Postgres** — code đã chạy, connect string lẫn instance `postgres-loadtest` (port 5439) đã có, đúng hướng cluster v1.1. Cập nhật lại PRD cho khớp.

### 6.2 Schema v2 (thay đổi so với v1 — `db/schema.sql`)

| Thay đổi | Lý do | Migration |
|----------|-------|-----------|
| `schema_version` → đổi thành `migrations` (version, name, applied_at) | Chạy migration có tên, không chỉ số | `002_add_migrations.sql` |
| Thêm `CHECK (created_at = floor(created_at))` trên mọi cột BIGINT epoch (admin_users, runs, pools, pool_accounts, metric_samples, log_events) | Chặn float insert ở tầng DB (fix 1.2.1) | `003_checks.sql` |
| `metric_samples` thêm index `(run_id, ts)` đã có — thêm index riêng `(ts)` nếu cần retention xóa | Query retention theo ts | `004_metric_index.sql` |
| `log_events` thêm cột `meta_json TEXT NOT NULL DEFAULT '{}'` | Structured log fields (4.4) | `005_log_meta.sql` |
| `admin_users` thêm `CHECK (char_length(username) >= 3)`, `CHECK (role IN ('admin','viewer'))` | Ràng buộc dữ liệu | `006_admin_constraints.sql` |
| `runs` thêm `CHECK (status IN ('running','finished','stopped','error'))` | Status không lệch | `007_run_status_check.sql` |
| `pool_accounts` thêm `CHECK (status IN ('registered','logged_in','failed'))` | Status không lệch | `008_pool_status_check.sql` |
| *(tùy chọn)* bảng `sessions` (id, user_id, token_hash, created_at, expires_at, revoked_at) | Rotation/revoke session (v1.1 nếu cần) | `009_sessions.sql` |

### 6.3 Migration strategy

- Thay cơ chế hiện tại (`db/init.ts:97` chỉ `INSERT INTO schema_version (version) VALUES (1)` + `db/store.ts:160-169` `ensureSchema` chạy toàn bộ schema.sql idempotent) bằng runner:
  - `db/migrations/001_base.sql` = schema v1 hiện tại (đổi tên từ `db/schema.sql`).
  - `db/migrations/002_*.sql` ... đánh số tăng dần.
  - `runMigrations(pool)`: đọc bảng `migrations`, chạy các file chưa áp dụng, **mỗi file trong 1 transaction**, ghi `applied_at`.
  - Idempotent: chạy lại không áp dụng lại file đã chạy.
- `db/init.ts` giữ vai trò CLI (init + seed + verify) nhưng gọi `runMigrations`.
- `db/store.ts:160-169` `ensureSchema` → bỏ, thay bằng `runMigrations` ở startup.

### 6.4 Constraints & indexes

- GIỮ index hiện có: `idx_runs_status`, `idx_runs_start_at`, `idx_pools_gateway`, `idx_pool_accounts_pool`, `idx_pool_accounts_status`, `idx_metric_samples_run`, `idx_log_events_run` (`db/schema.sql:57-58,76,97-98,136,146`).
- THÊM: `idx_metric_samples_ts` (retention), `idx_log_events_ts` (sort by ts).
- FK `ON DELETE CASCADE` đã có (`db/schema.sql:82,106,143`) — giữ.

### 6.5 Seed

- `db/init.ts --seed-admin` giữ nguyên (scrypt, in password 1 lần, idempotent — `db/init.ts:103-123`).
- Chuyển `hashPassword`/`verifyPassword` (`db/password.ts`) sang `infrastructure/db/password.ts` (giữ logic scrypt + timingSafeEqual).

---

## 7. Auth & session

### 7.1 Flow

```
POST /auth/register { username, email, password }
  → validate (password strength — db/password.ts:46-58)
  → hash scrypt (db/password.ts:14-18)
  → INSERT admin_users (unique username/email) → 409 nếu trùng
  → 200 { id, username, email, displayName, role }

POST /auth/login { username|email, password }
  → findAdminByLogin → verifyPassword (timingSafeEqual)
  → createSessionToken({ sub, username }) → HMAC-SHA256
  → 200 { token, expiresAt, user }

SPA mount → RequireLoadtestAuth → GET /auth/me (verify token ≤1ms, không DB)
  → redirect /loadtest/login nếu 401

POST /auth/logout → 200 { loggedOut: true } (client xóa session)
```

### 7.2 Token format

- Giữ HMAC-SHA256 stateless (`auth.ts:33-67`), payload `{ sub, username, exp }`, format `base64url(payload).base64url(hmac)`.
- **Thêm prefix `v1.`** vào token: `v1.<payload>.<hmac>` — cho phép đổi thuật toán/version sau này mà không phá token cũ.
- **Secret**: env `LOADTEST_AUTH_SECRET` → file `dataDir/auth-secret.json` (giữ `auth.ts:73-88`).
- **Expiry**: TTL 12h (`auth.ts:15`), không refresh token (MVP). **Rotation (v1.1)**: nếu `exp` sắp hết (< 2h), frontend gọi `/auth/me` trả token mới (hoặc thêm `POST /auth/refresh`).

### 7.3 Storage & guard

- **Storage**: giữ localStorage cho MVP (đã có `loadtest-auth-storage.ts:16-46`) — chấp nhận rủi ro XSS cho tool dev local; **khoanh vùng**: key `loadtest.auth`, không bao giờ đọc lưu token khác; document rủi ro ở README. Phương án HttpOnly cookie (an toàn hơn) đưa vào câu hỏi chốt (mục 11).
- **Guard server**: middleware `requireAuth` (verify HMAC, không decode, không DB lookup — `auth.ts:46-67`); `requireRole('admin')` cho các route control/delete (reserve viewer role).
- **Guard client**: `RequireLoadtestAuth` (`require-auth.tsx:12-33`) giữ nguyên; 401 interceptor → `clearSession` → redirect login (`loadtest-api.ts:62-70`, `loadtest-auth.store.ts:93-96`).
- **401 handling nhất quán**: mọi 401 trả `{ success:false, statusCode:401, error:'AUTH_EXPIRED'|'AUTH_REQUIRED'|'INVALID_CREDENTIALS', message }`.

---

## 8. Frontend design

### 8.1 Pages & routes

| Route | Page | Nguồn dữ liệu |
|-------|------|---------------|
| `/loadtest/login` | LoginPage | `auth.store.login` |
| `/loadtest/register` | RegisterPage | `auth.store.register` |
| `/loadtest` | ControlPanelPage | `live.store` + `run.startRun` |
| `/loadtest/live` | LiveDashboardPage | `live.store` (poll 1s) |
| `/loadtest/scenario` | ScenarioBuilderPage | `prefs.store`, `live.store.profile` |
| `/loadtest/report` | ReportPage | `history.getReport` (live) |
| `/loadtest/settings` | SettingsPage | `pool.allowlist`, `config` |
| `/loadtest/cleanup` | CleanupPage | `pool.cleanup` |
| `/loadtest/history` | HistoryPage | `history.listRuns` (phân trang) |
| `/loadtest/history/:runId` | RunDetailPage | `history.getRun` + metrics + logs |

### 8.2 State (zustand)

- **`auth.store`** — `{ user, token, expiresAt, isAuthenticated, authReady, initialize, login, register, logout, clearSession }` (giữ `loadtest-auth.store.ts`).
- **`live.store`** — chỉ dữ liệu LIVE: `{ config, phase, runId, elapsedSec, lastTick, ticks, pollStatus, profile, startRun, stopRun, pauseRun, resumeRun, pollOnce, resetRun }`. Tách `prefs` (`requireEnvConfirm`) sang `prefs.store` (fix 1.2.19).
- **Polling** giữ 1s (`loadtest.store.ts:165-192`) nhưng:
  - `pollOnce` dùng `lastTick.ts` đã có (đã tối ưu).
  - Dừng poll khi `TERMINAL_PHASES` (đã có — `loadtest.store.ts:168`).
  - **Không subscribe toàn store** — giữ selector slice (đã có comment `CẤM subscribe s => s` — `loadtest.store.ts:7`).

### 8.3 Data-fetching (query pattern)

- Thêm `useLoadtestQuery<T>(fn, deps)` — wrapper generic trả `{ data, error, loading, refetch }`; thay thế pattern `useState`+`useEffect` rải rác ở `HistoryPage.tsx:38-53` và `RunDetailPage.tsx:56-80`.
- **Phân trang**:
  - `HistoryPage`: `GET /runs?limit=50&offset=N` + pagination (không tải toàn bộ — fix 1.2.20).
  - `RunDetailPage`: metrics `limit=3600` + "load more"; logs `limit=200` + filter level (đã có filter — `RunDetailPage.tsx:82-85`); thêm phân trang thay vì tải hết.
- **Error/loading/empty states**: chuẩn hóa 3 trạng thái mỗi trang (đã có skeleton/banner/empty ở `HistoryPage.tsx:123-137`); dùng `AlertBanner` cho error (đã có).

### 8.4 Routing & auth guard

- Giữ `App.tsx:56-70`: `/loadtest/login`, `/loadtest/register` public; `/loadtest/*` qua `RequireLoadtestAuth`.
- `RequireLoadtestAuth` giữ: `initialize()` → `authReady` spinner → redirect login kèm `state.from` (`require-auth.tsx:22-31`).
- Chuyển route import sang `src/loadtest/pages/*` (đổi import path, không đổi contract).

### 8.5 Responsive

- Giữ `AppShell` hiện tại: `DesktopTopNav` (≥lg) + `MobileBottomNav` (<lg) + `RunStickyHeader` (`app-shell.tsx:29-109, 113-165, 169-223`).
- Bỏ duplicate logout handler (`app-shell.tsx:176-179` DesktopTopNav vs `255-258` AppShell) — dùng 1 hook `useLoadtestLogout` chung.

### 8.6 Components

- `charts.tsx` (Recharts) giữ nguyên; `chart-card.tsx`, `run-state-badge.tsx`, `run-status-badge.tsx`, `confirm-dialogs.tsx`, `logs-dialog.tsx` giữ nguyên.
- `RegisterPage` bỏ `validatePasswordStrength` local (`RegisterPage.tsx:15-24`) → import từ `src/loadtest/lib/validators.ts` (fix 1.2.21).

---

## 9. Clean code conventions

### 9.1 Naming

| Quy tắc | Áp dụng |
|---------|---------|
| File repository impl: `{entity}.postgres.ts` (hoặc `{entity}.repository.adapter.ts`) | `infrastructure/db/repositories/` |
| File controller: `{resource}.controller.ts` | `infrastructure/http/controllers/` |
| Use-case: `start-run.ts` → `startRunUseCase` | `application/use-cases/` |
| Port: `interface IRunRepository` / `RunRepository` | `application/ports/` |
| Hằng số UPPER_SNAKE, enum PascalCase, type PascalCase | toàn dự án |
| Không đặt tên `*Helper`/`*Util` trừ khi thực sự là pure helper | — |

### 9.2 File structure

- **1 file = 1 trách nhiệm**; file > 300 dòng → tách (hiện `coordinator.ts` 537, `socket-farm.ts` 694, `api-server.ts` 532 — tách ở Phase 2).
- Import theo thứ tự: stdlib → external → domain → application → infrastructure → shared.
- **Không export toàn bộ từ index** vô tội vạ — chỉ export public API của module.

### 9.3 Type safety

- `strict: true` trong tsconfig (kiểm tra `loadtest/tsconfig.json` hiện tại — kế thừa `../tsconfig.json`).
- **Không dùng `any`**; dùng `unknown` + type guard (đã có pattern ở `api-server.ts:494-500` `parse`).
- **Boundary type-safe**: mọi giá trị qua DB → `toEpochMs`/`toInt64` (+ `as const`/branded type `EpochMs = number` tùy chọn).
- **Không dùng `as` bừa bãi** — dùng `satisfies`/type guard.
- Validate body JSON bằng type guard (thay `readBody` trả `{}` — api-server.ts:95-105).

### 9.4 Test strategy

| Tầng | Công cụ | Bao phủ |
|------|---------|---------|
| Unit (domain) | vitest (đã có `vitest.config.ts`) | `run-phase`, `aggregate`, `metrics`, `report`, `http.envelope` |
| Unit (int coercion) | vitest | `int.ts` (float→int), retry classification |
| Integration (repo) | vitest + pg test (instance 5439 hoặc testcontainers) | `run.postgres`, `metric.postgres`, `pool.postgres`, migrations runner |
| Integration (API) | vitest + `http.createServer` trên port 0 (đã có pattern `api-server.test.ts`) | Mọi route: auth flow, envelope, error codes, rate-limit |
| Frontend (vitest + testing-library) | vitest + jsdom | `validators`, `format`, `session-storage`, `auth.store` (mocks), 1-2 page smoke |
| E2E (tùy chọn v1.1) | Playwright | login → start → live → history |

- Giữ các test hiện có: `__tests__/api-server.test.ts`, `auth.test.ts`, `config.test.ts`, `coordinator-state.test.ts`, `metrics.test.ts`, `report.test.ts`, `socket-farm.test.ts`, `store.test.ts`.
- Scripts: `npm run loadtest:test`, `loadtest:typecheck` (giữ `package.json:10-14`); thêm `loadtest:lint` (eslint) + `loadtest:format` (prettier).

### 9.5 Lint / format

- Thêm `eslint` + `prettier` cho `loadtest/` (cấu hình riêng, không đụng chat-app).
- Pre-commit: `typecheck` + `test` chạy được.

---

## 10. Kế hoạch refactor theo phases

Mỗi phase độc lập shippable, không breaking liên tục; gate mỗi phase: `npm run loadtest:typecheck` + `npm run loadtest:test` xanh + chạy thủ công 1 run ngắn.

### Phase 0 — Fix bug BIGINT ngay (small, safe, 1-2 ngày)

**Mục tiêu**: dừng ngay log spam `invalid input syntax for type bigint`; không đổi hành vi khác.

| File | Đổi |
|------|-----|
| `loadtest/db/writer.ts:256` | `createdAt: fs.statSync(filePath).mtimeMs` → `toEpochMs(...)` |
| `loadtest/db/store.ts:173-192` | Retry chỉ lỗi transient; fail nhanh + log rõ cho lỗi định thức (22P02...) |
| `loadtest/db/store.ts:19` | Bỏ/replace type parser int8 toàn cục bằng parse tại repository |
| `loadtest/db/int.ts` (mới) | `toEpochMs`/`toInt64` helper |
| `loadtest/__tests__/store.test.ts` | Thêm case: float → coerced; lỗi 22P02 không retry |

**Test thủ công**: chạy `importLegacyPools` với file `accounts-*.json` cũ → pool import thành công, không log spam.

### Phase 1 — Cấu trúc thư mục + config/logger (không đổi hành vi)

**Mục tiêu**: có cấu trúc target (mục 3.1), bỏ global singleton, inject logger.

| File cũ | File mới |
|---------|----------|
| `loadtest/server.ts` | `loadtest/src/main/bootstrap.ts` |
| `loadtest/worker.ts` | `loadtest/src/main/worker-entry.ts` |
| `loadtest/config.ts` | `loadtest/src/config/{index,env,schema,run-request}.ts` |
| `loadtest/util.ts` | `loadtest/src/shared/{time,url,random,text}.ts` + `loadtest/src/infrastructure/logging/logger.ts` |
| `loadtest/types.ts` | `loadtest/src/domain/types.ts` |
| `loadtest/coordinator-state.ts` | `loadtest/src/domain/{run-phase,aggregate}.ts` |
| `loadtest/metrics.ts` | `loadtest/src/domain/metrics.ts` |
| `loadtest/report.ts` | `loadtest/src/domain/report.ts` |
| `loadtest/db/password.ts` | `loadtest/src/infrastructure/db/password.ts` |
| `package.json` scripts | `loadtest:server` → `tsx loadtest/src/main/bootstrap.ts` |

- `getEnv` bỏ cache (`config.ts:68`) → `loadConfig(overrides)` tạo instance mới.
- Logger: interface + `createLogger()`; cập nhật gọi `ltLog` → `logger`.

### Phase 2 — Ports & adapters + tách god classes

**Mục tiêu**: tách `api-server.ts`, `coordinator.ts`, `socket-farm.ts`; mọi persistence qua port. Đây là phase lớn nhất — chia thành sub-phases riêng shippable.

**2a. Http layer**:
| File cũ | File mới |
|---------|----------|
| `loadtest/api-server.ts` | `loadtest/src/infrastructure/http/{server,router,response}.ts` + `middleware/{auth,body}.ts` + `controllers/*.ts` |

**2b. Repository ports**:
| Port (mới) | Implement | Thay cho |
|-----------|-----------|----------|
| `IRunRepository` | `run.postgres.ts` | `store.ts:244-310` |
| `IMetricRepository` | `metric.postgres.ts` | `store.ts:314-358` |
| `IPoolRepository` | `pool.postgres.ts` | `store.ts:384-436, 440-508` |
| `ILogRepository` | `log.postgres.ts` | `store.ts:362-380`, `writer.ts:133-136` |
| `IAdminRepository` | `admin.postgres.ts` | `store.ts:196-241` |
| `ISessionService` | `hmac-token.ts` | `auth.ts` |
| `IAccountProvisioner` | `provisioner.ts` | `auth-factory.ts:159-351` |

**2c. Orchestration**:
| File cũ | File mới |
|---------|----------|
| `loadtest/coordinator.ts` | `loadtest/src/application/use-cases/run-orchestrator.ts` + `domain/` (giữ logic) |
| `loadtest/db/writer.ts` | gộp vào orchestration + `ILogRepository`/`IMetricRepository` |
| `loadtest/auth-factory.ts` | `loadtest/src/infrastructure/redis/redis.ts` + `application/ports/account-provisioner.ts` + `infrastructure/workers/provisioner.ts` |

- Sau phase này: `application/` không import `infrastructure/`; `api-server` không gọi thẳng `store`/`coordinator`.
- **Hành vi giữ nguyên 100%** — chỉ di chuyển + inject.

### Phase 3 — API contract chuẩn + error handling + versioning

**Mục tiêu**: envelope chuẩn, error code, rate-limit, body validation, versioning.

| File | Đổi |
|------|-----|
| `domain/errors.ts` (mới) | `AppError` + `ErrorCode` + map |
| `http/response.ts` | `ok()`/`fail()` → envelope `{ success, statusCode, message, data, metadata, timestamp }`; error thêm `error`, `traceId`, `path` |
| `http/middleware/body.ts` | `readBody` → 400 `INVALID_JSON` + size limit (fix 1.2.9) |
| `http/middleware/rate-limit.ts` (mới) | Tuần tự auth/start/allowlist/cleanup/delete (mục 5) |
| `http/middleware/error.ts` (mới) | Global error handler: `AppError` → statusCode; unknown → 500 `INTERNAL` |
| `http/router.ts` | Versioning: header `X-API-Version`; chuẩn bị path `/api/loadtest/v2` |
| `frontend src/loadtest/api/*` | `unwrap` → đọc envelope chuẩn; thêm `toApiError` đọc `error` code |

- **Frontend đổi song song** (cùng release) để không phá dashboard.

### Phase 4 — Frontend refactor (feature folder)

**Mục tiêu**: `src/loadtest/` feature folder, chia api/stores, query pattern, phân trang, bỏ duplicate.

| File cũ | File mới |
|---------|----------|
| `src/lib/loadtest-api.ts` | `src/loadtest/api/{client,auth,run,history,pool}.ts` |
| `src/lib/loadtest-auth-storage.ts` | `src/loadtest/lib/session-storage.ts` |
| `src/lib/loadtest-format.ts` | `src/loadtest/lib/format.ts` |
| `src/store/loadtest-auth.store.ts` | `src/loadtest/stores/auth.store.ts` |
| `src/store/loadtest.store.ts` | `src/loadtest/stores/{live,prefs}.store.ts` |
| `src/types/loadtest.ts` | `src/loadtest/types.ts` |
| `src/pages/loadtest/*` | `src/loadtest/pages/*` |
| `src/components/loadtest/*` | `src/loadtest/components/*` |
| `src/App.tsx:56-70` | import path mới (route giữ nguyên) |

- `HistoryPage`/`RunDetailPage`: `useLoadtestQuery` + phân trang (fix 1.2.20).
- `RegisterPage`: bỏ duplicate validator → `src/loadtest/lib/validators.ts` (fix 1.2.21).
- `AppShell`: gộp logout handler (8.5).

### Phase 5 — Hardening + DB migration + tests

**Mục tiêu**: dead code, logging batch, migration runner, CORS, stress item.

| File | Đổi |
|------|-----|
| `db/migrations/*` | Runner + 001..009 (mục 6.3); `db/init.ts` gọi runner; `store.ts:160-169` bỏ `ensureSchema` |
| `infrastructure/logging/log-sink.ts` | Batch insert `log_events` (thay 1 row/1 log) |
| `worker-farm.ts:138-149` | Xóa `checkHeartbeats` (dead) hoặc nối vào heartbeat timer |
| `socket-farm.ts:663-665` | Xóa `final-tick` (không ai xử lý) hoặc định nghĩa+handle trong `WorkerMessage` (types.ts:230-236) |
| `config.ts:219-225` | `newRunId` → thêm `machineId`/epoch ms đầy đủ (tránh collision) |
| `http/server.ts` | CORS: `*` → `http://localhost:5173` (dev) hoặc cấu hình env (fix 1.2.18) |
| `db/writer.ts:19-20` | Flush interval/limit → env `LOADTEST_FLUSH_INTERVAL_MS`/`LOADTEST_FLUSH_MAX_TICKS`; flush trước khi SIGTERM |
| `__tests__/*` | Thêm integration (repo, migration, rate-limit) + frontend tests (mục 9.4) |

### Tổng kết phase

| Phase | Độ rủi ro | Shippable | Gate |
|-------|-----------|-----------|------|
| 0 | Thấp | Bug fix đơn lẻ | typecheck + test + run ngắn |
| 1 | Thấp | Cấu trúc + config/logger | typecheck + test + run ngắn |
| 2 | Trung bình | Ports/adapters + tách god class | typecheck + test + run ngắn + appshell thủ công |
| 3 | Trung bình | API contract + error + rate-limit | typecheck + test + dashboard thủ công |
| 4 | Thấp | Frontend feature folder | typecheck + build + smoke toàn trang |
| 5 | Trung bình | Hardening + migration + tests | typecheck + test + backup DB trước khi migrate |

---

## 11. Rủi ro & quyết định cần user chốt (tối đa 5)

1. **DB thật là gì?** — PRD ghi SQLite, code đã dùng Postgres (`db/store.ts:13`, `schema.sql`, `.env.example`). **Đề xuất: giữ Postgres** (đã chạy, connect 5439 sẵn, đúng hướng cluster v1.1). Chốt?
2. **Frontend giữ trong `src/loadtest/` hay tách `loadtest-ui/` riêng?** — Đề xuất: giữ trong `src/loadtest/` (dùng chung shadcn/ui + vite proxy, mục 3.2), tách khi deploy độc lập. Chốt?
3. **Session token lưu localStorage (Bearer) hay HttpOnly cookie?** — Đề xuất: giữ localStorage cho MVP (đúng code hiện tại), document rủi ro XSS; cookie khi cần an toàn hơn. Chốt?
4. **Versioning URL** — Đề xuất: coi `/api/loadtest` là v1, breaking change sau → `/api/loadtest/v2` (không đổi path hiện tại để khỏi phá Vite proxy). Chốt?
5. **Mức độ phá vỡ khi refactor** — Cho phép đổi entry point (`loadtest/server.ts` → `loadtest/src/main/bootstrap.ts`) kèm cập nhật `package.json`/`.env.example`, hay bắt buộc giữ file gốc làm shim? Đề xuất: đổi thẳng + cập nhật script, không giữ shim.

---

## Phụ lục — Bản đồ hiện trạng tham chiếu (file:dòng)

- `loadtest/server.ts:26-39` — bootstrap thủ công, không DI
- `loadtest/coordinator.ts:23,32,105-127,152-202,215-254,265-298,302-407,454-505` — god class + ring buffer 3600 + auto-stop + finishRun
- `loadtest/api-server.ts:75-93,95-105,112-124,128-382,386-439,444-531` — CORS `*`, envelope không chuẩn, routing chuỗi, auth inline, mapping
- `loadtest/auth.ts:15,33-67,73-88` — TTL 12h, HMAC, secret load
- `loadtest/auth-factory.ts:70-88,105-126,133-150,159-351,353-364,378-384` — OTP seed, listPools file, limiter, provision, persistPool JSON
- `loadtest/config.ts:45-66,68,70-115,126-248,257-278` — dotenv, singleton cache, validate, presets, runId, settings
- `loadtest/db/store.ts:19,126-192,196-508` — parser int8, retry blind, toàn bộ CRUD
- `loadtest/db/writer.ts:19-20,38-49,63-117,133-136,146-209,213-279,256,284-313` — flush 30s, import legacy (nguồn float), single-writer
- `loadtest/db/schema.sql:16-148` — 7 bảng + index (postgres, không phải SQLite như PRD)
- `loadtest/db/init.ts:86-129` — init + seed + verify
- `loadtest/util.ts:6-49` — logger global + ring buffer 500
- `loadtest/worker-farm.ts:138-149` — checkHeartbeats dead code
- `loadtest/socket-farm.ts:663-665` — final-tick không ai xử lý
- `loadtest/coordinator-state.ts:19-40,88-194` — state machine + aggregate (pure — model tốt)
- `src/App.tsx:56-70` — route /loadtest gate
- `src/lib/loadtest-api.ts:27-77,79-195` — axios client + interceptor + unwrap + 21 method
- `src/lib/loadtest-auth-storage.ts:16-46` — localStorage session
- `src/store/loadtest-auth.store.ts:34-55,93-96` — initialize + 401 clear
- `src/store/loadtest.store.ts:165-192` — poll 1s
- `src/pages/loadtest/RunDetailPage.tsx:56-80` — fetch không phân trang
- `src/pages/loadtest/RegisterPage.tsx:15-24` — duplicate password validator
- `src/components/loadtest/require-auth.tsx:12-33` — guard SPA
- `src/components/loadtest/app-shell.tsx:29-109,176-179,227-286` — sticky header + nav + logout
- `vite.config.ts:15-22` — proxy /api/loadtest → 3401
- `package.json:10-14` — scripts loadtest