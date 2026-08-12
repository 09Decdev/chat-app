# Critique (lens Security) — design council fix bug E2 connect-fail

**Vai trò**: Application Security Engineer — phản biện 3 đề xuất (backend / security / UI) + tìm attack surface mới.
**Trạng thái**: SẴN SÀNG CHO COUNCIL — mọi claim đã đối chiếu code thật.

---

## A. Trả lời trực tiếp các câu hỏi được giao

### A1. Kẻ tấn công chính có thật là "gateway" không? (proposal-security §1)

**ĐÚNG CHO 2 VECTOR, OVERSTATED CHO 1 VECTOR**:

- **Đúng**: (1) gateway ép connect fail → auto-stop DoS — bản chất auto-stop, fix window+threshold làm giảm đúng hướng; (2) nội dung do gateway gửi lọt vào log/dashboard — vector thật (xem A3).
- **Overstated**: premise "gateway kiểm soát nội dung `connect_error` message" yếu. `socket-farm.ts:121-133` dùng `transports: ['websocket']`; gateway `client.disconnect()` (websocket.gateway.ts:150-164, 179-185) KHÔNG gửi error packet kèm text → client engine.io nhận generic `"websocket error"`/`"timeout"` — PRD §6.1 tự thừa nhận. Custom text chỉ tới client khi server middleware `next(new Error(text))` — gateway hiện không làm.
- **Kênh gateway-controlled THẬT đang tồn tại hôm nay, proposal-security BỎ QUÊN**: `chat:error` handler `socket-farm.ts:192-195` — `p.code` và `p.message` DO GATEWAY ĐIỀU KHIỂN hoàn toàn, đi thẳng vào `lastError` + `recordError` → errorSamples → dashboard. Đây là kênh đáng sanitize gấp hơn connect_error.

**Verdict**: giữ mức Trung bình cho log-injection (đúng), nhưng sửa mô hình kẻ tấn công: gateway = "nguồn dữ liệu lạ", không phải "attacker có chủ đích" — mọi biện pháp phải tập trung ở **sink**, không ở giả định về nội dung message.

### A2. ST-1..12 thiếu case nào?

| Thiếu | Vì sao |
|---|---|
| **Kênh `chat:error`** (socket-farm.ts:192-195) — không có ST nào | Đây là kênh gateway-controlled hiện hữu, dễ injection hơn connect_error |
| **Field `code`** (không slice, không sanitize — socket-farm.ts:663 chỉ slice `message`) | arbitrary length + control chars vào errorSamples.code + errors map → TOP ERRORS + **report file** |
| **Log path newline** — ST-6 chỉ test errorSamples; T4 log verbose err qua `redactMsg` (không strip control chars) → ring buffer/console/DB bị chèn dòng giả | ST-10 chỉ assert "không chứa token/Authorization", không assert "không chứa newline" |
| **Sink `lastError`** (socket-farm.ts:156, 193 → toRow :418 → GET /users) | Ngoài scope S5 → bảng users nhận message thô không qua sanitize |
| **Report file sink** (report.ts:66-73 + saveReportFiles coordinator.ts:653) | `code` lọt vào report JSON/md/CSV tải về + summary_json DB |
| **Bypass regex**: `access_token=`, `apiKey=`, `jwt=`, `sid=`, hex-40 token, token 2-part (session format auth.ts:40-42) | ST-6 chỉ test `eyJ...` trần + `user:pass@host` |
| **ST-12 có thể pass trivially**: mock gateway dùng server disconnect (như gateway thật) thì client nhận `"websocket error"` generic, không phải message độc — test phải dùng middleware `next(new Error('độc'))` mới phản ánh đúng vector | Ngược lại: nếu mock gửi custom text qua packet, phải xác minh socket.io-client transports websocket có truyền được text đó qua connect_error hay không — nếu không, test sai kỹ thuật |

### A3. Sanitizer (strip control chars + redactUrl + regex JWT trần) có đủ không?

