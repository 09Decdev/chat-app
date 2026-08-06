# PRD: Cơ sở dữ liệu lưu trữ LoadTest Tool — Run History + Account Pool + Logs

**Status**: Draft — chờ review
**Author**: Alex (BA/PM)
**Version**: 0.1 — 2026-08-03
**Repo**: `C:\MAYogu_VIASG\chat-app`
**Stakeholders**: Đội tool/backend (chat-app, gateway-auth-service, content-service)
**Quyết định đã chốt (không bàn lại)**: cần database lưu (a) danh sách user/account pool và (b) log + số liệu từng lần chạy (run history) — thay cho hiện trạng "restart server là mất trắng data".

---

## 0. Tóm tắt điều hành

LoadTest Tool (`loadtest/`, chạy qua `npm run loadtest:server` → `tsx loadtest/server.ts`) hiện giữ **toàn bộ số liệu của run trong memory** của coordinator process. Restart server (hoặc run bị kill) = mất ticks, report, provision summary, logs. Chỉ có 2 thứ sống sót qua restart: file account pool JSON trong `dataDir` (`loadtest/data/accounts-{runId}.json`) và file report đã ghi lúc run kết thúc bình thường (`docs/loadtest-reports/{runId}/`). Ngoài ra không có danh sách/index nào cho các run cũ — sau restart, API chỉ phục vụ run đang chạy hoặc run vừa kết thúc trong memory (`api-server.ts:204-209`).

**Giải pháp đề xuất (PRD này)**: thêm một **SQLite database local** (file `loadtest/data/loadtest.db`, thư mục `loadtest/data/` mới) làm nơi lưu bền vững cho:

1. **Run** — 1 hàng/run: cấu hình, status, start/end, stopReason, summary, top errors, bottlenecks, per-action.
2. **MetricSample** — ticks 1s của run (high-frequency, batch insert, có thể tắt).
3. **Pool + PoolAccount** — account pool chuyển từ file JSON sang bảng; có per-account status (registered / logged_in / failed + error code) để hết bug "reuse pool log không đầy đủ".
4. **LogEvent** — log của từng run (hiện là ring buffer 500 trong memory, `util.ts:13-23`).

Chọn SQLite vì: zero hạ tầng, phù hợp tool dev chạy local 1 máy, mỗi run 60 phút ≈ 3600 ticks ≈ vài MB — quá nhỏ so với năng lực SQLite. Postgres chỉ cần khi chạy cluster nhiều máy (target 1M, v1.1 của PRD loadtest gốc) — khi đó chỉ cần đổi repository layer (xem §2.4).

**Phạm vi MVP**: toàn bộ luồng ghi (run + ticks + pool + logs) + API đọc lịch sử + màn History/Replay trong dashboard có sẵn + migration file JSON cũ. So sánh run, retention tự động, Postgres là v1.1/Future.

---

## 1. Hiện trạng rút từ code

| # | Dữ liệu | Lưu ở đâu hiện tại | Sống qua restart? | Dẫn chứng |
|---|---------|--------------------|-------------------|-----------|
| 1.1 | **Run ticks 1s** (toàn bộ số liệu run) | Memory: `tickHistory` ring buffer giới hạn **3600 ticks** trong `LoadTestCoordinator` | ❌ MẤT | `coordinator.ts:23,37,402-406` (`TICK_HISTORY_LIMIT = 3600`, `pushTick` shift khi quá hạn) |
| 1.2 | **Run report** | (a) Memory: `latestReport` (b) File: `docs/loadtest-reports/{runId}/report-{runId}.json|.md` + `metrics-{runId}.csv`, chỉ ghi ở `finishRun` | ⚠️ File sống, nhưng chỉ khi run **kết thúc bình thường**; không có index để liệt kê/query run cũ | `coordinator.ts:38,446-488,480`; `report.ts:284-297`; API chỉ trả `latestReport` memory: `api-server.ts:204-209,211-228` |
| 1.3 | **Provision summary** (registered/loggedIn/failed/errors) | Memory: `provisionSummary` | ❌ MẤT | `coordinator.ts:52,168`; chỉ được đếm 1 số `provisioned` vào report: `coordinator.ts:475` |
| 1.4 | **Error samples** (mẫu lỗi gần nhất) | Memory: `errorSamplesPrivate`, max 50 | ❌ MẤT | `coordinator.ts:93-96,344-345` |
| 1.5 | **Account pool** | File JSON: `dataDir/accounts-{runId}.json` chứa `{ runId, targetUsers, gatewayUrl, accounts: TestAccount[] }` | ✅ SỐNG — đọc lại qua `listPools` | `auth-factory.ts:82-84,86-107,297-308`; `config.ts:101` (`dataDir='./loadtest/data'`) |
| 1.6 | **Logs** | Memory: `logHistory` ring buffer **500** | ❌ MẤT | `util.ts:13-23`; API `/logs`: `api-server.ts:199-202` |
| 1.7 | **Settings** (allowlist bổ sung) | File `dataDir/settings.json` | ✅ SỐNG (ngoài phạm vi PRD này) | `config.ts:255-270` |
| 1.8 | **Run index / lịch sử run** | KHÔNG TỒN TẠI — coordinator chỉ biết run hiện tại | ❌ | `coordinator.ts:33-38`; `api-server.ts:165-172` (`/status` từ `getRunSnapshot()` memory) |

