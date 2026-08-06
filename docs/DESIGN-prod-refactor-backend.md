# DESIGN — Prod-refactor backend (loadtest server)

**Status**: PROPOSAL — chờ design council review
**Author**: Backend Architect (autobuild refactor)
**Version**: 0.1 — 2026-08-04
**Nguồn chuẩn**: `docs/PRD-prod-refactor.md` (APPROVED — GATE 1), `docs/PLAN-prod-refactor.md` (APPROVED — GATE 1), `docs/ARCHITECTURE-loadtest.md` (tham chiếu, không mâu thuẫn).
**Phạm vi**: Toàn bộ backend `loadtest/` — các task T-03, T-04, T-05, T-06 (Backend Architect executor). T-07 (observability) thiết kế phần backend để Realtime Collaboration Engineer tiêu thụ.
**Ràng buộc cứng**:
- **Zero-dep runtime** — chỉ `node:http`, `node:fs`, `node:path`, `pg`, `ws`, `socket.io-client`, `ioredis`. Không framework mới.
- **Giữ hành vi quan sát được** — không đổi contract gateway, không đổi UI dashboard, không đổi state machine run, không đổi route path.
- **KHÔNG phải rewrite** — đây là refactor có rào chắn (move + inject + thêm chức năng mới được PRD/PLAN chốt).

---

## 0. Nguyên tắc thiết kế chung

1. **Tách file trước, tách logic sau** — mỗi bước tách phải là *pure move* (đổi import path, không đổi thân hàm) để diff review được và test cũ vẫn xanh từng bước.
2. **Compat shim thay vì đổi entry point** — mọi module cũ giữ nguyên path/export để `worker.ts`, `api-server.test.ts`, `store.test.ts`, `socket-farm.test.ts` không vỡ vì import path (khác quyết định mở Q-5 của ARCHITECTURE-loadtest.md — xem §10).
3. **getEnv() không validate** — `validateEnv()` là bước riêng ở server entry (lý do bắt buộc: `worker.ts:11` gọi `getEnv()` trong child process; validate trong getEnv sẽ làm worker fail oan vì thiếu OTP_SECRET/DB. Xem §8).
4. **Mọi quyết định có tradeoff** — ghi rõ "chọn gì / vì sao / mất gì".

---

## 1. Module decomposition — kill god classes (T-06, S-6)

Mục tiêu đo được (PLAN T-06): `api-server.ts` 532 → < 400 dòng; `coordinator.ts` 537 và `socket-farm.ts` 694 được bẻ bằng *pure move + re-export shim*. KHÔNG làm hexagonal đầy đủ của ARCHITECTURE-loadtest.md §3.1 trong wave này (đó là mục tiêu v1.1 — ghi rõ trong §10 để tránh drift).

### 1.1 api-server.ts → router mỏng + 6 module

| File mới | Sở hữu | Nguồn (file:dòng hiện tại) | Ước dòng |
|---|---|---|---|
| `loadtest/http-server.ts` (MỚI) | Helper HTTP **inbound**: `readBody(req, maxBytes)` (1MB + 400 INVALID_JSON — §7.2), `applyCors(req,res,origins)` + `parseOrigins` (§7.1), `sendJson/okJson/failJson` (envelope chuẩn + timestamp + error code + traceId — §1.6), `makeRequestId()`, `BodyError`, `isRunPath/runIdFromPath` | `api-server.ts:75-109` (cors/json/ok/fail/readBody/url) + `api-server.ts:444-458` (runIdFromPath/isRunPath) | ~150 |
| `loadtest/api-mappers.ts` (MỚI) | Row → API payload mapping (thuần, test được không cần HTTP): `toRunSummary`, `toRunDetail`, `toMetricTick` | `api-server.ts:460-531` | ~80 |
| `loadtest/guards.ts` (MỚI) | `requireAuth(req, authSecret)` (HMAC ≤ 1ms, không DB — giữ nguyên logic), `registerGate(env)`, `rateLimitWrap(limiter, key)` | `api-server.ts:112-124` + logic mới §2 | ~70 |
| `loadtest/rate-limit.ts` (MỚI) | Token bucket per-IP + fail-window per-IP + registry cleanup (chi tiết §2) | mới (KHÔNG dùng `SimpleRateLimiter` `auth-factory.ts:133-150` — nó là limiter chờ, không trả 429, không theo IP) | ~120 |
| `loadtest/routes/auth.ts` (MỚI) | `registerAuthRoutes(ctx)`: register (có gate), login, logout, me | `api-server.ts:386-439` | ~90 |
| `loadtest/routes/run.ts` (MỚI) | start/stop/kill/pause/resume/status/metrics/users/errors/logs/report/export | `api-server.ts:148-271` | ~130 |
| `loadtest/routes/history.ts` (MỚI) | `/runs`, `/runs/{id}`, `/runs/{id}/metrics`, `/runs/{id}/logs`, `DELETE /runs/{id}` — đọc QueryResult, DB fail → 503 (§4.3) | `api-server.ts:335-375` | ~80 |
| `loadtest/routes/settings.ts` (MỚI) | `/config`, `/allowlist` GET/POST, `/cleanup`, `/pools` | `api-server.ts:148-163, 273-333` | ~90 |
| `loadtest/api-server.ts` (SỬA) | Chỉ còn: `ApiServer` class = **router** + composition root nhỏ — route table `[method, pattern] → handler(ctx)`, giữ `listen()/close()/port` public (test phụ thuộc), gắn requestId, CORS, error handler 500 cuối | giữ nguyên API public | target **< 250** |

**Ctx object** (định nghĩa trong `http-server.ts`):
```ts
interface RouteCtx {
  env: LoadTestEnv;
  coordinator: LoadTestCoordinator;
  store?: LoadtestStore;
  authSecret: string;
  requestId: string;   // sinh 1 lần/request (§1.6)
  limiter: RateLimiters;
}
```

**Thứ tự tách (mỗi bước xanh test)**:
1. Move `readBody/cors/ok/fail/json` → `http-server.ts` (pure move, không đổi hành vi).
2. Move mappers → `api-mappers.ts` (thuần).
3. Move `requireAuth` → `guards.ts`.
4. Tách `handleAuth` → `routes/auth.ts`; các handler còn lại → 3 file routes.
5. `handle()` chỉ còn: parse URL → tra route table → gọi handler → catch lỗi → envelope 500.

**Vì sao không dùng bảng route function `(req,res)=>Promise` một thể?** — Giữ pattern "switch case hiện tại" chuyển thành map `pattern → handler` (regex path param cho `/runs/{id}`), vì: (a) thay đổi tối thiểu thân handler (không viết lại parse param), (b) contract path giữ nguyên. Tradeoff: không có middleware chain — thay bằng 3 guard rõ ràng gọi đầu mỗi handler (auth, rate-limit, register-gate); đủ cho 20 route.

### 1.2 coordinator.ts → facade + 2 collaborator (bounded)

| File mới | Sở hữu | Nguồn | Ước dòng |
|---|---|---|---|
| `loadtest/gateway-observer.ts` (MỚI) | `GatewayObserver` — poll queue-count + scrape gateway `/metrics` (Prometheus text, AbortSignal.timeout(4000), bỏ qua lỗi 401 — giữ nguyên hành vi) | `coordinator.ts:416-450` | ~90 |
| `loadtest/run-finalizer.ts` (MỚI) | `finalizeRun(deps)` — chuỗi kết thúc run: stopTimers → killAll/dispose farm → redis disconnect → endPhaseFromStop → buildReport → saveReportFiles → dbWriter.writeRunFinish; inject qua interface (test được với fake deps) | `coordinator.ts:454-505` | ~80 |
| `loadtest/coordinator.ts` (SỬA) | Giữ class `LoadTestCoordinator` + constructor signature (api-server, server.ts, test đều import `../coordinator` — không đổi): vòng đời start/stop/pause/resume, worker message switch, aggregateTick 1s, auto-stop E1/E2/E3, queryUsers | giữ | ~380 |

