# Critique Hiệu năng — Fix E2 connect-fail (council phản biện 3 đề xuất)

**Lens**: Performance Benchmarker (mặc định HOÀI NGHI — cố bác cả 3 đề xuất)
**Đọc**: PRD-loadtest-e2-connect-fail.md · PLAN-loadtest-e2-connect-fail.md · proposal-backend.md · proposal-security.md · proposal-ui.md
**Code xác minh**: loadtest/socket-farm.ts · loadtest/coordinator.ts · loadtest/coordinator-state.ts · loadtest/types.ts · loadtest/db/writer.ts · loadtest/db/store.ts · loadtest/api-mappers.ts · loadtest/routes/run.ts · src/pages/loadtest/LiveDashboardPage.tsx · src/components/ui/stat-card.tsx · src/components/loadtest/charts.tsx · src/components/loadtest/user-phases.ts · src/store/loadtest.store.ts
**Điều kiện đo**: 10k user · 2500 user/socket/worker · hàng chục worker fork · tick 1s · UI poll 1s — tool self-host, dashboard THƯỜNG CHẠY CÙNG MÁY với coordinator + workers + gateway + Postgres + Redis.

---

## Phán quyết tổng (TL;DR)

**Không có finding critical về hiệu năng.** Cả 3 đề xuất đều RẺ về CPU/memory/IO so với khối lượng tick hiện tại (mỗi worker đã gửi 5-8KB tick/s: histogram 384 số + errorSamples 20 mẫu chứa email; coordinator mỗi giây rebuild histogram cumulative + aggregate + DB). Thêm 7 field số không đáng kể.

Nhưng có **1 lỗi thiết kế đo lường nghiêm trọng (F1 — major)** nằm ngay trong thuật toán window 60s của proposal-backend: window đo theo **số bucket (tick)** chứ không theo **thời gian thực**, và nó trôi chính xác trong điều kiện tải cao — điều kiện duy nhất mà E2 tồn tại để phục vụ. Kèm 3 finding minor cần hành động (F2 UI, F3 claim sai, F4 lockstep v1.1). 3 điểm tôi đã soi và **bác bỏ** (F5, F6, F7 — đề xuất đúng, không có vấn đề hiệu năng).

---

## F1 — SỐNG (MAJOR) · proposal-backend (T2 + T5): window 60s tính theo "số bucket tick" trôi dưới tải — E2 phản ứng chậm/pha loãng ĐÚNG LÚC khủng hoảng

**Vị trí**: `rollWindow`/`sumWindow` (proposal-backend §2.2 — bucket = delta 1 tick, `max = 60`), diff loop (proposal-backend §3.2), `handleWorkerDied` xóa `prevConnectCumulative` (proposal-backend §3.5).

**Vấn đề**: Window 60s KHÔNG phải 60 giây thực — nó là 60 bucket, mỗi bucket = delta của 1 lần gọi `aggregateTick`. Nhưng nguồn delta (tick worker) đến **không đều**:

1. **Stall worker 4-8s**: `WORKER_HEARTBEAT_STALE_MS = 8000` (coordinator.ts:29-30) — worker bận event loop (2500 socket + chat cycle) được phép "im lặng" tới 8s trước khi bị SIGKILL. Trong lúc đó các attempt/fail dồn lại → **1 bucket chứa delta 4-8s** → 60 bucket phủ **64-68s wall time**; tải kéo dài → window phủ 70-90s.
2. **Restart worker — tệ hơn**: `handleWorkerDied` xóa `prevConnectCumulative` (proposal §3.5) → tick đầu sau restart rơi vào nhánh `base = {0,0,EMPTY}` (proposal §3.2 guard) → **delta = TOÀN BỘ cumulative từ lúc worker khởi động** (2-15s attempt/fail, vì reconnect theo pacing + `reconnectCount` reset) dồn vào **1 bucket phình**. Chuỗi restart (E3 loop) → mỗi restart thêm 1 bucket phình → window giãn **lũy tiến**. Proposal §2.3 mới thừa nhận "trượt tối đa vài giây" — chỉ đúng cho 1 lần stall, KHÔNG đúng cho chuỗi restart.

