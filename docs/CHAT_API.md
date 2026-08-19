# CHAT API Reference

**Phạm vi tài liệu:** API REST + WebSocket cho 4 tính năng chat mới
- Reply (trả lời tin nhắn)
- @Mention (gắn @ nhắc tên)
- Bookmark (lưu tin nhắn)
- Read receipt (trạng thái đã xem)

**Ngày cập nhật:** 18/08/2026

---

## 0. Tổng quan kiến trúc

```
Mobile App
   │
   ├── REST (HTTP, Bearer token) ──► Nginx ──► content-service /chat/...
   │
   └── WebSocket (socket.io, token trong handshake) ──► gateway-auth-service
          ├── Emit:  chat:join / chat:send / chat:read / chat:edit / chat:delete ...
          └── Nhận:  chat:joined / chat:message / chat:message:updated /
                     chat:read:update / chat:error ...
```

- **REST:** mọi endpoint yêu cầu `Authorization: Bearer <JWT>`. Response được bọc trong `{ data: ... }` (global interceptor).
- **WebSocket:** token gửi trong handshake (`auth.token` hoặc `query.token` / `headers.authorization`).
- **Phòng chat:** tối đa 6 người, thời lượng 3 giờ mặc định (`CHAT_ROOM_TTL_HOURS`), tin nhắn purge sau `CHAT_RETENTION_DAYS` (mặc định 90 ngày).
- **Backward-compatible:** thêm field mới vào `message` → client cũ bỏ qua, không vỡ.

---

## 1. Dữ liệu dùng chung

### 1.1 ChatMessage — field mới (Reply + Mention)

Có trong: REST history (`GET /chat/rooms/:roomId/messages`), realtime `chat:message`, `chat:message:updated`, `chat:message:deleted`.

```jsonc
{
  "id": "uuid",
  "roomId": "r2662-....",
  "userId": "uuid",
  "content": "Nội dung tin nhắn",
  "displayName": "Người gửi",
  "avatarUrl": "https://...",
  "fileId": null,
  "fileType": null,
  "fileWidth": null,
  "fileHeight": null,
  "moderationStatus": "ACTIVE",
  "isDeleted": false,
  "deletedAt": null,
  "updatedAt": null,
  "createdAt": "2026-08-18T09:00:00.000Z",

  // === Field mới ===
  "replyToId": null,                  // id tin nhắn bị reply (null = không phải tin reply)
  "replyToContent": null,             // snapshot nội dung tin gốc lúc reply
  "replyToUserId": null,              // userId người gửi tin gốc
  "replyToSenderName": null,          // tên người gửi tin gốc (snapshot)
  "mentionedUserIds": [],             // [userId] bị @mention (server validate = thành viên phòng)
  "timCount": 2,                      // tổng lượt tim/like (denormalized, atomic update khi toggle)
  "likedByMe": true                   // CHỈ có trong GET history — mình đã tim tin này chưa
}
```

**Semantics:**
- `replyToId` **bất biến** — không đổi khi tin bị edit.
- Snapshot (`replyToContent/UserId/SenderName`) được **server tự lấy** lúc nhận `replyToId`; client KHÔNG gửi snapshot (server authoritative → chống giả mạo).
- Nếu tin gốc bị soft-delete sau đó → tin reply **vẫn hiển thị** nhờ snapshot. Không thể reply vào tin **đã bị xóa** (server chặn + client ẩn nút).
- `mentionedUserIds` = danh sách người được tag. Client dùng để highlight 1 tin: nếu `mentionedUserIds` chứa `myUserId` → highlight bubble.

### 1.2 Read receipt — watermark theo thời gian

- Watermark của mỗi user trong phòng = **`createdAt` (ISO string) của tin mới nhất họ đã xem**.
- So sánh theo **thời gian**, KHÔNG theo `message.id` (UUID không sort được): tin `X` được user `U` đọc khi `X.createdAt <= readReceipts[U]`.
- Lưu trữ: Redis `chat:read:{roomId}` → `{userId: lastReadAt}` (vòng đời = phòng, tự expire).
- Trạng thái hiển thị 1 tin của mình: `✓` đã gửi, `✓✓` đã đọc bởi ≥ 1 người khác (`userId != me`).

