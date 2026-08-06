# PRD — Refactor production-readiness: chat-app + loadtest tool

**Status**: ✅ APPROVED — GATE 1 (2026-08-04, user duyệt)
**Author**: Product Manager (autobuild refactor)
**Version**: 0.2 — 2026-08-04
**Repo**: `C:\MAYogu_VIASG\chat-app`
**Phạm vi**: Toàn bộ `chat-app` — frontend chat (`src/`) + loadtest tool (`loadtest/` server + `src/pages/loadtest/*` UI + `loadtest/db/*`).
**Tài liệu tham chiếu (KHÔNG mâu thuẫn, kế thừa)**: `docs/PLAN.md`, `docs/ARCHITECTURE-loadtest.md`, `docs/PRD-loadtest-tool.md`, `docs/PRD-loadtest-run-database.md`, `docs/PRD-loadtest-admin-auth.md`, `docs/UI-SPEC-loadtest-tool.md`, `docs/UX-FLOW-loadtest-tool.md`, `docs/API-loadtest-tool.md`.
**Nguyên tắc chung**: **Tuân thủ kiến trúc hiện có** (không viết lại sibling services, không đổi contract gateway). Refactor theo hướng "project chuẩn từ code đến database" — mọi thay đổi phải giữ nguyên hành vi quan sát được hiện tại.

---

## 1. Context & mục tiêu

### 1.1 Vì sao

Dự án hiện tại là frontend chat + **loadtest tool tự host** (server Node/TS trong `loadtest/`, dashboard React trong `src/pages/loadtest/*`). Toàn bộ được coi là "tạm bợ / nóng vội" (theo đánh giá chủ quan của người dùng) và **chưa deployable**:

- Git chỉ có **1 commit** (`README.md`), toàn bộ code còn lại **untracked** — kể cả các file chứa **secret thật** (`loadtest/data/auth-secret.json`, `loadtest/data/accounts-*.json`).
- Không có CI, không có Docker, không có secret-scan, không có test frontend.
- Nhiều đoạn "debug tạm" còn sót (`[DEBUG-LOGIN]` trong `auth.store.ts`).
- Database dùng `schema.sql` idempotent thủ công, chưa có migration/rollback thực sự.

### 1.2 Mục tiêu (business goals)

1. **An toàn khi bị lộ** — bí mật rời khỏi working tree, được quản lý qua env; không có secret trong git history.
2. **Deployable** — có build tái lập được, CI chạy test + secret-scan + lint + typecheck, Docker doable, healthcheck.
3. **Đáng tin trong lúc chạy** — loadtest không mất metric im lặng khi DB lỗi; lỗi rõ ràng, có retry, có idempotency.
4. **Quan sát được** — log có cấu trúc, health endpoint phản ánh đúng trạng thái DB/Redis/worker, có metric của chính tool.
5. **Database chuẩn** — migration có version, có rollback, đúng schema_version, không bị float→BIGINT hay mất dữ liệu.

### 1.3 Success criteria (đo được)

- [ ] Secret scan (gitleaks) trên CI = **0 finding**; `git check-ignore` trả về đúng cho `auth-secret.json`, `accounts-*.json`, `settings.json`, `.env`.
- [ ] `npm run build`, `npm run typecheck`, `npm run loadtest:typecheck`, `npm run loadtest:test` đều xanh trên CI (Windows + Linux).
- [ ] `npm run loadtest:test` có coverage ≥ 70% cho các module pure (`coordinator-state`, `metrics`, `report`, `config`, `auth`, `password`, `db/store`).
- [ ] Migration runner: `up` tạo schema từ 0; `down` rollback bảng đúng; chạy 2 lần idempotent.
- [ ] Loadtest server chạy được với `LOADTEST_DATABASE_URL` sai → **fail fast** (không "chạy mà không ghi history" im lặng nếu config yêu cầu DB bắt buộc).
- [ ] Không còn chuỗi `[DEBUG-LOGIN]` trong `src/`.
- [ ] Refresh token frontend gọi đúng endpoint thật của gateway (`/auth/refresh-token`).

---

## 2. Phạm vi

### 2.1 IN SCOPE

| Khu vực | Nội dung |
|---|---|
| Frontend chat | Xóa debug log, sửa refresh endpoint, thêm error boundary, bỏ token trong query string socket, CSP header, README hướng dẫn deploy. |
| Frontend loadtest UI | Không đổi hành vi; thêm test cơ bản (format helpers, store selectors), xử lý lỗi load-config nhất quán. |
| Loadtest server | Cấu trúc lại (tách controller/service/permission khỏi god classes), fail-fast config, CORS hẹp, rate-limit login/register, body-size limit, health chi tiết, structured logging, retry/idempotency. |
| Loadtest DB | Migration runner có version + rollback (thay `schema.sql` thủ công), fix float→BIGINT, phân biệt "no rows" vs "DB fail", bắt buộc DB khi cấu hình yêu cầu. |
| Config/env | `.env.example` đầy đủ (root + loadtest), validation startup, không hardcode default credential. |
| Security | Sửa `.gitignore` cho `loadtest/data/*`, xoá secret khỏi working tree (đã commit? chưa — nhưng rotate), CORS, rate-limit, registration gate. |
| Observability | Structured logger, health endpoint chi tiết, metric của tool (counter API lỗi, memory, worker). |
| Tests/build/deploy | CI workflow (GitHub Actions), Dockerfile (frontend + loadtest server), lint (eslint), secret-scan, mutation test cho pure modules, contract test cho API loadtest. |

### 2.2 OUT OF SCOPE (không làm — người dùng không yêu cầu)

