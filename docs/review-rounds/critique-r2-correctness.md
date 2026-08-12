# Critique R2 — Correctness (lens phản biện) — fix E2 loadtest connect-fail

**Reviewer**: Code Reviewer (correctness) — round R2 autobuild
**Branch**: `fix/loadtest-e2-connect-fail` — 4 commit: T1 4e05426 · T2 c470b56 · T3 f8248a2 · T6 9eaa9d8
**Thái độ mặc định**: HOÀI NGHI — mọi claim đã verify bằng code thật + node_modules + test chạy thật.
**Kết quả**: 7 finding sống (1 critical · 3 major · 2 minor · 1 nit). Finding số 1 là CHẶN — branch này chưa fix được bug gốc.

---

## Findings SỐNG

### F1 · CRITICAL — T5 wiring hoàn toàn THIẾU: E2 vẫn đo cumulative, window wall-clock là dead code, 5/7 AC không đạt

**file:dòng**: `loadtest/coordinator.ts:534-546` (khối E2 vẫn nguyên bản cũ — không nằm trong diff vì T5 không được làm); `loadtest/coordinator-state.ts:77-162` (toàn bộ T2 pure functions — ZERO caller ngoài test, đã grep toàn repo)

**Vấn đề**:
- `coordinator.ts:539` vẫn là `const connectFailRate = attempts >= 10 ? (fails / attempts) * 100 : 0;` với `attempts/fails` cộng dồn **cumulative toàn run** từ tick mới nhất mỗi worker (dòng 534-538). `decideAutoStop` được gọi với `connectTotal = attempts` cumulative (dòng 545).
- `rollWindow / sumWindow / windowSpanSecs / connectFailRateFromWindow / diffConnectWindowEntry` không có bất kỳ caller nào ngoài `coordinator-state.ts` và test (grep xác nhận).
- `agg.tick.rates.connectFailRate` không bao giờ bị override — aggregateTicks hardcode 0 (`coordinator-state.ts:298`), coordinator không set lại → **mọi tick LIVE có connectFailRate = 0 vĩnh viễn**.

**Vì sao phá vỡ** (map AC):
- **M1 (window 60s) KHÔNG đạt** → root cause #3 PRD (outage nhất thời đầu ramp "kẹt tỉ lệ cao mãi") vẫn nguyên: gateway hiccup lúc steady → 10k user đang connected bị rớt → mỗi user reconnect thất bại 1-5 lần → 10k fails/20k attempts = 50% > 30% → **E2 auto-stop đúng class false-positive mà PRD sinh ra để sửa**. Với cumulative, fails không bao giờ trôi khỏi mẫu số khi không có attempt mới (steady phase).
- **AC-1** ("run phải finished" với 5% user hỏng): chỉ đúng khi 0 restart worker — xem F5 (restart loop tái sinh fails) → 33% > 30%.
- **AC-2** ("≤ 60s kể từ khi window đủ mẫu" + "stopReason bắt đầu 'E2:'"): không đo được window; `finishRun('auto', decision.reason...)` (coordinator.ts:549) — reason bắt đầu `auto-stop:` — vỡ literal AC-2.
- **AC-3** (window < 50 attempts không evaluate): chỉ may mắn đạt qua ngưỡng cumulative 50, không phải semantics window.
- **AC-4** (log 8 trường): coordinator.ts:548 vẫn `E2: ${decision.reason}` — không có phase/elapsedSec/windowSec/windowAttempts/windowFails/byType/usersFailedCum/workers.
- **BE-4** (reorder): phase-advance (coordinator.ts:500-514) vẫn chạy TRƯỚC khối E2 (516-562) — duration hết đúng tick + rate 100% → phase 'cooldown' → E2 bị skip → run `finished` thay vì auto-stop.
- **AC-6** (dashboard): hệ quả F3 — rate luôn 0.0%.

**Fix đề xuất**: implement T5 đúng DESIGN §7.1: diff per-worker + skip-first-tick sau restart (`prevConnectCumulative`), clamp delta âm, `rollWindow`/`lastWindow`, override `agg.tick.rates.connectFailRate` TRƯỚC `pushTick`, di chuyển khối auto-stop LÊN TRƯỚC phase-advance, log 8 trường qua `formatE2Log`, `finishRun('auto', \`E2: ${decision.reason}\`, false)`, `handleWorkerDied` delete prev + `resetRunState` clear. Kèm test T5-1..T5-10 trong DESIGN §9. **Không có T5, branch này chỉ là contract + dead code.**

