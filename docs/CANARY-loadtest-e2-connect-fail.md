# CANARY — Release fix E2 connect-fail cho LOADTEST TOOL (Phase 5)

**Nguồn**: PRD-loadtest-e2-connect-fail.md (AC-1..AC-7) · DESIGN-loadtest-e2-connect-fail.md (T1-T7) · ASSURANCE.md (RELEASE-SAFETY).
**Vai trò**: SRE — kế hoạch CANARY RELEASE + ROLLBACK. **KHÔNG tự push/deploy** — mọi bậc chạy có người duyệt (mục 5).
**Phạm vi**: LOADTEST TOOL tự host (`npm run loadtest:server` — tsx, port 3401). "Traffic" = các run loadtest; "canary" = chuỗi bậc run xác minh trước khi chạy 10k thật (AC-5).

---

## 0. Bối cảnh canary (đọc trước)

1. **Fix đang trong `main`**: E2 đo trên **sliding window 60s wall-clock** (không cumulative toàn run), threshold ≥ 50 attempts, cap-5 consecutive fail mọi user (bounded), stopReason prefix `E2:`, log E2 đủ 8 trường, dashboard hiển thị "Connect fail %" + breakdown (M6). Bằng chứng unit/integration = `npm run loadtest:test` (T1-T7, gồm `e2e-mock-gateway-e2.test.ts` kịch bản a/b/c/d).
2. **Giới hạn tái lập — quan trọng**:
   - `validateRunRequest` (loadtest/config.ts:294) chặn `targetUsers < 1000` → **mọi run qua API ≥ 1000 users**. Kịch bản 100/60 users chỉ chạy được qua test harness (coordinator trực tiếp / vitest).
   - **Tool production KHÔNG có cấu hình inject token lỗi** (`StartRunRequest` — routes/run.ts:40-46 không có field broken). `brokenTokenRatio` / `acceptThenDrop` chỉ tồn tại trong test infra (`loadtest/__tests__/mock-gateway.ts`) → **Bậc 1, 2 không thể tái lập ngoài test; bằng chứng = e2e test deterministic** (đã calibrate trong `e2e-mock-gateway-e2.test.ts`).
   - **10k seed = production users THẬT** (đã register qua gateway thật). `freshAccounts: false` (mặc định — pool reuse) KHÔNG tạo user mới; `freshAccounts: true` sẽ register 10k user mới vào production user DB — **canary dùng pool reuse trừ khi founder quyết định khác**.
3. **Map ASSURANCE canary 1%→10%→50%→100%** (traffic = users của run): Bậc 0 (10% = 1000) → Bậc 1 (negative-test 5% broken, e2e) → Bậc 2 (negative-test 100% kênh B, e2e) → Bậc 3a (50% = 5000) → Bậc 3b (100% = 10000, AC-5).
4. **Precondition mỗi bậc** (mặc định): `npm run loadtest:typecheck` + `npm run loadtest:test` xanh (0 skip), lint không warning mới; `validateEnv` production PASS (LOADTEST_ALLOWLIST chứa gateway đích, DB URL thật, OTP/AUTH secret ≥ 32 ký tự — config.ts:226-254).

---

## 1. Các bậc canary

### Bậc 0 — Smoke local (xác minh pipeline + dashboard không E2 trong run khỏe mạnh)

| Mục | Giá trị |
|---|---|
| **Mục tiêu** | Verify end-to-end: start → provisioning (pool reuse) → ramping → finished; dashboard hiển thị connect metrics thật (M6/AC-6); KHÔNG E2 trong run 100% token OK. |
| **Cấu hình run** | `targetUsers: 1000` (mức tối thiểu API — config.ts:294) · `durationMin: 0.5` (30s) · `rampRate: 20` · `rampMode: 'rate'` · `freshAccounts: false` (pool reuse) · gateway: URL trong allowlist (mặc định localhost:3000 dev; nếu nhắm prod phải có trong LOADTEST_ALLOWLIST) |
| **Bằng chứng phụ (optional)** | `npx vitest run --config loadtest/vitest.config.ts __tests__/e2e-mock-gateway-e2.test.ts -t "(a)"` — smoke 100 users deterministic (thay cho API nếu không có gateway test sẵn) |
| **PASS** | phase `finished`; `stopReason` KHÔNG chứa `E2`; `rates.connectFailRate = 0` mọi tick; log không có dòng `E2:`; dashboard Màn 2 (`/loadtest/live`) hiển thị KPI "Connect fail %" = 0 + breakdown `timeout/transport/reject/other` đủ 4 loại; `usersFailed = 0`; report file có trong `LOADTEST_REPORTS_DIR`. |
| **FAIL (dừng canary)** | Bất kỳ `E2:` nào trong log · rate window > 0 kéo dài (không phải transient) · run không finished trong 5 phút · dashboard thiếu connect metrics / `hasConnectData` sai · E3 restart bất kỳ. |