### 1.9 Bug gần đây: "run tái sử dụng pool ghi log không đầy đủ" — root cause

Luồng reuse pool (`auth-factory.ts:149-190`):

- `useExistingAccounts` → `listPools(env.dataDir).find(targetUsers + gatewayUrl)` (`auth-factory.ts:149-150`).
- Login lại từng account, kết quả chỉ **cộng dồn vào bộ đếm memory**: `summary.loggedIn++` / `summary.failed++` / `summary.errors[code]++` (`auth-factory.ts:169-181`). **Không có bản ghi per-account** nào cho biết email nào fail với mã lỗi nào.
- Chỉ account login thành công được push vào `summary.accounts` rồi ghi vào file mới `accounts-{runId-mới}.json` (`auth-factory.ts:173,188,297-308`) → **mỗi lần reuse sinh thêm 1 file trùng dữ liệu**, thông tin lỗi login biến mất.
- Toàn bộ summary nằm trong memory coordinator (`coordinator.ts:168`) → restart là không còn gì để đối chiếu.

Đó chính là động lực của PRD: **kết quả từng account phải được lưu bền vững, gắn với run và pool**.

### 1.10 Mất dữ liệu khi restart — các kịch bản cụ thể

| Kịch bản | Mất gì | Còn gì |
|---|---|---|
| Restart server khi run đang chạy | Toàn bộ run: ticks, report, summary, logs, worker states | Pool file của run đang chạy (nếu provisioning đã persist), report rỗng |
| Kill -9 server giữa run | Như trên + không có report file | Pool file (nếu đã persist) |
| Run chạy > 1h | Tick từ giây 3600 trở về trước bị shift khỏi ring buffer → CSV/report thiếu đầu | Pool + report (thiếu phần đầu) |
| Run auto-stop E1/E2 (lỗi provisioning/connect) | Chỉ có dòng log console; không có run record | Pool file (nếu một phần đã persist) |

---

## 2. Giải pháp đề xuất: nơi lưu + mô hình dữ liệu

### 2.1 Chọn SQLite local (khuyến nghị) — trade-off với Postgres

| Tiêu chí | SQLite (local file) | Postgres (server) |
|---|---|---|
| Cài đặt | Không cần — 1 file trong `dataDir` | Cần server + connection config |
| Khối lượng dữ liệu | 1 run 60p ≈ 3600 ticks ≈ 2–4 MB; pool 10k account ≈ 4 MB — dư sức | Thừa sức nhưng cần vận hành |
| Concurrency | Single-writer (chỉ coordinator ghi — xem §2.4) — phù hợp | Đa writer, phù hợp cluster |
| Dashboard đọc cùng lúc ghi | OK với WAL mode | OK |
| Chuyển cluster nhiều máy (1M target, v1.1) | Không dùng chung được giữa máy | Cần cho chia sẻ/analytics |
| **Kết luận** | **MVP — chọn** | v1.1/Future khi có cluster |

**Lưu ý kỹ thuật triển khai**: dùng `better-sqlite3` (mature, sync API, prebuilt binary Windows) hoặc `node:sqlite` nếu version Node cho phép (repo đang dùng Node 22 — cần kiểm tra cờ). **Bắt buộc WAL mode + `synchronous=NORMAL`** để dashboard đọc trong lúc ghi và insert không bị fsync từng hàng. Mọi truy cập DB gói qua 1 module duy nhất (tương tự phong cách `loadtest/` hiện tại — plain TS module, không DI framework), để sau đổi Postgres chỉ thay module này.

### 2.2 Vị trí file

- File DB: `loadtest/data/loadtest.db` (nằm cùng `dataDir` — mặc định `./loadtest/data`, `config.ts:101`; thêm env `LOADTEST_DB_PATH` để override).
- Lý do đặt cạnh `dataDir`: dữ liệu pool + run gắn với **máy chạy tool** (mỗi máy 1 bộ), di chuyển/thêm máy chỉ cần copy thư mục.
- Thêm `loadtest/data/*.db*` vào `.gitignore` của repo.

### 2.3 Mô hình dữ liệu (MVP)

