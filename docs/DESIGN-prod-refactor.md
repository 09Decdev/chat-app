# DESIGN — Prod-refactor (FINAL, hợp nhất backend + security)

**Status**: ✅ FINAL — design council synthesis (2026-08-04). Đây là tài liệu **duy nhất** để Build (Phase 3) thực thi cho backend + security.
**Nguồn chuẩn**: `docs/PRD-prod-refactor.md` (APPROVED — GATE 1), `docs/PLAN-prod-refactor.md` (APPROVED — GATE 1), `docs/DESIGN-prod-refactor-backend.md` (hợp nhất), `docs/DESIGN-prod-refactor-security.md` (hợp nhất), `docs/DESIGN-prod-refactor-ui.md` (chỉ phần backend liên quan). Mọi conflict đã chốt trong §10 Decisions log — **không còn open question**.
**Ràng buộc cứng**: zero-dep runtime (`node:http`, `node:fs`, `node:path`, `pg`, `ws`, `socket.io-client`, `ioredis`); không đổi contract gateway; không đổi UI dashboard; không đổi route path; KHÔNG rewrite (refactor có rào chắn).

---

## 1. Module layout (FINAL)

Nguyên tắc: **tách file trước, tách logic sau** (mỗi bước pure move, test cũ xanh từng bước); **compat shim** giữ mọi export cũ để `worker.ts`, `api-server.test.ts`, `store.test.ts`, `socket-farm.test.ts` không vỡ import path.

### 1.1 Injectable module (mới)

| File | Owner | Interface (public) | Task |
|---|---|---|---|
| `loadtest/http-server.ts` | Backend | `readBody(req, maxBytes=1MB): Promise<Record<string,unknown>>` (BodyError 400/413 + plain-object check SB-3 + `req.destroy()` khi oversize), `applyCors(req,res,origins)`, `parseOrigins(raw, def)`, `sendJson/okJson/failJson`, `makeRequestId()`, `isRunPath`, `runIdFromPath` (format-check trước decode — SB-2), `RouteCtx`, `BodyError` | T-06 |
| `loadtest/api-mappers.ts` | Backend | `toRunSummary`, `toRunDetail`, `toMetricTick` (thuần) | T-06 |
| `loadtest/guards.ts` | Backend | `requireAuth(req, authSecret)` (giữ logic HMAC — không đổi), `registerGate(env)`, `rateLimitWrap(limiter, key)` | T-06 |
| `loadtest/rate-limit.ts` | Backend | `TokenBucket`, `FailWindow`, `RateLimiters` (§2) | T-06 |
| `loadtest/tool-metrics.ts` | Backend | `createToolMetrics()`, singleton `toolMetrics` (§5.1) | T-05 (tạo) → T-06/T-07 (mở rộng) |
| `loadtest/logger.ts` | Realtime | `log(level,msg,fields?)`, `ltLog`, `logHistory`, `subscribeLog`, `setVerbose`, `createJsonlSink` + `redactSensitiveFields` (B-1 guard) (§5.2) | T-07 |
| `loadtest/health.ts` | Realtime | `buildHealth(deps)`, `createHealthProbe` (§5.3) | T-07 |
| `loadtest/gateway-observer.ts` | Backend | `GatewayObserver` (poll queue-count + scrape `/metrics`, AbortSignal.timeout(4000), bỏ qua lỗi 401 — giữ hành vi) | T-06 |
| `loadtest/run-finalizer.ts` | Backend | `finalizeRun(deps)` — chuỗi kết thúc run, **`await writeRunFinish`** (B-2 fix, §6) | T-06 |
| `loadtest/virtual-user.ts` | Realtime | `VirtualUser`, `pickProfile`, `PendingMsg`, hằng pacing | T-06 |
| `loadtest/worker-runtime.ts` | Realtime | `WorkerRuntime` (scheduler 100ms, counters, histograms, emitTick, queryUsers) | T-06 |
| `loadtest/routes/{auth,run,history,settings}.ts` | Backend | Handler nhận `(ctx: RouteCtx, req, res)` — **KHÔNG tự gọi guard** (guard ở route table, B-3) | T-06 |

### 1.2 Route table + guard ở tầng đăng ký (B-3 — FIX)

`api-server.ts` còn là **router + composition root** (target < 250 dòng). Guard **không gọi trong thân handler**; đăng ký **tại route table**:

```ts
type Route = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  pattern: string;                 // regex path param cho /runs/{id}
  auth: boolean;                   // true → dispatcher chạy requireAuth trước
  rate?: 'login' | 'register' | 'start' | 'write' | 'none';
  handler: (ctx: RouteCtx, req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
};
const routes: Route[] = [
  { method: 'GET',  pattern: '/api/loadtest/health',        auth: false, rate: 'none', handler: h.health },
  { method: 'POST', pattern: '/api/loadtest/auth/login',    auth: false, rate: 'login',    handler: h.login },
  { method: 'POST', pattern: '/api/loadtest/auth/register', auth: false, rate: 'register', handler: h.register }, // registerGate chạy trước body validation
  { method: 'POST', pattern: '/api/loadtest/auth/logout',   auth: true,  handler: h.logout },
  { method: 'GET',  pattern: '/api/loadtest/auth/me',       auth: true,  handler: h.me },
  { method: 'POST', pattern: '/api/loadtest/start',         auth: true,  rate: 'start',  handler: h.start },
  { method: 'POST', pattern: '/api/loadtest/stop',          auth: true,  handler: h.stop },
  { method: 'POST', pattern: '/api/loadtest/kill',          auth: true,  handler: h.kill },
  { method: 'POST', pattern: '/api/loadtest/pause',         auth: true,  handler: h.pause },
  { method: 'POST', pattern: '/api/loadtest/resume',        auth: true,  handler: h.resume },
  { method: 'GET',  pattern: '/api/loadtest/status',        auth: true,  handler: h.status },
  { method: 'GET',  pattern: '/api/loadtest/metrics',       auth: true,  handler: h.metrics },   // tick-history (KHÔNG đổi tên)
  { method: 'GET',  pattern: '/api/loadtest/users',         auth: true,  handler: h.users },
  { method: 'GET',  pattern: '/api/loadtest/errors',        auth: true,  handler: h.errors },
  { method: 'GET',  pattern: '/api/loadtest/logs',          auth: true,  handler: h.logs },
  { method: 'GET',  pattern: '/api/loadtest/report/export', auth: true,  handler: h.reportExport },
  { method: 'GET',  pattern: '/api/loadtest/config',        auth: true,  handler: h.config },
  { method: 'GET',  pattern: '/api/loadtest/allowlist',     auth: true,  handler: h.allowlistGet },
  { method: 'POST', pattern: '/api/loadtest/allowlist',     auth: true,  rate: 'write', handler: h.allowlistPost },
  { method: 'GET',  pattern: '/api/loadtest/pools',         auth: true,  handler: h.pools },
  { method: 'POST', pattern: '/api/loadtest/cleanup',       auth: true,  rate: 'write', handler: h.cleanup },
  { method: 'GET',  pattern: '/api/loadtest/runs',          auth: true,  handler: h.runsList },
  { method: 'GET',  pattern: '/api/loadtest/runs/:id',      auth: true,  handler: h.runDetail },
  { method: 'GET',  pattern: '/api/loadtest/runs/:id/metrics', auth: true, handler: h.runMetrics },
  { method: 'GET',  pattern: '/api/loadtest/runs/:id/logs', auth: true,  handler: h.runLogs },
  { method: 'DELETE',pattern: '/api/loadtest/runs/:id',     auth: true,  rate: 'write', handler: h.runDelete },
];
// GET /metrics (tool-metrics, Prometheus) — ngoài prefix loadtest, public như health
```

