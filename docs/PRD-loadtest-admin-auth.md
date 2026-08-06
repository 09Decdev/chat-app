# PRD: Xác thực Quản trị viên + Khởi tạo Database cho LoadTest Dashboard

**Status**: Draft — chờ review
**Author**: Alex (BA/PM)
**Version**: 0.1 — 2026-08-04
**Repo**: `C:\MAYogu_VIASG\chat-app`
**Stakeholders**: Đội tool/backend (chat-app, gateway-auth-service, content-service)
**Liên kết PRD cũ**: `docs/PRD-loadtest-run-database.md` (v0.1) — PRD này **kế thừa toàn bộ mô hình dữ liệu** của PRD cũ (Run / Pool / PoolAccount / MetricSample / LogEvent), bổ sung **Module Admin Auth** + **màn Login/Register** + **phần khởi tạo database thực tế** (schema + script + file db).

**Quyết định đã chốt (không bàn lại)**:
1. Cần **tạo tài khoản để vào được trang quản trị** — đăng ký/login admin account để truy cập dashboard loadtest.
2. **Bắt đầu sinh database** — khởi tạo database thực tế (schema + file db) cho cả admin accounts lẫn các bảng loadtest đã đề xuất trong PRD cũ.

---

## 0. Tóm tắt điều hành

Dashboard loadtest hiện **không có bất kỳ xác thực nào**: mọi endpoint `/api/loadtest/*` đều mở, CORS `*` (`api-server.ts:53-57`), và toàn bộ route trên React SPA `/loadtest/*` truy cập tự do (`src/App.tsx:52-59`, comment `App.tsx:51`: "tool nội bộ, không cần auth chat"). Dashboard đang đi qua Vite proxy `/api/loadtest` (`vite.config.ts:15-22`) nên **bất kỳ website nào chạy trong cùng máy đều có thể gọi API loadtest** — chạy/pause/dừng run, đọc config, xóa cleanup.

Toàn bộ dữ liệu run (ticks 1s, report, summary, logs) nằm trong **memory** của coordinator process; restart server là mất trắng (phân tích chi tiết ở PRD cũ §1). Chỉ có file pool JSON (`loadtest/data/accounts-*.json`) và report file (`docs/loadtest-reports/{runId}/`) sống sót qua restart.

**PRD này giải quyết 2 việc**:
1. **Admin Auth** — đăng ký/login admin account, session có chữ ký, gate toàn bộ API + SPA dashboard.
2. **Khởi tạo database** — đã tạo thực tế `loadtest/db/schema.sql` (DDL 7 bảng) + `loadtest/db/init.ts` (script khởi tạo + seed admin), dùng **SQLite local** tại `loadtest/data/loadtest.db` (như PRD cũ đã chốt). *Lưu ý: file `.db` chưa được sinh ra trong lần này do môi trường agent không có shell để chạy lệnh — xem §2.4 (BLOCK) — lệnh tạo chỉ là 1 dòng.*

**Phạm vi MVP**: register/login/session admin + gate API/SPA + màn Login/Register + toàn bộ luồng ghi DB (run + ticks + pool + logs) + API đọc lịch sử + màn History/Replay (kế thừa PRD cũ) + migration pool JSON cũ. So sánh run, retention tự động, Postgres là v1.1/Future.

---

## 1. Hiện trạng rút từ code

### 1.1 API server — routes hiện tại, KHÔNG có auth

| # | Quan sát | Dẫn chứng |
|---|----------|-----------|
| 1.1.1 | Toàn bộ 15 endpoint `/api/loadtest/*` (health, config, start, stop, kill, pause, resume, status, metrics, users, errors, logs, report, report/export, allowlist, cleanup, pools) đều **không kiểm tra bất kỳ credential nào** — không guard, không header, không session | `api-server.ts:103-273` |
| 1.1.2 | CORS mở toàn bộ `*`, cho phép `Authorization` header | `api-server.ts:53-57` |
| 1.1.3 | Server bind `127.0.0.1` mặc định (an toàn tương đối), nhưng dashboard đi qua Vite proxy nên website khác trên cùng máy vẫn gọi được API trực tiếp | `config.ts:90`; `vite.config.ts:15-22` |
| 1.1.4 | `/logs` đọc `logHistory` ring buffer **500** trong memory (`util.ts:13-23`) | `api-server.ts:199-202` |
| 1.1.5 | `/report` đọc `latestReport` memory; 404 nếu chưa có report | `api-server.ts:204-209` |
| 1.1.6 | `/metrics` đọc `coordinator.tickHistory` memory (ring buffer 3600) | `api-server.ts:174-181`; `coordinator.ts:23,37,402-406` |
| 1.1.7 | `/status` đọc `getRunSnapshot()` memory | `api-server.ts:165-172`; `coordinator.ts:506-515` |
| 1.1.8 | `/pools` đọc `listPools` từ file JSON | `api-server.ts:269-271`; `auth-factory.ts:86-107` |
| 1.1.9 | `/cleanup` đọc pool file JSON (`auth-factory.ts:82-84`) | `api-server.ts:250-258` |