| Bảng | Cột chính (bỏ qua khóa chỉ mục chi tiết) | Mục đích |
|---|---|---|
| **Run** | `runId TEXT PK`, `status` ('running'/'finished'/'stopped'/'error'), `machineId`, `startAt`, `endAt`, `durationSec`, `gatewayUrl`, `targetUsers`, `workerCount`, `configJson` (toàn bộ `RunConfig`), `summaryJson` (summary + perAction + errors + bottlenecks từ `buildReport`), `stopReason`, `poolSourceRunId` (run cung cấp pool khi reuse), `createdAt/updatedAt` | 1 hàng/run — **tạo lúc `start()`, finalize lúc `finishRun()`**; đủ để tái dựng report mà không cần tick thô |
| **MetricSample** | `id PK autoincrement`, `runId` (index), `ts`, `phase`, `elapsedSec`, toàn bộ counters của `LoadTestTick` (usersCreated…rateLimitedNoEcho, queueCount, roomCount), `successRate`, `echoRate`, `actionsPerSecJson`, `latencyJson` (p50/p95/p99), `errorsJson`, `serverJson`, `workersJson` | Tick 1s đã tổng hợp ở coordinator (`aggregateTicks`, `coordinator-state.ts:88-194`) — **không lưu WorkerTick thô** (tránh nhân số lượng) |
| **Pool** | `poolId TEXT PK` (= runId tạo pool), `gatewayUrl`, `targetUsers`, `accountCount`, `registered`, `loggedIn`, `failed`, `errorsJson`, `reusedByRunIdsJson`, `importedFromFile` (đường dẫn file JSON legacy đã import), `createdAt` | 1 hàng/pool; `reusedByRunIdsJson` là danh sách runId đã reuse pool này |
| **PoolAccount** | `poolId` (FK), `email` (UNIQUE(poolId, email)), `password`, `userId`, `displayName`, `deviceInfoJson`, `dateOfBirth`, `country`, `registeredAt`, `status` ('registered'/'logged_in'/'failed'), `lastErrorCode`, `lastUsedRunId`, `lastLoginAt` | Per-account outcome — **giải quyết bug §1.9**: mỗi account lưu kết quả register/login + mã lỗi |
| **LogEvent** | `id PK autoincrement`, `runId` (index), `ts`, `level` ('info'/'warn'/'error'), `msg` | Log bền vững của từng run (thay cho ring buffer memory mất khi restart) |

**Quyết định thiết kế ghi chú**:
- **Không lưu `accessToken`/`refreshToken`** — token TTL 1h (`PRD-loadtest-tool.md §0.5`), reuse luôn login lại để lấy token mới (`auth-factory.ts:164-172`). Lưu token chết chỉ tốn dung lượng và là secret không cần thiết.
- **`password` có lưu** (bắt buộc để reuse login: `auth-factory.ts:164-167` gửi `email+password+deviceInfo`) — đây là môi trường TEST, chấp nhận plaintext trong SQLite local (rủi ro + biện pháp ở §6.6; quyết định chốt cuối ở §8).
- **Phase timeline**: không cần bảng riêng — mỗi `MetricSample` đã có cột `phase`; suy ra lịch sử phase từ ticks.
- **`otpSecret` tuyệt đối không vào DB** — chỉ trong env (`config.ts:93`, `.env.example:17-18`).
- **`machineId`** (`os.hostname()`): runId hiện sinh theo `Date.now()` local (`config.ts:219-223`) nên có thể trùng giữa máy — cột này giúp phân biệt khi nào cần dùng chung DB (Future).

### 2.4 Quy tắc ghi — single-writer

- **Chỉ coordinator process ghi DB.** Worker là child process fork chỉ gửi tick qua IPC (`worker-farm.ts:55-97`; `coordinator.ts:258-291`); logs từ worker cũng hội tụ về coordinator qua message `log` (`coordinator.ts:275-277`). → Không có race, không cần lock.
- **MetricSample**: batch insert mỗi ~30s (hoặc mỗi 500 tick) + flush cuối trong `finishRun`. Giữ nguyên ring buffer memory (`coordinator.ts:402-406`) cho dashboard LIVE — DB là lớp bền vững song song, không thay thế.
- **Run row**: insert `status='running'` ngay trong `start()` (`coordinator.ts:100-121`) → nếu process chết giữa chừng vẫn có record; khi startup, các row `running` còn sót được đánh dấu `error` (crash detection).
- **Finalize**: trong `finishRun` (`coordinator.ts:446-488`) — ghi status + stopReason + summaryJson + flush ticks còn lại, kể cả nhánh kill-switch (`coordinator.ts:230-233`) và auto-stop E1/E2/E3.
- **Lỗi DB không được làm chết run**: mọi write bọc try/catch, log cảnh báo, retry tối đa 1 lần. Ghi DB là best-effort.
- **API hiện tại giữ nguyên contract** (dashboard LIVE không đổi); thêm API đọc lịch sử từ DB (mục 3, Module A3).

### 2.5 Đường chuyển đổi từ file JSON hiện tại

