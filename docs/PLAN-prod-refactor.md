# PLAN — Refactor production-readiness: chat-app + loadtest tool

**Status**: ✅ KẾ HOẠCH — GATE 1 (2026-08-04, user duyệt)
**Author**: Senior Project Manager (autobuild refactor)
**Repo**: `C:\MAYogu_VIASG\chat-app`
**Nguồn chuẩn**: `docs/PRD-prod-refactor.md` (đã APPROVED — GATE 1). Plan này không mâu thuẫn với PRD, kế thừa toàn bộ IN SCOPE / OUT OF SCOPE / NFR / DoD.
**Tài liệu liên quan**: `docs/ARCHITECTURE-loadtest.md`, `docs/API-loadtest-tool.md`, `docs/PRD-loadtest-run-database.md`, `docs/PRD-loadtest-admin-auth.md`.

---

## 0. Quyết định đã chốt (GATE 1 — bắt buộc tuân thủ)

| # | Quyết định | Chốt | Hệ quả trong plan |
|---|---|---|---|
| Q-1 | Secrets: rotate + xoá khỏi working tree (repo **chưa** push remote, **không** rewrite history) | ✅ | T-01 là task ĐẦU TIÊN, phải xong trước mọi commit; thêm gitleaks (T-02) để chặn tái diễn. |
| Q-2 | DB **LUÔN bắt buộc** — `LOADTEST_DB_REQUIRED` mặc định `true`, server **fail-fast** khi DB không lên | ✅ (stricter hơn PRD) | T-03 + T-05 chuyển `connect()` fail từ `disabled=true` im lặng → throw + exit code ≠ 0. Đặt lại `db/init.ts` + `config.ts` default. |
| Q-3 | Migration runner **tự viết zero-dep** (không node-pg-migrate) | ✅ | T-04 ~150 dòng `migrate.ts`, giữ tinh thần plain-TS module của `loadtest/`. |
| Q-4 | Token giữ **localStorage** (chat + loadtest) + **CSP** + document threat model | ✅ | T-08 (CSP) + T-12 (`docs/THREAT-MODEL.md`). |
| Q-5 | CI = **GitHub Actions** `.github/workflows/ci.yml`, matrix `ubuntu-latest` + `windows-latest`, có gitleaks | ✅ | T-10. |

> Nguyên tắc xuyên suốt: **giữ nguyên hành vi quan sát được** — không đổi contract gateway, không đổi UI dashboard, không thêm tính năng mới. Mọi thay đổi "CẦN THÊM" theo PRD §3 đều được map vào task (xem Phụ lục A).

---

## 1. Quy ước chung

### 1.1 Định dạng task
- **id**: `T-01` … `T-12` (nhiều PRD-item gộp chung 1 task vì cùng file/ban đầu).
- **title / mô tả**: cấu trúc "**Thay gì → Làm gì → Giữ gì**".
- **file:line**: dẫn chứng từ code hiện tại (đã verify — khớp PRD §3).
- **acceptance criteria**: testable, từ PRD §4 (US-*) hoặc §8 (G1–G10).
- **dependencies**: task phải xong trước.
- **producer role**: ai code (executor).
- **reviewers**: ≥ 3 lens riêng biệt (correctness / security / perf / domain) từ autobuild team.
- **effort**: S (≤ 0.5 ngày) / M (1–2 ngày) / L (2–4 ngày).

### 1.2 Role map (autobuild team)
| Vai trò | Producer | Reviewer lens |
|---|---|---|
| **Backend Architect** | executor T-03, T-04, T-05, T-06 | — |
| **Realtime Collaboration Engineer** | executor T-07 | domain lens (socket/runtime) |
| **Frontend Developer** | executor T-08, T-09 | — |
| **DevSecOps** | executor T-01, T-02, T-10 | — |
| **Test Automation Engineer** | executor T-11 (producer) | lens: test coverage |
| **Tech Writer** | executor T-12 | — |
| **Code Reviewer** | — | correctness lens |
| **Application Security Engineer (AppSec)** | — | security lens |
| **Security Architect** | — | security architecture lens |
| **Performance Benchmarker** | — | perf lens |
| **Reality Checker** | — | evidence validation lens (mặc định "NEEDS WORK") |
| **API Tester** | — | contract/API lens |

### 1.3 Tinh thần zero-dep
- `loadtest/` runtime **không thêm dependency mới** (gitleaks, eslint, stryker, husky là **dev tooling** — nằm trong `devDependencies`, không dính vào runtime import).
- Migration runner dùng `pg` có sẵn + `node:fs`/`node:path` — không framework mới.

---

## 2. Phân rã task (chi tiết)

### 🔴 WAVE 0 — Bảo mật & vệ sinh repo (critical path — LÀM TRƯỚC MỌI COMMIT)

