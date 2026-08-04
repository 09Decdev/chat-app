# AUTOBUILD — prod refactor

## T-01 review — Code Review

Review của critic Code Review cho T-01 (secret rotation + gitignore hardening) — phạm vi CORRECTNESS (không phải security).

### Findings

| Severity | Finding | Evidence | Verdict | Fix |
|---|---|---|---|---|
| **Major** | OTP secret xoay 1 phía chưa sync sang gateway-auth-service — loadtest tool sẽ KHÔNG register được account (AF-1) khi chạy | `loadtest/.env` `LOADTEST_OTP_SECRET` = 64-hex mới; `gateway-auth-service/.env` `OTP_SECRET` vẫn = giá trị cũ `secret-key-that-must-be-32-bytes!` (md5 trùng khớp). Mismatch xác nhận bằng hash. README §Bảo mật & secrets & NEW-ROTATED-SECRETS.txt đều ghi rõ "PHẢI khớp" | CONFIRMED | Bắt buộc trước khi chạy loadtest: áp `LOADTEST_OTP_SECRET` mới vào `OTP_SECRET` của `gateway-auth-service/.env` (hoặc ngược lại rồi xoay lại), rồi chạy 1 test register để xác nhận 2 bên khớp |
| **Minor** | Pattern `.gitignore` dòng 36 `loadtest/settings.json` là dead/redundant — settings.json thực tế được ghi vào `env.dataDir` = `./loadtest/data/settings.json` (config.ts:259,271), đã bị `loadtest/data/*` che phủ | `config.ts` `loadSettings()`/`saveSettings()` dùng `path.join(env.dataDir, 'settings.json')`; `LOADTEST_DATA_DIR` default `./loadtest/data` | CONFIRMED (vô hại) | Xoá dòng 36 hoặc đổi comment để không gây hiểu nhầm path khác |

### Các hạng mục verify PASS

- **.gitignore**: `*.tsbuildinfo` ignore đúng `tsconfig.tsbuildinfo` + `tsconfig.node.tsbuildinfo` (git check-ignore confirm). `loadtest/data/*` + `!loadtest/data/.gitkeep` hoạt động đúng — `.gitkeep` không bị ignore, `accounts-*.json` bị ignore. `loadtest/.env` bị ignore (pattern `.env`). Không pattern nào chặn file cần commit (`.env.example` root + `loadtest/.env.example` đều KHÔNG bị ignore).
- **git status**: chỉ `README.md` modified; mọi thứ khác untracked (chưa từng commit — commit đầu chỉ có README.md). `loadtest/data/` chỉ chứa `.gitkeep`, không xoá nhầm file tracked nào.
- **README.md**: tên env var khớp code (`LOADTEST_AUTH_SECRET` → auth.ts:74; `LOADTEST_OTP_SECRET`/`LOADTEST_DATABASE_URL`/`LOADTEST_REDIS_URL` → config.ts:94/104/95). Backup path `%USERPROFILE%\.mayogu-secrets\chat-app-backup-2026-08-04\` tồn tại (chứa `.env` + `NEW-ROTATED-SECRETS.txt` + `data/`). `npm run secret:scan`, `scripts/install-hooks.sh`, `scripts/pre-commit` tồn tại.
- **loadtest/.env**: URL `postgresql://appuser:<pass>@localhost:5439/loadtest` hợp lệ; user/host/port/db giữ nguyên so với backup; set key giống hệt backup ngoài key mới `LOADTEST_AUTH_SECRET`; giá trị khớp `NEW-ROTATED-SECRETS.txt`.
- **Tests**: không test nào đọc `accounts-*.json` hay data dir thật — duy nhất `api-server.test.ts:47` dùng `LOADTEST_DATA_DIR: tmpDir`. Xoá accounts files không làm test đỏ.
- **Runtime**: `loadtest/data/` được đảm bảo tồn tại nhờ `.gitkeep` (commit được); `saveSettings` (config.ts:270) + `auth-factory.ts:355` đều `mkdirSync(recursive)` — không phụ thuộc dir có sẵn.

### Verdict

GHI NHẬN VỚI ĐIỀU KIỆN — an toàn để commit sau khi 2 điều kiện sau được xử lý:
1. **Bắt buộc**: sync `OTP_SECRET` sang gateway-auth-service (Major finding) trước khi chạy loadtest — nếu không tool sẽ fail register.
2. **Khuyến nghị**: áp DB password mới lên instance `postgres-loadtest` (localhost:5439) trước khi chạy (đã ghi trong README).

## T-02 review — Security

Reviewed by: Security + SecOps critic (REVIEW ONLY — no code modified).
Date: 2026-08-04.

Scope: `.gitleaks.toml`, `scripts/pre-commit`, `scripts/install-hooks.sh`, installed `.git/hooks/pre-commit`, `package.json` `secret:scan`, README secret-scan docs.

### Headline verdict on the critical question

The allowlist regex `postgresql://appuser:secret@localhost:5439/loadtest_test(_api)?` does **NOT** match the runtime default credential `postgresql://appuser:secret@localhost:5439/loadtest` (config.ts:104, init.ts:27, .env.example:24). Verified with node: `runtime matches allowlist: false`. The runtime credential is NOT allowlisted — it will be caught once present in a scanned target. The allowlist is correctly scoped to the test-only DB names.

### Findings

| Severity | Finding | Evidence | Verdict | Fix |
|---|---|---|---|---|
| MEDIUM | `secret:scan` scans git history ONLY, not the working tree. `--log-opts=--all` makes `detect` scan commits; the repo has exactly 1 commit (README.md only). All code files (incl. the 3 runtime-credential files) are untracked (`git ls-files` = 1). The scan therefore reports "0 findings" while `appuser:secret` sits in config.ts:104, init.ts:27, .env.example:24. README claims "chạy gitleaks detect trên toàn repo ... Kỳ vọng 0 finding" — misleading. | `git ls-files \| wc -l` = 1; `git show --stat 8c41ad8` = only README.md; package.json:15. | CONFIRMED | Add a working-tree scan as the primary gate: `gitleaks detect --source . --no-banner` (no `--log-opts`) and keep `--log-opts=--all` as a separate history scan, or document the limitation. A CI/tree scan is what actually catches the runtime credential now. |
| LOW | Allowlist regex has no end anchor / word boundary: `loadtest_test(_api)?` matches any DB name beginning with `loadtest_test`, e.g. `postgresql://appuser:secret@localhost:5439/loadtest_testing` (verified: `matches allowlist: true`). An over-broad allowlist could mask a future real DB whose name starts with that prefix. | node test: `loadtest_testing matches allowlist: true`. | CONFIRMED | Anchor the regex: `postgresql://appuser:secret@localhost:5439/loadtest_test(_api)?$` (or `(?!\w)`). |
| LOW | Allowlist is global, not path-scoped. `[allowlist]` with `strings=["test-secret"]` and the DB regex apply to every gitleaks rule and every file in the repo. A genuine secret elsewhere that happens to contain `test-secret` or the URL pattern would be silently masked. | .gitleaks.toml:23-32 (no `path` / `regexTarget`). | CONFIRMED | Scope the allowlist to fixtures, e.g. `path = "loadtest/__tests__/"` and/or set `regexTarget = "line"`; keep the `strings` list minimal. |
| INFO | gitleaks is NOT installed on this machine (`command -v gitleaks` fails). The pre-commit hook therefore fails OPEN (skips with a warning) and `npm run secret:scan` cannot run. The gate is currently inactive — by design and documented, but no protection is active until gitleaks is installed. | `command -v gitleaks` → not found; scripts/pre-commit:13-18. | CONFIRMED | Install gitleaks (`winget install gitleaks` / `scoop install gitleaks`) and re-run `sh scripts/install-hooks.sh`. |
| INFO | Installed hook matches tracked source exactly; `chmod +x` applied (rwxr-xr-x on .git/hooks/pre-commit, scripts/pre-commit, install-hooks.sh). `gitleaks protect --staged --no-banner` is the correct v8.18+ command; `set -e` propagates gitleaks' non-zero exit → fails closed when a leak is found. | diff source vs `.git/hooks/pre-commit` = identical; perms 100755. | CONFIRMED | None. |
| INFO | Leak-map expected files: `loadtest/data/accounts-*.json` (11 files) and `loadtest/data/auth-secret.json` are deleted and were NEVER committed (git log -S and `git ls-files` show nothing) — no residual history risk. `loadtest/data/*` and `loadtest/.env` are correctly gitignored (only `.gitkeep` retained). The runtime credential in config.ts / init.ts / .env.example is EXPECTED leakage (T-03 will fix) and is NOT allowlisted. | .gitignore:33-35; `ls loadtest/data` = only `.gitkeep`; `git log --all -S 'appuser:secret'` = empty. | CONFIRMED | None — T-03 owns the fix. |

### Leak-map confirmation (as staged by T-01/T-03)

- `loadtest/config.ts:104` — `postgresql://appuser:secret@localhost:5439/loadtest` present. Expected (T-03).
- `loadtest/db/init.ts:27` — same URL present. Expected (T-03).
- `loadtest/.env.example:24` — same URL present. Expected (T-03).
- `loadtest/data/accounts-*.json`, `loadtest/data/auth-secret.json` — deleted, never committed. No action needed.

### Overall verdict

T-02 is structurally sound: correct ruleset extension (`[extend] useDefault = true`), correct allowlist syntax (`regexes`/`strings` inside `[allowlist]`), correct `protect --staged` hook, correct fail-closed/fail-open semantics, correct install script. The one real gap is that `secret:scan` (history-only) does not scan the working tree, so it currently reports a clean bill while the runtime credential is unguarded in 3 untracked files — the only live gate today is the pre-commit hook, which is inactive because gitleaks is not installed. Fix the scan coverage (MEDIUM) and install gitleaks to activate the gate.

## T-01 review — Security

Reviewed by: Security Architect critic (REVIEW ONLY — no code modified).
Date: 2026-08-04.

Scope: backup integrity, rotation quality, gitignore correctness, runtime impact, leftover risk.

### Findings

| Severity | Finding | Evidence | Verdict | Fix |
|---|---|---|---|---|
| **Major** | OTP rotation là 1 phía — `gateway-auth-service/.env` `OTP_SECRET` vẫn = giá trị cũ ĐÃ LỘ (33 chars, sha256 khớp 100% với `LOADTEST_OTP_SECRET` cũ trong backup). Hệ quả kép: (1) SECURITY — secret đã bị leak (TH-1) vẫn còn LIVE ở gateway; (2) FUNCTIONAL — loadtest seed OTP bằng secret mới `1f91…` (AF-1) sẽ fail register vì gateway verify bằng secret cũ. README.md:57 + NEW-ROTATED-SECRETS.txt đều ghi "PHẢI khớp" nhưng chưa thực hiện. | `gateway-auth-service/.env` `OTP_SECRET` len=33; backup `.env` `LOADTEST_OTP_SECRET` len=33; sha256 bằng nhau; loadtest/.env `LOADTEST_OTP_SECRET` len=64 prefix `1f91` | CONFIRMED | BẮT BUỘC trước khi chạy loadtest: sync `LOADTEST_OTP_SECRET` mới vào `OTP_SECRET` của `gateway-auth-service/.env` (đồng thời rotate lại phía gateway nếu secret cũ bị lộ), rồi chạy 1 test register xác nhận khớp |
| **Minor** | Credential DB mặc định còn hardcode trong source: `postgresql://appuser:secret@localhost:5439/loadtest` (password 6 ký tự yếu). Pre-existing (không phải regression T-01), key nằm trong các file tracked/untracked sẽ được commit. `.gitleaks.toml:28-31` xác nhận sẽ bị gitleaks bắt và đã deferred sang T-03. | `loadtest/config.ts:104`, `loadtest/db/init.ts:27`, `loadtest/.env.example:24` | CONFIRMED (pre-existing) | T-03 xoá default khỏi source / chuyển sang env-bắt-buộc; không đưa vào T-01 |
| **Minor** | README tuyên bố "Kỳ vọng 0 finding" cho `secret:scan` nhưng `.gitleaks.toml:28-31` nói runtime default KHÔNG allowlist → scan sẽ báo ≥1 finding. Không thể chạy thực tế vì gitleaks chưa cài. | README.md:52 vs `.gitleaks.toml:28-31`; `command -v gitleaks` fail | PLAUSIBLE | Sửa README: "kỳ vọng 0 finding sau T-03" hoặc cài gitleaks + chạy thử để xác nhận |
| **Minor** | Cổng chặn secret đang INACTIVE: gitleaks không cài trên máy → pre-commit hook fail-open (skip kèm warning), `secret:scan` không chạy được. Repo hiện không có gate nào chặn secret. | `scripts/pre-commit:13-18`; `command -v gitleaks` → not found | CONFIRMED | `winget install gitleaks` (hoặc scoop) + `sh scripts/install-hooks.sh` |
| **Minor** | Dòng `.gitignore:36` `loadtest/settings.json` là dead rule — app thực tế đọc/ghi `loadtest/data/settings.json` (config.ts:259,271), đã bị `loadtest/data/*` che phủ. Vô hại nhưng path gây hiểu nhầm. | `loadtest/config.ts:259,271`, `loadtest/config.ts:102` | CONFIRMED (vô hại) | Xoá dòng 36 hoặc sửa comment |

### Các hạng mục verify PASS

