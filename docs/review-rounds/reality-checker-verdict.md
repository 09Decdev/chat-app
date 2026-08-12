# Reality Checker — Verdict (G7) — fix E2 loadtest connect-fail + 2 feature kèm

- **Branch**: `fix/loadtest-e2-connect-fail` (13 commit: T1-T7 + 3 fix Phase 4b + 309f1d1 community + fa4da02 pool json + 6fe58da G2 tests)
- **Ngày chấm**: 2026-08-06 · **Người chấm**: Reality Checker (cửa ship cuối)
- **Phương pháp**: TỰ CHẠY lại tất cả gate (không tin report). Toàn bộ kết quả dưới đây là output tôi chạy được trên máy này.

---

## 1. Bảng HARD-GATE G1-G10

| # | Gate | Verdict | Bằng chứng (tôi chạy, không phải "agent nói") |
|---|---|---|---|
| **G1** | Tests | **PASS (điều kiện)** | Tôi chạy `npx vitest run --config loadtest/vitest.config.ts` (107.22s): **455 pass / 1 fail / 46 skip (502)** — nhiều hơn con số 411 trong AUTOBUILD (G2 đã bổ sung test sau). Frontend `npx vitest run --config vitest.config.ts` (workaround rename `vitest.workspace.ts`, đã khôi phục): **151/151 pass (16 files)**. Điều kiện: 46 skip = DB-dependent pre-existing (chấp nhận, debt); 1 fail `config.test.ts` = MÔI TRƯỜNG, đã chứng minh: chạy lại không có `loadtest/.env` → **67/67 xanh** (fail là `LOADTEST_MAX_REGISTER_RAMP=2000` + `LOADTEST_WORKERS=4` từ .env máy, assertion pre-existing từ main, không phải regression branch). |
| **G2** | Mutation | **PASS (deviation ghi nhận)** | Report round 2: tổng 57.72% < 60% ngưỡng template NHƯNG covered 76.05%, **0 live mutant nguy hiểm critical region**, 8/8 mutant nguy hiểm vòng 1 đã bị giết. Tôi spot-check 2/3 claim equivalent: (a) `histBucketCount` tại coordinator-state.ts:234/278 — **dead local XÁC NHẬN** (chỉ ghi, không đọc → Math.max→Math.min vô hại); (b) `TRANSITIONS[from]?.includes` (dòng 32) — equivalent hợp lý (map phủ đủ 9 RunPhase, TS-enforced). Score thấp do nợ test code runtime pre-existing (scheduler/CPU/REST pacing — có e2e integration bù tầng cao). Deviation được chấp nhận với điều kiện ghi nợ + target v1.1 (tách pure helpers để critical score ≥ 90%). |
| **G3** | Contract | **N/A** | Tool nội bộ tự host, không consumer bên ngoài. `contract.test.ts` + `types-contract.test.ts` PASS trong suite. |
| **G4** | Type/Lint | **FAIL** | `npx tsc --noEmit -p loadtest/tsconfig.json` PASS · `npx tsc --noEmit` (FE) PASS. NHƯNG eslint: `npx eslint loadtest/ src/` = **5 error** (sanitize.ts:11, logger.ts:281/385/404, sanitize.test.ts:14 — toàn bộ `no-control-regex`). logger.ts trên main có **0** regex control-char → **5 lỗi MỚI từ branch này**. Claim AUTOBUILD "0 warning mới" **SAI**. `npm run lint` fail. Fix đơn giản (regex cố ý của sanitizer → eslint-disable comment) nhưng là hard-gate chưa đạt. |
| **G5** | SAST + secret | **PASS (automated) + nợ R-3 BẮT BUỘC** | gitleaks không cài (xác nhận `which gitleaks` fail — cơ chế gate chưa active, pre-existing). Bù: ST-11 secret-hygiene test PASS trong suite; tôi tự chạy `git ls-files | grep -E 'users_accounts|accounts-|\.env$|auth-secret'` → **RỖNG** (0 file credential track); `.env.example` chỉ placeholder; diff main...HEAD không chứa secret/`.env`. **NHƯNG nợ R-3 CHƯA ĐÓNG và đang NẶNG HƠN**: `users_accounts.json` (1MB, mật khẩu plaintext production users) nằm ở repo ROOT + `loadtest/data/accounts-*.json` (36MB, accessToken+refreshToken thật) + `auth-secret.json` — và feature pool-json mới đang **CHỦ ĐỘNG đọc file này** (`loadtest/.env:58 LOADTEST_POOL_FILE=C:/MAYogu_VIASG/chat-app/users_accounts.json` — đã set trên máy). **Phát hiện MỚI của tôi**: `.stryker-tmp/` (373MB, artifact của mutation gate) chứa BẢN SAO credentials thật (users_accounts.json + accounts-*.json trong sandbox) và **KHÔNG được gitignore ở cấp repo** — `git add .` sẽ stage **2533 file** (file credential may mắn được pattern `users_accounts*.json` + `loadtest/data/*` không leading-slash bảo vệ — đã verify bằng dry-run add). |
| **G6** | Code Reviewer | **PASS** | 3 vòng review tồn tại và nhất quán với git history: F1 (R2 CRITICAL wiring) → **0895e23** (tôi verify `coordinator.ts:535/571/585` — window thật được wire, không còn dead code); F-T7-1 → **35292c4** (ramping→cooldown); F-T7-2 → **e2a008c** (đếm kênh B). Grep docs: không blocker/major mở. SEC PASS kèm 3 điều kiện — R-1 đã đóng, R-2/R-3 là debt công khai. |
| **G7** | Reality Checker | **NOT SHIPPABLE** | Xem §4. |
| **G8** | Migration | **N/A** | 0 file migration/schema trong diff (DESIGN §8 xác nhận 0 schema change). |
| **G9** | Tiền | **N/A** | 0 file payment trong diff. |
| **G10** | Auth/PII | **PASS (kèm note)** | `loadtest/auth.ts / guards.ts / api-server.ts / http-server.ts / server.ts` = **0 diff**. `auth-factory.ts` thay đổi = feature pool-file (nạp TestAccount từ JSON, KHÔNG đổi giao thức auth). ST-9 auth regression 12 test PASS trong suite. |

