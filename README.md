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

Chạy loadtest tool (server riêng, port 3401):

```bash
cd chat-app
cp loadtest/.env.example loadtest/.env   # chỉnh secret + DB URL (xem bảng dưới)
npm run loadtest:db:up                    # migration DB lần đầu (bắt buộc trước khi start)
npm run loadtest:server                   # fail-fast nếu env/DB sai
```

## Biến môi trường (`.env`)

| Biến | Mặc định | Mô tả |
|---|---|---|
| `VITE_GATEWAY_URL` | `http://localhost:3000` | Gateway (auth, REST proxy, socket). Đổi nếu gateway chạy port khác — **build-time**: giá trị này được nhúng vào CSP `connect-src` (meta) nên phải set đúng origin trước khi `npm run build` |
| `VITE_SOCKET_PATH` | `/socket.io/` | Đường dẫn socket.io |
| `VITE_REFRESH_ENDPOINT` | `/auth/refresh-token` | Endpoint refresh token (khớp gateway `POST /auth/refresh-token`) |
| `VITE_CSP_CONNECT_SRC` | *(trống)* | Thêm origin (cách nhau space) vào CSP `connect-src` khi gateway deploy khác origin với app (VD: `wss://gateway.mayogu.test`) |

## Biến môi trường loadtest (`loadtest/.env`)

Nguồn: `loadtest/config.ts` + `loadtest/.env.example`. Merge 3 tầng: `process.env` > `loadtest/.env` > default. Server **fail-fast** (exit ≠ 0) khi thiếu/sai key bắt buộc khi `LOADTEST_DB_REQUIRED=true` (mặc định) hoặc `NODE_ENV=production`.