- **Backup integrity**: `C:\Users\Admin\.mayogu-secrets\chat-app-backup-2026-08-04\` tồn tại, đủ 13 files (`.env` 2316B, `data/` 11× `accounts-*.json` + `auth-secret.json`, `NEW-ROTATED-SECRETS.txt`). Ngoài repo — `git -C` trả `fatal: not a git repository`. Backup `.env` = bản CŨ (OTP 33 chars, KHÔNG có `LOADTEST_AUTH_SECRET`, DB password 28 chars không chứa GwdA).
- **Rotation quality**: `LOADTEST_AUTH_SECRET` mới 64-hex prefix `5f69` (bản cũ không có key này — trước đây nằm trong `auth-secret.json`); `LOADTEST_OTP_SECRET` mới 64-hex prefix `1f91` ≠ cũ `secret-key-t…`; DB password mới 46 chars chứa `GwdA` (cũ 28 chars, 0 lần `GwdA`). Cả 3 đều khác bản backup.
- **gitignore**: `git check-ignore -v` xác nhận `loadtest/data/*` (accounts, auth-secret, settings), `loadtest/settings.json`, `*.tsbuildinfo`, `loadtest/.env` đều bị ignore; `.gitkeep` KHÔNG bị ignore. Không pattern nào chặn file legit cần commit (root `.env.example` + `loadtest/.env.example` tự do).
- **Runtime impact**: `loadAuthSecret` (auth.ts:73-89) ưu tiên env `LOADTEST_AUTH_SECRET` (auth.ts:74-75) — xoá `auth-secret.json` không ảnh hưởng khi env set; nếu env trống sẽ tự tạo lại file trong `loadtest/data/` (đã gitignored). `listPools` (auth-factory.ts:107-109) lọc bằng regex `/^accounts-(.+)\.json$/` nên `.gitkeep` được bỏ qua an toàn. Không mã nào đọc `accounts-*.json`/`settings.json` ở startup bắt buộc — xoá pool files không gây crash.
- **Leftover risk**: `git add -n -A` (dry-run) chỉ đưa `loadtest/data/.gitkeep` từ `data/`; không có `.env`, `auth-secret.json`, `accounts-*.json`, `*.tsbuildinfo`. Chỉ file tên "password" trong repo là `loadtest/db/password.ts` — module scrypt hashing hợp lệ, không chứa secret. Grep hardcoded secret trong source: không có ngoài default DB URL đã liệt kê ở trên.

### Verdict

AN TOÀN ĐỂ COMMIT — nhưng phải xử lý 1 blocker trước khi CHẠY hệ thống: sync `OTP_SECRET` mới sang `gateway-auth-service/.env` (Major finding). Về mặt repo: backup đầy đủ, rotation thật sự khác bản cũ, gitignore đúng, dry-run commit sạch — phần xử lý T-01 đạt chất lượng. Điểm yếu còn lại nằm ở khâu vận hành (party-crossing chưa áp dụng) và thiếu gate thực thi (gitleaks chưa cài).

## W0 Reality Check

Reviewed by: Reality Checker (REVIEW ONLY — no code modified). Default = FAIL, requires overwhelming evidence.
Date: 2026-08-04. Last gate before committing W0.

### Evidence table

| # | Item | Evidence | Verdict |
|---|---|---|---|
| 1 | Secrets gone from tree | `find` (excl. `.git`) for `*auth-secret*`, `*accounts*`, `settings.json` → **no files**. `loadtest/data/` = only `.gitkeep` (0 bytes). `git ls-files` → only `README.md` tracked. | PASS |
| 2 | gitignore works | `git check-ignore -v` matched all 5: `loadtest/data/auth-secret.json`→gitignore:34, `accounts-ltd4r7sz01.json`→:34, `settings.json`→:34, `loadtest/.env`→:12, `tsconfig.tsbuildinfo`→:38. `git check-ignore loadtest/data/.gitkeep` → exit 1 (NOT ignored). | PASS |
| 3 | Backup exists outside repo | `C:/Users/Admin/.mayogu-secrets/chat-app-backup-2026-08-04/` contains `.env`, `NEW-ROTATED-SECRETS.txt`, `data/` (11× `accounts-*.json` + `auth-secret.json`). Path prefix check: OUTSIDE repo (not under `C:/MAYogu_VIASG/chat-app`). | PASS |
| 4 | Rotation evidence | sha256 of values (not printed): `LOADTEST_OTP_SECRET` new vs backup → **DIFFERENT**; `LOADTEST_DATABASE_URL` → **DIFFERENT**; `LOADTEST_AUTH_SECRET` new env vs backup `data/auth-secret.json` → **DIFFERENT**. Caution: backup `.env` lacks the `LOADTEST_AUTH_SECRET` key (old secret lived in `data/auth-secret.json` only) — compared against that file. | PASS |
| 5 | gitleaks config | `.gitleaks.toml` exists; allowlist regex anchored `postgresql://appuser:secret@localhost:5439/loadtest_test(_api)?$`. `package.json` `secret:scan` = history (`--log-opts=--all`) + tree (`--no-git`); `secret:scan:tree` = tree only. `package.json` validated as **valid JSON**. | PASS |
| 6 | pre-commit hook | `.git/hooks/pre-commit` exists, executable (`-rwxr-xr-x`), **byte-identical** to tracked `scripts/pre-commit` (`diff` clean). `scripts/install-hooks.sh` exists, executable. Hook fails OPEN (skips with warning) if gitleaks not installed. | PASS |
| 7 | No accidental deletions | `git status --short`: `M README.md` (still tracked, `git ls-files` confirms) + new untracked (`.gitignore`, `.gitleaks.toml`, `docs/`, `loadtest/`, `package.json`, `scripts/`, `src/`, `public/`, etc.). No deletions. | PASS |
| 8 | Docs/log | `docs/AUTOBUILD-prod-refactor.md` exists with T-01 (Code Review + Security) and T-02 (Security) review sections + this section. | PASS |

### Overall verdict

**PASS** — toàn bộ 8 items đều đạt. W0 (T-01 secret cleanup + T-02 gitleaks) an toàn để commit. Không có secret nào trong tree, rotation thật sự (cả 3 key đều khác bản backup), backup nằm ngoài repo, gitignore chính xác, hook/scripts đầy đủ.

### REMAINING user actions (pre-run — KHÔNG phải code blocker cho commit, nhưng BẮT BUỘC trước khi chạy hệ thống)

1. **Install gitleaks**: `winget install gitleaks` (hoặc `scoop install gitleaks`) rồi `sh scripts/install-hooks.sh`. Đến lúc đó pre-commit hook fail-open (skip warning) và `npm run secret:scan` không chạy được — gate chặn secret đang INACTIVE.
2. **Sync OTP secret sang gateway**: áp `LOADTEST_OTP_SECRET` mới vào `OTP_SECRET` của `gateway-auth-service/.env` (secret cũ ĐÃ LỘ — cân nhắc rotate lại phía gateway). Nếu không, loadtest seed OTP (AF-1) sẽ fail register. Chạy 1 test register để xác nhận 2 bên khớp.
3. **Apply DB password lên Postgres**: áp password mới của `LOADTEST_DATABASE_URL` lên instance `postgres-loadtest` (localhost:5439) — DB trước khi chạy phải dùng đúng credential mới (backup giữ password cũ).

## T-05 review — Security

Reviewed by: Security Architect critic (REVIEW ONLY — no code modified).
Date: 2026-08-04.
Scope: verify B-1 fix (QueryResult redaction), redaction helper coverage, other sql/params leak surfaces, tool-metrics, T-07 JSONL-sink readiness.

### Findings

| Severity | Finding | Evidence | Verdict | Fix |
|---|---|---|---|---|
| **Medium** | `redactParams` không redact được chính secret nó được xây để chặn: chỉ redact param dạng OBJECT, còn `insertPoolAccounts`/`createAdmin` truyền password/hash dạng chuỗi trần trong FLAT ARRAY (`values[2]` = password, `params[2]` = passwordHash) → pass-through nguyên vẹn. Docstring "non-object param giữ nguyên (params của SELECT là id/filter, không có secret)" SAI cho đúng 2 write path B-1 nhắm tới. Hiện vô hại vì QueryError đã omit params — nhưng nếu T-07 wire helper này vào JSONL sink sẽ KHÔNG bảo vệ được. | `db/int.ts:65-76`; `db/store.ts:517-527` (insertPoolAccounts), `:260` (createAdmin); test `int.test.ts:55` `'plain-string'` → giữ nguyên | CONFIRMED | Làm redact theo vị trí (position-aware: map key → index trong flat array) hoặc để sink chỉ log `err.message`/`r.error.message` |
| **Medium** | Helpers redaction là DEAD CODE: 0 call site production. Grep `redactSql(`/`redactParams(` chỉ ra definition + comment + test. Cách fix THỰC TẾ là "omit params khỏi QueryError" (mạnh hơn redact) — đóng B-1, nhưng helpers như hiện tại chưa "sẵn sàng wire vào T-07" như doc tuyên bố. | `db/int.ts:9,54,65`; `db/result.ts:11`; `__tests__/int.test.ts:6,51-79`; 0 call site ở store.ts/writer.ts/coordinator.ts | CONFIRMED | Wire vào sink T-07 HOẶC xoá khỏi codebase nếu không dùng — không để helpers "hứa" mà không thực thi |
| **Medium** | `db/init.ts:111-113` in toàn bộ `connectionString` ra stdout ("Schema applied"/"Verify mode"). Nếu `LOADTEST_DATABASE_URL` chứa password (URL form `postgresql://user:pass@…`) → credential vào stdout + mọi JSONL sink. CLI admin giảm exposure nhưng vẫn là leak surface. | `db/init.ts:111,113` | CONFIRMED | Mask DSN: `new URL(conn)` → in `host:port/db` hoặc `password → '***'` |
| **Low** | `db/init.ts:132` in plaintext password admin seed ra stdout (có warning "dev local only"). 1 lần lúc seed, nhưng sẽ persist vào log/JSONL nếu có sink. | `db/init.ts:132` | CONFIRMED | In masked hint (vd 4 ký tự đầu) + path file, không in plaintext |
| **Low** | `config.ts:180` log `databaseUrl.slice(0, 24)` khi URL malformed (fail regex `^postgres(ql)?:\/\/`) — có thể lộ prefix `user:pass`. Chỉ trigger khi config sai, edge case. | `config.ts:179-181` | CONFIRMED (edge) | Không log URL; chỉ log prefix scheme + host |
| **Info** | Worker fatal path (worker.ts:54 → coordinator.ts:286) forward `err.message` thô từ uncaught exception. Nếu message chứa token thì vào logs. Ngoài scope B-1, không có bằng chứng hiện tại. | `worker.ts:54`; `coordinator.ts:286` | PLAUSIBLE (pre-existing) | Quan sát — không chặn commit |

### Các hạng mục verify PASS

- **QueryError sạch**: `store.ts:210-241` error chỉ `{ code, message, context }` — KHÔNG sql/params/raw pg error. Type `result.ts:14-18` = `{ code?, message, context? }`. Toàn bộ 20+ log site (writer.ts, store.ts) chỉ log `r.error.message`/`err.message` — pg `err.message` không nhúng SQL text hay param value.
- **`password` column trong SQL text**: `redactSql` đúng hướng — key regex `/(password|secret|token|hash|refresh|otp)/i` bắt được SQL `INSERT INTO pool_accounts (…password…)` (store.ts:529) và thay literal `'...'` → `'[REDACTED]'`. Nhưng không có caller → không phát huy.
- **tool-metrics.ts**: chỉ counters/gauges (`dbWriteFail`, `dbRetry`, `apiErrors`, `workerRestarts`, `runFinished`, `coordinator.rssMb`, `worker.alive`) — không lưu data nhạy cảm. PASS.
- **Helpers export được**: `redactSql`/`redactParams` là `export function` từ `db/int.ts` — import được cho T-07, nhưng cần harden (xem finding Medium #1) trước khi tin tưởng.

### Verdict

B-1 leak (QueryResult mang sql/params) **CONFIRMED FIXED** bằng cách OMIT params (mạnh hơn redact) — không có surface nào hiện tại đưa sql/params vào log/error. **AN TOÀN ĐỂ COMMIT** phần fix B-1. Tuy nhiên: (1) helpers `redactSql`/`redactParams` là dead code + có lỗ hổng cấu trúc với flat-array params — doc tuyên bố "sẵn sàng wire vào T-07 JSONL sink" là QUÁ LẠC QUAN, phải harden trước khi wire; (2) 2 điểm in stdout (`init.ts:111-113` connectionString, `init.ts:132` password) là leak surface nên fix kèm CA-1 trước khi mở JSONL sink.

## T-03 review — Security

Scope: `loadtest/config.ts` (validateEnv, logEnvSources, newRunId), `loadtest/server.ts`, `loadtest/db/init.ts`, `loadtest/.env.example`. Reviewer: Security Architect (HOÀI NGHI). REVIEW ONLY — không sửa code.

### Findings

| # | Severity | File:Line | Finding |
|---|----------|-----------|---------|
| 1 | MEDIUM | `loadtest/db/init.ts:111,113` | Print **full connection string (kèm password)** ra stdout: `[lt][db] Schema applied: ${connectionString}` / `Verify mode — không tạo schema: ${connectionString}`. Chạy bình thường mỗi lần init đều lộ password vào log. Nên redact phần `:password@` (VD dùng `trimDbUrl` in `postgresql://user:***@host:port/db`). |
| 2 | MEDIUM | `loadtest/config.ts:180,201` | Error message URL prefix fail **in 24 ký tự đầu của URL**: `(${env.databaseUrl.slice(0, 24)}...)` — `postgresql://` là 12 ký tự nên phần `user:pass@ho` (12-24) lộ password. Tương tự `LOADTEST_REDIS_URL` (`redis://:password@host:6`). Cần redact password segment trước khi in. |
| 3 | MEDIUM | `loadtest/server.ts:33` | Startup log in full `redis=${env.redisUrl}` — nếu `LOADTEST_REDIS_URL` chứa password (`redis://:pass@...`) sẽ lộ. Nên redact hoặc in `redis=***`. |
| 4 | LOW-MEDIUM | `loadtest/config.ts:172` | Placeholder rejection **lệch design**: DESIGN-prod-refactor.md quy định pattern `/\/\/user:/i` nhưng implementation chỉ có exact-match `=== PLACEHOLDER_DB_URL` + regex `/(appuser\|:secret@)/i`. Biến thể generic như `postgresql://user:pass@host:5432/db` (lowercase, copy placeholder rồi sửa) **lọt qua validation** và đi connect thật. Thêm `/\/\/user:/i` cho khớp design. |
| 5 | LOW | `loadtest/db/init.ts:132` | Khi set `LOADTEST_ADMIN_PASSWORD` từ env, dòng print `PASSWORD ... ${password}` in password operator-set ra stdout (không phân biệt với password tự sinh). Lộ secret operator-set vào log. |
| 6 | LOW | `loadtest/api-server.ts:289-296` (pre-existing, liên quan newRunId) | `POST /cleanup` nhận `body.runId` **không validate charset** rồi dùng trong `poolPath(dataDir, runId)` = `path.join(dataDir, 'accounts-'+runId+'.json')`. `runId='../../../x'` → path traversal ngoài dataDir (đọc file nếu tồn tại, try/catch nuốt lỗi → `accounts=[]`). Đã có auth (Bearer) nên impact thấp, nhưng nên validate `^lt[0-9a-z]+$`. |
| 7 | INFO | `.env.example` | Thiếu doc `LOADTEST_ADMIN_USERNAME/EMAIL/PASSWORD/SEED_ADMIN` (chỉ ở header init.ts). Không có credential thật. |

### Verify PASS

- **Secret hygiene**: `grep appuser:secret` trong `config.ts`/`db/init.ts`/`.env.example` = **0**. Chỉ còn ở test fixtures (`__tests__/*.test.ts`) — đã được phép + nằm sau path allowlist gitleaks. Plugin regex `/(appuser\|:secret@)/i` trong validateEnv là pattern check, không phải credential.
- **logEnvSources** (`config.ts:78-95`): in **chỉ KEY NAMES + source** (`${key} ← ${source}`), KHÔNG in value. PASS.
- **Fail-fast**: `server.ts:19-25` — validateEnv trước, `exit(1)` khi có error, **trước khi** mở service/DB. DB URL unset → placeholder → bị bắt bởi `=== PLACEHOLDER_DB_URL` → exit với message rõ ràng. Không connect với undefined. PASS.
- **OTP/AUTH min 32**: khớp thực tế — cả hai đều là `crypto.createHmac('sha256', secret)` (auth.ts:41, auth-factory.ts:72) → 256-bit key cần ≥32 bytes. Không quá lỏng cũng không quá chặt. Điểm hay: gateway còn fallback `OTP_SECRET || 'secret'` (yếu) — validateEnv 32-char bên loadtest sẽ reject đúng khi gateway đang chạy HMAC yếu. PASS.
- **newRunId charset**: `lt` + base36-ts + base36-pid + base36-seq → charset `[0-9a-z]`, không có `/`, `.`, `..` → an toàn cho file path + DB PK, không path traversal. Predictability từ pid (0-46655) + ms + seq là **không phải vấn đề** — run id không phải secret và vẫn enumerate được qua `GET /runs` (đã auth). Mục đích của seed là uniqueness sau restart (B-4), đạt. PASS.

### Verdict

**PASS với follow-up** — an toàn để commit. Mục tiêu cốt lõi của T-03 đạt: xoá credential hardcode, fail-fast trước khi mở service, debug không lộ value, 32-char min nhất quán với HMAC-SHA256. Các finding #1-#3 rất đáng sửa (redact URL trong log/error — cùng một tinh thần "không lộ secret" mà T-03 đang theo đuổi) nhưng **không phải blocker** vì secret chỉ nằm trong log của chính operator, không vào code. #4 nên sửa để khớp design. #6 là pre-existing của cleanup endpoint, không phải regression của newRunId.

## T-05 review — Performance

Reviewed by: Performance Benchmarker (HOÀI NGHI). REVIEW ONLY — không sửa code.
Date: 2026-08-04.
Scope: hot path ghi metric (writer.ts flush → store.ts insertMetricSamples → query wrapper), parseBigInt/normalizeBigIntRows, redaction, history route 503, batch insert.

### Findings

| Severity | Finding | Evidence | Verdict | Fix |
|---|---|---|---|---|
| INFO | `redactSql`/`redactParams` là dead code — KHÔNG được gọi ở store.ts hay bất kỳ đâu trong code (chỉ định nghĩa + unit test). Trả lời câu hỏi adversarial: redaction KHÔNG chạy mỗi query, KHÔNG chạy mỗi error — zero overhead. Nhưng lệch DESIGN-prod-refactor.md §4.2 (read query error phải chứa `sql/params` đã redact): store.ts bỏ hẳn sql/params khỏi error (store.ts:229 — an toàn hơn redact, nhưng doc hứa "sẵn sàng wire T-07" là không có code). | Grep: `redactSql`/`redactParams` chỉ khớp int.ts:54/65, int.test.ts:6, docs. Không có call site production. | CONFIRMED (không perf impact) | Không cần fix cho perf; harden hoặc xoá trước khi wire vào T-07 (đã có finding tương tự ở review B-1). |
| INFO | `normalizeBigIntRows` duyệt cả 7 key `BIGINT_FIELDS` cho mọi row, dù row chỉ có 1-2 cột int8. Chỉ chạy trên SELECT (history endpoint low-freq), KHÔNG trên write path. `listMetricSamples` limit 20000 → 7×20k = 140k check `key in row` + type-check — vẫn <1ms, không regex. | store.ts:136-146; `listMetricSamples` limit ≤20000 (store.ts:392). | CONFIRMED (micro) | Không cần fix; nếu muốn: build danh sách field cần normalize theo từng query. |
| INFO | Perf-sensitive code thiếu test khối lượng thực: `store.test.ts` insertMetricSamples chỉ 2 samples (batch 500-row không test); `int.test.ts` pure function nhỏ. Không test normalizeBigIntRows nhiều rows / max batch. | store.test.ts:170-201; int.test.ts. | CONFIRMED | Bổ sung test volume (500-row batch, 20k-row read) nếu muốn chặn hồi quy perf — không blocker. |

### Verify PASS

- **Write path vẫn single multi-row INSERT**: `insertMetricSamples` (store.ts:386) build 1 statement `INSERT INTO metric_samples (...) VALUES (...), (...), ...` → 1 lần gọi `this.query`. KHÔNG thành N insert riêng. 500 tick/batch → 1 statement 500 rows. Không autocorrect thành per-row.
- **QueryResult wrapping zero overhead trên write path**: `insertMetricSamples`/`insertRun`/`insertLogEvent`/`insertPoolAccounts`/`upsertPool` đều KHÔNG có RETURNING → `res.rows = []` → `normalizeBigIntRows([])` no-op (store.ts:221). Chỉ SELECT (admin/history) bị normalize.
- **parseBigInt rẻ, regex-free**: `Number(s)` + `Number.isSafeInteger` (int.ts:14-27), không regex per cell. Chỉ gọi khi cột int8 (OID 20) hiện diện trong row — không trên write path.
- **Redaction không trên hot path**: như finding INFO — không chạy mỗi query, không chạy mỗi error.
- **Failure counting O(1)**: `toolMetrics.inc('dbWriteFail')` là object increment (tool-metrics.ts:34-36), chỉ trên error branch (store.ts:212/227/239). Không có work mới trên success path.
- **Flush cadence giữ nguyên**: `FLUSH_INTERVAL_MS = 30_000`, `MAX_PENDING_TICKS = 500` (writer.ts:21-22); `pushTick` → `flushTicks` (writer.ts:110) với guard `flushing` chống chồng. Retry path (writer.ts:122-132) chỉ chạy khi DB fail — O(n) copy array ≤1000 phần tử mỗi 30s, không đáng kể.
- **History 503 chỉ trên error branch**: `if (!rows.ok) return this.fail(res, 503, ...)` (api-server.ts:343/352/355/365/372/380) — 1 branch-check boolean trên normal path, không thêm DB round-trip. `countMetricSamples` là query thứ 2 trên GET /metrics — pre-existing, history endpoint low-freq, không phải hot-path.
- **Tải thực tế thấp hơn premise**: coordinator ghi 1 row/s per RUN (aggregateTick 1s → 1 MetricSampleRow, bất kể user count — coordinator.ts:331-362), không phải 1 row/s/user. Batch flush ~30 rows/30s (hoặc 500 nếu timer miss). Volumetric premise "5k rows/s" của task không khớp code — hot path càng nhẹ.

### Verdict

**HOT PATH KHÔNG bị degrade.** QueryResult refactor + parseBigInt + normalizeBigIntRows thêm ~0 overhead vào metric write path (rows rỗng trên INSERT → no-op); batch insert vẫn single multi-row statement; flush 30s/500-tick giữ nguyên; dbWriteFail O(1) chỉ trên error. Không có lỗi nào cần chặn commit. Lưu ý duy nhất (INFO, không perf): redaction helpers là dead code — cần harden/xoá trước khi wire T-07, đã có finding riêng ở review B-1.

## T-05 review — Code Review

Reviewed by: Code Reviewer (HOÀI NGHI). REVIEW ONLY — không sửa code.
Date: 2026-08-04.
Scope: QueryResult contract (result.ts), redaction (int.ts), BIGINT (int.ts/store.ts), float→BIGINT fix (writer.ts), fail-fast (store.ts/server.ts/config.ts), history 503 (api-server.ts + frontend loadtest-api.ts/RunDetailPage/HistoryPage), tool-metrics wiring, tests.

### Findings

| Severity | Finding | Evidence | Verdict | Fix |
|---|---|---|---|---|
| MINOR | `redactParams` KHÔNG redact params dạng flat string — shape thật của `insertPoolAccounts`/`createAdmin` (params là `a.password`, `input.passwordHash` string phẳng, store.ts:260/523), helper chỉ redact object-keyed params. Unit test chỉ cover object params (int.test.ts:51-66) → cảm giác an toàn sai. Hiện là dead code (không gọi trong store.ts) + error path bỏ hẳn sql/params (store.ts:229) nên KHÔNG có leak production; nhưng contract doc (result.ts:11, int.ts:9) hứa "chặn password/secret/hash" là không đúng với shape thật. | int.ts:65-77; store.ts:260/523; int.test.ts:51-66 | CONFIRMED (latent, không impact hiện tại) | Nếu wire vào T-07: redact cả string param đứng cạnh cột sensitive (theo index) hoặc bỏ helper; trước tiên sửa doc/test để không hứa sai. |
| MINOR | `dbWriteFail` double-count trên path overflow: 1 lần fail insertMetricSamples → store.query() đã inc (store.ts:227) + writer.ts overflow drop inc lần 2 (writer.ts:128). Một fail = count 2 → metric Prometheus bị thổi phồng (không sai hướng, chỉ sai lượng). | writer.ts:119-129; store.ts:227 | CONFIRMED (metric imprecision) | Chọn 1 trong 2: chỉ inc ở writer (drop) hoặc chỉ ở store; hoặc đổi tên metric (dbWriteFail vs dbDrop). |
| INFO | `first()` helper dead code — không import/use bất kỳ đâu (production lẫn test). Đúng contract nhưng thêm API surface thừa. | result.ts:29-31; grep `first(` chỉ khớp result.ts | CONFIRMED | Xoá hoặc dùng ở 1-2 caller (vd getRun) để test. |
| INFO | `redactSql` over-redact: khi SQL có cột sensitive, mọi string literal bị [REDACTED] (kể cả email legit). An toàn hướng bảo mật (conservative), không phải bug. | int.ts:54-59 | CONFIRMED (safe direction) | Không cần fix; note trong doc. |
| INFO | Counter tích luỹ global cho cả đời process, không reset per run — đúng chuẩn Prometheus counter (reset() chỉ dùng test). Delta giữa 2 snapshot là ý nghĩa. | tool-metrics.ts:23-31, writer/writeRun không gọi reset | CONFIRMED (by design) | Không cần fix. |
| INFO | Escape hatch `LOADTEST_DB_REQUIRED=false` (mặc định true) → connect() fail chỉ warn + DB disabled, server chạy không ghi history. Là log-cảnh báo rõ + bị chặn khi NODE_ENV=production (validateEnv:171 bắt buộc DB URL) → bounded dev-only. Không phải silent. | store.ts:171-179; config.ts:116/171; server.ts:39-40 | CONFIRMED (by design) | Không cần fix; đã có warning log. |

### Verify PASS

- **QueryResult contract nhất quán — KHÔNG caller nào dùng `rows` khi `!ok`.** Rà toàn bộ call site: writer.ts (12 chỗ: writeRunStart:80, writeRunFinish:102, flushTicks:120, writeLog:156, writePool:185/206/212-214/224/233, importLegacyPools:267/271/290/306), api-server.ts (pools:315-316, runs:343, metrics:352/355, logs:365, getRun:372-373, deleteRun:380-381, auth:406-411/424-426/450-451), store.test.ts:23, api-server.test.ts:22. Mọi chỗ check `!ok` → return/log TRƯỚC khi touch `rows`. Không có bug `rows` undefined trên error.
- **Fail-fast đúng**: `connect()` throw khi dbRequired (store.ts:171-174) → server.ts main() catch → `process.exit(1)` (server.ts:65-68). `ensureSchema`/`DbWriter.startup` throw lan lên main() cùng exit 1. Escape hatch chỉ khi set tường minh `LOADTEST_DB_REQUIRED=false` + non-production.
- **Float→BIGINT fix đầy đủ**: `toEpochMs` dùng `Math.trunc` (int.ts:33); áp dụng tại điểm insert mtimeMs duy nhất (writer.ts:288). auth-factory.ts:119 dùng raw mtimeMs nhưng chỉ sort/so sánh JS, không insert DB → không cần trunc. Test assert `pool.createdAt === Math.trunc(mtimeMs)` (store.test.ts:329).
- **BIGINT parse đúng biên**: bỏ global int8 parser, parse theo field whitelist (BIGINT_FIELDS — store.ts:134); `countMetricSamples` dùng `COUNT(*)::int` (không phải bigint) nên không cần normalize; `parseBigInt` chặn >2^53 (int.ts:17-18).
- **History 503 shape khớp frontend**: `fail()` → `{ success:false, statusCode:503, message:'Database lỗi', error:'DB_UNAVAILABLE' }` (api-server.ts:91-93); frontend `toApiError` đọc `statusCode`+`message` (loadtest-api.ts:36-45); HistoryPage:44-46 và RunDetailPage:71-73 catch → hiện message, không crash. RunDetailPage: `Promise.all` reject → `error && !detail` → màn hình lỗi + nút quay lại (không treo).
- **tool-metrics wiring đúng chỗ**: dbWriteFail tại store.ts:212 (DB disabled write), 227 (non-transient write non-business), 239 (retry exhausted), writer.ts:128 (overflow drop); dbRetry tại store.ts:231. Business error (23505/23503/22P02) KHÔNG tính dbWriteFail (store.ts:227) — đúng chính sách.
- **Typecheck + test xanh**: `npm run loadtest:typecheck` pass (0 lỗi); `npm run loadtest:test` 10 files / 116 tests pass (có store.test.ts 15, api-server.test.ts 17, int.test.ts 10 — DB integration thật chạy được).

### Verdict

**SAFE TO COMMIT.** Không có blocker. QueryResult contract áp dụng nhất quán 100% call site (không bug `rows` undefined khi error); fail-fast exit≠0 đúng; redaction không leak (error bỏ hẳn sql/params — an toàn hơn redact); float→BIGINT trunc đúng; history 503 shape khớp frontend, không crash. 2 MINOR (redactParams không cover flat-string params — dead code nên chưa có impact; dbWriteFail double-count trên overflow path) + 4 INFO (dead code `first()`, over-redact conservative, counter global by design, escape hatch dev-only) — giải quyết trước khi wire T-07, không chặn PR này.
## T-04 review — DBRE

Reviewed by: Database Reliability Engineer (HOÀI NGHI). REVIEW ONLY — không sửa code.
Date: 2026-08-04.
Scope: `loadtest/db/migrate.ts` (runner), `migrations/001_init.sql`, `cleanup.ts`, `store.ts ensureSchema` (B-5), `init.ts`, `package.json` scripts, `migrate.test.ts`. Đã chạy `npm run loadtest:typecheck` (pass) + `npm run loadtest:test` (116/116 pass, trong đó 8 test migrate chạy thật trên Postgres localhost:5439 — không bị skip).

### Findings

| Severity | Finding | Evidence | Verdict | Fix |
|---|---|---|---|---|
| LOW | `rollbackOne` (migrate.ts:164): `Math.max(1, Math.floor(opts.steps ?? 1))` — nếu caller truyền `steps: NaN` (chỉ reachable qua API library, CLI đã guard), `slice(-NaN)` → `slice(0)` → rollback **toàn bộ** migration thay vì 1. CLI `parseSteps` đã chặn NaN (migrate.ts:201-206), nên không reachable qua CLI — nhưng là footgun API. | migrate.ts:164, 201-206 | PLAUSIBLE (defensive) | `Number.isInteger(opts.steps) && opts.steps > 0 ? opts.steps : 1` |
| LOW | `cleanup.ts` — 2 DELETE (runs, pools) KHÔNG chung transaction: DELETE runs thành công + DELETE pools fail → cleanup một phần, không rollback. Manual maintenance script nên chấp nhận được. Đồng thời không `VACUUM (ANALYZE)` sau mass DELETE (metric_samples có thể hàng triệu row) — dead tuple không được thu hồi đến autovacuum chạy. | cleanup.ts:57-61 | CONFIRMED (không blocker) | Bọc trong 1 transaction; thêm vacuum sau khi xoá > ngưỡng |
| INFO | Baseline `CREATE TABLE IF NOT EXISTS` chỉ đảm bảo **bảng tồn tại**, không reconcile **thiếu cột** trên bảng cũ (R-4). Hiện tại 001_init.sql UP section = schema.sql **zero diff** (verify bằng diff 109/109 dòng khớp) nên không còn drift — nhưng DB cũ có bảng thiếu cột thì 001 không tự thêm; cần migration 002+ `ADD COLUMN IF NOT EXISTS` (đúng convention đã ghi). | 001_init.sql UP vs schema.sql (diff = 0) | CONFIRMED (chấp nhận theo design) | Giữ convention; không cần fix hôm nay |
| INFO | Test chưa phủ: (a) baseline scope fail-fast khi có migration tương lai (B-5) — chỉ test happy path; (b) rollback fail giữa chừng → schema_version nhất quán; (c) cleanup.ts; (d) concurrency/`pg_advisory_lock` thật (2 process chạy cùng lúc). DB thiếu → suite **skip âm thầm** (CI không có Postgres vẫn pass+0 test). | migrate.test.ts:75-189 | CONFIRMED (coverage gap) | Thêm test fail-fast + concurrency; CI gắn Postgres service để không skip |
| INFO | `down --steps 0` / `--steps abc` → parseSteps fallback về 1 (rollback 1 bước, không phải 0) — fail-safe (rollback ít, không nhiều) nhưng im lặng, không cảnh báo người dùng typo. | migrate.ts:201-206 | CONFIRMED (minor UX) | Cảnh báo khi `--steps` không hợp lệ |

### Verify PASS

- **Transaction safety**: mỗi migration trong BEGIN/COMMIT riêng; `INSERT schema_version` trong CÙNG transaction với UP (migrate.ts:143-153) → fail giữa chừng → ROLLBACK, schema_version giữ nguyên giá trị cũ — nhất quán. `pg_advisory_lock` được giữ nguyên suốt run (acquire trước try, unlock trong finally — migrate.ts:110, 139); `loadMigrations()` throw trước khi acquire → không orphan lock. PASS.
- **Baseline detect (R-4)**: `CREATE TABLE IF NOT EXISTS` xử lý DB có 1 phần bảng — bảng thiếu được tạo, bảng có sẵn no-op; test thực tế chứng minh up-lại không xoá dữ liệu (migrate.test.ts:123-138). PASS.
- **DOWN order**: đúng reverse-FK — metric_samples, log_events (FK→runs) → pool_accounts (FK→pools) → runs → pools → schema_version → admin_users (001_init.sql:163-169). DOWN trên DB chưa up → version=0 → `appliedMigrations` rỗng → no-op, không lỗi (migrate.ts:169-170). PASS.
- **Version tracking**: DELETE version + DOWN trong cùng transaction (rollback lại nếu DOWN fail) → sau down version đúng 0 (test xác nhận). PASS.
- **SQL injection**: migration là file repo đọc trực tiếp, không có user input trong SQL path; `--steps` chỉ điều khiển số bước, validate bằng `Number.isInteger` (không phải eval). PASS.
- **Schema/metric_samples**: 001 UP = schema.sql (109/109 dòng khớp, zero drift); `idx_metric_samples_run(run_id, ts)` đúng cho query `WHERE run_id=$1 ORDER BY ts ASC` (store.ts:403). PASS.
- **cleanup**: `--older-than` regex `/^(\d+)([dhms])?$/` validate cứng (cleanup.ts:27); từ chối run `running` (`status <> 'running'`); cascade metric_samples+log_events qua FK; KHÔNG đụng admin_users. PASS.
- **ensureSchema (B-5)**: DB đã migrate → pending rỗng → no-op; DB trống → chỉ apply 001; có migration tương lai → throw fail-fast (server không start). `store.connect()` (server.ts:40) chạy trước `dbWriter.startup()`/`ensureSchema` (writer.ts:45) nên pool đã sẵn sàng. PASS.

### Verdict

**PASS — an toàn để commit.** Cốt lõi DBRE chuẩn: transaction atomic, advisory lock, version tracking nhất quán, DOWN reverse-FK đúng, schema không drift, cleanup không đụng run đang chạy/admin_users. Các finding đều LOW/INFO, không blocker. Khuyến nghị theo dõi: #1 (NaN guard) và #2 (cleanup transaction + vacuum) là hardening nhanh nên làm khi có dịp; #4 (test fail-fast + concurrency) là món nợ phòng thủ — đặc biệt test concurrency vì đây là bảo vệ duy nhất cho advisory lock.

## T-04 review — API Tester

Reviewed by: API Tester critic (HOÀI NGHI). REVIEW ONLY — không sửa code.
Date: 2026-08-04.
Scope: migration runner CLI (`loadtest/db/migrate.ts`) + `package.json` scripts vs Phụ lục B, fail-fast/error-path behavior, `--steps` parsing, `migrate.test.ts` isolation. Đã chạy thật CLI (foreground) với DB không reachable (password trong `loadtest/.env` stale so với instance Postgres 5439) + chạy `vitest` migrate suite.

### CLI outputs observed (chạy thật, DB auth fail — dirty-path)

| Command | stdout/stderr | Exit | Notes |
|---|---|---|---|
| `npm run loadtest:db:status` | `[lt][db] migrate fail: password authentication failed for user "appuser"` | 1 | Clean, không hang, không stack trace |
| `npm run loadtest:db:up` | `[lt][db] migrate fail: password authentication failed for user "appuser"` | 1 | Clean — không hang, không nuốt lỗi |
| `npm run loadtest:db:down` | `[lt][db] migrate fail: password authentication failed for user "appuser"` | 1 | Clean, fail-fast |
| `npm run loadtest:db:cleanup` (thiếu arg) | `[lt][db] cleanup fail: Thiếu --older-than N (VD: --older-than 30d, 12h, 60m)` | 1 | Error rõ ràng |
| `npm run loadtest:db:cleanup -- --older-than 30d` | `[lt][db] cleanup fail: password authentication failed for user "appuser"` | 1 | Clean |
| `npx tsx loadtest/db/migrate.ts bogus` | `Usage: npx tsx loadtest/db/migrate.ts <up\|down\|status> [--steps N]` | 1 | Usage + exit 1 |

### Findings

| Severity | Finding | Evidence | Verdict | Fix |
|---|---|---|---|---|
| **Minor** | `--steps` không validate hard — mọi giá trị lỗi đều fallback im lặng về 1, không error/warning. `--steps 0` → 1, `--steps abc` → 1, `--steps -2` → 1, `--steps` (trailing) → 1. Trên path `down` (destructive — drop bảng), `--steps 0` NGƯỜI DÙNG CỐ Ý "không rollback" vẫn bị rollback 1 bước — typo `--steps abc` cũng bị nuốt. Xác nhận bằng chạy `parseSteps` (migrate.ts:201-206) + `rollbackOne` `Math.max(1, Math.floor(...))` (migrate.ts:164). Trùng DBRE INFO #4 — xác nhận độc lập. | migrate.ts:201-206, 164; node eval: `--steps 0`→1, `--steps abc`→1 | CONFIRMED | Warn/error khi `--steps` không hợp lệ thay vì fallback im lặng |
| **Minor** | Error khi migration fail KHÔNG nêu rõ migration nào fail. `applyOne`/`rollbackOne` throw raw pg error (migrate.ts:143-153, 173-181); CLI catch chỉ in `err.message` (migrate.ts:250). Với nhiều migration, không biết file nào hỏng — vì chỉ có 001 hiện tại nên latent, nhưng là gap của item 5. | migrate.ts:143-153, 250 | CONFIRMED (latent) | Wrap error kèm filename: `Migration ${m.filename} fail: ${err.message}` |
| **Minor** | Test suite dùng credential CŨ `appuser:secret` (migrate.test.ts:15) — hôm nay 8/8 pass CHỈ VÌ instance 5439 vẫn nhận password cũ. Sau khi áp bước README "apply DB password mới lên instance", probe fail → suite **skip âm thầm** (không 1 test, vẫn pass CI). Coverage mất không có tín hiệu. | migrate.test.ts:14-15, 30-41; vitest run 8/8 pass thật (không skip) | CONFIRMED (temporal coupling) | Set `LOADTEST_TEST_MIGRATE_DATABASE_URL` sang credential mới (hoặc env trong CI) khi xoay password |
| **Minor** | Env precedence ngược: `config.ts:100` `{ ...process.env, ...fromFile, ...overrides }` — file `.env` override process.env. Xác nhận: set `LOADTEST_DATABASE_URL` trong env KHÔNG có tác dụng, `getEnv()` trả giá trị từ `.env`. Không thể trỏ CLI sang DB khác bằng env var (phải sửa `.env`). Pre-existing config.ts (T-03 scope), nhưng ảnh hưởng tính vận hành của CLI. | config.ts:100; chạy thật: env override bị bỏ qua | CONFIRMED (pre-existing) | Đảo precedence: `{ ...fromFile, ...process.env, ...overrides }` (convention: process.env > .env file) |
| **Info** | CLI `pg.Client` không set `connectionTimeoutMillis`/`statement_timeout` (migrate.ts:222). Auth failure fail-fast (đã verify — trả về ngay), nhưng host unreachable (packet drop) có thể hang vô hạn thay vì fail-fast. | migrate.ts:222 | CONFIRMED (edge) | Set `connectionTimeoutMillis: 5000` |

### Verify PASS

- **Fail-fast đúng**: cả 4 command đều exit 1 + message rõ ràng, KHÔNG hang, KHÔNG stack trace. R-1 (không nuốt lỗi) đạt. `status`/`up`/`down`/`cleanup` đều fail sạch khi DB auth lỗi.
- **package.json scripts khớp Phụ lục B**: `loadtest:db:up` = `tsx loadtest/db/migrate.ts up`; `down`/`status` đúng; `loadtest:db:cleanup` = `tsx loadtest/db/cleanup.ts` (Phụ lục B thêm `-- --older-than 30d` — script bắt buộc arg, đúng). Khớp 100%.
- **Test isolation**: DB riêng `loadtest_test_migrate` (không đụng `loadtest`); module-load probe (3s timeout) → DB down thì skip toàn bộ suite; `beforeEach` reset (drop 7 bảng); `afterAll` restore baseline (`runMigrations scope:'all'`) — tự dọn sau. Chạy thật: 8/8 pass, không bị skip (đã verify đây là DB thật, không phải skip).
- **CLI parse** (`--steps 3` → 3 đúng; default 1 đúng) — chỉ vấn đề ở giá trị lỗi (finding #1).

### Verdict

**AN TOÀN ĐỂ COMMIT — không blocker.** Mục tiêu cốt lõi T-04 đạt: CLI fail-fast đúng (exit 1, message rõ, không hang, không stack trace) khi DB không reachable; scripts khớp Phụ lục B; test dùng DB riêng + tự dọn. Các finding Minor/Info không chặn commit: #1 (`--steps` fallback im lặng) và #2 (error thiếu filename) nên fix khi có dịp — #2 quan trọng hơn khi thêm migration 002+; #3 là nợ theo thời gian (nhớ set `LOADTEST_TEST_MIGRATE_DATABASE_URL` khi xoay password); #4 là pre-existing config.ts (T-03) nên đưa vào backlog T-03; #5 edge case.

## T-03 review — Code Review

Reviewed by: Code Reviewer critic (HOÀI NGHI). REVIEW ONLY — không sửa code.
Date: 2026-08-04.
Scope: `loadtest/config.ts` (validateEnv, PLACEHOLDER_DB_URL, dbRequired default true, newRunId fix, logEnvSources), `loadtest/server.ts` (validateEnv tại startup), `loadtest/db/init.ts` (placeholder default), `loadtest/.env.example`, `loadtest/__tests__/config.test.ts`. Đã chạy `npm run loadtest:typecheck` (pass) + `npm run loadtest:test` (116/116 pass) + chạy thật `npx tsx loadtest/server.ts`.

### Findings

| Severity | Finding | Evidence | Verdict | Fix |
|---|---|---|---|---|
| **HIGH** | Regex `/(appuser\|:secret@)/i` (config.ts:172) là substring match, **false-positive** trên chính `.env` dev của repo: `postgresql://appuser:GwdAb8v…@localhost:5439/loadtest` chứa `appuser` (username) → `npm run loadtest:server` **exit(1)** với lỗi "thiếu/placeholder/default credential" dù URL thật đã cấu hình. Chạy lại xác nhận: `tsx loadtest/server.ts` → exit 1. Security review T-03 đã bỏ qua cái này (xem regex là "pattern check"). Đây là regression chặn dev dùng server. | config.ts:172; loadtest/.env:26; `npx tsx loadtest/server.ts` → `EXIT: 1`; regex test `true` cho `appuser:realpass@…` | CONFIRMED | So khớp chính xác chuỗi default cũ `postgresql://appuser:secret@localhost:5439/loadtest`, hoặc parse URL rồi so username/password literal với `appuser`/`secret`. Không dùng substring |
| **MEDIUM** | Nhánh `:secret@` cũng false-positive khi password **đúng bằng** `secret` (case-insensitive). Các biến thể khác KHÔNG dính: password `mysecret1` → `false` (không bị từ chối), host chứa "secret" → `false`. Vậy câu hỏi adversarial "password 'mysecret1' có bị từ chối nhầm?" → **KHÔNG**. Nhưng cùng root cause #1 — check quá thô. | regex test: `user:secret@…` → true; `user:mysecret1@…` → false; `user:pw@secret-host…` → false | CONFIRMED | Gộp vào fix #1 (so khớp chuỗi/parse URL) |
| **LOW** | Placeholder rejection chỉ exact-match `=== PLACEHOLDER_DB_URL` — biến thể generic `postgresql://user:pass@host:5432/db` (copy placeholder rồi sửa, lowercase) **lọt** validation. Impact được giảm: dbRequired=true → `store.connect()` throw (store.ts:171-174) → server vẫn exit(1), nhưng message muộn + kém rõ ràng hơn. Lệch DESIGN (`/\/\/user:/i`). | config.ts:172; thử nghiệm trong test `sai prefix DB URL` (mysql) chỉ phủ prefix sai, không phủ generic URL | CONFIRMED | Thêm `/\/\/user:/i` theo design, hoặc chặn pattern `://user:pass@` generic |
| **LOW** | Test newRunId không pin đúng fix "full timestamp". Test "restart" (`vi.resetModules`) **có** bắt được bug cũ `slice(-6)` trong thứ tự cụ thể này (2 call cùng pid, cùng 25-ngày window, seq=1==1 → old code cho id trùng → test fail), nên **không vô nghĩa** — nhưng vì `pidPart` tính ở module load giữ nguyên qua reset, test chỉ pass nhờ seq=1 trùng nhau, không do full-timestamp. Không có test mock `Date.now` để ép same-ms restart. | config.test.ts:170-177; config.ts:309-317 | CONFIRMED (weak, không vacuous) | Mock `Date.now` cố định để verify id vẫn khác nhờ pid/seq; thêm assert độ dài/format đủ (full ts) |
| INFO | Fail-fast semantics **lệch nhau** giữa 2 entry: `db/init.ts:90` chỉ chặn exact placeholder, `server.ts` qua `validateEnv` còn chặn `appuser`/`secret` substring. Dev có URL `appuser` chạy được `db/init.ts` nhưng `loadtest:server` chết — thể hiện rõ #1. | init.ts:89-96 vs config.ts:172 | CONFIRMED | Dùng chung 1 helper guard (exact URL) cho cả 2 |
| INFO | newRunId fix **đúng**: full timestamp + `pid%46656` + seq. Same-ms sau restart → pid khác → id khác; same-ms cùng process → seq khác; charset `[0-9a-z]` an toàn cho file path + DB PK (run_id); không collision với format cũ (độ dài khác: 15 vs 13 chars). | config.ts:309-317; xác nhận test pass | CONFIRMED (PASS) | Không cần fix |

### Verify PASS

- **Placeholder rejection**: exact-match `=== PLACEHOLDER_DB_URL` bắt đúng URL `postgresql://USER:PASS@HOST:PORT/DB` (user quên set URL → error, không silent connect). Test `dbRequired=true (mặc định) + placeholder → error` pass. (Trừ false-positive #1 khi URL thật chứa `appuser`.)
- **OTP_SECRET min 32**: `.env` dev có 64-hex (`1f91…`) → pass; empty trong dev → chỉ warning (không error) — test `dev + dbRequired=false + thiếu key → không error` pass. Production empty → error. Đúng.
- **Escape hatch "không muốn DB"**: `LOADTEST_DB_REQUIRED=false` → validateEnv bỏ check DB (tắt error), `store.connect()` warn + DB disabled (store.ts:175-178). Đã document trong `.env.example:28-29`. Hợp lệ.
- **server.ts fail-fast**: `validateEnv` chạy TRƯỚC `store.connect()` (server.ts:19-25 vs 39-40), error → `process.exit(1)` (exit code khác 0 — xác nhận bằng chạy thật). PASS.
- **db/init.ts với URL thật**: `loadDotEnv` đọc `loadtest/.env` → `connectionString` = URL thật → không bằng placeholder → proceed. Fail-fast message chỉ trigger khi đúng placeholder. PASS (trừ lệch semantics #INFO).
- **logEnvSources**: chỉ in key names + source (`${key} ← ${source}`), không in value. Không leak secret. PASS.
- **Tests**: `npm run loadtest:typecheck` pass; `npm run loadtest:test` pass 116/116 (config.test.ts 19 tests). Các test validateEnv đều **có nghĩa** (đặt input cụ thể, assert severities/key cụ thể — không vacuous). Điểm yếu: không test nào phủ URL thật chứa `appuser` → để lọt bug #1.

### Verdict

**KHÔNG AN TOÀN ĐỂ COMMIT tới khi xử lý #1 (HIGH).** Cốt lõi T-03 đạt: xoá credential hardcode, fail-fast trước khi mở service (exit 1), debug không lộ value, 32-char OTP/AUTH nhất quán HMAC-SHA256, newRunId fix đúng. Nhưng regex `appuser` substring khiến **server không start được với chính `.env` dev đang có** — đây là regression trực tiếp phá luồng dev (T-01 đã ghi nhận `.env` dev dùng `appuser`). Fix #1 là 3 dòng (so khớp chuỗi exact default cũ thay vì substring) — sửa xong rồi commit. #2 cùng root cause, sửa chung. #3-#6 LOW/INFO theo dõi, không chặn.

## W1 Reality Check

Reviewed by: Reality Checker (mặc định FAIL). REVIEW ONLY — không sửa code.
Date: 2026-08-04.
Scope: T-03 config fail-fast, T-04 migration runner, T-05 DB store correctness. Đã chạy thật mọi lệnh (không dựa trên đọc code).

### Evidence table

| # | Check | Command / nguồn | Kết quả thực | Verdict |
|---|---|---|---|---|
| 1 | Không hardcode credential live | `grep -c "appuser:secret"` config.ts/init.ts/.env.example | config.ts:1 (`DEFAULT_DEV_DB_URL` — chuỗi known-bad **bị chặn cứng** bởi `isKnownBadDbUrl` exact-match, config.ts:30-32/196); init.ts:0; .env.example:0 | PASS (1 match là guard chủ động, không phải credential dùng được) |
| 2 | Fail-fast URL sai | `LOADTEST_DATABASE_URL=wrong npx tsx loadtest/server.ts` | `EXIT:1`, `[env] LOADTEST_DATABASE_URL: phải bắt đầu bằng postgres://... (hiện: wrong...)` — redacted, không hang, **không stack trace** | PASS |
| 3 | Fail-fast connect fail | `LOADTEST_DATABASE_URL=postgresql://foo:bar@localhost:59999/nope npx tsx loadtest/server.ts` | `EXIT:1`, `[lt][FATAL] Error: Không kết nối được Postgres (LOADTEST_DB_REQUIRED=true)` — controlled fatal, có stack frame (caveat nhỏ) | PASS (caveat: stack trace hiện diện, nhưng là FATAL log có message rõ, không phải unhandled exception) |
| 4 | Escape hatch dbRequired | `grep -n "dbRequired" loadtest/config.ts` | Flag tồn tại (config.ts:60), default `true` (config.ts:140), validateEnv chỉ check khi `dbRequired || production` (config.ts:195) | PASS |
| 5 | db:status với password stale | `npm run loadtest:db:status` | `EXIT:1`, `migrate fail: password authentication failed for user "appuser"` — fail sạch, không hang (EXPECTED — user chưa apply password mới) | PASS (expected) |
| 6 | Migration UP/DOWN | Đọc `loadtest/db/migrations/001_init.sql` | UP = 7 `CREATE TABLE IF NOT EXISTS` (schema_version, admin_users, runs, pools, pool_accounts, metric_samples, log_events); DOWN drop theo thứ tự đảo FK (metric_samples, log_events → pool_accounts → runs, pools → schema_version, admin_users) | PASS |
| 7 | Test suite | `npm run loadtest:test` | **134/134 passed (10 files)**, migrate.test.ts 14 tests (task ghi 8 — thực tế 14, phủ nhiều hơn); store.test.ts 15 tests chạy trên DB `loadtest_test` thật (không skip) | PASS |
| 8 | setTypeParser | `grep -rn "setTypeParser" loadtest/` | 0 match — BIGINT xử lý bằng `parseBigInt`/`normalizeBigIntRows` (store.ts:221) | PASS |
| 9 | mtimeMs → BIGINT | `grep -n "mtimeMs" loadtest/db/writer.ts` | writer.ts:287-288: `toEpochMs(fs.statSync(filePath).mtimeMs)` (Math.trunc trong int.ts:33) | PASS |
| 10 | History 503 khi DB lỗi | Đọc `loadtest/api-server.ts` | `/metrics` route: `countMetricSamples` → `!total.ok` → 503 (api-server.ts:353-356); `/runs`, `/logs`, run detail đều check `ok` → 503 | PASS |
| 11 | QueryResult contract | `grep -n "getMetricSamples\|query<T>" loadtest/db/store.ts` | `{ ok: true; rows } | { ok: false; error }` (store.ts:11, 210, 221, 229); caller check `ok`: api-server.ts:343, 352, 355, 365, 372 | PASS |
| 12 | Redaction URL | `grep -n "redactUrl\|redactParams"` | redactUrl wired tại config.ts:204/225, init.ts:112/114, server.ts:33; `otpSecret` in dạng `***` (server.ts:33) | PASS |
| 13 | Redaction params | `grep -rn "redactParams("` | Định nghĩa int.ts:111 + unit-test (int.test.ts) — **KHÔNG được gọi trong query path thật**; nhưng store.ts query path (B-1) **không bao giờ** đưa sql/params vào error/log (store.ts:226-229), test store.test.ts assert error không chứa sql/params/password | PASS kèm caveat: helper là dead-code phòng hờ, lớp bảo vệ thực tế là "cấm đưa params vào log" (omission) |
| 14 | Admin password không in ra | `grep -n "LOADTEST_ADMIN_PASSWORD" loadtest/db/init.ts` | Chỉ trong comment (dòng 15, 60, 62, 134); init.ts:132-134 ghi rõ "KHÔNG in ra", không bao giờ log plaintext | PASS |
| 15 | Cleanliness | `git status --short` | Chỉ `loadtest/`, `package.json`, `docs/AUTOBUILD-prod-refactor.md` + file mới trong loadtest/; **không có .env/data file** (loadtest/.env tồn tại local nhưng đã gitignore) | PASS |
| 16 | Typecheck | `npm run loadtest:typecheck` | Exit 0, sạch | PASS |

### Caveats

1. **Connect-fail path in stack trace** (#3): `server.ts:66 console.error('[lt][FATAL]', err)` in cả stack frame. Message rõ + exit 1, không phải unhandled exception — chấp nhận được, không chặn.
2. **`redactParams`/`redactSql` không wired vào query path** (#13): bảo vệ hiện tại dựa trên quy ước "error/log không chứa sql/params" (B-1) + test assert. Helper có test riêng nhưng không được gọi — nếu sau này ai thêm params vào log sẽ không có lưới an toàn. Theo dõi, không chặn.
3. **migrate.test.ts 14 test** (không phải 8 như brief): phủ nhiều hơn kỳ vọng, không phải vấn đề.
4. **`appuser:secret` trong config.ts là`DEFAULT_DEV_DB_URL`** — chuỗi duy nhất còn lại trong code, nhưng là known-bad default bị validateEnv chặn exact-match (fix của T-03 HIGH #1, đã xác nhận không còn substring regex).

### Verdict

**PASS.** Toàn bộ 16/16 check đạt: 134/134 test xanh (chạy trên DB Postgres thật `loadtest_test`), fail-fast proven (exit 1 + message rõ, không hang, không unhandled exception), migration UP=7 bảng + DOWN đúng thứ tự FK, không secret nào ra stdout, DB store trả về đúng ok/error contract và caller check `ok`. 2 caveat không chặn (stack frame ở connect-fail; redactParams là helper chưa wired nhưng lớp bảo vệ omission vẫn đứng).

### Pending user actions (trước khi chạy hệ thống)

1. **Apply DB password mới**: `loadtest/.env` đang chứa password stale cho DB `loadtest` (port 5439) → `db:status` fail "password authentication failed". Lưu ý: DB test `loadtest_test` vẫn nhận `appuser:secret` (store.test.ts chạy được) — vấn đề là connection string chính trong `.env`.
2. **OTP sync**: `LOADTEST_OTP_SECRET` phải khớp `OTP_SECRET` của gateway-auth-service (đang trống trong `.env.example` → dev chỉ warning, nhưng register sẽ fail khi chạy thật).
3. **gitleaks install**: chưa có — cài để scan secret trước khi commit.

## T-06 review — API Tester

Reviewed by: API Tester critic (HOÀI NGHI). REVIEW ONLY — không sửa code.
Date: 2026-08-04.
Scope: CORS allowlist + envelope + 429/403/400 shape + X-Request-Id (api-server.ts, http-server.ts, rate-limit.ts, guards.ts) vs frontend contract (loadtest-api.ts, loadtest-auth.store.ts, loadtest.store.ts, RegisterPage, api.ts). Đã chạy `npm run loadtest:test` — **162/162 pass (13 files)**, rate-limit suite chạy thật trên Postgres `loadtest_test_api` (KHÔNG skip).

### Findings

| Severity | Finding | Evidence | Verdict | Fix |
|---|---|---|---|---|
| MINOR | **Fail-window bỏ sót path 400 body**: `recordFail` chỉ được gọi ở gate-403 (api-server.ts:220) và handler trả bình thường (:246). Catch path `BodyError` (:247-255) KHÔNG gọi `recordFail` → login/register với JSON hỏng/non-object trả 400 NHƯNG không tính 1 fail — lệch doc "mọi response 4xx của login/register = 1 fail" (rate-limit.ts:16). Impact thấp (JSON hỏng không phải tấn công credential; brute-force vẫn bị chặn), nhưng attacker có thể spam body hỏng vô hạn không bao giờ dính 429. | api-server.ts:247-255 vs rate-limit.ts:16; grep `recordFail(` chỉ 2 call site | CONFIRMED | Gọi `this.recordFail(route, res, ip)` trong catch BodyError trước `return ctx.fail(...)` |
| MINOR | **CORS test không exercise env override — test pass "vacuous"**: `ApiServer` constructor đọc `process.env.LOADTEST_CORS_ORIGIN` TRỰC TIẾP (api-server.ts:123), bỏ qua merged env. Override trong test `startNoDbApi({ LOADTEST_CORS_ORIGIN })` bị IGNORE — test pass chỉ vì giá trị override trùng default `http://localhost:5173`. Nếu test set origin KHÁC (vd `http://foo.test`) thì test vẫn xài default và vẫn pass → không bao giờ verify đường override. Production: `.env` file vẫn chảy qua `env.corsOrigins` (fallback) nên không lỗi thật; chỉ test + đường shell-env lệch convention. | api-server.ts:123; api-server.test.ts:365; config.ts:156-159 | CONFIRMED (test-quality) | Constructor dùng `this.env.corsOrigins` (bỏ đọc process.env); test set origin khác default để assert echo thật |
| MINOR | **`Access-Control-Allow-Headers` không echo** `Access-Control-Request-Headers` — fixed `Content-Type,Authorization` (http-server.ts:61). Đủ cho axios hiện tại (chỉ gửi 2 header đó), nhưng preflight sẽ FAIL nếu sau này thêm custom header (vd X-Request-Id client-side). Test preflight cũng không gửi `Access-Control-Request-Headers` nên không phủ nhánh này. `Vary: Origin` chỉ set khi origin match (http-server.ts:66) — conditional ACAO nên chuẩn là set Vary vô điều kiện (localhost-only, cache share thấp). | http-server.ts:59-68; api-server.test.ts:367-373 | PLAUSIBLE (latent) | Echo requested headers hoặc ghi rõ limitation; set `Vary: Origin` luôn |
| INFO | **requestId test chỉ phủ path lỗi**: test 401 assert header + body requestId (api-server.test.ts:415-425); không test nào assert X-Request-Id trên response 200 thành công. 429 test không assert `X-RateLimit-Limit`/`Reset` (chỉ `Remaining: 0`). | api-server.test.ts:415-425, 538-559 | CONFIRMED (coverage gap) | Thêm assert header trên 1 success response + giá trị limit/reset |
| INFO | `toApiError` (loadtest-api.ts:36-45) chưa giữ `retryAfterSec` — interface `LoadtestApiError` thiếu field, 429 hiện chỉ lộ message. UI-SPEC §5.1 gán việc này cho T-09 (`retryAfterSec = data.retryAfterSec ?? Number(headers['retry-after']) ?? 0`) — KHÔNG phải bug T-06, backend đã cung cấp đúng contract. | loadtest-api.ts:29-45; UI-SPEC-prod-refactor.md:202-208 | CONFIRMED (expected, T-09) | T-09 bổ sung field + parse body/header |

### Verify PASS

- **CORS flow Vite proxy**: `changeOrigin: true` (vite.config.ts:19) đổi Host header, GIỮ NGUYÊN `Origin: http://localhost:5173` → khớp allowlist default (config.ts:159). Preflight OPTIONS → 204 + ACAO echo (test pass); origin lạ → KHÔNG ACAO (test assert null); default không wildcard, `*` chỉ khi config tường minh (`originAllowed` xử lý `origins.includes('*')` — opt-in). Hàm `parseOrigins` normalize entry qua `new URL(entry).origin` — strip path/port khác, đúng.
- **Envelope additive — frontend an toàn**: `toApiError` đọc `statusCode/message/errors/warnings` (loadtest-api.ts:37-44); `unwrap` đọc `data` — cả 2 không đụng field mới `timestamp/error/requestId`. Stores (loadtest.store.ts, loadtest-auth.store.ts) chỉ consume data đã unwrap, không có truy cập `data.` trực tiếp nào. `src/lib/api.ts` (CHAT client) là envelope RIÊNG (gateway, `success`+`data`+`traceId`, api.ts:94-115) — không share envelope loadtest, KHÔNG bị ảnh hưởng (DESIGN B-8 REFUTED đồng thuận).
- **429 shape khớp UI-SPEC**: envelope `{ success:false, statusCode:429, error:'RATE_LIMITED', message, retryAfterSec, timestamp, requestId }` + header `Retry-After` + `X-RateLimit-Limit/Remaining/Reset` (api-server.ts:232-240). Field name `retryAfterSec` khớp 100% UI-SPEC §5.1 (dòng 204-208). Test assert body `retryAfterSec > 0` + header `retry-after` truthy + `x-ratelimit-remaining: '0'`. Đã chạy thật trên DB — 5 fail → 429 ở lần 6; disable → không 429.
- **Register gate 403**: chạy TRƯỚC body validation + rate (dispatcher thứ tự gate→auth→rate→handler, api-server.ts:217-243) — 403 `{ error:'REGISTER_DISABLED', message:'Đăng ký đã bị tắt...' }`, 403 TÍNH 1 fail (line 220). Frontend: RegisterPage → `register()` → `toApiError(e).message` → AlertBanner (RegisterPage.tsx:51-57, 138) — handle graceful, parse đúng `message`. Test assert status 403 + `error === 'REGISTER_DISABLED'`.
- **X-Request-Id trên MỌI response**: set ở đầu `handle()` (api-server.ts:191-192) TRƯỚC mọi nhánh — OPTIONS 204, 404, 401, 429, 500, 200 đều có header. Error envelope kèm `requestId` trong body (ctx.fail, http-server.ts:200). Frontend không đọc header → không break.
- **Body 400**: JSON hỏng/non-object → 400 `{ success:false, message:'JSON body không hợp lệ' }`; 1MB limit → 413 (http-server.ts:104-130); test phủ cả 2 case JSON hỏng + string non-object. SB-2 runId format-check trước decodeURIComponent — 404, không 500.
- **Tests thực chất**: 162/162 pass; rate-limit test chạy thật (876ms, không skip); CORS/400/403/429/requestId đều có assert cụ thể, không vacuous (trừ điểm CORS override ở findings).

### Verdict

**AN TOÀN ĐỂ COMMIT — không blocker.** Mục tiêu T-06 đạt: CORS allowlist echo-origin không wildcard hoạt động đúng qua Vite proxy; envelope mới additive — frontend loadtest (toApiError/unwrap/stores) và CHAT client (api.ts, envelope riêng) đều an toàn; 429 `retryAfterSec` khớp contract UI-SPEC (T-09 tiêu thụ, chưa phải bây giờ); 403 gate đúng shape, RegisterPage parse message vào AlertBanner; X-Request-Id header trên mọi response kể cả OPTIONS/error. 2 MINOR nên fix khi có dịp: (1) `recordFail` bỏ sót path BodyError 400 — lệch doc fail-window; (2) CORS test không thực sự exercise override env (constructor đọc process.env trực tiếp) — test pass nhờ trùng default, cần sửa để test có nghĩa. INFO còn lại là coverage gap + nợ T-09 đã ghi rõ trong UI-SPEC.

## T-06 review — AppSec

Reviewed by: Application Security Engineer critic (HOÀI NGHI). REVIEW ONLY — không sửa code.
Date: 2026-08-04.
Scope: CORS allowlist (`http-server.ts`), rate-limit (`rate-limit.ts`, `api-server.ts`), register gate (`guards.ts`, `config.ts`), body 1MB (`http-server.ts`), requestId (`api-server.ts`), route table auth-vs-old (`api-server.ts` ROUTES vs `git show HEAD:loadtest/api-server.ts`), envelope error leak (`http-server.ts`, `routes/*`). Đã verify thực nghiệm: URL-origin parsing edge cases + socket lifecycle sau 413.

### Findings

| Severity | Finding | Evidence | Verdict | Fix |
|---|---|---|---|---|
| LOW | **413 KHÔNG `req.destroy()` — connection bị giữ, attacker giữ socket vô hạn**: test thực nghiệm (tsx + net.connect) xác nhận sau 413 server KHÔNG destroy socket — `Connection: keep-alive`, socket vẫn mở, client vẫn ghi thêm `EXTRA-ENDLESS-DATA` không bị chặn. Mỗi request >1MB tiêu tốn 1 socket/FD + CPU drain; bộ nhớ vẫn bounded (1MB cap). Local 127.0.0.1 → LOW; nếu `LOADTEST_HOST=0.0.0.0` → MEDIUM (connection flood). Kết hợp với không có `server.maxConnections`. | http-server.ts:104-130; test thực (socket không đóng sau 413) | CONFIRMED | Gọi `req.destroy()` sau 413 (và 400) trong `readBody` catch hoặc dispatcher |
| MINOR | **Register dùng fail-window, KHÔNG phải request-count — success 2xx `clear()` window**: nếu `LOADTEST_ALLOW_REGISTER=true` (prod/dev), attacker tạo admin account vô hạn — mỗi register thành công reset fail-window, không có bucket tổng request. Gate là lớp bảo vệ DUY NHẤT (đã xác nhận không có cơ chế khác). | rate-limit.ts:117-149 (clear on 2xx); api-server.ts:184-188, 246 | CONFIRMED (config-dependent) | Khi mở gate, thêm request-count bucket riêng cho register |
| MINOR | **Rate-limit per-IP bỏ qua khi bind != loopback**: `LOADTEST_HOST=0.0.0.0` → mỗi IP 1 bucket → attacker rotate IP né 429. `LOADTEST_TRUST_PROXY=1` KHÔNG proxy thật → X-Forwarded-For spoof → rotate IP. Default an toàn (socket.remoteAddress + 127.0.0.1). | http-server.ts:71-80; config.ts:169,199; .env.example:LOGGER | CONFIRMED (accepted risk) | Keep default; document khi expose |
| INFO | **CORS origins từ .env file KHÔNG normalize** (config.ts chỉ split/trim, parseOrigins chỉ áp dụng cho process.env): `LOADTEST_CORS_ORIGIN=http://localhost:5173/` (trailing slash) hoặc uppercase host trong .env → request origin `http://localhost:5173` KHÔNG match → fail-closed (an toàn nhưng config "đúng" bị chặn). | config.ts:156-159 vs http-server.ts:46-56 | CONFIRMED (fail-closed) | Normalize entry bằng parseOrigins cho cả 2 đường |
| INFO | **`GET /metrics` (Prometheus) MỚI, PUBLIC, không auth** — không có trong old api-server.ts. Lộ operational info: `lt_apiErrors`, `lt_workerRestarts`, `lt_coordinator_rssMb`, `lt_worker_alive` — không secret/PII. Acceptable cho local tool; nếu expose mạng thì là info-disclosure nhẹ. | api-server.ts:71-75; tool-metrics.ts:50-55 | CONFIRMED (info) | Chấp nhận, hoặc gắn auth khi mở 0.0.0.0 |
| INFO | **`Vary: Origin` chỉ set khi origin match** — ACAO conditional nhưng cache share không có Vary → cache-poisoning latent (localhost-only, low). | http-server.ts:63-67 | PLAUSIBLE (latent) | Set `Vary: Origin` vô điều kiện |
| INFO | **429 path không gọi `recordFail`** (api-server.ts:231-242 `return` trước recordFail) — window fail không bị trượt bởi chính 429; hệ quả nghịch đảo của finding MINOR bên API Tester (dòng 388). Benign. | api-server.ts:231-242 | CONFIRMED (benign) | — |

### Verify PASS

- **CORS không có đường bypass**: `originAllowed` dùng `new URL(origin).origin` + exact string match. Test thực nghiệm: `http://localhost:5173.evil.com` → THROWS Invalid URL → reject (không match); `http://localhost:5173@evil.com` → origin `http://evil.com` → reject (userinfo trick không qua); `http://LOCALHOST:5173` → normalize lowercase → match (browser cũng gửi lowercase — an toàn); trailing slash → normalize; `null` origin → reject. Wildcard `*` chỉ khi operator config tường minh.
- **Rate-limit không spoof được header**: `clientIp` mặc định `req.socket.remoteAddress` (http-server.ts:79), X-Forwarded-For chỉ được tin khi `LOADTEST_TRUST_PROXY=1` (opt-in). IP key duy nhất = socket IP. Cleanup: lazy sweep khi `lastSeen.size > 2048`, xoá idle > 10 phút, xoá đủ 4 map — bounded, không leak. 429 chỉ leak `Retry-After` + `X-RateLimit-Limit/Remaining/Reset` — KHÔNG leak số fail/token (bucket state).
- **Register gate không force-enable được bằng header**: `registerGate(env)` = `env.allowRegister` (guards.ts:31) — env-only, dispatcher gate chạy trước body validation + rate (api-server.ts:218-220), 403 tính 1 fail.
- **Body limit chặn trước khi xử lý**: 1MB cap dừng đọc ngay khi vượt (http-server.ts:110-114) — memory bounded mỗi request; DoS còn lại chỉ là socket-holding (finding LOW).
- **requestId**: `crypto.randomUUID()` (http-server.ts:26) — unpredictable, không phản chiếu header client (luôn tự sinh), set trên mọi response + error envelope; không lộ PII.
- **Route auth — KHÔNG route nào mất guard**: đối chiếu đầy đủ route table cũ (HEAD) vs mới — 24/24 route vẫn giữ `auth: true` (start/stop/kill/pause/resume/status/metrics/users/errors/logs/report/report-export/config/allowlist x2/pools/cleanup/runs x5). Chỉ route public MỚI là `/metrics` (Prometheus, info-only). Health public giữ nguyên.
- **Error messages không leak internals**: 500 envelope `{ error:'SERVER_ERROR', message:'Lỗi server, xem log với requestId', requestId }` — **CẢI THIỆN so với cũ** (old echo `err.message` ra client). 400/404/413/429/401/403 = hằng số tiếng Việt cố định; DB lỗi → `error:'DB_UNAVAILABLE'`, không leak code/stack/file path. Logger redact `authorization|password|token|otp|secret` + redactUrl (logger.ts:90-121).

### Verdict

**AN TOÀN ĐỂ COMMIT — không blocker.** Không có Critical/High. 1 LOW (413 không destroy socket — connection-holding DoS, local-only; thành MEDIUM nếu mở mạng) + 2 MINOR (register fail-window clear-on-success nếu mở gate; rate-limit per-IP né được khi bind 0.0.0.0) + 4 INFO. CORS allowlist, rate-limit, register gate, requestId, route auth đều đúng và không có đường bypass: CORS không echo origin lạ (URL normalization + exact match, fail-closed), rate-limit không tin header spoof mặc định, gate không force-enable bằng header, body 1MB bounded. Đáng fix ưu tiên: `req.destroy()` sau 413 (1 dòng, chặn DoS socket-holding).

## T-07 review — SRE

Reviewed by: SRE critic (HOÀI NGHI). REVIEW ONLY — không sửa code.
Date: 2026-08-04.
Scope: health endpoint (`health.ts`, `routes/run.ts`), `/metrics` Prometheus (`api-server.ts`, `tool-metrics.ts`), JSONL logger (`logger.ts`), runId/requestId flow (coordinator.ts, worker.ts, socket-farm.ts, db/writer.ts), NO_POST_FIXTURE reporting (report.ts, coordinator.ts).

### Findings

| Severity | Finding | Evidence | Verdict | Fix |
|---|---|---|---|---|
| **HIGH** | **Health probe KHÔNG có timeout — hung DB/Redis treo /health vĩnh viễn.** `store.probe()` = `pool.query('SELECT 1')` chỉ có `connectionTimeoutMillis: 3000` (chỉ giới hạn acquisition, KHÔNG phải query timeout; không có `statement_timeout`). Redis `ping()` không có `commandTimeout` (createRedis chỉ `maxRetriesPerRequest:2`). DB đã kết nối nhưng query treo (server nghẽn/network blackhole) → /health treo mãi. Thêm nữa: route gọi `buildHealth` TRỰC TIẾP mỗi request (run.ts:17) — cache 10s `createHealthProbe` là DEAD CODE (chỉ test dùng). Health check chuẩn yêu cầu bounded probe. | health.ts:47, 59; store.ts:190-199; auth-factory.ts:378-384; run.ts:17; = createHealthProbe chỉ trong health.test.ts | CONFIRMED | `SELECT 1` với `statement_timeout`/`query_timeout` (pg) + `commandTimeout` trên ioredis; hoặc bọc probe trong `AbortSignal.timeout(3000)`; route dùng `createHealthProbe` (cache 10s) để giảm tải probe |
| **HIGH** | **Health false-ok: `workerAlive` được truyền vào deps nhưng KHÔNG BAO GIỜ được đọc** — `workers` suy ra từ phase thuần: phase 'steady'/'ramping' mà 0 worker còn sống (crash-loop trước khi E3 kích hoạt ~1s) → `workers:'running'`. RUNNING_PHASES gồm cả 'provisioning'/'report'/'cooldown' (0 worker đang chạy) → vẫn 'running'. **Redis false-ok khi idle**: `redisHealth()` trả `true` khi `this.redis === null` (chưa chạy run / sau finishRun đã null) → hoàn toàn không probe → Redis chết vẫn `redis:'up'`, `status:'ok'`. `status` không bao giờ trả `'down'` (interface khai báo nhưng unreachable — chỉ 'ok'|'degraded'). | health.ts:66-68, 116-118; coordinator.ts:107-115, 510-513; healthDepsFrom:140 (`configured: () => true`) | CONFIRMED | Nếu `this.redis===null` → probe thật (tạo Redis client trả lời ping) hoặc trả `redis:'unknown'`; `workers` dựa vào `workerAlive` (+ `farm.total>0`); bỏ 'report'/'provisioning' khỏi RUNNING_PHASES |
| **MED** | **/metrics gauge STALE khi idle / sau run.** `aggregateTick` early-return khi `!config` (coordinator.ts:344) TRƯỚC `setGauge` → từ boot tới run đầu, `coordinator.rssMb` = 0 (tool dùng 80MB hiện rssMb 0). Sau `finishRun` → `stopTimers()` → gauge đóng băng: `worker.alive` giữ giá trị cuối (vd 8) dù farm đã dispose → operator thấy worker.alive>0 khi không có run nào. **Không có gauge active-run/phase** → không phân biệt idle vs run chết; không thể viết alert "worker down". | coordinator.ts:344-348, 241-253, 508-509; tool-metrics.ts:31 | CONFIRMED | Thêm gauge `lt_run_phase` (hoặc `lt_run_active`); set `worker.alive=0` khi `finishRun`; set rssMb ở metricsTimer (không phụ thuộc config) |
| **MED** | **Prometheus text thiếu TYPE/HELP + counter không có suffix `_total`** → `rate(lt_apiErrors[5m])` / `increase()` báo lỗi "expected type counter, got untyped" (Prometheus mặc định untyped gauge). Alert trên error-rate buộc dùng `delta()` workaround. `lt_` prefix lệch DESIGN §5.3 (`loadtest_...`). | tool-metrics.ts:50-55; api-server.ts:71-75 | CONFIRMED | Thêm `# TYPE lt_<counter> counter` (+ `_total` suffix) và `# TYPE lt_<gauge> gauge`; HELP ngắn |
| **MED** | **Log correlation gián đoạn: worker JSONL entries thiếu runId/workerId; requestId→runId không nối được.** Worker process log `start/stop` KHÔNG kèm fields (`socket-farm.ts:432,456` — không runId/workerId); `worker.ts:64` chỉ có workerId. Trong JSONL cùng file, entries worker không thể gắn vào run nào (trừ đoán theo timestamp). requestId chỉ xuất hiện ở log API-error (api-server.ts:252) — không có access log, không log nào map requestId→runId (envelope lỗi trả requestId, không phải runId). G-10: debug 1 request thất bại → không tìm được run đó. DB log_events gắn runId theo context `currentRunId` (writer.ts:174) nhưng KHÔNG có workerId/requestId. | socket-farm.ts:432,456 → logger.ts fields; api-server.ts:252; http-server.ts:200; writer.ts:53,174 | CONFIRMED | Worker log kèm `{ runId, workerId }` (truyền runId qua env/config khi fork); thêm access log `{ requestId, method, path, status, runId? }` (1 dòng/request, level info — đã có makeRequestId) |
| **MED** | **Multi-process JSONL ghi CÙNG 1 file: N+1 process append + rotation race.** `fork(WORKER_ENTRY, [], { env: { ...process.env, LOADTEST_WORKER_ID } })` (worker-farm.ts:62) — worker con thừa hưởng `LOGTEST_LOG_FILE` → mỗi worker tự init sink riêng vào CÙNG file. `appendFileSync` mỗi dòng (atomic đủ tốt) NHƯNG rotation: mỗi process giữ `size` riêng → 2 process đạt 10MB lệch nhau → `renameSync` đồng thời (`logger.ts:150-161`) → best-effort catch, có thể mất/trùng file `.1/.2`, torn line. | logger.ts:139-187, 213; worker-farm.ts:60-62; worker.ts:11 | CONFIRMED (latent) | Chỉ coordinator ghi file: worker set `LOGTEST_LOG_FILE` rỗng trước fork (hoặc `configureLogger({logFile:null})` trong worker entry); hoặc mỗi process ghi file riêng `${file}.${pid}` |
| LOW | **Log volume ổn nhưng JSONL không có level filter.** Không có per-message log (errors chỉ gộp in-memory → tick; NO_POST_FIXTURE log 1×/worker). Volume thực tế thấp: snapshot 5s (1 dòng/5s ≈ 720/h ≈ 5MB/ngày) + vài dòng start/stop/phase. Cap 5×10MB=50MB đủ. Nhưng JSONL sink ghi MỌI info vô điều kiện (verbose chỉ gate console, logger.ts:263) — không filter được snapshot noise. | logger.ts:250-256, 258-270; coordinator.ts:256-269 | CONFIRMED (INFO) | Thêm `LOGTEST_LOG_LEVEL` (warn/error) cho JSONL sink; hoặc bỏ snapshot info khi không cần |
| LOW | **Health luôn HTTP 200 (kể cả degraded) + không có 'down'** — LB health-check không phản ứng theo status code; `status` field là discriminator duy nhất. `workers` không bao giờ 'down' (chỉ 'idle'|'running'). | health.ts:27-35, 68; run.ts:18 | CONFIRMED (by design) | Nếu muốn LB failover: trả 503 khi degraded; ghi rõ contract trong doc |
| DOC | **Không có alerting guidance ở đâu** (không có README, không docs đề cập alert/Prometheus rule). Alert "worker down 5 min" hiện viết không được (xem HIGH/MED metrics). | grep 'alert|Prometheus|grafana' docs/*.md → 0 hit ngoài API/design | CONFIRMED | Thêm section ops: endpoints, cách viết alert sau khi bổ sung lt_run_active + TYPE/_total |

### Verify PASS

- **PRD §5.3 minimum metrics đủ**: `apiErrors`, `dbWriteFail`, `dbRetry`, `workerRestarts`, `runFinished`, `coordinator.rssMb`, `worker.alive` — đều có trong tool-metrics.ts:7-9, wiring đúng (store.ts:212/227/231/239, api-server.ts:253, coordinator.ts:346-347, 505).
- **NO_POST_FIXTURE rõ ràng + machine-readable**: field `noPostFixtureSkipped` (number) trong report JSON + section Markdown riêng (report.ts:76-81, 246-253); coordinator đếm từ raw worker errors TRƯỚC cap (coordinator.ts:376-378); RestDriver log 1 lần/worker (rest-actions.ts:75-80). Đủ cho plan.
- **runId nhất quán phía coordinator**: start/phase/end/snapshot đều kèm `runId`; DB log_events gắn runId theo `currentRunId` (writer.ts:174). Worker-side là gap (xem MED correlation).
- **Redaction B-1 áp dụng cho JSONL context** (logger.ts:90-121, 222-228) — fields sensitive/URL/params/sql đều redact trước emit.
- **Log volume không phải mối đe dọa**: KHÔNG tồn tại per-message logging (VirtualUser không log per message; recordError chỉ gộp bộ đếm + samples trong memory). Volume thực ~5MB/ngày, 50MB cap dư nhiều.
- **Health phân biệt db/redis per-service + không 500 khi down** (US-OBS-1): `db:'down'` khi disabled/probe fail, `redis:'down'` khi ping fail trong lúc run — đúng hướng; vấn đề là các đường false-ok ở HIGH.

### Verdict

**CẦN SỬA TRƯỚC KHI DÙNG CHO ALERTING — không blocker cho commit (observability hoạt động cho operator xem dashboard), nhưng KHÔNG đáng tin cho alert tự động/LB health-check.** High: (1) probe không timeout → /health treo mãi khi DB/Redis hung; (2) false-ok — `workerAlive` không được consul, Redis idle luôn 'up', workers không bao giờ 'down'. Med: gauge stale sau run + thiếu `lt_run_active`; thiếu TYPE/_total → rate() không chạy; worker JSONL thiếu runId/workerId + không map requestId→runId; multi-process ghi/rotate cùng file. NO_POST_FIXTURE và metrics PRD §5.3 đạt, log volume an toàn. Dùng được cho người xem dashboard (runId có, NO_POST_FIXTURE rõ, volume thấp) — chưa đủ cho "worker down 5 phút" alert vì 3 lý do: worker.alive không còn đáng tin sau run, không có run-active, và rate() lỗi untyped.

## T-07 review — Performance

Reviewed by: Performance Benchmarker (HOÀI NGHI). REVIEW ONLY — không sửa code.
Date: 2026-08-04.
Scope: hot path socket events + tick aggregation 1s + worker status; logger JSONL sink (appendFileSync), metrics gauges (rssMb 5s), health probe; adversarial vs PRD §5.1/§5.8 (DB-1 tick aggregation 1s) + DESIGN §5.2 (ring buffer 500, JSONL `fs.createWriteStream`) + DESIGN §5.3 (health cache 10s).

### Findings

| Severity | Finding | Evidence | Verdict | Fix |
|---|---|---|---|---|
| MEDIUM | **Health cache là dead code — route dùng `buildHealth` KHÔNG cache**: `GET /api/loadtest/health` gọi ngay một `SELECT 1` thật + Redis ping MỖI lần (createHealthProbe 10s TTL chỉ tồn tại + test dùng). Lệch DESIGN §5.3 "Cached probe TTL 10s — không đấm DB mỗi lần gọi". Khi DB CHẾT đúng lúc cần health nhất: `pool.query('SELECT 1')` không throw khi disabled (`probe()` trả false ngay) nhưng khi `enabled=true` rồi DB ngã → mỗi probe block tới `connectionTimeoutMillis=3000` + pool max 5 → poll 1s/s bị tắc, congestion pool. Với local tool tải 1s thấp thì không phá hot path, nhưng đúng là vi phạm budget đã hứa. | routes/run.ts:17 (buildHealth); health.ts:85 (createHealthProbe — grep chỉ khớp health.test.ts); store.ts:190-199, store.ts:159-163 | CONFIRMED | Wire `createHealthProbe` vào route handler (giữ `buildHealth` cho test/contract) |
| MEDIUM | **JSONL sink sync I/O per log — không buffered**: `fs.mkdirSync` + `fs.appendFileSync` (open/write/close) MỖI log trên event loop coordinator; DESIGN §5.2 chỉ định `fs.createWriteStream({ flags:'a' })` (buffered, async flush). Counter-comment: chọn appendFileSync cố ý để rotation an toàn trên Windows + **hiện tại call sites đều lifecycle-level** (worker chỉ log start/stop/ready/uncaught; socket events KHÔNG gọi logger — không log per-message) nên tần suất thấp, không tác hại thực tế. Nhưng nếu ai thêm log per-event (vd verbose per-message) → mỗi log = 2 syscall sync chặn event loop. Đồng thời mỗi log khi DB bật + đang run = 1 INSERT `log_events` fire-and-forget (`void this.writeLog`) — queue không cap, pool max 5 → DB chậm có thể tích promise backlog. | logger.ts:165-186 (write: mkdirSync+appendFileSync), logger.ts:131 (10MB vs DESIGN 50MB); writer.ts:171-175 (writeLog → insertLogEvent); socket-farm.ts — grep `ltLog` chỉ ở start/stop/warn, không trong handler socket | CONFIRMED (latent) | Buffer JSONL trong memory + flush timer (giữ rotation cũ), hoặc giữ persistent fd + `fsync` định kỳ; cap log_events queue khi DB down |
| LOW | **rssMb gauge đo mỗi 1s tick, không phải 5s**: `process.memoryUsage()` gọi trong `aggregateTick` (1/s) — metricsTimer 5s chỉ LOG snapshot, còn gauge value cập nhật per tick. `process.memoryUsage()` ~10-50µs/lần — không phá budget 1s, nhưng lệch premise "snapshot 5s". Worker emitTick còn thêm 1 lần/s/worker. | coordinator.ts:346 (aggregateTick), coordinator.ts:241 (metricsTimer 5000), socket-farm.ts:660 | CONFIRMED (micro) | Đo memoryUsage trong snapshotToolMetrics 5s (giữ gauge cũ giữa 2 lần) — hoặc chấp nhận |
| LOW | **Redaction double-work + URL parse trên mọi string**: khi `LOADTEST_LOG_JSON=1` + có sink → `buildJsonlEntry` chạy 2 lần/log (logger.ts:252, 260) = double redact + double JSON.stringify. `redactUrl` chạy `new URL()` try/catch + fallback regex trên MỌI string value trong context (không chỉ field nhạy cảm) — O(entries) context, không phải O(log-length). Context hiện rất nhỏ (snapshot 5s toàn number) → rẻ ở tần suất hiện tại; chỉ đáng giá khi log volume cao + context nhiều string. `redactSql`/`redactParams` chỉ chạy khi context có key `sql`/`params` (rare). | logger.ts:90-121, 215-231, 250-263 | CONFIRMED (micro) | Build entry 1 lần, dùng chung cho sink + console; redactUrl chỉ áp dụng value chứa `://` |
| LOW | **Rotation size 10MB ≠ DESIGN 50MB + rename loop sync**: `DEFAULT_MAX_BYTES = 10MB` (logger.ts:131) vs DESIGN §5.2 "max 50MB → suffix -1 (append)". Rotation `renameSync` loop sync khi đạt max — hiếm (10MB JSONL) nhưng là sync I/O khối. | logger.ts:131, 150-161, 175-181; DESIGN §5.2 | CONFIRMED (doc drift) | Align 50MB hoặc ghi nhận chủ ý |

### Verify PASS

- **Ring buffer O(1) amortized + KHÔNG JSON serialize**: `logHistory.push` + `shift()` cap 500 (logger.ts:241-242) — entry là string `[lt]...` dựng sẵn, JSON.stringify chỉ ở sink/console path. Đúng cấu trúc DESIGN §5.2 "Ring buffer 500 entry". Không double-work cho ring buffer.
- **worker.alive gauge không block**: `farm.alive` duyệt O(workers) handle (worker-farm.ts:46-50), không IPC sync — gọi trong aggregateTick (1/s) + health handler, trivial với ≤ dozen worker.
- **5s snapshot chạy trên interval riêng**: `metricsTimer` 5000ms (coordinator.ts:241) → `snapshotToolMetrics` — KHÔNG nằm trên 1s tick. Không thêm work per-tick từ snapshot path.
- **1s tick aggregate bounded, không degraded**: per-tick = memoryUsage() + setGauge×2 + spread O(workers) + `aggregateTicks` O(workers×ACTION_TYPES) + rebuild cumulative histogram O(workers×actions×48 buckets) + `toMetricSample` 5 JSON.stringify nhỏ — ~vài nghìn ops/s, cách xa budget 1s. `pushTick` → batch flush 30s/500 tick (writer.ts:20-21) giữ nguyên.
- **Socket event handlers KHÔNG gọi logger**: `on('connect'|'message'|'chat:error'|...)` chỉ cập nhật counter/histogram/outbox — không `ltLog` per-message. Hot path sạch hoàn toàn.
- **Health queries async (không sync trên event loop)**: `store.probe()` là `pool.query` async; `redisHealth()` ping async. Không có DB query sync.

### Verdict

**HOT PATH VÀ 1s TICK KHÔNG bị degrade — không blocker.** Grader: socket events không đụng logger; tick 1s bounded vài nghìn ops/s; ring buffer 500 O(1) không JSON; worker.alive O(workers) không block; snapshot 5s trên interval riêng. 2 vấn đề MEDIUM đều LATENT chứ không phải hiện tại: (1) health cache 10s (DESIGN §5.3) là dead code — route hit DB+Redis mỗi call, tệ nhất khi DB ngã (block 3s/call, pool max 5); (2) JSONL sink dùng `appendFileSync`+`mkdirSync` per log thay vì buffered stream như DESIGN §5.2 — an toàn hiện tại vì tần suất log lifecycle-level, nhưng bất kỳ log per-event nào cũng sẽ chặn event loop. LOW còn lại là micro/doc-drift (rssMb per-tick thay vì 5s, redaction double-run khi LOG_JSON=1, 10MB vs 50MB rotation). Khuyến nghị: wire `createHealthProbe` vào route (fix nhỏ, đúng doc) trước khi chạy healthcheck Docker; buffer JSONL sink là nợ kỹ thuật nên làm khi thêm log per-event.

## T-07 review — Code Review

Reviewed by: Code Reviewer (HOÀI NGHI). REVIEW ONLY — không sửa code.
Date: 2026-08-04.
Scope: T-07 observability — JSON logger (logger.ts), health endpoint (health.ts + routes/run.ts), tool metrics (/metrics route), redaction, runId/requestId flow, NO_POST_FIXTURE reporting, compat với dashboard + callers. Đã chạy thật `npm run loadtest:typecheck` (exit 0) + `npm run loadtest:test` (162/162 pass, 13 files).

### Findings

| Severity | Finding | Evidence | Verdict | Fix |
|---|---|---|---|---|
| MEDIUM | **Health cache 10s (DESIGN §5.3) là dead code — route gọi `buildHealth` trực tiếp, NOT `createHealthProbe`**: mỗi `GET /api/loadtest/health` = 1 `SELECT 1` thật + Redis ping. `createHealthProbe` (cache TTL 10s) chỉ tồn tại + test (health.test.ts:66-89) dùng. Trùng với finding MEDIUM của review Performance — xác nhận lại độc lập. Khi DB đang `enabled=true` rồi ngã → poll health 1s/s tạo pool query block (connectionTimeoutMillis 3000, pool max 5). | routes/run.ts:17 (`buildHealth`); health.ts:85-129; grep `createHealthProbe` chỉ khớp health.test.ts | CONFIRMED | Wire `createHealthProbe` vào route handler (giữ `buildHealth` cho test/contract) |
| MEDIUM | **JSONL sink multi-process unsafe**: auto-init module-level (logger.ts:213) tạo sink trong MỌI process có `LOGTEST_LOG_FILE`, gồm cả worker forked (worker-farm.ts:64 inherit `process.env`). Mỗi process có `size` counter cục bộ + tự rename rotation — 2 process cùng append file + rotate → race: process A rename `file→.1` trong lúc B đang append (mở theo tên `file`) → B append vào file đã rename hoặc recreate file mới → entry để lệch file/rotation lỗi thứ tự. Worker hiện log lifecycle-level (startup/uncaught) nên tần suất thấp — latent, không phá hiện tại. | logger.ts:139-187 (appendFileSync + renameSync + size local), logger.ts:213; worker-farm.ts:64 (env inherit) | CONFIRMED (latent) | Worker không inherit sink (flag `LOGTEST_WORKER=1` → skip auto-init) hoặc single-writer (coordinator duy nhất ghi JSONL) |
| MEDIUM | **`msg` KHÔNG được redact — chỉ `context`**: `buildJsonlEntry` (logger.ts:215-231) chỉ chạy `redactSensitiveFields` cho `fields.context`; chuỗi `msg` emit verbatim ra console + JSONL + ring buffer. Docstring logger.ts:17-18 hứa "KHÔNG log password/token ở bất kỳ đâu" — mạnh hơn code enforce. Đã rà ~50 call site `ltLog.*`: không leak thực tế hiện tại (gateway URL là config user allowlist; `err.message` từ pg/requestJson không chứa credential; `worker.ts:53` log `err.stack` — lỗi uncaught chứa URL có userinfo sẽ lọt). Đây là lỗ hổng defense-in-depth, không phải leak đang hoạt động. | logger.ts:215-231, 90-121; worker.ts:53 | CONFIRMED (defense-in-depth gap) | Redact msg string scan (redactUrl + sensitive regex) trước emit, hoặc nới docstring cho khớp thực tế; chặn `err.stack` trong worker uncaught |
| LOW | **`workerAlive` trong HealthDeps là field chết**: `buildHealth`/`createHealthProbe` không bao giờ đọc `deps.coordinator.workerAlive` — `workers` field derive thuần từ `phase` (RUNNING_PHASES). healthDepsFrom vẫn wire getter (health.ts:139). Interface hứa input mà impl bỏ qua. | health.ts:21,66,116,139; coordinator.ts:102 | CONFIRMED (dead field) | Bỏ field hoặc dùng để tổng hợp `workers=down` khi có worker chết |
| LOW | **NO_POST_FIXTURE double-represented**: vừa đếm vào `failTotal` + per-action `fail` (socket-farm.ts:589-592 → `recordAction` ok=false → failTotal++), vừa surface riêng `noPostFixtureSkipped` (report.ts:76-81). Profile `read/view/comment/like` = 60%+ user → feed trống làm successRate sinh giảm dù report đã giải thích rõ (report.ts:246-253). Đây là design decision ("action fail"), đã có giải thích — nhưng nếu intent là "không phải lỗi thật" thì không nên trừ successRate. | socket-farm.ts:587-596; report.ts:246-253; coordinator.ts:376-378 | CONFIRMED (design) | Chọn 1: xếp như `LIKE_PACED_SKIP` (không fail) hoặc nếu giữ fail lớp này thì đổi nhãn report thành "bị skip do feed trống" |
| LOW | **Prometheus naming lệch convention**: counter `lt_dbWriteFail`/`lt_apiErrors`/`lt_workerRestarts`/`lt_runFinished` thiếu suffix `_total` (convention counter), gauge `lt_coordinator_rssMb`/`lt_worker_alive` không có `# TYPE`/`# HELP` lines. Format vẫn VALID (uppercase được phép trong tên metric, type lines optional) — scrape được, nhưng Grafana/PromQL rate() sẽ hoạt động như counter không đúng kiểu. | tool-metrics.ts:50-55 | CONFIRMED (convention) | Thêm `_total` + `# TYPE lt_* counter/gauge` lines |
| INFO | **requestId chỉ vào log ở error path**: runId đạt JSONL cho run-scoped logs ✓ (coordinator.ts:144/324/539 pass `{runId}`; snapshot 5s pass `{runId, context}`). requestId chỉ được log ở `api error` (api-server.ts:252) — success path không có access log. Echo header `X-Request-Id` + envelope error vẫn đủ cho trace nhưng "requestId reach API logs" chỉ đúng 1 chiều. | coordinator.ts:144,258,324,539; api-server.ts:252; http-server.ts:200 | CONFIRMED (partial) | Thêm access log 1 dòng/request nếu cần trace full |
| INFO | **Rotation edge cases**: file hiện tại vượt quá maxBytes tới 1 line (rotation chạy SAU append — logger.ts:174-181); giảm maxFiles để lại file `.N` cũ không bao giờ dọn (chỉ rename từ trên xuống, không xoá `.5` cũ). Cả 2 benign. | logger.ts:150-161, 175-181 | CONFIRMED (benign) | Không cần fix; ghi chú nếu muốn retention chính xác |
| INFO | **`coordinator.ts:144` + `server.ts:31` log `gateway=${gatewayUrl}` chưa qua `redactUrl`**: gatewayUrl là user-supplied config nằm trong allowlist (normalizeUrl không strip userinfo), nếu URL có `user:pass@` sẽ lọt log. `server.ts:34` đã redact redisUrl đúng — thiếu đồng nhất. | coordinator.ts:144; server.ts:31,34 | CONFIRMED (minor) | Bọc `redactUrl(config.gatewayUrl)` như redisUrl |

### Verify PASS

- **Logger compat (O-5/R-8)**: `ltLog.info/warn/error` giữ nguyên — util.ts re-export shim (util.ts:11-22), ~50 call site đều qua `ltLog`/`log` với signature mới. Ring buffer 500 + `subscribeLog` giữ nguyên (logger.ts:62-75); entry text `[lt][LEVEL][ts] msg` KHÔNG đổi — so với util.ts cũ (git show HEAD:loadtest/util.ts) format y hệt. Không caller nào truyền second-arg non-LogFields (rà 9 call site có 2 arg — đều object `{runId|workerId|requestId|context}`). Test parse format text pass (logger.test.ts:46-52).
- **JSONL sink**: JSON line hợp lệ (`JSON.stringify(entry)+'\n'`); rotation 10MB/5 file đúng (rename `.4→.5…file→.1`, giữ 5); `LOGTEST_LOG_FILE` unset → không sink, không error (logger.ts:206-213, test logger.test.ts:103-107); path relative/absolute đều xử lý (`mkdirSync recursive` + `appendFileSync`). Test rotation pass (logger.test.ts:89-101).
- **Health endpoint (US-OBS-1)**: DB down → HTTP 200 + `status:'degraded'` + `db:'down'` — KHÔNG 500, KHÔNG 'ok' giả (routes/run.ts:15-19; api-server.test.ts:451-477; health.test.ts:19-30). Probe bắt 'down' đúng: `store.probe()` false / throw đều → 'down' (health.ts:42-53). Redis down → degraded (health.test.ts:56-63). Response field đủ `{status,db,redis,workers,version,uptimeSec,timestamp}` — frontend `health()` unwrap `{status}` (loadtest-api.ts:120-123) khớp.
- **Metrics endpoint**: `/metrics` public, `text/plain; version=0.0.4`; đủ 5 counters + 2 gauges với prefix `lt_`; KHÔNG collide `/api/loadtest/metrics` (tick-history) — api-server.test.ts:479-502 xác nhận cả 2 route.
- **Redaction (B-1)**: `redactSensitiveFields` chặn password/token/secret/authorization/otp + gọi `redactUrl` cho string + `redactParams`/`redactSql` cho `params`/`sql` + đệ quy object/array (logger.ts:90-121). `redactParams` đã harden position-aware (int.ts:111-125) — khác với review B-1 trước. Test B-1 pass (logger.test.ts:62-87). Không leak credential trong log call mới (rà toàn bộ `ltLog.*`).
- **runId/requestId flow**: runId → coordinator.start `{runId}` → `buildJsonlEntry` → JSONL ✓ (logger.ts:217); requestId → error path ✓ (api-server.ts:252). Trace 1 path: `start()` → `ltLog.info(..., {runId})` → `log()` → `jsonlSink.write(buildJsonlEntry(...))` → entry.runId có giá trị.
- **NO_POST_FIXTURE**: report JSON + Markdown đều nêu rõ absence (report.ts:76-81, 246-253); `RunReport.noPostFixtureSkipped` optional — additive, frontend `RunReport` (src/types/loadtest.ts:157-183) không khai báo nhưng frontend không đọc field → không break TS hay runtime. Coordinator truyền count từ raw worker errors trước top-10 cap (coordinator.ts:376-378). Test report.test.ts:109-154 pass.
- **Typecheck + test**: `npm run loadtest:typecheck` exit 0; `npm run loadtest:test` 162/162 pass (13 files, 3.5s).

### Verdict

**AN TOÀN ĐỂ COMMIT — không blocker.** Grader: logger compat 100% (shim giữ `ltLog`/ring buffer/text format y hệt, không caller vỡ signature); JSONL sink đúng (JSON hợp lệ + rotation 10MB/5 + unset env không ghi); health endpoint đúng US-OBS-1 (DB down → 200 degraded, không 500/ok giả, probe bắt 'down' + không throw); /metrics Prometheus hợp lệ + không collide tick-history; redaction không leak (B-1 test pass, `redactParams` position-aware đã harden); runId/requestId đủ cho trace; NO_POST_FIXTURE report rõ ràng + type additive không phá frontend; typecheck + 162/162 test xanh. 3 MEDIUM đều LATENT/defense-in-depth, không phải bug đang hoạt động: (1) health cache 10s là dead code — nên wire `createHealthProbe` (trùng khuyến nghị review Performance); (2) JSONL sink multi-process race khi worker cũng inherit sink — worker log tần suất thấp nên chưa tác hại; (3) `msg` không redact (chỉ context) — gap phòng hờ, chưa có leak thực tế. LOW/INFO là dead field, naming convention, double-count NO_POST_FIXTURE, rotation edge — theo dõi, không chặn.

## T-06 review — Code Review

Reviewed by: Code Reviewer critic (HOÀI NGHI). REVIEW ONLY — không sửa code.
Date: 2026-08-04.
Scope: T-06 (API hardening + module split) — `api-server.ts` 549→256 dòng, split `http-server.ts`/`guards.ts`/`rate-limit.ts`/`api-mappers.ts`/`routes/{auth,run,history,settings}.ts`. Verify: contract preservation (so sánh từng route `git show HEAD:loadtest/api-server.ts` vs route table mới), frontend envelope, rate-limit, register gate, B-2 shutdown, readBody, module split, tests. Đã chạy `npm run loadtest:typecheck` (exit 0) + `npm run loadtest:test` — **162/162 pass (13 files, 3.2s)** (brief nói 140/140 — suite thực tế lớn hơn, không phải thiếu).

### Findings

| Severity | Finding | Evidence | Verdict | Fix |
|---|---|---|---|---|
| LOW | **`sweep()` không bao giờ xoá được entry `failWindows` — key format lệch → memory leak chậm.** `getFailWindow` key = `${rate}:${ip}` (vd `login:1.2.3.4`) nhưng `sweep()` xoá `this.failWindows.delete(key)` với key = IP trần từ `lastSeen` (rate-limit.ts:157). `lastSeen` tự dọn, `startBuckets`/`writeBuckets` dùng key IP trần nên dọn đúng — RIÊNG `failWindows` (login/register = chính thứ brute-force đập) không bao giờ bị evict. Crawler nhiều IP + fail liên tục → map grow unbounded. | rate-limit.ts:152-162 vs 170; `touch`/lastSeen set IP trần (164-167) | CONFIRMED | Key `failWindows` bằng IP trần (bỏ prefix rate) hoặc sweep xoá theo prefix `login:`/`register:`; thêm test eviction |
| LOW | **B-2 shutdown race: `finishRun` đang chạy giữa chừng có thể bị `dbWriter.shutdown()` bỏ qua → run kẹt 'running'.** Nếu `finishing=true` (finishRun từ cooldown timer đang chạy) khi shutdown gọi `coordinator.stop(true)`, `finishRun` return ngay tại `if (this.finishing) return` (coordinator.ts:503) → `dbWriter.shutdown()` kiểm `finalizePromise` — nếu finishRun chưa kịp tới `writeRunFinish` (còn trong buildReport) thì `finalizePromise=null` → shutdown cho `store.disconnect()` (pool.end), sau đó `writeRunFinish` của finishRun đang bay fail trên pool đã đóng → đúng bug B-2 muốn diệt. Window hẹp (vài ms buildReport) nhưng vẫn là race thật; test B-2 (api-server.test.ts:268) chỉ phủ path writer trực tiếp, không phủ race coordinator này. | coordinator.ts:502-503, 550; server.ts:68-70; writer.ts:62 | CONFIRMED (race) | Lưu `finishPromise` trong coordinator và shutdown await nó (hoặc `stop()` await finishRun đang in-flight); thêm test: shutdown trong lúc finishRun chạy |
| MINOR | **`recordFail` bỏ sót 2 path 4xx: 429 (rate-limit branch rtr về sớm, api-server.ts:229-242) và 400 body (catch BodyError :247-255).** Doc "mọi 4xx login/register = 1 fail" (rate-limit.ts:16) không đúng hoàn toàn. 429 benign (đã blocked). 400-body: attacker spam JSON hỏng/non-object vô hạn không bao giờ dính 429 — cross-confirm finding MINOR #1 của review API Tester. | api-server.ts:220,246 (2 call site recordFail) vs 229-242, 247-255 | CONFIRMED | Gọi `recordFail` trong 2 nhánh còn lại (hoặc sửa doc cho khớp) |
| MINOR | **D-17 comment "frontend ẩn CTA đăng ký khi false" chưa implement.** Server thêm `allowRegister` vào /config (settings.ts:29-30) nhưng `LoadTestConfig` (src/types/loadtest.ts:68-80) không có field, không page nào đọc → register CTA vẫn hiện, mặc định `LOADTEST_ALLOW_REGISTER=false` (loadtest/.env không set key) → click register = 403. RegisterPage xử lý 403 graceful (AlertBanner) nên không crash, chỉ UX lệch thiết kế. | settings.ts:29-30; src/types/loadtest.ts:68-80; loadtest/.env (không có key) | CONFIRMED (doc/impl mismatch) | Thêm `allowRegister` vào type + ẩn CTA khi false; hoặc set `LOADTEST_ALLOW_REGISTER=true` trong .env dev |
| INFO | **`RateLimitConfig.trustProxy` là field chết** — set từ env (rate-limit.ts:206) nhưng không bao giờ đọc trong module; IP resolution thật nằm ở `clientIp` (http-server.ts:71-80). Không phải bug (spoofing đã chặn đúng bằng socket.remoteAddress mặc định), chỉ config thừa. | rate-limit.ts:35,206; grep `trustProxy` chỉ khớp 3 dòng | CONFIRMED (dead field) | Bỏ field hoặc chuyển hẳn quyết định trust-proxy vào limiter |

### Verify PASS

- **Contract preservation — 100% route giữ nguyên.** Bảng route mới (api-server.ts:68-105) vs route cũ (git show HEAD:loadtest/api-server.ts): cả 25 route + method + path + response shape khớp từng cái — `/health`, `/auth/{register,login,logout,me}`, `/start`, `/stop`, `/kill`, `/pause`, `/resume`, `/status`, `/metrics` (tick), `/users`, `/errors`, `/logs`, `/report`, `/report/export`, `/config`, `/allowlist` GET/POST, `/pools`, `/cleanup`, `/runs`, `/runs/:id`, `/runs/:id/metrics`, `/runs/:id/logs`, `DELETE /runs/:id`. Thêm `GET /metrics` (Prometheus, T-07) — không collide `/api/loadtest/metrics`. Handler `stop` tách `force` (body.force) còn `kill` luôn `stop(true)` — tương đương logic cũ (`p.endsWith('/kill') || body.force`). `config` thêm `allowRegister` (additive). `runIdFromPath` cũ decode thẳng → mới `decodeRunIdParam` format-check `/^lt[a-z0-9-]{2,24}$/i` trước decode (SB-2) — mọi runId thật (`newRunId` = `lt`+ts+pid+seq, config.ts:372) và test data (`lt-hist1`, `lt-shutdown1`) đều match; không 404 nhầm.
- **Frontend envelope an toàn**: `unwrap` đọc `data` (loadtest-api.ts:73-77), `toApiError` đọc `statusCode/message/errors/warnings` (:36-45) — không đụng field mới `timestamp/error/requestId`. `health()` unwrap `{status}` khớp shape mới (nhưng frontend hiện không gọi health — dead code trong api client). `stop(force)` → `/kill` với `{force:true}` — kill handler mới bỏ qua body, vẫn `stop(true)`. Export blob (report/export) giữ raw content-type + Content-Disposition như cũ.
- **Rate-limit đúng lõi**: fail window 5/60s → 429 lần 6 + Retry-After + X-RateLimit-* (test api-server.test.ts:538-559 chạy thật trên DB, 676ms); login 2xx → `clear()` reset window (api-server.ts:187); gate 403 register TÍNH 1 fail (:220); token bucket /start 1 per 10s refill đúng; IP = `socket.remoteAddress` trừ `LOADTEST_TRUST_PROXY=1` (clientIp) — chống X-Forwarded-For spoof; write bucket mặc định 0 = OFF (không phá E2E).
- **Register gate**: chạy TRƯỚC body parsing + rate (dispatcher thứ tự gate→auth→rate→handler, api-server.ts:217-243); 403 `{error:'REGISTER_DISABLED'}` đúng shape; `LOADTEST_ALLOW_REGISTER=true` → handler register y hệt cũ (routes/auth.ts:13-34).
- **readBody**: 1MB → 413 `{error:'BODY_TOO_LARGE'}`, dừng đọc stream (chống tiêu băng thông); JSON hỏng/non-object (array/string/number/null) → 400 `'JSON body không hợp lệ'`; rỗng → `{}`. Frontend toApiError parse 413 generic. (Non-object → 400 là hardening mới — cũ accept array; frontend chỉ gửi object nên không đứt.)
- **Module split**: không duplicate readBody (bản cũ đã xoá, http-server.ts là nguồn duy nhất); không circular import (coordinator không import http-server/routes — grep 0 match); dispatcher giữ route table + guard pipeline (B-3). `npm run loadtest:typecheck` exit 0; `npm run loadtest:test` 162/162 pass.

### Verdict

**AN TOÀN ĐỂ COMMIT — không blocker.** Tách module không đổi contract (25/25 route khớp, envelope additive, frontend unwrap/toApiError không đụng field mới, typecheck + 162/162 test xanh). Hardening đúng: CORS echo-origin allowlist, register gate 403 trước body, rate-limit fail-window + token bucket chống spoof IP, readBody 413/400, B-2 shutdown chờ finalize trước pool.end. 2 LOW là bug thật nhưng hẹp/latent: (1) `sweep()` không evict được `failWindows` (key `login:ip` vs IP trần) — leak nhớ chậm, nên fix khi có dịp; (2) race shutdown khi `finishRun` đang in-flight — đúng failure mode B-2 vừa diệt, window vài ms, nên fix bằng finishPromise. 2 MINOR (recordFail bỏ sót 429/400-body, D-17 frontend chưa consume allowRegister) + 1 INFO (trustProxy dead field) — theo dõi, không chặn.

## W2 Reality Check

Reviewed by: Reality Checker (DEFAULT = FAIL, cần bằng chứng ép). REVIEW ONLY — không sửa code.
Date: 2026-08-04.
Scope: Wave 2 — T-06 API hardening (CORS, register gate, rate-limit, 413, B-2 shutdown race) + T-07 observability (health, JSONL multi-process, logger redaction, Prometheus, /metrics). Đã chạy thật `npm run loadtest:test` (179/179 pass, 15 files), `npm run loadtest:typecheck` (exit 0), `npm run build` (exit 0).

### Evidence

| # | Item | Evidence (file:line) | Verdict |
|---|---|---|---|
| 1 | Tests: `loadtest:test` | 179/179 pass (15 files, 4.70s) — chạy thật | PASS |
| 1 | Tests: `loadtest:typecheck` | `tsc --noEmit -p loadtest/tsconfig.json` exit 0, không output | PASS |
| 1 | Tests: `build` | `tsc --noEmit && vite build` exit 0 (chỉ chunk-size warning, không lỗi) | PASS |
| 2 | CORS: không `*` trong response | http-server.ts:59-68 `applyCors` — chỉ set ACAO khi origin nằm allowlist, echo origin; không nhánh nào set `*` | PASS |
| 2 | CORS: preflight OPTIONS → 204 | api-server.ts:194-198 — handle OPTIONS trước route match, writeHead(204) | PASS |
| 2 | CORS: default origin localhost:5173 | config.ts:159 `corsOrigins` default `['http://localhost:5173']`; http-server.ts:30 | PASS |
| 2 | Route table: ≥24 auth:true + public /metrics | api-server.ts:68-105 — đếm 24 route `auth:true` (logout/me/start/stop/kill/pause/resume/status/metrics/users/errors/logs/report/report.export/config/allowlist GET+POST/pools/cleanup/runs/runs:id/runs:id:metrics/runs:id:logs/DELETE runs:id) + `/metrics` public (71-75) trỏ toolMetrics.toPrometheusText | PASS |
| 3 | Register gate: LOADTEST_ALLOW_REGISTER default false → 403 | config.ts:193 `parseBool(env.LOADTEST_ALLOW_REGISTER)` (no default → false); guards.ts:30-32 `registerGate` = env.allowRegister | PASS |
| 3 | Gate fires TRƯỚC body parsing | api-server.ts:218 — step 1 trong dispatcher (gate→auth→rate→handler), trước readBody | PASS |
| 3 | 403 shape | api-server.ts:219 `{success:false, statusCode:403, error:'REGISTER_DISABLED'}`; test api-server.test.ts:449-466 (403 + body.success=false + body.error='REGISTER_DISABLED') | PASS |
| 4 | Rate-limit: 5 fail/60s/IP login/register | config.ts:195-196 defaults (5, 60_000); rate-limit.ts:120-124 FailWindow | PASS |
| 4 | Rate-limit: /start 1/10s | config.ts:197 (10_000); api-server.ts:178 limiterLimit('start')=1; rate-limit.ts:125-128 TokenBucket | PASS |
| 4 | 429 + retryAfterSec + Retry-After header | api-server.ts:232-240 — setHeader('Retry-After') + body.retryAfterSec; test api-server.test.ts:561-582 (429 + RATE_LIMITED + retryAfterSec>0 + retry-after) | PASS |
| 4 | sweep evicts `login:ip`/`register:ip` (FIX-8) | rate-limit.ts:154-165 — delete `login:${key}` + `register:${key}`; test rate-limit.test.ts:13-30 (entryCount→0 sau 11 phút) | PASS |
| 4 | recordFail trên 429+400 (FIX-10) | api-server.ts:242 (429), 253 (BodyError 4xx) — cả 2 gọi recordFail; test api-server.test.ts "FIX-10: 429 đếm thêm fail window" | PASS |
| 5 | Health: cache 10s wired (không buildHealth trực tiếp) | routes/run.ts:18-28 — WeakMap + createHealthProbe (TTL 10_000), KHÔNG gọi buildHealth | PASS |
| 5 | probe query_timeout 2000 | store.ts:196 `{ text:'SELECT 1', query_timeout:2000 }` | PASS |
| 5 | Redis commandTimeout 2000 | auth-factory.ts:384 `commandTimeout: 2000`; coordinator.ts:15,131,201 dùng createRedis | PASS |
| 5 | workers field derive từ workerAlive | health.ts:67-70 deriveWorkers(phase, workerAlive) — idle/running/down | PASS |
| 5 | status có thể 'down' | health.ts:82 — dbRequired+dbDown hoặc db+redis cùng down → 'down' | PASS |
| 5 | redis 'disabled' khi unconfigured | health.ts:56-64 probeRedis — !configured → 'disabled' (không tính status); coordinator.ts:109-111 redisConfigured | PASS |
| 5 | Health tests: db-down→degraded, redis-down→degraded, workers-down→down | health.test.ts:19-30 (db down→degraded), 56-63 (redis down→degraded), 65-71 (workers down→degraded), 88-97 (db required+down→down), 99-109 (db+redis down→down) | PASS |
| 6 | JSONL multi-process: LOGTEST_LOG_FILE='' cho child (FIX-3) | worker-farm.ts:23-25 `workerEnv` ghi đè `LOGTEST_LOG_FILE:''`; dùng ở 68-73 fork | PASS |
| 6 | Logger: redactMsg trên msg (FIX-4) | logger.ts:127-135 redactMsg; dùng ở log() :255 + buildJsonlEntry :230 | PASS |
| 6 | File sink skip khi LOG_FILE unset | logger.ts:227 auto-init guard `if (process.env.LOGTEST_LOG_FILE)`; configureLogger :220 file null → không sink | PASS |
| 7 | Prometheus: # TYPE/# HELP + `_total` (FIX-5) | tool-metrics.ts:53-57 — counter `lt_<k>_total` + TYPE/HELP; gauge `.`→`_`; test tool-metrics.test.ts:27-44 | PASS |
| 7 | /metrics route trỏ toolMetrics | api-server.ts:71-75 — public, text/plain; version=0.0.4 | PASS |
| 8 | Shutdown race (FIX-9): finishRun track finishPromise | coordinator.ts:539-544 — finishing/return chính finishPromise nếu gọi lần 2 | PASS |
| 8 | stop() await finish in-flight | coordinator.ts:303-306 — `if (this.finishing) await this.finishPromise` | PASS |
| 8 | Stop-mid-finalize test | api-server.test.ts:672-697 — stop(true) lần 2 không resolve tới khi writeRunFinish xong | PASS |
| 9 | 413: req.destroy() sau response (FIX-7) | http-server.ts:207-216 — res.once('finish') → req.destroy() | PASS |
| 10 | Cleanliness: git status | Chỉ loadtest/ + docs/AUTOBUILD-prod-refactor.md + loadtest/.env.example; `dist`, `loadtest/.env`, `loadtest/data/*` đều git-ignore (git check-ignore exit 0); loadtest/data chỉ còn .gitkeep | PASS |
| 11 | Không stdout secrets | init.ts:112,114 `redactUrl(connectionString)`; init.ts:132-135 log username/email, KHÔNG in password; server.ts:34 redis redactUrl + otpSecret masked; coordinator.ts:167 gateway qua ltLog (redactMsg→redactUrl); coordinator.ts:203 redisUrl redactUrl. Duy nhất server.ts:84 `console.error('[lt][FATAL]', err)` là catch top-level — pg/ioredis error message không chứa credential (host:port thôi), rủi ro lý thuyết, không phải leak thực tế | PASS (residual: FATAL catch không bọc redact) |

### Verdict

**PASS — W2 đủ bằng chứng để production-ready.** Test 179/179 + typecheck + build đều xanh (chạy thật, không phải số triển khai). CORS echo-origin allowlist không `*` + preflight 204 + default localhost:5173 đúng; register gate 403 trước body parsing đúng + shape `REGISTER_DISABLED` có test; rate-limit 5/60s login/register + /start 1/10s + 429 kèm Retry-After + sweep evict `login:ip`/`register:ip` (FIX-8) + recordFail trên 429/400 (FIX-10) đều có test xanh; health dùng cache 10s (không buildHealth trực tiếp), probe timeout 2s DB + Redis, workers derive từ workerAlive, status 'down' khi dbRequired+down, redis 'disabled' khi unconfigured, và test phủ db-down/redis-down/workers-down → không false-ok; JSONL child worker không kế thừa sink (FIX-3); msg redact mọi sink (FIX-4); Prometheus đủ TYPE/HELP + `_total` (FIX-5); B-2 shutdown await finishPromise (FIX-9) có test; 413 destroy socket (FIX-7); git sạch không .env/data; không stdout secret. 2 điểm cần theo dõi (không chặn): (1) server.ts:84 FATAL catch không bọc redact — lý thuyết, pg/ioredis không in credential; (2) chunk-size warning frontend bundle 1.19MB — không thuộc scope Wave 2.
