# Critique Hiệu năng R2 — Fix E2 connect-fail (phản biện diff `main...HEAD`)

**Lens**: Performance Benchmarker (mặc định HOÀI NGHI — cố bác diff từ góc hiệu năng)
**Diff**: T1 4e05426 · T2 c470b56 · T3 f8248a2 · T6 9eaa9d8 (branch `fix/loadtest-e2-connect-fail`)
**Đọc**: DESIGN-loadtest-e2-connect-fail.md · critique-perf.md (R1, F1-F7) · toàn bộ diff 20 files + file hiện tại
**Điều kiện đo**: 2500 user/socket/worker · hàng chục worker · tick 1s · UI poll 1s · dashboard chạy cùng máy load gen

---

## Phán quyết tổng (TL;DR)

**Chi phí: PASS** — mọi đường code mới đo được < 0.1ms/lần chạy, IPC +89B/tick/worker (+1.1-1.7% trên payload thật 5-8KB — đúng claim +1-2%), UI thêm ~15 DOM node re-render 1Hz. Không có vấn đề tốc độ mới.

**Nhưng CÓ 1 finding MAJOR chặn release, mang tính hiệu năng-correctness**: **cơ chế E2 window (T2/T5) KHÔNG được wire vào coordinator** — 5 hàm window trong coordinator-state.ts là **dead code**, `rates.connectFailRate` trên MỌI tick vĩnh viễn = 0, `connectFailsByType` trên WorkerTick vĩnh viễn = 0. Fix F1 (skip-first-tick + evict wall-clock) mà R1 đặt làm điều kiện PASS **không hoạt động runtime** — E2 vẫn chạy trên cumulative (code cũ) → class bug gốc (false-positive kéo dài) vẫn còn. Kèm 2 finding minor (payload rác + tile hiển thị mù) là hệ quả trực tiếp.

---

## P1 — SỐNG (MAJOR, chặn release) · T2/T5: window 60s wall-clock KHÔNG được wire — dead code + connectFailRate vĩnh viễn 0

**Vị trí**: `loadtest/coordinator.ts:534-546` (auto-stop E2 vẫn code CŨ) · `loadtest/coordinator-state.ts:140-165` (rollWindow/sumWindow/diffConnectWindowEntry/connectFailRateFromWindow/windowSpanSecs — 0 caller production) · `loadtest/coordinator-state.ts:298` (hardcode `connectFailRate: 0`).

**Vấn đề**: DESIGN §7.1 Bước A (prevConnectCumulative + diff loop + rollWindow + sumWindow + override `agg.tick.rates.connectFailRate` TRƯỚC pushTick) **không tồn tại trong diff**. Grep toàn repo:
- `rollWindow | sumWindow | diffConnectWindowEntry | connectFailRateFromWindow | windowSpanSecs` → chỉ xuất hiện trong `coordinator-state.ts` + `__tests__/coordinator-state.test.ts` (170 dòng test mới cho hàm CHẾT — test xanh tạo cảm giác F1 đã đóng, thực tế không).
- `coordinator.ts:534-546` giữ nguyên vòng lặp sum **cumulative** `for (const t of ticks) { attempts += t.counters.connectAttempts; fails += t.counters.connectFails; }` + `attempts >= 10 ? (fails/attempts)*100 : 0` — thay đổi duy nhất là decideAutoStop ngưỡng 10→50.
- `aggregateTicks` set `connectFailRate: 0` và **không nơi nào override** (coordinator.ts diff chỉ +7 dòng: import + provisioning tick) → mọi tick live trả 0.

**Bằng chứng (đo)**: nếu wire lại, chi phí đã đo = **0.0026ms/tick** @120 bucket (bench rollWindow+sumWindow+rate) — 0.00026% của tick 1s. KHÔNG có lý do hiệu năng nào để bỏ wire. Cái giá thật là **hiệu lực đo lường**: E2 decide trên cumulative → fail cũ không trôi khỏi rate → false-positive kéo dài — **chính class bug PRD đang sửa**; và skip-first-tick chống bucket phình sau restart không hoạt động → spike sau E3-restart vẫn nằm trong quyết định.

**Fix**: implement Bước A đúng DESIGN §7.1 (~30 dòng trong `aggregateTick`, hoisted trước `pushTick`), override rate trước pushTick. Không có trade-off hiệu năng.