- **Không viết lại / đổi contract** của `gateway-auth-service`, `content-service`, `user-community-service`.
- **Không thêm tính năng mới** cho loadtest (vd: cluster 1M+ user, auto-cleanup sau run, refresh token hàng loạt 1M user, so sánh 2 runs, retention tự động 30 ngày) — các mục này đã ghi là **v1.1/Future** trong PRD cũ.
- **Không đổi UI/UX** của dashboard loadtest (giữ nguyên UI-SPEC).
- **Không migrate sang Postgres → khác DB** (giữ Postgres như PRD-run-database đã chốt).
- **Không thêm 2FA cho admin loadtest** (MVP chưa có, ghi rõ là quyết định mở).
- **Không thêm PWA/offline/đa ngôn ngữ cho chat.**

---

## 3. Hiện trạng (ĐÃ CÓ / CẦN THÊM)

> Nguyên tắc đánh giá: **ĐÃ CÓ** = điểm đã chuẩn, giữ nguyên; **CẦN THÊM** = thiếu/hỏng cho production. Dẫn chứng `file:dòng` lấy từ code hiện tại.

### 3.1 Frontend chat

| # | ĐÃ CÓ / CẦN THÊM | Chi tiết | Dẫn chứng |
|---|---|---|---|
| F-1 | ✅ ĐÃ CÓ | Store Zustand tách đoạn, selector rõ ràng; `chat.store.ts` 872 dòng nhưng tách socket lifecycle khỏi store. | `src/store/chat.store.ts:197-813`; `src/store/auth.store.ts:17-92` |
| F-2 | ✅ ĐÃ CÓ | API client typed, error envelope chuẩn hóa (`ApiError`), 401 → refresh best-effort → clear. | `src/lib/api.ts:24-35, 49-92` |
| F-3 | ✅ ĐÃ CÓ | Socket outbox + resend (Risk 1), clientMsgId dedupe, TTL 60s. | `src/lib/socket.ts:38-226` |
| F-4 | ✅ ĐÃ CÓ | Error code → message tiếng Việt tập trung. | `src/lib/constants.ts:30-45` |
| F-5 | ✅ ĐÃ CÓ | Device fingerprint sinh bằng `crypto.getRandomValues`, UUID fallback. | `src/lib/storage.ts:18-47` |
| F-6 | ⚠️ CẦN THÊM | **Refresh endpoint SAI** — frontend mặc định `/auth/refresh` (`env.ts:13`, `api.ts:61`), gateway thật là **`POST /auth/refresh-token`** (`auth.controller.ts:314`, body `{ refreshToken }` trả `{ accessToken, refreshToken }`). | `src/lib/env.ts:13`; `src/lib/api.ts:61`; `gateway-auth-service/src/infrastructure/driving-adapters/http-rest/controllers/auth.controller.ts:314-325` |
| F-7 | ⚠️ CẦN THÊM | **Debug log sót** — `[DEBUG-LOGIN]` in deviceInfo + full error ra console (đã ghi chú "GO SAU KHI DEBUG XONG"). | `src/store/auth.store.ts:46-55, 76-83` |
| F-8 | ⚠️ CẦN THÊM | **Token trong query string** socket (`query: { token }`) — gateway chấp nhận cả header lẫn query (`websocket.gateway.ts:147-149`); nên bỏ query, chỉ `Authorization` header, tránh token rơi vào access-log/proxy. | `src/lib/socket.ts:87`; `loadtest/socket-farm.ts:96`; `gateway-auth-service/.../websocket.gateway.ts:147-149` |
| F-9 | ⚠️ CẦN THÊM | **Không có Error Boundary** — 1 lỗi render trong bất kỳ component nào sẽ trắng toàn trang. | `src/App.tsx:46-77` |
| F-10 | ⚠️ CẦN THÊM | **Không có CSP** — `index.html` không set `Content-Security-Policy`; token lưu localStorage → nếu XSS, token bị đánh cắp dễ dàng. | `index.html:1-21` |
| F-11 | ⚠️ CẦN THÊM | **Không có test frontend** — `vitest.config.ts` chỉ include `loadtest/__tests__/**`, không có test cho store/api/socket. | `loadtest/vitest.config.ts:6-8` |

### 3.2 Frontend loadtest UI

| # | ĐÃ CÓ / CẦN THÊM | Chi tiết | Dẫn chứng |
|---|---|---|---|
| L-1 | ✅ ĐÃ CÓ | Auth gate SPA + `/loadtest/*` protected; session localStorage + verify `/auth/me`. | `src/App.tsx:56-70`; `src/components/loadtest/require-auth.tsx:12-33` |
| L-2 | ✅ ĐÃ CÓ | Poll 1s chống double-interval (guard timerRef), dừng khi run kết thúc. | `src/components/loadtest/app-shell.tsx:241-253`; `src/store/loadtest.store.ts:165-192` |
| L-3 | ✅ ĐÃ CÓ | Download report qua axios (Bearer) thay vì `<a href>` (tránh 401 gate). | `src/lib/loadtest-api.ts:165-178` |
| L-4 | ✅ ĐÃ CÓ | Allowlist UI chặn cứng, confirm dialog trước start/stop. | `src/pages/loadtest/ControlPanelPage.tsx:307-314, 384-427`; `src/pages/loadtest/SettingsPage.tsx:84-123` |
| L-5 | ⚠️ CẦN THÊM | **Không có test** cho format helpers/store selectors — hiện 0 test cho toàn bộ `src/`. | `src/lib/loadtest-format.ts` (0 test); `src/store/loadtest.store.ts:215-218` |
| L-6 | ⚠️ CẦN THÊM | **Session hết hạn 12h không refresh** — `SESSION_TTL_MS = 12h` (`loadtest/auth.ts:15`), sau 12h user bị logout giữa chừng; thiếu thông báo "phiên sắp hết hạn" hoặc refresh. Chấp nhận cho MVP nhưng cần documented. | `loadtest/auth.ts:15`; `src/store/loadtest-auth.store.ts:42-47` |
| L-7 | ⚠️ CẦN THÊM | **`loadtest.prefs` trong localStorage không envelope-prove** — JSON.parse không có schema validation; ok vì self-controlled nhưng ghi rõ. | `src/store/loadtest.store.ts:29-45` |