| Biến | Mặc định | Bắt buộc | Mô tả |
|---|---|---|---|
| `LOADTEST_PORT` | `3401` | — | Port HTTP API điều khiển + dashboard |
| `LOADTEST_HOST` | `127.0.0.1` | — | Chỉ lắng nghe loopback (an toàn). **Docker: đặt `0.0.0.0`** |
| `LOADTEST_ALLOWLIST` | `http://localhost:3000` | prod | Danh sách gateway được phép chạy (comma). Chặn cứng mọi URL khác khi `POST /start` (SD-1) |
| `LOADTEST_GATEWAY_URL` | `http://localhost:3000` | — | Gateway mặc định (tool tự normalize ws→http) |
| `LOADTEST_OTP_SECRET` | *(trống)* | **có** (prod) | Seed OTP register — **PHẢI khớp** `OTP_SECRET` của gateway-auth-service, ≥ 32 ký tự |
| `LOADTEST_REDIS_URL` | `redis://localhost:6379` | — | Redis quyền ghi (seed `otp:register:*` + queue-count) |
| `LOADTEST_DATABASE_URL` | placeholder | **có** | Postgres connection string — `postgresql://USER:PASS@HOST:PORT/DB` |
| `LOADTEST_DB_REQUIRED` | `true` | — | `false` chỉ để dev/rollback khẩn cấp — run sẽ KHÔNG ghi history |
| `LOADTEST_AUTH_SECRET` | *(trống)* | **có** (prod) | Ký session token HMAC; ≥ 32 ký tự. Rỗng → tự sinh + lưu `dataDir/auth-secret.json` (dev-only) |
| `LOADTEST_CORS_ORIGIN` | `http://localhost:5173` | prod | Allowlist origin (comma); echo origin khớp, KHÔNG bao giờ `*` (SEC-2) |
| `LOADTEST_ALLOW_REGISTER` | `false` | — | Gate đăng ký admin: `false` → `POST /auth/register` trả 403. Dev set `true` |
| `LOADTEST_RATE_LIMIT_DISABLED` | `0` | — | `1` = tắt mọi rate-limit (escape hatch test/CI) |
| `LOADTEST_RATE_LIMIT_LOGIN_FAILS` | `5` | — | Số fail login/register trong window → 429 |
| `LOADTEST_RATE_LIMIT_WINDOW_MS` | `60000` | — | Cửa sổ fail window |
| `LOADTEST_RATE_LIMIT_START_MS` | `10000` | — | Refill bucket `/start` (1 req/10s) |
| `LOADTEST_RATE_LIMIT_WRITE_BUCKET` | `0` | — | Req/min cho POST /allowlist, /cleanup, DELETE /runs — `0` = OFF |
| `LOADTEST_TRUST_PROXY` | `0` | — | Tin `X-Forwarded-For` (chỉ bật sau reverse-proxy) |
| `LOADTEST_SHUTDOWN_TIMEOUT_MS` | `10000` | — | Tổng timeout graceful shutdown (≥ 10s) |
| `LOADTEST_MAX_TARGET` | `200000` | — | Target tối đa 1 run (chặn cứng preset 1M/10M — cần cluster v1.1) |
| `LOADTEST_MAX_DURATION_MIN` | `60` | — | Duration tối đa (phút) — access token TTL 1h |
| `LOADTEST_MAX_REGISTER_RAMP` | `100` | — | Register ramp tối đa (req/s) — tránh bucket guest của gateway |
| `LOADTEST_REGISTER_RAMP` | `100` | — | Register ramp (req/s) cho fresh accounts — run clamp bởi `LOADTEST_MAX_REGISTER_RAMP` |
| `LOADTEST_FIXTURE_POST_IDS` | *(trống)* | — | PostId fixtures (comma) cho REST driver — rỗng → driver bỏ qua POST create |
| `LOADTEST_WORKERS` | `0` (auto) | — | Số worker processes |
| `LOADTEST_MAX_SOCKETS_PER_WORKER` | `10000` | — | Socket tối đa/worker |
| `LOADTEST_MAX_PENDING_OUTBOX` | `1000` | — | Outbox pending tối đa/user chat (backpressure) |
| `LOADTEST_DIR` | `loadtest/` | — | Base dir của tool (resolve từ module path trong `loadtest/config.ts` — KHÔNG cấu hình qua env) — dùng để nạp `loadtest/.env` |
| `LOADTEST_DATA_DIR` | `./loadtest/data` | — | Accounts pool + auth-secret + settings (git-ignored) |
| `LOADTEST_REPORTS_DIR` | `./docs/loadtest-reports` | — | Thư mục report JSON/MD/CSV |
| `LOADTEST_SCRAPE_METRICS_INTERVAL_MS` | `5000` | — | Poll `/metrics` của gateway (server-side view) |
| `LOADTEST_DEBUG` | `0` | — | `1` = in nguồn từng key env khi start (C-4) |
| `LOADTEST_LOG_JSON` | `0` | — | `1` = console JSON 1 dòng (prod) |
| `LOGTEST_LOG_FILE` | *(trống)* | — | Ghi JSONL sink (append, rotation 10MB ×5 file). Trống = không ghi file |

> ⚠️ **Lưu ý prefix lệch**: JSONL sink dùng `LOGTEST_LOG_FILE` (không phải `LOADTEST_...`) — đúng theo `loadtest/logger.ts` + `.env.example:87`. Đừng gõ nhầm.

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

### LoadTest admin session — TTL 12 giờ (không refresh)

Session admin của loadtest tool dùng token HMAC-SHA256, hết hạn sau **12 giờ** (`SESSION_TTL_MS` trong `loadtest/auth.ts:15`). **Không có refresh server-side** (MVP) — sau khi hết hạn, mọi request nhận 401 → interceptor tự clear session → UI redirect về `/loadtest/login`.

- **Banner "Phiên đăng nhập sắp hết hạn"**: hiện trên dashboard (dismissible) khi còn ≤ 30 phút trước khi hết hạn — text đồng hồ đến từ `expiresAt` server (không hardcode "12 giờ"). Xem `src/lib/loadtest-session.ts` + `src/components/loadtest/session-expiry-banner.tsx`.
- Token lưu localStorage (`loadtest.auth`, xem `src/lib/loadtest-auth-storage.ts`); secret nằm trong `LOADTEST_AUTH_SECRET` (env ưu tiên file `loadtest/data/auth-secret.json`).
- Hết hạn không phải lỗi — chỉ cần đăng nhập lại (retry không có sẵn).

