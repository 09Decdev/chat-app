# PRD: Tool Load-Test Realtime MAYogu (1M → 10M user đồng thời)

**Status**: Draft — chờ review
**Author**: Alex (BA/PM)
**Version**: 0.1 — 2026-08-03
**Repo tích hợp**: `C:\MAYogu_VIASG\chat-app` (đã chốt — không bàn lại)
**Stakeholders**: Đội backend (gateway-auth-service, content-service, user-community-service), đội FE (chat-app)

---

## 0. Tóm tắt điều hành

Xây dựng **MAYogu LoadTest Tool** — công cụ giả lập hàng triệu user hoạt động đồng thời trên hệ thống thật (chat realtime, đọc bài, comment, like, xem bài), **toàn bộ tự động**: 1 nút "Bắt đầu" chạy từ đăng ký tài khoản → login → connect socket → thực thi kịch bản theo profile → dashboard realtime → báo cáo P95/P99.

**Phát hiện quan trọng từ khảo sát code** (chi tiết §1):

1. **Register bắt buộc OTP** — `POST /auth/register` verify HMAC-SHA256 của OTP lưu Redis 300s (`auth-otp.service.ts:107-143`, `auth-register.service.ts:63-100`). Tool không thể nhận email thật → **MVP dùng chế độ "OTP Seed"**: tool ghi thẳng key `otp:register:{email}` vào Redis của môi trường test (cần `OTP_SECRET` + quyền ghi Redis — giả định hạ tầng test, xem §5.4).
2. **Rate-limit chat 1 msg/2s là SILENT DROP** (`chat-message.service.ts:82-92`) → metric "gửi thành công" phải đo bằng **echo `chat:message` kèm `clientMsgId`**, không phải việc emit.
3. **Matching engine có trần ~100 user/s** (`MAX_POP=200` mỗi tick 2s, `matching-tick.service.ts:19-21`) → 1M user không thể "vào phòng" ngay lập tức; kịch bản chat phải mô hình queue + chính con số này là 1 bottleneck cần đo.
4. **Throttler gateway theo user** (authed → bucket riêng `user:{id}`, `jwt-throttler.guard.ts:53-99`) nên REST theo user không phải nút thắt; nhưng **register/login không token → bucket `guest:{ip}` 1000 req/8s** (`app.module.ts:58-78`) → ramp register phải tính toán, hoặc tăng giới hạn ở môi trường test.
5. **Access token TTL 1h** (`token.provider.adapter.ts:20-21`) → run > 1h cần refresh token hàng loạt (v1.1), MVP giới hạn duration ≤ 60 phút hoặc xử lý refresh cơ bản.
6. **Socket mất room khi reconnect** — client phải emit lại `chat:join`/`joinRoom` sau mỗi `connect` (`DESIGN-realtime-socket.md:105`).

**Chiến lược scale** (giả định hạ tầng — §5.1): một process Node.js thực tế giữ được **10k–50k socket.io-client** (bộ nhớ ~20–60KB/socket). Do đó:

| Tier | Mục tiêu | Hạ tầng chạy tool | Ghi chú |
|---|---|---|---|
| **MVP** | **10k–100k** user đồng thời, đúng & đo được | 1 máy mạnh (16–32 core, ≥64GB RAM): 1 Coordinator + 4–32 worker processes | Đúng trước, tăng sau |
| **v1.1** | **100k–1M** | Cluster 4–16 máy, 40–100 workers (mỗi worker ~10–25k socket) | Coordinator điều phối qua registry |
| **Future** | **1M–10M** | 50–200 máy + client protocol raw (ws-based, giảm overhead/socket) | Cần gateway scale-out + tuning backend (matching tick, partition Kafka) |

Trang bị sẵn preset cấu hình 1M / 10M nhưng UI cảnh báo rõ yêu cầu hạ tầng khi chọn.

---

## 1. Hiện trạng hệ thống (rút từ source thật)

### 1.1 Auth — register / login / refresh

| Bước | Endpoint | Chi tiết | Source |
|---|---|---|---|
| Check email | `POST /auth/register/check/email` | Gọi user-community-service `checkEmail` | `auth.controller.ts:79-93` |
| Gửi OTP | `POST /auth/register/send-otp` | Rate **5 lần/600s/email** + cooldown **60s/email**; OTP 6 số, hash `HMAC-SHA256(OTP_SECRET, otp)` lưu `otp:register:{email}` TTL **300s**; gửi qua Kafka `notification.send-otp` (mã hoá AES-256-GCM bằng khóa dẫn xuất từ `OTP_SECRET`) | `auth-otp.service.ts:63-144`, `:107-113`; `crypto.util.ts:19-28` |
| **Register** | `POST /auth/register` | Body: `{ otp, email, passwordHash, dateOfBirth (≥16), country, deviceInfo, firstName?, lastName?, displayName? }` — **bắt buộc OTP**; verify hash + consume nguyên tử (Lua GETDEL chống replay, max 5 lần sai); `passwordHash` thực chất là **plaintext password mạnh** (≥8 ký tự, ≥3/4 nhóm ký tự — `isValidPassword`, `auth.util.ts:7-17`); tạo user qua `createUser` (user-community); **trả luôn `accessToken` + `refreshToken`** | `auth.controller.ts:224-240`; `auth-register.service.ts:48-177`; `register.dto.ts:6-72` |
| Login | `POST /auth/login` | Body `{ email, password, deviceInfo }`; check password qua user-community `checkUser`; Adaptive 2FA (device trust — thiết bị mới có thể bị chặn tùy policy); trả token pair; **register đã trả token nên login chỉ cần khi tái sử dụng account** | `auth.controller.ts:62-77`; `auth-login.service.ts:74-154` |
| Refresh | `POST /auth/refresh-token` | Body `{ refreshToken }`; refresh token TTL **7d** | `auth.controller.ts:263-274`; `token.provider.adapter.ts:48-53` |
| Access token | — | TTL **1h** (`ACCESS_TOKEN_EXPIRES`), payload `{ sub, email, displayName, avatar, dateOfBirth, gender, tokenVersion, installationId?, deviceTokenVersion? }` | `token.provider.adapter.ts:17-46`; `auth-token.helper.ts:15-24` |
| Session | — | Mỗi token pair lưu session metadata Redis (device trust, token version) | `auth-token.helper.ts:26-58` |