---

## P2 — SỐNG (MINOR) · T1/T4: connectFailsByType không bao giờ được sum vào WorkerTick — ~52B/tick/worker payload 100% rác + breakdown card vĩnh viễn rỗng

**Vị trí**: `loadtest/socket-farm.ts:727-733` (emitTick pass 2 chỉ sum `connectAttempts`/`connectFails`) · `:468` (init `{...EMPTY_CONNECT_FAILS}`) · `:167` (comment "T4 thay 'other' bằng classifyConnectError" — hàm KHÔNG tồn tại).

**Vấn đề**: `emitTick` gán `counters.connectAttempts`/`connectFails` nhưng **không gán `counters.connectFailsByType`** → WorkerTick.counters.connectFailsByType = `{0,0,0,0}` mãi mãi (chỉ per-user runtimeStats được inc 'other' rồi chết). aggregateTicks merge 4 số 0 → LoadTestTick.connectFailsByType cũng 0 → UI rule "tổng = sum(byType)" (connect-fail.ts:34-40) = 0 trong khi `connectFails` > 0 → card CONNECT FAIL BREAKDOWN luôn hiện **"Không có connect fail trong run này"** giữa run đang fail ồ ạt.

**Bằng chứng (đo)**: JSON delta counters payload = **+89B/tick/worker**, trong đó byType = **52B (58%) toàn số 0** → trên 32 worker ≈ **1.7KB/s rác IPC** + byType 0 trên HTTP tick ≈ 1.9KB/s nữa. Nhỏ, nhưng 100% là byte chết vì data không bao giờ được tính.

**Fix**: emitTick pass 2 cộng thêm 4 key byType (4 dòng — chi phí 4 add/user/tick ≈ 0). classifyConnectError (T4) để có data thật, không phải 'other' hết.

---

## P3 — SỐNG (MINOR, hệ quả P1) · T6: tile Connect fail hiển thị "0.0%" xanh healthy vĩnh viễn — metric chính của fix bị mù

**Vị trí**: `src/pages/loadtest/LiveDashboardPage.tsx` (`connectFailValue` = `lastTick.rates.connectFailRate ?? 0`) · `src/components/loadtest/connect-fail.ts:30-33` (variant) · hint text "0% khi window chưa đủ 50 attempts".

**Vấn đề**: vì P1, `tick.rates.connectFailRate` luôn 0 → tile luôn **0.0% variant success** khi có attempt (F-8 "0% xanh = khỏe giả" tái xuất VĨNH VIỄN, không chỉ đầu ramp) + RateSparkline là đường 0 phẳng. Hint tooltip nói "0% khi window chưa đủ 50 attempts" — không phản ánh thực tế runtime (không bao giờ khác 0).

**Bằng chứng**: grep `connectFailRate` → coordinator.ts:539 là biến local cho decideAutoStop, KHÔNG gán vào tick; api-mappers/aggregateTicks/provisioning đều hardcode 0.

**Fix**: phụ thuộc P1 (override rate đúng); độc lập: đổi hint/label hoặc ẩn tile khi rate vĩnh viễn 0.

---

## P4 — XÁC MINH (không cần sửa) · các chi phí mới đo được — trả lời 4 câu hỏi xác minh

| Câu hỏi | Trả lời | Đo |
|---|---|---|
| 1. emitTick/usersFailed — O(1) hay O(n)? | **Gộp vào pass đếm phase CÓ SẴN** (socket-farm.ts:702-710) — KHÔNG thêm pass quét toàn bộ. Pass sum attempts/fails (:727-731) là pre-existing. 10k user loop = **0.029ms**; 2 pass @2500 user ≈ **0.035ms/tick/worker** — 0.0035% của tick 1s | bench node |
| 2. Window mỗi tick (nếu wire) | rollWindow+sumWindow+decideAutoStop @120 bucket = **0.0026ms/tick** — không ý nghĩa ở nhịp 1s; 2 alloc gen-0/giây không gây GC pressure | bench node |
| 3. aggregateTicks merge byType | +4 add + 4 merge key/worker/tick + 1 alloc `{...EMPTY_CONNECT_FAILS}` — O(workers) hằng số nhỏ, µs | phân tích |
| 4. UI poll 1s | Không recharts thứ 5 (PF2 đúng — SVG polyline). RateSparkline 60 điểm = **0.021ms**; ConnectFailBreakdown = reduce/map/filter/sort 4 phần tử ≈ µs; tổng thêm ~15 DOM node re-render 1Hz — vô nghĩa. Memo StatCard vô hiệu do array ref mới mỗi poll = **pre-existing F2 R1, không nặng thêm** | bench + đọc |
| 5. IPC payload | +89B/tick/worker (đo trên counters payload; payload thật 5-8KB) ≈ **+1.1-1.7%** — đúng claim +1-2% (F3 verified). NHƯNG 58% là byType 0 (P2) | bench |

