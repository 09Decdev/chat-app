# Threat Model & Yêu cầu Bảo mật — Fix E2 loadtest connect-fail (MVP M1-M8)

**Nguồn**: `docs/PRD-loadtest-e2-connect-fail.md`, `docs/PLAN-loadtest-e2-connect-fail.md`
**Tác giả**: Security Architect (design council autobuild)
**Trạng thái**: Đề xuất — CHỈ thiết kế, không code

---

## 1. Phạm vi & mô hình kẻ tấn công

Thành phần được phân tích: loadtest tool (coordinator + socket-farm workers + HTTP API). Đây là công cụ **self-hosted, điều khiển qua API có auth** (`loadtest/auth.ts`, `loadtest/guards.ts`, `loadtest/api-server.ts:78-105`), host mặc định `127.0.0.1` (`loadtest/config.ts:169`).

**Thứ bậc tin cậy**:

| Actor | Tin cậy | Lý do |
|---|---|---|
| Operator (admin có session token HMAC — auth.ts:33-67) | Tin cậy hoàn toàn | Có quyền start/stop/kill — đã là root của tool |
| **Gateway đang test (system under test)** | **KHÔNG tin cậy** | Là mục tiêu đo; kẻ xấu/buggy có thể điều khiển kết quả handshake ws + nội dung `connect_error` packet |
| Người ngoài mạng (truy cập API không auth) | Không tin cậy | Bị chặn bởi auth + rate limit (api-server.ts:223-244); host 127.0.0.1 mặc định |
| Worker child process | Tin cậy (local IPC) | Không có vector remote tới IPC |

**Kết luận quan trọng**: kẻ tấn công chính của MVP là **gateway đang test** (mục tiêu bị đo) và **dữ liệu lạ đi qua đường ống đo** — không phải operator. Mọi biện pháp dưới đây nhắm vào: (1) gateway không được phép làm tool tự dừng nhầm HOẶC giấu sự cố thật; (2) nội dung do gateway kiểm soát (error message) không được phép lọt vào log/dashboard dưới dạng nguy hiểm.

---

## 2. Threat model từng thay đổi MVP

### 2.1 T1+T6 — Contract connect metrics + dashboard "Connect fail %"

**Attack surface mới**: các field mới `connectAttempts/connectFails/connectFailsByType/usersFailed` + `rates.connectFailRate` trong `LoadTestTick` (types.ts:154-184) — đi qua endpoint hiện có `GET /api/loadtest/metrics` (api-server.ts:87, **đã `auth: true`**) và render trên Màn 2.

**Phân tích**:

| STRIDE | Rủi ro | Mức | Mitigation |
|---|---|---|---|
| Information disclosure | Breakdown = **số đếm theo loại**, `usersFailed` = số nguyên — không chứa PII/token. Không lộ gì mới | Thấp | Chỉ xuất số đếm; **không** thêm `email`/`lastError` vào field mới |
| (e) Auth | Nếu đội dev vô tình mở endpoint mới (vd push WS/SSE cho tick) mà không auth → metrics run lộ | Trung bình | Yêu cầu: KHÔNG thêm endpoint mới; giữ nguyên `auth: true` của `/metrics` (api-server.ts:87). Nếu sau này thêm push channel → bắt buộc cùng auth Bearer |
| Tampering | Frontend tự đặt tên field lệch contract (R7 PLAN) → hiển thị sai giá trị → operator bị đánh lừa bởi số liệu | Thấp | T6 bám chính xác field T1 (đã có trong PLAN); test component assert giá trị |

**Kết luận**: attack surface mới của T1/T6 gần như bằng 0 với điều kiện giữ nguyên auth route hiện có. Không cần endpoint riêng.

### 2.2 T2+T5 — Sliding window 60s + threshold 50 + log E2 8 trường

**Attack surface mới**: trạng thái window `prevConnectCumulative` + `windowBuckets` (coordinator memory), quyết định `decideAutoStop`, dòng log E2.

**Phân tích**:

| STRIDE | Rủi ro | Mức | Mitigation |
|---|---|---|---|
| (a) DoS tool qua fail giả | Gateway (mục tiêu) LUÔN có thể ép connect fail → tool tự dừng. Đây là bản chất auto-stop (không tránh được). **Thay đổi của fix làm GIẢM vector này**: window 60s + ≥ 50 attempts + cap retry → fail nhất thời/gian lận ngắn hạn không còn đủ sức dừng run | Giảm rõ so với hiện tại (hiện: 4/10 attempts đầu ramp = 40% → stop ngay — PRD §2 #1) | Giữ nguyên window + threshold; **không cấu hình hóa ngưỡng** (config = thêm bề mặt tấn công — đúng lập luận PRD §6.6) |
| (a) Ngược lại — giấu fail thật (false negative) | **Diff-window**: nếu worker chết/restart, counter cumulative về 0 → delta **âm**. Không clamp ≥ 0 thì `fails` trong window có thể âm → `connectFailRate` âm → E2 **không bao giờ trigger** dù gateway đang chết | **Cao (điểm dễ sai nhất)** | Yêu cầu cứng: `delta = max(0, current - prev)` cho cả attempts lẫn fails (T5). Test bắt buộc: restart worker giữa window → rate không âm, không mất khả năng trigger |
| Tampering cửa sổ | Một bucket nhận delta lớn bất thường (worker stall 30s rồi tick dồn) → attempts nhích nhanh qua mốc 50 sớm hơn; tỉ lệ fails/attempts **bảo toàn** nên rate không lệch | Thấp | Chấp nhận (ratio-preserving); ghi chú trong design — không cần cấu hình |
| (d) Overflow | JS number double, an toàn tới 2^53. Window 60s × attempts/tick ~ vài trăm/s → ~10^4-10^6; kể cả cumulative retry Infinity cho user everConnected (~3600 fail/user/run max) × 10k user ≈ 3.6×10^7 — **không thể overflow** | Không đáng kể | Nhưng bắt buộc `rollWindow` giới hạn length ≤ 60 (shift) — chống memory growth nếu bug roll |
| (b) Log injection | Log E2 8 trường (PRD AC-4): phase/elapsedSec/windowSeconds/windowAttempts/windowFails/failsByType/usersFailed/workers — **toàn số** | Thấp | Yêu cầu: log E2 CHỈ gồm số + id chuẩn hóa; **cấm** nhét `err.message`/email/token vào dòng E2. Ghi rõ trong log field nào là window, field nào là cumulative (failsByType từ tick mới nhất là cumulative — dễ gây hiểu nhầm chẩn đoán) |
| Tampering state | `resetRunState` phải clear window + prevCumulative (T5 đã có — coordinator.ts:211-233); thiếu → run sau kế thừa fail run trước (pattern đã từng xảy ra với workerDeathTimes — coordinator.ts:231) | Trung bình | Yêu cầu: reset cả 2 state trong `resetRunState`; test: run mới bắt đầu với window rỗng |

### 2.3 T3 — Cap retry → phase 'failed' + skip user failed

**Attack surface mới**: chuyển phase client-side (`failed`), dừng reconnect (`disconnect()` / `reconnect(false)`), guard vòng lặp action.

**Phân tích**:

| STRIDE | Rủi ro | Mức | Mitigation |
|---|---|---|---|
| (a) Gateway ép user 'failed' ồ ạt | Gateway reject toàn bộ → mọi user failed sau ≤ 5 fail → fails đếm ≤ 5/user (bounded) → window rate vẫn > 30% với ≥ 50 attempts → **E2 vẫn dừng đúng** (AC-2). Không tạo cửa trốn | Thấp | Đúng thiết kế — test AC-2 bắt buộc |
| (a) Cửa trốn mới (side effect) | Với **6% token lỗi vĩnh viễn**: fails ~ 600×5 = 3000, attempts ~ 10.6k → rate ~28% < 30% → run tiếp tục với 600 user chết im lặng. Đây là chủ đích (AC-1) nhưng tạo "giấu fail cục bộ" | Trung bình (chấp nhận — có chủ đích) | Bắt buộc `usersFailed` hiển thị nổi bật trên dashboard (T6) để operator thấy user chết — không đánh lừa bởi rate thấp |
| DoS CPU | User **everConnected** vẫn retry Infinity (đúng chủ đích cho transient) → 10k socket reconnect với delay 1-10s — bounded, không spin nhanh (socket-farm.ts:129-133) | Thấp | Giữ `reconnectionDelay` hiện tại; KHÔNG giảm xuống < 1s |
| State tampering | `phase = 'failed'` chỉ set client-side bởi counter nội bộ — gateway không đặt được phase trực tiếp; nhưng gateway kiểm soát "có fail hay không" (đã phân tích ở trên) | Thấp | Không có vector mới |
| Logic | Disconnect handler (socket-farm.ts:147-153) đã guard `phase !== 'failed'` — nếu M3 không dừng reconnect thật (PLAN R4), `connect_error` vẫn phát → cần `io.reconnect(false)` và test khẳng định không còn fail sau failed | Trung bình | Yêu cầu T3: dừng reconnect xác minh bằng test (không còn `connect_error` mới); guard trong `tick()`/`ensureChatCycle` (M7) |

### 2.4 T4 — Phân loại connect_error + errorSamples `action:'connect'` + counters byType

**Attack surface mới**: nội dung `err.message` do **gateway kiểm soát** (socket.io-client: server gửi `connect_error` packet → message có thể chứa text tùy ý) đi vào: (1) `errorSamples` qua `recordError` (socket-farm.ts:661-665), (2) log verbose.

**Phân tích**:

| STRIDE | Rủi ro | Mức | Mitigation |
|---|---|---|---|
| (b) Log injection | `recordError` cắt `message.slice(0,160)` **KHÔNG qua logger redact** (socket-farm.ts:663). Nếu message chứa `\n[lt][ERROR][..] forged`, ring buffer format text `[lt][LEVEL][ts] msg` (logger.ts:256) bị **chèn dòng giả** → đánh lừa operator, làm hỏng log ingestion. JSONL sink an toàn (JSON.stringify escape), React render an toàn (escape mặc định — không có dangerouslySetInnerHTML cho lỗi) | **Trung bình** | Yêu cầu: sanitize message TRƯỚC khi vào errorSamples: strip `\r\n\x00` + control chars + truncate; không chỉ redact ở nhánh log verbose (PLAN T4 hiện mới redact ở log) |
| (c) Secret leak qua message | `err.message` có thể chứa URL có credential (redactUrl bắt — logger.ts:80-88, nhưng recordError KHÔNG đi qua nó) hoặc **JWT thô dạng `eyJ...`** — `redactMsg` (logger.ts:127-135) chỉ bắt `token=...`, KHÔNG bắt JWT trần | Trung bình | Yêu cầu: sanitizer dùng chung cho errorSamples: redactUrl + regex JWT/`eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+` → `[REDACTED]` + strip control chars |
| Info disclosure | `userId: u.account.email` trong errorSamples (socket-farm.ts:663) = email user thật (10k production accounts — PRD §0) — đã tồn tại với chat/rest; connect samples làm tăng tần suất. Chỉ lộ trong `/errors` (auth — api-server.ts:89) + dashboard auth | Thấp (hiện trạng) | Giữ auth; KHÔNG log errorSamples ra file/console ngoài nhánh verbose redact |
| Robustness | `classifyConnectError` nhận err thiếu field / kiểu lạ → không throw (PLAN T4 đã có) — mở rộng: fuzz với control chars, chuỗi rất dài, object null | Thấp | Unit test fuzz 4 loại × field thiếu × chuỗi lạ (mở rộng test PLAN T4) |

**Điểm lệch cần sửa trong PLAN**: PLAN T4 ghi "Log raw err (redact — logger.ts:90-135) khi verbose" — đúng cho LOG, nhưng **sink chính của err.message là `recordError` → errorSamples → dashboard**, nơi KHÔNG có redact. Yêu cầu đưa sanitizer vào đúng sink đó (hoặc dùng chung hàm `redactMsg` bổ sung JWT regex + strip control chars).

---

## 3. Trả lời trực tiếp 5 câu hỏi được giao

| Câu hỏi | Trả lời |
|---|---|
| (a) Giả mạo connect_error đẩy auto-stop sai / giấu fail thật? | **Đẩy sai**: giảm mạnh nhờ window+threshold+cap (2.2). **Giấu fail thật**: rủi ro THẬT nằm ở diff-window không clamp delta âm khi worker restart → rate âm → E2 tê liệt (2.2, mức Cao — bắt buộc `max(0, delta)` + test). Cửa trốn 6% token lỗi (2.3) là chủ đích AC-1 nhưng phải hiển thị `usersFailed` rõ |
| (b) Log injection qua error message vào 8-trường log? | Log E2 8 trường toàn số → an toàn nếu **cấm nhét message vào** (2.2). Vector thật nằm ở `recordError` → errorSamples (2.4) — cần sanitizer ở sink đó, không chỉ ở log verbose |
| (c) errorSamples chứa thông tin nhạy cảm (token/header)? | Khả năng thấp (socket.io-client message thường 'websocket error'/'timeout') nhưng gateway kiểm soát được message; JWT trần và URL có credential không bị redact hiện tại (logger.ts:127-135). Bắt buộc sanitizer chung: strip control chars + redactUrl + regex JWT. Không bao giờ log Authorization header (đã chặn — SENSITIVE_FIELD logger.ts:90) |
| (d) Counter overflow (cả window 60s)? | Không phải rủi ro thực tế trong JS double (2^53) với mọi kịch bản bounded (2.2). Yêu cầu thực chất: `rollWindow` giới hạn length ≤ 60 + reset state ở `resetRunState` — chống memory growth/bug roll |
| (e) Endpoint metrics mới cần auth không? | **Không tạo endpoint mới** — mở rộng `LoadTestTick` qua `/api/loadtest/metrics` đã `auth: true` (api-server.ts:87). Giữ nguyên auth. Mọi push channel tương lai (WS/SSE) phải cùng auth Bearer |

---

## 4. Rủi ro hiện hữu: `users_accounts.json` + pool files — QUYẾT ĐỊNH SCOPE

### Hiện trạng (đã xác minh)

- `C:\MAYogu_VIASG\chat-app\users_accounts.json` (1MB, ~10k accounts): `{email, password}` **plaintext**, mật khẩu chia sẻ chung `0IK05C2Zm`. Đã gitignore (`chat-app/.gitignore:50` — `users_accounts*.json`), **chưa bao giờ commit** (git log/ls-files xác minh sạch).
- `loadtest/data/accounts-*.json` (2 file 14.5MB mỗi file!): chứa `email`, `password` plaintext, **`accessToken` (JWT) và `refreshToken` (dài hạn)** của 10k user THẬT (PRD §0 — accounts production). Gitignore `loadtest/data/*` (`.gitignore:34`), chưa commit.
- `loadtest/data/auth-secret.json`: secret HMAC session persist (auth.ts:73-89) — gitignore phủ, chưa commit.
- errorSamples KHÔNG persist DB (db/writer.ts chỉ lưu `tick.errors` `{code,count}`) — blast radius giới hạn.

### Quyết định: KHÔNG đưa vào scope autobuild này — ghi security debt + hướng xử lý

**Lý do hợp lý**:
1. Đây là PRD **bugfix incident** (E2 false positive) với AC gate riêng; trộn xử lý dữ liệu nhạy cảm vào sẽ phá minimal-change và làm chậm fix đang chặn vận hành.
2. File đã gitignore + chưa từng commit → **không có vector leak qua repo**. Rủi ro còn lại là disk-level (backup, máy bị truy cập), mức độ không chặn được release hiện tại.
3. Tool **cần plaintext password để login/register** (useExistingAccounts — config.ts:172-207) — xóa/encrypt đột ngột làm vỡ luồng vận hành đang dùng.

**Hướng xử lý an toàn (task riêng, ưu tiên cao, đưa vào pre-flight còn nợ — memory: "sync OTP/DB password/gateway handshake.auth/gitleaks")**:
1. **Rotate**: mật khẩu chung `0IK05C2Zm` đã dùng cho 10k account — nếu file từng rò ra ngoài máy, reset mật khẩu các account seed (qua admin gateway) + đổi seed script sang mật khẩu ngẫu nhiên per-account.
2. **Di chuyển khỏi cây repo**: chuyển `users_accounts.json` + `loadtest/data/accounts-*.json` ra thư mục ngoài repo (vd `~/.mayogu/loadtest-secrets/`) hoặc xóa file seed sau khi import (pool files tái sinh mỗi run).
3. **ACL**: hạn chế quyền đọc file (POSIX 600 / Windows deny users khác) — đặc biệt `auth-secret.json` (session forge nếu lộ).
4. **Verify bằng tool**: `git ls-files | grep -iE 'users_accounts|accounts-|auth-secret'` = rỗng + gitleaks scan sạch (`.gitleaks.toml` đã có) — thành gate CI.
5. **Lưu ý pool files là rủi ro lớn hơn users_accounts.json**: chứa refreshToken dài hạn — ưu tiên xử lý trước.

---

## 5. Yêu cầu bảo mật cho design (danh sách cụ thể)

| # | Mục | Yêu cầu |
|---|---|---|
| S1 | T1/T6 (contract + dashboard) | Không tạo endpoint mới; field mới qua `/metrics` giữ `auth: true` (api-server.ts:87). Field mới chỉ chứa số đếm — không thêm email/lastError/message vào LoadTestTick |
| S2 | T2/T5 (window) | `delta = max(0, current - prev)` cho cả attempts và fails — worker restart không được tạo delta âm (ngăn rate âm giấu outage). `rollWindow` giới hạn length ≤ 60. `resetRunState` clear cả `prevConnectCumulative` + `windowBuckets` |
| S3 | T5 (log E2) | 8 trường AC-4 = **số + id chuẩn hóa, KHÔNG chứa message/email/token**. Ghi rõ field nào window vs cumulative (failsByType/workers là cumulative) |
| S4 | T3 (cap retry) | Sau phase 'failed': dừng reconnect thật (disconnect + `reconnect(false)` nếu cần — PLAN R4) và **không đếm thêm**; test khẳng định không còn `connect_error` sau failed. User everConnected giữ retry + delay 1-10s hiện tại |
| S5 | T4 (classify/errorSamples) | Sanitizer chung cho **mọi** message trước khi vào errorSamples: strip `\r\n\x00` + control chars, truncate ≤ 160, redactUrl, regex JWT trần `eyJ...` → `[REDACTED]`. Áp dụng ở `recordError` (socket-farm.ts:663), KHÔNG chỉ ở log verbose. `classifyConnectError` không throw với mọi input |
| S6 | M7 (skip failed) | Guard `phase === 'failed'` đầu vòng `tick()`/`ensureChatCycle` — user chết không tốn CPU (đã có trong PLAN T3) |
| S7 | Auth tổng thể | Không hạ auth bất kỳ route nào; login/register rate-limit giữ nguyên (api-server.ts:76-77) |

---

## 6. Danh sách kiểm thử bảo mật (test nào chứng minh)

| # | Test | Chứng minh | Vị trí đề xuất |
|---|---|---|---|
| ST-1 | `decideAutoStop` window: rate > 30 & attempts ≥ 50 → stop; attempts = 49 rate 100% → không stop; rate = 30 boundary → không stop; window rỗng → không stop | AC-2/AC-3 + không trigger sai | coordinator-state.test.ts (đã có trong PLAN T2 — giữ) |
| ST-2 | `rollWindow` push 65 → length 60, sum = 5 cuối; không giữ quá hạn | Bounded window, không memory growth | T2 (đã có) |
| ST-3 | **Diff clamp**: mô phỏng worker restart giữa window → delta âm → bị clamp 0 → `connectFailRate ≥ 0`; E2 vẫn trigger được với fail thật sau đó | Không giấu outage (S2) | coordinator.test.ts — **THÊM MỚI** vào T5 |
| ST-4 | `resetRunState` → window rỗng, prevCumulative rỗng; run mới không kế thừa fail run cũ | Không state leak giữa run (S2) | coordinator.test.ts — **THÊM MỚI** |
| ST-5 | `classifyConnectError` fuzz: err null/undefined, thiếu field, message chứa `\n`, chuỗi 10k ký tự, object lạ → không throw, trả 1 trong 4 loại | Robustness sink message (S5) | socket-farm.test.ts — **mở rộng** PLAN T4 |
| ST-6 | errorSamples sanitization: err.message chứa `\n[lt][ERROR] forged`, JWT `eyJ...`, `https://user:pass@host` → sample không chứa newline, không chứa JWT/password, bị truncate | Chống log injection + secret leak ở sink thật (S5) | socket-farm.test.ts — **THÊM MỚI** |
| ST-7 | Log E2 8 trường: regex assert dòng E2 chỉ có số/phase/workerId — không chứa token/email/message (AC-4 mở rộng) | Chống log injection dòng E2 (S3) | coordinator.test.ts — **THÊM MỚI** |
| ST-8 | Cap retry: 5 fail liên tiếp (chưa từng connected) → phase 'failed', socket ngừng reconnect, không đếm thêm; user everConnected fail → retry + đếm | Bounded fail/user (S4) | socket-farm.test.ts (PLAN T3 đã có) |
| ST-9 | Auth regression: `/metrics`, `/errors`, `/users` không token → 401; có token → 200 + field mới hiện diện | Metrics mới giữ auth (S1/S7) | api-server test hiện có — **mở rộng field mới** |
| ST-10 | Redaction: log verbose raw err → console/JSONL không chứa token/Authorization | Redact toàn pipeline (S5) | logger test hiện có — **mở rộng JWT trần case** |
| ST-11 | Secret hygiene (gate, không phải unit): `git ls-files | grep -iE 'users_accounts|accounts-|auth-secret'` rỗng; gitleaks scan sạch | File credential không lọt repo (Mục 4) | scripts/gate mới (pre-flight) |
| ST-12 | Integration mock gateway (đã có PLAN T7 a/b/c) + kịch bản **gateway gửi `connect_error` packet message độc** → assert ring buffer không có dòng log giả, errorSamples đã sanitize | End-to-end chống log injection từ mục tiêu | e2e-mock-gateway.test.ts — **THÊM MỚI** |

---

## 7. Điểm dễ bị tấn công trong chính đề xuất này

1. **Diff-window không clamp delta âm khi worker restart** (T5) — nếu quên `max(0, delta)`, fails window âm → `connectFailRate` âm → E2 tê liệt vĩnh viễn, giấu trọn outage thật. Đây là false-negative mới do chính fix tạo ra, dễ bỏ sót nhất vì chỉ xảy ra khi worker chết (điều kiện hiếm trong test thường).
2. **errorSamples đi qua `recordError` không có redact** (T4) — PLAN mới chỉ redact ở nhánh "log verbose"; sink thật (errorSamples → dashboard `/errors`) vẫn nhận message thô do gateway kiểm soát, mở log injection (newline) và JWT/URL-credential leak. Nếu producer bám đúng PLAN mà không sửa chỗ này, lỗ hổng (b)/(c) vẫn tồn tại nguyên vẹn.
3. **Cửa trốn "6% token lỗi" được hợp pháp hóa** (T3/AC-1) — đúng chủ đích, nhưng ngưỡng 30% + cap 5 fail làm run tiếp tục "thành công" trong khi 600 user chết: nếu dashboard không hiển thị `usersFailed` nổi bật, operator sẽ bị số liệu rate thấp đánh lừa và bỏ lỡ sự cố thật — phụ thuộc hoàn toàn vào T6 làm đúng.
4. **Ngưỡng 30%/50 hardcode + window 60s** — không cấu hình hóa (đúng, giảm bề mặt tấn công) nhưng với ramp cực thấp (< 1/s), window 60s không bao giờ đủ 50 attempts → E2 chết im lặng = false negative mới. Cần test boundary ramp thấp (AC-3 mở rộng) hoặc tài liệu hóa giới hạn.
5. **`failsByType`/`usersFailed`/`workers` trong log E2 là cumulative, rate là window** (T5) — trộn 2 gốc thời gian trong cùng 1 dòng log: nếu không ghi nhãn rõ, operator (hoặc script giám sát) có thể tính lại sai và kết luận "E2 sai" khi nó đúng — nguy cơ vận hành, gián tiếp tạo quyết định sai (vd tắt E2 vì tưởng bug).