---

### F2 · MAJOR — `connectFailsByType` không bao giờ được tổng hợp vào WorkerTick → breakdown UI luôn "fails 0"

**file:dòng**: `loadtest/socket-farm.ts:168` (tăng per-user `runtimeStats.connectFailsByType.other++`) vs `socket-farm.ts:744-748` (emitTick chỉ sum `connectAttempts`/`connectFails`, KHÔNG sum byType) vs `socket-farm.ts:468` (init `connectFailsByType: {...EMPTY_CONNECT_FAILS}` — không nơi nào ghi sau đó)

**Vấn đề**: mỗi `connect_error` tăng `other` trong runtimeStats của VirtualUser nhưng `WorkerRuntime.counters.connectFailsByType` giữ zeros vĩnh viễn. Comment dòng 468 tự thừa nhận: "T4 sum vào emitTick + classify" — nghĩa là aggregation bị hoãn sang task không có trong branch này.

**Vì sao phá vỡ**:
- `LoadTestTick.connectFailsByType` luôn `{0,0,0,0}` → UI-SPEC §2 invariant "live run sum(byType) == connectFails" bị vi phạm ngay trên live: card "CONNECT FAIL BREAKDOWN" (LiveDashboardPage.tsx:190 — `totalFails = sum(byType)`) hiển thị **"attempts 12.4k · fails 0"** trong khi `connectFails` (tick counters) > 0 — dữ liệu mâu thuẫn, đúng thứ UI-2 sinh ra để chống.
- Test T3-4 (`emitTick: usersFailed`) không assert byType — khoảng trống test che giấu đúng chỗ thiếu.

**Fix đề xuất**: trong emitTick sum per-user byType vào counters (vòng lặp 744-748 thêm 4 key), hoặc giữ counters byType như aggregate cấp worker; thêm test `emitTick` assert `connectFailsByType.other == 5` sau 5 fail.

---

### F3 · MAJOR — Dashboard live LUÔN hiển thị "0.0%" xanh — F-8 "khỏe giả" sống lại

**file:dòng**: `src/pages/loadtest/LiveDashboardPage.tsx:301-302` (`connectFailValue = (lastTick.rates.connectFailRate ?? 0).toFixed(1)`) + `src/components/loadtest/connect-fail.ts:35-40` (`connectFailVariant` → `success` khi rate < 5)

**Vấn đề**: hệ quả trực tiếp F1 — `rates.connectFailRate` của mọi tick live = 0 (không nơi nào set thật). Tile "Connect fail" hiện **"0.0%" variant success** suốt run — kể cả khi run thực tế đang ở 41% fail và E2 sắp/vừa stop. Danger strip (rate >= 30) không bao giờ xuất hiện trên live.

**Vì sao phá vỡ**: AC-6 ("không cần đoán") bị đảo ngược — dashboard khiến operator tin hệ thống khỏe trong khi nó đang chết; đúng kịch bản F-8 (đã ACCEPT giảm thiểu) nhưng giờ áp cho TOÀN BỘ live run, không chỉ đầu ramp. Hint text "Tỉ lệ fail/attempt trong cửa sổ 60s" là lời hứa không có code.

**Fix đề xuất**: phụ thuộc F1 (phải set rate thật). Nếu chấp nhận branch thiếu T5 tạm thời → tile phải hiển thị theo cumulative thật (`fails/attempts` hiện có trong tick) + nhãn "lũy kế", thay vì 0.0% giả; hoặc gate tile bằng `hasConnectData` và hiển thị "--" cho tới khi T5 xong. Không được để "0.0% xanh" khi có fail thật.

---

### F4 · MAJOR — Cap 5 là per-process: E3-restart tái sinh 5 fail/user — AC-1 vỡ dưới restart loop

**file:dòng**: `loadtest/socket-farm.ts:170-182` (cutover `phase='failed'`) + worker-farm restart (ngoài diff, E3 2s backoff)

