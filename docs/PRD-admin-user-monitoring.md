# PRD: Admin User Monitoring & Intervention Dashboard (Kiểm soát toàn bộ user)

**Status**: Draft
**Author**: Alex (PM)  **Last Updated**: 2026-08-05  **Version**: 0.2
> **Changelog 0.2**: Đính chính founder (đã chốt 2026-08-05): **seed 10k user của loadtest CHÍNH LÀ production users** (tạo qua flow register thật của gateway, ghi vào users table của user-community Postgres — xác minh code §1.4). Bỏ toàn bộ quan điểm "virtual users ≠ user thật". Mở rộng mục tiêu: **console quản trị hợp nhất** = (a) User monitoring + intervention + (b) Run control (kiểm soát tool chạy thế nào). Thêm Module F, US-9/10, §5.9, cập nhật Giả định/Metrics/Launch.
**Stakeholders**: Founder (decision maker), chat-app dev (loadtest/SPA), gateway-auth-service dev, content-service dev, user-community-service dev, designer

---

## 0. Tóm tắt 1 đoạn (press-release)

> Quản trị viên MAYogu mở một **console duy nhất** quản lý toàn bộ production user base (10k user — chính là các account do loadtest seed tạo qua flow register thật, sống trong DB production). Console có 2 khối song song:
> **(a) User monitoring & intervention**: nhìn thấy mọi tài khoản đang làm gì trong thời gian thực — ai online, ai đang đợi ghép (matching), ai ngồi trong phòng nào (phòng hết hạn lúc nào), ai bị khóa 15 phút, ai bị ban. Click vào user — thấy hồ sơ, thiết bị, phòng, toàn bộ transcript phòng. Click vào phòng — vào thẳng xem ai trong đó, nói gì, và ra lệnh kéo user ra khỏi phòng hoặc hủy lượt ghép đang chờ.
> **(b) Run control**: kiểm soát chính tool đang chạy như thế nào — start/stop/pause run, worker status, scenario, kết quả, lịch sử — tất cả trong cùng console.
> Không còn hỏi "user đó đang ở đâu?" hay "tool đang chạy ra sao?" — mở console là thấy, can thiệp được ngay.

---

## 1. Hiện trạng rút từ code

### 1.1 Admin hiện có gì (tái sử dụng được)

| Thứ | Vị trí code | Ghi chú |
|---|---|---|
| Admin auth HMAC-SHA256 session (12h, Bearer) | `chat-app/loadtest/auth.ts:33-43` (createSessionToken), `loadtest/guards.ts:15-27` (requireAuth) | Secret: env `LOADTEST_AUTH_SECRET` hoặc persist `dataDir/auth-secret.json` (`auth.ts:73-88`) |
| Route table + guards | `chat-app/loadtest/api-server.ts:68-105` (ROUTES), gate/rate tại `api-server.ts:217-247` | `GET /api/loadtest/users`, `/status`, `/metrics`... mọi route auth:true |
| Bảng users loadtest (10k+) | `chat-app/loadtest/routes/run.ts:104-117` (`/users` filter/phase/sort server-side), `loadtest/coordinator.ts:687-718` (queryUsers merge worker farm + cache 1s), `loadtest/types.ts:133-152` (VirtualUserRow — **cách gọi nội bộ: "virtual user" = user mà worker mô phỏng, tức production account của run**) | **ĐÂY CHÍNH LÀ PRODUCTION USERS** — xác minh §1.4. Email pattern `loadtest.{runId}.{i}@mayogu.test`, displayName `[lt] User {runId}.{i}` (`auth-factory.ts:217-226`) |
| UI bảng virtualized | `chat-app/src/pages/loadtest/UsersPage.tsx:47-64` (cột), `:293-298` (tanstack virtualizer), `:254-273` (poll 2.5s khi run active), PhaseDonut `:344-352` | Pattern UI bảng lớn → tái sử dụng trực tiếp |
| AppShell + poll 1s + admin identity | `chat-app/src/components/loadtest/app-shell.tsx:245-315` | Shell loadtest: nav, poll run, session expiry |
| Enforcement (ban/suspend) pipeline | content `main.ts:99-101` topic `user.enforcement.changed`; gateway `enforcement.consumer.ts:46-88` (level ≥ 3 → disconnectUser + SET `enforcement:user:{id}` chặn reconnect); gateway check khi handshake `websocket.gateway.ts:177-188` | Có sẵn toàn bộ: ban → cắt socket → chặn connect. Cần admin endpoint để gọi (chưa có) |
| Admin search user | `user-community-service/.../user.controller.ts:174-190` — `GET /user-community/users` (role Admin, filter email/displayName/phoneNumber, pagination, orderBy — `dtos/user.dto/getUserList.dto.ts:16-54`) | Đã có endpoint liệt kê user THẬT |
| Admin update user | `user-community-service/.../admin.controller.ts:60-91` — `PATCH /user-community/admin/user/change-status`, `PUT /admin/user/update/:id` (guard `@UseAuthGuard()` + `@RoleBaseAccessControl(Admin)`) | Có sẵn |
| Internal JWT guard (content-service admin) | `content-service/src/interceptors/admin-key.guard.ts:10-28` + `security/jwt-internal.util.ts:11-30` (HS256, `JWT_INTERNAL_SECRET`, maxAge 60s) | Pattern admin-tool gọi content-service — tái sử dụng |
| User basic info batch | `user-community-service/.../internal.controller.ts:379-393` — `GET /user-community/internal/users/basic-info?ids=` (x-service-token) | Đã dùng bởi chat (fetchRoomMembers) |
| REST chat endpoints | `content-service/.../chat.controller.ts:28-99` (match/my-room/queue-count/messages/my-topic) | Đều membership-gated (`chat-message.service.ts:132-139`) |

### 1.2 User state THẬT sống ở đâu (3 nguồn, không nguồn nào là "đủ")

**(a) Matching Redis (matching state)** — chủ sở hữu ghi: **content-service** (`content-service/src/config/redis/matching-redis.client.ts`), đọc: gateway (`gateway-auth-service/src/infrastructure/driven-adapters/messaging/matching-redis.client.ts:40-61`):

| Key | Kiểu | Ý nghĩa | Nơi ghi |
|---|---|---|---|
| `match:queue:waiting` | ZSET (score = enqueue time) | User đang chờ ghép | `enqueue()` `matching-redis.client.ts:327-335`; Lua MATCH_TICK `:4-121` |
| `match:queue:alive` | ZSET (score = last-seen) | Heartbeat chống ghost queue | `heartbeat()` `:348-350` (client chưa gửi — A2 v2) |
| `match:user:{uid}:room` | STRING (TTL = room ttl) | User đang ngồi phòng nào | Lua `seatRoom` `:73-87` |
| `match:room:{rid}` | HASH `{memberCount, capacity, createdAt, expiresAt}` | Metadata phòng | Lua `createRoom` `:51-60` |
| `match:room:{rid}:members` | SET | Thành viên phòng | Lua `seatRoom` `:74` |
| `match:room:{rid}:topics` | HASH (field=userId) | Chủ đề từng member | `setRoomTopic()` `:573-575` |
| `match:user:{uid}:nojoin` | SET (TTL 4h) | Phòng user không được quay lại (rời/kick) | Lua LEAVE_ROOM `:135-136`, VOTE_KICK_VOTE `:234-235` |
| `match:cooldown:{uid}` | STRING (TTL 900s mặc định) | Khóa 15 phút sau rời phòng | `setCooldown()` `:417-419` (chỉ khi `reason === 'VOLUNTARY'` — `chat-message.service.ts:790-793`) |
| `match:rooms:available` / `match:rooms:expiring` | ZSET | Index phòng | Lua |
| `match:room:{rid}:vote` / `:vote:voters` / `:vote_cooldown` | HASH/SET/STRING | Trạng thái vote-kick | Lua VOTE_KICK |
| `enforcement:user:{id}` | STRING JSON `{action, level, expiresAt}` | Ban/suspend (level ≥ 3 = cắt) | content-service (cache.service setEnforcementState) + gateway fallback `enforcement.consumer.ts:66-87` |

