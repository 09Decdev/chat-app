# AUTOBUILD — fix E2 loadtest connect-fail (branch `fix/loadtest-e2-connect-fail`)

**File**: Phase 5 synthesize (Agents Orchestrator) · **Ngày**: 2026-08-05
**Branch**: `fix/loadtest-e2-connect-fail` (base `main`) · **10 commits**:

```
e2a008c fix(loadtest): F-T7-2 count io-server-disconnect (E2)      ← Phase 4b fix 3
35292c4 fix(loadtest): F-T7-1 ramping→cooldown + sanitize stopReason ← Phase 4b fix 2
14d4171 fix(loadtest): T6b banner stopReason + card label (E2)      ← Phase 4b fix 1
1a383cc test(loadtest): T7 integration E2 scenarios (E2)            ← T7
0895e23 feat(loadtest): T5 wire window E2 (E2)                      ← T5
f51dc40 feat(loadtest): T4 classify + sanitize connect errors (E2)  ← T4
9eaa9d8 feat(loadtest): T6 dashboard connect metrics (E2)           ← T6
f8248a2 feat(loadtest): T3 cap retry connect (E2)                   ← T3
c470b56 feat(loadtest): T2 sliding window wall-clock (E2)           ← T2
4e05426 feat(loadtest): T1 contract connect metrics (E2)            ← T1
```

Nguồn chính thức: `docs/PRD-loadtest-e2-connect-fail.md` · `docs/PLAN-loadtest-e2-connect-fail.md` · `docs/DESIGN-loadtest-e2-connect-fail.md` · `docs/UI-SPEC-loadtest-e2-connect-fail.md`.

---

## 1. Mục lục chạy (Phase 0 → 5)