**Vấn đề**: `consecutiveConnectFails` sống trong VirtualUser — mỗi process worker. Khi worker chết → E3 restart → **user được spawn lại từ pool** → user token hỏng vĩnh viễn được fail lại 5 lần nữa. Cap "tối đa 5 fail/user" chỉ đúng trong 1 generation process.

**Vì sao phá vỡ**: DESIGN §5.2 tính AC-1 = 2500 fails/12500 attempts = 20% với giả định 1 chu kỳ. Với cumulative E2 (F1) + restart loop (chính là root cause #4 PRD): 2 chu kỳ → 5000 fails/(10000+5000) attempts = **33% > 30% → E2 stop dù chỉ 5% user hỏng**. Ngay cả với T5 window: 2+ restart cycle trong 60s → 5000 fails/60s window vs ~15000 attempts → 33%. AC-1 "run phải finished" không đảm bảo.

**Fix đề xuất**: (a) lưu fail-count per-user xuyên restart (out of scope MVP — ghi debt v1.1); (b) tối thiểu: test T7 scenario mock-gateway (b) phải chạy kèm 1-2 vòng kill/restart worker để lộ hành vi; (c) tài liệu hóa biên tham số mới: "cap 5/user/PROCESS" trong DESIGN §5.2 (claim hiện tại "tối đa 5 fail/user" là sai tuyệt đối).

---

### F5 · MINOR — `'connect'` handler thiếu guard `phase === 'failed'` — cửa resurrect

**file:dòng**: `loadtest/socket-farm.ts:141-151`

**Vấn đề**: handler `s.on('connect')` không có `if (this.phase === 'failed') return;` — đối xứng với guard trong `connect_error` (dòng 162). Nếu socket.io bắn `connect` sau cutover (race attempt in-flight hoàn tất thành công sau khi đã đánh dấu failed) → `this.phase = 'connected'/'in_room'`, `consecutiveConnectFails = 0` → **user hồi sinh, cap 5 bị xóa sạch**, user tiếp tục tham gia action loop.

**Đã verify mức độ reachable**: socket.io-client 4.8.3 — `socket.disconnect()` gọi `destroy()` → clear pending reconnect timer (subs cleanup) + `manager._destroy` → `_close()` → `skipReconnect = true` → onclose không schedule lại → trong luồng bình thường 'connect' sau failed gần như không tới được. Nhưng đây là bất biến ngầm của thư viện, không phải contract; DESIGN §5.1 mô hình "sau cutover không còn sự kiện" nên được enforce cả 2 phía.

**Fix đề xuất**: thêm guard đầu `'connect'` handler + test: fail 5 → fake `connect` event → phase vẫn 'failed', không đếm attempt.

---

### F6 · MINOR — `stopReason` không bắt đầu `E2:` + reason `toFixed(0)` làm log vô nghĩa

**file:dòng**: `loadtest/coordinator.ts:549` (`finishRun('auto', decision.reason ...)` — reason = `auto-stop: connect fail 41% > 30% (E2)`); `loadtest/coordinator-state.ts:63` (`input.connectFailRate.toFixed(0)`)

**Vấn đề**: (1) AC-2 yêu cầu `stopReason` bắt đầu `E2:` — DB/UI/report chỉ nhận `auto-stop: ...` (DESIGN §6 đã chỉ đích danh dòng này cần sửa — T5 không làm). (2) `toFixed(0)` làm tròn: 30.1% → reason "connect fail 30% > 30%" — dòng log tự mâu thuẫn, khó grep phân biệt 30.0 (không stop) vs 30.1 (stop).

**Fix đề xuất**: prefix `E2: ` ở finishRun (T5); reason dùng 1 chữ số thập phân `toFixed(1)`.

---

### F7 · NIT — rollWindow lưu reference `byType` của caller + evict giữ bucket tròn 60.000ms tuổi

**file:dòng**: `loadtest/coordinator-state.ts:95-108` (`rollWindow` — `{ ts, attempts, fails, byType }` giữ nguyên object caller); dòng 101 (`next[0].ts < cutoff` — bucket ts == now-60s giữ lại → window có thể chứa sự kiện từ now-60.000ms-ε)

**Vấn đề**: (1) claim "PURE" không trọn vẹn — không mutate nhưng alias reference: caller đổi byType sau khi push → bucket hỏng (hiện không có caller nào nên không bug thực tế; nhưng API public trap). (2) biên evict dùng `<` thay `<=` — lệch 1 tick/biên, không đáng kể.

**Fix đề xuất**: shallow-copy byType khi push (`{ ...byType }`) + test immutability ở mức deep; đổi thành `ts <= cutoff` nếu muốn window đúng 60s kín.

---

## Đã xác minh ĐÚNG (claims tôi check và thấy ổn)

1. **T2 window pure functions** — đúng DESIGN:
   - `rollWindow` evict theo wall-clock age TRƯỚC safety cap (test: 65 bucket 1s → 61 bucket, oldest = now-60s; 150 push → ≤ 120). Câu hỏi "bucket quá hạn bị giữ đến 120?" — KHÔNG: evict age chạy trước cap, không giữ bucket quá hạn. Không mutate input (test immutability pass).
   - `windowSpanSecs` clamp [0,120] đúng DESIGN §4.2; rỗng → 0.
   - `connectFailRateFromWindow` trả 0 khi attempts < 50 — AC-3 đúng ở tầng hàm (49 → 0; 50+17/50 → 34 — test pass).
   - `diffConnectWindowEntry` clamp âm per-key đúng (S2/ST-3), null khi prev undefined (skip-first-tick PF1).
2. **decideAutoStop** — đúng biên: `> 30` strict — 30.0% KHÔNG stop (kể cả floating point: 15/50*100 ≈ 29.999999999999996 < 30), 30.1% stop (test pass, đã chạy thật). E1 giữ nguyên (`registerFailRate > 50 && registeredTotal >= 10`). `E2_MIN_ATTEMPTS = 50` đúng M2.
3. **T3 socket.io v4.8.3 API — verify node_modules thật**:
   - `socket.disconnect()` → `destroy()` → clear reconnect timer + `io._destroy` → `_close()` → `skipReconnect = true` → không reconnect lại (manager.js:321-333, 411-418; socket.js:675-694).
   - `socket.io.reconnection(false)` — API đúng (manager.d.ts:125-127 `reconnection(v?: boolean): this | boolean`) — setter có thật, tắt reconnection tương lai.
   - Guard `phase === 'failed'` ở connect_error chặn đếm thêm (test T3-1 assert attempts/fails dừng ở 5 — chạy thật pass).
   - `disconnect()` sau failed không đổi phase (test T3-6 pass); scheduler skip failed (test T3-5 pass — failed user không REST/enqueue, healthy user vẫn chạy); emitTick `usersFailed` đếm đúng 1/user (test T3-4 pass); streak reset đúng chỗ ở 'connect' (test T3-3 pass — 3 fail → connect → 5 fail = không cutover trước fail thứ 5).
   - Counters per-user: mỗi connect_error = attempts+1, fails+1, byType.other+1; mỗi connect = attempts+1 — đúng model.
4. **T1 contract** — 4 compile-site đủ field: aggregateTicks (coordinator-state.ts:215-227), provisioning tick (coordinator.ts:435-445), WorkerRuntime init (socket-farm.ts:465-469), toMetricTick (api-mappers.ts:72-83). `tsc --noEmit` backend + frontend đều exit 0.
5. **hasConnectData** — đúng DESIGN §2.1: live true (aggregateTicks:305 + provisioning:445), replay false (api-mappers.ts:83). Không nơi nào sót (grep toàn repo).
6. **UI T6** (đã đọc + đối chiếu UI-SPEC):
   - Donut invariant: `slicesFromTick` sum = usersCreated với dữ liệu nhất quán (test 4 case pass logic — tôi tự kiểm chứng số học: conn+failed ≤ created và in_room/queued ≤ connected thì tổng = created).
   - NaN guard: mọi nguồn tick đều có `connectFailRate` số (`?? 0` kép ở tile + sparkline); replay không thể NaN vì toMetricTick set 0.
   - Variant ≥30/≥5/<5 + default khi null/replay/attempts=0 — đúng UI-SPEC §3 (test pass).
   - Empty states 4 nhánh đúng thứ tự ưu tiên UI-SPEC §4.4 (không tick → chờ; replay → "lịch sử" KHÔNG "đang chờ"; attempts 0 → chờ user; fails 0 → sạch).
   - Tile `--` đúng D4: chỉ khi !lastTick/replay, không phụ thuộc cumulative attempts → không tái xuất giữa run.
7. **Số học AC** (đối chiếu DESIGN §5.2, đúng):
   - AC-1: 500×5 = 2500 fails / (10000 + 2500) = 20.0% < 30% ✓
   - 6% broken: 600×5 = 3000 / 13000 = 23.08% (SEC-2 hiệu đính) ✓ — không phải 28% như claim cũ.
   - Boundary: 850×5 = 4250 / 14250 = 29.8% sát ngưỡng ✓.
8. **Test hiện trạng**: 90/90 backend test (coordinator-state 44, socket-farm 33, coordinator 11, api-mappers 2) PASS — chạy thật. Frontend test files KHÔNG chạy được trong env này do lỗi vitest 2.1.9 workspace pre-existing ("Vitest failed to find the current suite" — UsersPage.test.tsx cũ chưa đụng cũng fail) — KHÔNG phải lỗi branch; không verify được T6 tests xanh ở đây.
9. **E2 min-attempt interplay hiện tại**: coordinator gate `attempts >= 10` tính rate + decideAutoStop enforce `>= 50` — kết hợp không có lỗi số học (rate chỉ dùng khi đủ 50).

---

## Findings TỰ BÁC nội bộ (đề xuất rồi loại — không đưa vào danh sách sống)

- **"Safety cap 120 giữ bucket quá hạn khi stall dài"** — BÁC: code evict theo age trước, cap sau; bucket quá hạn luôn bị evict đúng tuổi.
- **"Sparkline âm khi worker restart làm counters tụt"** — BÁC: tile mới vẽ RATE (0-100, clamp), không vẽ counters; sparkline counters cũ (actionsTotal...) có thể giảm thật nhưng đã tồn tại trước branch và không phải vector âm.
- **"Replay NaN khi thiếu field"** — BÁC: `?? 0` guard + toMetricTick set 0 tường minh.
- **"rollWindow không PURE (mutate)"** — BÁC phần mutate: test immutability pass; giữ lại nit alias reference (F7).
- **"BE-1 ramp thấp làm E2 không bao giờ fire"** — BÁC: đã chốt DESIGN §11.1 giới hạn tham số + test low-ramp là trách nhiệm T7 (chưa có).
- **"Donut undercount khi counters race (usersFailed 500 + connected 700 > created 1000)"** — BÁC: tổ hợp đó bất khả vật lý (failed user không socketConnected — disconnect() set false đồng bộ trước emitTick); clamp đủ cho transient.

---

## Kết luận

**7 finding sống: 1 critical · 3 major · 2 minor · 1 nit.**

Ba nghiêm trọng nhất:
1. **F1 (critical)** — T5 wiring thiếu hoàn toàn: E2 vẫn cumulative, window wall-clock là dead code, dashboard rate = 0 vĩnh viễn; AC-1/AC-2/AC-3/AC-4/AC-6 + BE-4 không đạt. Đây là fix CHÍNH của PRD (M1) — branch này chưa fix bug gốc, chỉ dựng contract + pure functions.
2. **F2 (major)** — `connectFailsByType` không được sum vào tick → breakdown luôn "fails 0" mâu thuẫn `connectFails`, vi phạm UI-SPEC §2 invariant.
3. **F3 (major)** — live dashboard "0.0% xanh" giả khỏe (F-8 sống lại toàn run) + F4: cap 5 per-process cho phép E3-restart tái sinh fails → AC-1 không đảm bảo dưới restart loop.

**Khuyến nghị cho council**: branch này KHÔNG đủ điều kiện ship như "fix E2" — cần T5 (wiring) + T4 (classify + sum byType + sanitizer) + test T7 integration trước khi bất kỳ AC nào được tuyên bố đạt. T1/T2/T3/T6 phần pure/contract/UI là nền tốt, giữ nguyên.