**Tradeoff**: `finishRun` đụng nhiều private field — tách qua interface `RunFinalizerDeps` (read-only view) thay vì truyền `this`. Rủi ro: field nào sót trong deps → type error ngay (compile-time), không lỗi runtime. `aggregateTick` giữ nguyên trong coordinator vì nó đọc ~15 state field mỗi giây — tách sẽ tạo interface "con mồi" khó bảo trì hơn là giúp.

### 1.3 socket-farm.ts → 2 module + shim

| File mới | Sở hữu | Nguồn |
|---|---|---|
| `loadtest/virtual-user.ts` (MỚI) | `VirtualUser` + `pickProfile` + `PendingMsg` + hằng pacing | `socket-farm.ts:25-364` |
| `loadtest/worker-runtime.ts` (MỚI) | `WorkerRuntime` (scheduler 100ms, counters, histograms, emitTick, queryUsers) | `socket-farm.ts:366-691` |
| `loadtest/socket-farm.ts` (SỬA) | **Shim re-export**: `export { VirtualUser, pickProfile } from './virtual-user'; export { WorkerRuntime } from './worker-runtime';` | — |

**Vì sao shim**: `worker.ts:6` import `{ WorkerRuntime }` từ `./socket-farm`; `socket-farm.test.ts:6` import `pickProfile` từ `../socket-farm`. Giữ shim → 2 nơi này không đổi, diff thuần move. Tradeoff: 1 file shim "chết" còn tồn tại — chấp nhận, xoá trong v1.1 khi có worker-entry mới. Dead code `final-tick` (`socket-farm.ts:663-665`, không ai xử lý ở `coordinator.ts:265-298`) được **giữ nguyên** trong wave này (xoá là thay đổi hành vi IPC — ghi vào T-07 như PLAN đã liệt kê).

### 1.4 Vì sao tách theo file thay vì theo class DI đầy đủ

ARCHITECTURE-loadtest.md §2.2 đề xuất hexagonal + ports đầy đủ. PLAN T-06 (approved) chỉ yêu cầu giảm god class giữ hành vi. Chọn: tách file + inject thủ công qua constructor/interface — đủ để (a) mỗi module test độc lập, (b) không phá 8 test file hiện có, (c) giữ được diff review. Đổi sang ports/adapters đầy đủ là v1.1 — ghi rõ trong README.

---

## 2. rate-limit.ts (T-06, S-10, SEC-5, US-SEC-4)

### 2.1 Hai primitive (zero-dep, inject clock cho test)

```ts
// 1) Token bucket — trả 429 khi hết token
class TokenBucket {
  constructor(private capacity: number, private refillPerMs: number, private now: () => number = Date.now)
  take(): boolean  // refill theo (now - lastRefill) * refillPerMs; cận trên capacity
}

// 2) Fail window — đếm FAILURE (không phải tổng request) trong cửa sổ
class FailWindow {
  constructor(private limit: number, private windowMs: number, private now: () => number = Date.now)
  isBlocked(): boolean                      // fails.length >= limit && now - fails[0] < windowMs
  recordFailure(): { blocked: boolean; retryAfterSec: number }
  clear(): void                             // gọi khi thành công
}
```

**Registry per-IP + cleanup**:
```ts
class RateLimiters {
  private loginFails   = new Map<string, FailWindow>();   // key: ip
  private registerFails= new Map<string, FailWindow>();
  private startBuckets = new Map<string, TokenBucket>();
  private lastSeen     = new Map<string, number>();       // ip → now (dùng cho sweep)

  check(path: string, ip: string): { allowed: boolean; retryAfterSec?: number; kind?: 'FAIL' | 'BUCKET' }
  recordFailure(kind: 'login' | 'register', ip: string): void
  sweep(now: number): void   // xoá entry lastSeen < now - 10min
}
```

**Cleanup stale buckets** — chọn *lazy sweep* (không setInterval): mỗi lần `check()`, nếu `lastSeen.size > 2048` thì chạy `sweep()` (xóa entry không hoạt động > 10 phút, xóa toàn bộ bucket của ip đó). Tradeoff: không có timer riêng (đơn giản, test bằng fake clock), nhưng map có thể chứa vài nghìn ip thụ động trước khi vượt ngưỡng — bộ nhớ ≤ 2048 bucket ~ vài trăm KB, chấp nhận. `sweep` export riêng để test trực tiếp.

**IP key**: `req.socket.remoteAddress` (tool bind `127.0.0.1` mặc định — `config.ts:91`). KHÔNG tin `X-Forwarded-For` trừ khi `LOADTEST_TRUST_PROXY=1` (chống spoof header từ client trực tiếp). Tradeoff: sau reverse-proxy cluster cần bật flag — document trong README.

### 2.2 Route limits (theo PRD §5.1 — approved, đè ARCHITECTURE §5)

| Route | Limiter | Giá trị | Hành vi vượt |
|---|---|---|---|
| `POST /auth/login` | fail-window per-IP | 5 **fail**/60s | 429 `{ success:false, statusCode:429, error:'RATE_LIMITED', message:'Quá nhiều yêu cầu — thử lại sau Ns', retryAfterSec, timestamp }` + header `Retry-After: N` |
| `POST /auth/register` | fail-window per-IP | 5 **fail**/60s | 429 như trên |
| `POST /start` | token bucket per-IP | capacity 1, refill 1/10s | 429 như trên |
| `/allowlist` POST, `/cleanup`, `DELETE /runs/{id}` | (tùy chọn, default OFF) token bucket | 30 req/min | 429 — **mặc định tắt** để không phá test/E2E; bật qua `LOADTEST_RATE_LIMIT_WRITE_BUCKET=1` |
| GET polling (`/status`, `/metrics`, `/users`, `/errors`, `/logs`) | KHÔNG giới hạn | — | — (dashboard poll 1s — `src/store/loadtest.store.ts:165-192`; giới hạn sẽ làm vỡ UI) |
| `/health`, `/metrics` (tool) | KHÔNG giới hạn | — | — |

**Định nghĩa "fail"** (cần sign-off — xem §10.4): mọi response 4xx của login/register tính là 1 fail; response thành công → `clear()` (window reset). Lý do: brute-force đo bằng số phản hồi thất bại; đếm 409 (duplicate) chặn cả register-spam. **Login đúng trong cửa sổ vẫn hoạt động** (US-SEC-4) vì chỉ đếm fail.

**Testability**: constructor nhận `now()`; registry nhận `maxIdleMs`; test: 5 fail → thứ 6 block; hết 60s (fake clock) → unblock; /start 2 lần trong 10s → lần 2 429; sweep xoá ip thụ động. Env: `LOADTEST_RATE_LIMIT_DISABLED=1` (test/CI escape hatch — PLAN R-6), `LOADTEST_RATE_LIMIT_LOGIN_FAILS`, `LOADTEST_RATE_LIMIT_WINDOW_MS`, `LOADTEST_RATE_LIMIT_START_MS`.

**Rủi ro phá test**: `api-server.test.ts` login/register từ cùng IP 127.0.0.1 — số fail trong suite: register duplicate 409 (1) + password yếu 400 (1) + login sai 401 (1) = 3 < 5, window 60s giữa các request không tràn → an toàn. T-11 thêm test 429 phải set `LOADTEST_RATE_LIMIT_DISABLED` trong env override của riêng test đó.