### 3.3 Loadtest server

| # | ĐÃ CÓ / CẦN THÊM | Chi tiết | Dẫn chứng |
|---|---|---|---|
| S-1 | ✅ ĐÃ CÓ | State machine **pure/testable** (`canTransition`, `decideAutoStop`, `endPhaseFromStop`). | `loadtest/coordinator-state.ts:19-74` |
| S-2 | ✅ ĐÃ CÓ | Worker farm fork child process, heartbeat, restart backoff, kill-switch ≤ 5s. | `loadtest/worker-farm.ts:55-199` |
| S-3 | ✅ ĐÃ CÓ | Histogram log-scale 48 bucket, O(1) insert, memory cố định. | `loadtest/metrics.ts:9-108` |
| S-4 | ✅ ĐÃ CÓ | Auto-stop E1/E2/E3 + allowlist chặn cứng (SD-1) + kill-switch. | `loadtest/coordinator.ts:177-189, 382-406`; `loadtest/config.ts:126-183` |
| S-5 | ✅ ĐÃ CÓ | Auth admin HMAC-SHA256 timing-safe, scrypt password. | `loadtest/auth.ts:33-67`; `loadtest/db/password.ts:14-39` |
| S-6 | ⚠️ CẦN THÊM | **God classes** — `api-server.ts` (532d), `coordinator.ts` (537d), `socket-farm.ts` (694d) trộn orchestration + HTTP + mapping + auth; khó test/mở rộng. Đã được ARCHITECTURE-loadtest.md liệt kê (`1.2.6`). | `loadtest/api-server.ts:35`; `loadtest/coordinator.ts:32`; `loadtest/socket-farm.ts:367` |
| S-7 | ⚠️ CẦN THÊM | **`readBody` swallow lỗi JSON parse** → `{}` thay vì 400; **không giới hạn kích thước body**. | `loadtest/api-server.ts:95-105` |
| S-8 | ⚠️ CẦN THÊM | **1 coordinator = 1 run** — không hỗ trợ chạy nhiều run song song; `start()` từ chối nếu đang chạy. Chấp nhận MVP nhưng cần ghi rõ. | `loadtest/coordinator.ts:105-106` |
| S-9 | ⚠️ CẦN THÊM | **`newRunId()` collision giữa restart** — `runSeq` reset về 0 mỗi lần restart; 2 run cùng millisecond sau restart có thể trùng id. | `loadtest/config.ts:219-225` |
| S-10 | ⚠️ CẦN THÊM | **Không rate-limit** trên API loadtest (login brute-force, register spam, start/stop spam). Gateway có throttler nhưng tool không có. | `loadtest/api-server.ts:128-382` |
| S-11 | ⚠️ CẦN THÊM | **Register admin public** — ai có thể tới server đều tạo được admin. Nên đặt sau flag `LOADTEST_ALLOW_REGISTER` (mặc định off) hoặc registration token. | `loadtest/api-server.ts:387-401` |
| S-12 | ⚠️ CẦN THÊM | **Fixture post ids / REST đọc feed** — `PostIdCache` cần feed từ `/content-service/post/getAll`; nếu không có post → `NO_POST_FIXTURE`, hành vi "skip" đúng nhưng không rõ ràng trong report. | `loadtest/rest-actions.ts:20-47, 108-121` |

### 3.4 Loadtest DB

| # | ĐÃ CÓ / CẦN THÊM | Chi tiết | Dẫn chứng |
|---|---|---|---|
| D-1 | ✅ ĐÃ CÓ | Schema rõ ràng 7 bảng + `schema_version`; FK cascade; index chính. | `loadtest/db/schema.sql:16-148` |
| D-2 | ✅ ĐÃ CÓ | Single-writer (chỉ coordinator ghi), batch flush 30s/500 tick, crash-detect, import legacy pool idempotent. | `loadtest/db/writer.ts:19-20, 38-49, 213-279` |
| D-3 | ✅ ĐÃ CÓ | Best-effort write (DB lỗi không chết run), retry 1 lần, bỏ qua unique/FK violation. | `loadtest/db/store.ts:173-192` |
| D-4 | ⚠️ CẦN THÊM | **Không có migration runner thực sự** — chỉ `schema.sql` + `CREATE TABLE IF NOT EXISTS` + `INSERT schema_version 1`; đổi schema không tự áp dụng lên DB có sẵn, **không có rollback**. | `loadtest/db/store.ts:160-169`; `loadtest/db/init.ts:94-98` |
| D-5 | ⚠️ CẦN THÊM | **Bug float→BIGINT** — `importLegacyPools` dùng `fs.statSync().mtimeMs` (float) cho cột `created_at BIGINT` → insert fail im lặng. | `loadtest/db/writer.ts:256`; `loadtest/db/schema.sql:74` |
| D-6 | ⚠️ CẦN THÊM | **`query<T>` trả `[]` khi lỗi** — caller không phân biệt "no rows" vs "DB fail"; `countMetricSamples` trả 0 khi DB lỗi → mất dữ liệu im lặng. | `loadtest/db/store.ts:173-192, 355-358` |
| D-7 | ⚠️ CẦN THÊM | **Parser int8 toàn cục** — `pg.types.setTypeParser(20, v => Number(v))` biến mọi BIGINT thành number; giá trị > 2^53 mất chính xác. | `loadtest/db/store.ts:19` |
| D-8 | ⚠️ CẦN THÊM | **`pool_accounts.password` lưu plaintext** — cần thiết cho reuse login nhưng là dữ liệu nhạy cảm; cần ghi rõ ai được đọc, hoặc mã hóa (AES với key từ env). | `loadtest/db/schema.sql:84`; `loadtest/auth-factory.ts:353-364` |
| D-9 | ⚠️ CẦN THÊM | **Không có retention/cleanup dữ liệu DB** — `metric_samples` tăng 1 row/s/run; UI ghi "30 ngày" nhưng không có job. | `src/pages/loadtest/SettingsPage.tsx:194-196` |
| D-10 | ⚠️ CẦN THÊM | **DB bắt buộc/chỉ-làm-history mơ hồ** — `connect()` fail → `disabled=true` → mọi `query` trả `[]`; run vẫn chạy "không ghi history". Nên có cấu hình `LOADTEST_DB_REQUIRED` (mặc định true khi production). | `loadtest/db/store.ts:132-149` |

