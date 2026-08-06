# DESIGN — Fix E2 connect-fail loadtest (CHÍNH THỨC)

**Nguồn**: PRD-loadtest-e2-connect-fail.md · PLAN-loadtest-e2-connect-fail.md · 3 proposal (backend/security/ui) · 3 critique (correctness/security/perf) — **file này thay proposal-backend làm source of truth cho implementer**.
**Vai trò**: Backend Architect — ADJUDICATOR + CONVERGENCE (design council autobuild).
**Trạng thái**: ĐÃ CHỐT — implementer bám file này, không bám PLAN cũ khi có khác biệt (mục 10 liệt kê thay đổi).

---

## 1. Phán quyết findings (21 findings sống → 18 ACCEPT · 1 MERGE · 1 REJECT)

| # | Finding | Nguồn | Severity | Phán quyết | Lý do + nơi áp |
|---|---|---|---|---|---|
| 1 | BE-1 — E2 response time đảo theo rampRate (0.25s @200/s → ~50s @ ramp min) | correctness | minor | **ACCEPT** (giới hạn tài liệu hóa + test) | Không đổi ngưỡng (PRD §6.6: không cấu hình hóa). AC-2 tính từ "khi window đủ mẫu" nên không vỡ; thêm test low-ramp (mục 9 T5-10) |
| 2 | BE-2 — "cumulative toàn run" SAI khi E3-restart (counter tụt) | correctness | major | **ACCEPT** (semantics chính thức, không đổi tên) | Semantics: "cumulative per-worker từ lúc process worker khởi động, sum theo tick mới nhất" — giống MỌI counter hiện có (actionsTotal…). Không monotonic toàn run; UI nhãn ghi rõ (mục 2.2) |
| 3 | BE-3 — log `windowSec=60` hardcode vs window trượt thật | correctness | minor | **ACCEPT** | Log windowSec = span thật từ `windowSpanSecs()` (mục 4.3) |
| 4 | BE-4 — duration hết đúng tick → phase-advance trước E2 → run 100% fail vẫn 'finished' | correctness | minor | **ACCEPT** | Reorder: khối auto-stop E2/E3 chạy TRƯỚC phase-advance (mục 7.3) |
| 5 | SEC-1 — S3 "failsByType là cumulative" mâu thuẫn backend §3.3 (window) | correctness | major | **MERGE với F-7** | Chốt: `byType` trong log = **WINDOW** (sum 4 loại == windowFails); `usersFailedCum`/`workers` = cumulative, đánh dấu `Cum` (mục 6) |
| 6 | SEC-2 — sai số học proposal-security §2.3 (6% → 10.6k attempts bất khả thi) | correctness | minor | **ACCEPT** | Đúng math: 600×5=3000 fails / (10000+3000) = **23.1%**; margin boundary ≈ **8.5% broken** (mục 5.2) |
| 7 | UI-1 — replay mọi run lịch sử hiện "đang chờ user connect đầu tiên" | correctness | major | **ACCEPT** | Thêm field `hasConnectData?: boolean` vào LoadTestTick (mục 2.1); replay `false` → empty state riêng (UI-SPEC §5.4) |
| 8 | UI-2 — mockup mâu thuẫn số học (fails 1.2k vs sum 1107) | correctness | minor | **ACCEPT** | UI rule: tổng = sum(byType); mockup sửa lại nhất quán (UI-SPEC §5.3) |
| 9 | UI-3 — tile `--` tái xuất giữa run sau restart + sparkline 0-line dưới `--` | correctness | minor | **ACCEPT** | Tile `--` chỉ khi `!lastTick` hoặc `hasConnectData === false` — không dùng cumulative attempts (UI-SPEC §3) |
| 10 | F-1 [HIGH] — cap 5 chỉ áp user chưa từng connected → token hết hạn giữa run = fail vô hạn | security | HIGH | **ACCEPT** | Cap 5 consecutive fail cho **MỌI user** (kể cả everConnected); AC-1/AC-2 số không đổi (mục 5) |
| 11 | F-2 — sink `lastError` không sanitize (→ bảng users) | security | MED-HIGH | **ACCEPT** | Sanitize khi gán lastError (socket-farm.ts:156, 193) — mục 3 |
| 12 | F-3 — log-injection sống trên đường LOG (redactMsg không strip control chars) | security | MED | **ACCEPT** | Strip control chars ngay trong `redactMsg`/sanitizeLogText (logger.ts:127-135) — mọi sink được lợi |
| 13 | F-4 — field `code` không slice/sanitize → errorSamples + TOP ERRORS + REPORT FILE | security | MED | **ACCEPT** | Sanitize + cap 64 cho code tại recordError (mục 3) |
| 14 | F-5 — regex bypass: access_token=, apiKey=, jwt=, sid=, hex-40, token 2-part | security | MED | **ACCEPT** | Sanitizer regex mở rộng (mục 3) + unit test từng bypass |
| 15 | F-6 — "gitignore = không có vector leak" SAI; refreshToken crown jewel | security | MED | **REJECT** (giữ defer; sửa lập luận; ghi debt) | Quyết định defer của proposal-security giữ nguyên (minimal-change, không chặn fix E2); lập luận "gitignore an toàn" bị bác — ghi vào PLAN mục rủi ro + pre-flight gate (gitleaks + `git ls-files` + move-out + rotate) |
| 16 | F-7 — log E2 trộn 2 gốc thời gian (window vs cumulative) | security | LOW | **MERGE với SEC-1** | Suffix `Cum` cho field cumulative (mục 6) |
| 17 | F-8 — "0% khi window < 50 attempts" hiển thị xanh = "khỏe" giả | security | LOW | **ACCEPT** (giảm thiểu MVP; fix đầy đủ v1.1) | Hint tooltip + variant `default` khi attempts==0; `hasConnectData` xử lý replay; field `connectWindowAttempts` → v1.1 |
| 18 | PF1 [MAJOR] — window theo bucket-count trôi dưới tải + restart first-tick spike | perf | MAJOR | **ACCEPT** | Window **wall-clock**: bucket lưu `ts`, evict theo `age > 60s` + **skip tick đầu sau restart** (mục 4) |
| 19 | PF2 — +1 recharts sparkline; memo vô hiệu; replay thiếu field | perf | minor | **ACCEPT** | Sparkline tile mới = **SVG polyline thủ công**; guard `?? 0` (UI-SPEC §3.2) |
| 20 | PF3 — claim "structured clone" SAI (IPC = JSON) | perf | minor | **ACCEPT** | Sửa claim: IPC child_process = JSON serialization; +7 field ≈ +1-2% payload tick (mục 2.4) |
| 21 | PF4 — DB lockstep 3 nơi khi v1.1 thêm cột | perf | minor | **ACCEPT** (note) | MVP không sửa; v1.1 dùng constants cột chung (mục 8) |