```jsonc
// readReceipts — luôn là map {userId: lastReadAt-ISO}
{
  "user-aaaa": "2026-08-18T09:00:00.000Z",
  "user-bbbb": "2026-08-18T09:00:01.500Z"
}
```

---

## 2. REST Endpoints

Base path service: `/chat` — qua Nginx: `/content-service/chat`.

### 2.1 Lấy danh sách thành viên phòng (gợi ý @mention)

```
GET /chat/rooms/:roomId/members?q=<prefix>
```

| Param | Type | Bắt buộc | Mô tả |
|-------|------|:---:|-------|
| `roomId` | path | ✔ | id phòng |
| `q` | query | – | lọc theo prefix `displayName`/`userId` (lowercase). Bỏ trống = trả toàn bộ |

**Gate:** user phải là thành viên phòng (403 `CHAT_FORBIDDEN` nếu không).

**Response 200**
```jsonc
{
  "data": [
    { "userId": "uuid", "displayName": "Nguyễn Văn A", "avatarUrl": "https://...", "starCount": 12 },
    { "userId": "uuid", "displayName": "Linh",       "avatarUrl": null,          "starCount": null }
  ]
}
```
- Tối đa 6 phần tử (= sức chứa phòng).
- `starCount` = Sao Uy Tín (nullable — fail-open khi user-community không trả).
- **Khuyến nghị client:** dùng luôn member có trong `chat:joined` để filter local (không cần gọi API từng phím); API này là nguồn chính thống + dùng khi cần search.

### 2.2 Tim tin nhắn (luôn +1, user có thể tim nhiều lần)

```
POST /chat/messages/:messageId/tim
Content-Type: application/json
```

**Body**
```jsonc
{ "roomId": "r2662-..." }
```

**Gate:** phải là thành viên phòng (403); tin phải tồn tại + cùng room + chưa bị xóa (404 `CHAT_MESSAGE_NOT_FOUND`).

**Không toggle:** mỗi lần gọi = +1, bất kể user đã tim trước đó chưa. Bảng `chat_message_bookmarks` không có unique constraint — 1 user có thể có nhiều row cho 1 tin.

**Response 200**
```jsonc
{ "data": { "liked": true, "likeCount": 3 } }
```

### 2.3 Bỏ tim 1 lần (DELETE 1 like, count -1)

```
POST /chat/messages/:messageId/untim
Content-Type: application/json
```

**Body**
```jsonc
{ "roomId": "r2662-..." }
```

**Gate:** giống tim.

**Semantics:** xóa 1 like (bất kỳ, cũ nhất) của user này cho tin này. Nếu không còn like nào → `{ liked: false, likeCount }` (no-op, count giữ nguyên).

**Response 200**
```jsonc
{ "data": { "liked": false, "likeCount": 2 } }
// liked = false khi user đã bỏ hết like của mình; true nếu vẫn còn ≥1 like
```

**Tối ưu backend:** cả `tim` và `untim` đều dùng **transaction atomic**: INSERT/DELETE 1 like + `increment/decrement ChatMessage.timCount` trong cùng transaction (DB-side `UPDATE ... SET timCount = timCount +/- 1` — không đọc-then-ghi, không race). `timCount` denormalized trên từng tin → đọc history/search **không cần COUNT JOIN**. Sau mỗi thao tác server **broadcast `chat:tim:changed`** cả phòng để client tự update count/liked (không refresh history). `likedByMe` trong history = `COUNT(like) > 0` cho user đó.

### 2.4 Tạo bookmark (lưu tin giữ list — bổ sung)

```
POST /chat/bookmarks
Content-Type: application/json
```

**Body**
```jsonc
{ "roomId": "r2662-...", "messageId": "uuid" }
```