> ⚠️ **Party-crossing (2 bên phải đồng bộ)** — sau khi rotate secret (2026-08-04):
> 1. **DB password**: áp dụng mật khẩu mới trong `LOADTEST_DATABASE_URL` lên instance Postgres `postgres-loadtest` (localhost:5439, user `appuser`, db `loadtest`) **trước** khi chạy loadtest server.
> 2. **OTP_SECRET**: áp dụng `LOADTEST_OTP_SECRET` mới vào `OTP_SECRET` của `gateway-auth-service/.env` — 2 bên phải khớp, nếu không loadtest tool không register được account.

## Database

Lịch sử run + pool + metrics + log lưu Postgres (`LOADTEST_DATABASE_URL`, instance `postgres-loadtest` :5439). Schema quản lý bằng **migration runner zero-dep** (`loadtest/db/migrate.ts`, migrations trong `loadtest/db/migrations/`, bảng `schema_version`):

```bash
npm run loadtest:db:up                       # migration up (tạo 7 bảng + schema_version=1)
npm run loadtest:db:down                     # rollback 1 bước (--steps N để lùi nhiều)
npm run loadtest:db:status                   # xem schema_version + danh sách pending
npm run loadtest:db:cleanup -- --older-than 30d   # retention thủ công (30d/12h/60m)
```

- **Startup chỉ auto-apply baseline** (001, `IF NOT EXISTS`); còn migration pending > 1 → server **fail-fast** yêu cầu `npm run loadtest:db:up` (chống chạy migration destructive tự động — B-5).
- **Down là destructive** (drop bảng) — đúng ngữ nghĩa rollback; chỉ chạy khi cần.
- **Retention**: `loadtest:db:cleanup` xoá `runs` cũ (`status <> 'running'`, cascade `metric_samples` + `log_events`) và `pools` cũ (cascade `pool_accounts`); **không** đụng `admin_users`, **không** đụng run đang chạy. Chạy thủ công — không có cron nền (D-9).

**Backup** (khuyến nghị trước khi `db:down` hoặc deploy):

```bash
pg_dump -h localhost -p 5439 -U appuser -d loadtest -Fc -f loadtest-$(date +%F).dump
```

## Account pool (dùng account có sẵn)

Account test có thể **seed trước vào DB 1 lần** — các run sau **login lại** (không register) khi
`useExistingAccounts=true` (mặc định — bỏ tick "fresh accounts" khi start). Register vẫn dùng
khi cần account mới (`freshAccounts`).

**Seed account vào DB** (dùng `LOADTEST_DATABASE_URL`):

```bash
# JSON — array [{ email, password, displayName?, userId?, dateOfBirth?, country? }]
npm run loadtest:seed-accounts -- loadtest/data/seed-accounts.json

# CSV — email,password[,displayName] (dòng đầu là header; auto-detect .json/.csv)
npm run loadtest:seed-accounts -- loadtest/data/seed-accounts.csv

# Pool riêng / gateway khác
npm run loadtest:seed-accounts -- accounts.json --pool-id my-pool --gateway-url http://localhost:3000
```

- Pool id tự sinh `seed-<YYYYMMDDHHMMSS>-<rand4>` (hoặc set `--pool-id`). Chạy lại = **idempotent**
  (`ON CONFLICT (pool_id, email)` cập nhật password/status).
- Password lưu **plaintext** trong DB (THREAT-MODEL D-8 — bắt buộc để reuse login). Script
  **không bao giờ in password**.
- **Thứ tự tìm pool khi start** (`useExistingAccounts=true`): pool DB khớp `gateway_url` +
  `target_users` (mới nhất, bảng `pools`/`pool_accounts`) → pool file trên disk
  (`loadtest/data/accounts-*.json`, legacy) → register mới.
- ⚠️ **Login vẫn bị rate-limit bởi gateway**: reuse dùng chung ramp `LOADTEST_REGISTER_RAMP`
  (mặc định 100 req/s) — pool 10k users login lại mất ~100s (giới hạn guest bucket của gateway).

## Vận hành