**KHÔNG ĐỦ — 3 lỗ hổng**:

1. **Scope thiếu sink**: S5 chỉ áp ở `recordError`. `lastError` (F-2), `code` field (F-4), log path (F-3) không được phủ.
2. **Bypass regex** (F-5): `redactMsg` (logger.ts:130-133) chỉ bắt key ∈ {password,passwd,pwd,token,secret,otp,authorization,refreshToken} đi sau `[=:]` — `access_token=` (không có word boundary trước `token` do `_`), `apiKey=`, `jwt=`, `sid=`, `session_id=` đều lọt. Regex JWT 3-part `eyJ[a-zA-Z0-9_-]+\.` KHÔNG bắt: token 2-part (chính là format session token `body.sig` — auth.ts:40-42), token hex-40, token base64url có padding. `redactUrl` (logger.ts:80-88) chỉ đụng `user:pass@host`, không đụng query params.
3. **Control chars chỉ strip ở errorSamples**, không strip ở `redactMsg` chung → log path vẫn injectable (F-3).

**Kết luận**: sanitizer phải là 1 hàm chung áp ở MỌI sink: `recordError` (message + code), `lastError` (lúc gán socket-farm.ts:156/193), và `redactMsg` (logger.ts) — thêm strip `[\x00-\x1f\x7f]` + regex JWT + key=value mở rộng.

### A4. Quyết định "KHÔNG đưa users_accounts.json vào scope" — ổn không?

**Đồng ý defer VỀ THỨ TỰ (không chặn fix E2), nhưng lập luận "gitignore + chưa commit → không có vector leak qua repo" là SAI** (F-6): gitignore không phải security control. Đã xác minh bằng lệnh: file đúng là gitignore + `git ls-files` sạch — nhưng vector leak thật là: `git add -f`, zip/backup cây repo, copy thư mục sang VPS host tool, indexer/IDE, OneDrive/backup sync trên máy Windows này. **Rủi ro thật nằm ở `loadtest/data/accounts-*.json` (đã du: 14MB × 2 file) chứa `accessToken` + `refreshToken` dài hạn của 10k user production** — crown jewel, account takeover nếu lộ. Defer bắt buộc kèm: move-out khỏi cây repo + gate CI (gitleaks + `git ls-files` grep) trong **cùng release window**, không phải "pre-flight sau".

---

## B. Findings (theo độ nghiêm trọng)

### F-1 [HIGH] — proposal-backend (T3) / proposal-security (S4): cap-retry chỉ áp user CHƯA TỪNG connected → cohort token hết hạn giữa run = fail vô hạn → E2 false-positive TÁI XUẤT HIỆN đúng class bug đang sửa

- **Proposal**: proposal-backend §4.1 (T3) — "User ĐÃ TỪNG connected → giữ nguyên retry vô hạn + đếm (lỗi transient hệ thống là fail thật)"; proposal-security S4 đồng thuận.
- **Vị trí**: socket-farm.ts:129-133 (`reconnectionAttempts: Infinity`), :137-145 (connect → `everConnected = true`), :155-160 (đếm MỌI connect_error).
- **Vấn đề**: Token TTL 1h (gateway token.provider.adapter.ts:17-22), run ≤ 60 phút (config.ts:306-309). User connected lúc t=0, token hết hạn t=45', network hiccup/room kick/gateway restart (PRD §2 #2 — chính root cause #2 của PRD) → reconnect với token stale → gateway `client.disconnect()` → connect_error vĩnh viễn. Vì `everConnected = true`, T3 KHÔNG cap → mỗi user sinh ~10 fail/60s cho ĐẾN HẾT RUN. Tính: 500/10k user hết hạn × 10 fail/60s = 5.000 fails / (10.000 healthy attempts + 5.000) = **33% > 30% → E2 dừng run KHỎE MẠNH** — y hệt dáng dấp 41% đang sửa. Cửa sổ 60s KHÔNG cứu vì lỗi này là vĩnh viễn, không phải transient: rate window kẹt ≥ 30% từ khi user hết hạn đến cuối run.
- **Tại sao nguy hiểm**: fix này vô hiệu với nguyên nhân gốc #2 mà chính PRD liệt kê là "khả năng cao"; sự cố 41% lặp lại đúng class. PRD §6.3 giả định "cap retry + phase failed" đủ xử lý expiry — giả định sai vì cap chỉ nhắm never-connected.
- **Bằng chứng code**: socket-farm.ts:129-133, :137-145, :155-160; proposal-backend §4.1; PRD §2 #2 + §6.3.
- **Severity**: **HIGH** — vì là lỗ hổng false-positive của chính fix, với kịch bản hiện hữu (30-60 phút run, hiccup mạng thật).
- **Fix rẻ, KHÔNG phá AC**: áp cap 5 consecutive fail cho MỌI user (cả everConnected). Số học AC-1 (2.500/12.500 = 20,8%) và AC-2 (50k/50k = 100%) KHÔNG đổi — vì AC-2 dùng user chưa từng connected. Các test T3 (2) "everConnected user fail → retry + đếm" phải đổi thành "bounded retry + đếm đến cutover". Chi phí duy nhất: outage thật > 5 retry làm user chuyển failed — nhưng outage thật 60s+ với ≥ 50 attempts thì E2 stop cả run, không mất gì.