**Gate:** phải là thành viên phòng lúc tạo (403); tin phải tồn tại + cùng room + chưa bị xóa (404 `CHAT_MESSAGE_NOT_FOUND`).

**Idempotent:** lưu 2 lần cùng `(userId, messageId)` → trả bookmark đã có (không tạo trùng).

**Response 200** (tạo mới hoặc đã có)
```jsonc
{ "data": { "id": "bookmarkId" } }
```

### 2.4 Xóa bookmark

```
DELETE /chat/bookmarks/:id
```

**Gate:** chỉ chủ sở hữu xóa được (deleteMany `userId` filter). Idempotent.

**Response 200**
```jsonc
{ "data": { "deleted": true } }   // false = không tồn tại / không phải của user
```

### 2.5 Danh sách bookmark của tôi

```
GET /chat/bookmarks?cursor=<base64url>&limit=20
```

| Param | Type | Bắt buộc | Mô tả |
|-------|------|:---:|-------|
| `cursor` | query | – | keyset cursor (xem 2.5) |
| `limit` | query | – | 1–50, mặc định 20 |

**Gate:** KHÔNG yêu cầu membership (phòng đóng sau 3h TTL vẫn xem được) — chỉ cần login + dữ liệu của chính mình.

**Response 200**
```jsonc
{
  "data": [
    {
      "id": "bookmarkId",
      "roomId": "r2662-...",
      "messageId": "uuid",
      "createdAt": "2026-08-18T10:00:00.000Z",
      "message": null  // null = tin gốc đã bị soft-delete / purge → client hiện placeholder "Tin nhắn đã bị xóa"
    },
    {
      "id": "bookmarkId2",
      "roomId": "r2662-...",
      "messageId": "uuid",
      "createdAt": "2026-08-17T09:00:00.000Z",
      "message": {
        "id": "uuid", "userId": "uuid", "content": "Hẹn 8h nhé",
        "displayName": "Người gửi", "avatarUrl": "https://...",
        "fileId": null, "fileType": null,
        "isDeleted": false, "createdAt": "2026-08-17T09:00:00.000Z"
      }
    }
  ],
  "nextCursor": "base64url"  // null = hết trang
}
```

**Lưu ý:** bookmark là **pointer-only** — khi tin gốc bị purge 90 ngày, `message` trả `null` (không giữ snapshot). Nếu sau này cần danh sách sống mãi → chuyển sang lưu snapshot lúc tim.

### 2.6 Cursor format (keyset pagination)

Base64url của JSON `{ "createdAt": "<ISO>", "id": "<lastId>" }` — sort `createdAt DESC, id DESC`, query `createdAt < giá trị HOẶC (createdAt == && id <)`. Dùng chung cho messages/media/bookmarks.

```text
encode: base64url(JSON.stringify({createdAt: "2026-08-18T10:00:00.000Z", id: "uuid"}))
```

---

## 3. WebSocket Events (socket.io)

### 3.1 Emit — client → server

#### chat:send — gửi tin nhắn (có reply + mention)

```jsonc
{
  "roomId": "r2662-...",
  "content": "Đồng ý nhé @Linh",
  "fileId": null,                 // optional — fileId ảnh (chat hiện chỉ cho ảnh)
  "clientMsgId": "uuid",          // optional — để khớp optimistic UI (echo lại trong chat:message)
  "replyToId": "uuid",            // optional — id tin bị reply; server tự lấy snapshot
  "mentions": ["user-bbbb"]       // optional — [userId] bị @mention
}
```

Quy tắc:
- `content` và `fileId` **không được đồng thời rỗng** (tin ảnh thuần hợp lệ khi có file).
- `replyToId` hợp lệ khi: tin tồn tại + **cùng room** + **chưa bị xóa**. Vi phạm → server **im lặng bỏ qua** tin (không persist, không broadcast) — client nên chặn từ UI.
- `mentions`: server **validate từng id là thành viên phòng** (SISMEMBER), loại bỏ id không phải member / trùng / = chính người gửi; chặn tối đa theo sức chứa phòng.
- Server KHÔNG parse `@` tự động → client phải map `@Tên` → `userId`. Nội dung text giữ nguyên (`@Linh`), việc highlight dựa vào `mentionedUserIds`.

