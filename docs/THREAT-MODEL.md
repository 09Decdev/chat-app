# THREAT-MODEL v0.1 — chat-app + loadtest tool

**Status**: ✅ FINAL — design council synthesis (2026-08-04). Nguồn: `docs/DESIGN-prod-refactor.md` (FINAL), `docs/DESIGN-prod-refactor-security.md` (threat table), `docs/UI-SPEC-prod-refactor.md`. G-9 (PRD §8): 1 trang, mỗi mục có control + task.
**Perimeter**: loadtest server = tool local tự host (`LOADTEST_HOST=127.0.0.1`, `loadtest/config.ts:91`); internet-facing surface = chat SPA (Vite/nginx) + gateway. LocalStorage **dùng chung** giữa chat + dashboard loadtest (cùng origin) → XSS chat = đánh cắp token admin loadtest.

## Assets
| ID | Asset | Nơi lưu | Vì sao quan trọng |
|---|---|---|---|
| A1 | `LOADTEST_AUTH_SECRET` | `loadtest/.env` + (xóa ở T-01) `dataDir/auth-secret.json` | Ký mọi session HMAC — compromise = forge admin token |
| A2 | `LOADTEST_OTP_SECRET` | `loadtest/.env` | Seed `otp:register:*` trong Redis; phải khớp gateway |
| A3 | `LOADTEST_DATABASE_URL` | `loadtest/.env` | Full history DB + admin_users + pool_accounts |
| A4 | `LOADTEST_REDIS_URL` | `loadtest/.env` | Write access OTP keys + queue-count |
| A5 | `pool_accounts.password` (plaintext) | Postgres + `dataDir/accounts-*.json` | Reusable test-account creds lên gateway |
| A6 | `admin_users.password_hash` (scrypt) | Postgres | Admin login |
| A7 | Access/refresh tokens (chat + pool) | `localStorage`, `accounts-*.json`, in-memory | Session impersonation |
| A8 | Run data / metrics / reports | Postgres + `docs/loadtest-reports/` | Operative intel (report không có token — verified) |
| A9 | Synthetic PII (email, device_info, DOB, country) | Postgres `pool_accounts` | Mass-residual PII |

## Actors
**T-ext** (external, không credential), **T-xss** (script trong browser nạn nhân), **T-admin** (token hợp lệ bị lộ/brute-force), **T-db** (DB leak), **T-insider** (clone repo / teammate).