**Hậu quả đo được**:
- **AC-2 trễ**: "stop ≤ 60s kể từ khi window đủ mẫu" — dưới churn, window cần 60 bucket tương đương 70-90s thực → E2 stop chậm hơn spec đúng lúc hệ thống đang stress nhất.
- **False-positive KÉO DÀI (tái hiện đúng bug gốc)**: fail đầu run trôi khỏi window chậm hơn 60s thực → rate phục hồi chậm → run hợp lệ có thể bị stop muộn nhưng vẫn stop nhầm — chính cái bug PRD đang sửa.
- **False-negative mới (che fail thật)**: bucket phình sau restart thường chứa chủ yếu **attempts healthy** (user reconnect thành công sau restart — "attempt bump là tín hiệu thật" theo R6 là sai: bump là artifact của kỹ thuật diff, không phải hành vi user) → denominator phình → rate window bị pha loãng xuống dưới 30% → E2 tê liệt khi worker chết hàng loạt (E3) — kịch bản trùng với outage thật.

**Bằng chứng**: coordinator.ts:29-30 (heartbeat 8s), coordinator.ts:448 (`ticks = [...this.workerTicks.values()]` — tick mới nhất/worker, không có wall-time check), socket-farm.ts:486-487 (tickTimer 1s worker — không đồng bộ với aggregateTimer coordinator), proposal-backend §2.3 dòng "Tick bị bỏ lỡ… delta gộp N giây vào 1 bucket" (thừa nhận giới hạn), §3.2 guard `base = prev && ... ? prev : {0,0,...}` (restart → delta = full cumulative), §3.5 `prevConnectCumulative.delete(workerId)`.

**Severity**: **major** — không phá mechanism (rate vẫn tính trên đúng tập sự kiện, ratio bảo toàn) nhưng làm **sai thời gian phản ứng của cơ chế an toàn đúng trong điều kiện nó được thiết kế để hoạt động**. Security proposal S2 (clamp `max(0, delta)`) chỉ chặn delta âm — KHÔNG xử lý bucket phình dương này.

**Cách giảm chi phí** (chọn 1, xếp theo rẻ → đúng):
1. **Rẻ nhất**: tick đầu sau restart → `prev = tick`, delta = 0 (skip 1 bucket) — kill hẳn cơ chế (b) bằng 3 dòng.
2. **Đúng nhất**: window theo **wall-clock** — bucket lưu `ts` (WorkerTick đã có `ts` — types.ts:91), evict theo `age > 60s` thay vì đếm count, sum bằng running total (O(1) amortized). Vẫn pure/test được, và window 60s nghĩa đúng 60s thực.
3. Cap delta/bucket (attempts ≤ ngưỡng hợp lý/tick) — chặn spike vô lý như "phòng thủ tầng cuối".

---

## F2 — SỐNG (MINOR) · proposal-ui (D1, D4, sparkline): +1 recharts sparkline + card trên dashboard chạy CÙNG MÁY load generator; memo đã có nhưng bị vô hiệu bởi array reference mới mỗi giây

**Vị trí**: `useSpark` (LiveDashboardPage.tsx:33-39), KPI grid 8→9 (LiveDashboardPage.tsx:200-226), `StatCard` = `React.memo` nhưng sparkline render qua recharts `AreaChart` (stat-card.tsx:39-106), store poll 1s tạo `ticks` array MỚI mỗi lần (loadtest.store.ts:160), chart lớn đã memo (charts.tsx:137/215/316/405).

