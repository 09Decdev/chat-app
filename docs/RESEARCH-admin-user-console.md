# RESEARCH: Admin User Console — bản đồ API + state thật (trước khi code)

**Ngày**: 2026-08-05 · **Trạng thái**: research hoàn tất, sẵn sàng cho design + code
**Nguồn**: đọc toàn bộ 3 service (content-service, gateway-auth-service, user-community-service) — mọi claim đều có file:dòng.

---

## 1. Tóm tắt phát hiện chính

1. **Online/offline KHÔNG tồn tại dưới dạng query được** — chỉ có Gauge tổng `wsConnections` trong memory gateway. Phải xây mới: map `userId → {socketCount, lastSeenAt}` + 1 endpoint admin.
2. **"User X đang làm gì" = 5 check Redis rời rạc** (không có 1 key tổng): room / queue / cooldown / nojoin / enforcement. Cần 1 endpoint aggregation mới ở content-service.
3. **Force-leave đã có Lua dùng được ngay** (`runLeaveRoom`) nhưng **thiếu 3 mắt xích**: publish `chat:member_left` reason `'ADMIN'` (union type chưa có), xóa room topic, và gateway chưa có nhánh force-leave socket (pattern sẵn có: `forceLeaveKicked` cho vote-kick).
4. **Transcript admin: chưa có bypass** — phải thêm endpoint mới gọi thẳng repo + audit log (AuditLogModule có sẵn).
5. **Ban = publish `user.enforcement.changed`** (pipeline trust-safety, cắt socket + chặn reconnect). Endpoint admin để publish chưa có. Khác hệ với `User.status LOCKED` (user-community).
6. **Admin pattern chuẩn của hệ**: internal JWT HS256 `JWT_INTERNAL_SECRET` maxAge 60s (Bearer) cho admin endpoints; `x-service-token` (static `INTERNAL_SERVICE_TOKEN`) cho internal endpoints. BFF admin cần **cả 2** + `JWT_INTERNAL_KEY`.
7. **CẢNH BÁO**: REST chat endpoints của content-service chỉ decode JWT không verify (gateway là cửa trước) — **tuyệt đối không tái dùng làm admin**. Admin phải qua AdminKeyGuard.

---

## 2. Bản đồ API đã xác minh

### 2.1 content-service (port **3001** — PRD ghi 3000 là SAI, `main.ts:133` log cũng ghi sai 3004)

Prefix toàn bộ: `/content-service`. Auth mọi route: `JwtMiddleware` decode-not-verify (`middleware/jwt.middleware.ts:6-40`) — có thể bypass bằng header `x-user-id` → chỉ an toàn khi đứng sau gateway.

| Endpoint | Guard | Dùng cho admin | file:dòng |
|---|---|---|---|
| POST `/chat/match` · DELETE `/chat/match` | @User('id') | cancel logic tái dùng (xem §4.3) | chat.controller.ts:28-42 |
| GET `/chat/match/my-room` | @User('id') | — (không tái dùng, không verify JWT) | chat.controller.ts:44-50 |
| GET `/chat/rooms/:roomId/messages` | membership-gated | **KHÔNG** (chặn tại chat-message.service.ts:132-139) | chat.controller.ts:59-74 |
| `/admin/*` (content/gifts) | **AdminKeyGuard** | pattern chuẩn — controller chat/admin CHƯA CÓ | admin-content.controller.ts:12-14, gift.controller.ts:49 |
| `/internal/*` | ServiceTokenGuard `x-service-token` | — (không có chat messages ở đây) | internal.controller.ts:34-38 |

Kafka: content-service **publish** `chat.message.event` (key=roomId), `chat.room.event` (key=roomId **hoặc userId**), `user.enforcement.changed`; consume `chat.room.send/edit/delete/leave`, `chat.heartbeat`, `chat.vote_kick.command`.

### 2.2 gateway-auth-service (port **3005**, `main.ts:97`)