- **Health endpoint**: `GET /api/loadtest/health` → `{ status: 'ok'|'degraded'|'down', db, redis, workers, version, uptimeSec, timestamp }`. DB down → `degraded`/`down` — **không 500, không `ok` giả** (fix T-07); probe db/redis cache 10s. Docker healthcheck chỉ check HTTP 200 nên container sống khi `degraded` (D-25).
- **Tool metrics**: `GET /metrics` (Prometheus text, public như health — **ngoài** prefix `/api/loadtest`; `/api/loadtest/metrics` vẫn là tick-history dashboard). Counters: `dbWriteFail`, `dbRetry`, `apiErrors`, `workerRestarts`, `runFinished`; gauges: `coordinator.rssMb`, `worker.alive`.
- **Log JSONL**: set `LOGTEST_LOG_FILE=/path/loadtest.jsonl` → ghi JSON 1 dòng (append, rotation 10MB → `.1`... giữ 5 file). `LOADTEST_LOG_JSON=1` → console JSON (prod). Mọi entry qua redaction (`redactSensitiveFields`/`redactMsg`) — **không có** password/token/Authorization trong log.
- **Graceful shutdown**: `SIGINT`/`SIGTERM` → đóng HTTP → dừng run (await finalize DB) → flush → exit 0; quá `LOADTEST_SHUTDOWN_TIMEOUT_MS` (10s) → force exit 1 (B-2 finalize barrier).
- **Session admin**: TTL 12h, không refresh (xem "Bảo mật & secrets" — banner hết hạn trên dashboard).
- **Giới hạn (S-8)**: **1 coordinator = 1 run** — tool không chạy 2 run song song; `POST /start` khi đang chạy → 409 idempotent.

## Deploy (Docker)

Build context = repo root; bỏ qua secret nhờ `docker/.dockerignore` (chặn `loadtest/.env`, `loadtest/data/*`, `node_modules`, `.env*`). **Dockerfile không chứa secret** — mọi secret truyền qua env/volume lúc chạy.

```bash
# Frontend (2-stage: node:22-alpine build → nginx:alpine)
docker build -f docker/Dockerfile.frontend -t mayogu-chat-app:latest .
# Gateway khác origin → build-arg để CSP meta + runtime base cho đúng:
docker build -f docker/Dockerfile.frontend --build-arg VITE_GATEWAY_URL=https://gateway.mayogu.test -t mayogu-chat-app:latest .
docker run -d -p 8080:80 --name chat-app mayogu-chat-app:latest

# Loadtest tool
docker build -f docker/Dockerfile.loadtest -t mayogu-loadtest:latest .
# Bước 1 (1 lần): migration
docker run --rm -v mayogu-data:/data \
  -e LOADTEST_DATABASE_URL='postgresql://USER:PASS@HOST:5439/loadtest' \
  mayogu-loadtest:latest npm run loadtest:db:up
# Bước 2: start server
docker run -d -p 3401:3401 --name loadtest -v mayogu-data:/data \
  -e LOADTEST_HOST=0.0.0.0 \
  -e LOADTEST_DATABASE_URL='postgresql://USER:PASS@HOST:5439/loadtest' \
  -e LOADTEST_AUTH_SECRET='<hex ≥ 32 ký tự>' \
  -e LOADTEST_OTP_SECRET='<khớp OTP_SECRET gateway>' \
  -e LOADTEST_REDIS_URL='redis://...' \
  -e LOADTEST_CORS_ORIGIN='http://localhost:8080' \
  -e LOGTEST_LOG_FILE=/data/logs/loadtest.jsonl \
  mayogu-loadtest:latest
```

**Giả định / lưu ý**:
- `LOADTEST_HOST=0.0.0.0` **bắt buộc** trong Docker — mặc định `127.0.0.1` chỉ lắng nghe loopback trong container.
- `LOADTEST_PORT` mặc định 3401 — healthcheck trong image gọi đúng port này; đổi port phải sửa healthcheck.
- Healthcheck frontend: `wget /healthz` (nginx, 200 = healthy); loadtest: `wget /api/loadtest/health` (200 kể cả `degraded`).
- **nginx KHÔNG set header CSP** — CSP chỉ từ `<meta>` inject lúc build (1 nguồn duy nhất, D-8; 2 nguồn sẽ intersect chặn font/socket). nginx set `X-Frame-Options: DENY` + `X-Content-Type-Options: nosniff` + SPA fallback `try_files $uri $uri/ /index.html;` (bắt buộc cho react-router `/chat`, `/loadtest`, `/login` — F5/direct-nav không 404).

## Triển khai gateway change