### F-2 [MEDIUM-HIGH] — proposal-security S5: sink `lastError` không được phủ bởi sanitizer

- **Proposal**: proposal-security S5 ("sanitizer chung cho MỌI message trước khi vào errorSamples... Áp dụng ở `recordError`") — chỉ bám recordError.
- **Vị trí**: socket-farm.ts:156 (`this.lastError = \`connect_error: ${err.message}\``), :193 (chat:error — `p.code`/`p.message` gateway-controlled), :418 (`toRow()` xuất lastError), routes/run.ts:104-117 (GET /users), UsersPage.tsx:148-157 (render `row.lastError`).
- **Vấn đề**: message gateway-controlled đi vào bảng users KHÔNG qua bất kỳ sanitize nào — kể cả sanitizer S5 có implement đúng cũng không chạm sink này. Gateway buggy (vd echo token trong error text) → JWT/URL-credential/control-char vào API payload + UI. React escape chặn XSS (đã grep: không có `dangerouslySetInnerHTML` trong src), nhưng đây là đường leak dữ liệu không cần XSS: bảng users là chỗ operator đọc "Lỗi gần nhất" — attacker/gateway nhét text độc hoặc secret vào đây để đánh lừa hoặc rò rỉ qua màn hình/export tương lai.
- **Bằng chứng**: socket-farm.ts:156, 193, 418; routes/run.ts:104-117; UsersPage.tsx:148-157.
- **Severity**: **MEDIUM-HIGH** (sink thật bị bỏ sót; fix rẻ — sanitize tại lúc gán lastError hoặc tại toRow()).

### F-3 [MEDIUM] — Log injection VẪN SỐNG trên đường LOG (T4 verbose + relay worker→coordinator)

- **Proposal**: proposal-security 2.4 + S5 (chỉ fix errorSamples); proposal-backend §4.2 ("Log raw err (redact — logger.ts:90-135) khi verbose").
- **Vị trí**: logger.ts:127-135 `redactMsg` (KHÔNG strip control chars), :256 (format text ring buffer), coordinator.ts:399 (relay `worker#${workerId}: ${msg.msg}` qua ltLog).
- **Vấn đề**: T4 log `err.message` khi verbose → `redactMsg` chỉ replace key=value, không strip `\n`/`\x00` → message chứa `\n[lt][ERROR][09:00:00.000] forged` chèn dòng giả vào: ring buffer text (logger.ts:256) → GET /logs (routes/run.ts:124-127, auth) + console + subscriber → DB `log_events` (writer.ts:206). Đánh lừa operator, làm hỏng log ingestion, giả mạo cảnh báo E1/E2/E3.
- **Tại sao nguy hiểm**: chính vector log-injection proposal-security claim đang chặn — nhưng fix đặt sai sink. JSONL sink an toàn (JSON.stringify escape) — đúng, nhưng ring buffer/console/DB không phải JSON.
- **Bằng chứng**: logger.ts:127-135, 256; coordinator.ts:399; writer.ts:206.
- **Severity**: **MEDIUM**. Fix: strip `[\x00-\x1f\x7f]` ngay trong `redactMsg` (mọi sink được lợi) + ST mới assert dòng log không chứa newline.