| Thứ | Vị trí | Ghi chú |
|---|---|---|
| Socket client→server: `joinRoom` (IDOR-gated), `chat:join/send/edit/delete/typing/leave/heartbeat`, `chat:vote_kick:start/:vote` | chat-socket.service.ts:36-73, websocket.gateway.ts:195-349 | `chat:send` produce Kafka `chat.room.send`, eventId = clientMsgId (dedupe) |
| Server→client: từ Kafka qua `EventBusService` (regex `^.*\.(event|count|post|comment)$`) → `dispatch` → `wsEmitter` | event-bus.service.ts:76-82, websocket-emitter.ts:51-91 | room `chat_room:{rid}` hoặc `user:{uid}` |
| `chat:vote_kick:result KICKED` → `forceLeaveKicked` (fetchSockets cross-node, disconnect) | chat-socket.service.ts:90-102 | **pattern để tái dùng cho admin force-leave** |
| **`chat:member_left` — KHÔNG có branch xử lý riêng** | dispatch chat-socket.service.ts:76-88 | đếm vào `other` — phải THÊM branch reason ADMIN |
| `disconnectUser` (fetchSockets room `user:{uid}` → s.disconnect(true), không emit event) | websocket-emitter.ts:98-116 | dùng cho enforcement + ban |
| Enforcement consumer: level ≥3 → disconnectUser + fallback `SET enforcement:user:{id}` NX | enforcement.consumer.ts:46-89 | handshake check tại websocket.gateway.ts:177-188 (Redis lỗi → fail-open) |
| REST EnforcementGuard global: level 4 chặn hết 403, level 3 chặn write | app.module.ts:110-112 | |
| **GatewayController là catch-all `@All('*')`** | gateway.controller.ts:16-59 | controller admin mới phải đăng ký TRƯỚC nó |
| ROUTE_MAP proxy: `/user-community`→:3001, `/content-service`→:3004, fallback NGINX :8088 | router.map.ts:7-47 | gateway tự verify JWT + inject `x-user-id/email/installation-id` |

### 2.3 user-community-service (port **3001**, `main.ts:77`)

| Endpoint | Guard | Dùng cho admin | file:dòng |
|---|---|---|---|
| GET `/user-community/users` — filter: `email` (exact), `displayName` (contains), `phoneNumber` (exact), orderBy whitelist, pageSize max 30, default sort createdAt desc, luôn isDeleted:false. **KHÔNG filter status** | Admin (internal JWT 60s) | search user | user.controller.ts:174-190 |
| GET `/user-community/users/:id` — full detail gồm 2FA secret (select override) | **InternalService** (x-service-token) | detail user — BFF phải gọi bằng x-service-token, KHÔNG phải admin JWT | user.controller.ts:272-285 |
| POST `/user-community/users/lookup-by-emails` — exact match `{emails[]} → {id,email,displayName}` | InternalService | **F6 map user↔run** | user.controller.ts:438-455 |
| PATCH `/user-community/admin/user/change-status` — set 1 cột `status` (enum), KHÔNG audit, KHÔNG giới hạn | Admin JWT | ban = `LOCKED` | admin.controller.ts:60-73 |
| PUT `/user-community/admin/user/update/:id` | Admin JWT | sửa profile | admin.controller.ts:75-91 |
| GET `/internal/users/basic-info?ids=` | x-service-token | batch tên hiển thị | internal.controller.ts:379-393 |
| GET `/internal/devices/:userId/trusted` — danh sách TrustedDevice (deviceName, platform, lastSeenAt, lastIp, isRevoked...) | x-service-token | xem thiết bị | internal.controller.ts:572-584 |

Admin auth hoạt động: `AuthGuard` verify `verifyInternalJwt` (HS256, `JWT_INTERNAL_SECRET`, maxAge 60s) — **chỉ check signature, không check DB/role**; admin-tool sign `{sub:'admin-tool', key, role:'ADMIN'}` (role bị bỏ qua). BFF chỉ cần giữ secret + tự sign.

---

## 3. Bản đồ state user THẬT ("user đang làm gì")

| Trạng thái | Nguồn | Key/API | Lệch so với reality |
|---|---|---|---|
| Online/offline | **memory gateway** (phải xây mới) | map `userId→{socketCount,lastSeenAt}` + endpoint admin | wsConnections chỉ là Gauge tổng |
| Đang chờ ghép | Redis `match:queue:waiting` ZSET | `ZSCORE` → rank = position | kèm `match:queue:alive` (heartbeat) — cancel phải xóa cả 2 |
| Đang trong phòng | Redis `match:user:{uid}:room` STRING TTL 3h | `GET` + `getRoomExpiresAt` (`match:room:{rid}` HASH) | **ghế treo**: disconnect không xóa (bug đã biết) |
| Cooldown 15p | Redis `match:cooldown:{uid}` TTL 900s | `TTL` | chỉ khi rời VOLUNTARY |
| Nojoin 4h | Redis `match:user:{uid}:nojoin` SET | `SMEMBERS` | sau leave/kick |
| Ban/suspend | Redis `enforcement:user:{uid}` JSON `{action,level,expiresAt}` | `GET` (level ≥3 = cắt) | **khác hệ** với `User.status LOCKED` — 2 đường không đồng bộ |
| Last active | Postgres `TrustedDevice.lastSeenAt` | GET /internal/devices/:userId/trusted | không có `lastActive` trên users |
| Topic đang chờ | Redis `match:user:{uid}:queued_topic` TTL 1h | `GET` | cancel phải xóa |
| Messages | Postgres, retention 90 ngày | repo `findManyByRoom` (cursor, lọc moderationStatus ACTIVE/UNBANNED) | membership gate phải bypass bằng endpoint mới |