**Device info** (bắt buộc khi register/login): `{ installationId: uuid, deviceFingerprint: 64-hex, platform, deviceName }` — client web hiện tạo 1 lần lưu localStorage (`chat-app/src/lib/storage.ts:58-73`). Tool sẽ sinh mỗi user một bộ deviceInfo riêng (không dùng chung) để không bị "new device" 2FA nghi ngờ.

### 1.2 Socket contract (gateway giữ socket — content-service KHÔNG giữ)

**Kết nối**: Socket.IO `ws://{gateway}:3000/socket.io/`, transports `['websocket','polling']`, `pingInterval 25s / pingTimeout 60s` (`websocket.gateway.ts:25-30`).

**Handshake** (`websocket.gateway.ts:139-189`):
- Token từ `query.token` HOẶC header `Authorization: Bearer` (`:142-149`); verify bằng `ACCESS_TOKEN_SECRET` — thiếu/sai/hết hạn → `client.disconnect()` ngay.
- Enforcement check: đọc `enforcement:user:{id}` từ shared Redis, **level ≥ 3 → disconnect** (`:174-184`, fail-open nếu Redis lỗi).
- Auto-join room `user:{id}` (nhận `matching:found`, `roomExpired`, `chat:error` riêng) (`:185-187`).
- `joinRoom { type, id }` — generic join; **chặn join `user:` của người khác** (chống IDOR) (`:191-205`); room name `"{type}:{id}"` (`room.util.ts:3-5`), `RoomTypes` enum 2 service giống nhau (`room-types.ts`).

**Events C→S** (`chat-socket.service.ts:36-61`):

| Event | Payload | Hành vi | Source |
|---|---|---|---|
| `chat:join` | `{ roomId }` | Gate membership `SISMEMBER` + `nojoin` → join → `chat:joined { roomId, members, roomEndsAt }` | `chat-socket.service.ts:104-130` |
| `chat:send` | `{ roomId, content, fileId?, clientMsgId? }` | Gate → produce `chat.room.send` (key=roomId, **eventId = clientMsgId || uuid**) | `chat-socket.service.ts:133-169` |
| `chat:typing` | `{ roomId }` | Gate → **emit local** (không qua Kafka) | `chat-socket.service.ts:172-189` |
| `chat:leave` | `{ roomId }` | Gate → produce `chat.room.leave { reason: 'VOLUNTARY' }` → cooldown 15p | `chat-socket.service.ts:192-214` |
| `chat:vote_kick:start` | `{ roomId, targetUserId }` | Produce `chat.vote_kick.command {action:'START'}` | `chat-socket.service.ts:217-244` |
| `chat:vote_kick:vote` | `{ roomId }` | Produce `chat.vote_kick.command {action:'VOTE'}` | `chat-socket.service.ts:247-273` |

**Events S→C** (client `chat-app/src/lib/socket.ts:108-164` + `types/chat.ts`): `matching:found`, `chat:joined`, `chat:message` (echo kèm `clientMsgId`), `chat:typing`, `chat:member_left`, `chat:room_closed`, `roomExpired`, `chat:error` (về room `user:{id}`), `chat:vote_kick:started/voted/result`, `chat:topic:created/updated/deleted`, `joinedRoom`.

**Pipeline outbound**: service nghiệp vụ → Kafka (envelope `{ eventId, type, entity, roomType, id, ... }`) → gateway `EventBusService` (group `gateway-consumer-group`, regex `^.*\.(event|count|post|comment)$`, retry 3 + backoff → DLQ `gateway.dead-letter`, `event-bus.service.ts:58-114`) → `WebsocketEmitterService.emitEvent` (health-gated; **thiếu roomType/id → DROP**, `websocket-emitter.service.ts:48-86`) → Socket.IO Redis adapter fan-out mọi instance.

**Room map realtime ngoài chat** (`kafka.producer.ts`): like/comment/view post → `post_realtime_event:{postId}` (`POST_LIKE_UPDATED`, `COMMENT_CREATED`, `VIEW_COUNT_UPDATED`, `POST_COMMENT_COUNT`); comment like → `comment_in_post_event:{postId}` / `comment_in_event_event:{eventId}`; post publish → `posts.event` (đã có roomType/id từ VÁ-3, `kafka.producer.ts:297-331`). Client join các room này qua `joinRoom { type, id }`.

**Reconnect**: client hiện có `reconnection: true, attempts: Infinity, delay 1s → max 10s` (`socket.ts:77-91`); **sau reconnect phải emit lại join** (`DESIGN-realtime-socket.md:105`).

### 1.3 REST endpoints dùng trong kịch bản (qua gateway, prefix `content-service`)

Gateway proxy: `ROUTE_MAP` prefix → upstream (`router.map.ts:7-47`), verify JWT → inject `x-user-id` (`gateway.service.ts:24-71`). Response bọc envelope `{ success, statusCode, data, metadata }` (`api.response.interceptor.ts`). Endpoint chính:

| Nhóm | Endpoint | Chi tiết | Source |
|---|---|---|---|
| Chat | `POST /chat/match` | Enqueue (body `{ topic? }`) — cooldown 900s sau leave, seated-check, **phone check COMMENT OUT** (`chat-message.service.ts:189-198`), `ZADD NX` idempotent | `chat.controller.ts:28-34`; `chat-message.service.ts:164-228` |
| Chat | `DELETE /chat/match` | Hủy queue (idempotent) | `chat.controller.ts:36-42` |
| Chat | `GET /chat/match/my-room` | Room hiện tại + topics (reconcile trên reconnect) | `chat.controller.ts:44-50`; `chat-message.service.ts:248-293` |
| Chat | `GET /chat/match/queue-count` | Số user trong queue (không cần token) | `chat.controller.ts:52-57` |
| Chat | `GET /chat/rooms/:roomId/messages` | History keyset cursor, **limit ≤ 100**; membership-gated | `chat.controller.ts:59-74`; `chat-message.service.ts:129-160` |
| Chat | `PUT /chat/rooms/:roomId/my-topic` | Upsert topic — rate 15s, cap 6/phòng, title 3–80 code point | `chat.controller.ts:78-88`; `chat-message.service.ts:297-408` |
| Chat | `DELETE /chat/rooms/:roomId/my-topic` | Xóa topic (idempotent) | `chat.controller.ts:90-99` |
| Post | `GET /post/getAll` | Feed phân trang `page/limit` | `post.controller.ts:294-310` |
| Post | `GET /post/:id` | Chi tiết bài (tăng view? view riêng endpoint dưới) | `post.controller.ts:576-587` |
| Post | `POST /post/:id/view` | Tăng view, **dedupe theo user 7 ngày** (`user:{uid}:viewed_posts`) | `post.controller.ts:621-640` |
| Post | `POST /post` | Tạo bài: `{ communityId, content ≤100000, layoutType, fileIds? }` — profanity filter | `post.controller.ts:75-86`; `create-post.dto.ts:17-95` |
| Comment | `POST /comments/posts/:postId` | Tạo comment root — content ≤2000, profanity | `comment.controller.ts:85-97`; `create.comment.req.dto.ts:4-52` |
| Comment | `GET /comments/posts/:postId` | Danh sách root (page/limit) | `comment.controller.ts:121-139` |
| Comment | `POST /comments/replies/:commentId` | Reply | `comment.controller.ts:99-119` |
| Comment | `PUT /comments/:commentId` / `DELETE /comments/:commentId` | Sửa/xóa | `comment.controller.ts:185-223` |
| Like | `POST /like/post/:postId` | **Toggle like/unlike** (idempotent theo cặp user+post) — async qua Kafka batch worker | `like.controller.ts:27-34` |
| Like | `POST /like/comment/:commentId` | Toggle like comment | `like.controller.ts:73-80` |