**Dispatcher** (`handle()`): parse URL → tìm route → nếu `auth` → `requireAuth` (401 nếu fail) → nếu `rate` → `rateLimitWrap` (429 nếu chặn) → gọi handler → catch → envelope 500 generic + `requestId` + `toolMetrics.inc('apiErrors')`. **Cả 3 guard gọi ở đây, không gọi trong handler.** Đây là single gate đúng nghĩa (thay `api-server.ts:145-146`).

**Contract test bắt buộc (T-11)**: vòng qua mọi route có `auth: true` → gọi không token → kỳ vọng 401; `auth:false` (health, login, register) → không 401.

### 1.3 Coordinator + socket-farm (bounded tách)

- `coordinator.ts` (SỬA, ~380): giữ class `LoadTestCoordinator` + constructor signature; `finishRun` **bỏ `void`** → `await this.dbWriter.writeRunFinish(...)` (B-2, §6); `aggregateTick` giữ nguyên (đọc ~15 state field/s).
- `socket-farm.ts` (SỬA) → **shim re-export**: `export { VirtualUser, pickProfile } from './virtual-user'; export { WorkerRuntime } from './worker-runtime';` (giữ `worker.ts:6` + `socket-farm.test.ts:6` không đổi). Dead code `final-tick` giữ nguyên wave này (xoá là đổi hành vi IPC — PLAN T-07).
- `util.ts` (SỬA) → **shim re-export logger** (`export { ltLog, logHistory, subscribeLog, setVerbose, log } from './logger'`) — ~15 import site cũ không đổi.

### 1.4 File SỬA (giữ export cũ)

`api-server.ts` (< 250, router), `coordinator.ts` (~380), `socket-farm.ts` (shim), `util.ts` (shim), `config.ts` (validateEnv + newRunId + placeholder), `server.ts` (validateEnv + shutdown), `db/store.ts` (QueryResult + int boundary + ensureSchema wrapper), `db/writer.ts` (flushTicks retry + toEpochMs + dbWriteFail + finalize barrier), `db/init.ts` (runner), `worker-farm.ts` (workerRestarts counter), `auth-factory.ts` (crypto.randomInt + mtimeMs note), `package.json` (4 db scripts), `loadtest/.env.example`.

**KHÔNG đổi**: `types.ts`, `coordinator-state.ts`, `metrics.ts`, `report.ts`, `rest-actions.ts`, `http.ts` (outbound client — giữ tên, tránh trùng `http-server.ts`), `auth.ts`, `db/password.ts`, `db/schema.sql` (baseline reference), `worker.ts`, `cleanup.ts`.

---

## 2. Rate-limit design (T-06)

**KHÔNG dùng `SimpleRateLimiter`** (`auth-factory.ts:133-150`) — đó là pacing limiter (`acquire()` ngủ), không trả 429, không theo IP. Module mới `loadtest/rate-limit.ts`:

```ts
class TokenBucket {               // zero-dep, inject clock
  constructor(private capacity: number, private refillPerMs: number, private now: () => number = Date.now)
  take(): boolean
}
class FailWindow {                // đếm FAILURE (không phải tổng request) trong cửa sổ
  constructor(private limit: number, private windowMs: number, private now: () => number = Date.now)
  isBlocked(): boolean
  recordFailure(): { blocked: boolean; retryAfterSec: number }
  clear(): void                   // gọi khi request thành công
}
class RateLimiters {
  check(path, ip): { allowed: boolean; retryAfterSec?: number; kind?: 'FAIL' | 'BUCKET' }
  recordFailure(kind: 'login' | 'register', ip): void
  sweep(now): void
}
```

| Route | Limiter | Giá trị | Hành vi vượt |
|---|---|---|---|
| `POST /auth/login` | FailWindow/IP | 5 **fail**/60s | 429 `{ success:false, statusCode:429, error:'RATE_LIMITED', message:'Quá nhiều yêu cầu — thử lại sau Ns', retryAfterSec, timestamp }` + `Retry-After: N` + `X-RateLimit-Limit/Remaining/Reset` |
| `POST /auth/register` | FailWindow/IP | 5 **fail**/60s | 429 (register gate 403 chạy TRƯỚC; 403 cũng tính 1 fail) |
| `POST /start` | TokenBucket/IP | capacity 1, refill 1/10s | 429 như trên |
| `/allowlist` POST, `/cleanup`, `DELETE /runs/{id}` | TokenBucket/IP | 30 req/min | 429 — **mặc định OFF** (`LOADTEST_RATE_LIMIT_WRITE_BUCKET=1` mới bật), không phá test/E2E |
| GET polling (`/status`,`/metrics`,`/users`,`/errors`,`/logs`) | — | KHÔNG giới hạn | — (dashboard poll 1s — giới hạn sẽ vỡ UI) |
| `/health`, `/metrics` (tool) | — | KHÔNG giới hạn | — |

**Định nghĩa "fail" (chốt — B-6)**: mọi response **4xx** của login/register = 1 fail (409 duplicate cũng tính — chặn cả register-spam); **success (2xx) → `clear()`** (window reset). Login đúng trong cửa sổ vẫn hoạt động (US-SEC-4).