---

## 4. Thiết kế kỹ thuật MVP (đã chốt theo research)

### 4.1 content-service — `AdminChatController` mới (guard: AdminKeyGuard `JWT_INTERNAL_SECRET` 60s)

| Endpoint mới | Logic | Mắt xích phải thêm |
|---|---|---|
| `GET /content-service/admin/chat/users/:uid/state` | 5 check §3: room→{roomId,expiresAt}, waiting→{position}, cooldown→{ttl}, nojoin, enforcement→{level,expiresAt} | chỉ read — **KHÔNG cần đổi gì**, chỉ dùng matching-redis.client đã có |
| `GET /content-service/admin/chat/rooms/:rid/messages` | gọi thẳng `chatMessageRepo.findManyByRoom` (inject từ ChatModule — chat.module.ts:24) + ghi AuditLog (AuditLogModule có sẵn) | endpoint mới, không đụng service cũ |
| `POST /content-service/admin/chat/rooms/:rid/leave` `{userId}` | `runLeaveRoom(uid,rid,...)` (matching-redis.client.ts:395-405 — idempotent, tự nojoin 4h, KHÔNG cooldown) → `removeRoomTopic` (missing) → publish `chat:member_left` reason `ADMIN` (missing) | thêm `'ADMIN'` vào union `'VOLUNTARY'|'DISCONNECT'|'KICKED'` (kafka.producer.ts:940); chú ý Lua trả member count nhưng không trả list uid còn lại — publish per-member bị-left theo pattern `handleChatRoomLeave` (chat-message.service.ts:765-832) |
| `POST /content-service/admin/chat/match/:uid/cancel` | `cancel(uid)` (matching-redis.client.ts:337-340) + **thêm** ZREM `match:queue:alive` + `clearQueuedTopic` + publish `chat:error` code mới `ADMIN_MATCH_CANCELLED` (roomType user) | thêm code mới vào publishChatError (kafka.producer.ts:917-935) |
| `POST /content-service/admin/chat/enforcement` `{userId,action,level,expiresAt?}` | publish `user.enforcement.changed` (đường chuẩn — gateway cắt socket + chặn reconnect, content ghi EnforcementLog + setEnforcementState) | chỉ publish, không ghi tay |

### 4.2 gateway-auth-service — 3 thay đổi

1. **Presence map**: `Map<userId,{socketCount,lastSeenAt}>` — inc sau `client.data.user` set (websocket.gateway.ts:166-192), dec trong `handleDisconnect` (:355-381). MVP per-node (chấp nhận: multi-instance lệch — ghi rõ AC).
2. **Endpoint `GET /gateway/admin/gateway/online-users`** guard header `x-admin-token` == env `ADMIN_API_TOKEN` (mới). **Controller phải đăng ký TRƯỚC GatewayController catch-all `@All('*')`** (gateway.controller.ts:16-59).
3. **Branch `chat:member_left` reason `ADMIN`** trong `dispatch` (chat-socket.service.ts:76-88) → tái dùng pattern `forceLeaveKicked` (:90-102) để đuổi socket target khỏi `chat_room:{rid}`.

### 4.3 user-community-service — KHÔNG cần sửa code, chỉ gọi đúng guard

- Search/list user: GET /users (admin JWT 60s — BFF tự sign với `JWT_INTERNAL_KEY` + `JWT_INTERNAL_SECRET`)
- Detail user + devices: x-service-token (`INTERNAL_SERVICE_TOKEN`)
- F6 map run↔user: `lookup-by-emails` (exact) hoặc filter email GET /users; nhận dạng pattern email `loadtest.{runId}.{i}@mayogu.test` / displayName `[lt] User {runId}.{i}`
- Ban account (không cắt socket): change-status → `LOCKED`. (Cắt socket + chặn reconnect: publish enforcement ở §4.1 — **2 đường riêng, ghi rõ trong UI**)

