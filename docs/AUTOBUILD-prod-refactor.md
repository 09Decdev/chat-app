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