**Cơ chế ghi fail (để ordering không quan trọng)**: ghi fail **ở dispatcher sau khi handler trả response** — dispatcher biết route có `rate: 'login'|'register'`, status response 4xx → `limiter.recordFailure(kind, ip)`; 2xx → `limiter.clear(kind, ip)`. Hệ quả: gate 403 trả trước (không tốn token bucket) nhưng 403 vẫn bị đếm là fail (đúng F-7 — chặn register-spam tới 429).

**IP key**: `req.socket.remoteAddress` (tool bind `127.0.0.1`). KHÔNG tin `X-Forwarded-For` trừ `LOADTEST_TRUST_PROXY=1` (chống spoof header). Document khi sau reverse-proxy.

**Cleanup**: lazy sweep — mỗi `check()` nếu `lastSeen.size > 2048` → `sweep()` xoá entry idle > 10 phút (không setInterval; test bằng fake clock). `sweep` export riêng.

**Env (chốt — B-6)**: `LOADTEST_RATE_LIMIT_DISABLED=1` (test/CI escape hatch — PLAN R-6), `LOADTEST_RATE_LIMIT_LOGIN_FAILS`, `LOADTEST_RATE_LIMIT_WINDOW_MS`, `LOADTEST_RATE_LIMIT_START_MS`, `LOADTEST_RATE_LIMIT_WRITE_BUCKET`, `LOADTEST_TRUST_PROXY`.

**Rủi ro phá test**: suite hiện tại ~3 fail < 5 → an toàn; test 429 riêng set `LOADTEST_RATE_LIMIT_DISABLED` trong env override riêng của test đó.

---

## 3. Migration runner design (T-04)

### 3.1 File & naming
- `loadtest/db/migrations/NNN_name.sql` — `NNN` 3 chữ số, sort theo số. `001_init.sql` = **baseline** (DDL y hệt `schema.sql:16-148`, `CREATE TABLE IF NOT EXISTS`), có marker `-- startup-safe` (B-5). Header mẫu ghi rõ quy ước: **"mỗi file = DDL thuần, không PL/pgSQL có `;` nội bộ"; migration sau 001 phải `ADD COLUMN IF NOT EXISTS` + có DOWN** (R-4). `schema.sql` cũ giữ nguyên (rollback code an toàn — PLAN §7).

### 3.2 Parse up/down (zero-dep, ~30 dòng)
Split theo dòng, tìm marker `^--\s*====\s*(UP|DOWN)\s*====` (case-insensitive). **Fail-fast**: thiếu marker hoặc section rỗng → throw (PLAN R-1). Multiple statements chạy trong **1 `client.query(sql)`** (simple query protocol — không param).

### 3.3 Transaction + version tracking
- Giữ bảng `schema_version` (PRD §5.5); `applied = SELECT COALESCE(MAX(version),0) FROM schema_version`.
- Runner tự `CREATE TABLE IF NOT EXISTS schema_version` trước (R-4 — DB trống/thiếu bảng).
- Mỗi migration chạy 1 `pg.Client` riêng trong transaction: `up` = `BEGIN` → UP section → `INSERT INTO schema_version (version) VALUES (NNN) ON CONFLICT DO NOTHING` → `COMMIT`; lỗi → `ROLLBACK` + throw. `down` (1 bước) = `BEGIN` → DOWN section của version cao nhất → `DELETE FROM schema_version WHERE version=NNN` → `COMMIT`.
- **Idempotent**: chỉ áp dụng file `NNN > applied`; chạy lại `up` = no-op.
- **Concurrency guard**: `SELECT pg_advisory_lock(hashtext('loadtest_migrations'))` đầu `up/down` (2 dòng).

### 3.4 Startup auto-migrate scope (B-5 — FIX)
`runMigrations(client, opts?: { scope?: 'baseline' | 'all' })`:
- **`scope:'baseline'` (startup — `store.ensureSchema()` wrapper)**: chỉ áp dụng 001 nếu `applied < 1`; nếu còn pending migration `> 1` → **fail-fast throw** `"Pending migrations — chạy npm run loadtest:db:up"` (KHÔNG tự chạy migration destructive). `DbWriter.startup()` (`writer.ts:43`) gọi wrapper; `!ok && env.dbRequired → throw` (server exit ≠ 0 — T-05).
- **`scope:'all'` (CLI `up`)**: áp dụng mọi pending.

### 3.5 CLI + integration
```ts
export function loadMigrations(dir?: string): Migration[]
export async function runMigrations(client, dir?, opts?): Promise<{ applied: string[] }>
export async function rollbackOne(client, dir?): Promise<{ rolledBack: string | null }>
export async function migrationStatus(client, dir?): Promise<{ applied: number; pending: string[] }>
// main(): argv[2] ∈ up|down|status|cleanup
```
- CLI: `npx tsx loadtest/db/migrate.ts <cmd>` — tự tạo `pg.Client` từ `LOADTEST_DATABASE_URL` (placeholder → exit 1). `cleanup --older-than 30d`: `DELETE FROM runs WHERE start_at < cutoff AND status <> 'running'` (cascade metric_samples + log_events) + xoá pools/pool_accounts cũ; KHÔNG đụng `admin_users`. Chạy thủ công, không nền (D-9).
- package.json: `loadtest:db:up|down|status|cleanup`.
- `ensureSchema()` KHÔNG xoá — chuyển wrapper giữ tên (store.test.ts:20,35,276 + api-server.test.ts:24,52 không vỡ). `db/init.ts:94-98` bỏ đọc schema.sql, gọi `runMigrations` (giữ `--verify`/`--seed-admin`).
- Down = destructive (drop bảng) — đúng ngữ nghĩa rollback (G-8); `schema_version` giữ lại; "version 0" = bảng trống.

---

## 4. QueryResult contract + redaction rule (T-05, B-1 — FIX)

### 4.1 Contract
```ts
// loadtest/db/result.ts (MỚI)
export type QueryError = { code?: string; message: string; sql?: string; params?: unknown[] };
export type QueryResult<T> =
  | { ok: true; rows: T[] }
  | { ok: false; error: QueryError };
export function first<T>(r: QueryResult<T>): QueryResult<T | null>;  // rows[0] ?? null
```