### F-4 [MEDIUM] — Field `code` không slice, không sanitize — gateway nhét arbitrary content vào errorSamples + errors map + REPORT FILE

- **Proposal**: proposal-security S5 (chỉ đề cập message), ST-6 (chỉ test message); proposal-backend §4.2 (chỉ lưu ý message ngắn).
- **Vị trí**: socket-farm.ts:192-195 (`chat:error` — p.code gateway-controlled), :661-665 `recordError` — `message.slice(0,160)` NHƯNG `code` KHÔNG slice; coordinator-state.ts:129 (errors map), :154-157 (topErrors); report.ts:66-73 (errors từ tickHistory); coordinator.ts:653 (saveReportFiles) + routes/run.ts:136-152 (export JSON/md/CSV).
- **Vấn đề**: `code = 'chat:' + p.code` đi thẳng vào: errorSamples.code (không cap length, không strip control), errorCounters key (Map), tick.errors → TOP ERRORS (LiveDashboardPage.tsx:312 render), **report files trên đĩa** (docs/loadtest-reports — trong cây repo) + JSON/CSV export + DB summary_json/metric_samples.errorsJson. Gateway có thể nhét: code 1MB (memory/JSON bloat per tick), `\n` (phá bảng/report), hoặc credential-text.
- **Tại sao nguy hiểm**: sink REPORT FILE bị proposal bỏ sót hoàn toàn — report là thứ được tải về/share; dữ liệu lạ từ mục tiêu đo vào báo cáo chính thức.
- **Bằng chứng**: socket-farm.ts:192-195, 663; report.ts:66-73; coordinator.ts:653; LiveDashboardPage.tsx:75-78 (render `${s.action} · ${s.message}` — message hiện đã hiển thị trong dialog "TẤT CẢ LỖI").
- **Severity**: **MEDIUM**. Fix: sanitize + cap length cho CẢ code lẫn message tại recordError.

### F-5 [MEDIUM] — Sanitizer regex bị bypass: `access_token=`, `apiKey=`, `jwt=`, `sid=`, hex-40, token 2-part

- **Proposal**: proposal-security S5 + ST-6.
- **Vị trí**: logger.ts:130-133 (key=value regex), logger.ts:80-88 (redactUrl), S5 JWT regex 3-part.
- **Vấn đề**: (1) `access_token=eyJ...` — `\b` không đứng trước `token` trong `access_token` (dấu `_` là word char) → KHÔNG match key=value regex; (2) `apiKey=abcdef0123...` (hex-40) — không trong list key, không phải JWT 3-part → lọt; (3) token 2-part `base64url.base64url` — đúng format session token auth.ts:40-42 — regex 3-part không bắt; (4) `https://host/x?jwt=...` — redactUrl chỉ đụng `user:pass@host`; (5) JWT bắt đầu không bằng `eyJ` (header không phải `{"alg`) — bỏ.
- **Tại sao nguy hiểm**: sanitizer tạo cảm giác an toàn giả (false confidence) — đúng tinh thần "fix không hoạt động còn tệ hơn không fix". Với JWT trong message thì regex bắt phần lớn (eyJ...), nhưng secret dạng hex/session token 2-part thì không.
- **Bằng chứng**: logger.ts:130-133, 80-88; auth.ts:40-42.
- **Severity**: **MEDIUM**. Fix: JWT regex không bắt buộc prefix `eyJ` (`[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}`), key list thêm `access_token|api[_-]?key|jwt|sid|session|sig`, thêm pattern hex ≥ 32, + unit test từng bypass.