Thay đổi socket auth nằm ở **repo riêng** `gateway-auth-service` (chat-app **không** chứa code gateway — verified W3). Client chat-app gửi token qua `auth: { token }` (socket.io CONNECT packet) + `Authorization: Bearer` header; gateway phải đọc **`handshake.auth?.token` đầu tiên** rồi fallback query/header:

- File: `gateway-auth-service/src/infrastructure/driving-adapters/websocket/gateway/websocket.gateway.ts:147-150` — thứ tự hiện tại `handshake.auth?.token || handshake.query?.token || handshake.headers?.authorization` (đã commit ở repo gateway, cùng lúc với T-08).
- **Vì sao cần**: browser native WebSocket **không gửi được custom header** (engine.io-client chỉ gửi `extraHeaders` cho polling); không có `auth` → browser chỉ kết nối được qua polling fallback.
- **Thứ tự deploy**: deploy gateway-auth-service trước (hoặc cùng) chat-app. Gateway cũ + client mới vẫn hoạt động (browser fallback polling, Node dùng header) nhưng websocket transport chết âm thầm — không nên kéo dài.

## CI & quality

Chất lượng được gate bằng GitHub Actions (`.github/workflows/ci.yml`, matrix **ubuntu-latest + windows-latest**) + lint local. Các lệnh:

```bash
npm run lint              # eslint (flat config) — 0 error, 0 warning
npm run lint:fix          # tự sửa lỗi fixable
npm run typecheck         # tsc root (src + vite.config.ts)
npm run loadtest:typecheck # tsc loadtest
npm run build             # tsc --noEmit && vite build
npm run loadtest:test     # vitest loadtest (integration tests skip nếu không có Postgres)
npm run test              # vitest workspace (loadtest + frontend)
npm run test:coverage     # coverage frontend (thresholds 70%)
npm run secret:scan       # gitleaks (git history + working tree)
```

CI chạy: checkout → setup-node 22 (cache npm) → `npm ci` → **gitleaks** (`gitleaks/gitleaks-action@v2` — tự tải binary, đọc `.gitleaks.toml`; hard-fail khi phát hiện secret) → lint → typecheck → loadtest:typecheck → build → loadtest:test → test → coverage → upload artifact coverage.

**Integration tests + Postgres**: ubuntu leg khởi động `postgres:16` container và tạo 2 DB test (`loadtest_test`, `loadtest_test_migrate` — xem `.github/ci/init-test-dbs.mjs`), nên `store.test.ts` + `migrate.test.ts` **chạy thật** trên CI ubuntu. Windows leg không có Postgres → suite tự skip (pattern skip-if-no-DB, probe 3s). Lưu ý: CI dùng `docker run` thay vì block `services:` vì service containers GitHub Actions chỉ hỗ trợ Linux runner (đặt `services:` trong matrix có windows sẽ fail job Windows ngay khi khởi tạo).

> ⚠️ **Manual verify — repo chưa có GitHub remote (Q-1)**: gate CI (G-4/G-5) hiện được verify **thủ công** trên máy bằng chạy đủ các lệnh trên (kỳ vọng tất cả xanh). Khi push repo lên GitHub lần đầu:
> 1. CI chạy tự động trên push + pull_request (mọi branch). Nếu job ubuntu đỏ → fix theo log rồi push lại.
> 2. Nếu **matrix Windows** fail ở step gitleaks (vấn đề install path của action trên Windows) → ghi nhận tại đây và cân nhắc thay step gitleaks bằng job ubuntu riêng, hoặc chạy gitleaks qua `npm run secret:scan` trong job Windows (cần gitleaks binary trên PATH runner).
> 3. Nếu repo thuộc GitHub **Organization**: tạo secret `GITLEAKS_LICENSE` (gitleaks-action bắt buộc cho org, không cần cho user account).

**eslint**: flat config `eslint.config.js` (typescript-eslint + react-hooks + react-refresh, toàn bộ devDependencies — runtime zero-dep). `no-console` là error trong `src/`; ngoại lệ có chủ đích (kèm comment trong config): `chat.store.ts`/`lib/socket.ts` (debug log có sẵn — xử lý ở task T-08 scope), `ErrorBoundary.tsx` (log PII-sanitized, control bảo mật), `loadtest/**` (CLI tool — logger sink console).

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
