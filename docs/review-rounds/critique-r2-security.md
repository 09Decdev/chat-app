# Critique R2 (lens Security) — fix E2 loadtest connect-fail

**Vai trò**: Application Security Engineer — cố bác diff `main...HEAD` (T1 4e05426 · T2 c470b56 · T3 f8248a2 · T6 9eaa9d8), branch `fix/loadtest-e2-connect-fail`.
**Trạng thái**: mọi claim đối chiếu code thật (đã đọc socket-farm.ts, coordinator-state.ts, coordinator.ts, api-mappers.ts, LiveDashboardPage.tsx, connect-fail.ts, toàn bộ diff + test mới). Sanitizer (F-2/F-3/F-4/F-5) thuộc T4 — **KHÔNG có trong branch này**; window override rate thuộc T5 — **KHÔNG có trong branch này**.

---

## Finding SỐNG

### S-1 [MED-HIGH] — T6 dashboard connect-fail hiển thị "0.0% xanh" + "Không có connect fail" MÃI MÃI trên branch này — dữ liệu chết, đúng class F-8 "khỏe giả" mà F-8 đã chấp nhận giảm thiểu

- **Vị trí**: `loadtest/socket-farm.ts:727-733` (emitTick chỉ set `connectAttempts/connectFails`, KHÔNG bao giờ sum `connectFailsByType` từ user runtimeStats → worker counter bằng 0 vĩnh viễn) · `loadtest/coordinator-state.ts:289` (`rates.connectFailRate: 0` hardcode, T5 sẽ override trước pushTick — chưa có) · `src/pages/loadtest/LiveDashboardPage.tsx:301` (tile) + `:169-266` (ConnectFailBreakdown) · `src/components/loadtest/connect-fail.ts:32-39` (connectFailVariant).
- **Vấn đề**: Trên branch hiện tại, MỌI tick live có `connectFailsByType` = toàn 0 và `connectFailRate` = 0 — ngay cả khi gateway đang đánh sập toàn bộ connect. Hệ quả trên UI T6: tile luôn "0.0%" `variant success` (xanh) khi `attempts > 0`; card luôn nhánh `totalFails === 0` → **"Không có connect fail trong run này"**; danger strip (D5) không bao giờ bật; trong khi E2 auto-stop (coordinator.ts:534-549) vẫn có thể dừng run ngay cạnh đó. Đây chính là "0% = khỏe giả" mà F-8 (LOW) đã chấp nhận giảm thiểu bằng "variant default khi attempts==0" — nhưng mitigation đó chỉ chạy khi attempts==0; attempts > 0 + rate hardcode 0 → vẫn xanh. Test cũng bỏ lọt: `coordinator-state.test.ts:93-94` **tự ghi chú** "T5 override trước pushTick — aggregate trả 0", `socket-farm.test.ts:179` chỉ assert `runtimeStats.connectFailsByType.other === 5` (stat per-user, không assert tick counter) — wiring chết được test hóa thành "hành vi đúng".
- **Vì sao nguy hiểm**: telemetry sai lệch theo hướng an toàn giả là attack surface vận hành: operator chạy run đo gateway lỗi được dashboard xác nhận "sạch" trong khi cơ chế an toàn E2 đang bắn — quyết định điều hành (tắt E2, kết luận "hệ thống khỏe", đổ lỗi auto-stop sai) dựa trên dữ liệu không bao giờ đúng. F-8 nói "giảm thiểu MVP" — nhưng giảm thiểu đã implement KHÔNG đạt hiệu quả vì thiếu dữ liệu, không phải vì thiếu UI.
- **Fix**: (a) T5 (override window rate trước pushTick) + T4 (sum byType trong emitTick) PHẢI nằm trong cùng merge với T6 — nếu không, T6 là dead UI; (b) chống tái phát "0 giả": thêm field `connectWindowAttempts` (đúng đề xuất v1.1 của F-8) và cho tile `variant 'default'`/hiển thị "chưa đủ mẫu" khi `windowAttempts < 50` — KHÔNG cho 'success' xanh khi dữ liệu là 0 do không-wiring; (c) test integration-level: fake tick từ worker → assert byType phi-zero lọt được tới store/UI.

### S-2 [MED] — Phase 'failed' KHÔNG terminal: handler 'connect' thiếu guard `phase === 'failed'` → cap 5 (F-1) bị bypass theo chu kỳ bởi gateway flip-flop