**(b) Online/offline — chỉ tồn tại trong bộ nhớ gateway-auth-service** (socket.io, port 3005 mặc định, `gateway-auth-service/src/main.ts:97`, Redis adapter `main.ts:85-95`):
- `handleConnection` (`websocket.gateway.ts:142-193`): verify JWT → `client.data.user`, auto-join `user:{uid}` room (`:189-192`).
- `handleDisconnect` (`websocket.gateway.ts:355-381`): chat → `chatSocket.onDisconnectChat` (`chat-socket.service.ts:105-113`) — **chỉ xóa map memory, slot Redis GIỮ NGUYÊN** (bug rời phòng khi disconnect đã biết, xem §5.4).
- **KHÔNG có presence map / endpoint online per-user** — `ws_connections` chỉ là counter tổng (`metrics.adapter`).

**(c) Message history** — Postgres qua Prisma (`chat-message.service.ts:91-99`), retention 90 ngày (`:25`), đọc qua `GET /content-service/chat/rooms/:roomId/messages` **bắt buộc là member** (`chat-message.service.ts:132-139`).

### 1.3 Kết luận hiện trạng

- **Chưa có API/UI nào hiển thị trạng thái user THẬT theo cách admin có thể giám sát + can thiệp.** Bảng "Users" của loadtest tool hiển thị trạng thái từng production account **trong phạm vi một run** (phase do worker mô phỏng), nhưng: chỉ tồn tại khi run chạy, chỉ hiển thị account của run đó, không có transcript, không có action can thiệp (force-leave/cancel).
- **Quan trọng (đính chính founder 0.2)**: 10k account loadtest seed CHÍNH LÀ production users — tạo qua flow register THẬT của gateway, ghi vào `users` table của user-community Postgres (xác minh §1.4). Vì vậy "bảng Users của loadtest" và "danh sách user production" là HAI GÓC NHÌN CỦA CÙNG MỘT user base; console hợp nhất sẽ dùng chung nguồn dữ liệu.
- User state phân tán 3 nơi (matching Redis / gateway memory / Postgres) — như đã mô tả §1.2. Muốn console "kiểm soát toàn bộ user" phải **xây mới lớp admin aggregation** (xem §6.1) — phần này không đổi sau đính chính.
- Có sẵn để tái sử dụng: admin auth HMAC (UI shell), pattern bảng + filter/sort (UsersPage), AdminKeyGuard, enforcement pipeline, search user (user-community), Lua leave idempotent, **toàn bộ run control** (coordinator + ControlPanel/LiveDashboard/ScenarioBuilder — §2 Module F).

### 1.4 Xác minh: seed 10k user CHÍNH LÀ production users (đính chính founder)

Chuỗi tạo account của loadtest đi qua **đúng code production**:

1. **OTP-Seed**: loadtest ghi key OTP vào Redis test đúng format mà gateway đọc: `otp:register:{email}` + `register:sms:{email}` HMAC-SHA256 với OTP_SECRET, TTL 300s (`auth-factory.ts:69-88`, comment `:3-5` tham chiếu `auth-otp.service.ts:81-139` và `auth-register.service.ts:439-523`). Chỉ bypass bước *gửi* OTP, không bypass *xác thực*.
2. **Register 3 bước qua gateway thật**: `POST /auth/register/verify-email` → `verify-sms-otp` → `register/complete` (`auth-factory.ts:238-297`). Bước complete gửi email, passwordHash, phoneNumber (số điện thoại thật sinh ngẫu nhiên), dateOfBirth, country, deviceInfo, displayName — **"TẠO TÀI KHOẢN + trả token"** (`auth-factory.ts:279`).
3. **Gateway đẩy user vào user-community Postgres**: `register/complete` → `createUser` (`gateway-auth-service/.../user.repository.adapter.ts:29-38`) → `POST /user-community/users/` (kèm `x-service-token`) → `UserController.createUser` (`user-community/.../user.controller.ts:86-102`, `@RoleBaseAccessControl(AccessRole.InternalService)`) → `userService.createUser` → **`users` table Postgres production** (cùng bảng với user đăng ký thật).
4. **Login**: `POST /auth/login` (`auth-factory.ts:351-355`) → `checkUser` → `POST /user-community/users/check` (`user.repository.adapter.ts:16-26`). Login thành công = account production hoạt động bình thường.
5. **Device tracking**: mỗi account có `deviceInfo { installationId, deviceFingerprint, platform, deviceName }` (`auth-factory.ts:219`, `types.ts:76-81`) → tạo trusted-device record trong user-community (registerDevice — `user.repository.adapter.ts:334-343`).

**Hệ quả thiết kế**:
- Email `loadtest.{runId}.{i}@mayogu.test` / displayName `[lt] User {runId}.{i}` là **pattern nhận dạng** account do loadtest tạo — console phải hỗ trợ filter/đánh dấu account này nhưng chúng KHÔNG phải dữ liệu kém giá trị: chúng là user thật có phone, device, có thể chat, có thể bị admin can thiệp như mọi user khác.
- **Loadtest DB riêng** (`LOADTEST_DATABASE_URL` — `config.ts:183`) chỉ lưu **credential pool** (email + password plaintext + userId — `seed-accounts.ts:8-9`) và run history/log — KHÔNG chứa user data. User data nằm ở user-community Postgres + matching Redis + gateway memory (§1.2).

---

## 2. Danh sách tính năng theo module

Quy ước: **MVP** (ship cùng dashboard đầu tiên) / **v1.1** / **Future** — và **ĐÃ CÓ** (tái sử dụng) / **CẦN THÊM** (backend) / **CẦN THÊM UI**.

### Module A — Nền tảng admin (auth + proxy)

| # | Tính năng | Nhãn | Trạng thái |
|---|---|---|---|
| A1 | Admin session HMAC (login/logout/me, 12h) | MVP | **ĐÃ CÓ** — `loadtest/auth.ts` + `loadtest/api-server.ts:76-80` (login/register/logout/me) |
| A2 | BFF proxy: loadtest server làm cầu nối SPA → product services (giữ admin secret phía server) | MVP | **CẦN THÊM** (backend, `chat-app/loadtest`) |
| A3 | Guard admin cho API chat mới (tái sử dụng `AdminKeyGuard` — internal JWT `JWT_INTERNAL_SECRET`, 60s) | MVP | **ĐÃ CÓ guard** + **CẦN THÊM** áp dụng cho controller mới |
| A4 | Admin secret cho gateway (online endpoint) | MVP | **CẦN THÊM** (env `ADMIN_API_TOKEN` mới) |
| A5 | RBAC tách role admin sản phẩm (không dính loadtest tool) | Future | **CẦN THÊM** |

### Module B — Theo dõi trạng thái user (màn hình chính)

| # | Tính năng | Nhãn | Trạng thái |
|---|---|---|---|
| B1 | Danh sách + tìm kiếm user thật (email/displayName/phoneNumber, pagination, orderBy) | MVP | **ĐÃ CÓ** endpoint — `GET /user-community/users` (role Admin, `user.controller.ts:174-190`) |
| B2 | Hydrate trạng thái realtime từ matching Redis: `in_room` (kèm roomId + expiresAt), `queued` (kèm position), `cooldown` (kèm endsAt), `nojoin` (bị cấm phòng), `enforcement` (ban/suspend) | MVP | **CẦN THÊM** (content-service admin endpoint — đọc key §1.2a) |
| B3 | Online/offline per-user từ gateway (presence map in-memory, cập nhật connect/disconnect) | MVP | **CẦN THÊM** (gateway: Map<userId,count> + admin endpoint) |
| B4 | Bảng UI user state: virtualized, filter theo state, sort server-side, poll 2.5s | MVP | **CẦN THÊM UI** (kế thừa `UsersPage.tsx` pattern) |
| B5 | Push realtime (socket) cho dashboard thay poll | v1.1 | **CẦN THÊM** |
| B6 | Lịch sử phiên/hành vi user (lịch sử chat, lần online gần nhất, số lần bị kick) | Future | **CẦN THÊM** |

### Module C — Xem chi tiết user & phòng