### 4.2 Core query + retry + REDACTION (B-1)
```ts
// loadtest/db/int.ts (MỚI)
export function isTransient(code): boolean
//   transient: ECONNRESET, ETIMEDOUT, 08001, 08006, 57P01, 57P02, 40001
//   KHÔNG transient: 23505, 23503, 22P02, 42P01... → fail nhanh, KHÔNG retry
export function toEpochMs(x: number | string | null | undefined): number | null  // Math.trunc(Number(x)) — fix float (D-5)
const SENSITIVE_KEY = /(password|secret|token|hash|refresh|otp)/i;
export function redactSql(sql: string): string
//   thay mọi literal '...' chứa keyword nhạy cảm → '[REDACTED]' (vd 'password' VALUES ('...'))
export function redactParams(params: unknown[] | undefined): unknown[] | undefined
//   object param: key khớp SENSITIVE_KEY → '[REDACTED]'; không phải object → giữ nguyên
```

**Quy tắc redaction (chốt — B-1)**:
1. **Write query** (INSERT/UPDATE/DELETE — các method ghi trong §4.3): error object **chỉ chứa `{ code, message }`** — KHÔNG `sql`, KHÔNG `params`. Lý do: `insertPoolAccounts`/`createAdmin` đưa **plaintext password + scrypt hash** vào `params` (`store.ts:473-476, 206-211`); write fail chỉ cần `code` + `runId` để chẩn đoán.
2. **Read query** (SELECT): error object chứa `{ code, message, sql: redactSql(sql), params: redactParams(params) }` — params của SELECT là id/filter, không có secret; vẫn redact phòng hờ.
3. **Logger-level guard (dùng chung B-1 với §5.2)**: `logger.ts` `redactSensitiveFields(fields)` — mọi field tên khớp `/authorization|password|passwordHash|refreshToken|token|otp|secret/i` → `'[REDACTED]'` trước khi emit (JSONL sink + console). KHÔNG log `Authorization` header, token body, `password` ở bất kỳ đâu.

```ts
private async query<T>(sql, params = [], opts?: { write?: boolean }): Promise<QueryResult<T>> {
  if (!this.enabled || !this.pool) return { ok: false, error: { code: 'DB_DISABLED', message: 'DB chưa kết nối' } };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { const res = await this.pool.query(sql, params); return { ok: true, rows: res.rows as T[] }; }
    catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (!isTransient(code)) {
        const base = { code, message: err instanceof Error ? err.message : String(err) };
        return { ok: false, error: opts?.write ? base : { ...base, sql: redactSql(sql), params: redactParams(params) } };
      }
      toolMetrics.inc('dbRetry');
      if (attempt === 1) { await sleep(100); continue; }
    }
  }
  return { ok: false, error: { code: 'RETRY_EXHAUSTED', message: 'query fail 2 lần' } };  // không kèm sql/params
}
```

### 4.3 Callers (phân nhóm)
| Nhóm | Method | Cách đổi |
|---|---|---|
| History đọc (D-6) | `listRuns`, `getRun`, `deleteRun`, `listMetricSamples`, `countMetricSamples`, `listLogEvents`, `listPools` | `QueryResult<T[]>` / `QueryResult<T\|null>`; route: `!ok → fail(503, 'Database lỗi', { error:'DB_UNAVAILABLE' })` (history route sửa trong T-05, không đợi T-06); `countMetricSamples` không bao giờ trả 0 giả |
| Auth đọc | `findAdminByLogin`, `getAdminById`, `createAdmin` | `QueryResult<T\|null>`; route: `!ok → 503`; `rows[0]==null → 409/401` (login/register vẫn 401/409 — không lộ DB fail) |
| Write best-effort | `insertRun`, `finalizeRun`, `markRunsRunningAsError`, `insertMetricSamples`, `insertLogEvent`, `upsertPool`, `insertPoolAccounts`, `updatePoolAccount`, `touchLastLogin` | `QueryResult<void>` (write=true — không sql/params); **DbWriter**: `!ok → toolMetrics.inc('dbWriteFail')` + `ltLog.warn` kèm `{ runId }` + retry ≥ 1 (US-DB-2); KHÔNG throw chết run |

**DbWriter.flushTicks hồi phục hàng đợi** (`writer.ts:107-117`): `!ok` → đưa batch về đầu `pendingTicks` (cận `MAX_PENDING_TICKS*2` — vượt drop batch cũ nhất + `dbWriteFail`); flush timer 30s retry → US-DB-2 "(c) khi DB hồi phục, hàng đợi pending được flush".

### 4.4 BIGINT biên (D-7)
- Xoá `store.ts:19` `pg.types.setTypeParser(20, ...)` (toàn cục).
- BIGINT (OID 20) trả string → parse ở biên qua `toEpochMs()` cho đúng cột int8: `admin_users.created_at/updated_at/last_login_at`, `runs.start_at/end_at/created_at/updated_at`, `pools.created_at`, `pool_accounts.registered_at/last_login_at`, `metric_samples.ts`, `log_events.ts`. Cột `id` SERIAL (int4) + counter INTEGER không chạm.
- An toàn < 2^53 (mọi int8 là epoch ms hoặc counter nhỏ; `countMetricSamples` đã cast `::int`).
- Fix float: `writer.ts:256` `createdAt: toEpochMs(fs.statSync(filePath).mtimeMs)`; `auth-factory.ts:119` `mtimeMs` chỉ hiển thị/sort — giữ, ghi chú.
- `connect()` fail + `dbRequired` → **throw** (`store.ts:132-149`); server.ts bắt → exit ≠ 0 (US-CFG-1, Q-2).

### 4.5 Rủi ro phá test
`store.test.ts` (~20 call site) + `api-server.test.ts` (direct store calls) đọc row trực tiếp → cập nhật cơ học sang `r.ok ? r.rows : ...` (hoặc `first()`). **PLAN NOTE: thêm vào T-05 scope** (xem §10).

---

## 5. tool-metrics / logger / health (T-05/T-07)

