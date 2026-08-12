# Critique — lens Correctness · Design Council autobuild fix E2 loadtest connect-fail

**Reviewer**: Code Reviewer (correctness) · **Ngày**: 2026-08-05
**Đối tượng**: proposal-backend.md · proposal-security.md · proposal-ui.md (đối chiếu code thật: loadtest/coordinator.ts, coordinator-state.ts, socket-farm.ts, types.ts, config.ts, api-mappers.ts, db/writer.ts, worker-farm.ts, src/components/loadtest/user-phases.ts, src/pages/loadtest/LiveDashboardPage.tsx)

**Phương pháp**: bác bỏ từng claim bằng code (file:dòng); tìm mâu thuẫn nội bộ + edge case; AC nào không đạt với design này.

---

## A. Proposal Backend (T1 + T2 + T5)

### BE-1 · [minor] E2 response-time phụ thuộc rampRate ~200× — ngưỡng count-50 cộng với window 60 bucket làm tốc độ phản ứng tự đảo theo ramp

**Vị trí**: proposal-backend §2.1 (`E2_MIN_ATTEMPTS = 50` + `E2_WINDOW_BUCKETS = 60`), §2.3 ("rate 0 khi attempts < minAttempts"), §6 T2 test 3 (`connectFailRateFromWindow: attempts 49 → 0`).

**Vấn đề**: Ngưỡng 50 attempts không phải là "đủ mẫu thống kê" bất biến theo thời gian — nó là một **số đếm** so với **cửa sổ 60 tick**. Tốc độ tích lũy attempts = effective connect rate, mà effective rate bị chặn dưới bởi `Math.max(1, rampRate/workerCount)` mỗi worker (socket-farm.ts:528-533) → với rampRate nhỏ, window phải chờ 40-50s mới đủ 50 attempts; với ramp 200/s (default), chỉ mất 0.25s.

**Tại sao phá vỡ**: PRD §6.6 tự biện minh ngưỡng 50 bằng "ramp 200/s ≈ 0.25s ramp" — biện minh này **chỉ đúng ở default ramp**. AC-2 yêu cầu "dừng trong ≤ 60s kể từ khi window đủ mẫu" — với 100% token lỗi + ramp tối thiểu (vd 0.5/s, config.ts:311 chỉ chặn `rampRate <= 0`), window cần ~50s để đủ mẫu → E2 phản ứng chậm ~50s (vs 0.25s). Không vỡ AC (vẫn ≤ 60s từ lúc đủ mẫu), nhưng khoảng thời gian run chạy "mù" với 100% user failed tăng gấp ~200 lần, và test list T5 (spike/sạch/stop/<50) không có case ramp chậm nào bắt đặc tính này.

**Bằng chứng**: `loadtest/socket-farm.ts:528-533` (`ratePerWorker = Math.max(1, rampRate/workerCount)` → effective ≥ 1/s) · `loadtest/config.ts:311-315` (mọi rampRate > 0 hợp lệ) · proposal-backend §2.3 ("rate 0 khi attempts < minAttempts").

**Khắc phục gợi ý**: test bắt buộc thêm case ramp thấp; hoặc dùng ngưỡng theo thời gian (vd fail rate > 30% kéo dài N giây liên tục) thay vì count thuần.

---

### BE-2 · [major] Claim "counters.connectAttempts/connectFails/usersFailed là cumulative toàn run" SAI khi worker E3-restart — counter giảm giữa run, donut/log/dashboard regress

**Vị trí**: proposal-backend §1.1 "Lưu ý semantics quan trọng" (dòng 47-59): "`connectAttempts/connectFails` trong LoadTestTick là **CUMULATIVE toàn run** (snapshot — khớp mọi counter khác)"; §3.3 field 7 `usersFailed` chú thích "(cumulative)".

**Vấn đề**: Worker chết → E3 restart spawn **process mới** với counters khởi tạo 0 (socket-farm.ts:435-440 `private counters = { ... connectAttempts: 0, connectFails: 0 }`; worker-farm.ts:182-196 `restart()` → `spawn()` process fork mới). Coordinator `aggregateTicks` sum counter **mới nhất** của từng worker (coordinator-state.ts:104-144) → khi worker chết giữa run, `LoadTestTick.connectAttempts/connectFails/usersFailed` **giảm** so với tick trước.

