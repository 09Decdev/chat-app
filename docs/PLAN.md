# PLAN — chat-app (Phòng Chat Auto-Matching 6 người)

> Frontend SPA doc theo [content-service/docs/CHAT_API.md](../content-service/docs/CHAT_API.md).
> Stack: React 18 + Vite 5 + TypeScript + Tailwind + shadcn/ui (Radix) + Zustand + Socket.IO client + framer-motion.

## Mục tiêu

Project RIÊNG (không trộn với web-app/mobile-app) — một web client kết nối **gateway-auth-service (:3000)** thật: đăng nhập JWT, ghép phòng auto-match, chat realtime qua Socket.IO, lịch sử phân trang.

## Quyết định kỹ thuật

| Quyết định | Lý do |
|---|---|
| Vite SPA (không Next.js) | Web-app dùng Next.js + cookie auth; doc CHAT_API dùng Bearer token + socket query → SPA localStorage hợp lý hơn. |
| Tailwind v3 + shadcn/ui (hand-written) | UI đẹp, nhất quán; tránh CLI tương tác. Radix primitives cho a11y. |
| Zustand (không Redux) | state realtime đơn giản, không boilerplate. |
| Bearer token lưu localStorage | Doc §2: `Authorization: Bearer`, socket `?token=`. Đây là client độc lập theo doc. |
| Decode JWT client (KHÔNG verify) | Lấy `sub` làm userId để phân biệt message của mình. Server vẫn là nơi thẩm quyền thật. |

## Kiến trúc thư mục

```
src/
├── lib/            env, utils(cn), constants(error codes), storage, jwt, api, socket
├── types/          chat.ts, auth.ts
├── store/          auth.store.ts, chat.store.ts (Zustand)
├── components/
│   ├── ui/         shadcn primitives
│   ├── auth/       LoginForm
│   ├── chat/       StartScreen, MatchingScreen, ChatRoom, RoomHeader, MemberBar, MessageList, MessageBubble, MessageInput, UserAvatar
│   └── ProtectedRoute.tsx
├── pages/          LoginPage, ChatPage (orchestrator)
├── App.tsx         router + AuthGate (hydrate + socket lifecycle)
├── main.tsx
└── index.css       theme dark + gradient
```

## Ánh xạ CHAT_API.md → implementation

| Doc | File / hàm |
|---|---|
| §2 POST /auth/login (deviceInfo) | `chatApi.login` + `deviceStorage.getDeviceInfo()` (installationId uuid v4, fingerprint 64-hex) |
| §3 response envelope | `unwrap()` trong api.ts (lấy `.data` nếu có `success`) |
| §3 error envelope | `ApiError` + `toApiError()` |
| §4.1 POST /chat/match | `chatApi.enqueue` → `startMatching()` |
| §4.2 DELETE /chat/match | `chatApi.cancel` → `cancelMatching()` |
| §4.3 GET /chat/match/my-room | `chatApi.myRoom` → `init()` (reconnect) |
| §4.4 GET messages (cursor) | `chatApi.messages` + `parseMessagesPage()` (parse defensive: array ở `.data` hoặ body, `nextCursor` ở top/`.metadata`) |
| §5.1 client→server | `socketManager.emit`: `chat:join`, `chat:send`, `chat:leave` |
| §5.2 server→client | `buildHandlers()` → store actions |
| §6 error codes | `ChatErrorCode` + `errorMessageVi` + `friendlyMessage()` |
| §7 business rules | `env` constants (6 members, 3h, 900s cooldown, 4000 chars, 1msg/2s) |
| §8 reconnect flow | `init()`: my-room → join; `matchingFlag` resume hàng chờ |
| §9 rate limit 1/2s | throttle client trong `sendMessage` + UI disable 2s |

## State machine (chatStore.phase)

```
idle --startMatching--> matching --matching:found--> in_room
matching --cancel--> idle
in_room --leaveRoom (voluntary)--> idle (+cooldownUntil 15m)
in_room --chat:room_closed / roomExpired--> idle
in_room --chat:error FORBIDDEN--> idle
```

- `cooldownUntil`: set khi leave voluntary HOẶC nhận 429 `CHAT_COOLDOWN_ACTIVE` (dùng TTL nếu server trả, mặc định 900s).
- `joined`: false khi vào phòng, true khi nhận `chat:joined` → bật input.
- `requirePhoneVerify`: true khi enqueue trả `CHAT_PHONE_NOT_VERIFIED` → hiện màn xác minh.

## Optimistic send + dedupe

- `sendMessage` thêm message tạm `_local:'pending'` (id `local:...`), emit `chat:send`.
- Khi echo `chat:message` của chính mình về → thay message tạm đầu tiên (FIFO) bằng message thật.
- Sau 10s nếu chưa xác nhận → chuyển `_local:'failed'` + toast.
- Throttle 1msg/2s client-side khớp server (tránh silent-skip §9).

## Socket lifecycle

- `App.AuthGate`: khi `isAuthenticated && accessToken` → `connectChatSocket(token)` (setHandlers + connect, idempotent theo token).
- `onConnect` (gồm reconnect): nếu đang `in_room` → re-emit `chat:join` để đăng lại membership.
- Logout → `disconnectChatSocket` + `chatStore.reset()`.

## Giới hạn / chưa làm (theo doc)

1. **2FA**: doc §2 nói `require2fa:true` cần flow riêng (AUTH_API_DOCS.md) — hiện chỉ thông báo, chưa implement flow 2FA.
2. **Refresh endpoint**: không có trong CHAT_API.md — đoán `/auth/refresh`. Nếu thất bại → logout. Cấu hình qua `VITE_REFRESH_ENDPOINT`.
3. **Profile thành viên khác**: `matching:found` chỉ trả `userId`; doc §7 dùng profile gốc nhưng không có endpoint fetch profile trong doc → displayName/avatar chỉ hiện sau khi thành viên đó gửi tin nhắn đầu tiên (đã poprawnie theo "không nick ẩn" — không fake tên).
4. **Ảnh đính kèm**: `fileId`/`fileType` có, nhưng không có endpoint lấy URL ảnh trong doc → chỉ render chip "Ảnh đính kèm" + kích thước. Cần tích hợp upload-service/file URL khi có.
5. **Countdown phòng 3h**: sự kiện `chat:timer` doc ghi "chưa emit (v2)" → không hiện đồng hồ đếm ngược phòng.
6. **Vote kick / Report / Pinned Topic**: doc ghi v2 → chưa làm.