### 1.4 Giới hạn rate / cooldown / quy tắc miền (bắt buộc tôn trọng trong kịch bản)

| Giới hạn | Giá trị | Hành vi khi vi phạm | Source |
|---|---|---|---|
| Chat send | **1 msg/2s/user** (Redis NX) | **Silent drop** (không lỗi, không echo) | `chat-message.service.ts:21-22, 82-92` |
| Chat content | ≤ **4000** ký tự | BusinessException (consumer discard) | `chat-message.service.ts:21, 59-70` |
| Dedupe chat send | `evt:chat:{userId}:{eventId}:done` TTL **24h** | Retry trùng eventId bị bỏ qua | `chat-message.service.ts:24, 456-500` |
| Topic | 1 lần/**15s/user**; title 3–80 cp; cap **6 topic/phòng** | 429 `CHAT_TOPIC_RATE_LIMITED` / 409 full | `chat-message.service.ts:29, 326-353` |
| Cooldown leave | **900s** sau leave tự nguyện (không enqueue được) | 429 `CHAT_COOLDOWN_ACTIVE` | `chat-message.service.ts:555-558` |
| Vote-kick | **min 3 members**; TTL **90s**; cooldown room **300s**; target nojoin **4h** | `VOTE_*` error về initiator | `chat-message.service.ts:594-600`; `matching-redis.client.ts:73-103` |
| Room | capacity **6**; TTL **3h** (soft 15m min); nojoin **4h** sau leave/kick | — | `matching-tick.service.ts:16-20`; `matching-redis.client.ts:4-71` |
| Matching | Tick **2s**, `MAX_POP=200`/tick (`CHAT_MATCH_MAX_POP`), min 2 user | → trần seat ~100 user/s | `matching-tick.service.ts:19-21` |
| OTP register | **5/600s/email** + cooldown **60s**; TTL 300s | 429 | `auth-otp.service.ts:93-105, 139-141` |
| Throttler gateway | Authed: `user:{id}` 1000/8s, 15000/30s, 20000/60s; **guest: `guest:{ip}` 1000/8s** | 429 + block 30–120s | `app.module.ts:58-78`; `jwt-throttler.guard.ts:53-99` |
| Comment | content ≤ 2000; profanity filter (leo-profanity + danh sách tiếng Việt) | `ProfanityContentException` | `create.comment.req.dto.ts:12`; CLAUDE.md |
| Post | content ≤ 100000; profanity + safe-browsing | `ProfanityContentException` | `create-post.dto.ts:42` |
| View | dedupe theo user 7 ngày, max 1000 bài/user | đếm 1 lần | CLAUDE.md (Redis view) |
| Like | async batch worker (không đồng bộ) | eventual consistency | CLAUDE.md (worker.ts) |

### 1.5 Tài sản có sẵn kế thừa (ĐÃ CÓ) vs phải thêm (CẦN THÊM)

**ĐÃ CÓ (kế thừa từ chat-app / harness cũ `.socket-test-harness/`):**
- `chat-app/src/lib/socket.ts` — SocketManager: outbox + `clientMsgId` + echo-matching (đúng mẫu "gửi thành công = echo"), reconnect Infinity backoff 1s→10s, đủ handlers theo contract.
- `chat-app/src/types/chat.ts` — toàn bộ payload types (ChatSendPayload, MatchingFoundPayload, ...).
- `chat-app/src/lib/api.ts` — axios client + envelope unwrap + refresh-token interceptor + ApiError chuẩn hóa; có `login`, chat REST (enqueue/cancel/my-room/queue-count/messages/topic).
- `chat-app/src/lib/storage.ts` — deviceInfo factory (installationId + fingerprint).
- `chat-app` UI kit: React 18 + Vite + Tailwind + Zustand + Radix UI (có sẵn Button/Dialog/ScrollArea/Label/Avatar...) — dùng làm nền dashboard.
- Harness `.socket-test-harness/` — helpers `createSocket/waitEvent/emitJoinRoom` (lib/socket.js), kịch bản run-a..e; **tạo token bằng JWT ký tay** (`lib/token.js`) → tool mới THAY bằng register/login thật; quy ước timeout (CONNECT_WAIT 5s, MATCH_WAIT 15s, RATE_GAP 2.3s...) tham khảo tốt.
- Gateway `/metrics` Prometheus (`ws_connections`, `ws_messages_emitted_total{type}`...) — dùng cho server-side view (harness đã chứng minh `verify-post-created.js:11-15`).

**CẦN THÊM:** toàn bộ phần sinh tải (Auth Factory, Socket Farm, REST Driver, Scenario Engine), Coordinator + worker processes (Node server), metrics aggregation + histogram, dashboard React mới (route `/loadtest`), Report/Export, Control Panel, cleanup. Xem §2.

---

## 2. Danh sách tính năng theo module

**Nhãn**: **MVP** (bản đầu phải có) · **v1.1** (ngay sau MVP) · **Future** (xa hơn).

### 2.1 Module: Control Panel (điều khiển chạy)

| # | Tính năng | Nhãn | Mô tả |
|---|---|---|---|
| CP-1 | Cấu hình run: target users (10k/50k/100k + custom), ramp-up (users/s hoặc phút), duration, action profile | **MVP** | Preset 1M/10M hiển thị kèm cảnh báo hạ tầng |
| CP-2 | Nút **Bắt đầu / Dừng (kill-switch) / Tạm dừng-Tiếp tục** | **MVP** | Dừng = dừng sinh action + disconnect socket có kiểm soát; kill-switch dừng ngay |
| CP-3 | Trạng thái run (idle/provisioning/ramping/steady/cooldown/finished/error) + timeline | **MVP** | UI phản ánh phase của Scenario Engine |
| CP-4 | Preset lưu/load (localStorage + export JSON) | v1.1 | |
| CP-5 | Lịch chạy tự động (schedule), nhiều run song song | Future | |

### 2.2 Module: Auth Factory (sinh tài khoản + token)

| # | Tính năng | Nhãn | Mô tả |
|---|---|---|---|
| AF-1 | **OTP-Seed register hàng loạt**: seed key `otp:register:{email}` vào Redis test (HMAC-SHA256 với `OTP_SECRET`) rồi gọi `POST /auth/register` (email `loadtest.{runId}.{n}@mayogu.test`) — bỏ qua `send-otp` (tránh 60s cooldown + Kafka notification) | **MVP** | Cần `OTP_SECRET` + Redis write access — giả định §5.4 |
| AF-2 | Token pool: lưu `{ email, password, accessToken, refreshToken, userId }` vào memory + disk cache (run tiếp theo **login lại** để lấy token mới — không register lại) | **MVP** | |
| AF-3 | Concurrency control: register ramp ≤ 100 req/s/máy test (tránh bucket `guest:{ip}` 1000/8s), retry + exponential backoff, đếm thành công/thất bại | **MVP** | |
| AF-4 | Login hàng loạt (reuse account pool) | **MVP** | `POST /auth/login` với deviceInfo riêng mỗi user |
| AF-5 | Refresh token hàng loạt trước khi hết hạn (run > 1h) | v1.1 | MVP giới hạn duration ≤ 60 phút |
| AF-6 | Chế độ "realistic OTP": consume Kafka `notification.send-otp`, giải mã AES-256-GCM bằng `OTP_SECRET` rồi register | v1.1 | Kiểm chứng flow OTP thật |
| AF-7 | Mô phỏng social login (Google/Apple) | Future | |

### 2.3 Module: Socket Farm (sinh kết nối socket hàng loạt)

| # | Tính năng | Nhãn | Mô tả |
|---|---|---|---|
| SF-1 | Worker processes (child_process cluster) — mỗi worker giữ N socket.io-client; worker farm quản lý lifecycle | **MVP** | Transports `['websocket']` (bỏ polling — giảm overhead) |
| SF-2 | Kết nối với token (query + header, đúng contract `websocket.gateway.ts:142-149`), reconnect policy, **re-join room sau reconnect** | **MVP** | |
| SF-3 | Event buffer có giới hạn (bounded ring buffer/socket) + event counter (không giữ toàn bộ payload ở quy mô lớn) | **MVP** | Chống memory blow-up |
| SF-4 | Per-user pacing chuẩn: chat send ≥ 2s/user, typing 1.5s debounce, topic 15s — tôn trọng rate-limit server | **MVP** | |
| SF-5 | **Outbox + clientMsgId** (kế thừa pattern `socket.ts:182-214`): gửi xong chờ echo `chat:message` (cùng clientMsgId) trong TTL 60s → metric thành công; retry với cùng clientMsgId → server dedupe an toàn | **MVP** | |
| SF-6 | Chia kết nối qua nhiều gateway URL (round-robin) — phản ánh topology multi-instance | v1.1 | |
| SF-7 | Client protocol raw (ws + tự đóng gói Socket.IO) giảm ~50% bộ nhớ/socket | Future | Cho 10M |

### 2.4 Module: REST Driver (sinh traffic REST)

| # | Tính năng | Nhãn | Mô tả |
|---|---|---|---|
| RD-1 | Action library: GET post detail, GET feed, view, comment create/list, like toggle post/comment, chat enqueue/cancel/my-room/queue-count, history | **MVP** | Mỗi action: payload factory + validate response + đo latency |
| RD-2 | Pacing + jitter (phân bố thời gian nghỉ giữa action theo profile), retry idempotent (like toggle, enqueue ZADD NX, topic upsert, view dedupe) | **MVP** | |
| RD-3 | Nội dung test **sạch** (không từ vi phạm profanity filter; prefix chuẩn) — chống lẫn vào dữ liệu thật | **MVP** | |
| RD-4 | Action tạo bài viết (cần fixture `communityId` từ môi trường test), search, topic PUT/DELETE | v1.1 | |
| RD-5 | Upload media, premium post flow, ticket/event flow | Future | |

### 2.5 Module: Scenario Engine (kịch bản tự động)

| # | Tính năng | Nhãn | Mô tả |
|---|---|---|---|
| SE-1 | Script kịch bản dạng YAML/JSON: `rampUp`, `duration`, `phases`, `profiles` (phân bố % user làm gì: chat 40% / read 30% / comment 20% / like 10%...), `pacing` | **MVP** | |
| SE-2 | State machine per user: `provisioned → connecting → connected → queued → in_room → (leave/expire) → idle/looping` — theo đúng vòng đời chat thật | **MVP** | |
| SE-3 | **Matching queue awareness**: theo dõi `queue-count`, chờ `matching:found` (timeout 60s), xử lý room expired/room_closed; biết trần 100 user/s của matching engine | **MVP** | |
| SE-4 | Pha cooldown cuối run: dừng sinh action, chờ echo dứt điểm, chốt số liệu | **MVP** | |
| SE-5 | Validators: echo khớp clientMsgId, event đến đúng room, `chat:joined` members đủ | **MVP** | |
| SE-6 | Auto-adapt: nếu latency/queue tăng quá ngưỡng → tự giảm pacing (backoff toàn cục) | v1.1 | |
| SE-7 | Fault injection (mất socket đột ngột, dừng worker giữa chừng) | Future | |

### 2.6 Module: Dashboard (quan sát realtime)

| # | Tính năng | Nhãn | Mô tả |
|---|---|---|---|
| DB-1 | Metrics aggregation 1s (từ worker → coordinator qua IPC) + HDR histogram latency theo action | **MVP** | |
| DB-2 | Chart realtime (realtime WebSocket từ coordinator tới React): tổng user connect/active, actions/s theo loại, latency P50/P95/P99, success rate, error rate theo mã, echo rate (chat), queue-count, số room, message throughput | **MVP** | CẦN THÊM thư viện chart (recharts) |
| DB-3 | Server-side view: scrape gateway `/metrics` (ws_connections, ws_messages_emitted_total) | **MVP** | |
| DB-4 | Bảng lỗi top (mã lỗi, tần suất, mẫu payload) | MVP | |
| DB-5 | User Detail/Inspect: chọn 1 user → xem trạng thái, room, các event nhận/gửi gần đây, timeline | v1.1 | |
| DB-6 | Breakdown theo worker/máy; topology map gateway instances | v1.1 | |
| DB-7 | Cảnh báo ngưỡng (latency spike, error burst) + lưu lịch sử run | Future | |

### 2.7 Module: Report / Export (kết quả sau run)

| # | Tính năng | Nhãn | Mô tả |
|---|---|---|---|
| RE-1 | Summary: tổng user đã tạo/connect/active tối đa, actions thực hiện, success rate, throughput trung bình/đỉnh, latency P50/P95/P99 từng action, error rate | **MVP** | |
| RE-2 | **Phát hiện bottleneck**: so ngưỡng (matching 100/s, chat echo rate, queue tăng liên tục, CPU/mem worker) → liệt kê nghi vấn kèm bằng chứng | **MVP** | |
| RE-3 | Export: JSON (full) + Markdown (human) + CSV (raw metrics) — lưu `docs/loadtest-reports/` hoặc tải về | **MVP** | |
| RE-4 | HTML report (biểu đồ nhúng), so sánh 2 run | v1.1 | |
| RE-5 | Baseline theo dõi theo thời gian; tích hợp CI | Future | |

### 2.8 Module: An toàn & Dọn dẹp (cross-cutting)

| # | Tính năng | Nhãn | Mô tả |
|---|---|---|---|
| SD-1 | **Environment guard**: chặn chạy nếu gateway URL không thuộc danh sách test-allowlist; confirm modal trước khi chạy | **MVP** | |
| SD-2 | Namespace dữ liệu test: email `loadtest.{runId}.*`, nội dung prefix `[lt]`, tách biệt dữ liệu thật | **MVP** | |
| SD-3 | Kill-switch toàn cục (dừng mọi worker ≤ 5s) | **MVP** | |
| SD-4 | Cleanup script: xóa user test (qua admin/user-community hoặc script DB), xóa key Redis `match:*` / `otp:register:*` / `chat:*` / `enforcement:user:*` của namespace test, xóa post/comment/message test | **MVP** | |
| SD-5 | Auto-cleanup sau run (có cấu hình bật/tắt) | v1.1 | |
| SD-6 | Cấp phép hạ tầng test riêng (provision cluster test) | Future | |

---

## 3. User story + Acceptance criteria (tính năng MVP)

### US-01 — Một nút chạy toàn bộ (Core)

> **Với tư cách** là kỹ sư backend cần đo hệ thống dưới tải,
> **tôi muốn** bấm 1 nút "Bắt đầu" để tool tự đăng ký user, login, connect socket và chạy kịch bản,
> **để** tôi không phải can thiệp tay từng bước và có kết quả đáng tin cậy.

**AC:**
- [ ] AC1.1: Bấm "Bắt đầu" → tool chạy tuần tự: provision auth (register/login) → connect socket → thực thi action theo profile, không cần thao tác trung gian.
- [ ] AC1.2: Toàn bộ phase chuyển trạng thái hiển thị trên UI (idle → provisioning → ramping → steady → cooldown → finished).
- [ ] AC1.3: Một trong các bước lỗi (register fail > 50%, connect fail > 30%) → run tự dừng với báo cáo lỗi tổng hợp, không chạy tiếp kịch bản vô nghĩa.
- [ ] AC1.4: Bấm "Dừng" giữa chừng → tất cả socket disconnect sạch ≤ 10s, báo cáo partial được tạo.
- [ ] AC1.5: Với target 10.000 user, toàn bộ pipeline (đăng ký→connect→có user trong phòng) chạy được trong ≤ 15 phút trên máy test chuẩn.

### US-02 — Đăng ký tài khoản hàng loạt qua OTP-Seed (Auth Factory)

> **Với tư cách** là người chạy load test,
> **tôi muốn** tool tự tạo hàng nghìn tài khoản thật qua `POST /auth/register` (không cần email/SMS),
> **để** traffic của tôi đi qua đúng flow xác thực của production.

**AC:**
- [ ] AC2.1: Mỗi user có email duy nhất theo namespace `loadtest.{runId}.{n}@mayogu.test` + password đạt `isValidPassword` (≥8 ký tự, ≥3/4 nhóm) + `dateOfBirth` ≥ 16 tuổi + `deviceInfo` riêng (installationId uuid, fingerprint 64-hex).
- [ ] AC2.2: Tool seed key `otp:register:{email}` (TTL 300s, đúng định dạng `{otpHash, attempt}` mà server đọc, hash = HMAC-SHA256(`OTP_SECRET`, otp đã chọn)) trước khi gọi register; không gọi `send-otp`.
- [ ] AC2.3: Register thành công → nhận `accessToken` + `refreshToken` và lưu vào token pool (memory + disk); user tiếp theo không register trùng email.
- [ ] AC2.4: Register ramp giữ ≤ 100 req/s (mặc định, cấu hình được) — không vượt bucket `guest:{ip}` 1000/8s; quá ngưỡng → tự giảm tốc + ghi warning.
- [ ] AC2.5: Tỷ lệ register thành công, mã lỗi phân loại (OTP invalid, email exists, throttler, 5xx) hiển thị realtime trên dashboard.
- [ ] AC2.6: Chạy lại run với cùng runId/account pool → dùng login (không register lại), trừ khi `--fresh`.

### US-03 — Socket farm kết nối + chat thật sự được echo

> **Với tư cách** là người load test,
> **tôi muốn** N worker duy trì N kết nối socket.io đến gateway và gửi tin nhắn chat,
> **để** đo được throughput + latency end-to-end của pipeline chat (gateway → Kafka → content → Kafka → gateway → client).

**AC:**
- [ ] AC3.1: Mỗi socket connect bằng token hợp lệ (query + header); `connect_error`/disconnect → reconnect theo backoff 1s→10s (reuse policy `socket.ts:77-91`); sau reconnect tự emit lại `chat:join`/`joinRoom` đang hoạt động.
- [ ] AC3.2: Enqueue match → chờ `matching:found` (timeout 60s) → `chat:join` → nhận `chat:joined` có `roomId` — chuỗi này là 1 "chat cycle" thành công.
- [ ] AC3.3: Gửi `chat:send` kèm `clientMsgId` duy nhất → **metric thành công = nhận echo `chat:message` cùng `clientMsgId` trong ≤ 60s**; không echo → đếm là fail/rate-limited và **không retry cùng nội dung trừ khi dùng cùng clientMsgId** (server dedupe 24h).
- [ ] AC3.4: Pacing mỗi user ≥ 2s giữa 2 lần send (server rate-limit silent drop — không để thải rác vào hệ thống).
- [ ] AC3.5: Một socket tối đa 1 room chat đồng thời; sau `roomExpired`/`chat:room_closed` hoặc leave → user vào cooldown 900s (không enqueue lại ngay — tôn trọng `CHAT_COOLDOWN_ACTIVE`).
- [ ] AC3.6: Mỗi worker giữ ≥ 5.000 socket ổn định (không leak memory, RSS tăng < 10%/10 phút) ở target 10k–100k.

### US-04 — REST driver đọc bài / comment / like

> **Với tư cách** là người load test,
> **tôi muốn** user ảo đồng thời GET bài viết, xem, comment và like,
> **để** đo REST/DB/Kafka của content-service dưới tải hỗn hợp.

**AC:**
- [ ] AC4.1: Action distribution theo profile (vd: chat 40%, read 30%, comment 20%, like 10%) — tổng 100%, mỗi user chọn 1 profile lúc sinh.
- [ ] AC4.2: GET `post/getAll` + GET `post/:id` + POST `post/:id/view` với post fixture (có sẵn từ môi trường test) — response 2xx mới tính success; 4xx/5xx ghi mã lỗi.
- [ ] AC4.3: Comment: content ≤ 2000 ký tự, **không chứa từ profanity** (thư viện `leo-profanity` + danh sách VN sẽ chặn) — nội dung mẫu prefix `[lt]`; nếu server trả `ProfanityContentException` do nội dung → đếm là bug của fixture, không phải lỗi hệ thống (ghi rõ loại).
- [ ] AC4.4: Like toggle: cùng cặp user+post chỉ gọi lại sau ≥ 30s (tránh toggle liên tục tạo noise); phản hồi 2xx.
- [ ] AC4.5: Mỗi action đo latency (P50/P95/P99) + throughput; thành công/ thất bại tách biệt; retry tối đa 2 lần với backoff cho transient (5xx/timeout), **không retry** cho 4xx.
- [ ] AC4.6: Không vượt bucket throttler per-user (1000/8s) — pacing engine giới hạn ≤ 100 action/s/user.

### US-05 — Dashboard realtime

> **Với tư cách** là người vận hành load test,
> **tôi muốn** xem realtime "1 triệu user đang làm gì",
> **để** phát hiện bottleneck và quyết định dừng/điều chỉnh kịp thời.

**AC:**
- [ ] AC5.1: Độ trễ dữ liệu dashboard ≤ 3s so với thời điểm xảy ra (aggregation 1s + push qua WebSocket).
- [ ] AC5.2: Tối thiểu các chart: active connections (line), actions/s theo loại (stacked bar/area), latency P50/P95/P99 theo action (line), success rate % (gauge), error rate + top errors (table), chat echo rate, queue-count, số room đang mở, server-side ws_connections từ gateway `/metrics`.
- [ ] AC5.3: Khi run đang chạy, mọi con số tự cập nhật không cần refresh trang; dừng run → chart giữ nguyên cho phân tích.
- [ ] AC5.4: Dashboard hoạt động ổn định khi worker sinh ra ít nhất 100k events/s aggregate (ring buffer + sampling, không rớt mất mạch).

### US-06 — Báo cáo & bottleneck detection

> **Với tư cách** là kỹ sư chịu trách nhiệm năng lực hệ thống,
> **tôi muốn** nhận báo cáo summary P95/P99, success rate, throughput và danh sách nghi vấn bottleneck,
> **để** có bằng chứng trình đội backend điều chỉnh.

**AC:**
- [ ] AC6.1: Sau khi run kết thúc (bình thường hoặc dừng sớm), báo cáo được tạo ≤ 30s, gồm: tổng user (tạo/connect/active max), tổng action theo loại, success rate từng loại, throughput (avg/peak), latency P50/P95/P99 từng action, error rate, duration thực tế, cấu hình run (full snapshot).
- [ ] AC6.2: Bottleneck detector đối chiếu ít nhất các ngưỡng: chat echo rate < 95% (nghi ngờ rate-limit/backend), queue-count tăng liên tục > 5 phút (nghi ngờ matching trần 100/s), latency P95 tăng > 2× so với 5 phút đầu (nghi ngờ DB/Kafka), worker CPU > 85% (nghi ngờ tool-side); mỗi phát hiện kèm biểu đồ bằng chứng.
- [ ] AC6.3: Export được JSON (đầy đủ), Markdown (tóm tắt), CSV (raw metrics 1s) — file lưu kèm runId.
- [ ] AC6.4: Dữ liệu báo cáo khớp ±1% với tổng events mà worker đã ghi (tính nhất quán giữa aggregate và counter cuối).

### US-07 — An toàn: không phá production, dọn dẹp sạch

> **Với tư cách** là người quản trị hệ thống,
> **tôi muốn** tool không bao giờ chạy nhầm vào production và tự dọn dữ liệu test,
> **để** hệ thống thật và dữ liệu người dùng thật được an toàn tuyệt đối.

**AC:**
- [ ] AC7.1: Chặn cứng khi gateway URL không nằm trong allowlist test (config file); UI hiển thị cảnh báo đỏ + yêu cầu gõ "TÔI XÁC NHẬN" trước khi chạy.
- [ ] AC7.2: Mọi dữ liệu sinh ra đều gắn namespace `loadtest.{runId}` (email, displayName, content prefix `[lt]`) — không trùng/không lẫn user thật; user thật không bao giờ bị đụng (chỉ thao tác account do tool tạo).
- [ ] AC7.3: Kill-switch: dừng mọi worker và disconnect ≤ 5s từ UI lẫn từ CLI.
- [ ] AC7.4: Cleanup script xóa: user test (qua user-community admin/internal API), post/comment/message có prefix `[lt]` hoặc author test, key Redis `match:*` của room test, `otp:register:*` của email test, session/device của user test. Dry-run mode trước khi xóa thật.
- [ ] AC7.5: Sau cleanup, kiểm tra lại: không còn user `loadtest.*` active, Redis `ZCARD match:queue:waiting` = 0 (hoặc về baseline), không còn post/comment prefix `[lt]`.

---

## 4. User flow chính

```text
1. Mở dashboard: http://localhost:5173/loadtest
2. Chọn preset hoặc cấu hình run (target, ramp-up, duration, action profile, gateway test URL)
   → UI hiện ước lượng hạ tầng cần (số worker, RAM) + cảnh báo nếu target > khả năng máy hiện tại
3. Bấm "Bắt đầu" → xác nhận (nhập mã xác nhận + xác nhận đây là môi trường test)
4. Tool tự chạy:
   a. Auth Factory: register/login N user (OTP-Seed) → token pool
   b. Socket Farm: khởi động K worker, connect socket theo token pool (websocket-only)
   c. REST Driver: user ảo chạy action theo profile (đọc bài, comment, like, xem)
   d. Chat cycle: enqueue → matching:found → chat:join → chat:send/echo → (roomExpired/leave)
5. Trong lúc chạy: dashboard hiển thị realtime (connections, actions/s, latency P50/P95/P99,
   success/error rate, queue-count, server-side metrics) — điều chỉnh/dừng nếu cần
6. Hết duration (hoặc bấm Dừng) → phase cooldown: chờ echo dứt điểm, chốt số liệu
7. Xem báo cáo summary + bottleneck candidates → Export JSON/MD/CSV
8. (Tùy chọn) Chạy cleanup script → xác nhận hệ thống test sạch
```

**Vòng đời 1 user ảo** (do Scenario Engine điều khiển):

```text
provisioned → (register/login ok) → connecting → connected → queued → in_room
             → idle/looping (đọc bài/comment/like theo pacing) → [roomExpired | leave]
             → cooldown 900s (không enqueue lại) → loop lại từ đầu (nếu còn duration)
```

---

## 5. Điểm đặc thù của miền (domain specifics)

### 5.1 Quy mô 1M–10M kết nối — giả định hạ tầng

- **Ngưỡng 1 process**: socket.io-client ~20–60KB/socket (object + engine + frame buffer + outbox) → 10k ≈ 0.2–0.6GB, 100k ≈ 2–6GB RAM; event loop bão hòa ~50–100k msg/s/process. **MVP chốt: 10k–100k/1 máy, 4–32 workers** (mỗi worker 2.5–10k socket).
- **Backpressure**: không chờ ack từ server (socket.io emit là fire-and-forget) → worker phải có **outbox có TTL (60s) + giới hạn hàng đợi** (vd 1.000 pending/user, vượt → đếm dropped + giảm pacing) — không để memory tăng vô hạn khi server chậm echo.
- **Memory của coordinator**: không giữ event thô toàn cục — worker giữ ring buffer (1s) + counters; coordinator chỉ aggregate tổng hợp. Dashboard dùng sampling khi > 100k events/s.
- **Multi-node (v1.1+)**: coordinator = HTTP control plane + registry; worker node chạy agent (Node) nhận lệnh run/stop, đẩy metrics; topology phản ánh multi-gateway production (LB + Redis adapter fan-out).
- **10M (Future)**: cần client protocol raw (ws + tự đóng gói Socket.IO), ~10–20KB/socket; đồng thời backend phải scale-out (nhiều gateway instance, matching tick phân tán, đủ partition Kafka) — PRD này coi **10M là mục tiêu kiến trúc, không phải cam kết 1 máy**.

### 5.2 Idempotency / dedupe khi retry

| Hành động | Cơ chế server | Cách tool dùng |
|---|---|---|
| Chat send | `evt:chat:{userId}:{eventId}:done` TTL 24h (`chat-message.service.ts:463-483`) | Retry **cùng `clientMsgId`** — an toàn, không trùng message |
| Enqueue match | `ZADD NX` (`matching-redis.client.ts:269-274`) | Retry an toàn; kiểm tra kết quả `{ queued, position }` |
| Like toggle | Unique (user, post) — toggle | Retry an toàn (toggle 2 lần = về trạng thái cũ — tránh retry mù) |
| View | Dedupe `user:{uid}:viewed_posts` 7 ngày | Retry vô hại (đếm 1 lần) |
| Topic upsert | HASH field=userId (`matching-redis.client.ts:473-475`) | Retry an toàn |
| Register | OTP consume nguyên tử 1 lần (`auth-register.service.ts:102-111`) | **Không retry register cùng email sau khi consume OTP** — seed OTP key mới nếu retry |

### 5.3 Rate-limit / cooldown của hệ thống thật — ảnh hưởng kịch bản

- **Chat 1 msg/2s SILENT DROP**: nếu tool gửi nhanh hơn, không có lỗi nhưng message biến mất → echo rate < 100% là **đặc tính của hệ thống**, không phải bug; báo cáo phải tách "rate-limited (no echo)" khỏi "lỗi thật".
- **Matching trần ~100 user/s** (`MAX_POP=200/tick 2s`): ramp 100k user vào chat mất ~17 phút; 1M ~ 2.8h → UI phải dự báo "thời gian seat ước tính" từ queue-count; báo cáo ghi nhận đây là bottleneck nếu queue tăng liên tục.
- **Cooldown 900s sau leave**: user không thể vòng lặp "join→leave→join" nhanh; kịch bản phải có đủ user hoặc chấp nhận vòng lặp chậm.
- **Vote-kick min 3 members, 90s TTL, room cooldown 300s**: chỉ phát trong room đủ member, pacing theo cooldown; nếu không → `VOTE_*` error là dự kiến (đếm riêng).
- **Topic 15s/user + cap 6/phòng**: pacing 1 topic/user/≥15s; chỉ 6 user/phòng có topic.
- **Throttler gateway**: authed theo user (bucket rộng, hiếm chạm); guest (register/login) theo IP 1000/8s → giới hạn register ramp hoặc nâng giới hạn trong test env.
- **Access token 1h**: duration > 60 phút (MVP) cần kế hoạch refresh hoặc giảm target.

### 5.4 Chống spam phá production & môi trường chạy

- **Bắt buộc môi trường TEST ISOLATED** (staging clone topology: gateway + content + user-community + Kafka + Redis + Postgres), **KHÔNG BAO GIỜ chạy production** — guard cứng bằng allowlist URL.
- Giả định hạ tầng test: tool có **`OTP_SECRET`** + **quyền ghi Redis** (seed OTP) + fixture dữ liệu (1 community + vài bài viết chuẩn). Nếu không có OTP_SECRET → MVP không register được → phải dùng v1.1 "realistic OTP" hoặc account pool thủ công.
- Nên dùng Redis/PG **riêng cho test** (không phải Redis chứa session thật của dev) để cleanup không ảnh hưởng người khác.
- Ramp-up mặc định thận trọng (không "đập 1M vào lúc 0s"); mọi thay đổi tốc độ có giới hạn trên tuyệt đối (config).

### 5.5 Dữ liệu test tự sinh — dọn dẹp & an toàn dữ liệu

- Namespace `loadtest.{runId}` ở mọi nơi (email, displayName, content prefix `[lt]`, deviceName).
- Cleanup 3 tầng: (1) API nghiệp vụ (user-community delete user, content delete post/comment theo author), (2) Redis keys theo pattern `otp:register:loadtest.*`, `match:*` (room của run), `chat:*`, `enforcement:user:*` (nếu có), (3) kiểm tra baseline sau khi xóa.
- **Không dùng user thật**: tool chỉ thao tác account do chính nó tạo; không đọc/dùng dữ liệu cá nhân người dùng thật; report không chứa nội dung message (chỉ số liệu).
- Retention: report JSON giữ tối đa 30 ngày (config), raw metrics CSV có thể nén lưu theo runId.

---

## 6. Danh sách màn hình cần design

| # | Màn hình | Mô tả (2–3 dòng) |
|---|---|---|
| 1 | **Control Panel** (`/loadtest`) | Trang chính: form cấu hình run (target, ramp-up, duration, action profile, gateway URL, preset 1M/10M kèm cảnh báo hạ tầng), nút Bắt đầu/Dừng/Tạm dừng, trạng thái run + timeline phase, tổng quan nhanh (user đã tạo/connect/active). |
| 2 | **Live Dashboard** | Khu chart realtime: active connections, actions/s theo loại (stacked), latency P50/P95/P99 theo action (line, log-scale tùy chọn), success rate gauge, error rate + top errors table, chat echo rate, queue-count, số room, server-side metrics (gateway `/metrics`). Tự cập nhật ≤ 3s. |
| 3 | **User Detail / Inspect** (v1.1) | Chọn 1 user ảo: trạng thái hiện tại (phase, roomId, actions gần đây), timeline event nhận/gửi (bounded, 200 gần nhất), nút "theo dõi" để xem realtime riêng. |
| 4 | **Scenario Builder** | Editor script YAML/JSON kịch bản: phases, profiles (% action), pacing, validators; validate cú pháp + cảnh báo vi phạm giới hạn hệ thống (chat 2s, cooldown 900s, matching 100/s); lưu/load preset. |
| 5 | **Report** | Sau run: summary metrics (P50/P95/P99, success rate, throughput, error), bottleneck candidates kèm bằng chứng (biểu đồ vùng nghi vấn), cấu hình run đầy đủ, nút export JSON/MD/CSV; lịch sử run (danh sách + so sánh v1.1). |
| 6 | **Settings** | Cấu hình tool: đường dẫn gateway test (allowlist), Redis/OTP_SECRET path (test env), giới hạn mặc định (register ramp, per-user pacing), retention report, cờ "chạy trong môi trường test" + danh sách thao tác cleanup (dry-run/thật). |
| 7 | **Cleanup** (có thể gộp vào Settings) | Trình bày dữ liệu test tìm thấy theo namespace, nút Dry-run → Thực thi, kết quả từng bước xóa, kiểm tra baseline sau xóa. |

---

## 7. Phụ lục — tham chiếu nguồn

- Hợp đồng FE realtime: `content-service/docs/DESIGN-realtime-socket.md` (v1.3), `content-service/docs/DESIGN-realtime-hardening.md`, `content-service/docs/TEST-realtime-socket.md` (37 PASS/2 FAIL — lưu ý `COMMENT_DELETED` chưa emit, comment POST emit vào `post_realtime_event`).
- Harness cũ (tham khảo helper/thời gian chờ): `C:\MAYogu_VIASG\.socket-test-harness\` (lib/socket.js, lib/token.js, config.js, run-a..e, verify-post-created.js).
- CLAUDE.md `content-service` — kiến trúc, DI tokens, exception/response format, Kafka topics, Redis keys, enforcement.

## 8. Giả định & quyết định đã tự chốt (không hỏi lại)

1. **Kiến trúc tool**: bộ sinh tải là **Node server process** (Coordinator + workers) nằm trong repo chat-app (script `loadtest:server`, thư mục `loadtest/`), **không chạy trong browser** (browser giới hạn ~6 conn/host, không spawn worker). Dashboard là React trong cùng repo, route `/loadtest`.
2. **MVP scale = 10k–100k đúng trên 1 máy trước**; 1M/10M là preset có cảnh báo hạ tầng, hiện thực hóa đầy đủ ở v1.1/Future với cluster.
3. **OTP-Seed là cơ chế register MVP** — giả định môi trường test cho phép tool đọc `OTP_SECRET` và ghi Redis.
4. **Chat success = echo** (không phải emit); silent-drop rate-limit tách khỏi lỗi thật trong mọi metric.
5. **Run duration MVP ≤ 60 phút** (access token 1h); refresh hàng loạt ở v1.1.
6. **Dữ liệu test phải sạch profanity** (nội dung prefix `[lt]`, không từ nhạy cảm) để không dính `ProfanityContentException`.
7. **User ảo không cần verify phone** — phone check đang COMMENT OUT ở `chat-message.service.ts:189-198`, và register không bắt buộc phone.
8. **Không sửa source hệ thống** để phục vụ tool (trừ giới hạn môi trường test như nâng throttler guest — ghi chú cấu hình env, không đổi code).