### 3.5 Config/env

| # | ĐÃ CÓ / CẦN THÊM | Chi tiết | Dẫn chứng |
|---|---|---|---|
| C-1 | ✅ ĐÃ CÓ | Env-driven đầy đủ, `.env.example` (root + loadtest) rõ ràng, không dùng `dotenv` (tự đọc KV). | `loadtest/config.ts:45-66`; `loadtest/.env.example`; `.env.example` |
| C-2 | ⚠️ CẦN THÊM | **Default credential hardcode trong source** — `postgresql://appuser:secret@localhost:5439/loadtest` xuất hiện 2 nơi; nên để placeholder fail-fast. | `loadtest/config.ts:104`; `loadtest/db/init.ts:27` |
| C-3 | ⚠️ CẦN THÊM | **Không validate startup** — `getEnv()` dùng default cho mọi key thiếu/typo; OTP_SECRET thiếu chỉ lỗi runtime khi register (E1). | `loadtest/config.ts:70-115`; `loadtest/coordinator.ts:159-161` |
| C-4 | ⚠️ CẦN THÊM | **Hai nguồn sự thật env** — `process.env` + `loadtest/.env` + `overrides`; thứ tự merge đúng nhưng khó debug; cần log nguồn khi verbose. | `loadtest/config.ts:70-73` |

### 3.6 Security

| # | ĐÃ CÓ / CẦN THÊM | Chi tiết | Dẫn chứng |
|---|---|---|---|
| SEC-1 | 🔴 **P0 — SECRET THẬT TRONG WORKING TREE, KHÔNG gitignore** | `loadtest/data/auth-secret.json` (HMAC secret thật), `loadtest/data/accounts-*.json` (password + access token thật, 1.3MB/file), `loadtest/data/settings.json`. `git check-ignore` trả **không khớp** cho các file này. Git mới có 1 commit, toàn bộ untracked → commit tiếp theo sẽ đưa secret vào git history. | `loadtest/data/auth-secret.json`; `loadtest/data/accounts-ltd4r7sz01.json`; `.gitignore` (chỉ `.env`, `.env.*`, `!.env.example`) |
| SEC-2 | 🟠 **P1 — CORS `*`** trên API loadtest | Kết hợp Bearer auth thì rủi ro thấp hơn, nhưng nếu token bị lộ thì bất kỳ origin nào cũng đọc được dữ liệu run. | `loadtest/api-server.ts:76-79` |
| SEC-3 | 🟠 **P1 — Token trong URL query** (socket) | Bị log ở proxy/access-log. | `src/lib/socket.ts:87`; `loadtest/socket-farm.ts:96` |
| SEC-4 | 🟠 **P1 — localStorage chứa token** (chat + loadtest) | Rủi ro XSS; chấp nhận cho SPA nhưng cần CSP + ghi rõ threat model. | `src/lib/storage.ts:75-90`; `src/lib/loadtest-auth-storage.ts:16-47` |
| SEC-5 | 🟠 **P1 — Không rate-limit** trên login/register/start/stop loadtest | Brute-force dashboard, spam run. | `loadtest/api-server.ts:128-382` |
| SEC-6 | 🟠 **P1 — Register admin public** | `POST /api/loadtest/auth/register` không cần xác thực nào. | `loadtest/api-server.ts:387-401` |
| SEC-7 | 🟡 **P2 — `LOADTEST_HOST=127.0.0.1` mặc định** tốt, nhưng `.env.example` giữ dev-only `localhost:3000` trong allowlist default — nếu deploy chung, phải bắt buộc set allowlist. | Config default `[normalizeUrl('http://localhost:3000')]`. | `loadtest/config.ts:82-85` |
| SEC-8 | 🟡 **P2 — `loadtest/.env` chứa OTP_SECRET + DB password thật** | Đã gitignore (`.env` pattern) nhưng vẫn nằm trong working tree; cần rotate nếu từng bị share. | `loadtest/.env` (gitignore khớp `.env`) |

### 3.7 Observability

| # | ĐÃ CÓ / CẦN THÊM | Chi tiết | Dẫn chứng |
|---|---|---|---|
| O-1 | ✅ ĐÃ CÓ | Logger tách biệt, ring buffer 500 cho dashboard, subscriber hook cho DB. | `loadtest/util.ts:13-49` |
| O-2 | ⚠️ CẦN THÊM | **Log không có cấu trúc** — chuỗi text `[lt][INFO][ts] msg`; không có JSON, không có requestId, không có correlation giữa API request ↔ run ↔ worker. | `loadtest/util.ts:28-43` |
| O-3 | ⚠️ CẦN THÊM | **`/health` chỉ trả `{ status: 'ok' }`** — không phản ánh DB/Redis/worker farm. | `loadtest/api-server.ts:141` |
| O-4 | ⚠️ CẦN THÊM | **Không có metric cho chính tool** — coordinator memory, API latency, worker alive, DB fail count. | `loadtest/coordinator.ts:32-68` |
| O-5 | ⚠️ CẦN THÊM | **Không có traceId** cho run — admin khó debug "run này fail ở đâu". | `loadtest/coordinator.ts:454-505` |

### 3.8 Tests/build/deploy