## Threat table (STRIDE-flavored)
| # | Threat | L | I | Risk | Mức | Current control | Gap | Mitigation → Task |
|---|---|---|---|---|---|---|---|---|
| TH-1 | **Secret trong git history** (auth-secret, OTP, DB creds, accounts 1.3MB) | High | High | **Critical** | 🔴 | `.gitignore` chỉ `.env`/`.env.*` | `loadtest/data/*` không ignored; secret đang untracked | T-01 rotate+xoá+gitignore; T-02 gitleaks 0-finding + pre-commit |
| TH-2 | **XSS → token theft** (chat + loadtest admin cùng origin) | Medium | High | **High** | 🟠 | — | Không CSP; `[DEBUG-LOGIN]` leak deviceInfo | T-08 CSP `script-src 'self'` + ErrorBoundary + bỏ debug log; **U-1**: CSP chặn exfil (connect-src explicit origins) |
| TH-3 | **Brute-force admin login** | Medium | High | **High** | 🟠 | — | Không rate-limit login | T-06 rate-limit 5 fail/60s/IP → 429 + `Retry-After` |
| TH-4 | **Register spam / admin mới** | Medium | Medium | **Medium** | 🟠 | — | `POST /auth/register` public | T-06 gate `LOADTEST_ALLOW_REGISTER=false` → 403; `/config.allowRegister` (T-09 ẩn CTA) |
| TH-5 | **CORS misconfig** (`*` + Bearer) | Medium | High | **High** | 🟠 | `Access-Control-Allow-Origin: *` | Wildcard | T-06 `CORS_ORIGIN` allowlist, echo origin, `Vary: Origin`; T-09 CORS-misconfig UX |
| TH-6 | **DB PII/credential leak** (`pool_accounts.password` plaintext) | Medium | Med-Hi | **Medium** | 🟡 | — | Plaintext + file at-rest | T-12 accept+document (R-9); T-01 gitignore data; không API trả `password` (verified); AES-GCM v1.1 |
| TH-7 | **Token trong URL query** (socket) | Medium | Medium | **Medium** | 🟠 | Gateway nhận header fallback | `query:{token}` ở cả 2 socket | T-08 bỏ query, chỉ Bearer header; T-09/T-11 regression test |
| TH-8 | **Error/stack leakage** | Low-Med | Low | Low | 🟡 | Envelope sạch | 500 trả `err.message` | T-06/T-07 generic 500 + `requestId`; log full server-side |
| TH-9 | **Path traversal qua runId** | Low | Medium | Low | 🟡 | `isRunPath` chặn `/` | (REFUTED — `%2F` không tới filesystem; cleanup exact-match id server-gen) | T-06 format check `/^lt[a-z0-9]{2,24}$/i` + `path.resolve` prefix — **defense-in-depth** |
| TH-10 | **localhost CSRF / DNS rebinding** | Low | Medium | Low | 🟡 | CORS chặn đọc response (không chặn thực thi) | Chưa ghi trong model | T-12 document; control = CORS + auth-gated writes + register gate; `Sec-Fetch-Site` check để v1.1 |
| TH-11 | **B-1: Plaintext password/hash vào logs** (QueryResult error + JSONL sink) | Med | High | **High** | 🟠 | — | `insertPoolAccounts`/`createAdmin` đưa secret vào `params` | T-05 redaction: write → error chỉ `{code,message}`; read → `redactSql`+`redactParams`; T-07 logger `redactSensitiveFields` |
| TH-12 | **B-2: Shutdown mất finalize** (run kẹt `status='running'`, history half-written) | Med | Med | **Medium** | 🟠 | `dbWriter.shutdown()` flush | `pool.end()` có thể drop `finalizeRun` đang bay | T-06 finalize barrier (await `writeRunFinish` + `finalizePromise` trước `pool.end()`); T-11 shutdown test |
| TH-13 | **U-1: CSP exfil qua `ws:`/`wss:` wildcard** (post-XSS `new WebSocket('ws://attacker')`) | Med | High | **High** | 🟠 | — | `connect-src 'self' ws: wss:` theo design cũ | T-08 connect-src **explicit origins** (gateway origin + Vite + fonts); không wildcard; `VITE_CSP_CONNECT_SRC` cho gateway khác origin |

## Residual risks (accepted, documented)
- **localStorage** (Q-4): CSRF/CSP không chặn DOM read; token chat + loadtest cùng origin → residual XSS→token theft. Control: CSP chặn exfil + admin token 12h không refresh (bounded window) + không `dangerouslySetInnerHTML` user content (T-08 eslint `react/no-danger`).
- **`frame-ancestors`** (meta CSP không enforce — D-10): clickjacking thấp (Bearer + tool nội bộ); delegate nginx header riêng.
- **`pool_accounts.password` plaintext** (R-9): DB leak = all-or-nothing (AES key cùng host không chống được); accept + document, AES-GCM v1.1.
- **1 coordinator = 1 run** (S-8): đã chốt, document README (T-12).
- **OTP weak-RNG** (Math.random): đã fix `crypto.randomInt` (D-13) — OTP HMAC + verify cap 5 attempts, không phải vulnerability.
- **`docs/loadtest-reports/*`**: chứa config (gatewayUrl, target) không token — giữ 1 sample (G-7), gitignore phần còn lại (quyết định mở nhỏ, ko chặn).

## Control map (tài liệu cần)
- Token flow: `docs/DESIGN-prod-refactor.md` §7, `docs/UI-SPEC-prod-refactor.md` §2; CSP: UI-SPEC §2; rate-limit/CORS/register gate: DESIGN §2/§7; pool plaintext: TH-6 (v1.1 AES-GCM, R-9); shutdown: DESIGN §6; log redaction: DESIGN §4.2.