**Vấn đề**:
1. `StatCard` đã memo nhưng **sparkline prop = array mới mỗi giây** (useSpark re-map khi `ticks` đổi) → memo vô hiệu → 4 AreaChart sparkline hiện có **re-render 1Hz**. Tile 9 (sparkline "Connect fail") = chart recharts thứ 5.
2. Chart lớn (ConnectionsLineChart 3600 điểm, Latency, StackedArea, ActionRate) đã memo nhưng nhận `ticks` reference mới mỗi poll → **re-render toàn bộ 1Hz** — hiện trạng, fix làm tăng thêm 1 chart + 1 card.
3. **Ngữ cảnh same-host** (điểm quan trọng nhất): dashboard chạy trên chính máy đang chạy coordinator + N worker × 2500 socket + gateway + Postgres + Redis. Mỗi chu kỳ render 1Hz (5 sparkline + 4 chart lớn + donut + gauge) tốn ước tính 20-60ms main-thread — **tranh CPU trực tiếp với load generation đang đo**. Thêm 1 sparkline ≈ +2-8ms/s — nhỏ nhưng đúng hướng sai.
4. **Lỗi nhỏ kèm theo**: `useRateSpark` map `t.rates.connectFailRate` — tick replay từ DB (`toMetricTick` — api-mappers.ts:73, KHÔNG có `connectFailRate`) → `undefined` → AreaChart nhận giá trị undefined → đứt/NaN nét vẽ.

**Bằng chứng**: LiveDashboardPage.tsx:33-39 (useSpark — array mới mỗi ticks đổi), stat-card.tsx:39 (`memo` + `AreaChart` dòng 85-101), loadtest.store.ts:160 (`ticks: [...s.ticks, ...metrics.ticks].slice(-RING_CAPACITY)` — reference mới mỗi poll), charts.tsx:137-138/215-216/316-317/405-406 (memo nhưng props thay đổi), api-mappers.ts:73 (`rates: { successRate, echoRate }` — thiếu connectFailRate), routes/run.ts:95-101 (metrics trả tickHistory từ `since` — incremental 1 tick/s, first-load tối đa 3600).

**Severity**: **minor** — marginal cost thực nhỏ; nhưng có 2 hành động rẻ, không đáng bỏ qua.

**Cách giảm chi phí**:
1. Tile mới (và nếu được, cả 4 sparkline cũ — 1 lần đổi) dùng **SVG polyline thủ công ~10 dòng** thay recharts AreaChart (recharts overhead/instance ~1-3ms → ~0.1ms; không cần ResponsiveContainer/scale). Không vi phạm chuẩn codebase: `isAnimationActive={false}`, `dot={false}` đã là rule (charts.tsx:3).
2. `useRateSpark` guard `?? 0` (replay tick thiếu field) — 1 dòng, tránh NaN.
3. D6 (stacked bar flex-div, không recharts) là **quyết định đúng** — giữ nguyên, không nâng cấp thành chart.

---

## F3 — SỐNG (MINOR) · proposal-backend §1.2: lý do "child_process fork dùng structured clone" là SAI — chi phí thật +1-2%, không đáng lo

**Vị trí**: proposal-backend §1.2 — "`WorkerTick` IPC: child_process fork dùng structured clone — field số thuần không ảnh hưởng".

**Vấn đề**: **child_process IPC dùng JSON.stringify/JSON.parse** (structured clone là cơ chế của `worker_threads.postMessage`). Claim sai nhưng **kết luận vẫn đúng**: thêm 2 counter + `connectFailsByType` (4 số) + `usersFailed` ≈ **60-100 byte/tick/worker** so với payload hiện tại 5-8KB (socket-farm.ts:719-734: histograms tới 384 số + `errorSamples` 20 mẫu × email ~200-300B + errors map + action maps). Tăng **~1-2%** — vô nghĩa với queue backpressure sẵn có của `child.send()`.

**HTTP path** (thêm vào để đầy đủ): LoadTestTick +4 counter +1 rate ≈ +120 byte/tick → poll 1s tăng +120B/s (không đáng kể); first-load lịch sử 3600 tick +~430KB (1 lần, chấp nhận được).