| # | ĐÃ CÓ / CẦN THÊM | Chi tiết | Dẫn chứng |
|---|---|---|---|
| T-1 | ✅ ĐÃ CÓ | Unit test pure modules (coordinator-state, metrics, report, config, auth, socket-farm) + integration test có DB (skip nếu không có DB). | `loadtest/__tests__/`.{test.ts} |
| T-2 | ⚠️ CẦN THÊM | **Không test frontend** (`src/`). | `loadtest/vitest.config.ts:6-8` |
| T-3 | ⚠️ CẦN THÊM | **Không CI** — không `.github/workflows`, không Jenkinsfile, không Dockerfile trong chat-app (các service sibling đều có Dockerfile + Jenkinsfile). | `git status` (untracked); `content-service/Dockerfile`; `gateway-auth-service/Dockerfile` |
| T-4 | ⚠️ CẦN THÊM | **Không lint** — không `eslint.config.*` trong package.json devDeps. | `package.json:47-60` |
| T-5 | ⚠️ CẦN THÊM | **Không secret-scan** (gitleaks/trufflehog) — SEC-1 đang chứng minh hệ quả. | — |
| T-6 | ⚠️ CẦN THÊM | **Không mutation test** — không có `stryker`. | `package.json` |
| T-7 | ⚠️ CẦN THÊM | **Không contract test** với gateway — refresh endpoint sai (F-6) là minh chứng frontend "đoán" contract. | `src/lib/env.ts:13` |
| T-8 | ⚠️ CẦN THÊM | **Không end-to-end test loadtest** với mock gateway — không có test cho `provisionAccounts`/`coordinator.start` với gateway giả. | `loadtest/__tests__/` |

---

## 4. User stories & acceptance criteria

> Mỗi story dùng mẫu **Given / When / Then**, kiểm tra được bằng test tự động hoặc thao tác thủ công script.

### 4.1 Security — secret handling (US-SEC-1)

**US-SEC-1 — Bí mật không bao giờ vào git**
- **Given** một repo chat-app mới checkout,
- **When** chạy `git check-ignore` cho `loadtest/data/auth-secret.json`, `loadtest/data/accounts-*.json`, `loadtest/data/settings.json`, `loadtest/.env`,
- **Then** tất cả trả về "ignored" với pattern cụ thể (không phải wildcard mù), và `git status` không liệt kê file nào trong `loadtest/data/`.

**US-SEC-2 — Rotate secret đã lộ**
- **Given** secret thật từng nằm trong working tree (auth-secret, OTP_SECRET, DB password),
- **When** chạy refactor,
- **Then** tạo secret mới (rotate), cập nhật `.env`, xoá file khỏi working tree, và documented trong README.

### 4.2 Security — auth dashboard (US-SEC-3)

**US-SEC-3 — Register admin có gate**
- **Given** `LOADTEST_ALLOW_REGISTER=false` (mặc định),
- **When** gọi `POST /api/loadtest/auth/register`,
- **Then** trả 403 với message rõ ràng; khi đặt `true` (dev), register hoạt động như cũ.

**US-SEC-4 — Login có rate-limit**
- **Given** tài khoản admin đúng,
- **When** gửi > 5 login sai / 60s từ cùng IP,
- **Then** API trả 429, không cho thử tiếp trong cửa sổ; login đúng trong cửa sổ vẫn hoạt động.

### 4.3 Reliability — DB (US-DB-1)

**US-DB-1 — Migration có version + rollback**
- **Given** DB trống,
- **When** chạy `npm run loadtest:db:up`,
- **Then** tạo đủ 7 bảng + `schema_version=1`; chạy lại lần 2 không lỗi (idempotent);
- **When** chạy `npm run loadtest:db:down` (bản 1),
- **Then** bảng của migration 1 được drop, `schema_version` lùi về 0.

**US-DB-2 — Không mất metric im lặng**
- **Given** DB đang lỗi tạm thời,
- **When** coordinator ghi tick,
- **Then** không throw làm chết run, nhưng: (a) đếm `dbWriteFail` vào metric của tool, (b) log cảnh báo có `runId`, (c) khi DB hồi phục, hàng đợi pending được flush (retry ít nhất 1 lần).

### 4.4 Reliability — API (US-API-1)

**US-API-1 — Body sai trả 400, không nuốt**
- **Given** gửi `POST /api/loadtest/start` với body JSON hỏng,
- **When** request tới,
- **Then** trả 400 `{ success:false, message:'JSON body không hợp lệ' }` (không phải `{}`).

**US-API-2 — Idempotent start**
- **Given** 2 request `POST /start` cùng payload **trong 1 run đang chạy**,
- **When** request thứ 2 tới,
- **Then** trả 409 `'Đang chạy'` (không spawn run thứ 2, không tạo 2 run row).

### 4.5 Config — fail-fast (US-CFG-1)

**US-CFG-1 — Config thiếu secret → fail fast**
- **Given** `LOADTEST_DATABASE_URL` sai hoặc có `LOADTEST_DB_REQUIRED=true` mà DB không lên,
- **When** chạy `npm run loadtest:server`,
- **Then** process exit code ≠ 0 với message rõ ràng (không "chạy nhưng không ghi history" im lặng).

### 4.6 Frontend — refresh token (US-FE-1)

**US-FE-1 — Refresh gọi đúng endpoint gateway**
- **Given** access token hết hạn, refresh token còn hạn,
- **When** một request REST trả 401,
- **Then** interceptor gọi `POST /auth/refresh-token` với `{ refreshToken }`, nhận access token mới, retry request cũ; UI không logout.

### 4.7 Frontend — không còn debug log (US-FE-2)

**US-FE-2 — Không in PII ra console**
- **Given** user đăng nhập,
- **When** login thành công hoặc thất bại,
- **Then** console không có chuỗi `[DEBUG-LOGIN]` và không log deviceInfo/raw response.

### 4.8 Observability — health (US-OBS-1)