**Tổng: 18 ACCEPT · 1 MERGE (SEC-1+F-7) · 1 REJECT (F-6) · 0 cần thêm vòng.**

---

## 2. Contract chính thức (T1)

### 2.1 Field mới — `loadtest/types.ts`

```ts
export type ConnectFailType = 'timeout' | 'transport' | 'reject' | 'other';
export interface ConnectFailsByType { timeout: number; transport: number; reject: number; other: number; }
export const EMPTY_CONNECT_FAILS: ConnectFailsByType = { timeout: 0, transport: 0, reject: 0, other: 0 };
```

- **`WorkerTick.counters`** (types.ts:93-110) thêm: `connectFailsByType: ConnectFailsByType;` + `usersFailed: number;` (`connectAttempts/connectFails` đã có tại :108-109).
- **`LoadTestTick.counters`** (types.ts:161-177) thêm: `connectAttempts: number; connectFails: number; connectFailsByType: ConnectFailsByType; usersFailed: number;`
- **`LoadTestTick.rates`** (types.ts:178) thêm: `connectFailRate: number;` (0-100, window 60s — giá trị quyết định E2).
- **`LoadTestTick`** thêm **optional** `hasConnectData?: boolean;` (UI-1):
  - `true` — mọi tick LIVE (aggregateTicks + provisioning tick).
  - `false` — mọi tick DB-replay (`toMetricTick`).
  - Absent — không tồn tại trong dữ liệu persist (replay cũ không có — không xảy ra vì field chưa persist).

### 2.2 Semantics chính thức (BE-2)

`LoadTestTick.counters.connectAttempts/connectFails/connectFailsByType/usersFailed` = **tổng theo tick MỚI NHẤT của từng worker, mỗi counter cumulative từ khi process worker đó khởi động** (aggregateTicks sum latest per-worker — coordinator-state.ts:104-144). **KHÔNG monotonic toàn run**: khi worker chết → E3 restart (worker-farm.ts:182-196, process fork mới, counters init 0 — socket-farm.ts:435-440) → tổng có thể TỤT so với tick trước. Đây là semantics chung của MỌI counter hiện có (actionsTotal, usersCreated…) — field mới không đặc biệt, **không đổi tên field** (minimal change). Hệ quả:

- E2 decision KHÔNG dùng counters này (dùng window — mục 4) → auto-stop không bị ảnh hưởng bởi restart.
- UI nhãn "lũy kế" đổi chú thích: "từ đầu run, theo từng worker — có thể giảm khi worker restart" (UI-SPEC §2).
- Log E2 dùng suffix `Cum` cho các field cumulative (mục 6).

### 2.3 Compile-sites (bắt buộc)