**Bằng chứng**: socket-farm.ts:719-734 (tick build — payload hiện tại), worker-farm.ts:104-109 (IPC message handler — JSON), routes/run.ts:95-101 (tick history trả qua HTTP).

**Severity**: **minor** — hành động cần thiết: sửa claim trong proposal để không truyền sai kiến thức nền (khi dev sau này tính "bao nhiêu byte trên IPC" sẽ cộng sai thứ tự độ lớn).

**Cách giảm chi phí**: không cần code. Sửa chú thích: "child_process fork IPC = JSON serialization; thêm 7 field số ≈ +1-2% payload tick".

---

## F4 — SỐNG (MINOR) · proposal-backend §1.2 (DB): "toMetricSample không cần sửa" xác minh ĐÚNG; param count an toàn; cảnh báo lockstep 3 nơi cho v1.1

**Vị trí**: `toMetricSample` (writer.ts:412-441 — pick field tường minh, không spread `t.counters`), `insertMetricSamples` (store.ts:379-403 — 26 cột), `MAX_PENDING_TICKS = 500` (writer.ts:21).

**Vấn đề**: **KHÔNG có vấn đề thực ở MVP — claim được xác minh**:
- Payload INSERT không đổi (không cột mới) → không vỡ ngưỡng 65.535 param.
- Toán param: 26 cột × 500 tick = **13.000 < 65.535**. Kể cả v1.1 thêm 5 cột connect: 31 × 500 = **15.500 — vẫn an toàn**, KHÔNG cần chunk cho metric_samples (khác `pool_accounts` đã phải CHUNK 500 vì 13 cột × 5k+ accounts ≈ 65k — store.ts:549-556 — đúng chỗ "đã từng vỡ" trong đề bài).
- R1 (DB replay) đã chấp nhận: `toMetricTick` (api-mappers.ts:42-79) không có field mới → replay hiển thị 0 — dashboard live không bị ảnh hưởng (rate gán trước `pushTick` — proposal §3.2).

**Rủi ro thật (tương lai)**: v1.1 thêm cột → phải sửa **khớp 3 nơi**: (1) `toMetricSample` writer.ts:412-441, (2) cols+values store.ts:381-398 + SELECT list store.ts:405-419, (3) `toMetricTick` api-mappers.ts:42-79. Lệch 1 nơi → replay vỡ hoặc INSERT sai cột im lặng. Với 10k user run 60 phút = 3600 tick/run, đây là dữ liệu chẩn đoán — vỡ replay = mất khả năng điều tra post-mortem.

**Severity**: **minor**.

**Cách giảm chi phí**: MVP không cần sửa gì. V1.1: rút 1 danh sách cột constants dùng chung cho toMetricSample + store (tránh 3 chỗ tự do).

---

## F5 — CHẾT (bác bỏ) · proposal-backend T2: rollWindow/sumWindow O(60) mỗi tick — chi phí vài trăm ns → 1µs, KHÔNG đáng kể

**Vị trí**: proposal-backend §2.2 — `[...buckets, entry]` + `while shift` + full re-sum mỗi tick.

**Vấn đề giả định**: array copy 60 phần tử + shift + sum lại 60 bucket mỗi tick → GC pressure ở coordinator?

**Xác minh**: 60 bucket × ~6 phép cộng + 1 alloc array 60 phần tử **1 lần/giây** — vài trăm ns trên tổng ~5-15ms công việc `aggregateTick` hiện tại (coordinator.ts:418-560: cumulativeHistograms rebuild dòng 464-469, aggregateTicks histogram merge, NO_POST_FIXTURE scan, heartbeat check, DB push). Không gây GC pressure đáng kể (1 alloc/s vào gen 0). **Không cần thuật toán tối ưu.** Nếu muốn O(1): running sum (add khi push, trừ khi evict) + mutate tại chỗ — nhưng đánh đổi tính pure/test được để tiết kiệm ~1µs/tick là KHÔNG đáng.