#### T-01 — Xoá secret + rotate + harden `.gitignore` (SEC-1, SEC-8, US-SEC-1, US-SEC-2)
- **Mô tả**
  - **Thay**: `.gitignore` hiện chỉ chặn `.env`, `.env.*` (`.gitignore:11-14`) → secret thật trong `loadtest/data/` đang untracked, commit tiếp theo sẽ đưa vào history.
  - **Làm**: (1) copy secret hiện tại ra ngoài repo (vd `%USERPROFILE%\.mayogu-secrets\` — git-ignored tự nhiên vì ngoài repo) để còn lấy nếu cần; (2) **rotate** `LOADTEST_AUTH_SECRET`, `LOADTEST_OTP_SECRET`, DB password trong `loadtest/.env` (giá trị mới, không trùng giá trị đã lộ; DB password mới phải áp dụng lên instance Postgres trước khi đổi .env); (3) xoá `loadtest/data/auth-secret.json`, `loadtest/data/accounts-*.json`, `loadtest/data/settings.json` khỏi working tree; (4) bổ sung `.gitignore` pattern **explicit** (không wildcard mù): `loadtest/data/*`, `!loadtest/data/.gitkeep`, `loadtest/settings.json`, `*.tsbuildinfo`; (5) thêm `loadtest/data/.gitkeep`.
  - **Giữ**: `loadtest/.env` (đã gitignore qua pattern `.env`) — chỉ đổi giá trị bên trong; cơ chế `loadAuthSecret` (env → file → random) trong `auth.ts:73-89`.
- **file:line**: `.gitignore:11-14`; `loadtest/data/auth-secret.json`; `loadtest/data/accounts-ltd4r7sz01.json`; `loadtest/auth.ts:73-89`; `loadtest/config.ts:104`; `loadtest/db/init.ts:27`.
- **Acceptance criteria** (US-SEC-1, US-SEC-2, G-5):
  - `git check-ignore` trả "ignored" cho `loadtest/data/auth-secret.json`, `loadtest/data/accounts-*.json`, `loadtest/data/settings.json`, `loadtest/.env` — với pattern cụ thể.
  - `git status` không liệt kê file nào trong `loadtest/data/`.
  - Secret mới ≠ secret cũ (đã rotate); README ghi nơi lưu secret + cách set.
- **Dependencies**: — (FIRST).
- **Producer**: DevSecOps.
- **Reviewers**: Security Architect (security), Senior SecOps Engineer (domain), Code Reviewer (correctness), Reality Checker (evidence).
- **Effort**: S

#### T-02 — Secret-scan gitleaks + pre-commit hook (T-5, G-5)
- **Mô tả**
  - **Thay**: không có secret-scan → SEC-1 đã xảy ra.
  - **Làm**: thêm `gitleaks` vào `devDependencies` (gitleaks là **binary Go** — nếu npm wrapper không ổn định trên Windows, dùng `gitleaks/gitleaks-action` trong CI + tải binary/script cho pre-commit husky), script `npm run secret:scan` (gitleaks `detect --fail-on-any`), `.gitleaks.toml` (allowlist test-fixture có chuỗi `test-secret`), pre-commit hook (husky) chạy gitleaks.
  - **Giữ**: zero-dep runtime (gitleaks là dev tool).
- **file:line**: `package.json:47-60` (devDeps); `.gitignore`; `.gitleaks.toml` (mới).
- **Acceptance criteria**: `npm run secret:scan` trả **0 finding** trên toàn repo; pre-commit chặn commit có secret mới (US-BUILD-1, G-5).
- **Dependencies**: T-01.
- **Producer**: DevSecOps.
- **Reviewers**: Security Architect, AppSec (security), Code Reviewer (correctness), Reality Checker.
- **Effort**: S

---

### 🟢 WAVE 1 — Config & DB (fail-fast infrastructure)

#### T-03 — Config fail-fast + env hygiene (C-2, C-3, C-4, S-9, US-CFG-1, Q-2)
- **Mô tả**
  - **Thay**: `getEnv()` dùng default cho mọi key thiếu/typo (`config.ts:70-115`); default DB URL hardcode `postgresql://appuser:secret@localhost:5439/loadtest` (`config.ts:104`, `db/init.ts:27`); `newRunId()` collision khi restart (runSeq reset 0 — `config.ts:219-225`); allowlist default dev-only `localhost:3000` (`config.ts:82-85`).
  - **Làm**: thêm `validateEnv()` fail-fast khi `NODE_ENV=production`**hoặc** `LOADTEST_DB_REQUIRED=true` (mặc định `true` — Q-2): báo danh sách key thiếu/sai rồi exit code ≠ 0; bỏ default credential → placeholder `postgresql://USER:PASS@HOST:PORT/DB` (không có giá trị thật) — **kèm cập nhật `loadtest/.env.example:24`** (hiện đang chứa `appuser:secret` thật) sang placeholder; sửa `newRunId()` seed từ `process.pid` + counter để không trùng sau restart; log nguồn env (process.env / file / override) khi `LOADTEST_DEBUG` (C-4); ghi chú `LOADTEST_HOST` mặc định `127.0.0.1` giữ nguyên (SEC-7).
  - **Giữ**: toàn bộ cấu hình hiện có (port 3401, host, maxTarget, maxDurationMin, allowlist, presets, mobile defaults); cơ chế merge 3 nguồn.
- **file:line**: `loadtest/config.ts:70-115, 82-85, 104, 219-225`; `loadtest/db/init.ts:27`; `loadtest/server.ts:14-29`.
- **Acceptance criteria** (US-CFG-1, G-4):
  - `npm run loadtest:server` với `LOADTEST_DATABASE_URL` sai → process exit code ≠ 0 + message rõ ràng (không "chạy nhưng không ghi history").
  - `LOADTEST_DB_REQUIRED=true` + DB không lên → fail fast (✔ verified ở M1 — `connect()` throw là T-05; T-03 chỉ validate env keys).
  - Không còn chuỗi `appuser:secret` trong **runtime config** (grep = 0 trong `loadtest/config.ts`, `loadtest/db/init.ts`, `loadtest/.env.example`); test fixture `loadtest/__tests__/*.test.ts` dùng credential test DB riêng — KHÔNG tính vào grep (nếu giữ, thêm comment "test-only").
  - Unit test: `newRunId()` 2 lần gọi sau restart cho 2 id khác nhau.
- **Dependencies**: T-01 (rotate DB password trước khi đổi config).
- **Producer**: Backend Architect.
- **Reviewers**: Code Reviewer (correctness), Security Architect (env/secret), API Tester (fail-fast), Performance Benchmarker (startup perf).
- **Effort**: M

#### T-04 — Migration runner zero-dep + retention script (D-4, US-DB-1, Q-3, D-9)
- **Mô tả**
  - **Thay**: `ensureSchema()` chạy `schema.sql` + `INSERT schema_version 1` thủ công (`store.ts:159-169`); `init.ts:94-98` cùng pattern; đổi schema không tự áp dụng lên DB có sẵn, không rollback.
  - **Làm**: `loadtest/db/migrations/001_init.sql` — **baseline detect** (`CREATE TABLE IF NOT EXISTS` — handle "bảng đã tồn tại thiếu cột" R-4) + `up`/`down` block; `loadtest/db/migrate.ts` runner (~150 dòng, zero-dep): đọc thư mục migrations, đọc `schema_version` hiện tại, apply từng bậc trong transaction, ghi version, hỗ trợ `up`/`down`/`status`; scripts `loadtest:db:up/down/status`; thêm `db:cleanup --older-than 30d` (D-9 — script thủ công, KHÔNG chạy nền); `store.ensureSchema()` → gọi runner (hoặc `DbWriter.startup` gọi `migrate up`).
  - **Giữ**: schema 7 bảng + FK cascade + index (không đổi DDL trừ bug fix); `schema_version`; single-writer; import legacy pool idempotent.
- **file:line**: `loadtest/db/store.ts:159-169`; `loadtest/db/init.ts:86-129`; `loadtest/db/schema.sql:16-148`; `loadtest/db/writer.ts:38-49`; `package.json:7-15` (scripts).
- **Acceptance criteria** (US-DB-1, G-8):
  - `db:up` trên DB trống → 7 bảng + `schema_version=1`; chạy lại lần 2 không lỗi.
  - `db:down` → drop bảng bậc 1 + `schema_version` lùi 0.
  - `db:up → db:down → db:up` trên DB test: 0 lỗi, dữ liệu cũ không mất.
  - `db:status` in version đúng.
- **Dependencies**: T-03 (DB URL fail-fast).
- **Producer**: Backend Architect.
- **Reviewers**: Database Reliability Engineer (domain), Code Reviewer (correctness), API Tester (cli contract), Reality Checker (rollback proof).
- **Effort**: L

#### T-05 — DB store correctness — không mất metric im lặng (D-5, D-6, D-7, D-10, US-DB-2, Q-2)
- **Mô tả**
  - **Thay**: `query<T>` trả `[]` khi lỗi → caller không phân biệt "no rows" vs "DB fail" (`store.ts:173-192`); `countMetricSamples` trả 0 khi DB lỗi → mất dữ liệu im lặng (`store.ts:355-358`); `pg.types.setTypeParser(20, ...)` toàn cục làm BIGINT > 2^53 mất chính xác (`store.ts:19`); `importLegacyPools` dùng `fs.statSync().mtimeMs` float vào cột `created_at BIGINT` → insert fail im lặng (`writer.ts:256`); `connect()` fail → `disabled=true` run vẫn chạy "không ghi history" (`store.ts:132-149`).
  - **Làm**: `query<T>` trả `QueryResult<T> = { ok: true; rows } | { ok: false; error }`; mọi caller đọc `ok` trước khi dùng `rows`; `countMetricSamples`/`listMetricSamples` khi DB fail → không trả 0 giả (API history trả 503/500 rõ ràng — **phần sửa handler history route nằm trong task này**, không đợi T-06); bỏ `setTypeParser` toàn cục, parse BIGINT ở biên (chỉ cột cần, giữ an toàn < 2^53); `Math.trunc(fs.statSync().mtimeMs)`; `connect()` fail + `LOADTEST_DB_REQUIRED=true` → **throw** (server.ts bắt → exit ≠ 0); DB write fail → đếm `dbWriteFail` metric + log cảnh báo có `runId` + giữ retry ≥ 1 lần (US-DB-2); **tạo `loadtest/tool-metrics.ts`** (counter `dbWriteFail`/`dbRetry` + gauge tối thiểu) — T-07 mở rộng module này, task này KHÔNG phụ thuộc T-07.
  - **Giữ**: best-effort write (không chết run khi DB lỗi tạm thời), retry 1 lần, không retry 23505/23503, batch flush 30s/500 tick, single-writer.
- **file:line**: `loadtest/db/store.ts:19, 132-149, 173-192, 355-358`; `loadtest/db/writer.ts:256`; `loadtest/api-server.ts:336-374` (history routes).
- **Acceptance criteria** (US-DB-2, US-CFG-1, G-1):
  - DB lỗi tạm thời → không throw chết run; `dbWriteFail` đếm được; log warning có `runId`; retry ≥ 1 lần / flush khi DB hồi phục.
  - `countMetricSamples` với DB lỗi → không trả 0 giả (API lỗi rõ).
  - Import legacy pool không còn insert fail im lặng (test: pool có `created_at` đúng epoch integer).
  - `LOADTEST_DB_REQUIRED=true` + DB down → server không start.
- **Dependencies**: T-04 (migration thay `ensureSchema`). (KHÔNG phụ thuộc T-07 — counter `dbWriteFail` do task này tạo trong `tool-metrics.ts`; xoá cycle với T-07.)
- **Producer**: Backend Architect.
- **Reviewers**: Code Reviewer (correctness), Database Reliability Engineer (domain), API Tester (history routes), Performance Benchmarker (parser overhead).
- **Effort**: L

---

### 🟡 WAVE 2 — Loadtest server hardening

#### T-06 — API server hardening: CORS, rate-limit, register gate, body validation, graceful shutdown (S-7, S-10, S-11, SEC-2, SEC-5, SEC-6, US-API-1, US-API-2, US-SEC-3, US-SEC-4, §5.2)
- **Mô tả**
  - **Thay**: CORS `Access-Control-Allow-Origin: *` (`api-server.ts:76-79`); `readBody` swallow JSON parse → `{}` + không giới hạn body (`api-server.ts:95-105`); không rate-limit login/register/start/stop (`api-server.ts:128-382`); register admin public (`api-server.ts:387-401`); shutdown không timeout tổng (`server.ts:41-49`); god classes (`api-server.ts` 532d, `coordinator.ts` 537d, `socket-farm.ts` 694d — S-6).
  - **Làm**: CORS theo `CORS_ORIGIN` env (mặc định `http://localhost:5173` — R-7), allowlist nhiều origin; `readBody` limit ≤ 1MB → JSON hỏng → 400 `{ success:false, message:'JSON body không hợp lệ' }`; rate-limit per IP: login/register 5 fail/60s/IP → 429, `/start` 1 req/10s (**thiết kế token bucket mới `loadtest/rate-limit.ts` zero-dep — `SimpleRateLimiter` hiện có ở `auth-factory.ts:133-150` là limiter tốc độ chờ khi `acquire()`, KHÔNG trả 429 và không theo IP, chỉ dùng lại nếu cần throttle**); register gate `LOADTEST_ALLOW_REGISTER` (mặc định `false`) → 403; error envelope chuẩn hoá thêm `timestamp` + `error` code (giữ `{ success, statusCode, message }`); graceful shutdown timeout tổng ≥ 10s; **tách module** theo hướng giảm god class: `readBody`/`cors`/`rateLimit` → `http.ts` helpers, các handler route → module riêng, `requireAuth` → guard module (giữ nguyên hành vi, giảm `api-server.ts` xuống < 400 dòng); **kèm task này: cập nhật ngay `loadtest/__tests__/api-server.test.ts`** (set `LOADTEST_ALLOW_REGISTER=true` trong env override của `beforeAll`) — nếu không, sau khi thêm gate (default false) các test register hiện có (kỳ vọng 200) sẽ ĐỎ từ T-06 đến T-11; thêm counter `apiErrors` vào `tool-metrics.ts` (T-05 tạo).
  - **Giữ**: toàn bộ route contract (UI-SPEC / API-loadtest-tool), Bearer auth, envelope, allowlist chặn cứng (SD-1), `validateRunRequest`, idempotent start 409 (đã có — `coordinator.ts:105-106`).
- **file:line**: `loadtest/api-server.ts:75-105, 128-382, 386-401`; `loadtest/auth-factory.ts:133-150`; `loadtest/server.ts:41-49`; `loadtest/coordinator.ts:105-106`.
- **Acceptance criteria**:
  - Body hỏng → 400 `'JSON body không hợp lệ'` (US-API-1).
  - 2 request `/start` cùng payload trong 1 run → 409 (US-API-2, đã có — test regression).
  - > 5 login sai/60s cùng IP → 429 (US-SEC-4).
  - `LOADTEST_ALLOW_REGISTER=false` → 403 (US-SEC-3); `true` → register hoạt động như cũ.
  - CORS response không còn `*`; `CORS_ORIGIN` đúng origin.
  - Preflight `OPTIONS` 204.
- **Dependencies**: T-03, T-05 (store contract). (KHÔNG phụ thuộc T-07 — counter `apiErrors` tạo trong `tool-metrics.ts`; requestId sinh ngay trong task này, T-07 chỉ tiêu thụ.)
- **Producer**: Backend Architect.
- **Reviewers**: AppSec (security), Security Architect (auth design), API Tester (contract), Performance Benchmarker (rate-limit overhead), Code Reviewer (correctness).
- **Effort**: M

#### T-07 — Observability: structured log, health chi tiết, tool metrics, traceId (O-2, O-3, O-4, O-5, S-12, US-OBS-1)
- **Mô tả**
  - **Thay**: logger text `[lt][INFO][ts] msg` không JSON (`util.ts:28-43`); `/health` chỉ `{ status:'ok' }` (`api-server.ts:141`); không có metric cho chính tool (`coordinator.ts:32-68`); không traceId/requestId (`coordinator.ts:454-505`); `NO_POST_FIXTURE` skip đúng nhưng không rõ trong report (`rest-actions.ts:20-47, 108-121`).
  - **Làm**: `loadtest/logger.ts` — structured JSON `{ ts, level, runId?, workerId?, requestId?, msg, context? }`, giữ ring buffer 500 (compat `logHistory`), thêm sink file JSONL có rotation; gắn `requestId` mỗi API request (sinh + echo trong envelope — vùng nhớ do T-06 tạo); `loadtest/health.ts` — `/health` trả `{ status: ok|degraded|down, db, redis, workers, version, uptime }` (DB down → `status:'degraded', db:'down'`, không 500); tool metrics: **mở rộng `loadtest/tool-metrics.ts`** (T-05 tạo) thêm counters `apiErrors`, `workerRestarts`, `runFinished` + gauge `coordinator.rssMb`, `worker.alive` (expose `GET /metrics` Prometheus text — **KHÔNG dùng `/api/loadtest/metrics`** vì đã là route tick-history của dashboard; dùng `/metrics` hoặc `/api/loadtest/tool-metrics` — hoặc log định kỳ 5s — tối thiểu); `runId` gắn vào log DB (`log_events.run_id` — đã có, giữ); report làm rõ dòng `NO_POST_FIXTURE` (S-12).
  - **Giữ**: `ltLog` API compat (toàn bộ module gọi `ltLog.info/warn/error`), subscriber DB (`subscribeLog`), ring buffer dashboard, prefix `[lt]`.
- **file:line**: `loadtest/util.ts:13-49`; `loadtest/api-server.ts:141`; `loadtest/coordinator.ts:32-68, 216-218, 454-505`; `loadtest/server.ts:14-29`; `loadtest/rest-actions.ts:20-47, 108-121`.
- **Acceptance criteria** (US-OBS-1, G-10):
  - `/health` DB down → `status:'degraded', db:'down'` (không 500, không `ok` giả).
  - Log JSON có `runId`/`requestId`; `dbWriteFail`/`workerRestarts` đếm được.
  - Không còn phụ thuộc parse text log (test dùng JSON sink).
- **Dependencies**: T-05 (DB fail surfaced), T-06 (requestId trong envelope).
- **Producer**: Realtime Collaboration Engineer (runtime/observability).
- **Reviewers**: Code Reviewer (correctness), Performance Benchmarker (perf), SRE (domain), Reality Checker (health evidence).
- **Effort**: M

---

### 🟠 WAVE 3 — Frontend

#### T-08 — Frontend chat hardening: refresh endpoint, bỏ debug log, bỏ token query, Error Boundary, CSP (F-6, F-7, F-8, F-9, F-10, US-FE-1, US-FE-2, SEC-3, SEC-4)
- **Mô tả**
  - **Thay**: `VITE_REFRESH_ENDPOINT` default `/auth/refresh` (`env.ts:13`, `.env.example:9`) — gateway thật là `POST /auth/refresh-token` (`auth.controller.ts:314`, body `{ refreshToken }` → `{ accessToken, refreshToken }`); `[DEBUG-LOGIN]` in deviceInfo + full error (`auth.store.ts:46-55, 76-83`); token trong query string socket (`socket.ts:84-98`); không Error Boundary (`App.tsx:46-77`); không CSP (`index.html:1-21`).
  - **Làm**: sửa default endpoint → `/auth/refresh-token` (body đã đúng `{ refreshToken }` — giữ); xoá toàn bộ `[DEBUG-LOGIN]`; bỏ `query: { token }` socket ở **cả 2 nơi**: `src/lib/socket.ts:87` và `loadtest/socket-farm.ts:97` (F-8/SEC-3 — `socket-farm.ts` đang bị bỏ sót, cũng đưa token vào URL query), chỉ giữ `Authorization: Bearer` header (gateway đọc **query trước rồi fallback header** — `websocket.gateway.ts:148-149`; bỏ query vẫn hoạt động vì header fallback); `src/components/ErrorBoundary.tsx` + wrap các route trong `App.tsx`; CSP trong `index.html` (meta) — `default-src 'self'; script-src 'self'; connect-src 'self' ws: wss: https://fonts.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:`; đảm bảo Vite dev + HMR không bị chặn (dev CSP để qua Vite hoặc cấu hình phù hợp — **lưu ý: @vitejs/plugin-react inject INLINE script preamble react-refresh → dev cần `script-src 'self' 'unsafe-inline'` hoặc CSP riêng cho dev; prod giữ chặt `script-src 'self'`**).
  - **Giữ**: token trong localStorage (Q-4), socket outbox + resend + clientMsgId dedupe, refresh best-effort chain (401 → refresh → retry → clear), error envelope, `decodeJwt` hydrate.
- **file:line**: `src/lib/env.ts:13`; `src/lib/api.ts:57-72`; `src/store/auth.store.ts:44-86`; `src/lib/socket.ts:84-98`; **`loadtest/socket-farm.ts:93-98`** (F-8); `src/App.tsx:46-77`; `index.html:1-21`; `.env.example:8-9`; `gateway-auth-service/src/infrastructure/driving-adapters/http-rest/controllers/auth.controller.ts:314`.
- **Acceptance criteria** (US-FE-1, US-FE-2, G-10):
  - Console không có chuỗi `[DEBUG-LOGIN]`; không log deviceInfo/raw response (US-FE-2).
  - Interceptor gọi `POST /auth/refresh-token` với `{ refreshToken }`, nhận access token mới, retry request cũ, UI không logout (US-FE-1).
  - Socket handshake không có `token` trong query (chỉ header).
  - Component render lỗi → ErrorBoundary hiện fallback, không trắng trang.
  - Dev + production chạy với CSP không chặn (font, ws, HMR).
- **Dependencies**: (contract) xác nhận gateway `/auth/refresh-token` — xong cùng T-11; T-01 (đã xoá secret khỏi tree).
- **Producer**: Frontend Developer.
- **Reviewers**: Code Reviewer (correctness), AppSec (CSP/XSS), Security Architect (token handling), Realtime Collaboration Engineer (socket domain).
- **Effort**: M

#### T-09 — Frontend tests + loadtest UI hardening (F-11, L-5, L-6, L-7, T-2)
- **Mô tả**
  - **Thay**: `vitest.config.ts` chỉ include `loadtest/__tests__/**` (`loadtest/vitest.config.ts:6-8`) → 0 test cho `src/`; `loadPrefs` parse JSON không schema validate (`loadtest.store.ts:29-45`); session 12h không refresh (`loadtest/auth.ts:15`) — chấp nhận MVP.
  - **Làm**: mở rộng vitest include `src/**/*.test.{ts,tsx}` (hoặc config riêng root); unit test: `loadtest-format.ts` (fmtNum/fmtCompact/fmtMs/fmtClock/fmtTickTime/fmtDateTime/fmtRange), `loadtest.store.ts` selectors (`selectTicks`), `env.ts` (defaults), `api.ts` (`unwrap`, `toApiError`), `auth.store.ts` (hydrate/login mock api), `loadtest-auth-storage.ts`; `loadPrefs` schema-check (parse + validate shape → fallback default); ghi rõ `SESSION_TTL_MS` vào README + (nếu trống) thông báo "phiên sắp hết hạn" trên dashboard — không thêm refresh server-side.
  - **Giữ**: hành vi UI (UI-SPEC), store slices, localStorage, poll 1s.
- **file:line**: `loadtest/vitest.config.ts:6-8`; `src/lib/loadtest-format.ts`; `src/store/loadtest.store.ts:29-45, 215-218`; `src/store/auth.store.ts`; `src/lib/loadtest-auth-storage.ts`; `loadtest/auth.ts:15`.
- **Acceptance criteria** (G-1, G-6):
  - `npm run test` chạy cả loadtest + frontend tests, xanh.
  - Coverage ≥ 70% cho format helpers + store selectors (`src/lib/loadtest-format.ts`, `src/store/loadtest.store.ts`).
  - `loadPrefs` trả default khi JSON sai shape.
  - Không đổi hành vi UI (review G-6).
- **Dependencies**: T-08 (auth.store sạch debug log → test ổn định).
- **Producer**: Frontend Developer.
- **Reviewers**: Test Automation Engineer (coverage lens), Code Reviewer (correctness), API Tester (mock contract), Reality Checker.
- **Effort**: M

---

### 🔵 WAVE 4 — Build / deploy / test engineering

#### T-10 — CI pipeline + lint (T-3, T-4, US-BUILD-1, Q-5)
- **Mô tả**
  - **Thay**: không CI, không lint.
  - **Làm**: `.github/workflows/ci.yml` — matrix `ubuntu-latest` + `windows-latest`; steps: `install (npm ci) → secret-scan (gitleaks --fail-on-any) → lint (eslint) → typecheck (root + loadtest) → build → loadtest:test → test (frontend — T-09) → coverage`; thêm `eslint.config.*` + `npm run lint` (0 error, 0 warning); integration test cần Postgres giữ pattern skip-if-không-DB (hoặc service container Postgres cho phép chạy — tùy chọn, không bắt buộc). **⚠️ Tiền đề gate: CI GitHub Actions chỉ chạy được khi repo có remote GitHub (Q-1: repo chưa push remote). Nếu chưa có remote, gate CI (G-4/G-5) verify thủ công bằng chạy đủ step trên máy và đánh dấu TODO → hoàn thiện khi push.**
  - **Giữ**: zero-dep runtime cho `loadtest/` (eslint/gitleaks là dev tooling).
- **file:line**: `package.json:7-15` (scripts); `.github/workflows/ci.yml` (mới); `loadtest/vitest.config.ts`.
- **Acceptance criteria** (US-BUILD-1, G-4, G-5):
  - CI xanh trên cả 2 OS; secret-scan fail khi có secret mới.
  - 0 eslint error/warning.
- **Dependencies**: T-01, T-02 (secret-scan), T-03..T-09 (tests pass, code lint-clean).
- **Producer**: DevSecOps.
- **Reviewers**: Code Reviewer (correctness), Security Architect (CI secret), Test Automation Engineer (test lens), Reality Checker.
- **Effort**: M

#### T-11 — Contract + E2E + mutation tests (T-7, T-8, G-2, G-3)
- **Mô tả**
  - **Thay**: không contract test (F-6 đã chứng minh hệ quả), không E2E mock gateway, không mutation.
  - **Làm**: mở rộng contract test `api-server.test.ts` (đã có) cho các route/hành vi mới T-06 (400/403/429, CORS, health shape); test **type-check 2 chiều** `src/types/loadtest.ts` ↔ `loadtest/types.ts` (structural so sánh — đã có comment, chưa có test); E2E `coordinator.start` + `provisionAccounts` với **mock gateway** (HTTP server giả trả envelope chuẩn: register/login/feed/chat) — không cần gateway thật; stryker cho `loadtest/coordinator-state.ts`, `metrics.ts`, `config.ts`, `report.ts` — mutation score ≥ 70%.
  - **Giữ**: unit test hiện tại, integration test skip-if-no-DB.
- **file:line**: `loadtest/__tests__/api-server.test.ts`; `src/types/loadtest.ts`; `loadtest/types.ts`; `loadtest/coordinator-state.ts`; `loadtest/metrics.ts`; `loadtest/config.ts`; `loadtest/report.ts`.
- **Acceptance criteria** (G-2, G-3, G-7):
  - Contract test xanh; type 2-chiều khớp.
  - E2E mock gateway chạy được 1 run ngắn (≤ 5k user) → report đầy đủ.
  - Mutation score ≥ 70% cho 4 module chỉ định.
- **Dependencies**: T-06 (API contract mới), T-08 (refresh endpoint), T-10 (CI chạy được).
- **Producer**: Test Automation Engineer (producer) + Backend Architect (mock gateway).
- **Reviewers**: API Tester (contract), Code Reviewer (correctness), Performance Benchmarker (mutation/benchmark), Reality Checker (evidence).
- **Effort**: L

#### T-12 — Docs: threat model, README deploy, Docker artifacts (G-9, D-8, R-5, S-8, S-12, D-9)
- **Mô tả**
  - **Thay**: không có `THREAT-MODEL.md`, README chưa có deploy guide, không có Dockerfile.
  - **Làm**: `docs/THREAT-MODEL.md` (1 trang, G-9): luồng token chat + loadtest, localStorage risk (XSS → token theft), control CSP, rate-limit, CORS, register gate, `pool_accounts.password` plaintext (D-8/R-5 — quyết định: chấp nhận + document vì user test; đề xuất AES-GCM v1.1), `SESSION_TTL_MS` 12h; README: hướng dẫn deploy (env keys, migrate up/down/status, backup `pg_dump`, retention `db:cleanup --older-than 30d`, healthcheck, ghi rõ limitation 1 coordinator = 1 run — S-8); `docker/Dockerfile.frontend` (2-stage build → nginx/alpine, healthcheck `wget /healthz`), `docker/Dockerfile.loadtest` (node:22-alpine, `tsx loadtest/server.ts`, healthcheck `fetch /api/loadtest/health`), `docker/nginx.conf` (CSP header + `/healthz` + **SPA fallback `try_files $uri $uri/ /index.html;` — bắt buộc cho react-router (`/loadtest`, `/chat`, `/login`): F5/direct nav mà không có fallback → 404**).
  - **Giữ**: không đổi hành vi.
- **file:line**: `README.md`; `docs/`; `docker/` (mới); `index.html` (CSP reference).
- **Acceptance criteria** (G-9, G-7):
  - THREAT-MODEL.md đủ 9 mục + mỗi mục có control tương ứng (G-9).
  - README có deploy/backup/retention/limitation.
  - 2 Dockerfile build được trên test env.
- **Dependencies**: T-01..T-11 (document sau khi control đã có; chạy cuối).
- **Producer**: Tech Writer.
- **Reviewers**: Security Architect (threat model), AppSec (controls), Reality Checker (evidence), Code Reviewer (docs-spec khớp).
- **Effort**: M

---

## 3. Thứ tự triển khai tối ưu (waves)

### 3.1 Wave map
| Wave | Tên | Task | Mục tiêu shippable |
|---|---|---|---|
| **W0** | Bảo mật & vệ sinh repo | T-01, T-02 | Repo an toàn để commit (không secret, đã scan). |
| **W1** | Config & DB fail-fast | T-03, T-04, T-05 | Server fail-fast; DB có migration/rollback; không mất metric im lặng. |
| **W2** | Loadtest server hardening | T-06, T-07 | API an toàn (CORS/rate-limit/register gate); quan sát được. |
| **W3** | Frontend | T-08, T-09 | Chat đúng contract + sạch PII; frontend có test. |
| **W4** | Build/deploy/test engineering | T-10, T-11, T-12 | CI xanh, mutation/contract pass, docs + Docker. |

### 3.2 Critical path
```
T-01 → T-02 → T-03 → T-04 → T-05 → T-06 → T-07 → T-10 → T-11 → T-12
                                                          ↗
                                     T-08 → T-09 (song song W1–W2, chỉ đợi confirm contract gateway)
```
- **T-01 phải là task đầu tiên và là cam kết đóng đinh trước mọi commit khác** (R-1). Không commit bất kỳ file nào trong working tree trước khi T-01 xong.
- Frontend (T-08/T-09) có thể chạy song song W1–W2 vì chỉ phụ thuộc contract gateway (đã xác nhận GATE 1: `POST /auth/refresh-token`).
- T-11, T-12 là chốt chặn cuối: T-11 cần T-06/T-08 (contract mới), T-12 cần thiết bị đã tồn tại.

### 3.3 Milestone đánh giá giữa wave
| Milestone | Điều kiện mở wave sau |
|---|---|
| M0 | T-01 + T-02 xong: gitleaks 0 finding, `git check-ignore` đúng, secret đã rotate. |
| M1 | T-03 + T-04 + T-05 xong: `loadtest:test` xanh, migration `up/down/up` proof, fail-fast proof. |
| M2 | T-06 + T-07 xong: 400/403/429/CORS test pass, `/health` degraded đúng. |
| M3 | T-08 + T-09 xong: frontend tests pass, không `[DEBUG-LOGIN]`, CSP sống. |
| M4 | T-10 + T-11 + T-12 xong: CI xanh 2 OS, mutation ≥ 70%, THREAT-MODEL + Docker. |

---

## 4. Gates & milestones (hard-gates per wave)

| Wave | Cổng (hard-gate) | Tiêu chí kiểm chứng |
|---|---|---|
| W0 | **G-5 SAST/secret-scan** + G-6 review | gitleaks 0 finding; `git check-ignore` khớp `loadtest/data/*` + `*.env`; 1 reviewer độc lập pass. |
| W1 | **G-1 tests** + **G-4 type/lint/build** + **G-8 migration rollback** + US-CFG-1 | `loadtest:test` xanh; `typecheck` + `build` xanh; `db:up→down→up` 0 lỗi; `validateEnv` fail-fast proof. |
| W2 | **G-1** + **G-3 contract** + **G-4** + **G-10 observability** | 400/403/429/CORS/health test pass; `/health` degraded đúng; log JSON có runId/requestId. |
| W3 | **G-1** (frontend coverage ≥ 70% format helpers) + **G-4** + **G-6** | `npm run test` root xanh; không `[DEBUG-LOGIN]`; UI không đổi hành vi. |
| W4 | **G-2 mutation** + **G-3** + **G-5 CI** + **G-7 reality check** + **G-9 threat model** | stryker ≥ 70% (4 modules); type 2-chiều khớp; CI xanh 2 OS; 1 run thật ≤ 5k user có report; THREAT-MODEL đủ control. |

> Mỗi task ≥ 3 reviewer lens, **bắt buộc có 1 reviewer Security** cho Task chạm security (T-01, T-02, T-03, T-06, T-08, T-12) và **bắt buộc Reality Checker** cho Task chạm hành vi vận hành (T-04, T-05, T-07, T-11, T-12).

---

## 5. Risks & dependencies (cross-task coupling)

| # | Rủi ro / coupling | Task liên quan | Ứng phó |
|---|---|---|---|
| R-1 | **Migration runner đụng DB trước khi store đổi** — `ensureSchema` (T-04) thay bằng runner; nếu T-05 chưa xong, `query` vẫn trả `[]` khi lỗi → migration "chạy" nhưng không report. | T-04 ↔ T-05 | T-04 trước T-05; runner tự throw khi migrate fail (không nuốt); test `db:up` standalone. |
| R-2 | **CORS hẹp phá Vite proxy cùng máy** — proxy `changeOrigin: true` vẫn gửi origin Vite. | T-06 ↔ T-08 | `CORS_ORIGIN` mặc định `http://localhost:5173`; test cả dev + prod; lưu ý trong README. |
| R-3 | **Frontend refresh phụ thuộc confirm contract gateway** — R-2 PRD. | T-08 ↔ T-11 | GATE 1 đã xác nhận `POST /auth/refresh-token`; contract test chốt lại trong T-11. |
| R-4 | **`LOADTEST_DB_REQUIRED=true` làm vỡ workflow dev** — ai không có DB không chạy server. | T-03 ↔ T-05 | Q-2 chốt bắt buộc; giữ flag override emergency (rollback), document trong README. |
| R-5 | **Register gate chặn dev** — `LOADTEST_ALLOW_REGISTER=false` mặc định. | T-06 ↔ T-09 | Dev set `LOADTEST_ALLOW_REGISTER=true` trong `loadtest/.env`; test dùng seed-admin. |
| R-6 | **Rate-limit làm hỏng E2E/contract test** — nhiều request nhanh cùng IP. | T-06 ↔ T-11 | Test env set `LOADTEST_RATE_LIMIT_*` cao hoặc disable; ghi chú CI. |
| R-7 | **CSP chặn Vite HMR / font Google** — app dev đứng im. | T-08 ↔ T-12 | CSP cho phép `ws:`/`wss:` + `style-src 'unsafe-inline'` (dev) + font origin; nginx header riêng cho prod. |
| R-8 | **Structured logger phá subscriber/log_events** — test parse text log. | T-07 ↔ T-05 | Giữ `subscribeLog` + ring buffer; thêm sink JSON song song; test đọc JSON sink. |
| R-9 | **`pool_accounts.password` plaintext** — lộ nếu DB test bị lộ. | T-12 ↔ T-05 | Chấp nhận + document (user test); đề xuất AES-GCM v1.1; không thêm trong wave này. |
| R-10 | **`newRunId()` collision trùng run_id (PK) sau restart** — run khác ghi đè lịch sử. | T-03 ↔ T-05 | Fix seed trong T-03; test 2 lần gọi sau restart khác id. |

---

## 6. Test / mutation plan

| Module | Loại test | Công cụ | Phạm vi / ngưỡng | Task |
|---|---|---|---|---|
| `coordinator-state.ts`, `metrics.ts`, `config.ts`, `report.ts` | Unit + **Mutation** | vitest + **stryker** | mutation score ≥ 70% (G-2) | T-11 |
| `auth.ts`, `password.ts`, `util.ts`, `http.ts`, `coordinator-state.ts` | Unit | vitest | coverage ≥ 80% (PRD §5.6) | ĐÃ CÓ + mở rộng T-11 |
| `db/store.ts`, `db/writer.ts`, `db/migrate.ts` | Integration (Postgres) | vitest + pg | skip-if-no-DB; migration `up/down/up` (G-8) | T-04, T-05 |
| `api-server.ts` | **Contract test** | vitest + supertest-style (native http) | 400/403/429/CORS/health shape (G-3) | T-06, T-11 |
| `types/loadtest.ts` ↔ `loadtest/types.ts` | **Type-check 2 chiều** | tsc / vitest structural | khớp 100% (G-3) | T-11 |
| `coordinator.start` + `provisionAccounts` | **E2E với mock gateway** | vitest + mock HTTP server | 1 run ngắn ≤ 5k user, report đầy đủ (G-7) | T-11 |
| `src/lib/loadtest-format.ts`, `src/store/loadtest.store.ts`, `env.ts`, `api.ts`, `auth.store.ts` | Frontend unit | vitest (root) | coverage ≥ 70% format helpers + selectors (G-1) | T-09 |
| Refresh interceptor `src/lib/api.ts` | Frontend contract | vitest + axios-mock | `POST /auth/refresh-token` + retry (G-3) | T-08, T-09 |

---

## 7. Rollback plan per risky change

| Thay đổi | Task | Cách rollback an toàn | Điều kiện rollback |
|---|---|---|---|
| **Secret removal / rotate** | T-01 | Copy secret ra ngoài repo trước khi xoá (`%USERPROFILE%\.mayogu-secrets\`); DB: tạo credential mới trước, đổi `.env` sau; rollback = đổi `.env` về credential mới (giá trị cũ đã chết — không quay lại giá trị lộ). | Nếu dev không login được → kiểm tra credential mới đã áp dụng lên Postgres. |
| **Migration runner** | T-04 | Migration `001` = baseline `CREATE TABLE IF NOT EXISTS` (non-destructive, R-4); giữ `schema.sql` cũ; rollback mã = revert commit của runner; `db:down` chỉ để rollback bậc cuối. | DB dữ liệu cũ không bị drop khi `up` lại (G-8 proof). |
| **DB required=true** | T-03, T-05 | Giữ flag `LOADTEST_DB_REQUIRED` (default true theo Q-2) — emergency set `false` tạm thời để khôi phục dịch vụ; document là override khẩn cấp. | Server không khởi động được vì DB infra → tạm override, xử lý DB sau. |
| **CORS hẹp** | T-06 | `CORS_ORIGIN` là env — rollback = set origin đúng (hoặc thêm origin vào allowlist); không đặt `*` (SEC-2). | Dashboard không gọi được API → set `CORS_ORIGIN` khớp origin thật. |
| **Register gate + rate-limit** | T-06 | `LOADTEST_ALLOW_REGISTER=true` (dev) + `LOADTEST_RATE_LIMIT_*` tăng hoặc disable trong test env. | Dev không register được / test fail vì 429. |
| **Frontend refresh endpoint + bỏ query token** | T-08 | `VITE_REFRESH_ENDPOINT` là env — rollback set lại `/auth/refresh`; gateway vẫn chấp nhận query token (`websocket.gateway.ts:148`) nên bỏ query không phá contract; ErrorBoundary/CSP là additive. | Refresh không hoạt động → kiểm tra body/contract; CSP chặn dev → bỏ qua meta CSP trong dev. |
| **Health/logger shape** | T-07 | `/health` thêm field (additive — client đọc `status` vẫn OK); logger giữ text sink song song JSON. | Không cần rollback toàn bộ — chỉ đổi sink. |

---

## 8. Acceptance sign-off checklist (map G1–G10)

| Cổng | Tiêu chí (PRD §8) | Task chứng minh | Checklist khi sign-off |
|---|---|---|---|
| **G-1 Tests** | `loadtest:test` xanh; coverage ≥ 70% pure modules; test mới cho mọi bug fix | T-04, T-05, T-09, T-11 | [ ] `npm run loadtest:test` xanh cả 2 OS (CI) [ ] coverage report ≥ 70% [ ] regression test cho D-5/D-6/F-6/F-7 |
| **G-2 Mutation** | stryker ≥ 70% cho coordinator-state, metrics, config, report | T-11 | [ ] `npm run loadtest:mutation` ≥ 70% |
| **G-3 Contract** | api-server contract xanh; type 2-chiều khớp; refresh `/auth/refresh-token` | T-06, T-08, T-11 | [ ] contract test xanh [ ] type-check 2 chiều [ ] test US-FE-1 |
| **G-4 Type/lint/build** | typecheck, loadtest:typecheck, build xanh; eslint 0 error/warning | T-03, T-08, T-10 | [ ] 3 lệnh xanh [ ] `npm run lint` 0/0 |
| **G-5 SAST/secret-scan** | gitleaks 0 finding; `git check-ignore` khớp `loadtest/data/*` + `*.env` | T-01, T-02, T-10 | [ ] `npm run secret:scan` 0 finding [ ] `git check-ignore` đúng 4 nhóm file |
| **G-6 Code review** | ≥ 1 reviewer độc lập; không đổi contract gateway, không đổi UI | mọi task | [ ] mỗi PR review pass [ ] diff không đổi gateway contract / UI |
| **G-7 Reality check** | 1 run thật ≤ 5k user, 5 phút → report đầy đủ; Docker build được | T-11, T-12 | [ ] report trong `docs/loadtest-reports/` [ ] 2 Dockerfile build OK |
| **G-8 Migration rollback** | `db:up → db:down → db:up` 0 lỗi, schema_version đúng, dữ liệu cũ không mất | T-04 | [ ] `db:status` đúng [ ] proof rollback trên DB test |
| **G-9 Threat model** | 1 trang THREAT-MODEL: token flow, CSP, localStorage, rate-limit, CORS, register gate, pool_accounts plaintext + control | T-12 | [ ] `docs/THREAT-MODEL.md` đủ 9 mục + control |
| **G-10 Observability** | `/health` đúng; log JSON có runId; metric dbWriteFail/workerRestarts đếm được; không `[DEBUG-LOGIN]` | T-07, T-08 | [ ] `/health` degraded khi DB down [ ] log JSON [ ] grep `[DEBUG-LOGIN]` = 0 |

---

## 9. Phụ lục A — Map PRD item → task

| PRD item | Task | PRD item | Task | PRD item | Task |
|---|---|---|---|---|---|
| F-1..F-5 | (giữ — không task) | S-1..S-5 | (giữ — không task) | C-1 | (giữ) |
| F-6 | T-08 | S-6 | T-06 (tách module) | C-2 | T-03 |
| F-7 | T-08 | S-7 | T-06 | C-3 | T-03 |
| F-8 | T-08 | S-8 | T-12 (document) | C-4 | T-03 |
| F-9 | T-08 | S-9 | T-03 | SEC-1 | T-01 |
| F-10 | T-08 | S-10 | T-06 | SEC-2 | T-06 |
| F-11 | T-09 | S-11 | T-06 | SEC-3 | T-08 |
| L-1..L-4 | (giữ) | S-12 | T-07, T-12 | SEC-4 | T-08, T-12 |
| L-5 | T-09 | D-1..D-3 | (giữ) | SEC-5 | T-06 |
| L-6 | T-09, T-12 | D-4 | T-04 | SEC-6 | T-06 |
| L-7 | T-09 | D-5 | T-05 | SEC-7 | T-03 |
| O-1 | (giữ) | D-6 | T-05 | SEC-8 | T-01 |
| O-2 | T-07 | D-7 | T-05 | T-1 | (giữ) |
| O-3 | T-07 | D-8 | T-12 (threat model) | T-2 | T-09 |
| O-4 | T-07 | D-9 | T-04, T-12 | T-3 | T-10 |
| O-5 | T-07 | D-10 | T-05 (Q-2) | T-4 | T-10 |
| | | | | T-5 | T-02 |
| | | | | T-6 | T-11 |
| | | | | T-7 | T-11 |
| | | | | T-8 | T-11 |

---

## 10. Phụ lục B — Lệnh vận hành sau refactor (mục tiêu)

```bash
# DB
npm run loadtest:db:up          # migration up (tạo schema + schema_version)
npm run loadtest:db:down        # rollback 1 bước
npm run loadtest:db:status      # xem version hiện tại
npm run loadtest:db:cleanup -- --older-than 30d   # retention thủ công (không chạy nền)

# Dev
npm run dev                     # frontend (Vite, proxy /api/loadtest → 3401)
npm run loadtest:server         # loadtest server (tsx) — fail-fast nếu DB không lên

# Quality
npm run typecheck
npm run loadtest:typecheck
npm run test                    # vitest (root: loadtest + frontend)
npm run loadtest:test           # vitest (loadtest, skip nếu không DB)
npm run loadtest:mutation       # stryker (pure modules)
npm run lint                    # eslint (mới)
npm run secret:scan             # gitleaks (mới)

# Build / deploy
npm run build                   # tsc + vite build
docker build -f docker/Dockerfile.frontend .
docker build -f docker/Dockerfile.loadtest .
```

---

## Workflow Architect review (2026-08-04)

> Review độc lập theo lens workflow/sequencing/dependencies/gates. Verify thực tế trên code: `loadtest/config.ts`, `loadtest/db/store.ts`, `loadtest/db/init.ts`, `loadtest/db/writer.ts`, `loadtest/api-server.ts`, `loadtest/server.ts`, `loadtest/coordinator.ts`, `loadtest/auth.ts`, `loadtest/auth-factory.ts`, `loadtest/socket-farm.ts`, `loadtest/util.ts`, `loadtest/.env.example`, `loadtest/__tests__/*`, `src/lib/{env,api,socket}.ts`, `src/store/auth.store.ts`, `index.html`, `.gitignore`, `package.json`, `vite.config.ts`, `loadtest/vitest.config.ts`, `gateway-auth-service/.../websocket.gateway.ts:148-149`, `auth.controller.ts:314`. Mọi file:line trong plan đều khớp code hiện tại (đã đối chiếu).

### (a) Xác nhận đúng (confirmed-correct)

- **T-01/T-02** — `.gitignore:11-14` chỉ chặn `.env`/`.env.*`; secret thật (`loadtest/data/auth-secret.json`, `accounts-*.json`) đúng là untracked và sẽ vào history nếu commit. `loadAuthSecret` env→file→random đúng (`auth.ts:73-89`). W0 trước mọi commit là đúng.
- **T-03** — `config.ts:70-115` default cho mọi key; `config.ts:104` + `db/init.ts:27` default credential `appuser:secret`; `newRunId()` collision thật (`config.ts:219-225`, `runSeq` reset 0); allowlist default `localhost:3000` (`config.ts:82-85`).
- **T-04** — `store.ts:159-169` `ensureSchema` chạy `schema.sql` + INSERT version 1; `init.ts:94-98` cùng pattern; `writer.ts:38-49` startup gọi `ensureSchema`. R-1 (T-04 trước T-05) đúng và đã có hàng phòng vệ (runner throw, không nuốt).
- **T-05** — `store.ts:19` `setTypeParser(20, Number)`; `store.ts:132-149` connect fail → `disabled=true`; `store.ts:173-192` query trả `[]` khi lỗi; `store.ts:355-358` countMetricSamples trả 0 giả; `writer.ts:256` `mtimeMs` float vào `created_at BIGINT`.
- **T-06** — CORS `*` (`api-server.ts:76-79`); `readBody` swallow lỗi → `{}` (`api-server.ts:95-105`); register public (`api-server.ts:387-401`); không rate-limit; shutdown không timeout tổng (`server.ts:41-49`); idempotent start 409 (`coordinator.ts:105-106`).
- **T-07** — logger text `[lt][INFO][ts]` (`util.ts:28-43`); `/health` chỉ `{status:'ok'}` (`api-server.ts:141`); ring buffer 500 + subscribe (`util.ts:13-26`).
- **T-08** — `env.ts:13` default `/auth/refresh` SAI; gateway thật `POST /auth/refresh-token` (`auth.controller.ts:314`); `auth.store.ts:44-86` `[DEBUG-LOGIN]`; `socket.ts:84-98` query token; `index.html:1-21` không CSP; `.env.example:8-9` sai endpoint.
- **T-09** — `loadtest/vitest.config.ts:6-8` chỉ include `loadtest/__tests__/**` (0 test cho `src/`); `loadtest/auth.ts:15` SESSION_TTL_MS 12h.
- **T-10** — `package.json:7-15` scripts; `package.json:47-60` devDeps; chưa có `.github/` hay `docker/` (đã verify — phải tạo mới).
- **T-11** — `api-server.test.ts` tồn tại (contract test DB-gated); `store.test.ts` skip-if-no-DB; `websocket.gateway.ts:148-149` chấp nhận query + header.
- **T-12** — `docs/` đã có đủ docs tham chiếu; chưa có THREAT-MODEL/Dockerfile.
- Wave map + critical path (`T-01→T-02→T-03→T-04→T-05→T-06→T-07→T-10→T-11→T-12`) nhất quán sau các fix dưới đây.

### (b) Findings đã fix inline (severity)

**🔴 CRITICAL**

1. **Dependency cycle T-05 ↔ T-07 và T-06 ↔ T-07 → deadlock wave**.
   - Plan gốc: T-05 deps `T-07 (companion — counter dbWriteFail)`; T-06 deps `T-07 (companion — counter apiErrors)`; T-07 deps `T-05 + T-06`. Đây là 2 cycle: T-05→T-07→T-05 và T-06→T-07→T-06. Với wave tuần tự W1 (T-05) → W2 (T-06, T-07), T-05 phụ thuộc task ở wave SAU là không thể chạy; T-06/T-07 phụ thuộc vòng nhau → không chọn được thứ tự.
   - **Đã fix**: T-05 tự tạo `loadtest/tool-metrics.ts` (counter `dbWriteFail`/`dbRetry`, gauge tối thiểu) — KHÔNG phụ thuộc T-07; T-06 thêm counter `apiErrors` vào module đó + sinh `requestId` ngay trong task này — KHÔNG phụ thuộc T-07; T-07 mở rộng `tool-metrics.ts` + tiêu thụ requestId (deps giữ `T-05, T-06` — giờ hợp lệ, bất kỳ).
2. **T-03 acceptance "grep `appuser:secret` = 0" là sai khi sửa chữa**.
   - Chuỗi còn tồn tại ở `loadtest/.env.example:24` (default credential thật) và `loadtest/__tests__/api-server.test.ts:15`, `store.test.ts:11` (test DB URL default). Grep toàn repo = 0 sẽ fail oan.
   - **Đã fix**: thêm cập nhật `loadtest/.env.example:24` → placeholder vào T-03 "Làm"; scope acceptance chỉ còn runtime config (`config.ts`, `db/init.ts`, `.env.example`); test fixture được loại trừ rõ ràng (ghi chú "test-only").

**🟠 MAJOR**

3. **T-06 register gate (default false) làm ĐỎ `loadtest:test` từ T-06 đến T-11**.
   - `api-server.test.ts:89-113, 166-170` kỳ vọng register → 200 (hiện register public). Sau khi T-06 thêm gate default false, các test này fail; plan gốc đẩy việc sửa test sang T-11, nhưng milestones M2 (W2 gate G-3) và T-10 (CI chạy `loadtest:test`) yêu cầu suite xanh trước đó.
   - **Đã fix**: T-06 "Làm" bắt buộc cập nhật ngay `api-server.test.ts` (set `LOADTEST_ALLOW_REGISTER=true` trong env override của `beforeAll`).
4. **T-10 CI không chạy test frontend (T-09) mà G-1/W3 gate yêu cầu**.
   - T-09 acceptance: `npm run test` chạy cả loadtest + frontend; CI step gốc chỉ có `loadtest:test`; `npm run test` chưa tồn tại trong `package.json`.
   - **Đã fix**: T-10 CI thêm step `test (frontend — T-09)`; T-09 đã có quyền tạo script `test` root.
5. **Gate CI (G-4/G-5) không thể verify: repo chưa có remote GitHub** (Q-1: "repo chưa push remote"). CI acceptance "xanh 2 OS" cần remote thật.
   - **Đã fix**: T-10 ghi rõ tiền đề — nếu chưa có remote, verify thủ công + TODO hoàn thiện khi push; cần sync với user về remote (sibling dùng Jenkins, PRD R-8).
6. **T-08 bỏ sót `loadtest/socket-farm.ts:97`** — PRD F-8/SEC-3 liệt kê CẢ `src/lib/socket.ts:87` lẫn `loadtest/socket-farm.ts:96` (đã verify: `socket-farm.ts:93-98` gửi `query: { token }`). Plan gốc chỉ fix frontend.
   - **Đã fix**: T-08 thêm `loadtest/socket-farm.ts:93-98` vào file:line + Làm.
7. **`docker/nginx.conf` thiếu SPA fallback** — app react-router (`/loadtest`, `/chat`, `/login`); F5/direct nav không có `try_files` → 404.
   - **Đã fix**: T-12 nginx.conf thêm `try_files $uri $uri/ /index.html;`.

**🟡 MINOR**

8. **Phát biểu "gateway ưu tiên header" sai** — `websocket.gateway.ts:148-149` đọc **query trước**, header là fallback. Kết quả chức năng sau khi bỏ query vẫn đúng (header fallback hoạt động), nhưng mô tả sai. **Đã fix** wording trong T-08.
9. **`SimpleRateLimiter` (`auth-factory.ts:133-150`) không phải per-IP 429 limiter** — nó là limiter tốc độ chờ (`acquire()`), không đếm fail theo IP, không trả 429. Plan gốc "dùng SimpleRateLimiter có sẵn → 429" không đúng. **Đã fix**: T-06 thiết kế `rate-limit.ts` mới (token bucket per IP, zero-dep).
10. **T-03 acceptance "DB không lên → fail fast" không test được cho tới T-05** — `connect()` throw là T-05, T-03 chỉ validate env keys. **Đã fix**: ghi chú "verified ở M1".
11. **`GET /metrics` (T-07) va chạm tên với `/api/loadtest/metrics`** — route hiện có là tick-history dashboard (`api-server.ts:217-224`). **Đã fix**: T-07 chỉ định path khác (`/metrics` hoặc `/api/loadtest/tool-metrics`).
12. **gitleaks như npm devDependency mong manh** — gitleaks là binary Go; npm wrapper không chuẩn trên Windows. **Đã fix**: T-02 đề xuất `gitleaks/gitleaks-action` trong CI + binary/script cho pre-commit.
13. **CSP `script-src 'self'` chặn Vite dev** — @vitejs/plugin-react inject inline preamble react-refresh. **Đã fix**: T-08 ghi rõ dev cần `'unsafe-inline'` hoặc CSP riêng, prod giữ chặt.

### (c) Dependency re-order đã áp dụng

- **T-05**: `[T-04, T-07]` → `[T-04]` (tự tạo `tool-metrics.ts`).
- **T-06**: `[T-03, T-05, T-07]` → `[T-03, T-05]` (tự thêm `apiErrors`, sinh requestId; kèm sửa test đi kèm).
- **T-07**: giữ `[T-05, T-06]` — giờ acyclic (T-05 W1, T-06 → T-07 trong W2).
- Critical path không đổi: `T-01→T-02→T-03→T-04→T-05→T-06→T-07→T-10→T-11→T-12`.

### Open question cho human

- **Remote GitHub cho CI**: T-10 gate (G-4/G-5 "CI xanh 2 OS") chỉ chứng minh được sau khi push repo lên GitHub (Q-1 hiện "chưa push"). Cần xác nhận remote/URL trước khi vào W4, hoặc chấp nhận verify thủ công + TODO.
- **gitleaks npm package**: xác nhận chọn `gitleaks-action` (CI) hay npm wrapper T-02; nếu npm wrapper không có binary Windows, T-02 cần đổi cách cài.