| Phase | Việc | Agent/Artifact | Kết quả |
|---|---|---|---|
| **0 — Spec** | PRD + PLAN + UI-SPEC từ bug gốc (log 41% connect-fail, root cause #1 counter cumulative, #3 từ chối nhất thời; PRD §1.2 ghi sai kênh reject — hiệu đính ở Phase 4) | PM/spec + document | `PRD-loadtest-e2-connect-fail.md` (AC-1..AC-7) · `PLAN` · `UI-SPEC` |
| **1 — Design Council** | 3 proposal (backend/security/ui) → 3 critique (correctness/perf/security) | 3 critic + 1 adjudicator (Backend Architect) | **21 finding** → 18 ACCEPT · 1 MERGE (SEC-1+F-7) · 1 REJECT (F-6) — `DESIGN-loadtest-e2-connect-fail.md` (source of truth, thay PLAN cũ ở mục 10) |
| **2 — Implement đợt 1** | T1 (contract) · T2 (window wall-clock) · T3 (cap 5 mọi user) · T6 (dashboard connect metrics) | dev (realtime/correctness) | 4 commit: 4e05426, c470b56, f8248a2, 9eaa9d8 |
| **3 — R2 Critics** | 3 lens (correctness/perf/security) phản biện diff `main...HEAD` 4 commit đầu | 3 critic | **14 finding sống** (7 correctness · 4 security · 3 perf) — **F1/P1/S-1 CRITICAL: T5 wiring THIẾU — window dead code, rate vĩnh viễn 0 → branch chưa fix bug gốc** |
| **2b — Implement đợt 2** (loop lại dev theo R2) | T4 (classify + sanitize 3 sink) · T5 (wiring window vào coordinator) · T7 (integration e2e mock gateway) · T6b (banner stopReason + card label) | dev | 4 commit: f51dc40, 0895e23, 1a383cc, 14d4171 — đóng critical wiring + toàn bộ finding R2 |
| **4 — Panel Phase 4** | 3 lens (correctness/realtime/security) đọc toàn diff T1..T7 | 3 critic | `panel-phase4-correctness.md`: **F-T7-1 (BLOCKER, AC-1 kẹt ramping vĩnh viễn), F-T7-2 (HIGH, E2 mù kênh reject thật của gateway), F-T7-3 (ACCEPT-doc)** + X-1/X-2/X-5 minor, X-3/X-4 PASS; `panel-phase4-realtime.md`: kênh reject thật = B (`client.disconnect()` post-handshake — verified node_modules socket.io-client 4.8.3), E2 mù; `panel-phase4-security.md`: **SEC PASS kèm 3 điều kiện** (R-1 sanitize stopReason, R-3 F-6 move-out/rotate/gitleaks, R-2 debt v1.1) |
| **4b — Fix panel** | F-T7-1 (ramping→cooldown + R-1 + X-1) · F-T7-2 (count io-server-disconnect kênh B + mock acceptThenDrop) | dev | 2 commit: 35292c4, e2a008c |
| **5 — Synthesize** | Xác minh build + viết AUTOBUILD (file này) · mutate-test chạy song song (G2) · Reality Checker verdict (PENDING) | Agents Orchestrator · Test Automation Engineer · Reality Checker | Xem §4 (verify) · §5 (HARD-GATE) · Kết luận (trống — chờ Reality Checker) |

## 2. Quyết định chính

1. **F-4 (correctness) — BÁC số học finding**: claim "2 chu kỳ restart → 33% > 30%" sai model đếm — worker restart = CẢ cohort user reconnect (paced), healthy user mỗi connect +1 attempt → rate mỗi chu kỳ = `5B/(H+5B)` **bất biến** (20.8% với 5% broken). Quyết định **(b) chấp nhận**: không persist per-user state qua restart (quá nặng, race-prone; window 60s đã giới hạn đóng góp). Kèm skip-first-tick sau restart. (`DESIGN §5.3`)
2. **AC-1 giữ ngưỡng 30%**: F-T7-3 (transient phụ thuộc pacing ở slow-ramp) → **ACCEPT-document, KHÔNG đổi code** — AC-1 đảm bảo ở ramp ≥ ~20/s; slow-ramp = giới hạn tham số (note PRD §4, cùng class BE-1/§11.1). Hysteresis 2 tick + `connectWindowAttempts` → v1.1. (`panel-phase4-correctness.md` §A-F-T7-3)
3. **F-T7-2 — đếm kênh B (reject thật của gateway)**: gateway thật reject bằng `client.disconnect()` post-handshake (NestJS IoAdapter) → client nhận `'connect'` rồi `'disconnect' ("io server disconnect")` — **KHÔNG connect_error, KHÔNG retry** (verified socket.io-client 4.8.3 `destroy()` chặn manager `_close()`). Fix: đếm 1 reject-fail (attempt đã đếm ở `'connect'` — giữ invariant fails ≤ attempts), cutover `phase='failed'` NGAY, không `reconnectCount++`, `io.reconnection(false)`. Các reason khác (transport close/ping timeout) KHÔNG đếm — kênh C + cap-5 bao phủ. Không mâu thuẫn cap-5 (kênh B 1-shot, cap quản kênh C retry-loop). Trade-off chấp nhận: kick enforcement user khỏe → 1 fail (bounded, đúng nghĩa "server từ chối session"). (`panel-phase4-realtime.md` §3)
4. **Sanitizer 3 sink** (`loadtest/sanitize.ts`, PURE): `sanitizeLogText` — strip control chars (F-3), URL credential (F-5), query/KV secret key (F-5), JWT/2-part/hex ≥ 32 (F-5), cap length. Áp tại đúng 3 sink: `recordError` (code cap 64, message cap 160), `lastError` (MỌI điểm gán, cap 160), `redactMsg` (logger — mọi sink đường log được lợi). Kèm `MAX_ERROR_CODES = 20` + bucket `OTHER` (S-4). (`DESIGN §3`)
5. **Window 60s wall-clock + skip-first-tick** (PF1): bucket lưu `ts`, evict theo `age > 60s` (evict trước safety cap 120), diff per-worker `max(0, ·)` clamp, skip tick đầu sau restart — window nghĩa đúng 60s thực, hết "bucket trôi dưới tải / bucket phình sau restart". (`DESIGN §4`, T2/T5)
6. **Cap-5 MỌI user (kể cả everConnected)** (F-1): cohort token hết hạn giữa run không retry vô hạn; cap là rào duy nhất cho kênh C (nguồn 41% thật); user failed TERMINAL (guard `'connect'`), không tốn CPU action (scheduler skip). (`DESIGN §5`)
7. **Log E2 8 trường — byType = WINDOW, cumulative suffix `Cum`** (SEC-1+F-7 MERGE): `windowFails` == sum(byType) để log tự nhất quán; `usersFailedCum`/`workers` đánh dấu `Cum`. (`DESIGN §6`)
8. **F-6 REJECT (giữ defer, sửa lập luận)**: không move-out `users_accounts.json`/`accounts-*.json` trong fix E2 (minimal-change); bác lập luận "gitignore = không có vector leak"; ghi nợ vận hành R-3 (move-out + rotate + gitleaks TRONG CÙNG release window; gate test ST-11 đã sẵn). (`DESIGN §1 #15`)

## 3. Các vòng phản biện

### 3.1 Design Council — 21 finding → 18A · 1M · 1R (+1 ACCEPT-điều kiện)

**21 finding** = correctness 9 (BE-1..4, SEC-1..2, UI-1..3) + security 8 (F-1..F-8) + perf 4 (PF1..PF4). Phán quyết: **18 ACCEPT · 1 MERGE (SEC-1+F-7) · 1 REJECT (F-6)** — trong đó F-8 ACCEPT-với-điều-kiện (giảm thiểu MVP; fix đầy đủ `connectWindowAttempts` → v1.1). Chi tiết bảng đầy đủ ở `DESIGN-loadtest-e2-connect-fail.md` §1.

### 3.2 R2 Critics — 14 finding sống; critical wiring đã fix

3 lens đọc diff 4 commit đầu (T1/T2/T3/T6): correctness 7 (F1 CRITICAL — T5 wiring thiếu → E2 vẫn cumulative, window dead code, 5/7 AC không đạt; F2..F7), security 4 (S-1..S-4), perf 3 (P1 MAJOR dead-code tương đương F1; P2/P3 minor). **F1/P1/S-1 = 1 gốc**: `coordinator.ts` chưa wire window + `rates.connectFailRate` hardcode 0 + `connectFailsByType` không sum → đóng bởi **T5 (0895e23 wiring + override rate)** + **T4 (f51dc40 sum byType + classify + sanitize)**; F2/F5/S-2/S-3/S-4 đóng bởi T4; F6 đóng bởi T5 (`finishRun('auto', 'E2: …')`); F7 đóng bởi T2.

### 3.3 Panel Phase 4 — F-T7-1/2/3 + SEC PASS 3 điều kiện

- **F-T7-1 (BLOCKER)**: run kẹt `ramping` vĩnh viễn khi có user failed (cap-5 → connected plateau < target; duration chỉ kiểm ở steady) → AC-1 vỡ. Đóng bởi **35292c4** (path ramping→cooldown theo `elapsedSec >= durationSec`; E2/E3 vẫn chạy trước phase-advance — BE-4). Hệ quả: e2e (b) giờ kết thúc `finished` thật (stopReason 'duration hết', rate ~20.8%).
- **F-T7-2 (HIGH)**: E2 mù kênh reject thật (B — io server disconnect) → AC-2 không chứng minh được trước gateway thật + user kẹt 'connecting' vĩnh viễn. Đóng bởi **e2a008c** (đếm 1-shot reject + terminal failed + mock `acceptThenDrop` + e2e (d)).
- **F-T7-3 (ACCEPT-doc)**: transient > 30% ở slow-ramp — ghi note PRD §4, không đổi ngưỡng. → v1.1 (hysteresis).
- **X-1** (rate mất ở cooldown → report 0% cuối run): đóng bởi **35292c4** (rate roll cả phase cooldown). **X-2** (breakdown cumulative vs window sau restart): đóng bằng guard `cumulativeResetDanger` (LiveDashboardPage.tsx:191-195 — window rate ≥ 30 + cumulative reset → vẫn hiện banner cảnh báo, không nói "không có connect fail"). **X-5** (banner phase 'error' hiện text cứng E1/E2): đóng bằng `stopReason` từ store (LiveDashboardPage.tsx:288, 345-346). **X-3/X-4**: PASS verified, không sửa.
- **SEC: PASS kèm 3 điều kiện** — R-1 (sanitize stopReason) → đóng bởi **35292c4**; R-3 (F-6 move-out/rotate/gitleaks) → **debt, gate test ST-11 sẵn sàng**; R-2 (debt v1.1: accept-then-drop vào window + cap churn reconnect) → **debt v1.1** (pre-existing semantics).

### 3.4 Bảng finding → phán quyết → đóng bởi commit

| Finding (vòng) | Severity | Phán quyết | Đóng bởi |
|---|---|---|---|
| BE-1 (council) | minor | ACCEPT (giới hạn tham số + test) | DESIGN §11.1 + T7 e2e |
| BE-2 (council) | major | ACCEPT (semantics "cumulative per-worker từ lúc process khởi động") | T1 4e05426 |
| BE-3 (council) | minor | ACCEPT (windowSec = span thật) | T5 0895e23 |
| BE-4 (council) | minor | ACCEPT (auto-stop trước phase-advance) | T5 0895e23 |
| SEC-1+F-7 (council) | major | **MERGE** (byType = window; suffix `Cum`) | T4/T5 |
| SEC-2 (council) | minor | ACCEPT (math: 3000/13000 = 23.1%) | T3 + T7 e2e |
| UI-1/UI-2/UI-3 (council) | major/minor | ACCEPT (`hasConnectData`, sum=sum(byType), tile `--` chỉ khi !tick/replay) | T6 9eaa9d8 |
| F-1 (council) | HIGH | ACCEPT (cap-5 MỌI user) | T3 f8248a2 |
| F-2/F-3/F-4/F-5 (council) | MED-HIGH..MED | ACCEPT (sanitize 3 sink) | T4 f51dc40 |
| F-6 (council) | MED | **REJECT** (defer; sửa lập luận; ghi debt) | debt R-3 (ST-11 gate test: T7) |
| F-8 (council) | LOW | ACCEPT-với-điều-kiện (MVP; v1.1) | T6 + debt v1.1 |
| PF1 (council) | MAJOR | ACCEPT (wall-clock + skip-first) | T2 c470b56 + T5 0895e23 |
| PF2/PF3/PF4 (council) | minor | ACCEPT | T6 / T1 / (note v1.1) |
| F1 (R2) · P1 (R2) · S-1 (R2) | CRITICAL/MAJOR | **wiring thiếu → fix** | T5 0895e23 (+T4 cho byType) |
| F2 (R2) · S-1 (R2) | MAJOR/MED-HIGH | byType không sum → fix | T4 f51dc40 |
| F3 (R2) · P3 (R2) | MAJOR/MINOR | "0.0% xanh" → fix | T5 (override rate) + T6 |
| F4 (R2) | MAJOR | BÁC số học + không persist | T5 (skip-first) + DESIGN §5.3 |
| F5 (R2) · S-2 (R2) | MINOR/MED | 'failed' không terminal → fix | T4 f51dc40 |
| F6 (R2) | MINOR | stopReason 'E2:' → fix | T5 0895e23 |
| F7 (R2) | NIT | fix | T2 c470b56 |
| S-3 (R2) | MED-HIGH | lastError sanitize mọi điểm gán | T4 f51dc40 |
| S-4 (R2) | LOW-MED | errorCounters bound 20 + OTHER | T4 f51dc40 |
| P2 (R2) | MINOR | payload rác byType → fix | T4 f51dc40 |
| F-T7-1 (panel 4) | HIGH/BLOCKER | IN-SCOPE-fix (ramping→cooldown) | **35292c4** |
| F-T7-2 (panel 4) | HIGH | IN-SCOPE-fix (đếm kênh B) | **e2a008c** |
| F-T7-3 (panel 4) | MEDIUM | ACCEPT-document (không đổi code) | note PRD §4 → v1.1 |
| X-1 (panel 4) | minor | fix (rate ở cooldown) | **35292c4** |
| X-2 (panel 4) | minor | fix (empty-state guard) | LiveDashboardPage.tsx:191-195 (luồng Phase 4b) |
| X-3/X-4 (panel 4) | — | PASS (verified) | không sửa |
| X-5 (panel 4) | nit | fix (banner stopReason) | LiveDashboardPage.tsx:288,345-346 (luồng Phase 4b/T6b) |
| SEC R-1 (panel 4) | LOW | sanitize stopReason | **35292c4** |
| SEC R-2 (panel 4) | LOW | debt v1.1 (blind channel) | chưa đóng — debt |
| SEC R-3 (panel 4) | LOW | F-6 vận hành (move-out + rotate + gitleaks) | chưa đóng — debt |
| SEC R-4 (panel 4) | INFO | fixture giả → allowlist `__tests__/` trong gitleaks | chưa đóng — debt |

## 4. Xác minh build (chạy thật, 2026-08-05)

### 4.1 Git — 10 commit đúng kỳ vọng
`git log --oneline main..HEAD` = đúng 10 commit T1..T7 (7) + 3 fix Phase 4b (14d4171, 35292c4, e2a008c). ✓

### 4.2 Loadtest suite — `npx vitest run --config loadtest/vitest.config.ts`
```
Test Files  1 failed | 28 passed (29)
Tests       1 failed | 411 passed | 46 skipped (458)
Duration    106.98s
```
- **Fail duy nhất = `config.test.ts` (pre-existing, loại trừ)**: `env.maxRegisterRamp` nhận 2000 (env `LOADTEST_MAX_REGISTER_RAMP=2000` — `loadtest/.env:34`) vs default 100 — lỗi phụ thuộc env máy, KHÔNG phải regression branch (không liên quan diff).
- T7 integration e2e (5 case) **đều PASS**: (a) mini AC-5 · (b) AC-1+F4 (5% broken → finished, ~20.8%) · (c) AC-2/AC-4 (100% upgrade-403 → E2 ≤ 60s, 8 trường) · ST-12 (message độc → sanitized) · (d) F-T7-2 kênh B accept-then-drop → E2 stop, `usersFailed == userCount`.
- 46 skipped = DB-dependent tests (cần Postgres/Redis localhost:5439) — pre-existing, ghi debt.

### 4.3 Frontend suite — workspace bug workaround
`npx vitest run --config vitest.config.ts` với workaround đã biết (tạm rename `vitest.workspace.ts` → chạy config đơn → khôi phục):
```
Test Files  16 passed (16)      Tests  151 passed (151)      Duration 5.87s
```
Không workspace lỗi "failed to find the current suite" (vitest 2.1.9 pre-existing). ✓

### 4.4 Typecheck
- `npx tsc --noEmit -p loadtest/tsconfig.json` → **PASS**
- `npx tsc --noEmit` (frontend) → **exit 0** ✓

### 4.5 Đối chiếu AC-1..AC-7 (bảng evidence `panel-phase4-correctness.md` §C + hiện trạng cuối)

| AC | Bằng chứng (test thật chạy trong §4.2) | Trạng thái |
|---|---|---|
| **AC-1** — run finished, 5% broken, rate < 30% | e2e (b): E2 không trigger, rate ~20.8% < 30%, 5 user failed, **run FINISHED** (stopReason 'duration hết' qua ramping→cooldown) + unit F4 restart-loop (20.8% invariant) | **ĐẠT** — trước panel: KHÔNG ĐẠT (kẹt ramping, stop tay); đóng bởi **35292c4** (F-T7-1) |
| **AC-2** — 100% broken → E2 ≤ 60s, reason 'E2:' | e2e (c) (kênh 403-upgrade) + e2e (d) (kênh B — reject THẬT của gateway): E2 stop ≤ 60s, stopReason "E2:", usersFailed == userCount | **ĐẠT** — trước panel: "ĐẠT trên kênh mô phỏng, CHƯA ĐÚNG kênh thật"; đóng bởi **e2a008c** (F-T7-2) |
| **AC-3** — window < 50 attempts không evaluate | unit coordinator-state: 49→0; 50+17/50→34 | **ĐẠT** (từ T2/T5) |
| **AC-4** — log 8 trường | regex test + e2e (c) khớp `E2_LOG_RE` (phase/elapsedSec/windowSec/windowAttempts/windowFails/byType/usersFailedCum/workers; sum byType == windowFails) | **ĐẠT** |
| **AC-5** — 10k fresh, rate < 5% | Chỉ mini-run 100 users (a); **chưa có run 10k thật nào**; report.ts chưa có connect metrics | **CHƯA ĐỦ BẰNG CHỨNG** — manual gate, ghi debt |
| **AC-6** — dashboard hiển thị | LiveDashboardPage.test.tsx 6 case (tile/variant/breakdown/danger/replay/empty) + user-phases.test.ts (donut failed + clamp) | **ĐẠT** (test-level; không screenshot — chấp nhận) |
| **AC-7** — E1/E3 nguyên vẹn, E2 auto-stop thật, failed không tốn CPU | E1 boundary regression ✓ · E3 restart ✓ · BE-4 reorder ✓ · M7 scheduler skip failed ✓ · E2 thật trên kênh B (e2e (d)) | **ĐẠT** — trước panel: "MỘT PHẦN" (E2 mù kênh reject thật); đóng bởi **e2a008c** |

## 5. HARD-GATE G1-G10 (template `~/.claude/ASSURANCE.md`)

| # | Gate | Kết quả | Bằng chứng |
|---|---|---|---|
| **G1** | Tests | **PASS** (điều kiện) | Loadtest 411 pass / 1 fail pre-existing env (config.test.ts — loại trừ, §4.2) / 46 skip DB-dependent; frontend 151 pass. Ghi chú: "0 skip" của template chưa đạt tuyệt đối (46 skip cần DB — pre-existing); coverage % chưa đo → debt |
| **G2** | Mutation | **PENDING** | mutate-test đang chạy song song (`.stryker-tmp/` active + `stryker.config.e2.mjs` + `loadtest/vitest.mutation.e2.config.ts` tồn tại). Kết quả sẽ được cập nhật khi hoàn tất |
| **G3** | Contract | **N/A** | Không có consumer contract riêng cho tool nội bộ (loadtest tự host, không API public/consumer bên ngoài). Nội bộ có `contract.test.ts` + `types-contract.test.ts` (PASS trong suite §4.2) — contract types nội bộ, không consumer-driven |
| **G4** | Type/Lint/Build | **PASS** | `tsc --noEmit` loadtest + frontend exit 0 (§4.4); vitest xanh; 0 warning mới |
| **G5** | SAST + secret-scan | **PASS-gián tiếp / PARTIAL** | gitleaks **chưa cài trên máy** (`gitleaks: command not found`) → `npm run secret:scan` không chạy được (gate cơ chế chưa active — đã biết, docs prod-refactor). Bù: **ST-11 test PASS** trong suite (git ls-files không chứa users_accounts.json/accounts-*/auth-secret/.env thật) + `.gitleaks.toml` tồn tại + R2 security verified diff 2966 dòng không secret thật + 0 file auth/config/.env mới trong diff (§ `git diff main...HEAD --name-only`) |
| **G6** | Code Reviewer | **PASS** (điều kiện) | Panel Phase 4 correctness + realtime + security: verdict cuối FAIL (chờ fix F-T7-1/2) → **2 fix 35292c4 + e2a008c đã đóng đủ blocker**, kèm test chứng minh (e2e (b) finished, e2e (d) kênh B); SEC PASS 3 đk (R-1 đã đóng). Re-verify cuối thuộc G7 (Reality Checker) |
| **G7** | Reality Checker | **PENDING** | Chưa chạy — verdict sẽ được điền vào mục Kết luận (trống) |
| **G8** | Migration | **N/A** | Không có migration trong branch (`git diff main...HEAD` không có file migration; loadtest DB impact T1 = xác minh không schema change — DESIGN §8) |
| **G9*** | Tiền | **N/A** | Không đụng payment |
| **G10*** | Auth/PII | **N/A** (kèm note) | Không đụng auth/PII — `git diff main...HEAD --name-only`: **0 thay đổi** ở `loadtest/auth.ts`/`guards.ts`/`api-server.ts`/`http-server.ts`; route dashboard dùng có sẵn, không endpoint mới; ST-9 auth regression 12 test PASS trong suite. **Note: loadtest auth không đổi** |

## 6. Việc còn nợ (debt)

| # | Debt | Trạng thái | Chủ |
|---|---|---|---|
| R-3 | F-6 vận hành: move-out `loadtest/data/users_accounts.json` + `accounts-*.json` + `auth-secret.json` khỏi cây repo + rotate + **cài gitleaks** (gate test ST-11 đã sẵn; cần chạy `npm run secret:scan` sau khi cài) | CHƯA ĐÓNG — bắt buộc TRONG CÙNG release window | vận hành |
| F-8 v1.1 | `connectWindowAttempts` field + tile variant 'default' khi < 50 attempts | v1.1 | dev |
| F-T7-3 v1.1 | Hysteresis 2 tick liên tiếp cho E2 | v1.1 | dev |
| R-2 v1.1 | Blind channel accept-then-drop (đếm churn reconnect vào window) — pre-existing semantics | v1.1 | dev |
| vitest workspace | Bug máy "failed to find the current suite" (vitest 2.1.9) — workaround rename `vitest.workspace.ts`; chưa chạy được workspace chung 1 lệnh | môi trường | infra |
| 46 skipped tests | DB-dependent (Postgres/Redis) — chạy khi có infra test | môi trường | infra |
| AC-5 | Chưa chạy run 10k thật (3 kịch bản AC-1/AC-2/AC-5 trên env test) + report.ts chưa có connect metrics | **MANUAL GATE** — chặn xác nhận SHIPPABLE cuối | người/vận hành |
| G1 coverage | Coverage % chưa đo (template ngưỡng ≥ 80%) | bổ sung | QA |
| R-4 | gitleaks allowlist `__tests__/` (fixture giả `secret=`/`Bearer eyJ` gây false-positive khi cài gitleaks) | khi cài gitleaks | dev |

## 7. Ước lượng token đã tiêu (thô)

~**30 agent rounds** đã chạy: spec/PM (PRD/PLAN/UI-SPEC) ≈ 3 · design council (3 proposal + 3 critique + 1 adjudicator DESIGN) = 7 · implement đợt 1 (T1/T2/T3/T6) ≈ 4 · R2 critics (3 lens) = 3 · implement đợt 2 (T4/T5/T7/T6b) ≈ 4 · panel Phase 4 (3 lens) = 3 · fix Phase 4b ≈ 3 · mutate-test (chạy song song) = 1 · synthesize (file này) = 1 · Reality Checker (sắp chạy) = 1.
Ước lượng thô ~30 × 50–80k token/round ≈ **1.5–2.5M token** (chưa gồm tool output/CI).

## 8. Kết luận

**SHIPPABLE (với điều kiện NGƯỜI)** — Reality Checker vòng 2 (2026-08-06, chi tiết: `docs/review-rounds/reality-checker-verdict.md`):
- Toàn bộ HARD-GATE kỹ thuật đã đóng: G1 PASS-đk (455 pass, fail duy nhất = env máy, đã chứng minh), G2 PASS (0 mutant nguy hiểm critical), G3 N/A, G4 PASS (lint 0/0 sau 188f8e8), G5 PASS-đk (credential ngoài repo, stryker-tmp ignored + đã xóa, ST-11 2/2), G6 PASS, G8/G9/G10 N/A/PASS.
- **Chặn chạy tool production (cổng NGƯỜI, không phải lỗi code — merge được)**: (1) rotate credential pool; (2) AC-5 run 10k thật qua canary Bậc 0→3b (docs/CANARY-loadtest-e2-connect-fail.md).
- **Nên làm (không chặn)**: cài gitleaks + allowlist fixture test, duyệt merge vào main.
- Branch: `fix/loadtest-e2-connect-fail`, 15 commit, chưa push. Kèm trên branch: community scoping (309f1d1) + pool-from-json (fa4da02) — đã test, chờ merge chung.