1. **Import legacy (MVP, tự động lúc startup)**: quét `dataDir/accounts-*.json` (`auth-factory.ts:86-107`), upsert vào `Pool` + `PoolAccount` với `importedFromFile` = đường dẫn file. **Không xóa file gốc** — giữ làm backup; import idempotent (chạy lại không sinh trùng).
2. **Sau import**, `listPools` đọc từ DB trước, fallback file khi chưa import (`auth-factory.ts:86-107` thay nguồn đọc).
3. `persistPool` (`auth-factory.ts:297-308`) chuyển sang ghi DB (Pool + PoolAccount per-account outcome); file JSON ngừng sinh mới (tùy chọn giữ trong 1 release chuyển tiếp).
4. **Report file hiện tại (`docs/loadtest-reports/{runId}/`) giữ nguyên** — DB là nguồn query; file là artifact export (không đụng `report.ts:284-297`).

---

## 3. Danh sách tính năng theo module

### Module A — Run history (lịch sử run)

| ID | Tính năng | Nhãn | Lý do |
|---|---|---|---|
| A1 | **Run registry**: tạo Run row khi start, finalize khi finish (status/stopReason/summary/errors/bottlenecks) | **MVP** | Lõi của nhu cầu "biết số liệu từng lần chạy" — tái dựng được report sau restart |
| A2 | **MetricSample**: lưu ticks 1s (batch, flush 30s + cuối run), có thể tắt qua env | **MVP** | Dữ liệu chart chi tiết; mỗi run 3600 ticks/SQLite là rẻ |
| A3 | **API lịch sử**: `GET /runs` (list + filter status/gateway), `GET /runs/{id}` (detail + report), `GET /runs/{id}/metrics`, `DELETE /runs/{id}` | **MVP** | Điều kiện để dashboard/màn hình history hoạt động sau restart |
| A4 | **Màn History + Replay run cũ** (xem §7) | **MVP** | Yêu cầu người dùng: "xem lại số liệu từng lần chạy" |
| A5 | **So sánh 2+ run** (side-by-side KPI/chart) | v1.1 | Cần sau khi đã có history ổn định; thêm phức tạp UI |
| A6 | **Ghi chú/tag run** (label, mô tả mục đích test) | Future | Chưa có nhu cầu xác nhận; dễ thêm sau |
| A7 | **Run bị crash**: đánh dấu row `running` còn sót thành `error` lúc startup | **MVP** | Đảm bảo "không run nào biến mất" |

### Module B — Account pool

| ID | Tính năng | Nhãn | Lý do |
|---|---|---|---|
| B1 | **Pool + PoolAccount trong DB**: ghi kết quả từng account (registered/logged_in/failed+code) ngay khi provision xong | **MVP** | Giải bug §1.9; pool chuyển từ file sang DB |
| B2 | **Import legacy JSON** (tự động lúc startup, idempotent, giữ file gốc) | **MVP** | Pool cũ phải dùng tiếp được, không mất công tạo lại 10k account |
| B3 | **Pool stats**: tổng registered/loggedIn/failed, top error codes, số run đã reuse pool | **MVP** | Dữ liệu có sẵn ở Pool/PoolAccount; hiển thị rẻ |
| B4 | **Reuse pool đọc từ DB**: `listPools` + login-reuse chuyển nguồn dữ liệu sang DB, ghi `poolSourceRunId` vào Run và `lastUsedRunId`/`lastLoginAt` vào PoolAccount | **MVP** | Trả lời "run này dùng pool nào, account nào login fail" |
| B5 | **Pool retention/expiry**: tự xóa pool cũ quá N ngày, cảnh báo khi pool quá cũ (token hết hạn, user bị xóa) | v1.1 | Cần chính sách thời gian; không chặn MVP |
| B6 | **Per-account history**: lịch sử các run từng dùng 1 account cụ thể | Future | Query theo email là đủ cho debug tay MVP |

### Module C — Logs

| ID | Tính năng | Nhãn | Lý do |
|---|---|---|---|
| C1 | **LogEvent persistence**: log của run (info/warn/error, gồm phase-change, provisioning, worker log qua IPC) ghi vào DB (async best-effort) | **MVP** | Bug reuse-pool một phần do không truy vết được log sau restart |
| C2 | **API logs theo run**: `GET /runs/{id}/logs` (phân trang, filter level) | **MVP** | Đọc được log run cũ sau restart |
| C3 | **Log viewer UI** (filter, jump-to-error) | v1.1 | MVP đọc qua API/CLI là đủ |

### Module D — Vận hành

| ID | Tính năng | Nhãn | Lý do |
|---|---|---|---|
| D1 | **Cấu hình DB**: env `LOADTEST_DB_PATH`, tự tạo schema khi server start | **MVP** | Bắt buộc để chạy |
| D2 | **Auto-migration**: tạo/upgrade schema ở startup (version table đơn giản) | **MVP** | Tool local — không cần migration framework |
| D3 | **Backup/export DB** (dùng `sqlite3 .backup` hoặc export CSV) | v1.1 | Data cỡ MB, copy file là backup thủ công đã đủ MVP |
| D4 | **Retention policy**: xóa run cũ hơn N ngày / giới hạn số run + dung lượng ticks | v1.1 | Đã có `DELETE /runs/{id}` MVP; tự động hóa sau |
| D5 | **Postgres (shared DB)** cho cluster nhiều máy | Future | Khi chạy target 1M (v1.1 PRD gốc) |