---

## F6 — CHẾT (bác bỏ) · proposal-backend (T1/T4) + T3: worker thêm pass đếm byType/usersFailed — không vấn đề; M3/M7 thực ra GIẢM chi phí

**Vấn đề giả định**: pass đếm thêm trên 10k user mỗi tick + skip failed có làm trễ worker?

**Xác minh**: `emitTick` đã chạy 2 pass/users/s (socket-farm.ts:671-678 phase count, 694-698 connect counters). Thêm byType sum = +4 add/user/s = **40k phép cộng/s — vô nghĩa**; proposal đã đúng khi gộp đếm `failed` vào pass phase-counting (không thêm pass thứ 3). `schedulerTick` loop 100ms × 10k user = 100k iter/s (socket-farm.ts:549-565) — guard `phase === 'failed'` (M7) **giảm** công việc trong vòng lặp, không tăng. Disconnect ồ ạt 10k user khi AC-2: mỗi disconnect ~µs, 1 lần/user, ~10-50ms tổng — chấp nhận, không phải bottleneck.

---

## F7 — CHẾT (bác bỏ) · proposal-backend T5: wiring window + diff trong aggregateTick — KHÔNG làm trễ tick loop chính

**Vấn đề giả định**: thêm O(workers + 60) mỗi tick làm trễ vòng lặp 1s của coordinator → tick lệch → auto-stop trễ?

**Xác minh**: diff loop O(16-32 workers) + roll/sum O(60) + 2 object alloc ≈ **micro-giây** — < 0.1% công việc `aggregateTick` hiện tại. `formatE2Log` chỉ chạy 1 lần lúc stop. Worker-side: T3/T4 chỉ thêm công việc **per-event** (classifyConnectError regex + 4 counter inc + recordError bounded 20) — ngay cả 5k connect_error/s (AC-2) ≈ 1-2ms/s trên worker event loop — không trễ `emitTick` (1s) hay `schedulerTick` (100ms). **Không có chỗ nào trong 3 đề xuất làm trễ vòng lặp chính** — rủi ro thời gian thực nằm ở F1 (window trôi), không phải chi phí tính toán.

---

## Kết luận & điều kiện PASS hiệu năng

**4 finding SỐNG** (1 major + 3 minor) · **3 bị bác bỏ** (F5, F6, F7 — đề xuất rẻ đúng như tuyên bố).

| # | Finding | Proposal | Severity | Hành động |
|---|---|---|---|---|
| F1 | Window 60s theo bucket-count trôi dưới tải + restart first-tick cumulative spike | backend T2/T5 | **major** | Skip tick đầu sau restart HOẶC window wall-clock (evict theo age) |
| F2 | +1 recharts sparkline + card; memo bị vô hiệu; same-host contention; replay thiếu field | ui | minor | SVG sparkline cho tile mới + guard `?? 0` |
| F3 | Claim "structured clone" sai (IPC = JSON) — chi phí thật +1-2% | backend §1.2 | minor | Sửa doc claim |
| F4 | DB impact = 0 xác minh đúng; lockstep 3 nơi khi v1.1 thêm cột | backend §1.2 | minor | MVP không sửa; v1.1 dùng constants cột chung |

**Điều kiện PASS**: F1 phải được xử lý (chọn 1 trong 2 phương án đề xuất) — không xử lý, tôi không duyệt T5. F2-F4 là cải thiện rẻ, không chặn.

**Phán quyết hiệu năng tổng**: thiết kế RẺ, không có nguy cơ tải (IPC/DB/UI đều +1-5%); rủi ro thực nằm ở **độ chính xác theo thời gian của phép đo** (F1) — một lỗi thuộc đúng phạm vi "đo sai" mà PRD đang sửa.