---

## 3. Migration runner (T-04, D-4, US-DB-1, Q-3)

### 3.1 File & naming

- `loadtest/db/migrations/NNN_name.sql` — `NNN` = số 3 chữ số (001, 002...), tên snake_case mô tả. Sort theo prefix số.
- `001_init.sql` = **baseline** — nội dung DDL y hệt `schema.sql:16-148` hiện tại (`CREATE TABLE IF NOT EXISTS` — giữ nguyên, không đổi DDL), kèm marker UP/DOWN (mục 3.2). `schema.sql` cũ **giữ nguyên** để rollback code an toàn (PLAN §7) — chỉ init.ts/store không còn đọc nó.

### 3.2 Parse up/down (zero-dep)

Mỗi file migration:
```sql
-- ==== UP ====
CREATE TABLE IF NOT EXISTS admin_users (...);
...

-- ==== DOWN ====
DROP TABLE IF EXISTS log_events;
DROP TABLE IF EXISTS metric_samples;
DROP TABLE IF EXISTS pool_accounts;
DROP TABLE IF EXISTS pools;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS admin_users;
```

Parser (trong `migrate.ts`, ~30 dòng): split theo dòng, tìm marker `^--\s*====\s*(UP|DOWN)\s*====` (case-insensitive); section UP = nội dung giữa UP-marker và DOWN-marker; DOWN = sau DOWN-marker. **Fail-fast**: thiếu marker hoặc section rỗng → throw (không nuốt — PLAN R-1). Multiple statements chạy trong **1 `client.query(sql)`** (simple query protocol của pg cho phép multi-statement, không có param). Tradeoff: không tách từng câu bằng `;` (rủi ro vỡ khi DDL chứa `;` trong trigger/function) — bù lại, migration phải tuân thủ "mỗi file = DDL thuần, không PL/pgSQL có `;` nội bộ" — ghi trong header mẫu.

### 3.3 Transaction + schema_version tracking

- Bảng tracking: **giữ `schema_version`** (`schema.sql:16-19`) — PRD §5.5 "schema_version giữ" đè ARCHITECTURE §6.2 (đề xuất đổi sang bảng `migrations`). `applied version = SELECT COALESCE(MAX(version), 0) FROM schema_version`.
- Runner **tự đảm bảo bảng tồn tại**: đầu tiên `CREATE TABLE IF NOT EXISTS schema_version (...)` (xử lý DB trống / bảng thiếu — R-4).
- Mỗi migration chạy trên **1 `pg.Client` riêng** (lấy từ `pool.connect()` khi qua store; tự tạo khi qua CLI) trong transaction:
  - `up`: `BEGIN` → chạy section UP → `INSERT INTO schema_version (version) VALUES (NNN) ON CONFLICT DO NOTHING` → `COMMIT`; lỗi → `ROLLBACK` + throw (không ghi version).
  - `down` (1 bước): `BEGIN` → chạy section DOWN của version cao nhất → `DELETE FROM schema_version WHERE version = NNN` → `COMMIT`.
- **Idempotent**: chỉ áp dụng file có `NNN > appliedVersion`; chạy lại `up` không làm gì (số file đã apply = 0).
- **Concurrency guard**: `SELECT pg_advisory_lock(hashtext('loadtest_migrations'))` đầu `up/down` (2 dòng, zero-dep) — chặn 2 instance chạy cùng lúc.

### 3.4 Baseline-detect cho DB cũ (R-4)

- DB mới: chạy 001 đầy đủ → 7 bảng + `schema_version=1`.
- DB cũ (đã có data từ schema.sql thủ công): bảng đã tồn tại → `CREATE TABLE IF NOT EXISTS` no-op (không đụng data), version=1 đã có → 001 **bị skip** vì `1 <= applied(1)`.
- "Bảng tồn tại nhưng thiếu cột" (R-4): không thể xảy ra với DB hiện tại (vì schema.sql luôn tạo đủ v1), nhưng migration **sau** 001 phải dùng `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` + có DOWN tương ứng (`DROP COLUMN`) — ghi thành quy ước trong header mẫu.

### 3.5 CLI + integration với store/init (không vỡ startup)

```ts
// migrate.ts exports (dùng chung CLI + store):
export function loadMigrations(dir?: string): Migration[]
export async function runMigrations(client: pg.Client, dir?: string): Promise<{ applied: string[] }>
export async function rollbackOne(client: pg.Client, dir?: string): Promise<{ rolledBack: string | null }>
export async function migrationStatus(client: pg.Client, dir?: string): Promise<{ applied: number; pending: string[] }>
// main(): process.argv[2] ∈ up|down|status|cleanup
```

- **CLI**: `npx tsx loadtest/db/migrate.ts <cmd>` — tự tạo `pg.Client` từ `LOADTEST_DATABASE_URL` (placeholder → exit 1). `cleanup --older-than 30d`: `DELETE FROM runs WHERE start_at < cutoff AND status <> 'running'` (FK cascade tự xoá metric_samples + log_events — `schema.sql:106,143`) + `DELETE FROM pool_accounts WHERE pool_id IN (SELECT pool_id FROM pools WHERE created_at < cutoff)` + `DELETE FROM pools WHERE created_at < cutoff`. KHÔNG đụng `admin_users`. Chạy thủ công, không nền (D-9).
- **package.json** (thêm 4 scripts): `loadtest:db:up|down|status|cleanup`.
- **`store.ensureSchema()` KHÔNG bị xoá — chuyển thành wrapper**: `async ensureSchema(): Promise<QueryResult<void>>` → `const client = await this.pool.connect(); runMigrations(client)` (giữ tên để `store.test.ts:20,35,276` và `api-server.test.ts:24,52` không vỡ). `DbWriter.startup()` (`writer.ts:43`) gọi wrapper: `!ok && env.dbRequired → throw` (server exit ≠ 0 — T-05). `db/init.ts:94-98` bỏ đọc schema.sql, gọi `runMigrations` qua client của nó (giữ `--verify`/`--seed-admin`).
- **Down = destructive** (drop bảng) — đúng ngữ nghĩa rollback, G-8 chấp nhận; bảng `schema_version` giữ lại (runner cần); "version 0" = bảng trống.

---

## 4. DB store correctness: QueryResult + BIGINT (T-05, D-5/D-6/D-7/D-10)

### 4.1 Contract

```ts
// loadtest/db/result.ts (MỚI)
export type QueryResult<T> =
  | { ok: true; rows: T[] }
  | { ok: false; error: { code?: string; message: string; sql?: string; params?: unknown[] } };

export function first<T>(r: QueryResult<T>): QueryResult<T | null>;  // rows[0] ?? null (giữ ergonomics)
```

### 4.2 Core query + retry policy (thay `store.ts:173-192`)

```ts
private async query<T>(sql, params = []): Promise<QueryResult<T>> {
  if (!this.enabled || !this.pool) return { ok: false, error: { code: 'DB_DISABLED', message: 'DB chưa kết nối' } };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { const res = await this.pool.query(sql, params); return { ok: true, rows: res.rows as T[] }; }
    catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (!isTransient(code)) return { ok: false, error: { code, message, sql, params } };  // 23505/23503/22P02 → fail nhanh, KHÔNG retry
      toolMetrics.inc('dbRetry');                       // đếm retry thật (T-05 tạo tool-metrics)
      if (attempt === 1) { await sleep(100); continue; }
    }
  }
  return { ok: false, error: { code: 'RETRY_EXHAUSTED', message: 'query fail 2 lần', sql, params } };
}
// loadtest/db/int.ts (MỚI)
export function isTransient(errOrCode): boolean
//   connection-level: ECONNRESET, ETIMEDOUT, 08001, 08006, 57P01, 57P02, 40001
//   KHÔNG transient: 23505, 23503, 22P02, 42P01... → fail nhanh + log có SQL (chẩn đoán được, không retry vô nghĩa — 1.2.2)
```