| # | Tính năng | Nhãn | Trạng thái |
|---|---|---|---|
| C1 | User detail: hồ sơ (basic-info) + state tổng hợp + room snapshot + cooldown + enforcement | MVP | **CẦN THÊM** (backend tổng hợp + UI) |
| C2 | Room snapshot: members (profile), capacity, expiresAt, topics | MVP | **CẦN THÊM** backend (đọc Redis key §1.2a — data đã có sẵn, chỉ là chưa có API) |
| C3 | Transcript phòng read-only (admin bypass membership gate) | MVP | **CẦN THÊM** (content-service: reuse `findManyByRoom` bỏ gate, audit log) |
| C4 | Live view phòng realtime (admin socket vào `chatroom:{rid}`, chế độ spectator) | v1.1 | **CẦN THÊM** (không phá `joinRoom` IDOR guard — cơ chế admin riêng, xem §5.5) |
| C5 | Danh sách thiết bị đang đăng nhập + revoke (multi-device) | v1.1 | Đã có nền: internal endpoints trusted-device (`internal.controller.ts:535-689`) — **CẦN THÊM** ghép UI |

### Module D — Hành động can thiệp

| # | Tính năng | Nhãn | Trạng thái |
|---|---|---|---|
| D1 | Force-leave: kéo user ra khỏi phòng (không cooldown; user rời socket room; member_left cho người còn lại) | MVP | **CẦN THÊM** — dựa trên Lua `runLeaveRoom` idempotent (`matching-redis.client.ts:395-405`) + gateway force-leave socket (pattern `forceLeaveKicked` `chat-socket.service.ts:90-102`) |
| D2 | Force-cancel matching: dequeue user khỏi `match:queue:waiting` + báo client reset | MVP | **CẦN THÊM** — dựa trên `cancel()` `matching-redis.client.ts:337-340` + event mới |
| D3 | Ban / suspend (level 3-4) + gỡ ban | v1.1 | Pipeline **ĐÃ CÓ** (`enforcement.consumer.ts`) — **CẦN THÊM** admin endpoint gọi setEnforcementState |
| D4 | Đóng phòng sớm (force expire tất cả member) | v1.1 | **CẦN THÊM** (dựa trên expire sweep Lua `:158-185`) |
| D5 | Audit log mọi hành động admin (ai làm gì với user nào, lúc nào) | v1.1 | Nền có: `AuditLogModule` (content-service), `log_events` (loadtest DB) — **CẦN THÊM** ghi cho module chat |

### Module E — Danh sách phòng (v1.1)

| # | Tính năng | Nhãn | Trạng thái |
|---|---|---|---|
| E1 | Danh sách phòng live: occupancy, expiresAt, danh sách member | v1.1 | **CẦN THÊM** (scan `match:rooms:expiring` + HGETALL room hash) |
| E2 | Bản đồ phòng trực quan (6 slot, highlight ai còn online) | Future | **CẦN THÊM UI** |

### Module F — Run control (kiểm soát tool chạy như thế nào — khối (b) của console hợp nhất)

| # | Tính năng | Nhãn | Trạng thái |
|---|---|---|---|
| F1 | Start/stop/pause/resume/kill run + sticky header run live | MVP | **ĐÃ CÓ toàn bộ** — coordinator `start/stop/pause/resume` (`loadtest/coordinator.ts:186-377`), routes `/start /stop /kill /pause /resume` (`loadtest/api-server.ts:81-85`), UI ControlPanel (`src/pages/loadtest/ControlPanelPage.tsx`) + RunStickyHeader (`app-shell.tsx:33-128`) — **cần tích hợp cùng console** (cùng AppShell, thêm tab Admin) |
| F2 | Worker status: alive/total, cpuAvg, restart, auto-stop E1-E3 | MVP | **ĐÃ CÓ** — tick tổng hợp (`coordinator.ts:416-560`), LiveDashboard (`LiveDashboardPage.tsx`), health workerAlive (`coordinator.ts:142-144`) |
| F3 | Scenario builder: target/ramp/duration/profile/presets | MVP | **ĐÃ CÓ** — `loadtest/config.ts:341-357` (PRESETS), `ScenarioBuilderPage.tsx`, validateRunRequest (`config.ts:282-339`) |
| F4 | Kết quả: report, metrics CSV/MD/JSON export, history, replay | MVP | **ĐÃ CÓ** — `buildReport` + `saveReportFiles` (`coordinator.ts:634-653`), routes `/report /report/export /runs*` (`api-server.ts:91-104`), ReportPage/HistoryPage/RunDetailPage |
| F5 | Settings + allowlist + cleanup + pools | MVP | **ĐÃ CÓ** — routes `/config /allowlist /pools /cleanup` (`api-server.ts:94-98`), SettingsPage/CleanupPage |
| F6 | **Map user ↔ run**: từ 1 user production (dashboard khối a) biết được account đó thuộc run nào, index, worker nào, đang được mô phỏng action gì | MVP | **CẦN THÊM** (nhỏ) — email pattern `loadtest.{runId}.{i}@mayogu.test` (`auth-factory.ts:217`) → lookup `pool_accounts`/`runs` trong loadtest DB (`seed-accounts.ts`, `db/writer.ts`) hoặc query `VirtualUserRow` của run đang chạy (`coordinator.queryUsers` `coordinator.ts:687-718`) |
| F7 | Alert khi run lệch target (worker chết, fail rate cao, ghost queue) | v1.1 | Cơ chế **ĐÃ CÓ** (auto-stop E1-E3 `coordinator.ts:266-276, 513-558`) — **CẦN THÊM** UI notification trong console |
| F8 | Điều chỉnh profile/target khi run đang chạy (live reconfig) | Future | **CẦN THÊM** (hiện chỉ config trước khi start) |
| F9 | Force restart/kill worker cá nhân từ UI | Future | **CẦN THÊM** (hiện có restart tự động E3 `coordinator.ts:110-118`) |

**MVP scope = A1+A2+A3+A4 + B1+B2+B3+B4 + C1+C2+C3 + D1+D2 + F1+F2+F3+F4+F5+F6 (F1-F5 là tích hợp, không phát triển mới).**
**Non-goals MVP**: B5 (socket push), C4 (live view realtime), C5 (device revoke), D3 (ban), D4 (đóng phòng), E1, F7-F9, audit log đầy đủ. Không xây mobile admin app. Không sửa cơ chế matching/cooldown/seat hiện có. Không đổi behavior run control hiện tại — chỉ tích hợp vào cùng console.

---

## 3. User story + Acceptance criteria (MVP)

### US-1 — Admin đăng nhập vào dashboard
> As a quản trị viên, tôi muốn đăng nhập bằng tài khoản admin hiện có để mở dashboard theo dõi user.

- **AC-1.1**: Tài khoản admin đăng nhập được qua màn login hiện có của loadtest tool (`POST /api/loadtest/auth/login`, HMAC 12h) — không tạo hệ auth mới.
- **AC-1.2**: Sau login, dashboard là trang con của loadtest shell (`/loadtest/admin`), có nav riêng; token hết hạn → chuyển về login + thông báo (kế thừa `RequireLoadtestAuth` + `SessionExpiryBanner`).
- **AC-1.3**: Mọi request của SPA tới admin API đều mang Bearer token loadtest (interceptor `loadtest-api.ts:79-84`).

### US-2 — Xem danh sách user thật + trạng thái live
> As a quản trị viên, tôi muốn mở dashboard và thấy toàn bộ user đang làm gì (online/offline, matching, trong phòng nào) để giám sát.