Kết quả:
- Thành công → cả phòng nhận `chat:message` (message kèm `replyTo*`, `mentionedUserIds`).
- Lỗi gate (không phải member…) → `chat:error` code `FORBIDDEN`.
- Lỗi relay Kafka → `chat:error` code `SEND_FAILED`.

#### chat:read — báo đã đọc

```jsonc
{
  "roomId": "r2662-...",
  "lastReadAt": "2026-08-18T09:00:00.000Z"   // iso8601 UTC createdAt của tin mới nhất user đã thấy
}
```

Quy tắc:
- **Không phải** tin nhắn cuối mình gửi → watermark cho biết "đã xem tới mốc thời gian này" cho **các tin của người khác** trước mốc đó.
- **Client debounce 1.2s**, chỉ gửi khi **advance** (chỉ gửi khi mốc mới > mốc cũ) — không gửi khi scroll.
- Server relay qua Kafka → HSET watermark → broadcast `chat:read:update` về cả phòng.

#### chat:read:update — server → client

```jsonc
{
  "roomId": "r2662-...",
  "readReceipts": {
    "user-bbbb": "2026-08-18T09:00:01.000Z"
  },
  "roomEndsAt": 1766102400000
}
```

- Bản đồ **đầy đủ** {`userId`: `lastReadAt`} — client **replace state** (hoặc merge per-user, an toàn cả 2).
- Client tính "đã xem" cho tin của mình: tồn tại `userId != me` với `lastReadAt >= message.createdAt`.
- Có thể nhận nhiều event trong 1 giây nếu nhiều người đọc; payload nhỏ (≤6 member).

### 3.2 chat:joined — initial state (đã bổ sung readReceipts)

```jsonc
{
  "roomId": "r2662-...",
  "members": [...],
  "roomEndsAt": 1766102400000,
  "readReceipts": {          // ← MỚI: trạng thái đã đọc ban đầu khi join (best-effort)
    "user-bbbb": "2026-08-18T09:00:01.000Z"
  }
}
```

- Client dùng `readReceipts` làm giá trị khởi tạo; các lần sau nhận delta qua `chat:read:update`.

### 3.3 Danh sách event liên quan

| Event | Chiều | Mô tả |
|-------|------|-------|
| `chat:send` | emit | gửi tin (kèm replyToId/mentions) |
| `chat:read` | emit | báo đã đọc tới mốc thời gian |
| `chat:join` | emit | join phòng |
| `chat:message` | nhận | tin mới (kèm reply/mention field) |
| `chat:message:updated` | nhận | tin bị edit |
| `chat:message:deleted` | nhận | tin bị soft-delete |
| `chat:read:update` | nhận | cập nhật read receipt |
| `chat:tim:changed` | nhận | 1 tin vừa tim/bỏ tim (delta {messageId, userId, liked, likeCount}) |
| `chat:joined` | nhận | ack join + members + readReceipts initial |
| `chat:error` | nhận | `{code, message}` (FORBIDDEN, SEND_FAILED, AUTH_STALE…) |

---

## 4. Flow từng tính năng

### 4.1 Reply
1. User long-press tin A → chọn "Trả lời".
2. Client ghi nhớ `replyTarget = A` (hiện strip "đang trả lời A" + nút X hủy).
3. Gửi `chat:send { content, replyToId: A.id }`.
4. Server resolve snapshot A (`replyToContent/UserId/SenderName`) → persist → broadcast `chat:message`.
5. Client render: bubble có quote block (tên + snapshot content) phía trên text. A bị xóa sau này → quote vẫn còn.

