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