### 4.4 BFF loadtest (chat-app/loadtest) — routes proxy mới

- Giữ secret phía server: `LOADTEST_JWT_INTERNAL_KEY` + `LOADTEST_JWT_INTERNAL_SECRET` (sign 60s per request, như admin-tool internal-request.service.ts:41), `LOADTEST_INTERNAL_SERVICE_TOKEN`, `LOADTEST_ADMIN_API_TOKEN` (cho gateway)
- Routes mới: `/api/admin/users*` (search, detail, devices), `/api/admin/chat/*` (state, transcript, leave, cancel, enforcement), `/api/admin/gateway/online-users`
- Base URL: content-service/user-community port **đọc từ env** (PRD ghi 3000/3004 sai — thực tế 3001; gateway 3005; prod qua nginx/api.mayogu.com)

### 4.5 UI (chat-app SPA) — tab Admin trong AppShell loadtest

- Bảng user thật (virtualized, filter email/displayName, phân trang — tái dùng pattern UsersPage) + cột state tổng hợp (online? matching? room? cooldown? ban?)
- Click user → detail: profile (x-service-token), devices (trusted), trạng thái live, nút: vào phòng (nếu in_room), force-leave, cancel matching, ban (2 đường: LOCKED / enforcement)
- Click phòng → transcript read-only (cursor pagination) + danh sách member + nút leave từng member

---

## 5. Đính chính PRD (research phát hiện)

| PRD (v0.2) | Thực tế research |
|---|---|
| content-service port 3000 | **3001** (main.ts:133; log ghi 3004 cũng sai) |
| GET /users/:id dùng admin JWT | **InternalService** — phải x-service-token |
| Search email contains | **exact-match** qua blind index (AES-GCM) — không contains được; displayName mới contains |
| Ban qua change-status = enforcement | **2 hệ riêng**: change-status → User.status (không cắt socket); enforcement → cắt socket + chặn reconnect. UI phải phân biệt |
| "online" có thể lấy | **không có** — phải xây map presence ở gateway |
| force-leave chỉ cần runLeaveRoom | thêm: removeRoomTopic + publish reason ADMIN + gateway branch member_left |
| cancel chỉ ZREM waiting | thêm ZREM alive + clearQueuedTopic + publish ADMIN_MATCH_CANCELLED |

---

## 6. Rủi ro / việc phải kiểm khi code

1. **Fail-open**: handshake check enforcement Redis lỗi → cho connect (websocket.gateway.ts:177-188) — không đổi, chỉ ghi nhận.
2. **Presence per-node**: multi-instance gateway sẽ lệch — MVP chấp nhận, AC ghi rõ (PRD AC-8.3).
3. **Catch-all controller**: đăng ký admin controller gateway TRƯỚC GatewayController.
4. **Publish member_left reason ADMIN**: client chat-app hiện xử lý `chat:member_left` như thế nào cần kiểm (UI có hiện "bị rời phòng" không) — nếu chưa, thêm xử lý UI cho reason ADMIN.
5. **Admin xem transcript = đọc chat riêng tư**: bắt buộc audit log mỗi lần đọc (đã có AuditLogModule), UI cảnh báo.
6. **Lua không trả list uid còn lại**: force-leave publish member_left theo pattern handleChatRoomLeave — test kỹ trường hợp phòng còn member khác.
7. **Admin action lên user THẬT** (10k seed = production): không có vùng an toàn — UI cần confirm 2 bước cho force-leave/ban/cancel.

---

## 7. Kết luận

Research đã xác minh đầy đủ: **không có blocker kỹ thuật nào**. Toàn bộ mắt xích đều có pattern sẵn trong hệ (AdminKeyGuard, forceLeaveKicked, Lua idempotent, AuditLog, enforcement pipeline). Khối công việc: content-service ~1 controller mới (~5 endpoint) + 2-3 thay đổi nhỏ (reason union, code mới, removeRoomTopic), gateway ~3 thay đổi (presence map, admin controller trước catch-all, branch member_left), BFF ~5 routes proxy + secrets env, UI 1 tab mới (3 màn hình). Sẵn sàng bước sang DESIGN rồi CODE.