---

## 2. AC-1..AC-7 (PRD)

| AC | Bằng chứng | Trạng thái |
|---|---|---|
| **AC-1** — 5% broken, rate < 30%, run finished | e2e (b) PASS trong run của tôi: rate ~20.8% < 30%, usersFailed = 5, connectFails ≤ 25 (cap 5×5), run finished | **ĐẠT** |
| **AC-2** — 100% broken → E2 ≤ 60s, reason 'E2:' | e2e (c) + (d) PASS: phase 'error', stopReason `/^E2:/`, < 60s, usersFailed == userCount | **ĐẠT** |
| **AC-3** — < 50 attempts không evaluate | coordinator-state.test.ts:186-187 (100% fail, 49 attempts → không dừng), :295-300, :303 (49 vs 50 biên) PASS | **ĐẠT** |
| **AC-4** — log E2 8 trường | e2e (d) assert `E2_LOG_RE` + byType sum == fails, PASS (tôi thấy log thật trong output: `phase=ramping elapsedSec=9 windowSec=8 windowAttempts=53 windowFails=53 byType=timeout:0,transport:0,reject:53,other:0 usersFailedCum=60 workersAlive=1`) | **ĐẠT** |
| **AC-5** — 10k thật, rate < 5% | **CHƯA CÓ run thật** — manual gate, canary Bậc 3b (cổng người). Không có bằng chứng automated | **CHƯA ĐỦ BẰNG CHỨNG** (manual gate đã ghi debt) |
| **AC-6** — dashboard hiển thị | LiveDashboardPage.test.tsx 13 case (nhiều hơn 6 được báo cáo) + user-phases.test.ts 6 case — 151/151 PASS (test-level, không screenshot) | **ĐẠT** (test-level) |
| **AC-7** — E1/E3 nguyên vẹn, E2 auto-stop thật | E1 boundary (49.9% → không dừng) + e2e (d) (E2 stop kênh reject thật, usersConnected == 0) + M7 scheduler skip failed — PASS | **ĐẠT** |