### 1.2 Coordinator — dữ liệu chỉ sống trong memory

| # | Dữ liệu | Lưu ở đâu | Dẫn chứng |
|---|---------|-----------|-----------|
| 1.2.1 | Run ticks 1s (ring buffer 3600) | Memory | `coordinator.ts:23,37,402-406` |
| 1.2.2 | Report + file ghi lúc `finishRun` | Memory + file | `coordinator.ts:38,446-488`; `report.ts:284-297` |
| 1.2.3 | Provision summary (registered/loggedIn/failed/errors) | Memory | `coordinator.ts:52,168` |
| 1.2.4 | Error samples (max 50) | Memory | `coordinator.ts:93-96,344-345` |
| 1.2.5 | Log từ worker qua IPC | Memory (`ltLog`) | `coordinator.ts:275-280` |
| 1.2.6 | `start()` (điểm tạo Run row) | — | `coordinator.ts:100-121` |
| 1.2.7 | Kill-switch path | — | `coordinator.ts:230-233` |
| 1.2.8 | `aggregateTick` 1s (nguồn MetricSample) | — | `coordinator.ts:295-400` |

### 1.3 Auth Factory — pool lưu file JSON

- `poolPath` = `dataDir/accounts-{runId}.json` (`auth-factory.ts:82-84`); `listPools` đọc file (`auth-factory.ts:86-107`); reuse pool đọc file + login lại (`auth-factory.ts:149-190`); `persistPool` ghi file (`auth-factory.ts:297-308`).
- Cấu trúc `TestAccount` (email, password, userId, token, deviceInfo...) tại `types.ts:63-79`.
- Bug "reuse pool ghi log không đầy đủ": result per-account chỉ cộng dồn vào bộ đếm memory, không có bản ghi per-account (PRD cũ §1.9).

### 1.4 Dashboard frontend (React SPA trong chat-app)

| # | Quan sát | Dẫn chứng |
|---|----------|-----------|
| 1.4.1 | Route `/loadtest` → `AppShell` với 6 trang: ControlPanel, Live, Scenario, Report, Settings, Cleanup — **không có auth gate** | `src/App.tsx:52-59` |
| 1.4.2 | Comment "tool nội bộ, không cần auth chat" — không dùng lại auth store của chat | `src/App.tsx:51` |
| 1.4.3 | API client axios baseURL `/api/loadtest`, **không gắn auth header** | `src/lib/loadtest-api.ts:18` |
| 1.4.4 | Store zustand poll 1s (`pollOnce`) | `src/store/loadtest.store.ts:165-192` |
| 1.4.5 | AppShell: poll 1s khi run chạy, layout sticky header + bottom nav | `src/components/loadtest/app-shell.tsx:199-241` |

### 1.5 Dependencies & runtime

- `package.json`: **không có** sqlite driver, **không có** bcrypt/argon2, **không có** jsonwebtoken. Có `tsx` (devDependency) và `@types/node ^22.10.2` (⇒ runtime Node ≥ 22).
- Toolserver chạy `node:http` thuần, không framework — mọi thêm mới phải theo phong cách plain TS module hiện tại (`loadtest/`).

---

## 2. Database — thiết kế + trạng thái khởi tạo

### 2.1 Chọn driver SQLite

| Tiêu chí | `node:sqlite` (built-in) | `better-sqlite3` (npm) |
|---|---|---|
| Cài đặt | **Không cần** — Node ≥ 22.5 có sẵn | Cần `npm i better-sqlite3 --no-save` |
| Cách bật | Node 22.5–22.12 cần flag `--experimental-sqlite`; từ 22.13/23.4 không cần flag (còn ExperimentalWarning) | Không cần flag |
| API | `DatabaseSync` — sync, giống better-sqlite3 | sync, mature |
| **Kết luận** | **Chọn làm driver chính** — zero thêm dep | Fallback (script tự báo lỗi nếu thiếu) |

Script `init.ts` tự động: thử `node:sqlite` trước → fallback `better-sqlite3` → báo lỗi rõ ràng. **Không cần npm install** cho luồng chính.

### 2.2 Vị trí file & cấu hình

- File DB: `loadtest/data/loadtest.db` (cùng `dataDir` — `config.ts:101`; thêm env `LOADTEST_DB_PATH` để override).
- Thư mục mới: `loadtest/db/` chứa `schema.sql` + `init.ts`.
- **Cần thêm `.gitignore`**: `loadtest/data/*.db*` (ghi vào backlog triển khai — ngoài phạm vi file mới của PRD này).

### 2.3 Mô hình dữ liệu — 7 bảng (đã đồng nhất với PRD cũ)