**US-OBS-1 — Health phản ánh đúng trạng thái**
- **Given** server chạy, DB OK, Redis OK,
- **When** `GET /api/loadtest/health`,
- **Then** trả `{ status:'ok', db:'up', redis:'up', workers:'idle', version:'…' }`;
- **When** DB down,
- **Then** `status:'degraded'`, `db:'down'` (không 500, không phải `ok` giả).

### 4.9 Build & deploy (US-BUILD-1)

**US-BUILD-1 — CI xanh trên mọi thay đổi**
- **Given** mỗi PR/push vào main,
- **When** CI chạy,
- **Then** các bước `install → secret-scan → lint → typecheck → build → loadtest:test → coverage` đều xanh; secret-scan fail nếu có secret mới.

---

## 5. Non-functional requirements

### 5.1 Security

- **Secret handling**: mọi secret qua env (`LOADTEST_AUTH_SECRET`, `LOADTEST_OTP_SECRET`, `LOADTEST_DATABASE_URL`, `LOADTEST_REDIS_URL`). Không hardcode. `.gitignore` thêm: `loadtest/data/*` (với `!loadtest/data/.gitkeep` nếu cần), `loadtest/settings.json`, hoặc explicit `loadtest/data/auth-secret.json`, `loadtest/data/accounts-*.json`, `loadtest/data/settings.json`. **Rotate** mọi secret đã từng nằm trong working tree.
- **Auth storage**: token chat + loadtest trong localStorage (giữ kiến trúc hiện tại) nhưng **thêm CSP** và ghi rõ threat model (XSS → token theft). Loadtest token: cân nhắc chuyển sang `sessionStorage` (tool nội bộ, không cần sống qua tab đóng) — **quyết định mở Q-4**.
- **Input validation**: `readBody` trả 400 khi JSON hỏng; giới hạn body ≤ 1MB; validate `targetUsers/rampRate/durationMin/profile` (đã có ở `validateRunRequest` — giữ); validate `gatewayUrl` qua allowlist (giữ).
- **Rate limiting**: login/register: 5 fail/60s/IP; `/start`: 1 request/10s; toàn bộ API: đơn giản token bucket per IP (không cần thêm dependency — dùng `SimpleRateLimiter` có sẵn ở `auth-factory.ts:133-150`).
- **CORS**: thay `*` bằng `CORS_ORIGIN` env (mặc định `http://localhost:5173`); khi chạy cluster thì đặt origin thật.
- **Socket token**: bỏ `query: { token }`, chỉ dùng `Authorization` header (gateway hỗ trợ cả 2 — giữ khả năng tương thích nếu gateway cần query, nhưng ưu tiên header).
- **Password**: giữ scrypt (`db/password.ts`); không đổi thuật toán.
- **Registration**: `LOADTEST_ALLOW_REGISTER` (mặc định `false`).

### 5.2 Reliability

- **Error handling**: mọi lỗi API trả envelope `{ success, statusCode, message, errors?, warnings? }` nhất quán (đã có ở `api-server.ts:87-93` — chuẩn hoá thêm `timestamp` + `error` code).
- **Retry**: 
  - HTTP action (loadtest→gateway): giữ retry 1 lần cho 5xx/timeout, không retry 4xx (`rest-actions.ts:73-87`).
  - DB write: giữ retry 1 lần + **đếm fail** vào metric; không retry lỗi định thức (`22P02`, `23505/23503`).
  - Socket CORS/polling: socket.io client đã có reconnect — giữ.
- **Idempotency**: `POST /start` khi đang chạy → 409; `POST /cleanup` idempotent (dry-run flag); `DELETE /runs/{id}` idempotent (đã có — `db/store.ts:307-310`).
- **Graceful shutdown**: giữ `SIGINT/SIGTERM` handler (`server.ts:41-49`); thêm timeout tổng ≥ 10s để không treo.
- **Backpressure**: giữ outbox limit (`env.maxPendingOutbox`), histogram memory cố định.

### 5.3 Observability

- **Structured logging**: logger ghi JSON `{ ts, level, runId?, workerId?, requestId?, msg, context? }`; giữ ring buffer cho dashboard (compat) nhưng thêm sink file (JSON Lines) với rotation.
- **Health endpoint**: `GET /health` trả `{ status, db, redis, workers, version, uptime }` — status `ok|degraded|down`.
- **Metrics của tool**: counter `apiErrors`, `dbWriteFail`, `dbRetry`, `workerRestarts`, `runFinished`; gauge `coordinator.rssMb`, `worker.alive`. Expose qua `GET /metrics` (Prometheus text) hoặc tối thiểu log định kỳ 5s.
- **TraceId per run**: sinh `runId` (đã có) + gắn vào log DB (`log_events.run_id`), report, file name.

### 5.4 Configurability

- `.env` là nguồn duy nhất; `.env.example` liệt kê đủ mọi key + comment mô tả.
- **Startup validation**: `getEnv()` có `validateEnv()` → fail fast với danh sách key thiếu/sai (khi `NODE_ENV=production` hoặc `LOADTEST_DB_REQUIRED=true`).
- Không hardcode credential (bỏ default `appuser:secret`).
- Cấu hình host/port/allowlist/maxTarget/maxDuration giữ nguyên.

### 5.5 Database

- **Migration**: thư mục `loadtest/db/migrations/` với `001_init.sql` + runner (`npm run loadtest:db:up/down/status`); `schema_version` giữ; mỗi migration có `up` + `down`.
- **Rollback**: mỗi migration có `down`; `db:down` hỗ trợ rollback 1 bước.
- **Fix**: float→BIGINT (dùng `Math.trunc`), parser int8 chỉ ở biên (KHÔNG `setTypeParser` toàn cục), phân biệt `QueryResult<{ ok:true, rows } | { ok:false, error }>`.
- **Retention**: script `db:cleanup --older-than 30d` (không tự chạy nền — tránh scope creep; document trong README).
- **Backup**: document `pg_dump` trong README; không tự động.

### 5.6 Testing