---

## 3. 2 feature kèm — verdict riêng

### 3.1 Community scoping (309f1d1)
- **Test**: rest-actions.test.ts 5 case liên quan (community endpoint, like/comment dùng postId community, 403 → fallback getAll + lọc local, items rỗng → fallback, không set → hành vi cũ) + config.test.ts — đều PASS trong suite của tôi.
- **Env**: `.env.example` đã document; `.env` đã set (`LOADTEST_COMMUNITY_ID=f8f2669f-...`).
- **Rủi ro vận hành**: fallback 403 đã implement + test. Không migration, không đụng auth. **Verdict: OK — không chặn merge.**

### 3.2 Pool json (fa4da02)
- **Test**: pool-file.test.ts 6 case (array format, {accounts} format, giữ deviceInfo/accessToken, file hỏng → throw rõ, set/rỗng env, **pool cạn → fail run sớm KHÔNG gọi HTTP**, login qua mock không register) — PASS.
- **Env**: `.env.example` đã document; `.env` **ĐÃ SET** trỏ vào `users_accounts.json` tại repo root (credential thật).
- **Secret hygiene**: file không bị commit (ST-11 PASS, ls-files rỗng — tôi tự xác nhận).
- **Rủi ro vận hành**: pool 10.532 account — nếu target > pool → fail sớm đã implement. **NHƯNG feature này CHỦ ĐỘNG đọc file credential trong cây repo → nâng mức độ nghiêm trọng của nợ R-3** (trước đây file chỉ nằm im, giờ là input vận hành). **Verdict: chức năng OK, nhưng KHÔNG merge độc lập được — gắn chặt với điều kiện R-3** (move-out + rotate + gitleaks trong cùng release window, đúng cam kết đã ghi nợ).

**Kết luận 2 feature**: cả hai có test thật, env document đầy đủ, không chặn riêng lẻ — nhưng pool-json làm R-3 trở thành điều kiện bắt buộc trước khi tool chạy production (Bậc 3a canary).

---

## 4. RELEASE-SAFETY

| Mục | Trạng thái | Ghi chú |
|---|---|---|
| Feature flag/kill-switch | PASS | E2 ngưỡng hằng cứng cố ý (không config hóa); kill-switch = Stop/force Stop UI-API (coordinator.ts:361-389); validateRunRequest chặn < 1000 users |
| Canary staged | PASS (kế hoạch) | CANARY doc 5 bậc (smoke 1000 → e2e 5% → e2e kênh B → 5k → 10k), cổng người trước Bậc 3a/3b; quy tắc dừng rõ |
| Rollback plan + drill | PASS (kế hoạch) | Rollback = `git checkout <sha-an-toan> -- loadtest/` + restart (0 DB change); drill bắt buộc ≥ 1 lần trước Bậc 0 — **chưa chạy** (kế hoạch, chưa phải bằng chứng đã chạy) |
| Observability | PASS (có giới hạn) | Dashboard live + log E2 8 trường + metrics snapshot + gateway scrape. **KHÔNG alerting tự động** — chấp nhận cho tool nội bộ tự host (người theo dõi dashboard trong mỗi bậc), đã ghi debt không chặn |

---

## 5. Verdict cuối

### **NOT SHIPPABLE** (ngay lúc này) — code quality tốt, bằng chứng test thật và mạnh, NHƯNG 2 hard-gate chưa đạt điều kiện + 1 nợ vận hành đang tăng nặng.

**Lý do chính**: G4 eslint FAIL (5 lỗi mới từ branch, `npm run lint` đỏ — claim "0 warning mới" sai) và G5 nợ R-3 chưa đóng trong khi feature pool-json (cùng branch này) đang chủ động đọc file credential production tại repo root — cộng phát hiện mới `.stryker-tmp/` (373MB bản sao credential thật, không gitignored).

**Danh sách điều kiện bắt buộc trước khi merge/ship (theo thứ tự ưu tiên)**:

1. **G4 — fix 5 eslint error** (sanitize.ts:11, logger.ts:281/385/404, sanitize.test.ts:14): thêm `eslint-disable-next-line no-control-regex` (regex cố ý của sanitizer) hoặc refactor regex. → `npm run lint` xanh.
2. **G5 — nợ R-3 (bắt buộc trong cùng release window, đã cam kết)**:
   - Move-out `users_accounts.json` (repo root) + `loadtest/data/accounts-*.json` + `loadtest/data/auth-secret.json` khỏi cây repo (ra ngoài thư mục repo, ví dụ `~/loadtest-secrets/`).
   - **Rotate** credentials pool (password tự sinh — cần người/vận hành tạo file seed mới bên ngoài repo).
   - Cài gitleaks + chạy `npm run secret:scan` (gate ST-11 đã sẵn, cần cơ chế active).
   - Cập nhật `LOADTEST_POOL_FILE` trỏ tới vị trí mới; xoá file cũ trong cây.
3. **G5 — hygiene mới (phát hiện của tôi)**: thêm `.stryker-tmp/` vào `.gitignore` (dòng 48) + xoá thư mục 373MB. Mutation gate sẽ tái tạo mỗi lần chạy — cần ignore ngay để không bao giờ lọt `git add .`.
4. **AC-5 (manual gate)**: run 10k thật trên môi trường test theo CANARY Bậc 3a/3b với cổng người — KHÔNG ship đến production gateway trước khi Bậc 0-2 PASS và founder duyệt (quy trình đã viết sẵn).

**Ghi nợ chấp nhận được (không chặn)**:
- G2 deviation 57.72% < 60% (critical 0 nguy hiểm, covered 76.05%, dead local verified) → target v1.1.
- 46 skipped tests DB-dependent; AC-6 không screenshot (test-level); vitest workspace bug (workaround đã chạy, không phải lỗi branch); no alerting tự động (tool nội bộ).

**Ước lượng**: 1 revision cycle (vài giờ — các fix 1-3 đều nhỏ), sau đó chạy lại: `npm run lint` + full vitest 2 suites + `npm run secret:scan` → mới được xét SHIPPABLE.

---

# RE-VERIFY vòng 2 — sau 2 commit dọn điều kiện (188f8e8, 8acf586)

- **Ngày chấm lại**: 2026-08-06 · **Người chấm**: Reality Checker · **Branch**: `fix/loadtest-e2-connect-fail` (git status sạch, ngoài docs untracked)
- **Phương pháp**: như vòng 1 — TỰ CHẠY lại tất cả, không tin report.

## 1. Kiểm chứng từng điều kiện vòng 1 (tôi chạy, bằng chứng cứng)