| Bảng | Cột chính (tên cột snake_case; PRD cũ camelCase ghi chú trong DDL) | Mục đích |
|---|---|---|
| **admin_users** *(mới)* | `id`, `username UNIQUE`, `email UNIQUE`, `password_hash` (scrypt), `display_name`, `role` ('admin'/'viewer'), `is_active`, `created_at`, `updated_at`, `last_login_at` | Admin account cho dashboard — đăng ký/login |
| **runs** | `run_id PK`, `status`, `machine_id`, `start_at`, `end_at`, `duration_sec`, `gateway_url`, `target_users`, `worker_count`, `config_json` (RunConfig, `types.ts:33-49`), `summary_json` (summary+perAction+errors+bottlenecks), `stop_reason`, `pool_source_run_id`, `created_at`, `updated_at` | 1 hàng/run — tạo lúc `start()`, finalize lúc `finishRun()` |
| **pools** | `pool_id PK` (= runId tạo pool), `gateway_url`, `target_users`, `account_count`, `registered`, `logged_in`, `failed`, `errors_json`, `reused_by_run_ids_json`, `imported_from_file`, `created_at` | 1 hàng/pool; `reusedByRunIdsJson` = runId đã reuse |
| **pool_accounts** | `id PK`, `pool_id FK`, `email`, `password`, `user_id`, `display_name`, `device_info_json`, `date_of_birth`, `country`, `registered_at`, `status` ('registered'/'logged_in'/'failed'), `last_error_code`, `last_used_run_id`, `last_login_at`, `UNIQUE(pool_id, email)` | Per-account outcome — giải bug §1.9 |
| **metric_samples** | `id PK`, `run_id FK`, `ts`, `phase`, `elapsed_sec`, 15 cột counters (users_created…rate_limited_no_echo), `success_rate`, `echo_rate`, `actions_per_sec_json`, `latency_json`, `errors_json`, `server_json`, `workers_json` | Tick 1s tổng hợp (`LoadTestTick`, `types.ts:139-168`) — không lưu WorkerTick thô |
| **log_events** | `id PK`, `run_id FK`, `ts`, `level`, `msg` | Log bền vững từng run |
| **schema_version** | `version PK`, `applied_at` | Auto-migration đơn giản (Module D2 PRD cũ) |

**Quyết định thiết kế ghi chú** (kế thừa PRD cũ §2.3):
- **Không lưu accessToken/refreshToken** — token TTL 1h, reuse luôn login lại (`auth-factory.ts:164-172`).
- **`otpSecret` tuyệt đối không vào DB** — chỉ trong env (`config.ts:93`, `.env.example:18`).
- **`password` của pool account có lưu** (bắt buộc reuse login) — môi trường TEST, chấp nhận plaintext trong SQLite local (quyết định PRD cũ §8).
- **`machine_id`** (`os.hostname()`) — runId sinh theo `Date.now()` local (`config.ts:219-223`) có thể trùng giữa máy; cột này phân biệt khi Future dùng DB chung.

### 2.4 Trạng thái khởi tạo — file đã tạo + ⚠️ BLOCK

**File đã tạo (trong scope lần này):**

| File | Mô tả |
|---|---|
| `loadtest/db/schema.sql` | DDL 7 bảng + index + WAL/synchronous=NORMAL/foreign_keys=ON |
| `loadtest/db/init.ts` | Script khởi tạo: mở DB, chạy schema, seed admin (`--seed-admin`), verify bảng (`--verify`) |

**⚠️ BLOCK — chưa sinh được file `loadtest.db` thật trong lần này.**
Môi trường agent làm việc **không có shell để thực thi lệnh** (không chạy được `node`/`npx`), nên script `init.ts` đã viết đầy đủ nhưng **chưa được chạy**. Đây không phải vấn đề thiếu dependency — driver `node:sqlite` là built-in Node ≥ 22.5, không cần cài gì. **Việc tạo file DB chỉ còn 1 lệnh**, người dùng chạy từ repo root `chat-app/`:

```bash
# Cách 1: chạy trực tiếp qua tsx (đã có trong devDependencies)
npx tsx loadtest/db/init.ts                # tạo schema + in bảng
npx tsx loadtest/db/init.ts --seed-admin   # + seed admin mặc định (password phát sinh, in 1 lần)

# Cách 2: nếu Node 22.5–22.12 (cần flag experimental)
node --experimental-sqlite --import tsx loadtest/db/init.ts --seed-admin

# Verify bảng tồn tại (chạy lại cùng script, hoặc mở bằng sqlite3 CLI)
npx tsx loadtest/db/init.ts --verify
# Kỳ vọng: 7 bảng — admin_users, runs, pools, pool_accounts, metric_samples, log_events, schema_version
```

**Verify thủ công** (nếu có `sqlite3` CLI):
```bash
sqlite3 loadtest/data/loadtest.db ".tables"
# → admin_users  log_events  metric_samples  pool_accounts  pools  runs  schema_version
```