- **Unit** (không cần DB/Redis): `coordinator-state`, `metrics`, `report`, `config`, `auth`, `password`, `util`, `http` — mục tiêu line coverage ≥ 80%.
- **Integration** (cần Postgres test, skip nếu thiếu): `store`, `api-server` — giữ pattern hiện tại, thêm test migration runner.
- **Contract**: test `api-server` đóng vai trò contract cho frontend; thêm **type check 2 chiều** `types/loadtest.ts` ↔ `loadtest/types.ts` (đã có comment, chưa có test).
- **Mutation**: bật stryker cho `coordinator-state`, `metrics`, `config`, `report` — mutation score ≥ 70%.
- **E2E loadtest**: test `coordinator.start` với **mock gateway** (HTTP server giả trả envelope chuẩn) — không cần gateway thật.

### 5.7 Build & deploy

- **CI** (GitHub Actions): matrix `ubuntu-latest` + `windows-latest`; steps: `install → secret-scan (gitleaks) → lint → typecheck (root + loadtest) → build → loadtest:test → coverage`.
- **Dockerfile**: 2 stage cho frontend (build → nginx/alpine, có healthcheck `wget /healthz`); 1 stage cho loadtest server (node:22-alpine, `tsx loadtest/server.ts`, healthcheck `fetch /api/loadtest/health`).
- **Secret-scan**: `gitleaks` trong CI với `fail-on-any`; pre-commit hook gitleaks + husky.
- **Healthcheck**: frontend `/healthz` (nginx) + loadtest `/api/loadtest/health`.

### 5.8 Performance budgets (cho load tool)

| Budget | Giá trị | Ghi chú |
|---|---|---|
| Tick aggregation | ≤ 1s/lần | `coordinator.ts:216` interval 1s |
| API poll latency (status+metrics) | p95 ≤ 300ms local | `loadtest.store.ts` poll 1s |
| Histogram insert | O(1) | `metrics.ts:38-43` |
| Log ring buffer | 500 entries | `util.ts:14` |
| Worker CPU | cảnh báo > 85% | `report.ts:173-180` |
| Coordinator memory | monitor rssMb, không có budget cứng MVP | `socket-farm.ts:660` |
| Outbox/user | ≤ `env.maxPendingOutbox` (default 1000) | `config.ts:104` |

---

## 6. Risks & unknowns

| # | Rủi ro | Mức | Ứng phó |
|---|---|---|---|
| R-1 | **Secret thật đang trong working tree** (SEC-1) — commit tiếp theo sẽ đưa vào git history; nếu repo push lên remote → lộ vĩnh viễn. | 🔴 Critical | Xử lý **trước tiên**: thêm `.gitignore`, rotate toàn bộ secret, xoá file; nếu repo đã push remote, **force-rewrite history** hoặc xoá remote + đổi mọi secret. |
| R-2 | **Refresh endpoint gateway không được document** trong PRD cũ (chỉ ghi "giả định theo convention") — endpoint thật là `/auth/refresh-token`. | 🟠 High | Xác nhận với team gateway; fix `env.ts` default; thêm contract test. |
| R-3 | **Không biết chính xác cách gateway /metrics hoạt động** (scrape `ws_connections`, `ws_messages_emitted_total`) — có thể 401/lỗi format. | 🟡 Medium | `scrapeGatewayMetrics` đã bỏ qua lỗi (`coordinator.ts:447-449`); document + degrade gracefully. |
| R-4 | **Migration runner mới có thể đụng DB đang có dữ liệu** — `schema.sql` IF NOT EXISTS không alter; migration phải handle "bảng đã tồn tại nhưng thiếu cột". | 🟡 Medium | Migration `001` = baseline detect + `CREATE TABLE IF NOT EXISTS`; migration sau = `ALTER`, có `down`. |
| R-5 | **`pool_accounts.password` plaintext** — nếu DB test bị lộ, password của hàng nghìn user test lộ. | 🟡 Medium | AES-GCM với key từ env (hoặc chấp nhận + document vì là user test). |
| R-6 | **`LOADTEST_DB_REQUIRED` mới có thể làm vỡ workflow dev** (ai không có DB sẽ không chạy được server). | 🟡 Medium | Mặc định `false` trong dev, `true` trong production (`NODE_ENV`). |
| R-7 | **CORS hẹp phá Vite proxy cùng máy** — proxy `changeOrigin: true` vẫn gửi origin Vite; cần đặt `CORS_ORIGIN` đúng. | 🟡 Medium | `CORS_ORIGIN` mặc định `http://localhost:5173`; document. |
| R-8 | **Không có sẵn CI runner** — chưa biết repo có GitHub Actions hay không (sibling dùng Jenkins). | 🟡 Medium | Cung cấp cả `.github/workflows` + Jenkinsfile stub; chọn theo quyết định mở Q-5. |

---

## 7. Các quyết định mở cần người duyệt (max 5)

| # | Quyết định | Options | Đề xuất |
|---|---|---|---|
| Q-1 | **Bí mật đã lộ — xử lý git history thế nào?** | (a) Chỉ rotate + xoá file khỏi working tree, giữ commit history cũ (repo chưa push remote). (b) Force-rewrite history (nếu đã push remote, mọi clone phải re-clone). | **(a) rotate + xoá khỏi working tree** — repo chưa có remote/push, không cần rewrite; thêm secret-scan để chặn lần sau. |
| Q-2 | **DB có bắt buộc không?** | (a) `LOADTEST_DB_REQUIRED` mặc định `false` (giữ hành vi hiện tại: chạy không history). (b) Mặc định `true` — server không start nếu DB lỗi. | ✅ **ĐÃ CHỐT (GATE 1): (b) luôn bắt buộc** — `LOADTEST_DB_REQUIRED` mặc định `true`, server không start nếu DB không lên. Load test = lưu history, không có DB thì không chạy. |
| Q-3 | **Migration runner — tự viết hay thêm dependency?** | (a) Tự viết runner ~150 dòng (phong cách "zero-dep" hiện tại). (b) `node-pg-migrate` / `drizzle-kit`. | **(a) tự viết runner** — giữ đúng tinh thần "zero-dep, plain TS module" của `loadtest/`; migration = số thứ tự + `up/down` SQL file. |
| Q-4 | **Token loadtest: localStorage hay sessionStorage?** | (a) Giữ localStorage (sống qua tab đóng, đúng PRD C5). (b) Chuyển sessionStorage (tool nội bộ, giảm XSS surface). | **(a) giữ localStorage** — đã chốt trong PRD-loadtest-admin-auth C5; thêm CSP + document threat model. |
| Q-5 | **CI dùng gì?** | (a) GitHub Actions (nếu repo trên GitHub). (b) Jenkinsfile (nếu repo dùng Jenkins như 3 sibling services). | ✅ **ĐÃ CHỐT (GATE 1): (a) GitHub Actions** — workflow `.github/workflows/ci.yml` matrix ubuntu-latest + windows-latest, kèm gitleaks. |