### Bậc 1 — 5% broken → KHÔNG E2 (AC-1 + F4, F-T7-1)

| Mục | Giá trị |
|---|---|
| **Mục tiêu** | Xác minh **false-positive đã hết**: 5% token lỗi (≈20.8% rate window, boundary 8.5% — DESIGN §5.2) KHÔNG dừng run; user lỗi cutover phase `failed` sau cap-5; run kết thúc `finished` tự nhiên theo duration (F-T7-1). |
| **Cấu hình** | **Bằng chứng = e2e test (b)** (`e2e-mock-gateway-e2.test.ts`): `brokenTokenRatio: 0.05` (deterministic counter — đúng 5/100 token lỗi), 100 users, ramp 20/s, durationMin 1, mock gateway `rejectInvalidTokens` — chạy qua `npm run loadtest:test`. Rate ~20.8% **bất biến theo quy mô** (DESIGN §5.3) nên 100 users là bằng chứng đủ. |
| **Bổ sung (khuyến nghị)** | Real run 1000 users / 60s / ramp 20/s / pool reuse chống gateway trong allowlist: đo **rate tự nhiên của pool** (token TTL 1h hết hạn) — kỳ vọng < 5% (AC-5 ngưỡng). Đây là cảnh báo sớm nếu pool bị nhiễm token lỗi trước Bậc 3. |
| **PASS** | Test (b): window ≥ 50 attempts, rate ∈ (10%, 30%), E2 KHÔNG trigger, `usersFailed = 5`, `connectFails ≤ 25` (cap 5×5 — F-1), run `finished` stopReason `duration hết` (không chứa `E2`), byType sum == fails. Real run: rate window < 5% toàn run, không `E2:`. |
| **FAIL (dừng canary)** | Test (b) fail bất kỳ assert · rate ≥ 30% khi broken ≤ 5% (false-positive còn sống) · E2 fire · `usersFailed ≠ 5%` (đếm sai) · real run rate tự nhiên ≥ 5% (điều tra pool trước khi lên bậc 3). |

### Bậc 2 — Kênh B accept-then-drop 100% → E2 phải dừng (AC-2 trên kênh reject THẬT)

| Mục | Giá trị |
|---|---|
| **Mục tiêu** | Xác minh E2 **vẫn là auto-stop thật** (AC-7: không đổi cơ chế an toàn) trên kênh reject thật duy nhất của gateway: `client.disconnect()` sau accept (websocket.gateway.ts:150-153,161-164,179-185) — client nhận `connect` rồi `disconnect` terminal, KHÔNG retry (F-T7-2). |
| **Cấu hình** | **Bằng chứng = e2e test (d)**: `acceptThenDrop: true`, 60 users, ramp 8/s (đã calibrate — window đủ 50 attempts khi user cuối drop), durationMin 2. **Không tái lập được ngoài test** — tool không cho inject broken token (mục 0.2); mock mô phỏng đúng hành vi gateway thật. |
| **PASS** | E2 stop ≤ 60s kể từ start; status `error`; `stopReason` khớp `/^E2:/`; `usersFailed == 60`, `connectFails == 60`, `usersConnected == 0` (không "connected giả"); window 100% fail, `byType.reject == fails`; log E2 đủ 8 trường (regex ST-7). |
| **FAIL (dừng canary)** | Không stop trong 60s · stopReason không bắt đầu `E2:` · user kẹt `connecting` vĩnh viễn (đếm sai kênh B) · byType không phải reject · log E2 thiếu trường. |

### Bậc 3a — Run 5k semi-prod (50% scale) — **CỔNG NGƯỜI**