**Seed admin mặc định**: username `admin` / email `admin@loadtest.local`, password **phát sinh ngẫu nhiên** (in ra console 1 lần, không ghi vào DB), hash bằng **scrypt** (`node:crypto`, không cần bcrypt/argon2). Không cài secret thật; chỉ dùng cho dev local. Idempotent: chạy lại không tạo trùng.

### 2.5 Đường chuyển đổi từ file JSON hiện tại (kế thừa PRD cũ §2.5)

1. **Import legacy (MVP, tự động lúc startup)**: quét `dataDir/accounts-*.json` (`auth-factory.ts:86-107`), upsert vào `pools` + `pool_accounts` với `imported_from_file`; **không xóa file gốc**; idempotent.
2. Sau import, `listPools` đọc DB trước, fallback file khi chưa import.
3. `persistPool` (`auth-factory.ts:297-308`) chuyển sang ghi DB; per-account outcome lưu `status`/`last_error_code`.
4. Report file `docs/loadtest-reports/{runId}/` giữ nguyên — DB là nguồn query, file là artifact export.

---

## 3. Danh sách tính năng theo module

### Module A — Admin Auth (xác thực quản trị viên)

| ID | Tính năng | Nhãn | Lý do |
|---|---|---|---|
| A1 | **Register admin**: `POST /api/loadtest/auth/register` (username, email, password) — hash scrypt, UNIQUE username/email | **MVP** | Yêu cầu chốt: "tạo tài khoản để vào được trang quản trị" |
| A2 | **Login**: `POST /api/loadtest/auth/login` → trả session token (HMAC-SHA256, payload `{ sub, username, exp }`, TTL 12h) | **MVP** | Cửa vào dashboard |
| A3 | **Session + verify**: module `auth` dùng `node:crypto` HMAC (không cần dep JWT); secret từ env `LOADTEST_AUTH_SECRET` hoặc tự sinh + lưu `dataDir/auth-secret.json` (sessions sống qua restart) | **MVP** | Không thêm dependency, bám phong cách plain TS của `loadtest/` |
| A4 | **Logout + `/auth/me`**: xóa session client-side; `GET /auth/me` trả `{ id, username, email, displayName, role }` | **MVP** | SPA cần biết trạng thái đăng nhập |
| A5 | **Đổi mật khẩu** (`POST /auth/change-password`, cần session) | v1.1 | Chưa chặn MVP; dev local ít account |
| A6 | **Remember me / refresh session** (TTL 30 ngày, session mới) | v1.1 | Đơn giản hóa login sau này |
| A7 | **Role viewer** (chỉ xem, không chạy run) | Future | Chưa có nhu cầu nhóm; mọi account đều admin cho MVP |

### Module B — Database (schema + init + migration)

| ID | Tính năng | Nhãn | Lý do |
|---|---|---|---|
| B1 | **Schema + init**: `schema.sql` + `init.ts` (đã tạo file — xem §2.4) | **MVP** ✅ file đã tạo | Yêu cầu chốt "bắt đầu sinh database" |
| B2 | **Import legacy pool JSON** (tự động, idempotent, giữ file gốc) | **MVP** | Pool 10k–100k account không tạo lại |
| B3 | **Crash-detect**: row `running` còn sót → `error` lúc startup; Run row tạo ở `start()` | **MVP** | "Không run nào biến mất" |
| B4 | **Backup/export DB** (`.backup` hoặc CSV) | v1.1 | Data cỡ MB, copy file đủ cho MVP |
| B5 | **Postgres (shared DB)** cho cluster nhiều máy | Future | Khi target 1M (PRD gốc v1.1) |

### Module C — Dashboard bảo vệ (gate routes)