### F-6 [MEDIUM] — Quyết định defer users_accounts.json: lập luận "gitignore = không có vector leak" sai; pool refreshToken là crown jewel

- **Proposal**: proposal-security §4.
- **Vị trí**: repo root `users_accounts.json` (gitignore OK — đã verify `git check-ignore` + `git ls-files` sạch), `loadtest/data/accounts-*.json` (đã du: 14MB × 2 — accessToken + refreshToken), `loadtest/data/auth-secret.json`.
- **Vấn đề**: gitignore không phải security control — `git add -f`, zip/backup cây repo, copy sang VPS host tool, IDE/indexer, backup-sync (máy Windows này có thể sync OneDrive/Dev Drive) đều mang file đi. Claim "không có vector leak qua repo" sai ở chỗ repo ≠ git. Defer về THỨ TỰ thì ổn (không chặn fix E2), nhưng đây là debt bảo mật nghiêm trọng nhất của toàn bộ pipeline đo: refreshToken 10k user production = account takeover toàn diện (không cần reset, không thể revoke hàng loạt nhanh).
- **Bằng chứng**: `git check-ignore users_accounts.json loadtest/data/accounts-*.json` → khớp; `du -sh` → 14M × 2; proposal-security §4 (tự xác nhận nội dung file).
- **Severity**: **MEDIUM** (rủi ro tiềm tàng cao, nhưng chưa có dấu hiệu lộ — defer chấp nhận được nếu gate + move-out + rotate trong cùng window release, KHÔNG để "pre-flight sau").

### F-7 [LOW] — proposal-backend: log E2 trộn 2 gốc thời gian (window vs cumulative) trong 1 dòng

- **Proposal**: proposal-backend §3.3 + §8.5 (tự nhận, không fix).
- **Vị trí**: log E2 format (`windowAttempts/windowFails/byType` = window 60s; `usersFailed/workers` = cumulative).
- **Vấn đề**: script grep/log-monitor tính lại rate từ `windowFails/windowAttempts` sẽ đúng, nhưng ai tính từ `usersFailed` sẽ sai; operator đọc nhầm "450 user failed" thành "trong window" → kết luận E2 sai → có thể đề nghị tắt E2. Hậu quả gián tiếp là quyết định vận hành sai trên cơ chế an toàn.
- **Bằng chứng**: proposal-backend §3.3 (bảng 8 trường).
- **Severity**: **LOW** — fix rẻ: thêm `usersFailedWindow` (delta) hoặc tách 2 dòng log.

### F-8 [LOW] — proposal-ui: "0% khi window < 50 attempts" hiển thị success xanh → operator tin hệ thống khỏe khi CHƯA CÓ DỮ LIỆU

- **Proposal**: proposal-ui §4 (variant: `< 5 → success`; hint chỉ là tooltip).
- **Vị trí**: LiveDashboardPage KPI "Connect fail" (proposal-ui §4), T2/T5 `connectFailRate = 0` khi chưa đủ mẫu.
- **Vấn đề**: đầu ramp (vài giây đầu, ramp thấp) và DB-replay (R1 — luôn 0) hiển thị "0.0%" xanh = "khỏe" trong khi thực chất N/A. Operator chạy run dài với gateway lỗi sẽ được dashboard xác nhận "khỏe mạnh" cho tới khi đủ 50 attempts — cửa sổ mù kéo dài tỉ lệ với ramp thấp (ramp 50/s → 1s; ramp 5/s → 10s; DB replay → vĩnh viễn). Breakdown/attempts/email/token: **an toàn** — toàn số, không message text, không JWT (đã xác minh proposal-ui không thêm field text); claim "oracle cho attacker" bị bác (cần auth operator, thông tin tương đương có sẵn qua /status + /metrics — xem Ref-3).
- **Bằng chứng**: proposal-ui §2 (contract), §4 (variant), §7 (replay); T2 `connectFailRateFromWindow` trả 0 khi attempts < 50.
- **Severity**: **LOW**. Fix: thêm field `connectWindowAttempts` vào contract T1 (đề xuất ngay v1.1, không đợi) để UI hiển thị trạng thái "insufficient" thay vì "success"; hoặc tối thiểu `variant` mặc định `default` khi `connectAttempts === 0` (đã làm) — nhưng còn case attempts > 0 mà window < 50 thì vẫn xanh.