| Mục | Giá trị |
|---|---|
| **Mục tiêu** | Xác minh ở 50% quy mô thật: pacing 200/s + window 60s không transient-spike; pool cũ (production users) connect sạch; dashboard chịu tải. |
| **Cấu hình đề xuất** | `targetUsers: 5000` · `durationMin: 10` (AC-5: ≥ 10 phút) · `rampRate: 200` (default; ≥ 20/s — F-T7-3) · `rampMode: 'rate'` · `freshAccounts: false` · gateway prod (trong LOADTEST_ALLOWLIST) |
| **PASS** | phase `finished`; `stopReason` không chứa `E2`; `connectFailRate` (window 60s) **< 5% toàn run** (AC-5); `usersFailed` tự nhiên ≤ 5%; E3 restart = 0; log periodic 15s ổn định (`connected` đạt ~5000, echo rate ≥ 90%); breakdown reject/timeout không có loại bất thường chiếm đa số. |
| **FAIL (dừng canary)** | E2 fire bất kỳ · rate window ≥ 5% kéo dài > 60s (điều tra: pool nhiễm / gateway) · E3 restart > 0 · connected không đạt ≥ 90% target trong duration · dashboard sai/thiếu dữ liệu. |

### Bậc 3b — Run 10k thật production (AC-5) — **CỔNG NGƯỜI, gate cuối**

| Mục | Giá trị |
|---|---|
| **Mục tiêu** | AC-5 chính thức: run 10k hợp lệ, connect-fail rate window < 5% toàn run, KHÔNG E2 false-positive; nếu có connect fail THẬT → hiện đúng breakdown trên dashboard (không đoán). |
| **Cấu hình đề xuất** | `targetUsers: 10000` · `durationMin: 15` (khuyến nghị 15-30; tối đa 60 — TTL token 1h, config.ts:306-309) · `rampRate: 200` · `rampMode: 'rate'` · `freshAccounts: false` (pool 10k seed; **KHÔNG fresh** trừ khi founder chốt — fresh = 10k user mới trên production) · gateway prod trong allowlist |
| **Cảnh báo pacing (F-T7-3)** | Ramp ≥ 20/s (200/s default giữ nguyên); **broken phân bố NGẪU NHIÊN theo thời gian** (token hết hạn tự nhiên khi pool cũ). Đã verify: ramp quá chậm + broken cluster trong connect order → transient spike > 30% → flaky (e2e test (b) comment). Không chạy ramp < 20/s trong run này. |
| **PASS** | phase `finished`; `connectFailRate` window < 5% toàn run (đọc từ dashboard/report); 0 dòng `E2:` trong log; `usersFailed ≤ 5%` (500/10k); report + DB run `finished`; breakdown chính xác nếu có fail thật (reject = token lỗi tự nhiên, timeout = hạ tầng — phân biệt được). |
| **FAIL (dừng canary + điều tra)** | E2 fire khi broken < 5% (false-positive — bug sống) → dừng, không nới ngưỡng vội (mục 4) · rate window ≥ 30% liên tục (fail thật — E2 dừng run ĐÚNG hành vi, điều tra gateway/pool) · rate ≥ 5% nhưng < 30% kéo dài > 60s · E3 restart loop · dashboard mất data. |

**Quy tắc chung mọi bậc**: chạy xong 1 bậc → founder xác nhận PASS (mục 5) trước khi bước tiếp. Bậc FAIL → dừng ngay (kill-switch), quay lại đầu quy trình (re-run bậc 0 để phân biệt "tool hỏng" vs "môi trường").

---

## 2. Rollback plan + drill

### Rollback trigger (bất kỳ điều kiện nào)
- Bất kỳ bậc nào FAIL tiêu chí PASS của nó.
- **E2 fire sai** (false-positive: run có < 5% broken vẫn dừng).
- Dashboard/log hiển thị metric connect sai (rate 0 giả, `hasConnectData` sai, byType vỡ bất biến sum == fails).
- Gateway prod có dấu hiệu bất thường trong run (ws_connections sụt, error tăng) — dừng run trước.

### Revert (không đụng DB — DESIGN §8: MVP = 0 thay đổi schema)
Tool tự host, chạy TS trực tiếp qua tsx (không build step) → rollback = checkout code + restart:

```bash
# 1) Dừng run đang chạy NGAY (nếu còn): UI kill-switch hoặc API
# 2) Xác định commit an toàn cuối (trước merge fix E2 — kiểm tra git log)
git log --oneline -10 -- loadtest/        # tìm <sha-an-toan>
# 3) Revert code-only (chỉ thư mục loadtest; giữ nguyên mọi config/env khác)
git checkout <sha-an-toan> -- loadtest/
# 4) Restart tool (đúng cách tool đang chạy trên máy — ví dụ process trực tiếp):
kill <pid-loadtest>                        # hoặc pm2 restart <tên> nếu dùng pm2
npm run loadtest:server                    # tsx loadtest/server.ts
# 5) Verify rollback: chạy lại Bậc 0 smoke (xem drill bên dưới)
```

- **Không** migrate DB down (schema không đổi); dữ liệu run cũ giữ nguyên.
- **Cấu hình run cũ giữ nguyên vô điều kiện**: run config không nằm trong code; KHÔNG đổi LOADTEST_* env khi revert (trừ khi nguyên nhân FAIL liên quan env — ghi rõ lý do khi thay đổi).
- Nếu prefer lịch sử rõ: `git revert <sha-fix>` thay cho `git checkout ... -- loadtest/` — kết quả tương đương; chọn 1, không làm cả 2.

### Drill (bắt buộc ≥ 1 lần — ASSURANCE RELEASE-SAFETY "không chỉ nói 'có thể rollback'")
Chạy **1 lần, TRƯỚC Bậc 0** (~10 phút, rẻ vì tool tự host):
1. Làm đúng chuỗi lệnh mục Revert (checkout sha an toàn → restart).
2. Chạy Bậc 0 smoke (1000 users / 30s / ramp 20/s / pool reuse) → xác nhận tool chạy được với code cũ (finished, không lỗi startup).
3. Checkout lại code fix → restart → chạy lại Bậc 0 → xác nhận fix vẫn hoạt động.
4. Bằng chứng drill: log run smoke (startup + finished) + `git log --oneline -3`.

---

## 3. Observability

| Metric | Nơi xem | Cách đọc |
|---|---|---|
| **connectFailRate (window 60s)** | Dashboard Màn 2 (`/loadtest/live`) KPI "Connect fail %" + report | Tiêu chí bậc: 0 / < 5% (AC-5) / < 30% (E2) |
| **Breakdown byType** (timeout/transport/reject/other) | Dashboard Màn 2 (AC-6) + log E2 `byType=` | sum 4 loại == windowFails (bất biến SEC-1); reject = token lỗi, timeout = hạ tầng |
| **usersFailed** (cumulative, suffix Cum) | Dashboard + log E2 `usersFailedCum=` | ≤ 5% pool (500/10k) là biên giới hạn hợp lệ (AC-1 premise) |
| **stopReason histogram** | Dashboard run header + DB `runs.status/stop_reason` + report | `finished` (duration hết) vs `error` (E1/E2/E3) vs `stopped` (manual) |
| **E2 trigger count** | Grep log `E2: auto-stop: connect fail` + DB runs status='error' | 0 = PASS; > 0 → kiểm tra log 8 trường |
| **E2 log 8 trường** | Ring buffer logger / log file (LOGTEST_LOG_FILE nếu bật) — regex `phase=… windowAttempts=… windowFails=… byType=… usersFailedCum=… workersAlive=…` | Diagnostic khi E2 fire (AC-4) |
| **Tool metrics snapshot 5s** | Log `tool metrics snapshot` (coordinator.rssMb, worker.alive, apiErrors, dbWriteFail, workerRestarts, runFinished) | restart loop / DB write fail |
| **Gateway metrics scrape 5s** | Dashboard server metrics: ws_connections, ws_messages_emitted_total (scrape /metrics — coordinator.ts:651-673) | Sụt ws_connections giữa run = sự cố hạ tầng |
| **Redis queue count** | Dashboard (poll 1s) | Tắc queue khi quá tải |
| **Report files** | `LOADTEST_REPORTS_DIR/<runId>/` sau mỗi run | Kiểm tra cuối bậc |

**Alert**: hiện KHÔNG có alerting tự động cho tool (self-hosted, dashboard + log). Trong canary, "alert" = người duyệt theo dõi dashboard/live trong suốt mỗi bậc + grep `E2:` sau mỗi run. Nếu muốn tự động hóa (ngoài phạm vi fix này): cron/CI grep log `E2:` hoặc scrape tool metric — ghi debt, không chặn canary.