### Module E — Dashboard/UI

| ID | Tính năng | Nhãn | Lý do |
|---|---|---|---|
| E1 | **Màn 8 — Lịch sử run** (danh sách, filter, mở run cũ) | **MVP** | Yêu cầu "xem lại số liệu từng lần chạy" |
| E2 | **Màn 9 — Chi tiết run cũ** (replay chart từ MetricSample + report + logs từ DB) | **MVP** | Cùng E1 |
| E3 | **Màn 10 — So sánh run** | v1.1 | Theo A5 |
| E4 | **Màn 11 — Pool manager** (danh sách pool, stats, nút reuse/cleanup) | **MVP** (read-only) | Hiển thị pool là đủ; cleanup đã có `/cleanup` |
| E5 | **Màn 12 — Log viewer** | v1.1 | Theo C3 |

---

## 4. User story + acceptance criteria — MVP

### US-1: Liệt kê lịch sử run sau restart

**Với tư cách** kỹ sư loadtest, **tôi muốn** sau khi restart server vẫn liệt kê được toàn bộ run đã chạy (kể cả run chạy ở phiên trước, run bị kill, run auto-stop) **để** không phải đoán từ trí nhớ và báo cáo chính xác.

**Acceptance criteria**:
- [ ] Sau khi restart server, `GET /api/loadtest/runs` trả về danh sách run đầy đủ từ DB, kể cả run của các phiên trước (không chỉ run trong memory hiện tại).
- [ ] Mỗi row gồm tối thiểu: runId, status, startAt, endAt, durationSec, gatewayUrl, targetUsers, stopReason, machineId.
- [ ] Có filter theo status (`finished`/`stopped`/`error`/`running`) và sắp xếp mặc định startAt giảm dần.
- [ ] DB trống (lần đầu chạy) → trả về mảng rỗng, không lỗi.
- [ ] Thời gian phản hồi list ≤ 500ms với 500 run.

### US-2: Xem đầy đủ số liệu 1 run cũ (report + chart) sau khi run đó không còn trong memory

**Với tư cách** kỹ sư loadtest, **tôi muốn** mở 1 run cũ (đã kết thúc nhiều phiên trước) xem đầy đủ report và chart metrics **để** phân tích kết quả không phụ thuộc việc server vừa chạy run đó.

**Acceptance criteria**:
- [ ] `GET /api/loadtest/runs/{id}` trả về cấu hình + summary + per-action + top errors + bottlenecks tương đương `RunReport` (`types.ts:192-218`) — tái dựng được từ `summaryJson`/`configJson` mà không cần `buildReport` lại.
- [ ] `GET /api/loadtest/runs/{id}/metrics` trả về ticks 1s đầy đủ theo thứ tự ts, kèm `total`; hỗ trợ phân trang hoặc `limit` (mặc định 3600).
- [ ] `GET /api/loadtest/runs/{id}` với id không tồn tại → 404 theo đúng convention `{ success:false, statusCode:404, message }`.
- [ ] Số liệu summary từ DB khớp ± 0 với report file JSON đã lưu của cùng runId (kiểm tra bằng so sánh field chính: successRate, echoRate, p95).
- [ ] Khi run chưa kết thúc (`running`), API trả trạng thái `running` và dữ liệu ticks tính tới lần flush gần nhất (không chặn request).

### US-3: Run bị kill/auto-stop giữa chừng vẫn còn dữ liệu

**Với tư cách** kỹ sư loadtest, **tôi muốn** khi run bị kill-switch hoặc auto-stop (E1/E2/E3) thì toàn bộ dữ liệu tới thời điểm dừng vẫn được lưu với status và lý do đúng **để** không mất công chạy lại khi đang debug.

**Acceptance criteria**:
- [ ] Kill-switch giữa run (`coordinator.ts:230-233`): sau khi run kết thúc, `GET /runs/{id}` trả status `stopped` + stopReason `kill-switch...`, ticks tính tới giây dừng.
- [ ] Auto-stop E1 (register fail > 50%, `coordinator.ts:170-176`) → status `error` + stopReason chứa "E1", kèm summary provisioning đã lưu.
- [ ] Auto-stop E2/E3 (`coordinator.ts:375-399`) → status `error`, stopReason tương ứng.
- [ ] Process bị SIGKILL đột ngột: lúc khởi động lại, run row còn sót `status='running'` được đánh dấu `error` (kèm lý do crash), ticks đã flush vẫn đọc được.
- [ ] Không có trạng thái treo: mọi run sau khi xử lý crash-detection đều nằm trong {finished, stopped, error}.

### US-4: Reuse pool ghi đầy đủ log per-account và truy vết pool nguồn

**Với tư cách** kỹ sư loadtest, **tôi muốn** khi run tái sử dụng pool, tôi biết chính xác pool nào được dùng, account nào login thành công/fail và mã lỗi của từng account **để** hết bug "reuse pool log không đầy đủ" (§1.9) và debug nhanh.