- **AC-2.1**: Màn hình chính hiển thị danh sách user THẬT (nguồn: `GET /user-community/users`, role Admin), mỗi row gồm: avatar, displayName, email, phoneNumber, **trạng thái tổng hợp** (`online | in_room | matching | cooldown | offline`), roomId (nếu in_room), phòng hết hạn (nếu in_room), queue position (nếu matching).
- **AC-2.2**: State tổng hợp được tính từ 3 nguồn đúng thứ tự ưu tiên: (1) enforcement level ≥ 3 → `suspended`; (2) có `match:user:{uid}:room` + room tồn tại → `in_room` (kèm roomId, expiresAt từ `match:room:{rid}.expiresAt`); (3) có trong `match:queue:waiting` → `matching` (position = ZRANK+1); (4) có `match:cooldown:{uid}` → `cooldown` (kèm endsAt); (5) online socket → `online`; còn lại `offline`. **Ưu tiên (2) phải dùng kết hợp presence (B3): in_room + không socket = `in_room (offline)`** — hiển thị 2 trạng thái riêng biệt, không gộp.
- **AC-2.3**: Poll 2.5s khi màn hình active; chỉ số `updatedAt` mỗi row không lệch quá 5s so với giờ server (sau mỗi poll, row có state đổi phải render cập nhật ≤ 500ms).
- **AC-2.4**: Hiệu năng: bảng hỗ trợ ≥ 10.000 user / trang đầu load ≤ 2s (p95), virtualized (tái dùng `@tanstack/react-virtual` như `UsersPage.tsx:293-298`).
- **AC-2.5**: Không expose PII không cần thiết: mặc định **ẩn phoneNumber** (hiện khi bấm eye icon) — quyết định PM, founder không có yêu cầu ngược lại.

### US-3 — Lọc / tìm kiếm
> As a quản trị viên, tôi muốn lọc user theo trạng thái và tìm theo email/số điện thoại/tên để nhanh chóng tìm đúng người cần xem.

- **AC-3.1**: Filter theo state (dropdown: all/online/in_room/matching/cooldown/suspended/offline) — filter client-side trên page đã nạp cho MVP (server-side filter theo state ở v1.1 khi cần scale > 10k).
- **AC-3.2**: Tìm kiếm server-side theo email / displayName / phoneNumber (truyền thẳng `GET /user-community/users?email=&displayName=&phoneNumber=`) — debounce 300ms.
- **AC-3.3**: Nhập chuỗi bất kỳ trong ô search → tự quyết định field: chứa `@` → email, ≥ 8 ký tự toàn số → phoneNumber, còn lại → displayName. Ghi rõ trong UI field đang search theo gì (placeholder đổi tương ứng).
- **AC-3.4**: Kết quả 0 → empty state có gợi ý "thử search theo email/số điện thoại đầy đủ".

### US-4 — Xem chi tiết user
> As a quản trị viên, tôi muốn click vào một user để xem đầy đủ hồ sơ và trạng thái hiện tại trước khi quyết định can thiệp.

- **AC-4.1**: Click row → mở User Detail (page hoặc drawer): avatar, displayName, userId, email, phoneNumber (ẩn mặc định), state tổng hợp + các mốc thời gian (vào phòng lúc nào, phòng hết hạn lúc nào, cooldown hết lúc nào).
- **AC-4.2**: Nếu `in_room` → hiện card "Phòng hiện tại": roomId, số member `X/6`, capacity, expiresAt, danh sách member (avatar + displayName + online/offline badge), topics của từng member, nút "Mở phòng" → Room Viewer (US-5).
- **AC-4.3**: Nếu `matching` → hiện position trong hàng chờ + thời gian chờ (now − enqueue time), nút "Hủy ghép" (US-7).
- **AC-4.4**: Nếu `suspended` → hiện level, action, expiresAt từ `enforcement:user:{id}`.
- **AC-4.5**: Toàn bộ dữ liệu detail lấy từ 1 request tổng hợp (`GET /api/loadtest/admin/users/:userId`) — không 3 request rời.

### US-5 — Xem phòng (Room Viewer, đọc-only)
> As a quản trị viên, tôi muốn "vào được luôn phòng chat của user đó" để xem họ đang nói gì với ai.

- **AC-5.1**: Từ User Detail (user in_room) hoặc từ roomId → mở Room Viewer: header (roomId, memberCount/capacity, expiresAt, countdown), member list (online badge), **transcript đầy đủ** (phân trang cursor như `GET /chat/rooms/:roomId/messages`), hiển thị displayName + avatar + thời gian từng message.
- **AC-5.2**: Transcript dùng endpoint admin mới **bypass membership gate** (không phải endpoint user hiện tại) — chỉ admin mới gọi được (xem §5.6).
- **AC-5.3**: Trạng thái "đang gõ" (typing) không hiển thị (MVP); tin nhắn bị xóa (soft-delete) hiển thị placeholder "đã bị xóa".
- **AC-5.4**: Auto-refresh transcript 5s (poll) khi đang mở; badge "live" + thời điểm cập nhật cuối.
- **AC-5.5**: Room không còn tồn tại (đã expire/đóng) → 404 với thông báo "phòng đã đóng" thay vì crash.

### US-6 — Force-leave: kéo user ra khỏi phòng
> As a quản trị viên, tôi muốn kéo một user ra khỏi phòng ngay lập tức để xử lý vi phạm.

- **AC-6.1**: Từ User Detail (in_room) → nút "Kéo ra khỏi phòng" → dialog xác nhận gõ `CONFIRM` (bắt buộc, chống bấm nhầm) → gọi `POST /api/loadtest/admin/users/:userId/leave-room`.
- **AC-6.2**: Hành vi hệ thống sau khi thành công (server-side, trong ≤ 2s): (a) `runLeaveRoom` Lua xóa binding `match:user:{uid}:room` + SADD nojoin phòng cũ (idempotent — `matching-redis.client.ts:395-405`); (b) publish `chat:member_left` (reason `ADMIN`) → user bị kick và member còn lại nhận event, client reset về idle (pattern `onMemberLeft` `chat.store.ts:549-564`); (c) gateway force-leave socket của user khỏi `chatroom:{rid}` (pattern `forceLeaveKicked` `chat-socket.service.ts:90-102`, áp dụng cho reason `ADMIN`); (d) dọn topic của user (`removeRoomTopic`).
- **AC-6.3**: **KHÔNG set cooldown 15 phút** (cooldown chỉ khi `VOLUNTARY` — `chat-message.service.ts:790-793`). User có thể match lại ngay, nhưng **không quay lại được phòng cũ** (nojoin 4h — hành vi hiện có của Lua, chấp nhận).
- **AC-6.4**: Idempotent: gọi lần 2 với user đã rời → trả `{ alreadyLeft: true }`, không lỗi, không tạo event thừa (Lua trả `-2` = no-op).
- **AC-6.5**: UI cập nhật ngay: user chuyển `in_room → online/offline`, Room Viewer cập nhật member list; toast xác nhận + (v1.1: ghi audit log).
- **AC-6.6**: User đang offline (ghế treo do disconnect) vẫn kéo ra được — chính là cách dọn "ghế ma" (xem §5.4).

### US-7 — Force-cancel matching
> As a quản trị viên, tôi muốn hủy lượt chờ ghép của một user (người đó đang kẹt hàng chờ hoặc cần ngăn ghép ngay).

- **AC-7.1**: Từ User Detail (matching) → nút "Hủy ghép" → xác nhận → `POST /api/loadtest/admin/users/:userId/cancel-match`.
- **AC-7.2**: Server: ZREM khỏi `match:queue:waiting` + `match:queue:alive` + xóa `queued_topic` (reuse `cancel()` + `clearQueuedTopic()` `matching-redis.client.ts:337-340, 567-570`).
- **AC-7.3**: Client user nhận event `chat:error` code `ADMIN_MATCH_CANCELLED` → reset về idle + toast "Admin đã hủy lượt ghép của bạn" (thêm branch trong `onChatError` `chat.store.ts:584-596` — thay đổi nhỏ frontend chat).
- **AC-7.4**: Idempotent: user không trong queue → `{ alreadyCancelled: true }`.
- **AC-7.5**: Race an toàn: nếu giữa lúc bấm và lúc xử lý user đã được seat vào phòng (matching tick 2s) → endpoint phải check lại `getUserRoom` trước khi ZREM; nếu đã có room → trả 409 `ALREADY_SEATED` + UI gợi ý dùng Force-leave.

### US-8 — Online/offline theo thời gian thực
> As a quản trị viên, tôi muốn phân biệt user đang thực sự online (có socket) với user đang bị "treo ghế" để đánh giá đúng tình hình.