| Nơi | Sửa |
|---|---|
| `coordinator.ts:428-443` (provisioning tick) | counters +4 field = 0, `rates.connectFailRate: 0`, `hasConnectData: true` |
| `coordinator-state.ts:89-93,104-144,165-185` (aggregateTicks) | C init +4 zero; loop sum connectAttempts/connectFails/usersFailed + merge byType từng key; tick build; `rates.connectFailRate: 0` (coordinator override trước pushTick — mục 7.1); `hasConnectData: true` |
| `socket-farm.ts:435-440` (WorkerRuntime.counters init) | +`connectFailsByType: {...EMPTY_CONNECT_FAILS}`, `usersFailed: 0`. `emitTick` spread (`:724`) tự mang — KHÔNG sửa logic T1 |
| `api-mappers.ts:42-79` (toMetricTick) | counters +4 = 0, `rates.connectFailRate: 0`, **`hasConnectData: false`** |
| `src/types/loadtest.ts:123-152` (frontend mirror) | +4 counter, +1 rate, +`hasConnectData?: boolean` (T6) |

### 2.4 Serialization / IPC (PF3 — claim đúng)

`WorkerTick` qua child_process fork IPC = **JSON serialization** (KHÔNG structured clone — structured clone là của worker_threads). Thêm 7 field số ≈ 60-100 byte/tick/worker trên payload 5-8KB hiện tại (socket-farm.ts:719-734) ≈ **+1-2%** — không đáng kể. HTTP path: LoadTestTick +120B/tick ≈ +120B/s poll (không đáng kể).

---

## 3. Sanitizer chung (F-2, F-3, F-4, F-5) — `sanitizeLogText`

Một hàm PURE dùng chung cho MỌI sink — file mới `loadtest/sanitize.ts` (thuần, test được):

```ts
/** Sanitize text từ nguồn không tin cậy (gateway-controlled) trước mọi sink.
 *  1) strip control chars (F-3 — chống log injection dòng giả)
 *  2) URL credential (F-5 — mở rộng redactUrl: user:pass@host + query secret keys)
 *  3) key=value nhạy cảm, KHÔNG cần word-boundary trước key (F-5 — bắt access_token=, apiKey=…)
 *  4) token trần: JWT 3-part (không bắt buộc prefix eyJ) + 2-part session + hex ≥ 32 (F-5)
 *  5) cap length (F-4)
 */
export function sanitizeLogText(raw: unknown, maxLen = 1000): string {
  const s0 = raw === null || raw === undefined ? '' : String(raw);
  let s = s0.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').replace(/\r?\n/g, ' '); // 1
  s = s.replace(/^([^:]+:\/\/[^:]+):[^@]*@/, '$1:***@');                              // 2 (host credential)
  s = s.replace(/[?&](?:access_token|api[_-]?key|jwt|session_id?|sid|sig|token|secret|otp|password|passwd|pwd|authorization|refresh_token)[^=]*=[^&\s]+/gi, '$&[REDACTED]'); // 2b (query params)
  s = s.replace(
    /\b((?:access_token|api[_-]?key|jwt|session_id?|sid|sig|password|passwd|pwd|token|secret|otp|authorization|refreshToken|refresh_token)\s*[=:]\s*)([^\s,;|]+)/gi,
    '$1[REDACTED]',                                                                     // 3
  );
  s = s.replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, '[REDACTED]'); // 4a JWT 3-part
  s = s.replace(/\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');              // 4b 2-part session
  s = s.replace(/\b[0-9a-fA-F]{32,}\b/g, '[REDACTED]');                                   // 4c hex-40
  return s.slice(0, maxLen);                                                             // 5
}
```

**Áp dụng tại 3 sink (KHÔNG chỉ errorSamples — đúng sink F-2/F-3):**

| Sink | Nơi | Cách |
|---|---|---|
| `recordError` — message + code | socket-farm.ts:661-665 | `code = sanitizeLogText(code, 64)`; `message = sanitizeLogText(message, 160)`; errorSamples push message đã sanitize (F-4: code cap 64 — chống bloat TOP ERRORS/report file) |
| `lastError` — mọi lần gán | socket-farm.ts:156 (`connect_error: ${err.message}`), :193 (`chat:error ${code} ${message}`), :370/:657 (enqueue/result — code vốn nội bộ nhưng sanitize đồng bộ) | `this.lastError = sanitizeLogText(raw, 160)` — bảng users / GET /users (routes/run.ts:104-117) không nhận text thô (F-2) |
| `redactMsg` — logger | logger.ts:127-135 | Đổi return: `return sanitizeLogText(s, 1000)` — giữ `redactSensitiveFields` bước 0 hiện có, thay khối regex `:130-133` bằng sanitizeLogText bước 3-4 (F-3/F-5): ring buffer text `[lt][LEVEL][ts]` (logger.ts:256), console, subscriber → DB log_events (writer.ts:206) đều được lợi |

Ghi chú: 4b/4c có thể over-redact (false-positive) — chấp nhận (an toàn hơn leak). `chat:error` handler (socket-farm.ts:192-195) KHÔNG sanitize riêng — code/message chỉ lọt ra qua 2 sink trên.