### 4.2 @Mention
1. User gõ `@` ở đầu từ → client detect token `@[a-zA-Z0-9_]*` (sau space).
2. Filter local members (`displayName.startsWith(token)`), loại chính mình, hiện dropdown (tối đa 5).
3. Chọn → chèn `@Tên hiển thị ` + nhớ `userId`.
4. Gửi `chat:send { content, mentions: [userId...] }`.
5. Server validate member → persist `mentionedUserIds`.
6. Client của người bị tag: `mentionedUserIds.contains(myId)` → highlight bubble.

### 4.3 Tim tin nhắn (like — cộng dồn, có bỏ tim)
1. Bấm ❤️ trên bubble → `POST /chat/messages/:id/tim {roomId}` → **luôn +1**, không toggle.
2. Khi `likedByMe` = true → xuất hiện nút **"Bỏ tim"** → `POST /chat/messages/:id/untim {roomId}` → **-1** (xóa 1 like cũ nhất).
3. Server: gate member + message còn tồn tại → **transaction atomically**: INSERT/DELETE 1 like + incr/decr `timCount` → trả `{liked, likeCount}`.
4. Client **optimistic** cập nhật count ngay; server **broadcast `chat:tim:changed`** → mọi người trong phòng update count/liked (không refresh history).
5. History (`GET /chat/rooms/:id/messages`) trả kèm `timCount` + `likedByMe` (gắn theo user đang xem, 1 query batch với `distinct: [messageId]`).
6. `POST/DELETE/GET /chat/bookmarks` giữ làm danh sách cá nhân (bổ sung — không dùng cho tim).

### 4.4 Read receipt
1. Client nhận tin mới / user ở đáy → debounce 1.2s → `chat:read {roomId, lastReadAt: <createdAt tin mới nhất>}`.
2. Server HSET `chat:read:{roomId}` → broadcast `chat:read:update`.
3. Mọi client (kể cả người vừa gửi) update map; bubble tin của mình so `lastReadAt >= message.createdAt` của từng member khác → hiện `✓✓`.
4. Người gửi mở lại app sau reconnect → nhận lại initial trong `chat:joined`.

---

## 6. Chạy smoke test nhanh (tích hợp sẵn trong repo)

Script `loadtest/smoke-chat-features.ts` — chạy 2 user thật vào cùng phòng, self-check cả 4 tính năng:

```bash
cd chat-app
# Cần backend đang chạy (loadtest/.env đã có LOADTEST_GATEWAY_URL, OTP_SECRET, REDIS_URL).
npm run smoke:chat-features
```

**Nguồn account (ưu tiên):** `SMOKE_EMAIL1`+`SMOKE_EMAIL2`+`SMOKE_PASSWORD` (login có sẵn) → `LOADTEST_POOL_FILE` (pool file) → mặc định register 2 account mới (cần `LOADTEST_OTP_SECRET`).

Ví dụ:
```bash
SMOKE_EMAIL1=a@test.com SMOKE_EMAIL2=b@test.com SMOKE_PASSWORD=... npm run smoke:chat-features
```

**Các check:** 2 user match cùng phòng → members REST → A gửi tin → B reply + @mention (verify `replyToId/replyToContent/replyToSenderName/mentionedUserIds`) → B emit `chat:read` → A nhận `chat:read:update` → A bookmark B (POST/GET/DELETE). Exit 0 = PASS hết.

## 5. Lưu ý triển khai vận hành

- **Topic Kafka mới:** `chat.room.read` (gateway relay → content-service). Content-service subscribe topic **explicit** trong `src/main.ts` — thêm topic mới ở đó.
- **Gateway whitelist metrics:** `KNOWN_WS_EVENT_TYPES` (websocket-emitter.service.ts) — mọi socket event type mới phải thêm để metric không rơi vào `other`.
- **Read receipt vòng đời = phòng:** Redis tự expire theo room TTL; không cần dọn tay.
- **Retention:** bookmark là con trỏ — tin gốc purge sau `CHAT_RETENTION_DAYS` → `message: null` (đúng thiết kế, không phải lỗi).
- **Migration Prisma:** `content-service/prisma/migrations/20260818000000_add_chat_reply_mention_bookmark` — apply trước khi deploy backend.