### 4.3 Callers đổi thế nào (phân nhóm)

| Nhóm | Method (store.ts) | Cách đổi | Ghi chú |
|---|---|---|---|
| History đọc (D-6 — "no rows" ≠ "DB fail") | `listRuns:289`, `getRun:301`, `deleteRun:307`, `listMetricSamples:338`, `countMetricSamples:355`, `listLogEvents:366`, `listPools:428` | Trả `QueryResult<T[]>` / `QueryResult<T\|null>`; **API route**: `!ok → fail(503, 'Database lỗi', { error:'DB_UNAVAILABLE' })` | `countMetricSamples` không bao giờ trả 0 giả — `api-server.ts:350` route history xử lý 503 ngay trong T-05 |
| Auth đọc | `findAdminByLogin:216`, `getAdminById:227`, `createAdmin:196` | Trả `QueryResult<T\|null>`; route: `!ok → 503`; `rows[0] == null → 409/401` | login/register vẫn 401/409 — không lộ DB fail khác thường |
| Write best-effort | `insertRun:244`, `finalizeRun:267`, `markRunsRunningAsError:279`, `insertMetricSamples:314`, `insertLogEvent:362`, `upsertPool:384`, `insertPoolAccounts:440`, `updatePoolAccount:479`, `touchLastLogin:238` | Trả `QueryResult<void>`; **DbWriter**: `!ok → toolMetrics.inc('dbWriteFail')` + `ltLog.warn` kèm `{ runId }` + retry ≥ 1 (US-DB-2) | KHÔNG throw chết run — giữ best-effort (`store.ts:6-7` quy tắc) |

**DbWriter.flushTicks bổ sung hồi phục hàng đợi** (`writer.ts:107-117`): hiện tại fail → batch mất. Đổi: `!ok` → đưa batch về đầu `pendingTicks` (cận `MAX_PENDING_TICKS * 2` — vượt thì drop batch cũ nhất + `toolMetrics.inc('dbWriteFail')`), flush timer 30s (`writer.ts:19`) sẽ retry — đúng US-DB-2 "(c) khi DB hồi phục, hàng đợi pending được flush". **Thay đổi hành vi có chủ đích**: batch không còn bị mất im lặng.

### 4.4 Bỏ setTypeParser toàn cục + parse BIGINT ở biên (D-7)

- Xoá `store.ts:19` (`pg.types.setTypeParser(20, ...)`) — toàn cục, ảnh hưởng mọi module dùng pg.
- BIGINT (OID 20) giờ trả **string** → parse ở biên qua `toEpochMs()` cho **đúng cột đã biết là epoch ms**:
```ts
// loadtest/db/int.ts
export function toEpochMs(x: number | string | null | undefined): number | null {
  if (x === null || x === undefined) return null;
  return Math.trunc(Number(x));   // fix float (D-5)
}
```
- Mỗi SELECT trong store thêm bước map: `rows.map(r => ({ ...r, startAt: toEpochMs(r.startAt), ... }))` — ~10 call site, liệt kê cột int8: `admin_users.created_at/updated_at/last_login_at`, `runs.start_at/end_at/created_at/updated_at`, `pools.created_at`, `pool_accounts.registered_at/last_login_at`, `metric_samples.ts`, `log_events.ts`. Các cột **khác** giữ nguyên string? — KHÔNG: cột `id` SERIAL (int4), counter đều `INTEGER` — không chạm.
- **An toàn < 2^53**: mọi cột int8 đều là epoch ms hoặc counter nhỏ — không cột nào vượt 2^53; `countMetricSamples` đã cast `::int` (`store.ts:356`). Tradeoff: mất tính năng tự động của parser toàn cục (các cột int8 khác nếu thêm sau phải map thủ công) — bù lại không có side-effect toàn cục, type-safe.
- **Fix nguồn float**: `writer.ts:256` `createdAt: fs.statSync(filePath).mtimeMs` → `createdAt: toEpochMs(fs.statSync(filePath).mtimeMs)`. `auth-factory.ts:119` `mtimeMs` chỉ là hiển thị/sort (không vào DB) — giữ, ghi chú.
- `connect()` fail + `dbRequired` → **throw** (`store.ts:132-149` đổi: catch → `if (env.dbRequired) throw new Error(...)`; server.ts bắt → exit ≠ 0 — US-CFG-1, Q-2). `enabled` giữ như flag trạng thái.

### 4.5 Rủi ro phá test (bắt buộc nêu)

- `store.test.ts` (~20 call site) và `api-server.test.ts` (direct store calls: `findAdminByLogin`, `insertRun`, `insertMetricSamples`, `insertLogEvent`, `finalizeRun`) đọc kết quả dạng row trực tiếp → **cần cập nhật cơ học** sang `r.ok ? r.rows : ...` (hoặc dùng `first()`). PLAN chưa liệt kê test-update này trong T-05 (chỉ T-06 có) — **đề nghị thêm vào T-05** (xem §10.3). `truncateAll` dùng cast `query` bypass — không đổi.

---

## 5. tool-metrics.ts + logger.ts + health.ts (T-05/T-07)

### 5.1 tool-metrics.ts (T-05 tạo — T-06/T-07 mở rộng)