---

## 4. Sliding window 60s WALL-CLOCK + threshold 50 (T2 + T5)

### 4.1 Bucket & hằng số (thay proposal-backend §2 — PF1)

```ts
export interface ConnectWindowBucket {
  ts: number;                 // wall-clock ms lúc roll (đầu giây aggregateTick)
  attempts: number;           // delta (đã diff + clamp)
  fails: number;              // delta
  byType: ConnectFailsByType; // delta
}
export const E2_WINDOW_MS = 60_000;
export const E2_MIN_ATTEMPTS = 50;
export const E2_MAX_BUCKETS = 120; // safety cap — chống length vô hạn nếu evict hỏng
```

### 4.2 Thuật toán (PURE — `coordinator-state.ts`)

```ts
export function rollWindow(
  buckets: ConnectWindowBucket[],
  entry: ConnectWindowBucket,
  now: number,
  max = E2_MAX_BUCKETS,
): ConnectWindowBucket[] {
  const next = [...buckets, entry];                    // PURE — không mutate input
  const cutoff = now - E2_WINDOW_MS;
  while (next.length && next[0].ts < cutoff) next.shift(); // (1) evict theo WALL-CLOCK age > 60s
  while (next.length > max) next.shift();              // (2) safety cap
  return next;
}

export function sumWindow(buckets): { attempts: number; fails: number; byType: ConnectFailsByType } {
  // sum attempts/fails + merge byType từng key; rỗng → zeros (như proposal-backend §2.2)
}

export function windowSpanSecs(buckets, now): number {
  // BE-3: span THẬT — rỗng → 0; else Math.round((now - buckets[0].ts)/1000), clamp [0,120]
}

export function connectFailRateFromWindow(
  sum: { attempts: number; fails: number },
  minAttempts = E2_MIN_ATTEMPTS,
): number { return sum.attempts >= minAttempts ? (sum.fails / sum.attempts) * 100 : 0; }
```

**Vì sao wall-clock** (PF1): worker stall 4-8s (heartbeat 8s — coordinator.ts:29-30) hoặc coordinator GC pause làm 1 bucket chứa delta nhiều giây; evict theo age → window luôn = 60s thực → AC-2 "≤ 60s kể từ khi window đủ mẫu" đúng nghĩa, fail cũ trôi đúng lúc, không pha loãng kéo dài.

### 4.3 `decideAutoStop` (coordinator-state.ts:56-64)

```ts
// E2: connectTotal = attempts TRONG window 60s (semantics đổi — comment dòng 42-46 giờ là sự thật)
if (input.connectFailRate > E2_FAIL_RATE_PCT && input.connectTotal >= E2_MIN_ATTEMPTS) {
  return { stop: true, reason: `auto-stop: connect fail ${formatRatePct(input.connectFailRate)}% > ${E2_FAIL_RATE_PCT}% (E2)` };
}
```
E1 giữ nguyên (`registeredTotal >= 10`). KHÔNG cấu hình hóa ngưỡng (PRD §6.6). `formatRatePct` = 1 chữ số thập phân (F6: 30.1 → "30.1", không toFixed(0) → "30").

---

## 5. Cap retry 5 consecutive — MỌI user (T3, F-1) + xác nhận số học

### 5.1 Model đếm chính thức (thay proposal-backend §4.1 — F-1 HIGH)

`VirtualUser` (`socket-farm.ts`) thêm: `everConnected = false; consecutiveConnectFails = 0;`

- `'connect'` handler (:137-145): `everConnected = true; consecutiveConnectFails = 0;`
- `'connect_error'` handler (:155-160):
  ```ts
  if (this.phase === 'failed') return;                       // sau cutover: không đếm gì
  this.runtimeStats.connectAttempts++;
  this.runtimeStats.connectFails++;
  this.runtimeStats.connectFailsByType[classifyConnectError(err)]++;
  this.consecutiveConnectFails++;
  if (this.consecutiveConnectFails >= 5) {                   // cap MỌI user (kể cả everConnected)
    this.phase = 'failed';
    this.socket?.disconnect();
    this.socket?.io?.reconnect(false);                       // R4: chặn manager retry
    // KHÔNG null this.socket (khác disconnect() :394-402) — tránh connect() re-invoke
  }
  ```