- **AC-8.1**: Gateway duy trì presence: `Map<userId, count>` tăng khi `handleConnection` có `client.data.user.sub`, giảm khi `handleDisconnect` (sửa tại `websocket.gateway.ts:142-193, 355-381` — mỗi socket đếm 1; multi-device = count > 1).
- **AC-8.2**: Endpoint admin mới `GET /admin/gateway/online-users` (guard secret `ADMIN_API_TOKEN`) trả danh sách `{ userId, socketCount, lastSeenAt }`; gọi từ loadtest BFF mỗi poll (2.5s) và cache 2s.
- **AC-8.3**: Khi gateway multi-node (Redis adapter), MVP chấp nhận presence per-node không hợp nhất (mỗi node báo riêng, BFF gọi danh sách node từ cấu hình); hợp nhất cross-node → v1.1 (dùng `fetchSockets()` hoặc pub/sub presence qua Redis).
- **AC-8.4**: Dashboard hiển thị: `in_room` + online = badge xanh "trong phòng"; `in_room` + offline = badge cam "trong phòng (offline — ghế treo)".

### US-9 — Run control trong cùng console (khối (b))
> As a quản trị viên, tôi muốn kiểm soát tool chạy như thế nào (start/stop/pause run, xem worker, chọn scenario, xem kết quả) ngay trong cùng console mà không phải chuyển màn riêng biệt.

- **AC-9.1**: Tab "Admin" mới nằm trong AppShell hiện có (`app-shell.tsx:132-139` nav) — mọi màn run control hiện tại (Cấu hình/Live/Users/Lịch sử/Báo cáo/Cài đặt) giữ nguyên và truy cập được từ cùng console; không di dời, không đổi hành vi.
- **AC-9.2**: Sticky header run live (`RunStickyHeader` — stop/pause/resume/log) hiển thị ở MỌI màn console kể cả Admin dashboard (`app-shell.tsx:31-128`) — từ màn user monitoring vẫn dừng được run.
- **AC-9.3**: Không có endpoint run control mới — tái sử dụng `loadtestApi` hiện có (`src/lib/loadtest-api.ts:158-176`: start/stop/pause/resume/status) và coordinator (`coordinator.ts:186-377`). Acceptance: toàn bộ F1-F5 hoạt động như hiện tại, chỉ thay đổi về cách điều hướng.
- **AC-9.4**: Tab "Users" cũ (bảng user của run đang chạy) đổi nhãn thành "Run Users" để phân biệt với tab Admin mới (user base toàn bộ) — tránh nhầm lẫn 2 bảng.

### US-10 — Trace 1 user về run (map user ↔ tool)
> As a quản trị viên, tôi muốn từ 1 user bất kỳ (trong dashboard khối a) biết user đó có phải account do loadtest tạo không, thuộc run nào, đang được mô phỏng hành động gì, để hiểu "tool đang chạy thế nào" ở mức cá nhân.

- **AC-10.1**: User Detail hiển thị badge "Loadtest account" nếu email khớp pattern `loadtest.{runId}.{i}@mayogu.test` (`auth-factory.ts:217`), kèm runId + index giải mã từ email.
- **AC-10.2**: Nếu run tương ứng đang chạy (phase ramping/steady), hiển thị thêm: worker index, phase worker hiện tại (queued/in_room/...), currentAction, messagesSent/echoed, reconnectCount, outboxPending — dữ liệu lấy từ `coordinator.queryUsers` (`coordinator.ts:687-718`, filter theo email — route `/users` đã hỗ trợ `filter`).
- **AC-10.3**: Nếu run đã kết thúc — hiển thị runId + status + link tới Run Detail (`/loadtest/history/:runId` — ĐÃ CÓ, `app.tsx:73`).
- **AC-10.4**: User KHÔNG phải account loadtest (email không khớp pattern) → không hiển thị khối này (user đăng ký thật qua app — vẫn giám sát bình thường như US-2..US-8).

---

## 4. User flow chính

```
┌──────────────┐
│ /loadtest/login (ĐÃ CÓ — HMAC) │
└──────┬───────┘
       ▼
┌─────────────────────────────────────────┐
│ AppShell (ĐÃ CÓ) — console hợp nhất      │
│ nav: Cấu hình | Live | Run Users |      │
│      Lịch sử | Báo cáo | Cài đặt | ADMIN │
│ sticky run header (stop/pause) — ĐÃ CÓ  │
└──────┬──────────────────────────────────┘
       ▼
┌──────────────────────────────────────────────────────────┐
│ Admin Dashboard — Bảng user state (poll 2.5s)            │
│ [search email/phone/name] [filter state ▼] [sort]        │
│ ┌────┬────────────┬──────────┬─────────┬─────────────┐   │
│ │🟢  │ displayName │ email    │ STATE   │ roomId/pos  │   │
│ │🟢  │ [lt] User…  │ loadtest.…│ in_room │ r123 · 2h14m│   │
│ │🔴  │ ...         │ ...      │ offline │ —           │   │
│ └────┴────────────┴──────────┴─────────┴─────────────┘   │
└──────┬───────────────────────────────────────────────────┘
       │ click row (user in_room)
       ▼
┌──────────────────────────────────────────────────────┐
│ User Detail (/loadtest/admin/users/:id)               │
│ [avatar] displayName · email · userId · phone(🔒)     │
│ STATE: Trong phòng (online) · vào lúc 14:02            │
│ ┌─ Phòng hiện tại ─────────────────────────────┐      │
│ │ r123 · 3/6 · hết hạn 17:00 · [Mở phòng ▶]     │      │
│ │ 👤 A 🟢  👤 B 🟢  👤 C 🔴(offline)            │      │
│ └───────────────────────────────────────────────┘      │
│ [Kéo ra khỏi phòng]  [Hủy ghép nếu matching]           │
└──────┬─────────────────────────────────────────────────┘
       │ "Mở phòng"
       ▼
┌──────────────────────────────────────────────────────┐
│ Room Viewer (/loadtest/admin/rooms/:roomId)           │
│ r123 · 3/6 · còn 2h14m · [live · refresh 5s]          │
│ Member bar: A 🟢 B 🟢 C 🔴                            │
│ 14:03 A: chào mọi người                                │
│ 14:04 B: có ai xem phim không?                        │
│ 14:05 C: tôi có (đã xóa)                              │
│ ⤓ scroll → xem thêm (cursor)                          │
└──────┬─────────────────────────────────────────────────┘
       │ "Kéo ra khỏi phòng" (từ Detail hoặc Viewer)
       ▼
┌───────────────────────────────┐
│ Dialog xác nhận: gõ CONFIRM    │  → POST leave-room
│ "Kéo {displayName} ra khỏi     │  → member_left → user reset idle
│  phòng r123? (không cooldown)" │  → dashboard refresh: user → online
└───────────────────────────────┘
```

---

## 5. Điểm đặc thù miền (domain quirks — developer bắt buộc đọc)

### 5.1 Kiến trúc realtime là Kafka → socket.io (event-driven, async)
Mọi thay đổi chat state đi qua **Kafka** (gateway relay → content-service consumer → publish event → gateway `EventBusService` emit socket). Đường đi `chat:leave`: client `chat:leave` → gateway produce `chat.room.leave` (`chat-socket.service.ts:293-300`) → content consumer `handleChatRoomLeave` (`chat-message.service.ts:765-832`) → `runLeaveRoom` Lua + publish `chat:member_left` → gateway emit. **Admin force-leave phải đi cùng đường ống này** (không ghi Redis tay rồi bỏ quên emit) — nếu không client sẽ lệch trạng thái. Độ trễ Kafka round-trip thường < 100ms (tham chiếu `resolveCooldownEndsAt` poll 100ms `chat-socket.service.ts:400-415`).

### 5.2 Cooldown 15 phút
`CHAT_LEAVE_COOLDOWN_SECONDS = 900` (`chat-app/src/lib/env.ts:18`). **Chỉ `reason === 'VOLUNTARY'` mới set cooldown** (`chat-message.service.ts:790-793`). Admin force-leave (reason `ADMIN`) tự nhiên KHÔNG cooldown — đúng thiết kế, nhưng cần ghi rõ trong UI để admin không bất ngờ. `match:cooldown:{uid}` TTL là nguồn chân lý cho countdown (`getMyRoom` đọc TTL — `chat-message.service.ts:390-397`).