**Acceptance criteria**:
- [ ] Run reuse pool có `poolSourceRunId` trỏ đúng run đã tạo pool (`GET /runs/{id}` hiển thị).
- [ ] Sau khi reuse-login, mỗi account trong `PoolAccount` được cập nhật: `status='logged_in'|'failed'`, `lastErrorCode` (mã lỗi như `TWO_FA_REQUIRED`, `LOGIN_FAIL`, `THROTTLED`...), `lastLoginAt`, `lastUsedRunId`.
- [ ] Pool row cập nhật `reusedByRunIdsJson` chứa runId mới; số `failed`/`errorsJson` của pool khớp với tổng per-account.
- [ ] Run reuse có `provisionSummary` (loggedIn/failed/errors) được lưu vào Run row — đọc được sau restart.
- [ ] Trường hợp login toàn bộ fail và fallback register mới (`auth-factory.ts:185-190`): cả 2 giai đoạn (login fail + register mới) đều có log và số liệu trong run.

### US-5: Migration tự động pool JSON cũ sang DB

**Với tư cách** kỹ sư loadtest, **tôi muốn** khi nâng cấp tool, toàn bộ pool đang ở file `dataDir/accounts-*.json` được nạp vào DB tự động **để** không phải tạo lại 10k–100k account đã có.

**Acceptance criteria**:
- [ ] Server start lần đầu với `dataDir` chứa file pool cũ → `GET /api/loadtest/pools` trả về các pool từ DB với đầy đủ `accountCount`, `targetUsers`, `gatewayUrl`, `importedFromFile`.
- [ ] Import idempotent: restart lần 2 không tạo bản ghi trùng (không duplicate Pool/PoolAccount).
- [ ] File JSON gốc không bị xóa/sửa.
- [ ] Pool imported có thể được dùng cho reuse ngay (login bằng email/password/deviceInfo từ DB cho kết quả đúng).
- [ ] File hỏng (JSON parse fail, `auth-factory.ts:102-104`) được bỏ qua + log cảnh báo, không chặn startup.

### US-6: Xem log của run cũ sau restart

**Với tư cách** kỹ sư loadtest, **tôi muốn** xem log (info/warn/error) của run cũ sau restart **để** truy vết diễn biến run (provisioning, phase change, worker fatal) mà không phụ thuộc console/ring buffer.

**Acceptance criteria**:
- [ ] Log trong lúc run chạy được ghi vào `LogEvent` (gồm log provisioning, phase change, worker `log`/`fatal` qua IPC `coordinator.ts:275-280`, lỗi auto-stop).
- [ ] `GET /api/loadtest/runs/{id}/logs` trả log theo ts tăng dần, phân trang (mặc định 200/trang, tối đa 500), filter theo level.
- [ ] Sau restart, log của run cũ vẫn đọc được đầy đủ (số entry khớp ± 0 với lúc chạy).
- [ ] Ghi log không làm chậm run: nếu DB lỗi, chỉ có cảnh báo `[lt][WARN]`, không ảnh hưởng tiến trình run.
- [ ] Log từ worker được gắn đúng runId đang chạy (không lẫn sang run khác khi chạy nhiều phiên).

### US-7: Ghi DB không làm nghẽn luồng đo lường

**Với tư cách** developer, **tôi muốn** việc lưu DB (ticks 1s, high-frequency) không ảnh hưởng tới vòng đo lường realtime và auto-stop của run **để** kết quả loadtest không bị sai lệch vì chính tool.

**Acceptance criteria**:
- [ ] Ticks được ghi batch (flush mỗi ~30s hoặc mỗi 500 tick + cuối run) — không ghi 1 hàng/1 giây.
- [ ] WAL mode bật; insert batch 500 tick hoàn thành < 50ms (đo trên máy dev thông thường).
- [ ] Vòng `aggregateTick` 1s (`coordinator.ts:209,295-400`) và auto-stop không chờ DB write (ghi bất đồng bộ/best-effort).
- [ ] Bật ghi DB vs tắt ghi DB: KPI run (successRate, echoRate, p95) chênh lệch ≤ 0.1% trên cùng cấu hình (test A/B 1 lần, 10 phút).
- [ ] DB đầy/lỗi ổ cứng → run vẫn chạy hết với cảnh báo, không crash coordinator.

---

## 5. User flow chính

### Flow 1 — Chạy loadtest → dữ liệu được lưu bền vững