- **Bỏ** điều kiện `!everConnected` — lý do (F-1): user ĐÃ connected có token hết hạn giữa run (TTL 1h, run ≤ 60 phút — PRD §2 #2, root cause #2) → reconnect vô hạn → 1 user = ~10 fail/60s → 500 user = 5000 fails/60s → 33% > 30% → **E2 false-positive tái xuất hiện đúng class bug đang sửa**. Cap 5 mọi user chặn đúng vector này. Transient thật (fail < 5 liên tiếp rồi success) vẫn được retry vô hạn — chỉ cutover khi 5 fail LIÊN TIẾP không thành công.
- M7 giữ: schedulerTick loop (:549-565) `if (u.phase === 'failed') continue;` + `ensureChatCycle` (:349-351) guard.

### 5.2 Số học AC-1 vs AC-2 (xác nhận — SEC-2 sửa lỗi mẫu số)

Mỗi `connect_error` = 1 attempt + 1 fail (socket-farm.ts:155-160); user failed cutover sau 5 consecutive → **tối đa 5 fail/user**. Mẫu số ĐÚNG: 10k cohort = 9.500 healthy (1 attempt) + 500 broken × 5 attempts → attempts = 9.500 + 2.500 = **12.000** (không phải 12.500 — SEC-2 class error, hiệu đính 2026-08-05):

| Kịch bản | attempts (window) | fails (window) | rate | Kết quả |
|---|---|---|---|---|
| **AC-1** 5% broken (500/10k, chưa từng connected) | 9.500 + 2.500 = **12.000** | **2.500** | **20.8%** < 30% | ✓ không trigger — finished |
| **AC-2** 100% broken (10k) | 10.000 × 5 = **50.000** | **50.000** | **100%** > 30%, ≥ 50 | ✓ stop `E2:` |
| **F-1 scenario** 500 user token hết hạn giữa run (đã everConnected) | 9.500 + 2.500 = **12.000** | **2.500** | **20.8%** < 30% | ✓ không trigger — đây là fix mới F-1 |
| **F-4 scenario** restart loop 2 chu kỳ trong window | 2 × 12.000 = **24.000** | 2 × 2.500 = **5.000** | **20.8%** < 30% | ✓ không trigger (xem 5.3) |
| 6% broken (SEC-2 hiệu đính) | 9.400 + 3.000 = **12.400** | **3.000** | **24.2%** | ✓ |
| Boundary ≈ **7.9%** broken (5x/(1+4x) = 30%) | 13.160 | 3.950 | 30.0% | sát ngưỡng — giới hạn tham số, không phải bug |

Chữ "chỉ đếm 1 fail/window" trong AC-1 (PRD:180) = tàn dư M3 cũ; giữ nghĩa đen thì AC-2 vỡ (10k fails/50k attempts = 20%) — **mô hình chính thức là bounded-5 mọi user** (đã chốt PLAN R3 + F-1).

### 5.3 ADJUDICATION F-4 (correctness — restart loop) + AC-1 verify (T5, 2026-08-05)

**F-4: cap 5 fail/user là per-process — E3-restart tái sinh 5 fail/user/chu kỳ; 2 chu kỳ trong window có vượt ngưỡng?**

- **BÁC số học finding**: 33% (5000/15000) giả định healthy users KHÔNG re-attempt trong khi broken users có — sai với model đếm: worker restart = CẢ cohort user của worker đó reconnect (paced, socket-farm.ts:528-533), healthy user mỗi connect đều +1 attempt (socket-farm.ts:137-145). Rate per chu kỳ = 5B/(H+5B) — **bất biến** với mọi chu kỳ/cohort (20.8% cho 5% broken) → 2 chu kỳ = 20.8% (bảng trên). Cộng thêm skip-first-tick (T5) làm giảm thêm contribution của restart (bucket đầu bị bỏ).
- **QUYẾT ĐỊNH: (b) chấp nhận** — không persist per-user state qua restart (persist = state store/Redis/file: quá nặng cho edge case, race-prone khi worker bị kill giữa tick; window 60s đã giới hạn thời gian đóng góp). Kịch bản "restart loop + broken users" = churn thật (E3-class) — rate vẫn 20.8% nên không false-positive.
- **Test**: `coordinator.test.ts` "F4: restart loop (worker chết + skip-first) → rate giữ ~20.8%, không stop (AC-1)" — handleWorkerDied xóa prev + cycle B skip-first + 2 chu kỳ → rate 20.8%, writeRunFinish không được gọi.

**AC-1 verify (transient outage có false-positive?)**:
- AC-1 premise: "E2 không trigger khi connect-fail THẬT < 30% trong window 60s, kể cả khi có ≤ 5% user lỗi vĩnh viễn". Implementation: 5% broken → 20.8% < 30% → KHÔNG trigger (test F4 + wiring spike test) ✓ — AC-1 ĐẠT, không cần chỉnh.
- Kịch bản "10k user fail 1 lần rồi thành công" = fail thật 100% trong window (≥ 50 attempts) → **E2 STOP — ĐÚNG THIẾT KẾ**: burst 100% là sự cố thật (gateway down/deploy), ngoài premise AC-1 (premise chỉ bảo vệ fail < 30%); window giới hạn thời gian chứ không "bỏ qua" fail thật (PRD §2 #3: sau fix, fail nhất thời không còn kẹt mãi — nhưng vẫn dừng run ĐANG có sự cố, đúng chủ đích auto-stop).
- **KHÔNG đổi ngưỡng** (PRD §6.6). Test ghi nhận: "AC-1 verify: 100% fail burst thật → STOP (fail thật ≥ 30% — ngoài premise AC-1)".

---

## 6. Log E2 8 trường — format CHUẨN (AC-4, BE-3, SEC-1+F-7)

`formatE2Log` = hàm PURE (test chuỗi được). 1 dòng duy nhất (grep `E2:` ra đủ 8 trường — AC-4):

```
E2: auto-stop: connect fail 41% > 30% (E2) | phase=ramping elapsedSec=87 windowSec=60 windowAttempts=8120 windowFails=3330 byType=timeout:2500,transport:500,reject:300,other:30 usersFailedCum=450 workersAlive=10 workersTotal=10
```

| Trường | Giá trị | Gốc thời gian |
|---|---|---|
| `phase` | `this.phase` | — |
| `elapsedSec` | `agg.tick.elapsedSec` | — |
| `windowSec` | `windowSpanSecs(buckets, now)` — **span thật** (BE-3), không hardcode 60 | window |
| `windowAttempts` | `window.attempts` | window |
| `windowFails` | `window.fails` | window |
| `byType=timeout:,transport:,reject:,other:` | `window.byType` — **tổng 4 loại == windowFails** (SEC-1 chốt) | window |
| `usersFailedCum` | `sum(t.counters.usersFailed)` từ ticks mới nhất — suffix `Cum` (F-7/SEC-1) | cumulative |
| `workersAlive` / `workersTotal` | `this.farm.alive` / `this.farm.total` (worker-farm.ts:60-68) | cumulative |

- **stopReason** (DB, AC-2): `finishRun('auto', \`E2: ${decision.reason}\`, false)` → bắt đầu bằng `E2:` (PHÁT HIỆN: code hiện tại coordinator.ts:546 truyền `decision.reason` bắt đầu `auto-stop:` → vỡ AC-2).
- Log line: `ltLog.error(\`E2: ${decision.reason} | ${formatE2Log(...)}\`)`.
- Cấm nhét message/email/token vào dòng E2 (S3) — toàn số + id.

---

## 7. Coordinator wiring (T5)

### 7.1 State + luồng `aggregateTick`

```ts
private prevConnectCumulative = new Map<number, { attempts: number; fails: number; byType: ConnectFailsByType }>();
private windowBuckets: ConnectWindowBucket[] = [];
private lastWindow: { attempts: number; fails: number; byType: ConnectFailsByType } = { attempts: 0, fails: 0, byType: EMPTY_CONNECT_FAILS };
```

**Bước A — hoisted TRƯỚC `pushTick` (:484)**, trong guard `phase === 'ramping' || 'steady'`:

```ts
let dA = 0, dF = 0;
const dByType = { ...EMPTY_CONNECT_FAILS };
for (const t of ticks) {                                    // ticks = [...this.workerTicks.values()] (:448)
  const prev = this.prevConnectCumulative.get(t.workerId);
  if (!prev) {
    // SKIP TICK ĐẦU (PF1): worker mới spawn / vừa restart — cumulative của process mới
    // có thể chứa 2-15s attempt/fail (pacing + reconnect storm) → KHÔNG tạo bucket phình.
    this.prevConnectCumulative.set(t.workerId, snapshotOf(t));
    continue;
  }
  // Clamp delta âm (S2/ST-3): restart race / counter reset → max(0, …) — rate không bao giờ âm
  dA += Math.max(0, t.counters.connectAttempts - prev.attempts);
  dF += Math.max(0, t.counters.connectFails - prev.fails);
  dByType.timeout   += Math.max(0, t.counters.connectFailsByType.timeout   - prev.byType.timeout);
  dByType.transport += Math.max(0, t.counters.connectFailsByType.transport - prev.byType.transport);
  dByType.reject    += Math.max(0, t.counters.connectFailsByType.reject    - prev.byType.reject);
  dByType.other     += Math.max(0, t.counters.connectFailsByType.other     - prev.byType.other);
  this.prevConnectCumulative.set(t.workerId, snapshotOf(t));
}
this.windowBuckets = rollWindow(this.windowBuckets, { ts: now, attempts: dA, fails: dF, byType: dByType }, now);
this.lastWindow = sumWindow(this.windowBuckets);
agg.tick.rates.connectFailRate = connectFailRateFromWindow(this.lastWindow); // TRƯỚC pushTick (dashboard AC-6)
```

**Bước B — khối auto-stop (:513-558) di chuyển lên TRƯỚC phase-advance (:497-511)** (BE-4): duration hết đúng tick mà window vượt ngưỡng → E2 thắng natural-end (finishRun 'auto' → status 'error'), không xuyên thủng AC-7. Thứ tự mới trong nhánh ramping/steady: (1) Bước A + pushTick → (2) periodic 15s → (3) **E2 decide + E3 checks** (dùng `lastWindow`) → (4) phase-advance (ramping→steady / steady→cooldown).

E3 (workerDeathTimes — coordinator.ts:104-106, :549-558) giữ nguyên, chỉ đổi vị trí; không tái dùng code cho window (2 pattern khác nhau: đếm sự kiện vs sum bucket).

### 7.2 Cleanup

- `handleWorkerDied` (:103-119): thêm `this.prevConnectCumulative.delete(workerId);` (để skip-first-tick phát huy khi restart).
- `resetRunState` (:211-233): thêm `prevConnectCumulative.clear(); windowBuckets = []; lastWindow = zeros;` (thiếu → run sau kế thừa window run trước — bug pattern đã từng xảy ra với workerDeathTimes :231).

---

## 8. DB impact (T1 — xác minh, PF4)

- **MVP = 0 thay đổi**: `toMetricSample` (writer.ts:412-441) pick field tường minh theo cột → field mới bị bỏ im lặng, không vỡ INSERT; cột `metric_samples` không đổi (store.ts:59-86, 381-401); param count 26 × 500 tick = 13.000 < 65.535 (an toàn; v1.1 thêm 5 cột = 15.500 vẫn an toàn, KHÔNG cần chunk cho metric_samples).
- Replay (R1): `toMetricTick` trả field mới = 0 + `hasConnectData: false` → UI phân biệt được (mục 2.1, UI-SPEC §5.4).
- **v1.1** khi thêm cột: sửa khớp 3 nơi (toMetricSample / store INSERT+SELECT / toMetricTick) — dùng 1 danh sách cột constants chung (PF4).

---

## 9. Test list ĐẦY ĐỦ

### T1 (contract)
1. `types-contract.typecheck.ts` — cross-assign 2 chiều BE↔FE: 4 counter + 1 rate + `hasConnectData`.
2. `coordinator-state.test.ts` — fakeTick (:5-27) + aggregateTicks: merge byType 2 worker `{timeout:1,transport:2}` + `{transport:3,reject:1}` → `{timeout:1,transport:5,reject:1,other:0}`; usersFailed sum; `rates.connectFailRate === 0`; `hasConnectData === true`.
3. `coordinator.test.ts` — provisioning tick đủ field = 0 + hasConnectData true.
4. api-mappers — `toMetricTick` field 0 + `hasConnectData === false`.
5. JSON round-trip LoadTestTick (HTTP/WS) giữ đủ field.

### T2 (window wall-clock)
1. `rollWindow` wall-clock: push 65 entry ts cách 1s → length 60, sum = 5 cuối; entry `ts < now-60s` bị evict dù length < 60; push 150 → length ≤ 120 (safety cap); immutability.
2. `sumWindow`: rỗng → zeros; merge attempts/fails/byType.
3. `windowSpanSecs`: rỗng → 0; 60 bucket 1s → 59-60; bucket stall 8s → span = span thật (không hardcode 60).
4. `connectFailRateFromWindow`: 49 → 0; 50 + 17/50 → 34.
5. `decideAutoStop`: 100%×49 → không stop; 100%×50 → stop; 30%×50 → không; 30.1×50 → stop; rỗng → không.
6. E1 boundary regression (:115-149) — chỉ đổi 2 case E2 10→50.

### T3 (cap mọi user — F-1)
1. Cap 5 consecutive (chưa từng connected) → `failed`, không đếm thêm, không còn connect_error (R4).
2. **ĐỔI (F-1)**: user ĐÃ everConnected fail 5 liên tiếp → `failed`, không đếm thêm.
3. **THÊM**: fail 3 → success → fail 5 → KHÔNG failed (consecutive reset — transient vẫn retry).
4. `emitTick`: `usersFailed` đúng; fail sau failed không vào counters.
5. Scheduler bỏ qua user failed (M7) — không REST/chat/enqueue.
6. disconnect sau failed không đổi phase.

### T4 (classify + sanitizer)
1. `classifyConnectError` 6-8 case (4 loại × field thiếu) + **fuzz (ST-5)**: null/undefined/string/thiếu field/`\n`/10k chars/object lạ → không throw, 1 trong 4 loại.
2. `recordError`: action 'connect' (backward compat 'chat'); **sanitize message + code (ST-6 mở rộng)**: `\n[lt][ERROR] forged`, JWT `eyJ…`, `user:pass@host`, `access_token=…`, hex-40 → sạch; code cap 64.
3. byType + usersFailed trong tick.
4. **THÊM (F-2)**: lastError từ connect_error + chat:error message độc → sanitized (không newline/secret) — qua `toRow()`.
5. **THÊM (F-3, logger.test.ts)**: `redactMsg` strip control chars — msg chứa `\n` → 1 dòng, không dòng log giả.
6. **THÊM (F-5)**: regex bypass từng loại — `access_token=`, `apiKey=`, `jwt=`, `sid=`, `session_id=`, token 2-part `body.sig`, hex-40, JWT không prefix eyJ.
7. **THÊM (F-4)**: `chat:error` code độc → errorSamples.code + TOP ERRORS sạch + report không bị phá.

### T5 (wiring)
1. Spike 5s rồi sạch → hết 60s wall-clock rate ~0, không finish (phục hồi — AC-1).
2. Fail liên tục 100% → `finishRun('auto', reason bắt đầu 'E2:')` ≤ 60s (AC-2).
3. Window < 50 attempts → không stop, không log E2 (AC-3).
4. Log E2 8 trường — assert chuỗi đủ 8 token + **regex ST-7**: `/^E2: .* \| phase=\S+ elapsedSec=\d+ windowSec=\d+ windowAttempts=\d+ windowFails=\d+ byType=timeout:\d+,transport:\d+,reject:\d+,other:\d+ usersFailedCum=\d+ workersAlive=\d+ workersTotal=\d+$/`.
5. `resetRunState` — run 2 không kế thừa window/prev (ST-4).
6. Worker chết giữa window: prev xóa → tick đầu sau restart delta 0 (skip), tick 2 delta tính từ tick 1 (ST-3 mở rộng).
7. Không double-count: 2 aggregateTick cùng tick worker → delta tick 2 = 0.
8. **ST-3**: diff clamp âm — worker restart cumulative thấp hơn → delta 0, rate ≥ 0, E2 vẫn trigger với fail thật sau đó.
9. **THÊM (BE-4)**: elapsedSec == durationSec + window rate 100% → finishRun 'auto' (status error), KHÔNG cooldown/'finished'.
10. **THÊM (BE-1)**: ramp 1/s → window đủ 50 attempts sau ~50 tick → E2 fire sau ~50s; không fire trước đó (tài liệu hóa giới hạn).

### T6 (UI) — UI-SPEC §6: 6 component test (5 cũ + hasConnectData).

### T7 (integration + AC)
- Mock gateway a/b/c (giữ PLAN) + **ST-12**: mock gateway gửi `connect_error` packet message độc (middleware `next(new Error('độc'))`) → ring buffer không dòng giả, errorSamples sanitized.
- **ST-9**: auth regression — /metrics, /errors, /users không token → 401; có token → 200 + field mới hiện diện.
- **ST-10**: log verbose raw err → console/JSONL không chứa JWT trần/Authorization.
- **ST-11**: gate secret hygiene (pre-flight): `git ls-files | grep -iE 'users_accounts|accounts-|auth-secret'` rỗng + gitleaks sạch.
- AC map: AC-1→T3+T5+T7(b) · AC-2→T5+T7(c) · AC-3→T2+T5+T7 · AC-4→T5+T7(c)+ST-7 · AC-5→T7(10k) · AC-6→T6+T7 · AC-7→T3+T5(BE-4)+T7.

---

## 10. Khác biệt so với PLAN cũ (implementer đọc đây)

1. **T2**: window = wall-clock (`ts` + evict age + `windowSpanSecs`) — KHÔNG bucket-count thuần.
2. **T3**: cap 5 consecutive **mọi user** (bỏ phân biệt everConnected) — test (2) đổi, test (3) mới.
3. **T4**: thêm sanitizer `sanitizeLogText` áp 3 sink (recordError message+code / lastError / redactMsg) — chạm thêm `logger.ts` + file mới `sanitize.ts`; code cap 64.
4. **T5**: khối auto-stop chuyển TRƯỚC phase-advance (BE-4); skip-first-tick sau restart; log `windowSec` thật + `usersFailedCum`; stopReason prefix `E2:`.
5. **T1**: thêm `hasConnectData?: boolean` (live true / replay false).
6. **T6**: sparkline SVG polyline thủ công (không recharts thứ 5) + guard `?? 0` + empty state theo `hasConnectData`.
7. **F-6**: ghi nợ pre-flight (gitleaks + move-out + rotate) — không phải task R1-R5.

---

## 11. Rủi ro còn lại (đã chấp nhận — ghi để council biết)

1. **BE-1**: ramp < 1/s → E2 phản ứng chậm (~attempts/rate giây) — giới hạn tham số, AC-2 vẫn đúng theo định nghĩa "từ khi window đủ mẫu".
2. **F-8**: window < 50 attempts hiển thị 0% xanh đầu ramp (hint tooltip giảm thiểu; `connectWindowAttempts` field → v1.1).
3. **F-6**: credential files (users_accounts.json, loadtest/data/accounts-*.json 14MB × 2 chứa refreshToken) — debt pre-flight, gate CI bắt buộc cùng window release.
4. **Boundary ≈ 8.5% broken** (SEC-2) — nếu tỉ lệ token lỗi thật vượt, AC-1 không đảm bảo (giới hạn tham số).
5. **Over-redact false-positive** của sanitizeLogText 4b/4c — chấp nhận (an toàn hơn leak).