| ID | Tính năng | Nhãn | Lý do |
|---|---|---|---|
| C1 | **Gate API**: mọi route `/api/loadtest/*` (trừ `/health`, `/auth/*`) yêu cầu `Authorization: Bearer <token>` hợp lệ → 401 nếu thiếu/sai/hết hạn | **MVP** | Chặn website khác cùng máy gọi API (`api-server.ts:53-57` CORS `*`) |
| C2 | **Gate SPA**: route `/loadtest/*` chưa đăng nhập → redirect `/loadtest/login` (check `/auth/me` khi mount) | **MVP** | "Vào được trang quản trị" = phải có tài khoản |
| C3 | **Màn Login + Register** (xem §7) | **MVP** | Yêu cầu chốt |
| C4 | **API client xử lý 401**: axios interceptor thêm `Authorization` header; khi nhận 401 → clear session + redirect login | **MVP** | Đồng bộ giữa SPA và API |
| C5 | **Session persistence client**: token lưu localStorage (dev tool, chấp nhận cho MVP — xem Câu hỏi mở #1) | **MVP** | Sống qua refresh trang |

### Module D — History / Replay (kế thừa PRD cũ)

| ID | Tính năng | Nhãn | Lý do |
|---|---|---|---|
| D1 | **API lịch sử**: `GET /runs` (list + filter status/gateway), `GET /runs/{id}` (detail + report), `GET /runs/{id}/metrics`, `GET /runs/{id}/logs`, `DELETE /runs/{id}` | **MVP** | Điều kiện để màn History hoạt động sau restart |
| D2 | **Màn History** (danh sách run từ DB, filter, mở run cũ) | **MVP** | Yêu cầu "xem lại số liệu từng lần chạy" |
| D3 | **Màn Run Detail (Replay)** (KPI summary + chart từ MetricSample + logs từ DB) | **MVP** | Cùng D2 |
| D4 | **So sánh 2+ run** (side-by-side) | v1.1 | Sau khi history ổn định |
| D5 | **Log viewer UI** (filter, jump-to-error) | v1.1 | MVP đọc qua API/JSON là đủ |

---

## 4. User story + acceptance criteria — MVP

### US-1: Đăng ký admin account

**Với tư cách** kỹ sư loadtest, **tôi muốn** đăng ký một tài khoản admin (username/email/password) **để** có quyền truy cập trang quản trị dashboard.

**Acceptance criteria**:
- [ ] `POST /api/loadtest/auth/register` với body hợp lệ → 200 `{ success, data: { id, username, email, displayName, role } }`; response **không chứa** password_hash.
- [ ] Trong DB, `admin_users.password_hash` lưu dạng `scrypt$16384$8$1$<salt>$<hash>` (không phải plaintext).
- [ ] Đăng ký trùng `username` hoặc `email` → 409 `{ success:false, statusCode:409, message }`, không tạo bản ghi mới.
- [ ] Password < 8 ký tự hoặc không đủ 3/4 nhóm ký tự (chuẩn `genPassword`, `util.ts:57-70`) → 400 kèm message rõ ràng.
- [ ] Route register **không** yêu cầu token (public); sau register, account login được ngay.

### US-2: Đăng nhập và giữ phiên

**Với tư cách** kỹ sư loadtest, **tôi muốn** đăng nhập bằng username/email + password và giữ phiên qua các lần refresh trang **để** không phải nhập lại mật khẩu mỗi lần mở dashboard.

**Acceptance criteria**:
- [ ] `POST /api/loadtest/auth/login` đúng → 200 `{ success, data: { token, expiresAt, user } }`; token là payload `base64url.hmac` chữ ký HMAC-SHA256, `exp` = now + 12h.
- [ ] Login sai password → 401 `{ success:false, statusCode:401 }`, không lộ thông tin account tồn tại hay không.
- [ ] Token giả mạo/thay đổi payload → 401 (verify HMAC, không phải decode).
- [ ] Token hết hạn → 401 kèm message "phiên hết hạn, đăng nhập lại".
- [ ] `GET /api/loadtest/auth/me` với token hợp lệ → 200 trả `{ id, username, email, displayName, role }`; với token lỗi → 401.

### US-3: Dashboard yêu cầu đăng nhập (gate)

**Với tư cách** kỹ sư loadtest, **tôi muốn** toàn bộ dashboard và API loadtest chỉ truy cập được khi đã đăng nhập admin **để** người khác (kể cả website cùng máy) không thể chạy/dừng loadtest hoặc đọc cấu hình.

**Acceptance criteria**:
- [ ] Mọi route `/api/loadtest/*` (trừ `/health`, `/auth/*`) gọi thiếu/thiếu token hoặc token sai → 401 theo convention `{ success:false, statusCode:401, message }`.
- [ ] Mở `/loadtest` hoặc `/loadtest/live` khi chưa đăng nhập → SPA redirect sang `/loadtest/login` (không render nội dung dashboard).
- [ ] Đăng nhập xong → quay lại `/loadtest` hiển thị đầy đủ (ControlPanel, Live, Report, Settings, Cleanup).
- [ ] Sau khi logout, gọi lại bất kỳ API protected nào → 401 và SPA redirect login.
- [ ] Thời gian verify token mỗi request ≤ 1ms (HMAC local, không DB lookup) — không ảnh hưởng polling 1s dashboard.

### US-4: Khởi tạo database và seed admin

**Với tư cách** developer, **tôi muốn** chạy 1 lệnh để tạo đầy đủ database (schema + admin mặc định) **để** hệ thống sẵn sàng chạy mà không cần thao tác thủ công.

**Acceptance criteria**:
- [ ] `npx tsx loadtest/db/init.ts` tạo file `loadtest/data/loadtest.db` (hoặc `LOADTEST_DB_PATH`) với đủ 7 bảng: `admin_users, runs, pools, pool_accounts, metric_samples, log_events, schema_version`.
- [ ] Chạy lại lệnh init (idempotent) → không lỗi, không tạo bảng trùng, không ghi đè dữ liệu có sẵn.
- [ ] `--seed-admin` tạo admin `admin@loadtest.local`, hash scrypt, in password **1 lần**; chạy lại không tạo admin trùng.
- [ ] `npx tsx loadtest/db/init.ts --verify` in danh sách bảng + số hàng; DB chưa tồn tại → báo lỗi hướng dẫn chạy init trước.
- [ ] `PRAGMA journal_mode = wal` có hiệu lực (query `PRAGMA journal_mode` trả `wal`).

### US-5: Liệt kê lịch sử run sau restart

**Với tư cách** kỹ sư loadtest, **tôi muốn** sau khi restart server vẫn liệt kê được toàn bộ run đã chạy (run phiên trước, run bị kill, run auto-stop) **để** không phải đoán từ trí nhớ và báo cáo chính xác.

**Acceptance criteria**:
- [ ] `GET /api/loadtest/runs` trả danh sách run từ DB, kể cả run của phiên trước (không chỉ memory hiện tại).
- [ ] Mỗi row gồm tối thiểu: runId, status, startAt, endAt, durationSec, gatewayUrl, targetUsers, stopReason, machineId.
- [ ] Filter theo status (`finished`/`stopped`/`error`/`running`), sắp xếp mặc định startAt giảm dần.
- [ ] DB trống (lần đầu) → trả mảng rỗng, không lỗi.
- [ ] Thời gian phản hồi list ≤ 500ms với 500 run.

### US-6: Xem đầy đủ số liệu 1 run cũ (report + chart) sau khi run không còn trong memory

**Với tư cách** kỹ sư loadtest, **tôi muốn** mở 1 run cũ xem đầy đủ report + chart metrics **để** phân tích kết quả không phụ thuộc việc server vừa chạy run đó.

**Acceptance criteria**:
- [ ] `GET /api/loadtest/runs/{id}` trả cấu hình + summary + per-action + top errors + bottlenecks tương đương `RunReport` (`types.ts:192-218`) — tái dựng từ `summary_json`/`config_json`, không cần `buildReport` lại.
- [ ] `GET /api/loadtest/runs/{id}/metrics` trả ticks 1s theo thứ tự ts, hỗ trợ `limit` (mặc định 3600).
- [ ] `GET /api/loadtest/runs/{id}` với id không tồn tại → 404 theo convention.
- [ ] Số liệu summary từ DB khớp ± 0 với report file JSON cùng runId (so sánh successRate, echoRate, p95).
- [ ] Run đang `running` → API trả trạng thái `running` và ticks tính tới flush gần nhất (không chặn request).

### US-7: Migration tự động pool JSON cũ sang DB

**Với tư cách** kỹ sư loadtest, **tôi muốn** khi nâng cấp tool, toàn bộ pool ở file `dataDir/accounts-*.json` được nạp vào DB tự động **để** không phải tạo lại 10k–100k account đã có.

**Acceptance criteria**:
- [ ] Server start lần đầu với `dataDir` chứa pool cũ → `GET /api/loadtest/pools` trả pool từ DB với đầy đủ `accountCount`, `targetUsers`, `gatewayUrl`, `importedFromFile`.
- [ ] Import idempotent: restart lần 2 không tạo bản ghi trùng (không duplicate Pool/PoolAccount).
- [ ] File JSON gốc không bị xóa/sửa.
- [ ] Pool imported dùng được cho reuse ngay (login bằng email/password/deviceInfo từ DB).
- [ ] File hỏng (JSON parse fail, `auth-factory.ts:102-104`) được bỏ qua + log cảnh báo, không chặn startup.

---

## 5. User flow chính

### Flow 1 — Đăng ký admin → đăng nhập → vào dashboard

```
Mở http://localhost:5173/loadtest
  │  (chưa đăng nhập)
  ▼
GET /auth/me (SPA mount) ── 401 ──► redirect /loadtest/login
  │
  ├─ Chưa có tài khoản?
  │   └─ POST /auth/register {username, email, password}     [A1]
  │        └─ 200 { id, username, email } → về /loadtest/login
  │
  └─ POST /auth/login {username|email, password}             [A2]
       └─ 200 { token, expiresAt } → lưu localStorage
            └─ axios interceptor gắn Authorization: Bearer   [C4]
                 ▼
       Redirect /loadtest → AppShell render đầy đủ           [C2]
```

### Flow 2 — Chạy loadtest → dữ liệu ghi DB (kế thừa PRD cũ)

```
POST /api/loadtest/start  (đã login)
  │
  ├─ coordinator.start() ──────────────► DB: INSERT runs (status=running, config_json)   [B3]
  │
  ├─ provisionAccounts() ──────────────► DB: UPSERT pools + pool_accounts (per-account
  │                                       status/error_code) + log_events                 [B2]
  │
  ├─ worker farm chạy (ramping/steady)
  │     │  worker ticks (IPC 1s)
  │     ▼
  │  aggregateTick (memory ring buffer giữ nguyên cho dashboard LIVE)
  │     └─ flush batch mỗi ~30s ───────► DB: INSERT metric_samples (batch)                [A2]
  │
  ├─ finishRun (natural/auto/manual/kill)
  │     ├─ flush ticks còn lại ────────► DB: metric_samples cuối
  │     ├─ finalize ───────────────────► DB: UPDATE runs (status, stop_reason, summary_json)
  │     └─ saveReportFiles (giữ nguyên export file; DB là nguồn query)
  │
  └─ GET /api/loadtest/runs/{id} (sau restart) ──► đọc từ DB, không phụ thuộc memory
```

### Flow 3 — Xem kết quả sau restart

```
Khởi động lại server (memory mất, DB còn)
  │
  ├─ startup: DB open + auto-migration + import legacy pools + crash-detect
  │           (runs status=running còn sót → error)                                       [B3]
  │
  ├─ GET /api/loadtest/runs ──────────► Màn History: danh sách run (status badge, filter)
  │
  ├─ GET /api/loadtest/runs/{id} ─────► Màn Run Detail: summary KPI + report (từ summary_json)
  │
  ├─ GET /api/loadtest/runs/{id}/metrics ─► Màn Run Detail: replay chart (từ metric_samples)
  │
  └─ GET /api/loadtest/runs/{id}/logs ────► logs JSON (MVP) / log viewer (v1.1)
```

### Flow 4 — Initialize DB + seed admin (bootstrap)

```
npx tsx loadtest/db/init.ts --seed-admin
  │
  ├─ mở loadtest/data/loadtest.db (hoặc LOADTEST_DB_PATH)
  │     ├─ node:sqlite (built-in) / fallback better-sqlite3
  │     ├─ exec schema.sql (7 bảng + index + WAL)                                         [B1]
  │     └─ INSERT OR IGNORE schema_version (1)
  │
  ├─ seed admin (nếu --seed-admin): scrypt hash + in password 1 lần
  │
  └─ printVerify: danh sách bảng + số hàng
       → user dùng password để vào /loadtest/login
```

---

## 6. Điểm đặc thù của miền

| # | Đặc thù | Mô tả | Hệ quả thiết kế |
|---|---|---|---|
| 6.1 | **Admin auth local, không OAuth/production identity** | Tool dev nội bộ chạy 1 máy, bind `127.0.0.1` (`config.ts:90`); không cần SSO, không cần 2FA, không cần quên mật khẩu | Register/login/session đơn giản trong chính DB local; HMAC token bằng `node:crypto` — **không thêm dep**; không dùng lại auth store của chat (`App.tsx:51`) |
| 6.2 | **Secret hash = scrypt (không cần bcrypt/argon2)** | Password admin cần hash ký tự mạnh; `node:crypto` có sẵn `scryptSync` (N=16384, r=8, p=1) | `password_hash` = `scrypt$16384$8$1$<salt>$<hash>`; verify lại bằng `scryptSync` + `timingSafeEqual` |
| 6.3 | **Không lưu OTP secret vào DB** | OTP secret chỉ trong env (`config.ts:93`, `.env.example:18`) — nếu lọt DB là lộ khả năng seed OTP thật | `admin_users`/DB không có cột OTP; `otpSecret` chỉ env |
| 6.4 | **Database single-writer (chỉ coordinator ghi)** | Worker fork gửi tick qua IPC (`worker-farm.ts:55-97`); logs hội tụ tại coordinator (`coordinator.ts:275-277`) | Không lock, không race; WAL + `synchronous=NORMAL` cho dashboard đọc song song (`PRD cũ §2.4`) |
| 6.5 | **High-frequency metrics** | Ticks 1s/run (`coordinator.ts:209`); run 60 phút = 3600 tick; tới 100k action/s khi đo (`metrics.ts:6`) | Batch insert (flush ~30s/500 tick) + WAL; KHÔNG lưu WorkerTick thô, chỉ `LoadTestTick` tổng hợp (`coordinator-state.ts:88-194`) |
| 6.6 | **Run gắn với máy/dataDir** | `dataDir='./loadtest/data'` (`config.ts:101`); runId sinh theo `Date.now()` local (`config.ts:219-223`) | DB đặt trong `dataDir` (đi theo máy); cột `machine_id` phân biệt khi Future dùng DB chung |
| 6.7 | **Migration dữ liệu pool JSON cũ** | Pool hiện là file `accounts-{runId}.json` (`auth-factory.ts:82-84,297-308`), đọc qua `listPools` (`auth-factory.ts:86-107`) | Import tự động lúc startup, idempotent, giữ file gốc; `persistPool` chuyển sang ghi DB |
| 6.8 | **Dashboard poll 1s từ memory giữ nguyên** | Dashboard poll API 1s (`src/store/loadtest.store.ts:165-192`); DB là lớp bền vững song song | Contract API LIVE không đổi; verify token HMAC ≤ 1ms không ảnh hưởng polling |
| 6.9 | **Report file là artifact, DB là nguồn query** | `saveReportFiles` (`report.ts:284-297`) | Giữ nguyên export file; DB đủ tái dựng report (config_json + summary_json) |

---

## 7. Danh sách màn hình cần design

Theo đúng design system tối (dark-first, token HSL, tabular-nums — `docs/UI-SPEC-loadtest-tool.md` Mục 0/1):

| Màn | Tên | Mô tả (2-3 dòng) | Nhãn |
|---|---|---|---|
| Màn L | **Login** | Form username/email + password, nút "Đăng nhập", link "Chưa có tài khoản? Đăng ký". Hiển thị lỗi 401 (sai mật khẩu) / hết hạn phiên. Sau thành công → redirect về `/loadtest` (hoặc màn định đi). | MVP |
| Màn R | **Register** | Form username + email + password (+ confirm), yêu cầu mật khẩu ≥ 8 ký tự đủ 3/4 nhóm. Hiển thị lỗi trùng username/email. Sau đăng ký → về Login kèm message "đăng ký thành công". | MVP |
| Màn 1-7 | **Dashboard (live) hiện tại** | Giữ nguyên (ControlPanel, Live, Scenario, Report, Settings, Cleanup) — chỉ thêm: header hiển thị tên admin + nút Logout; mọi request đã gắn Bearer token. | MVP (gate) |
| Màn 8 | **History** | Danh sách run từ DB: status badge (finished/stopped/error/running), startAt, duration, targetUsers, gatewayUrl, stopReason. Filter theo status + search runId. Bấm 1 row mở Màn 9; nút xóa run (kèm confirm). | MVP |
| Màn 9 | **Run Detail (Replay)** | Tái hiện KPI summary (từ summary_json), chart replay từ metric_samples (cùng bộ chart Màn 2, `isAnimationActive=false`), top errors + bottlenecks, tab logs (JSON đơn giản MVP). Badge "LIVE" nếu run đang chạy, "HISTORY" nếu đã kết thúc. | MVP |

---

## 8. Câu hỏi mở (tối đa 3)

1. **Session token lưu ở đâu?** — Khuyến nghị: `Authorization: Bearer` + localStorage (đơn giản, đúng phong cách plain TS/axios hiện tại; chấp nhận rủi ro XSS local cho tool dev). Phương án khác: HttpOnly cookie (an toàn hơn nhưng cần cookie parsing + CSRF handling trong `node:http` thuần). Chốt: theo khuyến nghị?
2. **Mọi account đăng ký đều là admin?** — Khuyến nghị: **có** cho MVP (tool nội bộ, ít người dùng); cột `role` đã có sẵn để mở rộng viewer (Future). Chốt: theo khuyến nghị?
3. **Session TTL** — Khuyến nghị: 12h cố định cho MVP (không refresh token); nếu cần "remember me" thì đưa vào v1.1 (A6). Chốt: 12h ổn?

---

## Phụ lục — Bản đồ hiện trạng tham chiếu (file:dòng)

- `api-server.ts:53-57` — CORS `*` (không nguồn auth)
- `api-server.ts:103-273` — 15 endpoint không guard
- `api-server.ts:165-172,174-181,199-202,204-209,269-271` — API đều đọc memory/file
- `coordinator.ts:23,37,402-406` — ring buffer ticks 3600
- `coordinator.ts:38,446-488,480` — report memory + file lúc finish
- `coordinator.ts:52,168,475` — provision summary chỉ memory
- `coordinator.ts:100-121,230-233,275-277,295-400` — start / kill-switch / worker log / aggregateTick
- `auth-factory.ts:82-84,86-107,149-190,297-308` — poolPath / listPools / reuse / persistPool
- `types.ts:63-79,139-168,192-218` — TestAccount / LoadTestTick / RunReport
- `config.ts:90,101-102,219-223` — host / dataDir / newRunId
- `util.ts:13-23` — logHistory ring buffer 500
- `src/App.tsx:51-59` — route /loadtest không auth gate
- `src/lib/loadtest-api.ts:18` — axios client không auth header
- `src/store/loadtest.store.ts:165-192` — poll 1s
- `src/components/loadtest/app-shell.tsx:199-241` — AppShell layout
- `vite.config.ts:15-22` — Vite proxy `/api/loadtest` → 3401
- `package.json` — không có sqlite/auth dep; có tsx, @types/node ^22.10.2

## File đã tạo trong lần này

| File | Loại | Mô tả |
|---|---|---|
| `docs/PRD-loadtest-admin-auth.md` | PRD | File này |
| `loadtest/db/schema.sql` | DDL | 7 bảng + index + WAL |
| `loadtest/db/init.ts` | Script | Khởi tạo DB + seed admin + verify |
| `loadtest/data/loadtest.db` | File DB | ⚠️ **CHƯA tạo** — cần chạy `npx tsx loadtest/db/init.ts` (xem §2.4 BLOCK) |