| Điều kiện vòng 1 | Kết quả tôi tự chạy | Verdict |
|---|---|---|
| **(1) G4 — 5 eslint error** | `npm run lint` → **exit 0, 0 error 0 warning** (eslint .). Lặp lại đúng lệnh vòng 1 `npx eslint loadtest/ src/` → **exit 0**. 5 dòng `eslint-disable-next-line no-control-regex` đúng chủ đích (3 dòng e2e-mock-gateway-e2.test.ts:278/382/401 + 1 sanitize.test.ts:11 + 1 sanitize.ts:8 — commit 188f8e8, 5 insertions). Ghi chú: vòng 1 ghi "logger.ts:281/385/404" — file thực tế là `e2e-mock-gateway-e2.test.ts` (nhầm tên file, cùng vị trí dòng); kết quả gate không đổi: xanh. | **PASS** |
| **(2) R-3 move-out + rotate + gitleaks** | (a) `git ls-files \| grep -iE 'users_accounts\|accounts-\|auth-secret\|\.env$'` → **RỖNG** (exit 1). (b) File cũ ĐÃ BIẾN MẤT khỏi cây repo: `users_accounts.json` (root), `loadtest/data/accounts-*.json`, `loadtest/data/auth-secret.json` → No such file. (c) `C:/MAYogu_VIASG/secrets/` tồn tại chứa: users_accounts.json (1MB) + 7 file accounts-ltms*.json (97B–14.5MB) + auth-secret.json (112B) — chỉ kiểm tra tên, KHÔNG đọc nội dung. (d) `loadtest/.env:46 LOADTEST_DATA_DIR=C:/MAYogu_VIASG/secrets`, `:58 LOADTEST_POOL_FILE=C:/MAYogu_VIASG/secrets/users_accounts.json` — trỏ NGOÀI repo; `loadtest/.env` gitignored (dòng 12). (e) `.stryker-tmp/` gitignored (dòng 45) + thư mục đã xóa khỏi đĩa. (f) .gitignore giờ đủ pattern: `loadtest/data/*` (34), `.stryker-tmp/` (45), `users_accounts*.json` (51). | **PASS (phần code) — rotate còn lại = việc NGƯỜI** |
| **(3) Gitleaks fixtures giả** | gitleaks **KHÔNG cài trên máy** (`which gitleaks` fail) → `npm run secret:scan` chưa chạy được. Tương đương tôi chạy: ST-11 secret-hygiene test **2/2 PASS** (chạy riêng `vitest __tests__/secret-hygiene.test.ts`); tự grep pattern secret (JWT/AWS key/ghp_/sk-/PRIVATE KEY) trên tracked non-test files → **chỉ 2 hits, đều fixture giả**: `.gitleaks.toml` (allowlist fixture — đúng thiết kế) + `docs/AUTOBUILD-prod-refactor.md:856` trích JWT header `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9` từ fixture logger.test.ts:92 (chỉ header base64 của `{"alg":"HS256","typ":"JWT"}`, không payload/signature → không credential). `.gitleaks.toml` đã allowlist đúng các fixture (stopwords test-secret/e2e-otp-secret/e2e-auth-secret + regex fixtures). | **PASS-điều kiện** — cài gitleaks + quyết allowlist = NGƯỜI |
| **(4) AC-5 run 10k thật** | Không có run thật mới — vẫn là manual gate canary Bậc 3b (cổng người). KHÔNG phải lỗi code. | **KHÔNG ĐỔI — chờ NGƯỜI** |
| **(5) G1 tests** | Loadtest suite: **455 pass / 1 fail / 46 skip (502)** — y hệt vòng 1. Fail duy nhất = `config.test.ts:424` env máy: `expected 2000 to be 100` (maxRegisterRamp — `loadtest/.env:34 LOADTEST_MAX_REGISTER_RAMP=2000`). Đã kiểm chứng lại 2 chiều: rename tạm `loadtest/.env` → **67/67 xanh**, khôi phục file. Fail pre-existing từ main (assertion dòng 424 không nằm trong diff branch), không phải regression 2 commit mới. FE: **151/151 PASS (16 files)** với workaround rename `vitest.workspace.ts` (đã khôi phục). Lưu ý: `--config vitest.config.ts` KHI vitest.workspace.ts tồn tại → vitest merge 2 project → FE collection fail (bug vitest workspace pre-existing; `vitest.workspace.ts` không nằm trong diff branch — `git diff main...HEAD --name-only \| grep workspace` rỗng). Không phải regression. | **PASS (điều kiện)** — 46 skip DB debt + 1 fail env pre-existing (chấp nhận, debt) |
| **(6) G2 mutation** | `mutation-report.md` KHÔNG đổi: commit cuối đụng file = 6fe58da (TRƯỚC 2 commit mới), git status file sạch. 2 commit mới không đụng source logic: `git show --stat 188f8e8` = chỉ 5 dòng eslint-disable trong 3 file (sanitize.ts + 2 test); `git show --stat 8acf586` = .gitignore + loadtest/.env.example + config.test.ts. | **PASS** |
| **(7) G6 — 2 commit mới không đụng source chính** | Xác nhận bằng `git show --stat 188f8e8 8acf586` (chi tiết ở dòng trên): eslint-disable + .gitignore + .env.example + config.test.ts (thêm cô lập `LOADTEST_DATA_DIR:''` + test LOADTEST_COMMUNITY_ID). Không cần re-review sâu. | **PASS** |

## 2. Bảng HARD-GATE G1-G10 — cập nhật vòng 2