- **Vị trí**: `loadtest/socket-farm.ts:141-151` (handler `connect` — không có guard failed, không có comment; trái ngược 3 guard có chủ đích ở `connect_error` :162, `disconnect` :155, `ensureChatCycle` :378, action loop :581).
- **Vấn đề**: `connect_error` :170-182 cắt user sang `phase='failed'` + `disconnect()` + `reconnection(false)` — nhưng nếu sự kiện `connect` về sau (connect attempt đã in-flight trước cutover, hoặc bất kỳ code path tương lai nào gọi lại `connect()` — hiện `connectStarted` monotonic nên chưa có, nhưng đó là giả định mỏng), handler :141-151 chạy KHÔNG kiểm tra phase → gán `phase='connected'/'in_room'`, `everConnected=true`, **`consecutiveConnectFails=0`** → chu kỳ cap khởi động lại từ đầu. Gateway thù địch (đúng mô hình attacker = "nguồn dữ liệu lạ" đã chốt ở critique R1) có thể: reject 5 → accept 1 (resurrect) → reject 5 → … lặp vô hạn → `connectFails` **không còn bounded 5/user** (đảm bảo cốt lõi của F-1: "1 user hỏng sinh TỐI ĐA 5 fail"), `usersFailed` dao động 0/N (metric integrity), counter tăng không chặn.
- **Vì sao nguy hiểm**: F-1 là fix chống E2 false-positive — đảm bảo số học "cohort hết hạn = 20% < 30%" dựa trên tiền đề "mỗi user tối đa 5 fail". Tiền đề đó chỉ đứng khi 'failed' là terminal bất khả xâm phạm; một 'connect' muộn phá tiền đề mà không ai bắt được (không test nào cover). Đây là defense-in-depth gap của chính cơ chế an toàn, không phải bug tưởng tượng: chi phí fix 1 dòng.
- **Fix**: đầu handler `connect` thêm `if (this.phase === 'failed') return;` (hoặc cờ `retired: boolean` vĩnh viễn — không reset khi reconnect). Thêm test: simulate connect sau failed → phase giữ 'failed', counters không tăng.

### S-3 [MED-HIGH] — F-2 vẫn SỐNG và T3 THÊM sink ghi mới không sanitize, không cap (line 181)

- **Vị trí**: `loadtest/socket-farm.ts:163` (`this.lastError = `connect_error: ${err.message}`` — sink có sẵn) **+ :181 MỚI trong T3**: `this.lastError = `${this.lastError} | failed sau 5 connect_error liên tiếp (ngừng reconnect)`` — nối thẳng err.message thô, không sanitize, KHÔNG cap length.
- **Vấn đề**: `lastError` → `toRow()` :446 → GET /users (routes/run.ts:104-117) → UsersPage.tsx:148-157 (bảng operator đọc). err.message do gateway điều khiển (middleware `next(new Error(text))` / engine.io error). Control chars (`\n` — chèn hàng giả vào bảng/export tương lai), secret/URL-credential do gateway echo lại, và payload lớn: không có `slice` nào (recordError có `slice(0,160)` :694 — lastError thì không) → 1 err.message 1MB × N user = response /users phình. F-2 đã chốt sanitize tại lúc gán (T4) — nhưng **T4 chưa nằm trong branch này, còn T3 đã thêm 1 sink mới vào chính đúng nơi F-2 chỉ định** → mức độ phơi nhiễm của branch hiện tại lớn hơn main (2 sink write thay vì 1).
- **Vì sao nguy hiểm**: đây là sink thật (đã xác minh R1: chat:error là kênh gateway-controlled hiện hữu, connect_error chỉ tới khi server chủ động trả text). T3 thay đổi code chạm trực tiếp sink này mà không kèm sanitize — vi phạm nguyên tắc "sửa sink đúng chỗ ngay khi chạm".
- **Fix**: (a) T4 phải nằm trong merge này, hoặc tối thiểu: gán lastError bằng 1 hàm `sanitizeLogText(raw, 160)` ngay từ bây giờ (tách file `loadtest/sanitize.ts` theo DESIGN mục 3 — dùng luôn cho T4); (b) cap length 160 tại mọi điểm gán lastError.

### S-4 [LOW-MED] — Residual F-4: field `code` không cap + `errorCounters` Map key phân biệt KHÔNG giới hạn → gateway bơm N code lạ = tick/report phình, T4 dự kiến chỉ cap length không chặn số lượng

- **Vị trí**: `loadtest/socket-farm.ts:215-218` (`chat:error` — `p.code` gateway-controlled → `onError` → recordError) · `:692-695` (`recordError`: chỉ `message.slice(0,160)`, code KHÔNG slice; `errorCounters.set(code, …)` — Map vô hạn key) · `:761` (tick `errors: Object.fromEntries(this.errorCounters)` serialize TOÀN BỘ map mỗi giây) → coordinator-state errors → TOP ERRORS + report.ts:66-73 + saveReportFiles (report JSON/md/CSV trên đĩa).
- **Vấn đề**: không do diff này tạo ra (pre-existing), nhưng T6 mở rộng bề mặt đọc (TOP ERRORS + breakdown cùng cột) và T4 trong kế hoạch chỉ "sanitize + cap 64 cho code" — **cap length không chặn vô hạn key**: gateway gửi 10.000 code ngẫu nhiên khác nhau → map 10.000 entry → payload tick/giây tăng dần, report file phình, memory worker tăng — DoS tài nguyên thấp cường độ, dài hạn.
- **Vì sao nguy hiểm**: report file là sink được tải/share (F-4 đã chốt) — dữ liệu lạ từ mục tiêu đo vào báo cáo chính thức; và đây là vector "gateway = nguồn dữ liệu lạ" duy nhất còn lại chưa có biện pháp nào trong toàn bộ kế hoạch.
- **Fix**: thêm cap số lượng: `MAX_ERROR_CODES = 50` — khi vượt, chỉ đếm bucket 'OTHER' hoặc evict key cũ (LRU); hoặc chặn ở nguồn: `code.slice(0,64)` + chỉ đẩy vào map khi code khớp allowlist regex `[A-Z0-9_]{1,64}`.