Bonus (tích cực, xác nhận F6 R1): M7 `if (u.phase === 'failed') continue` trong schedulerTick 100ms (socket-farm.ts:581) + guard ensureChatCycle (:378) **GIẢM** công việc — user failed bị bỏ qua cả 2 vòng 100ms + 1s thay vì tiếp tục tick action.

---

## P5 — SỐNG (note, cho correctness lens) · T3: usersFailed không thực sự cumulative — race resurrect sau cutover

**Vị trí**: `loadtest/socket-farm.ts:141-143` ('connect' handler set `phase = 'connected'` KHÔNG guard `phase === 'failed'`) · `:174-179` (cutover) · `:716` (`counters.usersFailed = failed` — đếm current, không phải cumulative).

**Vấn đề**: cutover disconnect() có thể race với connect in-flight thành công → 'connect' event hồi sinh user failed (phase → 'connected', consecutiveConnectFails reset) → `usersFailed` (đếm phase hiện tại) **GIẢM** → vi phạm semantics "cumulative per-worker" ghi trong types.ts:115 và tooltip "có thể giảm khi worker restart" (tooltip sai nguyên nhân). Chi phí hiệu năng: 0. Xác suất thấp (single-threaded, cửa sổ nhỏ) nhưng đúng class lỗi "đếm sai" mà PRD đang chống.

**Fix**: guard `if (this.phase === 'failed') return;` đầu 'connect' handler (:141) — 1 dòng, chặn cả hồi sinh lẫn đếm lệch.

---

## Kết luận & điều kiện PASS

**Verdict: PERF PASS về CHI PHÍ — PERF FAIL về HIỆU LỰC CƠ CHẾ.**

Không có gì chậm (mọi đường mới < 0.1ms, IPC +1-2% đúng claim, UI +~15 node/s). NHƯNG cơ chế hiệu năng-correctness của chính fix — window 60s wall-clock (F1 R1) — **không được wire**: dead code + `connectFailRate`/`connectFailsByType` vĩnh viễn 0 → E2 vẫn chạy cumulative (bug gốc chưa được sửa ở tầng quyết định), dashboard hiển thị metric mù, payload chở byte chết.

**Finding SỐNG**:
| # | Severity | Mô tả | Hành động |
|---|---|---|---|
| P1 | **MAJOR** | Window T2/T5 không wire — dead code (5 hàm, test xanh trên hàm chết), E2 cumulative, rate tick = 0 | Wire Bước A §7.1 (~30 dòng, chi phí 0.003ms/tick) — chặn release |
| P2 | MINOR | connectFailsByType không sum trong emitTick → 52B/tick/worker rác + breakdown card sai | +4 dòng sum trong emitTick; T4 classify |
| P3 | MINOR | Tile Connect fail 0.0% xanh vĩnh viễn (hệ quả P1) | Fix hint/label hoặc theo P1 |
| P5 | note | usersFailed có thể giảm do race resurrect — semantics cumulative sai | Guard 1 dòng 'connect' handler |

**Điều kiện PASS của tôi**: P1 phải được wire trước khi coi F1 R1 là đã xử lý — test T2 xanh trên hàm không có caller là bằng chứng SAI. P2/P3 theo sau P1 (cùng 1 luồng wiring), P5 là 1 dòng độc lập.

---
**Performance Benchmarker** · 2026-08-05 · Chi phí diff: RẺ (đo) · Hiệu lực cơ chế: CHƯA hoạt động (dead code) — PHẢN ĐỐI duyệt release khi P1 chưa wire.