| # | Gate | Vòng 1 | Vòng 2 | Ghi chú |
|---|---|---|---|---|
| G1 | Tests | PASS (điều kiện) | **PASS (điều kiện)** | Không đổi: 455/1/46 loadtest (1 fail env pre-existing, đã chứng minh 67/67 khi bỏ .env) + FE 151/151 |
| G2 | Mutation | PASS (deviation) | **PASS** | Report không đổi; 2 commit mới không đụng source logic |
| G3 | Contract | N/A | N/A | Không đổi |
| G4 | Type/Lint | **FAIL** | **PASS** | `npm run lint` exit 0 — 0 error 0 warning (5 disable-next-line chủ đích) |
| G5 | SAST + secret | PASS + nợ R-3 | **PASS (điều kiện)** | Move-out hoàn tất + gitignore đủ + ST-11 2/2; ROTATE + cài gitleaks = việc NGƯỜI |
| G6 | Code Reviewer | PASS | **PASS** | Không đổi |
| G7 | Reality Checker | NOT SHIPPABLE | **SHIPPABLE (điều kiện NGƯỜI)** | Xem verdict dưới |
| G8-G10 | Migration/Tiền/Auth | N/A/PASS | Không đổi | Auth 0 diff |

## 3. Verdict cuối vòng 2

### **SHIPPABLE (với điều kiện NGƯỜI)** — cả 3 điều kiện kỹ thuật vòng 1 (G4 lint, R-3 move-out + hygiene, G2 không đổi) đã đóng bằng bằng chứng tôi tự chạy trên máy; chỉ còn việc thuộc cổng NGƯỜI: rotate credential + AC-5 run 10k qua canary + cài/allowlist gitleaks + duyệt merge.

**Danh sách CHÍNH XÁC việc còn lại — tách "chặn" vs "nên làm"**:

**Chặn production (cổng người, KHÔNG phải lỗi code — merge branch được, KHÔNG chạy tool production trước khi xong)**:
1. **Rotate credentials pool** (R-3 còn lại): file đã ngoài repo nhưng credential cũ vẫn còn hiệu lực — người/vận hành tạo file seed MỚI tại `C:/MAYogu_VIASG/secrets/` + xoá file cũ, cập nhật `LOADTEST_POOL_FILE` (path không đổi, chỉ đổi nội dung file).
2. **AC-5**: run 10k THẬT theo CANARY Bậc 0→3b với cổng người từng bậc (smoke 1000 → e2e 5% → kênh B → 5k → 10k), rate < 5%. Chưa có run thật — manual gate đã ghi nợ từ vòng 1.

**Nên làm (không chặn merge — chấp nhận rủi ro thấp có cơ chế bù)**:
3. **Cài gitleaks + chạy `npm run secret:scan`**: gate chưa active (gitleaks chưa cài). Bù hiện có: ST-11 secret-hygiene test 2/2 (fail nếu track credential) + .gitignore đủ pattern + allowlist fixture trong `.gitleaks.toml`. Quyết định allowlist fixtures = người sở hữu (rủi ro thực thấp — không có credential thật trong repo, các finding dự kiến đều fixture giả đã verify).
4. **Duyệt merge** branch `fix/loadtest-e2-connect-fail` → main (cổng người).

**Ghi nợ không đổi từ vòng 1**: G2 deviation 57.72% (covered 76.05%, 0 live mutant nguy hiểm critical — report không đổi); 46 skip DB-dependent; AC-6 test-level không screenshot; vitest workspace bug (pre-existing, workaround rename workspace — không nằm trong diff branch); no alerting tự động (tool nội bộ).

---
**Reality Checker** · **2026-08-06** · **Bằng chứng vòng 2**: tôi chạy trực tiếp trên máy (`npm run lint` 0/0, `eslint loadtest/ src/` 0, vitest loadtest 455/1/46, FE 151/151 workaround workspace, config.test.ts 67/67 không .env, ST-11 2/2, `git ls-files` rỗng credential, `git check-ignore` khớp, `git show --stat` 2 commit, scan pattern secret thủ công).