---

## 8. Definition of Done (map tới ASSURANCE hard-gates)

> Mỗi mục refactor coi là "XONG" khi vượt qua ĐỦ các cổng sau:

| # | Cổng (hard-gate) | Tiêu chí | Tài liệu/Kiểm chứng |
|---|---|---|---|
| G-1 | **Tests** | `npm run loadtest:test` xanh (unit + integration); coverage ≥ 70% cho pure modules; **có test mới cho mọi bug fix** (regression). | `loadtest/__tests__/`; CI report |
| G-2 | **Mutation** | Stryker mutation score ≥ 70% cho `coordinator-state`, `metrics`, `config`, `report`. | `npm run loadtest:mutation` |
| G-3 | **Contract** | API loadtest contract test (api-server) xanh; `types/loadtest.ts` ↔ `loadtest/types.ts` khớp (type-check 2 chiều); refresh endpoint frontend khớp gateway (`/auth/refresh-token`). | `loadtest/__tests__/api-server.test.ts`; CI |
| G-4 | **Type/lint/build** | `npm run typecheck`, `npm run loadtest:typecheck`, `npm run build` xanh; eslint clean (0 error, 0 warning). | CI |
| G-5 | **SAST / secret-scan** | Gitleaks **0 finding** trên toàn bộ repo (không tính file test-fixture có secret giả dạng `test-secret`); `git check-ignore` khớp `loadtest/data/*` + `*.env`. | CI (gitleaks `fail-on-any`); `git check-ignore` |
| G-6 | **Code review** | Mỗi PR ≥ 1 reviewer độc lập; reviewer xác nhận **không đổi contract gateway**, **không đổi hành vi UI** (trừ lỗi rõ). | PR template |
| G-7 | **Reality check** | Chạy thật: `npm run loadtest:server` + dashboard + 1 run nhỏ (≤ 5k user, 5 phút) trên test env → report đầy đủ; ghi lại file report mẫu. | `docs/loadtest-reports/`; ghi chú run |
| G-8 | **Migration rollback** | `db:up` → `db:down` → `db:up` trên DB test: 0 lỗi, `schema_version` đúng, dữ liệu cũ không bị mất khi `up` lại. | `npm run loadtest:db:status` |
| G-9 | **Auth/PII threat model** | Document 1 trang threat model (trong README hoặc `docs/`): luồng token (chat + loadtest), CSP, localStorage risk, rate-limit, CORS, register gate, `pool_accounts.password` plaintext — và xác nhận từng mục đã có control. | `docs/THREAT-MODEL.md` (mới) |
| G-10 | **Observability** | `/health` trả đúng trạng thái; log JSON có `runId`; metric `dbWriteFail`/`workerRestarts` đếm được; không còn `[DEBUG-LOGIN]`. | thủ công + test |

---

## Phụ lục A — Lệnh vận hành sau refactor (mục tiêu)

```bash
# DB
npm run loadtest:db:up          # migration up (tạo schema + schema_version)
npm run loadtest:db:down        # rollback 1 bước
npm run loadtest:db:status      # xem version hiện tại

# Dev
npm run dev                     # frontend (Vite, proxy /api/loadtest → 3401)
npm run loadtest:server         # loadtest server (tsx)

# Quality
npm run typecheck
npm run loadtest:typecheck
npm run loadtest:test           # vitest (unit + integration, skip nếu không DB)
npm run loadtest:mutation       # stryker (pure modules)
npm run lint                    # eslint (mới)
npm run secret:scan             # gitleaks (mới)

# Build / deploy
npm run build                   # tsc + vite build
docker build -f docker/Dockerfile.frontend .
docker build -f docker/Dockerfile.loadtest .
```

## Phụ lục B — Danh sách file cần tạo/sửa (TẠO MỚI) cho refactor

> Chỉ là bản đồ tham chiếu — chi tiết theo từng phase trong `ARCHITECTURE-loadtest.md`.

- `.gitignore` — thêm `loadtest/data/*`, `loadtest/settings.json`, `*.tsbuildinfo` (đã có 2 file tsbuildinfo bị untracked).
- `.github/workflows/ci.yml` (hoặc `Jenkinsfile` theo Q-5).
- `docker/Dockerfile.frontend`, `docker/Dockerfile.loadtest`, `docker/nginx.conf`.
- `loadtest/db/migrations/001_init.sql` (+ `up.sql`/`down.sql` hoặc runner tự parse).
- `loadtest/db/migrate.ts` — runner migration.
- `loadtest/logger.ts` — structured JSON logger (backward-compat với `util.ts`).
- `loadtest/health.ts` — health check endpoint logic.
- `loadtest/rate-limit.ts` — token bucket per IP (dùng `SimpleRateLimiter` có sẵn).
- `docs/THREAT-MODEL.md`.
- `src/components/ErrorBoundary.tsx`.
- `src/test/` — vitest cho frontend (format helpers, store selectors).