```
POST /api/loadtest/start
  │
  ├─ coordinator.start() ──────────────► DB: INSERT Run (status=running, configJson)   [A1]
  │
  ├─ provisionAccounts() ──────────────► DB: UPSERT Pool + PoolAccount (per-account
  │                                       status/errorCode) + LogEvent(provision logs) [B1][C1]
  │
  ├─ worker farm chạy (ramping/steady)
  │     │  worker ticks (IPC 1s)
  │     ▼
  │  aggregateTick (memory ring buffer giữ nguyên cho dashboard LIVE)
  │     └─ flush batch mỗi ~30s ───────► DB: INSERT MetricSample (batch)               [A2]
  │
  ├─ finishRun (natural/auto/manual/kill)
  │     ├─ flush ticks còn lại ────────► DB: MetricSample cuối
  │     ├─ finalize ───────────────────► DB: UPDATE Run (status, stopReason, summaryJson)
  │     └─ saveReportFiles (giữ nguyên export file hiện tại)
  │
  └─ GET /api/loadtest/runs/{id} (sau restart) ──► đọc từ DB, không phụ thuộc memory
```

### Flow 2 — Xem lại và so sánh số liệu các lần chạy

```
Khởi động lại server (dữ liệu memory mất, DB còn)
  │
  ├─ startup: DB open + auto-migration + import legacy pools + crash-detect
  │           (Run status=running còn sót → error)
  │
  ├─ GET /api/loadtest/runs ──────────► Màn 8: danh sách run (status badge, filter,
  │                                     bấm chọn 1 run)
  │
  ├─ GET /api/loadtest/runs/{id} ─────► Màn 9: summary KPI + report (từ summaryJson)
  │
  ├─ GET /api/loadtest/runs/{id}/metrics ─► Màn 9: replay chart (từ MetricSample)
  │
  └─ GET /api/loadtest/runs/{id}/logs ────► Màn 12 (v1.1) / JSON trên màn 9 (MVP)
```

### Flow 3 — Reuse pool + migration legacy

```
Server start
  ├─ quét dataDir/accounts-*.json ────► import → Pool + PoolAccount (idempotent,
  │                                     importedFromFile; file gốc giữ nguyên)       [B2]
  │
  └─ POST /start (useExistingAccounts=true)
       ├─ tìm pool theo targetUsers+gatewayUrl từ DB (không scan file)               [B4]
       ├─ login lại từng account ──────► UPDATE PoolAccount (status/lastErrorCode/
       │                                 lastLoginAt) + Run.poolSourceRunId          [B4]
       └─ kết quả summary + errors lưu vào Run row                                   [A1]
```

---

## 6. Điểm đặc thù của miền (đã xác nhận từ code)

| # | Đặc thù | Mô tả | Hệ quả thiết kế |
|---|---|---|---|
| 6.1 | **Dữ liệu high-frequency** | Ticks 1s/run (`coordinator.ts:209`); run 60 phút = 3600 tick; lên tới 100k action/s khi đo (`metrics.ts:6`) | Batch insert + WAL + `synchronous=NORMAL`; KHÔNG lưu WorkerTick thô, chỉ `LoadTestTick` tổng hợp (`coordinator-state.ts:88-194`); có thể tắt ticks qua env |
| 6.2 | **Dữ liệu chỉ có nghĩa khi gắn runId** | Mọi tick/log/account đều thuộc 1 run/pool | Mọi bảng có cột `runId`/`poolId` index; `DELETE /runs/{id}` xóa cascade; query luôn scope theo runId |
| 6.3 | **Concurrency nhiều worker ghi đồng thời** | Worker fork gửi tick qua IPC (`worker-farm.ts:55-97`); logs hội tụ tại coordinator (`coordinator.ts:275-277`) | Single-writer (chỉ coordinator) — không lock, không race; worker KHÔNG chạm DB |
| 6.4 | **Chạy local nhiều máy (dataDir theo máy)** | `dataDir='./loadtest/data'` (`config.ts:101`) — mỗi máy 1 bộ dữ liệu; runId sinh theo Date.now local (`config.ts:219-223`) | DB đặt trong `dataDir` (đi theo máy); `machineId` column để phân biệt khi Future dùng DB chung |
| 6.5 | **Migration từ pool file JSON hiện có** | Pool đang là file `accounts-{runId}.json` (`auth-factory.ts:82-84,297-308`), đọc qua `listPools` (`auth-factory.ts:86-107`) | Import tự động lúc startup, idempotent, giữ file gốc; `listPools` chuyển nguồn đọc sang DB |
| 6.6 | **Secret: OTP secret + token không vào DB** | OTP secret chỉ env (`config.ts:93`); access/refresh token TTL 1h; reuse login lại (`auth-factory.ts:164-172`) | Không lưu token, không lưu otpSecret. **Password có lưu** (bắt buộc reuse login) — chấp nhận cho tool test local; khuyến nghị giới hạn quyền file DB (quyền user duy nhất), không đưa DB ra ngoài máy; xác nhận cuối ở §8 |
| 6.7 | **Run chết giữa chừng (kill -9, SIGINT, crash)** | Coordinator chỉ write file report trong `finishRun` (`coordinator.ts:446-488`); restart = mất memory | Run row tạo ở `start()` + crash-detect startup (running → error) + flush ticks định kỳ → mất tối đa ~30s ticks cuối khi bị SIGKILL |
| 6.8 | **Ring buffer memory giữ nguyên cho dashboard LIVE** | Dashboard poll 1s từ memory (`api-server.ts:174-181`); DB là lớp bền vững | Không thay thế memory — DB ghi song song; contract API LIVE không đổi |
| 6.9 | **Report file là artifact, DB là nguồn query** | `saveReportFiles` (`report.ts:284-297`) | Giữ nguyên export file; DB đủ để tái dựng report (configJson + summaryJson) |