```ts
// loadtest/tool-metrics.ts (MỚI — thiết kế TRƯỚC đủ 5 counter + 2 gauge để 3 task không đụng nhau)
export type ToolCounter = 'dbWriteFail' | 'dbRetry' | 'apiErrors' | 'workerRestarts' | 'runFinished';
export type ToolGauge    = 'coordinator.rssMb' | 'worker.alive';
export interface ToolMetrics {
  inc(name: ToolCounter, by?: number): void;
  setGauge(name: ToolGauge, v: number): void;
  snapshot(): { counters: Record<string, number>; gauges: Record<string, number> };
  toPrometheusText(): string;   // loadtest_db_write_fail 12 — gauge đổi '.' → '_'
}
export function createToolMetrics(): ToolMetrics;   // factory (test dùng instance riêng)
export const toolMetrics: ToolMetrics;              // singleton module (prod dùng)
```
- **Nơi gắn**: `dbWriteFail/dbRetry` — §4.3 (T-05); `apiErrors` — error handler `handle()` catch (`api-server.ts:378-381`) (T-06); `workerRestarts` — `worker-farm.ts:89 onWorkerRestarted` → `toolMetrics.inc` (T-07); `runFinished` — `run-finalizer.ts` (T-07); `coordinator.rssMb` — `aggregateTick` set `process.memoryUsage().rss` (T-07); `worker.alive` — `coordinator.ts:336` đã có `farm.alive`.
- **Expose**: route `GET /metrics` (Prometheus text/plain) — **không phải** `/api/loadtest/metrics` (đã là tick-history — PLAN finding #11). Nằm ngoài prefix loadtest như `/health` — public như health (không có dữ liệu nhạy cảm, chỉ counter).
- Counter Map cố định theo union type → typo fail lúc compile; snapshot để test.

### 5.2 logger.ts (T-07) — structured JSON, giữ ltLog compat

**Thiết kế: chuyển implement từ `util.ts:6-49` sang `logger.ts`; `util.ts` thành re-export shim** (`export { ltLog, logHistory, subscribeLog, setVerbose, log } from './logger'`) — toàn bộ ~15 import site cũ không đổi. `logger.ts` KHÔNG import `util.ts` (tránh cycle).

```ts
export interface LogEntry {
  ts: number; level: 'info' | 'warn' | 'error';
  msg: string;                       // GIỮ text có prefix [lt] như cũ (ring buffer + dashboard compat — /logs trả msg như hiện tại)
  runId?: string; workerId?: string; requestId?: string; context?: unknown;
}
export const logHistory: LogEntry[];                 // ring 500 (giữ — PRD 5.8)
export function log(level, msg, fields?: Record<string, unknown>): void;
export const ltLog = { info, warn, error };          // (msg, fields?) — arg không phải object → nối vào msg (giữ output cũ)
export type LogSubscriber = (level, msg, meta?: { runId?, workerId?, requestId? }) => void;  // tham số 3 OPTIONAL — subscriber cũ (writer.ts:48) không vỡ
export function subscribeLog(fn): () => void;
export function setVerbose(v): void;
export function createJsonlSink(dir: string, opts?: { maxBytes?: number }): { start(): void; stop(): void };
```
- **Console sink**: in JSON 1 dòng `{"ts":"2026-08-04T10:00:00.000Z","level":"info","msg":"[lt] ...","runId":"lt...","requestId":"req..."}` khi `LOADTEST_LOG_JSON=1` (default 0 → giữ format text hiện tại; PRD 5.3 yêu cầu JSON — bật mặc định ở production). Tradeoff: dev giữ text dễ đọc, prod bật JSON.
- **Ring buffer**: lưu entry **có cấu trúc** (fix lệch format 1.2.22 — trước đây lưu cả dòng `[lt][INFO][ts]`, DB subscriber nhận msg raw); dashboard `/logs` (`api-server.ts:242-245`) map qua: `{ ts, level, msg }` — **msg giữ nguyên text cũ** → UI không đổi.
- **Subscriber DB**: giữ signature `(level, msg)` cho `writer.ts:48` — meta optional; runId vẫn do writer tự gắn qua `currentRunId` (`writer.ts:134`) — log_events.run_id đã có.
- **JSONL sink + rotation**: `dataDir/logs/loadtest-YYYY-MM-DD.jsonl` (xoay theo ngày); vượt `maxBytes` (50MB) → đóng stream, mở file mới suffix `-1` (append). Zero-dep: `fs.createWriteStream({ flags: 'a' })`, check size mỗi write (rẻ: so `stat.size` cache + dòng dài trung bình). Không chạy nền rotation phức tạp — đủ cho tool.
- **runId/requestId**: coordinator log hot spots (`start`/`finishRun`/E1-E3) truyền `{ runId }`; routes truyền `{ requestId }` (T-06 sinh). Logger stateless — không global run context (giữ single-run architecture).

### 5.3 health.ts (T-07, US-OBS-1)

```ts
// loadtest/health.ts (MỚI — thuần, test bằng fake deps)
export interface HealthDeps {
  store?: { enabled(): boolean; probe(): Promise<boolean> };
  coordinator: { phase(): RunPhase; farmAlive(): number };
  redis?: { configured(): boolean; ping(): Promise<boolean> };
  version: string; startedAt: number;
}
export function buildHealth(deps: HealthDeps): Promise<HealthReport>;
// HealthReport = {
//   status: 'ok' | 'degraded' | 'down',
//   db: 'up' | 'down' | 'unknown', redis: 'up' | 'down' | 'disabled',
//   workers: 'idle' | 'running' | 'down', version, uptimeSec, timestamp,
// }
```
- **Logic**: `db = probe ok ? 'up' : 'down'`; `redis = configured ? (ping ok ? 'up' : 'down') : 'disabled'`; `workers = phase ∈ running ? (farmAlive>0 ? 'running' : 'down') : 'idle'`; `status`: có `down` → `down`; `db='down' || redis='down'` → `degraded`; else `ok`. **DB down → degraded, không 500, không 'ok' giả** (US-OBS-1).
- **Cached probe TTL 10s** (`createHealthProbe`): health không được đấm DB mỗi lần gọi (container healthcheck 10-30s + dashboard không gọi). Tradeoff: trạng thái trễ ≤ 10s — chấp nhận.
- Route `GET /api/loadtest/health` (`api-server.ts:141`) → gọi buildHealth; thêm field `version` (từ package.json), `uptimeSec`. Additive — client đọc `status` không vỡ.

---

## 6. Graceful shutdown (T-06, §5.2 PRD)

Thay `server.ts:41-49`:

```ts
const SHUTDOWN_TIMEOUT_MS = env.shutdownTimeoutMs;  // LOADTEST_SHUTDOWN_TIMEOUT_MS, default 10_000 (≥ 10s — PRD 5.2)
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return; shuttingDown = true;
  ltLog.info(`Nhận ${signal} — shutdown tối đa ${SHUTDOWN_TIMEOUT_MS}ms...`);
  const deadline = setTimeout(() => {
    ltLog.error('Shutdown timeout — force exit 1');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  deadline.unref();
  try {
    await api.closeConnections();   // http-server: server.close() + server.closeAllConnections?.() (Node ≥ 18.2 — cắt keep-alive)
    await coordinator.stop(true);    // kill-switch → finishRun → dbWriter.writeRunFinish → flushTicks
    await dbWriter.shutdown();      // unsubscribe log + flushTicks (lần 2 — no-op) + store.disconnect
    ltLog.info('Shutdown hoàn tất');
    process.exit(0);
  } catch (err) {
    ltLog.error(`Shutdown lỗi: ${String(err)}`);
    process.exit(1);
  }
}
```
- **Thứ tự**: đóng HTTP trước (chặn request mới) → dừng run (force, worker chết nhanh ≤ 5s — `worker-farm.ts:126-135`) → flush DB → thoát. Tradeoff: request đang dở bị cắt ngang — chấp nhận cho tool nội bộ (dashboard poll 1s tự reconnect).
- **Flush trước khi thoát**: `dbWriter.shutdown()` → `flushTicks()` (`writer.ts:53-58`) — không mất ≤ 30s tick cuối (PLAN Phase 5).
- `deadline.unref()` để timer không giữ process sống nếu shutdown xong sớm. Worker con đã có SIGTERM/SIGINT handler (`worker.ts:57-62`).

---

## 7. CORS + body parsing (T-06, SEC-2, S-7, US-API-1)

### 7.1 CORS (`http-server.ts`, thay `api-server.ts:75-79`)

```ts
export function parseOrigins(raw: string | undefined, def = ['http://localhost:5173']): string[]  // split ',', normalizeUrl, lọc rỗng
export function applyCors(req, res, origins: string[]): void
```
- Origin khớp (so `new URL(origin).origin` với từng entry) → `Access-Control-Allow-Origin: <origin>` + `Vary: Origin`; `Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS`; `Access-Control-Allow-Headers: Content-Type,Authorization`; `Access-Control-Max-Age: 600` (cache preflight — giảm request). Không khớp → **không set ACAO** (browser tự chặn; server vẫn xử lý — CORS là cơ chế browser, attacker curl không bị ảnh hưởng; chọn cách này vì đơn giản + chuẩn).
- Preflight `OPTIONS` → 204 với header CORS (giữ `api-server.ts:130-134` nhưng theo origin).
- `LOADTEST_CORS_ORIGIN` env, default `http://localhost:5173` (R-7 — Vite proxy `changeOrigin:true` gửi origin Vite). `*` chỉ có hiệu lực nếu set literal `*` (dev — document, KHÔNG khuyến nghị — SEC-2).
- Không có `Origin` header (curl/SSR) → không ACAO → không ảnh hưởng.

### 7.2 readBody — 1MB + 400 (thay `api-server.ts:95-105`)

```ts
export class BodyError extends Error {
  constructor(public statusCode: 400 | 413, message: string) { super(message); }
}
export async function readBody(req: http.IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > maxBytes) { req.destroy(); throw new BodyError(413, `Body vượt quá ${maxBytes} byte`); }
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { throw new BodyError(400, 'JSON body không hợp lệ'); }   // US-API-1: message CHÍNH XÁC
}
```
- Route wrap: `try { body = await readBody(req) } catch (e) { if (e instanceof BodyError) return failJson(res, e.statusCode, e.message, { error: e.statusCode === 413 ? 'BODY_TOO_LARGE' : 'INVALID_JSON' }); throw e; }` — global error handler của router bắt phần còn lại → 500.
- `req.destroy()` khi oversize (ngừng đọc — chống tiêu tốn băng thông). Tradeoff: client nhận được response trước khi destroy hoàn tất — xử lý: respond rồi destroy (writeHead trước).
- Body rỗng → `{}` (giữ hành vi — `start` route sẽ fail validation thay vì crash).
- Không check Content-Type (JSON.parse là nguồn chân lý — nhận `application/json` lẫn `text/plain`; tradeoff: chấp nhận request thiếu header, đổi lại không từ chối oan).

---

## 8. Config fail-fast (T-03, C-2/C-3/C-4, S-9, US-CFG-1)

### 8.1 validateEnv() — tách KHỎI getEnv

```ts
// config.ts (thêm, KHÔNG gọi trong getEnv)
export interface EnvProblem { key: string; message: string }
export function validateEnv(env: LoadTestEnv, opts?: { production?: boolean }): EnvProblem[]
```
- Gọi tại **duy nhất `server.ts`** sau `getEnv()`: `const problems = validateEnv(env, { production: process.env.NODE_ENV === 'production' }); if (problems.length) { problems.forEach(p => ltLog.error(`[env] ${p.key}: ${p.message}`)); process.exit(1); }`.
- **BẮT BUỘC tách**: `worker.ts:11` gọi `getEnv()` — validate trong getEnv làm worker fail oan (worker không cần DB/OTP). Đây là lệch nhẹ so với wording PRD C-3 ("getEnv() có validateEnv()") — xem §10.6.

### 8.2 Danh sách key (required / điều kiện)

| Key | Mặc định | Validate |
|---|---|---|
| `LOADTEST_PORT` | 3401 | int 1-65535 |
| `LOADTEST_DATABASE_URL` | **placeholder `postgresql://USER:PASS@HOST:PORT/DB`** (xoá `appuser:secret` — C-2, `config.ts:104` + `init.ts:27` + `.env.example:24`) | bắt buộc khi `dbRequired`; prefix `postgresql://`/`postgres://`; KHÔNG chứa pattern placeholder (`/\/\/user:/i`, `appuser`, `:secret@`) → error |
| `LOADTEST_DB_REQUIRED` | **true** (Q-2) | parseBool; `false` → cảnh báo to "DB KHÔNG bắt buộc — run sẽ không ghi history" |
| `LOADTEST_OTP_SECRET` | '' | rỗng → error khi production (register fail E1 — `coordinator.ts:159-161`); warn khi dev |
| `LOADTEST_AUTH_SECRET` | '' (fallback file/random — `auth.ts:73-89`) | rỗng → error khi production (auto-generate chỉ cho dev); dev → warn |
| `LOADTEST_REDIS_URL` | `redis://localhost:6379` | prefix `redis://`/`rediss://`; sai → error |
| `LOADTEST_ALLOWLIST` | `[http://localhost:3000]` (`config.ts:82-85`) | **production: phải set, không được là default** (SEC-7) |
| `LOADTEST_CORS_ORIGIN` | `http://localhost:5173` | production: bắt buộc set (SEC-2) |
| `LOADTEST_MAX_TARGET/MAX_DURATION_MIN/MAX_REGISTER_RAMP/MAX_SOCKETS_PER_WORKER/MAX_PENDING_OUTBOX` | giữ | > 0, finite |

- **Định dạng lỗi**: danh sách đầy đủ 1 lần (không dừng ở lỗi đầu) — dev sửa 1 lần, không lặp.
- **C-4 (log nguồn env)**: `getEnv` thu thập `sources: Record<key, 'process'|'file'|'override'>` (rẻ, ~10 dòng); `server.ts` in khi `LOADTEST_DEBUG=1`. Không đổi merge thứ tự (process.env → file → overrides — `config.ts:70-73`).

### 8.3 newRunId() seed fix (S-9, `config.ts:219-225`)

```ts
const pidPart = (process.pid % 46656).toString(36).padStart(3, '0');  // base36 3 ký tự
let runSeq = 0;
export function newRunId(): string {
  runSeq = (runSeq + 1) % 1296;
  const ts = Date.now().toString(36).slice(-6);
  return `lt${ts}${pidPart}${runSeq.toString(36).padStart(2, '0')}`;  // ví dụ: ltm4k2zabc01
}
```
- **Vì sao**: runSeq reset 0 mỗi restart (`config.ts:219`) → 2 run cùng ms sau restart trùng id. Thêm pidPart → collision cần *cùng ms + cùng pid mod 46656 + cùng counter* — không thực tế.
- **Format đổi** (dài hơn 2 ký tự) — kiểm tra consumer: `config.test.ts:83` chỉ match `/^lt/`; `runIdFromPath` (`api-server.ts:447-450`) parse generic 1 segment; frontend chỉ hiển thị chuỗi. An toàn. Test T-03: gọi 2 lần sau khi "restart" (module reload) → khác nhau.

### 8.4 `.env.example` (loadtest) cập nhật

Thêm: `LOADTEST_DB_REQUIRED=true`, `LOADTEST_ALLOW_REGISTER=false`, `LOADTEST_CORS_ORIGIN=http://localhost:5173`, `LOADTEST_AUTH_SECRET=` (comment), `LOADTEST_RATE_LIMIT_*`, `LOADTEST_SHUTDOWN_TIMEOUT_MS=10000`, `LOADTEST_TRUST_PROXY=0`; sửa `LOADTEST_DATABASE_URL` → placeholder.

---

## 9. Risk register & test-breakage matrix

| # | Rủi ro | Mức | Ứng phó | Task |
|---|---|---|---|---|
| B-1 | **QueryResult đổi signature ~20 method** → `store.test.ts` + `api-server.test.ts` call site vỡ | High | Cập nhật cơ học cùng T-05 (thêm vào scope — §10.3); `first()` helper giữ ergonomics | T-05 |
| B-2 | **Register gate default false** → test register kỳ vọng 200 ĐỎ (T-06 → T-11) | High | PLAN đã chốt: set `LOADTEST_ALLOW_REGISTER=true` trong env override `beforeAll` của `api-server.test.ts:44-49` | T-06 |
| B-3 | **Rate-limit làm fail test/E2E** (nhiều request cùng IP) | Medium | `LOADTEST_RATE_LIMIT_DISABLED=1` trong test env; GET polling không giới hạn; suite hiện tại chỉ ~3 fail < 5 | T-06 |
| B-4 | **Migration đụng DB cũ có data** | Medium | 001 = IF NOT EXISTS no-op + skip version ≤ applied; `pg_advisory_lock`; rollback code = revert commit (PLAN §7) | T-04 |
| B-5 | **flushTicks giữ batch khi fail** → memory tăng nếu DB chết lâu | Low | Cận `MAX_PENDING_TICKS * 2`, drop batch cũ nhất + đếm fail | T-05 |
| B-6 | **Down migration drop bảng** (G-8) | Accepted | Ngữ nghĩa rollback; chỉ CLI thủ công; backup `pg_dump` document (T-12) | T-04 |
| B-7 | **logger ring buffer format đổi** (entry có meta) — dashboard /logs | Low | `msg` giữ text cũ; field mới optional — UI không đổi | T-07 |
| B-8 | **CORS hẹp phá Vite proxy** (R-7) | Medium | Default `http://localhost:5173`; test dev + prod | T-06 |
| B-9 | **Shim socket-farm.ts/coordinator.ts** — dead export kéo dài | Low | Ghi rõ v1.1; review G-6 xác nhận không đổi hành vi | T-06 |

---

## 10. Open conflicts với PLAN / cần council chốt

| # | Vấn đề | PLAN/PRD nói | Đề xuất | Lý do |
|---|---|---|---|---|
| 10.1 | **`http.ts` trùng tên** — PLAN T-06: "readBody/cors/rateLimit → http.ts helpers"; `http.ts` hiện là **HTTP client outbound** (`requestJson` — `http.ts:53-125`) | gộp vào http.ts | **Tách `http-server.ts`** (inbound) + giữ http.ts (outbound) | Trộn 2 chiều HTTP vào 1 file phá tính rõ ràng; zero thêm dependency |
| 10.2 | **Rate-limit số liệu** — PRD §5.1 (approved): login/register 5 fail/60s, /start 1/10s vs ARCHITECTURE §5: 10 req/min + 30 req/min | PRD thắng | Theo PRD; bucket write 30/min mặc định OFF | PRD là tài liệu approved cấp cao hơn |
| 10.3 | **T-05 phá test không được liệt kê** — QueryResult đổi signature đụng `store.test.ts` + direct store call trong `api-server.test.ts` | PLAN chỉ liệt kê api-server.test.ts update cho register gate (T-06) | **Thêm vào T-05**: "cập nhật call site store trong store.test.ts + api-server.test.ts (mechanical)" | Nếu không, T-05 không pass G-1 |
| 10.4 | **Định nghĩa "fail" của fail-window** — 5 fail/60s: đếm status nào? | PRD không định nghĩa | Mọi 4xx từ login/register = 1 fail; success → reset window | Chống cả brute-force lẫn spam; test được |
| 10.5 | **`db:down` của 001** — drop 6 bảng + xoá version | G-8: "down → drop bảng bậc 1 + schema_version lùi 0" | Drop theo thứ tự ngược FK (log_events → ... → admin_users); giữ bảng schema_version | Runner cần bảng; "version 0" = trống |
| 10.6 | **validateEnv trong getEnv vs worker** — PRD C-3 wording | "getEnv() có validateEnv()" | validateEnv gọi ở server.ts entry duy nhất, KHÔNG trong getEnv | `worker.ts:11` gọi getEnv trong child process — validate trong getEnv làm worker fail oan (thiếu OTP/DB); config.test.ts cũng phụ thuộc getEnv permissive |
| 10.7 | **Entry point / thư mục src/** — ARCHITECTURE §3.1 đề xuất `loadtest/src/{main,config,domain,...}` + bootstrap | PLAN T-06 giới hạn "tách module giảm god class, api-server < 400" | **Giữ layout phẳng hiện tại** (thêm file mới cạnh nhau), không tạo `src/` | Diff review được, test import không vỡ; src/ là v1.1 (đồng ý với Q-5 mở của ARCHITECTURE — chưa chốt, để v1.1) |
| 10.8 | **`GET /metrics` ngoài prefix** | PLAN finding #11: "/metrics hoặc /api/loadtest/tool-metrics" | Chọn `/metrics` (chuẩn Prometheus scrape) | Không đụng `/api/loadtest/metrics` tick-history; public như health |

---

## Phụ lục A — File inventory

**MỚI**: `loadtest/http-server.ts`, `loadtest/api-mappers.ts`, `loadtest/guards.ts`, `loadtest/rate-limit.ts`, `loadtest/routes/{auth,run,history,settings}.ts`, `loadtest/gateway-observer.ts`, `loadtest/run-finalizer.ts`, `loadtest/virtual-user.ts`, `loadtest/worker-runtime.ts`, `loadtest/tool-metrics.ts`, `loadtest/logger.ts`, `loadtest/health.ts`, `loadtest/db/migrate.ts`, `loadtest/db/migrations/001_init.sql`, `loadtest/db/result.ts`, `loadtest/db/int.ts`.

**SỬA (giữ export cũ)**: `api-server.ts` (< 250), `coordinator.ts` (~380), `socket-farm.ts` (shim), `util.ts` (shim re-export logger), `config.ts` (validateEnv + newRunId + placeholder), `server.ts` (validateEnv + shutdown), `db/store.ts` (QueryResult + int boundary + ensureSchema wrapper), `db/writer.ts` (flushTicks retry + toEpochMs + dbWriteFail), `db/init.ts` (runner), `worker-farm.ts` (workerRestarts counter), `auth-factory.ts` (mtimeMs note), `package.json` (4 db scripts), `loadtest/.env.example`.

**KHÔNG đổi**: `types.ts`, `coordinator-state.ts`, `metrics.ts`, `report.ts`, `rest-actions.ts`, `http.ts`, `auth.ts`, `db/password.ts`, `db/schema.sql` (giữ làm baseline reference), `worker.ts`, `cleanup.ts`.

---

## Cross-refutation by Backend Architect (2026-08-04)

> Design council round 2 — adversarial review of `DESIGN-prod-refactor-security.md` and `DESIGN-prod-refactor-ui.md`. All claims verified against code at HEAD (8c41ad8). Verdicts: CONFIRMED (claim holds), REFUTED (claim does not hold), PLAUSIBLE (mechanism correct but impact overstated / understated).

### Findings vs Security design

| # | Sev | Claim | Verdict | Code evidence | Concrete fix |
|---|---|---|---|---|---|
| S-1 | Major | TH-9 path traversal via `runId` — `%2F` decode passes `isRunPath` and reaches `fs.readFileSync` in `POST /cleanup` | **REFUTED** (mechanism conflates two routes) | `runIdFromPath`'s `decodeURIComponent` (`api-server.ts:447-450`) feeds **only SQL routes** (`/runs/{id}` metrics/logs/detail/DELETE — `api-server.ts:345-375`; parameterized SQL in `store.ts:338-375`). The cleanup route uses `body.runId` **directly, no decode** (`api-server.ts:289`), and only reads the file when `listPools(dataDir).find(p2 => p2.runId === runId)` matches exactly (`api-server.ts:293`) — pool runIds are server-generated `lt…` (`newRunId`, `config.ts`), never attacker-controlled. `%2F` stays literal percent chars → `path.join(dataDir, 'accounts-..%2F..%2F.json')` is a literal filename, not a traversal. | Keep the runId format check as cheap defense-in-depth, but downgrade the threat. The real related bug is `decodeURIComponent` throwing on malformed escapes → 500 (see SB-2). |
| S-2 | Minor | Math.random() OTP is a real weakness | **CONFIRMED** (hygiene only; premise wrong) | `seedOtp`/`seedSmsOtp` use `Math.floor(100000 + Math.random()*900000)` (`auth-factory.ts:71,85`). Gateway verifies with `inputHash !== parsed.otpHash` — **plain string comparison, NOT `crypto.timingSafeEqual`** (`gateway-auth-service/.../auth-otp.service.ts:316`), capped at 5 attempts (`:303-309`). OTP is never exposed to an attacker (HMAC'd in Redis, sent only in the verify-email request), so the PRNG state is unobservable → not practically exploitable for a local tool. Gateway itself already uses `crypto.randomInt` (`:119,231`). | Swap to `crypto.randomInt(100000, 1000000)` — 3 lines, consistent with gateway. Not a blocker. |
| S-3 | Minor | Rate-limit 5 fail/60s/IP compatible with existing auth flow | **CONFIRMED** (no implementation conflict) | `SimpleRateLimiter` (`auth-factory.ts:133-150`) is a pacing limiter (`acquire()` sleeps), used only in `provisionAccounts` ramp (`:179,231`) — not the admin API, not a 429 limiter. New `rate-limit.ts` is separate. | Caveat: the design's "whole API token bucket 120/10s/IP" must exempt `GET /status` + `GET /metrics` (dashboard polls 1s — `app-shell.tsx:241-253`, `loadtest.store.ts:165-192`) or the dashboard breaks. My design already exempts all GET polling — align on that. |
| S-4 | Minor | CORS echo-origin + register-gate sound; won't break dev proxy/tests | **CONFIRMED** | Vite proxy `changeOrigin:true` (`vite.config.ts:19`) forwards `Origin: http://localhost:5173` on POST → matches default allowlist. Same-origin GETs carry no Origin → no ACAO → browser unaffected. Register gate default-false breaks `api-server.test.ts:89-97` (expects 200; `beforeAll` env at `:44-49` has no `LOADTEST_ALLOW_REGISTER`) → must add env override in T-06 (plan already fixed). | Gate before body validation (403) is fine; keep the test env override. |
| S-5 | Minor | Threat model omission: localhost CSRF / DNS rebinding | **CONFIRMED** (omission) | Tool binds `127.0.0.1` (`config.ts:91`). CORS blocks response *read*, not request *execution* — the design itself states "attacker curl không bị ảnh hưởng". A malicious browser page can still POST to the tool. Practical impact limited (auth-gated writes need Bearer; register 403 by default; login brute-force rate-limited), but the model never names it. | Add to THREAT-MODEL; optional cheap control: require `Sec-Fetch-Site` or a custom header on state-changing routes. |
| S-6 | Minor | Security CSP `connect-src 'self' ws: wss:` is sufficient | **REFUTED** (breaks fonts preconnect) | `<link rel="preconnect">` to `fonts.googleapis.com`/`fonts.gstatic.com` (`index.html:10-11`) is governed by `connect-src` in Chrome — the security design's CSP omits both origins, so the preconnect is blocked. UI design's CSP correctly adds both. | Adopt UI's `connect-src 'self' ws: wss: https://fonts.googleapis.com https://fonts.gstatic.com`. |
| S-7 | Major | CSP: nginx `add_header` *and* meta (belt-and-suspenders) vs UI "meta only" | **CONFIRMED** (cross-design conflict) | Both applied → intersection (strictest per directive). `frame-ancestors` only works in a header, so meta-only drops clickjacking defense; header-only drops the CSP from any static host without nginx. | Council must pick one source. If meta-only (UI), accept `frame-ancestors` loss and document in THREAT-MODEL; if header-only (Security), drop the meta plugin. |

### Findings vs UI design

| # | Sev | Claim | Verdict | Code evidence | Concrete fix |
|---|---|---|---|---|---|
| U-1 | Major | CSP via Vite build plugin (`transformIndexHtml` + `apply:'build'`) works; inline styles required | **CONFIRMED** | `index.html` has no inline script/style — only external module `<script src="/src/main.tsx">` (`index.html:19`) → `script-src 'self'` safe. `@vitejs/plugin-react` preamble is dev-only (`apply:'serve'`), so build output has no inline script. Inline-style claim verified: React `style` props render as attributes requiring `style-src 'unsafe-inline'`; recharts/framer-motion/sonner (`package.json:33,40,42`) all use inline styles. Report download uses `URL.createObjectURL` on `<a download>` (`loadtest-api.ts:170-177`) — not an `<img>`, so no `blob:` needed in `img-src`. | Deploy caveat: if prod gateway is a separate origin, `connect-src 'self'` blocks REST/socket to it — must add the origin (design's deploy note covers this). |
| U-2 | Minor | ErrorBoundary Layer-1 "Về trang chủ" button is functional | **REFUTED** (no-op without reset) | Layer-1 has **no `resetKey`** (explicitly, to avoid crash-loop). `hasError` stays `true` → after `navigate(/chat)` the boundary still renders the fallback (it wraps `<Routes>`), so the button does nothing; only reload works. | Add a safe reset: e.g., reset on `location.key` change (with a 1-frame guard), or drop the button and keep reload-only. |
| U-3 | Minor | Session notice (30-min) matches `expiresAt` computation | **CONFIRMED** (no bug) | `expiresAt` is an absolute epoch from login (`loadtest-auth-storage.ts:25`, `loadtest-auth.store.ts:42-47`); `/auth/me` does not refresh it (`api-server.ts:429-436` returns user only). `shouldWarnSession(expiresAt, now)` = `expiresAt - now` is correct; 60s tick is fine. | Static "12 giờ" text drifts if `SESSION_TTL_MS` changes (`auth.ts:15`) — minor doc nit. |
| U-4 | Minor | `vitest.workspace.ts` compatible with `loadtest/vitest.config.ts` | **CONFIRMED** (compatible; one gotcha) | loadtest config `root` resolves to `chat-app/` (verified `new URL('..', import.meta.url)`), include `loadtest/__tests__/**/*.test.ts` node env; frontend project `src/**/*.test.{ts,tsx}` jsdom — no overlap. loadtest tests import vitest explicitly (`api-server.test.ts:6`) and skip without DB (`:32`). `loadtest:test` uses `--config` → unaffected by workspace. | Gotcha: `--coverage` in workspace mode also collects coverage for the loadtest project (no coverage config → defaults → slow/noisy). Scope coverage to the frontend project only. |

### Self-critique — CONFIRMED weaknesses in my own design (surfaced by this review)

| # | Sev | Finding | Action |
|---|---|---|---|
| SB-1 | Minor | No runId format validation on the cleanup route before `poolPath` → `fs.readFileSync` (`api-server.ts:289-296`). Not exploitable (gated by `listPools` exact match), but the security design's `/^[a-z0-9-]{1,64}$/i` check is cheap hardening. | Adopt into `http-server.ts`/`guards.ts` (§1.1). |
| SB-2 | Minor | §1.1 moves `runIdFromPath` as-is; `decodeURIComponent` throws on malformed escapes (`%E0%A4%A`) → 500 via the catch-all handler. | Add a format check (`/^lt[a-z0-9]{1,16}$/i` or similar) before decoding. |
| SB-3 | Minor | §7.2 `readBody` returns `{}` for non-object JSON (`[]`, `"str"`, `42`) — downstream `Number()`/validateRunRequest catches it, but the security design's explicit object check is cleaner. | Add a "parsed value must be a plain object" check → 400. |
| SB-4 | Minor | §2.2 `/start` bucket "capacity 1, refill 1/10s" — a dashboard double-click on Start returns 429; acceptable (confirm dialog), but E2E must set `LOADTEST_RATE_LIMIT_DISABLED=1` (already in risk register B-3). | No change; keep the risk-register note. |

**Bottom line**: The security design's headline "real vulnerability" (TH-9 path traversal, S-1) is REFUTED — the `%2F`-decode mechanism never reaches the filesystem; the filesystem read is gated by an exact-match against server-generated pool ids. The Math.random OTP finding (S-2) is real hygiene but not a vulnerability (premise about `timingSafeEqual` is wrong). The UI design's CSP approach (U-1) is CONFIRMED working and the inline-style claim holds. The two design docs conflict on CSP source (S-7) — resolve at council. My own design has no Critical/Major flaw; the identified items are optional hardening (SB-1..SB-4).