**Tại sao phá vỡ**: (1) Dashboard "fails 1.2k (lũy kế)" tụt về thấp giữa run — vi phạm tinh thần AC-6 "không cần đoán" trong đúng bối cảnh incident (PRD §2 #4: worker churn); (2) donut slice "Lỗi" (D7) biến mất rồi xuất hiện lại khi worker restart; (3) log E2 8-trường `usersFailed(cumulative)` đặt tên sai bản chất dữ liệu.

**Bằng chứng**: `loadtest/socket-farm.ts:435-440` (init 0) · `loadtest/worker-farm.ts:182-196` (restart = fork mới) · `loadtest/coordinator-state.ts:104-144` (sum latest per-worker, không phải monotonic accumulate).

---

### BE-3 · [minor] Log E2 `windowSec=60` hardcode trong khi window thực tế trượt 65-70s+ — field AC-4 tự mâu thuẫn với chính window nó báo

**Vị trí**: proposal-backend §3.3 field 3 (`windowSec = E2_WINDOW_BUCKETS (60) — hằng số`); §8.1 thừa nhận "cửa sổ trượt thời gian thực (có thể 65-70s thay vì 60s)".

**Vấn đề**: Bucket được roll theo nhịp tick của **coordinator** (1 bucket/aggregateTick) nhưng mỗi bucket có thể chứa delta nhiều giây (worker stall 8s → kill → restart, coordinator GC pause). 60 bucket ≈ 60-90s wall-time. Proposal vừa thừa nhận drift (§8.1) vừa hardcode `windowSec=60` vào log (AC-4).

**Tại sao phá vỡ**: AC-4 yêu cầu log có "window seconds" — con số 60 là sai với chính dữ liệu windowAttempts/windowFails in cùng dòng; script grep log sau này tính lại rate sẽ nhân nhầm. Chi phí sửa ~0 (lưu `lastWindowSecs` thực khi roll).

**Bằng chứng**: proposal-backend §3.3 field 3 vs §8.1 (self-contradiction) · `loadtest/coordinator.ts:304-310` (setInterval 1000ms không phải timer chính xác).

---

### BE-4 · [minor] E2 có thể bị bỏ lỡ đúng tick duration hết — run 100% connect fail vẫn kết thúc status='finished'

**Vị trí**: proposal-backend §3.2 step B (E2 block "giữ vị trí :513-547"); không đề cập thứ tự với phase-advance.

**Vấn đề**: Trong `aggregateTick`, khối phase-advance (coordinator.ts:502-506: `steady && elapsedSec >= durationSec` → `setPhase('cooldown')`) chạy TRƯỚC khối E2 (coordinator.ts:513-547, guard `phase === 'ramping' || 'steady'`). Nếu duration hết đúng tick mà window vượt ngưỡng E2 → phase đã là 'cooldown' → E2 skip → run finish 'natural' với stopReason "duration hết", status 'finished' — dù connect fail 100% suốt run.

**Tại sao phá vỡ**: Báo cáo sai sự thật (run "finished" thành công trong khi 0 user connected); AC-7 "E2 vẫn là auto-stop thật sự" bị xuyên thủng ở boundary tick. Xác suất thấp nhưng là mâu thuẫn thứ tự code hữu hình, test T5 (mô phỏng tick) không cover.

**Bằng chứng**: `loadtest/coordinator.ts:502-506` (cooldown trước) vs `:513-547` (E2 block sau, cùng guard phase).

---

## B. Proposal Security

### SEC-1 · [major] Yêu cầu S3 "failsByType/workers là cumulative" MÂU THUẪN trực tiếp với proposal-backend §3.3 (failsByType lấy TỪ WINDOW) — cùng 1 field log, 2 semantics

**Vị trí**: proposal-security §2.2 (b) (dòng 54: "Ghi rõ trong log field nào là window, field nào là cumulative (failsByType từ tick mới nhất là cumulative)") và §3 S3 (dòng 131: "Ghi rõ field nào window vs cumulative (failsByType/workers là cumulative)").

**Vấn đề**: proposal-backend §3.3 field 6 (dòng 249-251) đã **có chủ đích đổi** nguồn `failsByType` từ "sum cumulative từ ticks" (đúng như PLAN T5 viết) sang `window.byType`, với lý do "tổng 4 loại phải == windowFails để log tự nhất quán". Proposal-security đọc **PLAN T5 cũ** (không đọc bản sửa của backend) rồi đóng thành yêu cầu bảo mật S3 ghi nhãn "failsByType là cumulative" — sai với design đã chốt.

**Tại sao phá vỡ**: Implementer nhận 2 tài liệu trái nhau về **cùng 1 field log**. Nếu bám S3: hoặc (a) dán nhãn "cumulative" lên giá trị window → log sai nhãn, hoặc (b) lấy cumulative thật → `sum(4 loại) ≠ windowFails` → phá luôn tính tự nhất quán mà backend §3.3 vừa xây, và ST-7 ("regex assert dòng E2 chỉ có số") không bắt được lỗi này. Đây là lỗi review-syncing chứ không phải lỗi thiết kế — cần thống nhất 1 nguồn truth (nên theo backend §3.3: failsByType = window; workers = cumulative).

**Bằng chứng**: proposal-backend §3.3 bảng field 6 (dòng 249-251) vs proposal-security S3 (dòng 131) · PLAN T5 dòng 165 ("sum connectFailsByType từ ticks mới nhất" — nguồn mà security dựa vào).

---

### SEC-2 · [minor] §2.3 sai số học: "6% token lỗi → fails 3000, attempts ~10.6k → rate ~28%" — mẫu số 10.6k bất khả thi với 3000 fails

**Vị trí**: proposal-security §2.3 (a) (dòng 66: "Với **6% token lỗi vĩnh viễn**: fails ~ 600×5 = 3000, attempts ~ 10.6k → rate ~28% < 30%").

**Vấn đề**: Trong chính mô hình bounded-5 của họ, 3000 fails đồng nghĩa broken users có ≥ 3000 attempts (mỗi fail = 1 attempt — socket-farm.ts:155-160). Mẫu số đúng = 10.000 (healthy) + 3000 (broken) = **13.000 → 23.1%**, không phải 28.3% (3000/10600). "10.6k" = 10k + 600 tức đếm mỗi broken user 1 attempt — mâu thuẫn với 3000 fails.

**Tại sao phá vỡ**: Biên cách ngưỡng 30% bị tính sai ~5 điểm (thực ~7 điểm, nói là ~2 điểm) → mức độ khẩn cấp của yêu cầu "bắt buộc `usersFailed` hiển thị nổi bật" được biện minh bằng con số phóng đại rủi ro. Không đổi kết luận (vẫn < 30%) nhưng margin analysis của proposal sai.

**Bằng chứng**: `loadtest/socket-farm.ts:155-160` (mỗi `connect_error` = 1 attempt + 1 fail) · proposal-security §2.3 (dòng 66) vs proposal-backend §5 (dòng 296-297 — tính đúng 20.8% với cùng mô hình).

---

## C. Proposal UI (T6)

### UI-1 · [major] Replay lịch sử (R1) hiển thị "Chưa có dữ liệu connect — đang chờ user connect đầu tiên..." trên MỌI run đã hoàn thành — kể cả run E2-stopped với fail thật

**Vị trí**: proposal-ui §5.4 empty state #2 (dòng 167: `lastTick && c.connectAttempts === 0` → "Chưa có dữ liệu connect — đang chờ user connect đầu tiên..."), §7 Replay (dòng 204).

**Vấn đề**: `toMetricTick` (DB replay) trả connect fields = 0 (api-mappers.ts:42-79 — DB không có cột, R1). Điều kiện state #2 (`connectAttempts === 0`) đúng với **mọi** replay → mọi run lịch sử — kể cả run 10k user đã connect đầy đủ, kể cả run vừa bị E2 auto-stop với connect fail thật — đều hiển thị "đang chờ user connect đầu tiên" như thể dữ liệu còn đang tới.

**Tại sao phá vỡ**: (1) Mâu thuẫn trực tiếp trên cùng màn hình với banner "Run tự dừng: register/connect fail vượt ngưỡng (E1/E2)" (LiveDashboardPage.tsx:179-190) — operator mở lại run incident sẽ thấy "không có dữ liệu connect" cạnh "connect fail vượt ngưỡng"; (2) empty state dùng thì hiện tại ("đang chờ...") cho run frozen — nói dối trạng thái. UI không thể phân biệt "không persist (R1)" vs "thật sự 0" — proposal tự thừa nhận ở §2 ("frontend không thể phân biệt") nhưng không đổi text empty state cho hợp. Phải phân biệt theo run phase (frozen → text khác) hoặc persist field (v1.1).

**Bằng chứng**: `loadtest/api-mappers.ts:42-79` (không có connect field) · `loadtest/db/writer.ts:412-441` (`toMetricSample` không persist rates.connectFailRate) · proposal-ui §5.4 #2 + §7.

---

### UI-2 · [minor] Mockup của chính proposal mâu thuẫn số học — "fails 1.2k" (connectFails) vs sum byType 1107; "750 (61%)" sai với cả 2 mẫu số

**Vị trí**: proposal-ui §9 mockup (dòng 238-245): summary "attempts 12.4k · fails 1.2k", legend "timeout 750 (61%) · transport 340 (28%) · reject 12 (1%) · other 5 (<1%)".

**Vấn đề**: 750+340+12+5 = **1107 ≠ 1200**. Và 750/1200 = 62.5% (→ theo format `pct >= 10 → Math.round` = 63%, không phải 61%); 750/1107 = 67.8%. Proposal §2 (dòng 41) tự nêu bất biến "`connectFails === timeout+transport+reject+other` (về lý thuyết)" rồi §5.3 quyết định "tổng = sum 4 loại, không dùng connectFails trực tiếp" — mockup chứng minh 2 tổng lệch nhau ngay trong ví dụ chuẩn của họ.

**Tại sao phá vỡ**: Card có 2 con số tổng khác nhau (summary line "fails 1.2k" vs legend sum 1107) — đúng rủi ro "2 mẫu số" mà D3/§11.2 cố chống; khi byType lệch (replay/restart — xem BE-2), UI render 2 tổng mâu thuẫn trên cùng card. Fix tối thiểu: summary line dùng `sum(byType)` chứ không `connectFails`, hoặc ngược lại.

**Bằng chứng**: proposal-ui §9 (dòng 238-245) vs §2/§5.3 (dòng 41, 150) — self-inconsistency.

---

### UI-3 · [minor] Tile `--` (khi `connectAttempts === 0`) tái xuất hiện giữa run sau E3 restart; sparkline vẽ 0-line trong khi value `--`

**Vị trí**: proposal-ui §4 (dòng 104-106: `--` khi `!lastTick` HOẶC `c.connectAttempts === 0`), §4 sparkline (dòng 108: `useRateSpark` map `t.rates.connectFailRate`).

**Vấn đề**: (1) `connectAttempts` cumulative reset về 0 khi mọi worker restart (BE-2: socket-farm.ts:435-440 + worker-farm.ts:182-196) → tile đang hiển thị số bỗng quay về `--` giữa run live — trạng thái "chưa có dữ liệu" hiển thị khi run đã có dữ liệu; (2) replay: value `--` (attempts=0) nhưng sparkline map `rates.connectFailRate` (= 0, T1 bắt buộc thêm field vào toMetricTick) → vẽ đường 0 phẳng dưới tile `--` — 2 nguồn cùng 1 metric hiển thị mâu thuẫn (proposal §4 nói "Giá trị mặc định: undefined khi chưa có tick nào" — replay CÓ ticks nên không undefined).

**Tại sao phá vỡ**: Operator đọc "chưa có dữ liệu" trong khi run đang chạy giữa chừng (worker churn — chính bối cảnh incident); và màn hình lịch sử vừa `--` vừa 0-line. Severity thấp nhưng là hệ quả trực tiếp của việc dùng cumulative counter làm điều kiện hiển thị.

**Bằng chứng**: proposal-ui §4 (dòng 104-108) · `loadtest/socket-farm.ts:435-440` (counter reset khi restart) · `loadtest/worker-farm.ts:182-196`.

---

## D. Claims đã xác minh ĐÚNG (không phải finding — để council khỏi soi lại)

- **Backend §3.4**: stopReason hiện tại bắt đầu `auto-stop:` (coordinator.ts:546 + coordinator-state.ts:61) — AC-2 chữ nghĩa "bắt đầu bằng 'E2:'" thật sự vỡ với code hiện tại; fix prefix `E2:` là cần thiết. ✓
- **Backend §1.2**: `emitTick` spread `{ usersTotal, ...this.counters }` (socket-farm.ts:724) tự mang field mới ✓; `toMetricSample` pick field tường minh (writer.ts:412-441) → DB impact = 0 ✓; `workerDeathTimes` ring buffer pattern (coordinator.ts:104-106) ✓.
- **Backend §2.2/§2.4**: `rollWindow`/`sumWindow` toán đúng (sum 60 bucket, không leak) ✓; `decideAutoStop` E2 `> 30 && >= 50` với window-đủ-50 đáp ứng AC-2/AC-3 về số ✓ (nếu không kể BE-1).
- **Backend §5 AC-1 math**: 20.8% (2500 fails/12500 attempts) đúng và gần như bất biến theo thời điểm đo (rate bảo toàn khi restart worker — fails và attempts cùng nhân đôi). ✓
- **Security §2.4 (c)**: `redactMsg` chỉ bắt `token=...` (logger.ts:127-135), `recordError` cắt `slice(0,160)` không redact (socket-farm.ts:663) — yêu cầu sanitizer chung có cơ sở ✓. Số liệu file: users_accounts.json ~1MB, 2 file accounts-*.json 14,503,047 bytes ✓. `/metrics` auth: true (api-server.ts:87) ✓. worker-farm alive/total (60-68) ✓.
- **UI §3.1/§3.2**: grid `xl:grid-cols-8` (LiveDashboardPage.tsx:200), Hàng 3 (287-322), pattern `space-y-4 lg:col-span-4` (264), banner error (179-190) ✓. PHASE_COLORS.failed (chart-theme.ts:32) + PHASE_LABELS.failed (user-phases.ts:28) đã có — slice 'failed' chỉ thiếu ở `slicesFromTick` ✓. Donut invariant (D7) giữ được: failed ⊂ not-connected trong mô hình M3 terminal ✓.

---

## E. Danh sách finding SỐNG (sau tự phản bác nội bộ)

| # | Proposal | Finding | Severity |
|---|---|---|---|
| 1 | backend | BE-2: "cumulative toàn run" sai khi E3-restart — counter/donut/log regress giữa run | major |
| 2 | security | SEC-1: S3 "failsByType là cumulative" mâu thuẫn backend §3.3 (window.byType) — cùng field log, 2 semantics | major |
| 3 | ui | UI-1: replay mọi run lịch sử hiển thị "đang chờ user connect đầu tiên" — kể cả run E2-stopped, trái banner đỏ cùng màn hình | major |
| 4 | backend | BE-1: E2 response-time đảo theo rampRate ~200× (0.25s @200/s → ~50s @ ramp min) — ngưỡng count-50 + window 60 bucket | minor |
| 5 | backend | BE-3: log `windowSec=60` hardcode vs window thực trượt 65-70s+ (tự mâu thuẫn với §8.1) | minor |
| 6 | backend | BE-4: duration hết đúng tick → phase-advance trước E2 block → run 100% fail vẫn 'finished' | minor |
| 7 | security | SEC-2: sai số học §2.3 (3000 fails/10.6k attempts bất khả thi; đúng 13k → 23.1% không phải 28%) | minor |
| 8 | ui | UI-2: mockup breakdown tự mâu thuẫn (fails 1.2k vs sum 1107; "750 (61%)" sai cả 2 mẫu số) | minor |
| 9 | ui | UI-3: tile `--` tái xuất hiện giữa run sau restart + sparkline 0-line dưới value `--` (replay) | minor |

**Đã bác (bỏ sau tự phản bác)**:
- *Worker restart → double-count fails trong window phá AC-1* — BÁC: fails và attempts cùng nhân đôi cho cả cohort restart, rate bảo toàn ~20.8% (tự kiểm chứng số).
- *Tick in-flight cũ sau SIGKILL gây delta khổng lồ* — BÁC: xác suất cực thấp, bounded 1s, đã có guard delta âm.
- *Danger strip `rate >= 30` sai vì không check attempts ≥ 50* — BÁC: `connectFailRateFromWindow` ép rate = 0 khi < 50 → điều kiện `rate >= 30` đã ngầm chứa attempts ≥ 50.
- *"0% khi chưa đủ mẫu" gây hiểu nhầm healthy* — BÁC: proposal đã xử lý hint + thừa nhận giới hạn (§11.3), không phải lỗi design.
- *Donut D7 đếm trùng* — BÁC: invariant `total = usersCreated` giữ nguyên về số học trong mô hình M3 (failed ⊂ not-connected).

**Khuyến nghị tối thiểu trước khi chốt design**: (1) chốt 1 semantics cho `failsByType` trong log (theo backend §3.3 = window) và sửa S3 cho khớp — đây là 2 proposal đang nói 2 thứ khác nhau về cùng field; (2) ghi nhận BE-2 vào contract (counters mới KHÔNG monotonic sau restart) và đổi nhãn UI "lũy kế" → "hiện tại" hoặc thêm note; (3) empty state replay của UI phải phân biệt run frozen (R1) với run live — không dùng text "đang chờ" cho dữ liệu đã đóng băng.
