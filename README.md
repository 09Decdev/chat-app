# chat-app

Frontend cho **Phòng Chat Auto-Matching 6 người**, build theo [CHAT_API.md](../content-service/docs/CHAT_API.md). SPA React + Vite, kết nối **gateway-auth-service thật** (:3000): đăng nhập JWT, ghép phòng tự động, chat realtime Socket.IO, lịch sử phân trang.

> Project RIÊNG, không phụ thuộc web-app/mobile-app.

## Yêu cầu

- Node >= 18 (đã test Node 22)
- Gateway-auth-service chạy ở `:3000` (xem `gateway-auth-service/.env` — `PORT=3000`; doc CHAT_API ghi 3005 đã lạc hậu)
- Tài khoản đã **xác minh số điện thoại** (CHAT_API.md §7) để dùng được chat

## Cài đặt & chạy

```bash
cd chat-app
cp .env.example .env        # chỉnh VITE_GATEWAY_URL nếu gateway ở host khác
npm install
npm run dev                  # http://localhost:5173
```

Build production:

```bash
npm run build               # tsc -b && vite build
npm run preview
```

## Biến môi trường (`.env`)

| Biến | Mặc định | Mô tả |
|---|---|---|
| `VITE_GATEWAY_URL` | `http://localhost:3000` | Gateway (auth, REST proxy, socket). Đổi nếu gateway chạy port khác |
| `VITE_SOCKET_PATH` | `/socket.io/` | Đường dẫn socket.io |
| `VITE_REFRESH_ENDPOINT` | `/auth/refresh` | Endpoint refresh token (không có trong CHAT_API.md, đoán theo convention) |

## Bảo mật & secrets

Không commit secret vào repo. Secret thật nằm trong `loadtest/.env` (đã git-ignored) và được backup ngoài repo:

- **Backup location**: `%USERPROFILE%\.mayogu-secrets\chat-app-backup-2026-08-04\` (ngoài repo, git-ignored tự nhiên). Không xoá thư mục này.
- **Nơi lưu secret trong `loadtest/.env`**:
  - `LOADTEST_AUTH_SECRET` — HMAC secret cho admin session (env ưu tiên hơn file `data/auth-secret.json`, đã xoá khỏi repo).
  - `LOADTEST_OTP_SECRET` — seed OTP register; **PHẢI khớp** `OTP_SECRET` của gateway-auth-service.
  - `LOADTEST_DATABASE_URL` — credential Postgres `postgresql://appuser:<pass>@localhost:5439/loadtest`.
  - `LOADTEST_REDIS_URL` — Redis có quyền ghi (test env).
- **Runtime data**: `loadtest/data/*` (accounts pool, auth-secret) theo `.gitignore`; chỉ giữ `loadtest/data/.gitkeep`.

### Secret-scan (gitleaks)

- **`npm run secret:scan`** — chạy gitleaks `detect` trên toàn repo (cần gitleaks trên PATH: `winget install gitleaks`). Kỳ vọng **0 finding**.
- **Pre-commit hook** — chặn commit chứa secret mới (scan staged changes). Cài lại sau khi clone: `sh scripts/install-hooks.sh` (source: `scripts/pre-commit`).
- Allowlist (test fixtures `test-secret`, DB URL test-only) nằm trong `.gitleaks.toml` — **không** thêm secret thật vào đây.

> ⚠️ **Party-crossing (2 bên phải đồng bộ)** — sau khi rotate secret (2026-08-04):
> 1. **DB password**: áp dụng mật khẩu mới trong `LOADTEST_DATABASE_URL` lên instance Postgres `postgres-loadtest` (localhost:5439, user `appuser`, db `loadtest`) **trước** khi chạy loadtest server.
> 2. **OTP_SECRET**: áp dụng `LOADTEST_OTP_SECRET` mới vào `OTP_SECRET` của `gateway-auth-service/.env` — 2 bên phải khớp, nếu không loadtest tool không register được account.

## Luồng chính

1. **Đăng nhập** (`POST /auth/login`) với `deviceInfo` tự sinh (installationId uuid v4 + fingerprint 64-hex lưu localStorage).
2. **Vào chat** → `GET /chat/match/my-room` (reconnect): nếu đang có phòng → join lại; nếu từng đang chờ → enqueue lại; ngược lại hiện màn "Tìm phòng".
3. **Ghép phòng** → `POST /chat/match` (idempotent) → chờ socket `matching:found` → `emit chat:join` → `chat:joined` → chat.
4. **Gửi tin nhắn** → `emit chat:send` (throttle 1/2s client-side) → echo `chat:message` về room.
5. **Lịch sử** → `GET /chat/rooms/:roomId/messages?cursor=` phân trang (load older khi cuộn lên).
6. **Rời phòng** → `emit chat:leave` → khóa 15 phút (`CHAT_COOLDOWN_ACTIVE` nếu enqueue lại).

## Xử lý lỗi (theo §6)

Mọi error code (`CHAT_PHONE_NOT_VERIFIED`, `CHAT_ALREADY_SEATED`, `CHAT_COOLDOWN_ACTIVE`, `CHAT_FORBIDDEN`, `CHAT_CONTENT_TOO_LONG`…) được switch sang message tiếng Việt + hành động phù hợp (toast / về home / đếm ngược cooldown). 401 → thử refresh, thất bại → về đăng nhập.

## Cấu trúc

```
src/
├── lib/        env, utils, constants(error codes), storage, jwt, api, socket
├── store/      auth.store, chat.store (Zustand)
├── components/ ui/ (shadcn) + auth/ + chat/ + ProtectedRoute
├── pages/      LoginPage, ChatPage
└── App.tsx     router + AuthGate (hydrate + socket lifecycle)
```

Chi tiết thiết kế & ánh xạ từng mục doc → file: xem [docs/PLAN.md](docs/PLAN.md).

## Giới hạn

- **2FA**: chỉ thông báo, chưa implement flow (cần AUTH_API_DOCS.md).
- **Profile thành viên khác**: `matching:found` chỉ trả `userId`; displayName/avatar hiện sau khi thành viên gửi tin nhắn đầu tiên (không có endpoint fetch profile trong doc).
- **Ảnh đính kèm**: có `fileId` nhưng không có endpoint lấy URL → chỉ render chip "Ảnh đính kèm".
- **Countdown phòng 3h**: sự kiện `chat:timer` doc ghi v2 (chưa emit).
- Vote kick / Report / Pinned Topic / AI Moderation = v2 (chưa làm).