### 5.1 tool-metrics.ts (T-05 tạo — T-06/T-07 mở rộng)
```ts
export type ToolCounter = 'dbWriteFail' | 'dbRetry' | 'apiErrors' | 'workerRestarts' | 'runFinished';
export type ToolGauge    = 'coordinator.rssMb' | 'worker.alive';
export interface ToolMetrics {
  inc(name: ToolCounter, by?: number): void;
  setGauge(name: ToolGauge, v: number): void;
  snapshot(): { counters: Record<string, number>; gauges: Record<string, number> };
  toPrometheusText(): string;   // gauge đổi '.' → '_'
}
export function createToolMetrics(): ToolMetrics;   // factory (test)
export const toolMetrics: ToolMetrics;              // singleton (prod)
```
- **Nơi gắn**: `dbWriteFail/dbRetry` — §4 (T-05); `apiErrors` — error handler router (T-06); `workerRestarts` — `worker-farm.ts:89` (T-07); `runFinished` — `run-finalizer.ts` (T-07); `coordinator.rssMb` — `aggregateTick` (T-07); `worker.alive` — `coordinator.ts:336` đã có `farm.alive`.
- **Expose**: `GET /metrics` (Prometheus text/plain) — ngoài prefix loadtest, public như health (chỉ counter, không data nhạy cảm). KHÔNG dùng `/api/loadtest/metrics` (là tick-history — PLAN finding #11).

### 5.2 logger.ts (T-07) — structured JSON, giữ ltLog compat
- `util.ts` → **re-export shim** (`export { ltLog, logHistory, subscribeLog, setVerbose, log } from './logger'`); `logger.ts` KHÔNG import `util.ts` (tránh cycle).
- `LogEntry { ts, level, msg, runId?, workerId?, requestId?, context? }` — `msg` GIỮ text có prefix `[lt]` (ring buffer + dashboard `/logs` compat).
- Console sink: JSON 1 dòng khi `LOADTEST_LOG_JSON=1` (default 0 — dev giữ text; prod bật). PRD §5.3 yêu cầu JSON — bật mặc định production.
- Ring buffer 500 entry **có cấu trúc** (fix lệch 1.2.22); dashboard `/logs` map `{ ts, level, msg }` — msg giữ text cũ → UI không đổi.
- Subscriber DB giữ signature `(level, msg)` — `writer.ts:48` không vỡ; `runId` do writer tự gắn (`currentRunId`).
- JSONL sink + rotation: `dataDir/logs/loadtest-YYYY-MM-DD.jsonl`, max 50MB → suffix `-1` (append). Zero-dep: `fs.createWriteStream({ flags:'a' })`.
- **`redactSensitiveFields(fields)`** — guard dùng chung (B-1): drop/redact field tên khớp `/authorization|password|passwordHash|refreshToken|token|otp|secret/i`; `log()`/`ltLog` luôn chạy qua guard trước khi emit.
- `runId`/`requestId`: coordinator log hot spots (`start`/`finishRun`/E1-E3) truyền `{ runId }`; routes truyền `{ requestId }` (T-06 sinh). Logger stateless.

### 5.3 health.ts (T-07, US-OBS-1)
```ts
export interface HealthDeps {
  store?: { enabled(): boolean; probe(): Promise<boolean> };
  coordinator: { phase(): RunPhase; farmAlive(): number };
  redis?: { configured(): boolean; ping(): Promise<boolean> };
  version: string; startedAt: number;
}
export function buildHealth(deps): Promise<HealthReport>
// { status: 'ok'|'degraded'|'down', db, redis, workers, version, uptimeSec, timestamp }
```
- Logic: `db='down'`/`redis='down'` → `degraded`; có `down` → `down`; else `ok`. **DB down → degraded, không 500, không 'ok' giả**.
- Cached probe TTL 10s (`createHealthProbe`) — không đấm DB mỗi lần gọi.
- Route `GET /api/loadtest/health` → `buildHealth`; thêm `version`/`uptimeSec` (additive — client đọc `status` không vỡ). Docker healthcheck phải chấp nhận `degraded` để container sống (F-5).

---

## 6. Graceful shutdown (T-06, B-2 — FIX)

**Vấn đề (B-2, CONFIRMED)**: `coordinator.ts:497` `void this.dbWriter?.writeRunFinish(...)` là fire-and-forget; `stop(true)` (`coordinator.ts:239`) trả `finishRun`'s promise **trước** khi `finalizeRun` UPDATE xong; `dbWriter.shutdown()` → `store.disconnect()` → `pool.end()` có thể drop finalize đang bay → run row kẹt `status='running'`.

**Fix (chốt — finalize barrier + awaited finalize)**:
1. `run-finalizer.ts` / `finishRun`: **`void this.dbWriter?.writeRunFinish(...)` → `await this.dbWriter?.writeRunFinish(...)`** (chuỗi kết thúc đợi finalize xong).
2. `db/writer.ts` — **finalize barrier**:
```ts
private finalizePromise: Promise<void> | null = null;
async writeRunFinish(...): Promise<void> {
  const p = this.doWriteRunFinish(...);       // UPDATE status + flush ticks
  this.finalizePromise = p;
  await p;
  if (this.finalizePromise === p) this.finalizePromise = null;
}
async shutdown(): Promise<void> {
  if (this.unsubscribeLog) { this.unsubscribeLog(); this.unsubscribeLog = null; }
  if (this.finalizePromise) await this.finalizePromise;   // B-2: chờ finalize TRƯỚC pool.end()
  this.stopFlushTimer();
  await this.flushTicks();
  await this.store.disconnect();
}
```
3. `server.ts` shutdown (thay `41-49`):
```ts
const SHUTDOWN_TIMEOUT_MS = env.shutdownTimeoutMs;   // LOADTEST_SHUTDOWN_TIMEOUT_MS, default 10_000 (≥ 10s — PRD 5.2)
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return; shuttingDown = true;
  const deadline = setTimeout(() => { ltLog.error('Shutdown timeout — force exit 1'); process.exit(1); }, SHUTDOWN_TIMEOUT_MS);
  deadline.unref();
  try {
    await api.closeConnections();   // http-server: server.close() + closeAllConnections?.()
    await coordinator.stop(true);    // finishRun → await writeRunFinish (finalize xong TRƯỚC khi dbWriter.shutdown)
    await dbWriter.shutdown();      // barrier no-op + flushTicks + store.disconnect
    ltLog.info('Shutdown hoàn tất');
    process.exit(0);
  } catch (err) { ltLog.error(`Shutdown lỗi: ${String(err)}`); process.exit(1); }
}
```
- **Thứ tự**: đóng HTTP → dừng run (force, worker chết ≤ 5s) → flush DB → thoát. Request đang dở bị cắt — chấp nhận (dashboard poll 1s reconnect).
- **Test bắt buộc (T-11)**: kill mid-run → assert `runs.status != 'running'` TRƯỚC khi pool đóng.

---

## 7. CORS + body + register-gate (T-06)

### 7.1 CORS (`http-server.ts`)
```ts
export function parseOrigins(raw: string | undefined, def = ['http://localhost:5173']): string[]
export function applyCors(req, res, origins: string[]): void
```
- Origin khớp (`new URL(origin).origin` vs từng entry) → `Access-Control-Allow-Origin: <origin>` (echo, KHÔNG `*`) + `Vary: Origin`; `Allow-Methods: GET,POST,PUT,DELETE,OPTIONS`; `Allow-Headers: Content-Type,Authorization`; `Max-Age: 600`. Không khớp → **không set ACAO** (browser tự chặn; curl không có Origin không ảnh hưởng). KHÔNG `Allow-Credentials` (auth Bearer, không cookie).
- Preflight `OPTIONS` → 204 với header CORS theo origin.
- `LOADTEST_CORS_ORIGIN` env, default `http://localhost:5173` (R-7 — Vite proxy `changeOrigin:true` gửi origin Vite). `*` chỉ hiệu lực nếu set literal `*` (dev, document — SEC-2).
- Không có `Origin` header (curl/SSR) → không ACAO.

### 7.2 readBody — 1MB + 400 + plain-object (SB-3)
```ts
export class BodyError extends Error { constructor(public statusCode: 400 | 413, message: string) { super(message); } }
export async function readBody(req, maxBytes = 1024*1024): Promise<Record<string, unknown>> {
  // stream, total > maxBytes → respond 413 rồi req.destroy() (chống tiêu băng thông)
  // JSON.parse fail → BodyError(400, 'JSON body không hợp lệ')   // US-API-1
  // parsed value không phải plain object (array/string/number/null) → BodyError(400, 'JSON body không hợp lệ')  // SB-3
  // body rỗng → {}
}
```
- Route wrap: `try { body = await readBody(req) } catch (e) { if (e instanceof BodyError) return failJson(res, e.statusCode, e.message, { error: e.statusCode===413?'BODY_TOO_LARGE':'INVALID_JSON' }); throw e; }` — global error handler bắt phần còn lại → 500.
- Không check Content-Type (JSON.parse là nguồn chân lý — chấp nhận thiếu header, không từ chối oan).

### 7.3 Register gate (SEC-6, US-SEC-3)
- `LOADTEST_ALLOW_REGISTER` default `false` → `POST /auth/register` trả **403** `{ success:false, statusCode:403, error:'REGISTER_DISABLED', message:'Đăng ký đã bị tắt (LOADTEST_ALLOW_REGISTER=false)' }` **trước body validation** (đăng ký ở route table — B-3).
- Gate chạy TRƯỚC rate-limit check (403 không tốn token bucket), nhưng 403 vẫn bị ghi là 1 fail ở dispatcher post-response (§2) — đúng F-7. Khi `true` (dev) register hoạt động như cũ.
- **`GET /config` thêm `allowRegister: env.allowRegister`** (additive — F-7 fix: frontend ẩn CTA đăng ký khi false, tránh dead-end).
- Test coupling: `api-server.test.ts:89-113,166-170` set `LOADTEST_ALLOW_REGISTER=true` trong env override `beforeAll` **ngay trong T-06** (PLAN đã chốt).

### 7.4 Error envelope
- Shape chuẩn: `{ success, statusCode, message, error?, errors?, warnings?, timestamp, requestId? }` — additive (frontend `toApiError` chỉ đọc `statusCode/message/errors/warnings` — B-8 REFUTED).
- **500 handler**: KHÔNG trả `err.message` cho client; log `{ requestId, method, path, error: err.message, stack }` server-side; trả `{ success:false, statusCode:500, message:'Lỗi server, xem log với requestId', requestId }` (TH-8).
- `requestId` sinh 1 lần/request (`makeRequestId`), echo envelope, thread vào logger (T-07).

### 7.5 runId validation (TH-9 REFUTED — defense-in-depth; SB-1/SB-2)
- **Path params** (`/runs/{id}` family): trước `decodeURIComponent` (SB-2 — malformed escape `%E0%A4%A` gây 500), check `/^lt[a-z0-9]{2,24}$/i`; chỉ dùng cho SQL parameterized (không filesystem).
- **Cleanup body.runId** (SB-1): check `/^[a-z0-9-]{1,64}$/i`; `poolPath(dataDir, runId)` → `path.resolve` + assert `startsWith(path.resolve(dataDir) + path.sep)` — defense-in-depth (TH-9 đã REFUTED: `%2F` không tới filesystem vì `listPools` exact-match id server-gen; chống đúng bug `decodeURIComponent`).
- **`/report/export`**: `format` whitelist md/csv/json (giữ); `Content-Disposition` filename sanitizer (strip `"`/CR/LF) — defense-in-depth.

---

## 8. Config fail-fast (T-03)

### 8.1 validateEnv tách KHỎI getEnv
- `validateEnv(env, opts?: { production?: boolean }): EnvProblem[]` — **KHÔNG gọi trong getEnv** (worker.ts:11 gọi getEnv trong child process; validate trong getEnv làm worker fail oan vì thiếu OTP/DB — PL, §10).
- Gọi duy nhất ở `server.ts` sau `getEnv()`: `if (problems.length) { problems.forEach(p => ltLog.error(`[env] ${p.key}: ${p.message}`)); process.exit(1); }`.

### 8.2 Key validation
| Key | Mặc định | Validate |
|---|---|---|
| `LOADTEST_PORT` | 3401 | int 1-65535 |
| `LOADTEST_DATABASE_URL` | **placeholder** `postgresql://USER:PASS@HOST:PORT/DB` (xoá `appuser:secret` — C-2) | bắt buộc khi `dbRequired`; prefix `postgresql://`/`postgres://`; KHÔNG chứa pattern `/\/\/user:/i`, `appuser`, `:secret@` → error |
| `LOADTEST_DB_REQUIRED` | **true** (Q-2) | parseBool; `false` → cảnh báo to "DB không bắt buộc — run sẽ không ghi history" |
| `LOADTEST_OTP_SECRET` | '' | rỗng → error khi production (register fail E1); warn khi dev |
| `LOADTEST_AUTH_SECRET` | '' (fallback file/random — `auth.ts:73-89`) | rỗng → error khi production (auto-generate chỉ dev); dev → warn; **file-fallback là legacy path sau T-01 — env phải set tường minh** |
| `LOADTEST_REDIS_URL` | `redis://localhost:6379` | prefix `redis://`/`rediss://`; sai → error |
| `LOADTEST_ALLOWLIST` | `[http://localhost:3000]` | **production: phải set, không default** (SEC-7) |
| `LOADTEST_CORS_ORIGIN` | `http://localhost:5173` | production: bắt buộc set (SEC-2) |
| `LOADTEST_MAX_TARGET/MAX_DURATION_MIN/MAX_REGISTER_RAMP/MAX_SOCKETS_PER_WORKER/MAX_PENDING_OUTBOX` | giữ | > 0, finite |

- Lỗi in **đầy đủ 1 lần** (không dừng ở lỗi đầu).
- C-4: `getEnv` thu thập `sources: Record<key,'process'|'file'|'override'>`; in khi `LOADTEST_DEBUG=1`. Merge thứ tự giữ nguyên (process.env → file → overrides).
- `.env.example` cập nhật: `LOADTEST_DB_REQUIRED=true`, `LOADTEST_ALLOW_REGISTER=false`, `LOADTEST_CORS_ORIGIN=http://localhost:5173`, `LOADTEST_AUTH_SECRET=` (comment), `LOADTEST_RATE_LIMIT_*`, `LOADTEST_SHUTDOWN_TIMEOUT_MS=10000`, `LOADTEST_TRUST_PROXY=0`; `LOADTEST_DATABASE_URL` → placeholder.

### 8.3 Crypto hardening (hygiene)
- `auth-factory.ts:71,85` `seedOtp`/`seedSmsOtp`: `Math.random()` → **`crypto.randomInt(100000, 1000000)`** (3 dòng, khớp gateway `crypto.randomInt`).
- `util.ts:55-89` `genPassword`/`randomHex`/`uuidV4`: `Math.random()` → `crypto.randomBytes`/`randomInt` (không phải vulnerability — OTP đã HMAC trong Redis + verify plain compare cap 5 attempts; hygiene).

---

## 9. runId fix (T-03, S-9 + B-4)

**Vấn đề kép**: (1) `runSeq` reset 0 mỗi restart (`config.ts:219`) → 2 run cùng ms sau restart trùng id (S-9); (2) `ts = Date.now().toString(36).slice(-6)` **wrap mỗi 25.2 ngày** (36⁶ ms) → trùng pid+seq sau 25 ngày (B-4, CONFIRMED).

**Fix (chốt)**:
```ts
const pidPart = (process.pid % 46656).toString(36).padStart(3, '0');
let runSeq = 0;
export function newRunId(): string {
  runSeq = (runSeq + 1) % 1296;
  const ts = Date.now().toString(36);          // toàn bộ timestamp — KHÔNG slice (B-4)
  return `lt${ts}${pidPart}${runSeq.toString(36).padStart(2, '0')}`;  // vd ltm4k2z...abc01
}
```
- Collision cần cùng ms + cùng pid mod 46656 + cùng counter — không thực tế (không còn wrap 25 ngày).
- Consumer check: `config.test.ts:83` chỉ match `/^lt/`; `runIdFromPath` parse generic; frontend hiển thị chuỗi. Format check §7.5 `/^lt[a-z0-9]{2,24}$/i` phủ.
- Test T-03: gọi 2 lần sau module reload → khác nhau.

---

## 10. Decisions log (mọi finding đã chốt — Build không cần hỏi lại)

| # | Finding | Verdict | Nguồn | Resolution (FINAL) | Task |
|---|---|---|---|---|---|
| D-1 | **B-1** QueryResult error mang `sql/params` chứa plaintext password + hash → vào logs + JSONL sink | CONFIRMED (Major) | security §cr B-1 | **Redaction rule §4.2**: write query → error chỉ `{code,message}`; read query → `redactSql`+`redactParams`; logger guard `redactSensitiveFields` | T-05, T-07 |
| D-2 | **B-2** Shutdown race: `pool.end()` có thể drop `finalizeRun` đang bay → run kẹt `running` | CONFIRMED (Major) | backend §6, security §cr B-2 | **Finalize barrier §6**: `finishRun` await `writeRunFinish`; `DbWriter.shutdown()` await `finalizePromise` trước `pool.end()`; shutdown test mid-run | T-06, T-11 |
| D-3 | **B-3** Guard per-handler → handler mới quên `requireAuth` thành unauthenticated | PLAUSIBLE (Major) | backend §1.1, security §cr B-3 | **Guard ở route table §1.2** (flag `auth`/`rate`); 401 contract test mọi route auth:true | T-06, T-11 |
| D-4 | **B-4** `newRunId` slice(-6) wrap 25.2 ngày → trùng id | CONFIRMED (Minor) | security §cr B-4 | **§9**: full timestamp + pid + seq | T-03 |
| D-5 | **B-5** Startup auto-migrate có thể chạy migration destructive | PLAUSIBLE | security §cr B-5 | **§3.4**: startup `scope:'baseline'` chỉ 001, pending >1 → fail-fast `db:up` | T-04 |
| D-6 | **B-6** Env drift `LOADTEST_RATE_LIMIT_DISABLED` vs `_OFF`; định nghĩa "fail" | CONFIRMED | security §cr B-6 | **§2**: chốt `LOADTEST_RATE_LIMIT_DISABLED`; fail = mọi 4xx (gồm 409), success → clear | T-06 |
| D-7 | **U-1** CSP `connect-src 'self' ws: wss:` cho phép exfil tới mọi host | CONFIRMED (Major) | security §cr U-1 | **§UI-SPEC §2**: connect-src = explicit origins, KHÔNG scheme-wildcard (prod + dev exact string) | T-08 |
| D-8 | **U-2 / Double-CSP** 2 nguồn CSP (nginx header + meta) → intersection chặn font | CONFIRMED (Major) | security §cr U-2, UI §8#1 | **1 nguồn duy nhất = meta inject ở build** (Vite plugin `apply:'build'`); nginx KHÔNG set CSP (hoặc copy y hệt + comment "GIỮ ĐỒNG BỘ"); `frame-ancestors` delegate nginx header riêng, ghi THREAT-MODEL | T-08, T-12 |
| D-9 | **U-3** `dangerouslySetInnerHTML` tại `MatchingScreen.tsx:131` | PLAUSIBLE | security §cr U-3 | Refactor `search` sang JSX interpolation (chỉ nội suy constant); thêm eslint `react/no-danger` | T-08 |
| D-10 | **U-4** `frame-ancestors` mất khi meta-only | CONFIRMED | security §cr U-4 | Chấp nhận MVP (Bearer + tool nội bộ); nginx có thể set `X-Frame-Options`/`frame-ancestors` riêng; ghi THREAT-MODEL | T-12 |
| D-11 | **429 UX gap** UI nuốt 429, không retry-after, stop im lặng | CONFIRMED (Major) | UI §cr F-3/F-8/S-2 | **UI-SPEC §5**: `toApiError` giữ `retryAfterSec`; start/stop disable + countdown; sticky stop toast | T-09 |
| D-12 | **TH-9** path traversal qua runId | **REFUTED** | backend §cr S-1 | `%2F` không tới filesystem (cleanup dùng `body.runId` exact-match id server-gen); **giữ format check defense-in-depth §7.5** | T-06 |
| D-13 | **Math.random OTP** | CONFIRMED (hygiene) | security §4.5 | `crypto.randomInt(100000,1000000)`; không phải blocker (OTP HMAC + plain compare cap 5) | T-06 |
| D-14 | **Banner "12 giờ" hardcode** vs logic động | CONFIRMED | UI §cr S-1 | **UI-SPEC §3**: text động từ `expiresAt` (static snapshot tại thời điểm hiện, không live countdown) | T-09 |
| D-15 | **Thiếu socket-token regression test** | CONFIRMED | UI §cr F-12/S-3 | **UI-SPEC §8**: test `socket.ts` + `socket-farm.ts` options không chứa `query.token` | T-09, T-11 |
| D-16 | **CSP fonts preconnect** thiếu `fonts.gstatic.com` trong connect-src | CONFIRMED | backend §cr S-6 | **UI-SPEC §2**: connect-src gồm CẢ `fonts.googleapis.com` + `fonts.gstatic.com` | T-08 |
| D-17 | **Register gate dead-end** (403 mãi, CTA luôn hiện) | PLAUSIBLE | UI §cr F-7 | `/config` thêm `allowRegister`; frontend ẩn CTA đăng ký khi false | T-06, T-09 |
| D-18 | **CORS-misconfig UX** message "port 3401" gây hiểu nhầm | PLAUSIBLE | UI §cr F-9 | **UI-SPEC §6**: `toApiError` phân biệt network/CORS → "kiểm tra `LOADTEST_CORS_ORIGIN`" | T-09 |
| D-19 | **ErrorBoundary Layer-1 "Về trang chủ" no-op** (không resetKey) | CONFIRMED | UI §cr U-2 | **UI-SPEC §1**: home button = navigate + reset sau 1-frame (rAF); Layer-2 reset theo `location.pathname` | T-08 |
| D-20 | **Coverage workspace** đếm cả loadtest project | CONFIRMED | UI §cr U-4 | **UI-SPEC §8**: scope coverage chỉ frontend project | T-09 |
| D-21 | **localhost CSRF / DNS rebinding** (S-5) — thiếu trong threat model | CONFIRMED (omission) | backend §cr S-5 | **THREAT-MODEL TH-10**: control = CORS + auth-gated writes + register gate; residual documented; `Sec-Fetch-Site` check để v1.1 | T-12 |
| D-22 | **SB-2** `decodeURIComponent` throw trên malformed escape → 500 | CONFIRMED | backend self-critique | §7.5 format check trước decode | T-06 |
| D-23 | **SB-3** `readBody` trả `{}` cho non-object JSON | CONFIRMED | backend self-critique | §7.2 plain-object check → 400 | T-06 |
| D-24 | **SB-1** thiếu runId format check trên cleanup path | CONFIRMED | backend self-critique | §7.5 regex + `path.resolve` prefix check | T-06 |
| D-25 | **F-5** `/health` nằm trong prefix `/api/loadtest/health` (không phải ngoài) | CONFIRMED | UI §cr F-4/F-5 | `GET /metrics` (tool) ngoài prefix; `/health` giữ `/api/loadtest/health`; Docker healthcheck chấp nhận `degraded` | T-07, T-12 |

### PLAN NOTE (điều chỉnh nhỏ, không đổi wave/deps)
- **PLAN NOTE (T-05)**: thêm "cập nhật cơ học call site store trong `store.test.ts` + `api-server.test.ts` (sang `r.ok ? r.rows : ...` / `first()`)" — nếu không T-05 không pass G-1 (backend §10.3).
- **PLAN NOTE (T-04)**: runner hỗ trợ `scope: 'baseline' | 'all'` (B-5) + marker `-- startup-safe` trên 001.
- **PLAN NOTE (T-06)**: guard ở route table (B-3) + 401 contract test chuyển qua T-11; runId format check + `crypto.randomInt` + plain-object check trong task này.
- **PLAN NOTE (T-08)**: CSP connect-src explicit origins (không `ws:`/`wss:`); `/config` thêm `allowRegister` (T-06 backend) cho frontend ẩn CTA.
- **PLAN NOTE (T-09)**: thêm 429 UX (retryAfterSec + countdown + stop toast), CORS-misconfig message, socket-token regression test, banner text động.
- **PLAN NOTE (T-11)**: thêm 401 contract test (mọi route auth:true), shutdown mid-run test (B-2), test `/config.allowRegister`.

---

## 11. Risk register (giữ từ backend §9, đã cập nhật fix)

| # | Rủi ro | Mức | Ứng phó | Task |
|---|---|---|---|---|
| B-1 | QueryResult đổi signature ~20 method → test vỡ | High | Cập nhật cơ học trong T-05 (PLAN NOTE); `first()` helper | T-05 |
| B-2 | Register gate default false → test 200 ĐỎ | High | `LOADTEST_ALLOW_REGISTER=true` trong env override `beforeAll` (T-06) | T-06 |
| B-3 | Rate-limit làm fail test/E2E | Medium | `LOADTEST_RATE_LIMIT_DISABLED=1` trong test env; GET polling không giới hạn | T-06 |
| B-4 | Migration đụng DB cũ có data | Medium | 001 = IF NOT EXISTS + skip ≤ applied; advisory lock; startup scope=baseline | T-04 |
| B-5 | flushTicks giữ batch khi DB chết lâu | Low | Cận `MAX_PENDING_TICKS*2`, drop + đếm fail | T-05 |
| B-6 | Down migration drop bảng | Accepted | Ngữ nghĩa rollback; CLI thủ công; `pg_dump` backup document (T-12) | T-04 |
| B-7 | logger ring buffer format đổi | Low | `msg` giữ text cũ; field mới optional | T-07 |
| B-8 | CORS hẹp phá Vite proxy | Medium | Default `http://localhost:5173`; test dev + prod | T-06 |
| B-9 | Shim socket-farm/coordinator dead export | Low | Ghi rõ v1.1; review G-6 | T-06 |
| B-10 | CSP chặn fonts/preconnect nếu thiếu origin | Medium | connect-src gồm cả 2 font origins (D-16); verify build + dev | T-08 |