### 5.3 Seat giữ 3 giờ
Phòng TTL 3h (`CHAT_ROOM_TTL_HOURS`, `matching-tick.service.ts:17`) + buffer 1h dọn dẹp (Lua `createRoom` EXPIRE `ttl_s + 3600` `matching-redis.client.ts:57`). `match:user:{uid}:room` TTL = room ttl (`seatRoom` `:77`). `expiresAt` trong HASH phòng là nguồn chính xác cho countdown (`getRoomExpiresAt` `:452-455`). Dashboard phải dùng `expiresAt` hash, **không dùng PTTL** (PTTL là ttl_s+3600 → lệch 1h).

### 5.4 Bug đã biết: disconnect KHÔNG rời phòng (ghế treo)
`handleDisconnect` → `onDisconnectChat` chỉ xóa map memory, **Redis seat giữ nguyên**: "chat disconnect ... — slot retained" (`chat-socket.service.ts:105-113`). Hệ quả:
- User đóng app giữa chừng → vẫn `in_room` trong Redis đến khi phòng expire 3h hoặc user bị vote-kick/rời thủ công.
- **Dashboard BẮT BUỘC phân biệt "seated" (Redis) và "online" (socket)** — nếu chỉ đọc Redis, một nửa "người trong phòng" có thể là ghế ma. Đây là lý do B3 (presence) nằm trong MVP.
- Force-leave (D1) chính là công cụ admin dọn ghế ma.

### 5.5 Quyền admin nằm ở đâu (3 lớp hiện có, không gộp)
1. **UI shell**: HMAC session loadtest (`loadtest/auth.ts`) — admin của *công cụ*, không phải admin *sản phẩm*.
2. **content-service admin API**: `AdminKeyGuard` internal JWT (`admin-key.guard.ts:10-28`, `JWT_INTERNAL_SECRET`, maxAge 60s) — đã dùng cho `/content-service/admin/*` (`admin-content.controller.ts:12-14`).
3. **user-community admin**: `@UseAuthGuard()` + `@RoleBaseAccessControl(AccessRole.Admin)` (`admin.controller.ts:48-50`, `user.controller.ts:174-190`).

MVP giữ nguyên 3 lớp: BFF loadtest giữ `JWT_INTERNAL_SECRET` (mint token 60s mỗi request — pattern admin-tool sẵn có) và gọi user-community bằng admin-token của nó (hiện user-community AuthGuard xác thực JWT — cần xác minh cơ chế admin-token khi implement; fallback: gọi qua `x-service-token` nếu role check cho phép, hoặc thêm internal search endpoint). **Future (A5)**: gộp về 1 identity admin sản phẩm + RBAC.

### 5.6 Bảo mật xem phòng riêng tư (quyền đọc chat người khác)
- REST messages hiện tại **membership-gated cứng** (`chat-message.service.ts:132-139`) — không được dùng endpoint này cho admin.
- Endpoint transcript admin mới (C3) phải: (a) chỉ chạy sau `AdminKeyGuard`; (b) **ghi audit log** mỗi lần đọc (user nào, room nào, lúc nào — bắt buộc vì đọc nội dung private); (c) không trả file/ảnh của phòng ở MVP (chỉ text + metadata).
- Socket: `joinRoom` chặn join room user người khác (`websocket.gateway.ts:202-208`) — C4 v1.1 phải tạo cơ chế admin riêng (admin namespace/role claim), **không được sửa guard này thành cho phép admin chung chung**.

### 5.7 Đa thiết bị / deviceInfo
- 1 user có thể có nhiều socket (nhiều thiết bị). Presence đếm theo socket; `deviceInfo = { installationId, deviceFingerprint, platform, deviceName }` (chuẩn trong `TestAccount.types.ts:76-81` và login `auth.store.ts:45-47`).
- v1.1 C5 tái sử dụng internal endpoints trusted-device đã có (`internal.controller.ts:535-689`: list/check/revoke) — đừng xây mới.
- MVP: chỉ hiện `socketCount`; nếu > 1 hiển thị "n thiết bị" + tooltip.

### 5.8 Loadtest tool bị expose khi deploy Docker
- `LOADTEST_HOST` mặc định `127.0.0.1` (`config.ts:169`) nhưng Docker thường set `0.0.0.0` để healthcheck → **toàn bộ admin API + auth secret file + khả năng đăng ký 100k account production thật lộ ra internet** (mỗi register tạo user trong Postgres production — §1.4).
- Quy tắc deploy (ghi vào runbook): (1) không publish port 3401 ra internet — chỉ trong VPN/mạng nội bộ; (2) `LOADTEST_ALLOW_REGISTER=false` (mặc định đã false — `guards.ts:30-32`); (3) `LOADTEST_AUTH_SECRET` ≥ 32 ký tự bắt buộc production (`config.ts:248-253`); (4) CORS không `*` (`config.ts:262-268`).
- Dashboard admin sản phẩm gắn vào tool này đồng nghĩa "admin sản phẩm = admin tool" ở MVP — chấp nhận, ghi rõ A5 (RBAC tách biệt) là nợ kỹ thuật có chủ đích.