---

## 4. Kill-switch

**Hiện trạng**: ngưỡng E2 là **hằng cứng** (`loadtest/coordinator-state.ts:91-97`): `E2_WINDOW_MS = 60_000`, `E2_MIN_ATTEMPTS = 50`, `E2_FAIL_RATE_PCT = 30`, `E2_MAX_BUCKETS = 120`. DESIGN §4.3 + PRD §6.6 cố ý KHÔNG cấu hình hóa (ngưỡng = cơ chế an toàn; thêm config = thêm mặt tấn công + rủi ro tắt nhầm). **Không sửa code trong phase này.**

**Đề xuất (chỉ ghi trong plan — dành cho v1.1 hoặc khi có nhu cầu thật)**:
- Thêm env override **optional** `LOADTEST_E2_FAIL_RATE_PCT` / `LOADTEST_E2_MIN_ATTEMPTS` / `LOADTEST_E2_WINDOW_MS`, default = hằng hiện tại (hành vi không đổi khi không set).
- Validate range khi đọc env (rate 1-100, attempts ≥ 10, window 10-600s); log giá trị override vào log start run (không lặng lẽ nới ngưỡng).
- Mục đích: nới ngưỡng **tạm thời** khi pool bị nhiễm > 5% token lỗi (chạy được run mà không cần build lại), hoặc thắt chặt khi cần. E2 KHÔNG bao giờ bị tắt hoàn toàn qua env.

**Kill-switch vận hành HIỆN CÓ (dùng được ngay, không cần code)**:
- Nút Stop (manual) + **Stop force / kill-switch** trong UI/API — `coordinator.stop(true)` → `farm.killAll()` + finishRun `kill-switch: dừng ngay mọi worker` (coordinator.ts:361-389).
- `start()` bị chặn khi run đang chạy (coordinator.ts:200) — không chồng run.
- **Quy tắc xử lý E2 fire sai**: dừng canary + điều tra root cause (log 8 trường + breakdown) TRƯỚC; nới ngưỡng chỉ khi có bằng chứng pool nhiễm > 5% token lỗi VÀ founder duyệt — không nới ngưỡng để "che" bug.

---

## 5. Trách nhiệm & cổng người (KHÔNG auto-merge / auto-promote)

| Bậc | Người chạy | Cổng duyệt | Điều kiện bước tiếp |
|---|---|---|---|
| 0 — Smoke | Implementer (agent) | Founder xác nhận PASS (dashboard/log/run id) | Bậc 1 |
| 1 — 5% broken (e2e) | Implementer (agent) | Founder xác nhận kết quả test (b) + real-run 1000 | Bậc 2 |
| 2 — Kênh B (e2e) | Implementer (agent) | Founder xác nhận kết quả test (d) | Bậc 3a |
| 3a — 5k thật | Implementer (agent) | **CỔNG NGƯỜI TRƯỚC khi chạy**: founder chốt cấu hình + xác nhận kết quả bậc 0-2 (gồm bằng chứng HARD-GATE G6 Code Reviewer / G7 Reality Checker của phase trước); founder theo dõi live trong run | Bậc 3b |
| 3b — 10k thật (AC-5) | Implementer (agent) | **CỔNG NGƯỜI bắt buộc**: founder duyệt kết quả 3a + chốt cấu hình trước khi chạy; founder theo dõi live; sau run founder xác nhận PASS toàn bộ AC-1..AC-7 + report | Kết thúc — KHÔNG auto-promote thêm gì |

- Người duyệt mọi bậc: **founder (Dev)** — người duy nhất có quyền chạy run nhắm production gateway và quyết định freshAccounts (tạo user production mới).
- Vi phạm quy trình = dừng canary, quay lại cổng duyệt (ASSURANCE: escalate người sau tối đa 3 lần thất bại; KHÔNG tự vòng sửa-tự sai).

---

## 6. Tóm tắt 1 dòng

Canary 5 bậc (smoke 1000 → e2e 5% broken → e2e kênh B 100% → 5k thật → 10k thật AC-5, cổng người trước 2 bậc thật) + rollback 1 dòng: **`git checkout <sha-an-toan> -- loadtest/` + restart `npm run loadtest:server` (không đụng DB) + drill = chạy lại Bậc 0**, trigger rollback = bất kỳ bậc nào FAIL hoặc E2 fire sai.