---

## 7. Danh sách màn hình cần design

Dashboard hiện có (UI-SPEC Màn 1-7, `docs/UI-SPEC-loadtest-tool.md`) — thêm các màn sau, theo đúng design system tối (dark-first, token, tabular-nums, sticky run header):

| Màn | Tên | Mô tả (2-3 dòng) | Nhãn |
|---|---|---|---|
| Màn 8 | **Lịch sử run** | Danh sách run từ DB: status badge (finished/stopped/error/running), startAt, duration, targetUsers, gatewayUrl, stopReason. Filter theo status + search runId. Bấm 1 row mở Màn 9; nút xóa run (kèm confirm). | MVP |
| Màn 9 | **Chi tiết run cũ (Replay)** | Tái hiện KPI summary (từ summaryJson), chart replay từ MetricSample (cùng bộ chart Màn 2, `isAnimationActive=false`), top errors + bottlenecks, tab logs (JSON đơn giản MVP). Badge "LIVE" nếu run đang chạy, ngược lại "HISTORY". | MVP |
| Màn 10 | **So sánh run** | Chọn 2-4 run từ lịch sử, hiển thị bảng KPI đối chiếu (successRate, echoRate, p95, throughput...) + chart overlay P50/P95/P99. | v1.1 |
| Màn 11 | **Pool manager** | Danh sách pool từ DB: accountCount, registered/loggedIn/failed, top error codes, số run đã reuse, importedFromFile. Xem chi tiết pool (mở bảng account phân trang, filter theo status/error). Nút "Dùng pool này cho run mới". | MVP (read-only; chi tiết account v1.1) |
| Màn 12 | **Log viewer** | Xem LogEvent của 1 run: filter level, jump-to-error, auto-refresh khi run đang chạy. | v1.1 |
| CLI | **`npm run loadtest:history`** (tùy chọn MVP) | Bảng text liệt kê run gần nhất (runId, status, startAt, duration, target, gateway) + `--run <id>` in summary/log — hữu ích khi không mở dashboard. | MVP |

---

## 8. Câu hỏi mở / quyết định cần user chốt (tối đa 3)

1. **Lưu `password` plaintext vào SQLite local** — bắt buộc để reuse pool login (`auth-factory.ts:164-167` gửi email+password+deviceInfo), nhưng là dữ liệu nhạy cảm. Chốt: chấp nhận plaintext trong DB local test (khuyến nghị), hay cần mã hóa nhẹ (khóa env)?
2. **Ticks lưu chi tiết tới đâu**: lưu đầy đủ MetricSample 1s cho mọi run (mặc định, DB ~2-4MB/run) hay chỉ lưu summary + ticks đầy đủ khi bật flag? (ảnh hưởng tốc độ tăng dung lượng `loadtest/data/`)
3. **Retention mặc định** khi DB lớn dần: giữ N run gần nhất (VD 200), xóa run cũ hơn X ngày (VD 90), hay không giới hạn (người dùng tự xóa tay)? — cần mặc định để cài giá trị mặc định trong v1.1 (Module D4).

---

## Phụ lục — Bản đồ hiện trạng tham chiếu (file:dòng)

- `coordinator.ts:23,37,402-406` — ring buffer ticks 3600 (mất khi restart)
- `coordinator.ts:38,446-488,480` — report chỉ trong memory + ghi file lúc finish
- `coordinator.ts:52,168,475` — provision summary chỉ memory
- `coordinator.ts:100-121` — `start()` (nơi tạo Run row)
- `coordinator.ts:230-233` — kill-switch path (nơi finalize run)
- `coordinator.ts:275-277` — log worker qua IPC (nơi bắt LogEvent)
- `coordinator.ts:295-400` — `aggregateTick` 1s (nguồn MetricSample)
- `auth-factory.ts:82-84,86-107` — poolPath + listPools (nguồn migration)
- `auth-factory.ts:149-190` — reuse pool login (nguồn B4; bug §1.9)
- `auth-factory.ts:297-308` — persistPool ghi file JSON
- `api-server.ts:165-172,174-181,199-202,204-209,269-271` — API đều đọc memory/file
- `config.ts:101-102,219-223` — dataDir/reportsDir + newRunId
- `util.ts:13-23` — logHistory ring buffer 500
- `types.ts:63-79,139-168,192-218` — TestAccount / LoadTestTick / RunReport (cấu trúc dữ liệu cần lưu)
- `report.ts:82-108,284-297` — RunReport shape + saveReportFiles
- `coordinator-state.ts:88-194` — aggregateTicks (tick tổng hợp để lưu)
- `metrics.ts:9-11` — histogram log-scale (không lưu sample thô)