### 5.9 Seed 10k = production users (đính chính founder — hệ quả thiết kế)
- **Bản chất**: 10k account loadtest được tạo qua flow register THẬT (gateway → user-community → Postgres users table — §1.4). Đây là production user base thực sự của sản phẩm ở giai đoạn hiện tại. Mọi hành vi admin (force-leave, cancel, xem transcript) tác động lên **user thật** — không có "vùng an toàn thử nghiệm".
- **System of record**: user data = user-community Postgres; chat state = matching Redis; online = gateway socket; credential pool + run history = loadtest DB riêng (`LOADTEST_DATABASE_URL`). **Không được xóa user khỏi Postgres production khi cleanup loadtest** — cleanup (`/cleanup`, CleanupPage) chỉ dọn Redis keys/OTP/token pool của run, không đụng user table (kiểm chứng khi implement; nếu cleanup hiện tại có động chạm user table thì phải tách).
- **Pattern nhận dạng**: email `loadtest.{runId}.{i}@mayogu.test` — dùng để (a) filter hiển thị, (b) trace user ↔ run (F6/US-10), (c) thống kê "bao nhiêu user base là account loadtest".
- **Quyền riêng tư**: account này có phoneNumber/device thật (sinh ngẫu nhiên nhưng lưu trong DB production như user thường) — policy ẩn phone (AC-2.5, giả định #8) áp dụng như nhau, không phân biệt.
- **2FA**: loadtest login không kích hoạt 2FA cho account mới (register flow không enable) — nếu sau này user 2FA bật thì login pool fail (`TWO_FA_REQUIRED` — `auth-factory.ts:366-373`) — console cần hiển thị trạng thái này khi trace run.

---

## 6. Kiến trúc đề xuất & API (MVP)

### 6.1 Luồng dữ liệu

```
SPA (chat-app, /loadtest/admin)
  │  Bearer HMAC (loadtest auth)
  ▼
LoadTest Server :3401 (chat-app/loadtest)  ← BFF admin: giữ secret, mint internal JWT 60s
  │  x-admin-token / x-service-token / x-admin-token(ADMIN_API_TOKEN)
  ├──► content-service :3000  ── AdminChatController (mới, AdminKeyGuard)
  │     ├── đọc matching Redis (state hydration, room snapshot)
  │     ├── chatMessageRepo.findManyByRoom (transcript, bỏ membership gate)
  │     └── runLeaveRoom Lua / cancel() (force-leave / cancel-match) + publish Kafka events
  ├──► gateway-auth-service :3005 ── GET /admin/gateway/online-users (mới, guard ADMIN_API_TOKEN)
  │     └── presence map in-memory (handleConnection/handleDisconnect)
  └──► user-community-service ── GET /user-community/users (ĐÃ CÓ, admin role)
                                  GET /user-community/internal/users/basic-info (ĐÃ CÓ)
```

Không thêm route mới nào vào gateway proxy công khai; admin API chỉ tồn tại nội bộ (loadtest BFF gọi trực tiếp service, không qua gateway public).
**Run control (Module F) không cần BFF route mới** — mọi endpoint đã tồn tại trong `loadtest/api-server.ts:68-105` và `loadtestApi` SPA (`src/lib/loadtest-api.ts`); F1-F5 chỉ là tích hợp UI/navigation trong cùng console.

### 6.2 API mới (chi tiết để developer làm)

**content-service** — controller mới `AdminChatController`, prefix `/content-service/admin/chat`, `@UseGuards(AdminKeyGuard)`:

| Method | Path | Mô tả | Trả về chính |
|---|---|---|---|
| GET | `/users` | Danh sách + hydrate state (input: danh sách userId/email từ user-community, hoặc tự gọi search rồi hydrate — BFF quyết định phối hợp) | `[{ userId, state, roomId?, roomEndsAt?, queuePosition?, cooldownEndsAt?, enforcement? }]` |
| GET | `/users/:userId` | State tổng hợp 1 user + room snapshot | `{ state, room?: { roomId, memberCount, capacity, expiresAt, members: [{userId, displayName, avatarUrl, online}], topics: TopicDto[] }, queuePosition?, cooldownEndsAt?, enforcement? }` |
| GET | `/rooms/:roomId` | Room snapshot (không transcript) | `{ roomId, memberCount, capacity, expiresAt, members, topics }` |
| GET | `/rooms/:roomId/messages` | Transcript (admin bypass) — cursor pagination như endpoint user, **ghi audit log** | `{ data: ChatMessage[], nextCursor }` |
| POST | `/users/:userId/leave-room` | Force-leave (idempotent) | `{ ok, alreadyLeft? }` |
| POST | `/users/:userId/cancel-match` | Force-cancel (idempotent, race-check seated) | `{ ok, alreadyCancelled?, seated? }` |

Triển khai ghi chú:
- State hydration dùng Redis batch: `MGET match:user:{uid}:room` (hoặc pipeline), `ZSCORE match:queue:waiting`, `EXISTS match:cooldown:{uid}` + `TTL`, `GET enforcement:user:{uid}`. Giới hạn batch ≤ 200 user/request.
- Force-leave: gọi `runLeaveRoom(uid, rid, cap, now, minTtl)` (Lua idempotent) → nếu trả ≥ 0: publish Kafka `chat:member_left` reason `ADMIN` (bổ sung trường reason như `handleChatRoomLeave` `chat-message.service.ts:800-805`) + `removeRoomTopic` (dọn topic như `:809-824`). Gateway `ChatSocketService.dispatch` thêm nhánh: `member_left` reason `ADMIN` → `forceLeaveKicked(roomId, userId)` (pattern vote-kick `chat-socket.service.ts:80-102`). Không set cooldown.
- Force-cancel: `cancel()` + `clearQueuedTopic()`; race-check `getUserRoom` trước; publish `chat:error` code `ADMIN_MATCH_CANCELLED` tới `user:{uid}` (qua `wsEmitter.emitEvent` — pattern có sẵn) + SPA chat thêm branch xử lý.

**gateway-auth-service** — mới:
| Method | Path | Mô tả |
|---|---|---|
| GET | `/admin/gateway/online-users` | Guard: header `x-admin-token` = env `ADMIN_API_TOKEN` (mới). Trả `[{ userId, socketCount }]` từ presence map; cache 1s |

Presence map: `Map<userId, number>`, tăng/giảm trong `handleConnection`/`handleDisconnect` (sau khi `client.data.user` có). Reset map khi `disconnect` toàn bộ? Không — map tự giảm đúng count từng socket; thêm `lastSeenAt` khi count giảm về 0 (cho "lần online gần nhất" Future).

**chat-app loadtest (BFF)** — routes mới trong `loadtest/api-server.ts` (auth: `requireAuth` — `auth: true`):
| Method | Path | Proxy tới |
|---|---|---|
| GET | `/api/loadtest/admin/users` | content `/content-service/admin/chat/users` (phối hợp search user-community) |
| GET | `/api/loadtest/admin/users/:userId` | content + user-community basic-info + gateway online |
| GET | `/api/loadtest/admin/rooms/:roomId` | content |
| GET | `/api/loadtest/admin/rooms/:roomId/messages` | content |
| POST | `/api/loadtest/admin/users/:userId/leave-room` | content |
| POST | `/api/loadtest/admin/users/:userId/cancel-match` | content |
| GET | `/api/loadtest/admin/online` | gateway `/admin/gateway/online-users` (cache 2s) |

**chat-app SPA chat (thay đổi nhỏ)**: `onChatError` thêm branch `ADMIN_MATCH_CANCELLED` → `set({...idleState})` + toast (`chat.store.ts:584-596`).

### 6.3 Config mới (env)
- content-service: dùng sẵn `JWT_INTERNAL_SECRET` (đã có).
- gateway-auth-service: `ADMIN_API_TOKEN` (mới, ≥ 32 ký tự, production bắt buộc).
- chat-app loadtest: `LOADTEST_JWT_INTERNAL_SECRET` (dùng chung giá trị với content `JWT_INTERNAL_SECRET`), `LOADTEST_ADMIN_API_TOKEN` (dùng chung với gateway), `LOADTEST_CONTENT_SERVICE_URL` (default `http://localhost:3000`), `LOADTEST_GATEWAY_ADMIN_URL` (default `http://localhost:3005`), `LOADTEST_USER_COMMUNITY_URL` (default `http://localhost:3001` — xác minh port thực tế khi implement).

---

## 7. Màn hình cần design (6 màn + 2 ghi chú tích hợp)

1. **Admin Login** — Tái sử dụng màn login loadtest hiện có (không thiết kế mới). Ghi chú: nếu muốn tách biệt có thể thêm copy "Console quản trị — quyền hạn chế".
2. **Admin Dashboard (User State List)** — Màn hình chính: header tìm kiếm (auto-detect email/phone/name) + dropdown filter state + bảng virtualized (cột: avatar/displayName/email/state/roomId+expiry/queue position/last online) + donut phân bố state (kế thừa PhaseDonut). Badge màu theo state: xanh lá online, xanh dương in_room, vàng matching, cam cooldown, đỏ suspended, xám offline. Badge phụ "LT" (loadtest account) cho email pattern `loadtest.*@mayogu.test`. Poll 2.5s + nút refresh tay.
3. **User Detail** — Page/drawer 2 cột: trái = hồ sơ (avatar, displayName, userId, email, phone ẩn/eye); phải = state card (badge + các mốc thời gian) + card "Phòng hiện tại" (member chips có online badge, nút Mở phòng) + nút hành động (Kéo ra khỏi phòng / Hủy ghép) + dialog xác nhận gõ CONFIRM. **Khối "Trace run" (US-10)**: nếu là loadtest account — runId, index, worker, phase worker, link tới Run Detail.
4. **Room Viewer** — Header phòng (roomId mono, X/6, countdown expiresAt, badge live) + member bar + transcript chat (bubble như ChatRoom nhưng read-only, không input) + infinite scroll cursor + empty/closed state. Không có typing indicator.
5. **Rooms List** (v1.1) — Bảng mọi phòng live: roomId, occupancy X/6 (progress), expiresAt, danh sách member avatar stack, sort theo occupancy/expiry; click → Room Viewer.
6. **Enforcement Dialog** (v1.1) — Modal từ User Detail: chọn mức (SUSPEND 30 ngày / BAN vĩnh viễn / LIFTED), preview hậu quả (cắt socket, chặn reconnect), xác nhận gõ CONFIRM.

**Ghi chú tích hợp (không thiết kế mới)**: (a) Toàn bộ màn run control — ControlPanel, LiveDashboard, ScenarioBuilder, Report, History, Settings, Cleanup — **ĐÃ CÓ UI** (`src/pages/loadtest/*`), chỉ đổi nhãn tab "Users" → "Run Users" (AC-9.4) và đảm bảo nav/header nhất quán với tab Admin mới; (b) RunStickyHeader hiển thị trên mọi màn console kể cả Admin (AC-9.2).

---

## 8. Giả định (đã tự quyết định — founder không cần hỏi lại)

1. **Admin identity MVP = loadtest admin (HMAC)**: dashboard đặt dưới `/loadtest/admin` trong AppShell hiện có. Không xây auth admin sản phẩm riêng ở MVP (A5 — Future). Lý do: không tạo hệ thống mới, founder dùng công cụ này sẵn; rủi ro (tool bị expose) được kiểm soát bằng §5.8.
2. **"Vào được luôn phòng chat của user" MVP = Room Viewer read-only (transcript + snapshot)**, auto-refresh 5s. Live realtime spectator (C4) là v1.1 vì cần cơ chế admin socket an toàn, không phá IDOR guard.
3. **Force-leave không set cooldown 15p** (khớp code hiện tại: cooldown chỉ cho VOLUNTARY) nhưng **có nojoin phòng cũ 4h** (hành vi Lua hiện có). User có thể match lại ngay nhưng không quay lại phòng vừa bị kéo.
4. **Online = có ≥ 1 socket tại gateway.** Presence in-memory per-node, multi-node hợp nhất là v1.1.
5. **"Tất cả user" MVP = tìm qua `GET /user-community/users` (Admin role)** — nguồn chân lý user là Postgres user-community (chính là nơi 10k account seed được ghi — §1.4), không có index toàn cục trong Redis. Hiệu năng ≥ 10k user đạt được bằng pagination + virtualized. Loadtest DB chỉ bổ sung thông tin credential/run (F6/US-10).
6. **Console hợp nhất, một user base duy nhất**: account loadtest seed = production user (§1.4). Bảng "Run Users" (cũ) hiển thị trạng thái worker-mô-phỏng của các account trong một run; tab Admin mới hiển thị state thật (Redis/socket) của CÙNG các user đó + toàn bộ user đăng ký thật — 2 bảng nhìn cùng một user base ở 2 góc độ, không phải 2 loại dữ liệu.
7. **Admin API chỉ tồn tại nội bộ** (loadtest BFF gọi trực tiếp service), không expose qua gateway public. `JWT_INTERNAL_SECRET` + `ADMIN_API_TOKEN` là secret chung dùng bởi BFF.
8. **PhoneNumber mặc định ẩn** trong mọi màn hình admin (PII), chỉ hiện khi admin chủ động bấm eye.
9. **Quy mô MVP**: ≤ vài nghìn user online đồng thời, poll 2.5s là đủ. Nếu vượt, chuyển B5 (socket push) + filter server-side theo state lên sớm.
10. Dev topology: các service có thể cùng port 3000 trong dev (content-service `main.ts:133` mặc định 3000, gateway 3005 mặc định `main.ts:97`) — BFF cấu hình URL từng service bằng env, không hardcode.
11. **Seed 10k = production users (đính chính founder, đã chốt)**: mọi tính năng admin tác động lên user thật. Policy vận hành: cleanup loadtest chỉ dọn credential/Redis state, **không xóa user khỏi Postgres production** (§5.9); account loadtest được nhận dạng bằng pattern email nhưng được đối xử như user thường (ẩn phone, audit transcript, v.v.).
12. **Run control (Module F) không thay đổi hành vi hiện tại**: coordinator, auto-stop E1-E3, allowlist, cleanup, report — giữ nguyên; MVP chỉ tích hợp navigation/UI và thêm F6 (trace user ↔ run).

---

## 9. Technical considerations & rủi ro

| Rủi ro | Khả năng | Ảnh hưởng | Giảm thiểu |
|---|---|---|---|
| Presence map lệch count (socket chết bất thường không fire disconnect) | Trung bình | User online ảo | `pingInterval 25s/pingTimeout 60s` (`websocket.gateway.ts:28-29`) đã tự dọn; thêm reconcile định kỳ (so map với `server.sockets`) ở v1.1 |
| Kafka lag giữa action và event | Thấp | Client lệch vài trăm ms | Chấp nhận (hệ thống hiện tại đã vậy); dashboard poll lại sau 2.5s sẽ bù |
| Transcript admin bị lạm dụng (đọc chat private) | Thấp | Vi phạm quyền riêng tư | Audit log bắt buộc mỗi lần đọc (C3) + chỉ admin tool; mở rộng RBAC ở A5 |
| Force-leave race với matching tick 2s | Thấp | User vừa bị kéo vừa được seat phòng mới | Lua idempotent + check lại trước khi publish; UI refresh trạng thái sau 2.5s |
| Loadtest tool bị expose Docker | Trung bình (ops) | Lộ admin + test account | §5.8 runbook + checklist launch |
| Admin action (force-leave/cancel) tác động lên user thật — không có vùng an toàn (đính chính 0.2) | Chắc chắn (bản chất) | Kéo nhầm user, hủy nhầm lượt ghép của user thật | Dialog xác nhận gõ CONFIRM (AC-6.1); transcript audit (C3); rollback plan: user chỉ cần match lại; giới hạn quyền theo A5 (Future) |
| Cleanup loadtest (cũ) có thể đụng user table production | Thấp | Xóa nhầm user | Kiểm chứng khi implement (CleanupPage); yêu cầu: cleanup chỉ dọn Redis/credential, không xóa Postgres user (§5.9, giả định #11) |
| Đọc `match:room:{rid}:topics`/members mỗi 2.5s × N admin | Thấp (MVP 1 admin) | Tải Redis | Batch pipeline ≤ 200 user; cache 1-2s ở BFF |

**Open questions đã tự chốt**: không còn — mọi điểm đã xử lý ở §8.

---

## 10. Success metrics & launch

| Metric | Baseline | Target | Window |
|---|---|---|---|
| Admin dùng console để xử lý (số action/ngày — force-leave + cancel) | 0 | ≥ 10 tuần đầu | 30 ngày post-GA |
| Thời gian tìm ra trạng thái 1 user (search → biết in_room/offline) | N/A (phải hỏi DB/Redis thủ công) | ≤ 10 giây | 30 ngày |
| Độ chính xác state hiển thị so với Redis reality (đo bằng diff test) | N/A | 100% khớp tại thời điểm poll | 60 ngày |
| Room Viewer mở thành công (không 404/lỗi) | N/A | ≥ 99% | 30 ngày |
| Force-leave/cancel idempotent — không lỗi trùng lặp | N/A | 0 lỗi duplicate event | 60 ngày |
| Run control từ console (F1-F5) hoạt động không hồi quy | 100% (hiện tại) | 100% sau tích hợp — zero regression | GA + 7 ngày |
| Trace user ↔ run (F6) thành công cho account loadtest | 0 | 100% account khớp pattern email | 60 ngày |

**Launch plan**:
- Alpha (nội bộ): dev + founder test trên staging với run nhỏ (< 1k user) — gate: không P0, transcript + force-leave hoạt động đúng, audit log ghi, **cleanup không đụng user table** (kiểm chứng trên staging).
- Beta: 5 admin mời dùng trên môi trường chạy user thật (10k seed = production base — lưu ý: hành động beta tác động user thật, giới hạn beta ở hành động đọc + force-leave với account `[lt]` trước) — gate: 0 sự cố state lệch gây xử lý nhầm user; run control zero regression.
- GA: bật chính thức + runbook §5.8 + tài liệu vận hành (cách tra cứu, xử lý vi phạm, khôi phục nếu kéo nhầm — ghi rõ: kéo nhầm không có undo, user chỉ cần match lại; phân biệt account `[lt]` vs user đăng ký thật).
- Rollback: tắt flag route `/loadtest/admin` (SPA) — không đụng service chính; run control giữ nguyên.

---

## 11. Appendix

- Code nguồn tham chiếu: danh sách đầy đủ trong §1 (kèm file:dòng).
- **Xác minh đính chính 0.2 (seed = production users)**: `chat-app/loadtest/auth-factory.ts:238-297` (register 3 bước qua gateway thật), `gateway-auth-service/.../user.repository.adapter.ts:29-38` (createUser → `/user-community/users/`), `user-community/.../user.controller.ts:86-102` (createUser internal), `chat-app/loadtest/db/seed-accounts.ts:8-9` (credential pool — DB riêng, không phải user data).
- Docs liên quan: `docs/UI-SPEC-loadtest-tool.md`, `docs/API-loadtest-tool.md`, `docs/PRD-loadtest-admin-auth.md`, `docs/PRD-loadtest-run-database.md` (trong repo chat-app), `CHAT_API.md` (mô tả event/endpoint chat).