---

## C. Phát hiện mới ngoài 3 proposal (tổng hợp)

1. **F-2 lastError sink** — không nằm trong S1-S7 nào của proposal-security.
2. **F-3 log path newline** — S5 đặt sai sink; cần strip control chars ở `redactMsg` chung.
3. **F-4 code field** — chưa ai (kể cả T4) đề cập sanitize `code`; report file là sink bị bỏ sót.
4. **F-5 bypass regex** — ST-6 không cover; cần unit test từng bypass.
5. **F-1 (nguy hiểm nhất)**: everConnected retry vô hạn — thứ mà cả 3 proposal cùng chốt ("giữ retry vô hạn cho user đã connected") là lỗ hổng false-positive còn sót, đúng root-cause #2 của PRD.
6. Đã loại: `/metrics` Prometheus không auth (api-server.ts:71-75) — pre-existing, host 127.0.0.1 default, chỉ gauge tool; ghi chú, không phải finding của fix này.

---

## D. Finding SỐNG (tự bác nội bộ các finding yếu của chính critique)

1. **BÁC — "Diff-window attempt-inflation khi restart churn che outage thật"**: worker chết → restart → counter reset → guard base=0 (proposal-backend §3.2) → delta = cumulative mới. Khi gateway DOWN, user mới fail ngay tick đầu → fails đếm đủ → rate phản ánh thực tế trong ~1-2s; khi gateway UP, inflation attempts làm rate giảm — đúng (không có outage để che). E3 cover toàn bộ chết. Không phải finding.
2. **BÁC — "Breakdown là oracle cho attacker"**: cần session operator (auth HMAC — auth.ts:33-67, guards.ts:15-27); mọi thông tin về run đã có sẵn qua /status + /metrics (auth); breakdown chỉ là chi tiết hóa có chủ đích của observability — không phải thông tin mới.
3. **BÁC — "`/metrics` Prometheus unauth = finding"**: pre-existing (api-server.ts:71-75), không nằm trong thay đổi MVP, host mặc định 127.0.0.1 (config.ts:169), chỉ gauge tool (rssMb/worker.alive/restarts) không chứa run data. Ghi chú cho v1.1, không phải finding của fix E2.

---

## E. Kết luận

- **Số finding sống: 8** (1 HIGH · 5 MEDIUM/MEDIUM-HIGH · 2 LOW).
- **3 nghiêm trọng nhất**:
  1. **F-1 (HIGH)** — T3 giữ retry vô hạn cho user đã connected → cohort token hết hạn giữa run (root cause #2 PRD) sinh fail vô hạn → E2 false-positive tái xuất hiện; fix rẻ (cap 5 mọi user) không phá AC-1/AC-2.
  2. **F-2 (MEDIUM-HIGH)** — sink `lastError` không được sanitize: message gateway-controlled (connect_error + chat:error) vào bảng users qua GET /users.
  3. **F-3/F-4 (MEDIUM)** — log-injection sống trên đường LOG (redactMsg không strip control chars) và field `code` không slice → gateway nhét content tùy ý vào errorSamples/TOP ERRORS/report files.

**Yêu cầu tối thiểu trước khi council chốt**: (a) T3 cap retry mọi user; (b) 1 hàm sanitize chung (strip control + redactUrl + JWT regex không prefix eyJ + key list mở rộng + cap length cả code lẫn message) áp ở recordError + lastError + redactMsg; (c) ST mới: chat:error code, log newline, bypass regex từng loại, lastError, report file.