---

## Đã xác minh ĐÚNG (không bác được)

1. **F-1 cap 5 áp MỌI user (kể cả everConnected)** — `socket-farm.ts:170-182`: điều kiện chỉ `consecutiveConnectFails >= 5`, KHÔNG còn nhánh `!everConnected`. `everConnected` (:76, :146) giờ chỉ là trạng thái tham chiếu, không gate cap. Reset streak đúng chỗ (:146). Test `socket-farm.test.ts:179` assert `byType.other === 5` + phase failed.
2. **Counter bounded (ngoài trừ S-2)**: connect_error handler early-return khi failed (:162); disconnect giữ phase failed (:155-158); action loop (:581) + ensureChatCycle (:378) skip failed → 1 user sinh tối đa 5 fail; `usersFailed` đếm đúng 1 lần/user (emitTick :716, phase terminal). Số học E2: full outage 500 user = 2500 fails/2500 attempts = 100% → stop đúng; cohort token hết hạn 500/10k = 2500/(10000+2500) = 20% < 30% → không false-positive (khớp DESIGN §5.1).
3. **Window T2 an toàn**: `rollWindow` evict theo wall-clock age + safety cap 120 bucket (:122-135); `diffConnectWindowEntry` clamp `max(0, …)` chống rate âm giấu outage (:95-113); `sumWindow`/`connectFailRateFromWindow` thuần túy, M2 gate 50 attempts — không có path âm/tràn (number JS, tổng tối đa ~120 bucket × counters — bounded).
4. **UI chỉ render số + nhãn tĩnh**: tile/breakdown/donut/aria-label chỉ số đếm và label cố định (`connect-fail.ts` CONNECT_FAIL_LABELS tĩnh); không có message/token/URL từ error chạm dashboard qua T3/T6; `grep dangerouslySetInnerHTML` toàn src: **0 hit** → không vector XSS mới; `toFixed`/`?? 0` guard giá trị lạ (NaN không truyền được qua JSON).
5. **Auth KHÔNG bị đụng**: `git diff main...HEAD --name-only` — 0 thay đổi ở `loadtest/auth.ts`, `loadtest/guards.ts`, `loadtest/api-server.ts`, `src/lib/loadtest-api.ts`. T6 dùng route dashboard có sẵn, không mở endpoint mới; `hasConnectData` là field hiển thị (cosmetic) — không tham gia quyết định an toàn nào.
6. **Secret scan diff**: 1779 dòng diff — 0 pattern (JWT/hex-40/token 2-part/Bearer/key=value/refreshToken). Không file config/.env mới trong diff.
7. **Bảo mật dữ liệu cũ không regress**: recordError vẫn slice message 160 + errorSamples cap 20 (:694-695); outbox/histogram không đổi.

---

## Residual notes (không tính finding của diff này — ghi nợ)

- **E2 blind với disconnect-churn**: gateway accept rồi disconnect ngay → 'connect' + 'disconnect' (reconnectCount++), KHÔNG connect_error → rate luôn 0 → E2 không bao giờ bắn dù 0 user thực sự kết nối. Pre-existing semantics (E2 đo connect_error, không đo churn) — không phải regression của diff; ghi chú v1.1 (đếm "accept-then-drop" vào window).
- **F-6 debt** (users_accounts.json/accounts-*.json chứa refreshToken 10k user): đúng R1 — gate gitleaks + move-out + rotate PHẢI trong cùng release window, không "pre-flight sau".

---

## Kết luận

**4 finding SỐNG** (S-1 MED-HIGH · S-2 MED · S-3 MED-HIGH · S-4 LOW-MED). **3 nghiêm trọng nhất**:
1. **S-1** — T6 dashboard connect-fail là dead UI trên branch này (rate hardcode 0 + byType không bao giờ sum từ worker) → "khỏe giả" xanh vĩnh viễn, đúng class F-8; T4/T5 phải nằm cùng merge, không thể tách vòng.
2. **S-3** — F-2 chưa fix mà T3 còn thêm sink ghi lastError mới không sanitize/không cap — chạm đúng sink F-2 chỉ định, phải xử lý trong vòng này.
3. **S-2** — phase 'failed' không terminal (thiếu guard ở handler 'connect') → đảm bảo "max 5 fail/user" của F-1 có thể bị vô hiệu bởi gateway flip-flop — fix 1 dòng.

**Verdict security**: phần lõi fix E2 (cap F-1, window T2, bound counter) đứng vững trước phản biện. Nhưng branch này KHÔNG được merge với T6 khi thiếu T4+T5 — dữ liệu connect hiển thị sai theo hướng nguy hiểm (khỏe giả), và sink lastError phơi nhiễm rộng hơn main. Đề xuất: sáp nhập T4 (sanitizer + classify) và T5 (window override) vào trước gate merge, hoặc cắt T6 khỏi branch.
