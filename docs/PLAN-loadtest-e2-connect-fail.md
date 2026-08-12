# PLAN — Fix bug E2 loadtest: auto-stop kích hoạt nhầm (connect fail 41% > 30%)

**Nguồn**: `docs/PRD-loadtest-e2-connect-fail.md` (root-cause #1-#3, MVP M1-M8, AC-1..AC-7) · **`docs/DESIGN-loadtest-e2-connect-fail.md` (CHÍNH THỨC — thay các proposal; mọi khác biệt bám DESIGN)** · `docs/UI-SPEC-loadtest-e2-connect-fail.md` (T6)
**Mục tiêu**: Không đổi cơ chế an toàn E1/E2/E3. E2 chỉ trigger khi connect-fail THẬT > 30% trong cửa sổ 60s (WALL-CLOCK) với ≥ 50 attempts; 1 user hỏng vĩnh viễn (kể cả đã từng connected) không được sinh fail vô hạn; log E2 + dashboard có observability; sanitizer chung cho mọi sink message.
**Trạng thái**: ĐÃ CHỐT — sẵn sàng rounds R1-R5.

---

## 1. Tóm tắt spec (trích PRD)

| # | Yêu cầu (MVP) | Nguồn |
|---|---|---|
| M1 | E2 đo trên sliding window 60s thật (không cumulative toàn run) | PRD §3 M1 |
| M2 | Threshold window ≥ 50 attempts (thay 10 cumulative) | PRD §3 M2 |
| M3 | Cap retry: user chưa từng connected fail ≥ 5 liên tiếp → phase `'failed'`, ngừng reconnect, fail sau đó không đếm | PRD §3 M3 |
| M4 | Phân loại connect fail (timeout/transport/reject) → `errorSamples` với `action: 'connect'` | PRD §3 M4 |
| M5 | Log E2 trigger kèm breakdown (8 trường) | PRD §3 M5, AC-4 |
| M6 | Connect metrics trong `LoadTestTick` + dashboard "Connect fail %" | PRD §3 M6, AC-6 |
| M7 | User `'failed'` không tham gia vòng lặp action | PRD §3 M7 |
| M8 | Unit test đi kèm | PRD §3 M8 |

**Cơ chế hiện tại (đã xác minh trong code)**:
- `loadtest/coordinator.ts:531-536` — sum cumulative counter toàn run từ `workerTicks` (tick mới nhất/worker); `connectFailRate = fails/attempts` khi `attempts >= 10`.
- `loadtest/coordinator-state.ts:60-61` — `decideAutoStop` ngưỡng `> 30 && connectTotal >= 10`; comment dòng 44-46 hứa "cửa sổ 60s" nhưng không có code (deviation).
- `loadtest/socket-farm.ts:129-133` — `reconnectionAttempts: Infinity`; `:155-160` đếm MỌI `connect_error` → 1 user lỗi vĩnh viễn = vô hạn fail.
- `loadtest/socket-farm.ts:663` — `recordError` hardcode `action: 'chat'`; `ErrorSample.action` (types.ts:126) đã cho phép `'connect'`.
- `loadtest/types.ts:161-177` — `LoadTestTick.counters` KHÔNG có connectAttempts/connectFails → dashboard/report mù với E2.
- Pattern cửa sổ 60s đã có sẵn ở E3: `workerDeathTimes` ring buffer (coordinator.ts:104-106) — **tái dùng pattern này**.

---

## 2. Danh sách task

### T1 — Contract: thêm connect metrics vào types + fix mọi constructor
**Producer**: Backend Architect

**Mô tả**: Định nghĩa contract mới (additive — không đổi field hiện có). **Bám CHÍNH XÁC DESIGN §2**:
- `loadtest/types.ts`:
  - Export `ConnectFailType = 'timeout' | 'transport' | 'reject' | 'other'` + `ConnectFailsByType` + `EMPTY_CONNECT_FAILS`.
  - `WorkerTick.counters` thêm: `connectFailsByType: ConnectFailsByType`, `usersFailed: number`.
  - `LoadTestTick.counters` thêm: `connectAttempts`, `connectFails`, `connectFailsByType`, `usersFailed`.
  - `LoadTestTick.rates` thêm: `connectFailRate: number` (0-100, window 60s).
  - `LoadTestTick` thêm optional `hasConnectData?: boolean` — **live = true, replay (toMetricTick) = false** (UI-1).
- Fix mọi constructor/compile-site (DESIGN §2.3):
  - `loadtest/coordinator.ts:428-443` (provisioning tick: 4 counter = 0, `rates.connectFailRate: 0`, `hasConnectData: true`).
  - `loadtest/coordinator-state.ts` `aggregateTicks` (C thêm 3 counter sum + merge `connectFailsByType` theo loại + `usersFailed`; tick.rates `connectFailRate: 0` — coordinator override ở T5; `hasConnectData: true`).
  - `loadtest/socket-farm.ts` `WorkerRuntime.counters` init thêm `connectFailsByType: {...EMPTY_CONNECT_FAILS}`, `usersFailed: 0` (emitTick spread `{usersTotal, ...counters}` tự mang — KHÔNG sửa logic ở task này).
  - `loadtest/api-mappers.ts` `toMetricTick`: 4 counter default 0, `rates.connectFailRate: 0`, **`hasConnectData: false`**.
- **Semantics chính thức (BE-2)**: counters connect = "cumulative per-worker từ lúc process khởi động, sum theo tick mới nhất" — KHÔNG monotonic toàn run (tụt khi worker E3-restart; giống mọi counter hiện có). KHÔNG đổi tên field; comment + UI nhãn ghi rõ (T6).
- Cập nhật test khớp contract: `loadtest/__tests__/types-contract.test.ts` + `types-contract.typecheck.ts` (2 chiều FE↔BE kể cả hasConnectData), `coordinator-state.test.ts` (fakeTick), `e2e-mock-gateway.test.ts`, `int.test.ts` nếu dựng tick thủ công.

**Acceptance criteria**:
- `tsc` (backend + frontend) xanh — không còn compile error do field mới.
- `LoadTestTick`/`WorkerTick` từ mọi nguồn (aggregate, provisioning tick, DB replay) đều đủ field mới (0 hoặc giá trị thật); replay `hasConnectData === false`.
- Không đổi field cũ, không đổi behavior — test hiện có vẫn xanh trừ thay đổi shape cần thiết.

**Test**:
- Unit: `types-contract.test.ts` assert shape mới + `hasConnectData`; `coordinator-state.test.ts` aggregateTicks merge `connectFailsByType` + `usersFailed` từ 2 worker; api-mappers `toMetricTick` (DESIGN §9 T1).
- G1: full suite xanh; G4: lint + build.

**Critics**: Code Reviewer (correctness/ripple), Software Architect (contract additive vs breaking), Test Automation Engineer (contract test phủ mọi nguồn tick).

**Effort**: M

---

### T2 — Sliding window 60s WALL-CLOCK pure + threshold 50 (coordinator-state.ts)
**Producer**: Backend Architect

**Mô tả**: Phần PURE (testable không IO). **Bám DESIGN §4 (PF1 — window theo wall-clock, KHÔNG bucket-count thuần)**:
- Thêm vào `loadtest/coordinator-state.ts`:
  - `ConnectWindowBucket = { ts: number; attempts: number; fails: number; byType: ConnectFailsByType }` (ts = wall-clock ms lúc roll).
  - `rollWindow(buckets, entry, now, max = 120): ConnectWindowBucket[]` — push + evict theo **age > 60s** (`ts < now - E2_WINDOW_MS`) + safety cap length ≤ 120 (chống length vô hạn nếu evict hỏng). PURE — không mutate input.
  - `sumWindow(buckets): { attempts; fails; byType }` — sum + merge byType từng key; rỗng → zeros.
  - `windowSpanSecs(buckets, now): number` — **span THẬT** của window (BE-3), clamp [0, 120].
  - `connectFailRateFromWindow(sum, minAttempts = 50): number` — `attempts >= min ? fails/attempts*100 : 0`.
  - Hằng số: `E2_WINDOW_MS = 60_000`, `E2_MIN_ATTEMPTS = 50`, `E2_MAX_BUCKETS = 120`.
- Sửa `decideAutoStop` (`coordinator-state.ts:56-64`):
  - Đổi ngưỡng E2: `input.connectFailRate > 30 && input.connectTotal >= E2_MIN_ATTEMPTS` (window attempts ≥ 50 — thay 10 cumulative).
  - KHÔNG cấu hình hóa ngưỡng (PRD §6.6). E1 giữ nguyên (`registeredTotal >= 10`).
  - Ghi rõ comment: `connectTotal` giờ là attempts TRONG window 60s (semantics đổi — PRD §6.6 chấp nhận).
- Cập nhật test cũ: `loadtest/__tests__/coordinator-state.test.ts:134-148` (boundary 10 attempts → 50).

**Acceptance criteria**:
- Unit: `decideAutoStop` window: rate > 30% && attempts ≥ 50 → stop; attempts < 50 → không stop (kể cả rate 100%); rate = 30 (boundary) → không stop; window rỗng → không stop.
- Unit: `rollWindow` wall-clock: push 65 entry ts cách 1s → sum = 5 cuối, length 60; entry quá hạn (`ts < now-60s`) bị evict dù length < 60; push 150 → length ≤ 120; không mutate input.
- Unit: `windowSpanSecs` trả span thật (không hardcode 60).
- E1 boundary test không đổi.

**Test**:
- Unit: `coordinator-state.test.ts` — ~10 case (DESIGN §9 T2).
- G2 mutation: scoped `coordinator-state.ts` ≥ 60% critical.

**Critics**: Code Reviewer (correctness), Performance Benchmarker (evict theo age + cap — chi phí O(120)/tick), Statistician (ngưỡng 50 + boundary 30% + giới hạn ramp thấp BE-1).

**Effort**: S

---

### T3 — Cap retry vĩnh viễn MỌI user + skip user 'failed' (socket-farm.ts)
**Producer**: Realtime Collaboration Engineer

**Mô tả**: PRD M3 + M7. **Bám DESIGN §5 (F-1 HIGH — cap 5 áp MỌI user kể cả đã từng connected)** — `loadtest/socket-farm.ts`:
- `VirtualUser` thêm field: `everConnected = false`, `consecutiveConnectFails = 0`.
- `'connect'` handler (dòng 137-145): `everConnected = true; consecutiveConnectFails = 0`.
- `'connect_error'` handler (dòng 155-160) — mô hình đếm (DESIGN §5.1):
  - Nếu `phase === 'failed'` → return (không đếm gì — fail sau khi failed không vào window).
  - `connectAttempts++`, `connectFails++`, `connectFailsByType[classifyConnectError(err)]++` (byType tăng ở T4; T3 chỉ chốt counters).
  - `consecutiveConnectFails++`; **nếu `consecutiveConnectFails >= 5` → `phase = 'failed'`, dừng reconnect** (`socket.disconnect()` + `socket.io.reconnect(false)` — R4), KHÔNG null `this.socket` (khác `disconnect()` :394-402), `lastError` giữ + ghi chú failed.
  - **KHÔNG phân biệt everConnected** (F-1): user token hết hạn giữa run (đã từng connected) cũng cutover sau 5 fail liên tiếp — chặn fail vô hạn = tái hiện bug gốc. Transient thật (fail < 5 liên tiếp rồi success) vẫn retry vô hạn.
- M7 — bỏ user failed khỏi vòng lặp action:
  - `schedulerTick` loop (dòng 549-565): `if (u.phase === 'failed') continue;` đầu vòng.
  - `ensureChatCycle` (dòng 349-351): thêm guard `if (this.phase === 'failed') return;`.
- `disconnect` handler (dòng 147-153) đã guard `phase !== 'failed'` — không đổi.

**Acceptance criteria**:
- User chưa từng connected fail 5 lần liên tiếp → `phase === 'failed'`, socket ngừng reconnect (không còn `connect_error` mới sau đó), `runtimeStats` không tăng thêm attempt/fail.
- **User ĐÃ TỪNG connected fail 5 lần liên tiếp → `phase === 'failed'`, không đếm thêm (F-1 — test T3 (2) ĐỔI).**
- **User fail 3 → success → fail 5 → KHÔNG failed (consecutive reset — transient vẫn retry) (THÊM).**
- User `'failed'` không được schedule action/REST/enqueue (kiểm tra qua `tick()` + `ensureChatCycle` không sinh action mới).
- AC-1 numeric: 500/10k user lỗi → fails tối đa 500×5 = 2500, attempts 12.500 → rate window = 20.0% < 30% (DESIGN §5.2).

**Test**:
- Unit: `loadtest/__tests__/socket-farm.test.ts` — (1) cap retry 5 liên tiếp chưa từng connected; (2) **everConnected 5 liên tiếp → failed (ĐỔI)**; (3) **consecutive reset (THÊM)**; (4) `emitTick` khi có user failed: counters không tăng fail thêm, `usersFailed` đúng; (5) scheduler bỏ qua user failed; (6) disconnect sau failed không đổi phase.
- G2 mutation scoped socket-farm connect handler ≥ 60% critical.

**Critics**: Code Reviewer (correctness), Realtime Collaboration Engineer (socket.io reconnect semantics — `io.reconnect(false)`), SRE (tương tác E3 restart/backoff + heartbeat), Security (F-1: cap mọi user — false-positive còn sót).

**Effort**: L

---

### T4 — Phân loại connect fail + errorSamples 'connect' + counters by-type + SANITIZER CHUNG (socket-farm.ts + logger.ts + sanitize.ts)
**Producer**: Realtime Collaboration Engineer

**Mô tả**: PRD M4 + **DESIGN §3 (sanitizer F-2..F-5)** — `loadtest/socket-farm.ts` + `loadtest/logger.ts` + file mới `loadtest/sanitize.ts`:
- File mới `loadtest/sanitize.ts`: export pure `sanitizeLogText(raw: unknown, maxLen = 1000): string` — (1) strip control chars `[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]` + `\r?\n` → space (F-3 — chống log injection dòng giả); (2) redact URL credential (user:pass@host + query secret keys) (F-5); (3) key=value nhạy cảm KHÔNG cần word-boundary trước key (`access_token|api[_-]?key|jwt|session_id?|sid|sig|password|passwd|pwd|token|secret|otp|authorization|refreshToken|refresh_token`) (F-5); (4) token trần: JWT 3-part (không bắt buộc prefix `eyJ`), 2-part session (`body.sig`), hex ≥ 32 → `[REDACTED]` (F-5); (5) cap `maxLen`.
- `'connect_error'` handler: `const t = classifyConnectError(err);` → tăng `runtimeStats.connectFailsByType[t]++`; record vào errorSamples qua callback worker với `action: 'connect'` (T3 đã chốt counters).
- Export pure `classifyConnectError(err: unknown): ConnectFailType` (DESIGN §6) — thứ tự: timeout (`type==='TimeoutError'`/`/timeout/i`) → transport (`/xhr poll error|transport/i`) → reject (`/websocket error|server|handshake|reject/i` — gồm auth-reject vì client không expose HTTP status, PRD §6.1) → other. **Không throw với mọi input** (null/string/thiếu field/control chars — fuzz ST-5).
- **Sanitizer áp tại 3 sink** (DESIGN §3):
  - `recordError` (dòng 661-665): thêm param `action: ErrorSample['action'] = 'chat'` (backward compat); **`code = sanitizeLogText(code, 64)`** (F-4 — code không slice trước đây → errorSamples/TOP ERRORS/report file) + **`message = sanitizeLogText(message, 160)`** (F-2/F-3 — thay `slice(0,160)`).
  - **`lastError` mọi lần gán** (dòng 156 connect_error, :193 chat:error, :370/:657): `this.lastError = sanitizeLogText(raw, 160)` (F-2 — bảng users / GET /users không nhận text thô).
  - `logger.ts` `redactMsg` (dòng 127-135): thay khối regex bằng `sanitizeLogText(s, 1000)` (giữ bước `redactSensitiveFields`); strip control chars ngay đây → ring buffer/console/subscriber/DB log_events đều được lợi (F-3).
- `emitTick` (dòng 671-678): đếm `failed` trong vòng phase-counting → `counters.usersFailed`.

**Acceptance criteria**:
- `classifyConnectError` trả đúng 4 loại với mock err + fuzz không throw (ST-5).
- Mỗi `connect_error` → 1 mẫu errorSamples `action: 'connect'` (cap 20 giữ) + byType tăng đúng loại.
- **errorSamples/lastError/TOP ERRORS không chứa newline/JWT/password/URL-credential/control chars (ST-6 mở rộng code + F-2/F-4)**.
- **`redactMsg` strip control chars — log không có dòng giả (F-3)**.
- `WorkerTick.counters.connectFailsByType` + `usersFailed` có giá trị thật.
- Error cũ (chat/rest) không đổi code/action (trừ message/code đi qua sanitize — không đổi behavior hợp lệ).

**Test**:
- Unit: `socket-farm.test.ts` — classify 6-8 case + fuzz (ST-5); record action 'connect'; sanitize message+code (ST-6); lastError sanitized; byType + usersFailed trong tick; `logger.test.ts` — redactMsg strip control + regex bypass từng loại (ST-10 mở rộng).
- G1 full suite xanh (recordError signature cũ vẫn pass).

**Critics**: Code Reviewer (correctness), AppSec (sanitizer sink coverage + bypass regex), Backend Architect (path recordError/errorSamples cap + lastError), Test Automation Engineer (fuzz + ST coverage).

**Effort**: M

---

### T5 — Wire window wall-clock vào coordinator + log E2 breakdown + REORDER auto-stop (coordinator.ts)
**Producer**: Backend Architect

**Mô tả**: PRD M1 (wiring) + M5. **Bám DESIGN §7 (PF1 skip-first-tick, BE-4 reorder, BE-3 windowSec thật, SEC-1/F-7 nhãn)** — `loadtest/coordinator.ts`:
- State mới: `prevConnectCumulative = new Map<number, { attempts; fails; byType }>()` + `windowBuckets: ConnectWindowBucket[] = []` + `lastWindow` (DESIGN §7.1).
- Trong `aggregateTick` (nhánh ramping/steady, thay khối 531-536):
  - Diff per-worker: **SKIP tick đầu** khi `prevConnectCumulative` chưa có entry (worker mới spawn / vừa restart — chống bucket phình 2-15s, PF1) → `prev = snapshot(tick); continue;`.
  - Delta **clamp ≥ 0** cho cả attempts/fails/byType (S2/ST-3 — restart race không được tạo rate âm giấu outage).
  - `windowBuckets = rollWindow(windowBuckets, { ts: now, attempts: dA, fails: dF, byType: dByType }, now)`; `lastWindow = sumWindow(...)`.
  - `agg.tick.rates.connectFailRate = connectFailRateFromWindow(lastWindow)` — **TRƯỚC `pushTick`** (dashboard AC-6).
- **REORDER (BE-4)**: di chuyển khối auto-stop E2/E3 (hiện :513-558) lên TRƯỚC phase-advance (:497-511) — duration hết đúng tick mà window vượt ngưỡng → E2 thắng natural-end (status 'error'), không lọt 'finished'. Thứ tự: Bước A + pushTick → periodic 15s → E2 decide + E3 checks → phase-advance.
- E2 decide: `decideAutoStop({ phase, registerFailRate: 0, connectFailRate, registeredTotal: 0, connectTotal: lastWindow.attempts })`.
- Log E2 (thay dòng 544-547) — **8 trường format chuẩn DESIGN §6** (hàm pure `formatE2Log`):
  `E2: ${decision.reason} | phase=<phase> elapsedSec=<s> windowSec=<span THẬT> windowAttempts=<w.a> windowFails=<w.f> byType=timeout:<n>,transport:<n>,reject:<n>,other:<n> usersFailedCum=<sum ticks> workersAlive=<farm.alive> workersTotal=<farm.total>`
  - `byType` = **window.byType** (SEC-1 — sum 4 loại == windowFails); `usersFailed` = cumulative, suffix **`Cum`** (F-7).
- **stopReason bắt đầu `E2:`** (AC-2 — code hiện tại coordinator.ts:546 truyền `decision.reason` bắt đầu `auto-stop:` → vỡ AC-2): `finishRun('auto', \`E2: ${decision.reason}\`, false)`.
- `handleWorkerDied` (dòng 103-119): thêm `prevConnectCumulative.delete(workerId)` (để skip-first-tick phát huy).
- `resetRunState` (dòng 211-233): clear `prevConnectCumulative` + `windowBuckets` + `lastWindow` (ST-4).

**Acceptance criteria**:
- AC-2: mô phỏng (unit/integration) window đủ ≥ 50 attempts với rate 100% → `finishRun('auto', reason bắt đầu 'E2:')` trong ≤ 60s kể từ khi window đủ mẫu.
- AC-3: window chưa đủ 50 attempts → không evaluate (không gọi finish, không log E2).
- AC-4: log E2 chứa đủ 8 trường (grep/assert + regex ST-7).
- Rate phục hồi: fail đầu run trôi khỏi window sau 60s **wall-clock** → run không auto-stop nhầm khi gateway khỏe lại.
- **BE-4**: tick duration hết + rate > 30% → auto-stop thắng (không 'finished').
- **ST-3**: diff clamp âm — restart worker → rate ≥ 0, E2 vẫn trigger với fail thật sau đó.

**Test**:
- Unit: `loadtest/__tests__/coordinator.test.ts` — mô phỏng `aggregateTick` qua nhiều giây: (a) spike 5s rồi sạch → hết 60s wall-clock rate ~0, không stop; (b) fail liên tục 100% → stop `E2:`; (c) window < 50 attempts → không stop; (d) log E2 assert 8 field + regex (ST-7); (e) skip-first-tick sau restart + clamp âm (ST-3); (f) resetRunState (ST-4); (g) **BE-4 duration-boundary**; (h) **BE-1 ramp thấp** (1/s → stop sau ~50 tick). (DESIGN §9 T5)
- G1 full suite; G2 mutation scoped `coordinator.ts` E2 block ≥ 60% critical.

**Critics**: Code Reviewer (correctness + reorder), SRE (auto-stop vẫn là thật — không false negative), Performance Benchmarker (evict theo age + skip-first — chi phí O(workers + 120)/tick), Statistician (window span thật + boundary).

**Effort**: M

---

### T6 — UI: LoadTestTick mirror + dashboard "Connect fail %" + breakdown (frontend)
**Producer**: Frontend Developer

**Mô tả**: PRD M6 (UI part) — bám **`docs/UI-SPEC-loadtest-e2-connect-fail.md` (CHÍNH THỨC)** + field T1 đã chốt (không tự sửa tên):
- `src/types/loadtest.ts:123-151` — mirror `LoadTestTick`: counters thêm `connectAttempts/connectFails/connectFailsByType/usersFailed`, rates thêm `connectFailRate`, thêm `hasConnectData?: boolean`.
- `src/pages/loadtest/LiveDashboardPage.tsx` (Màn 2):
  - KPI tile mới "Connect fail" — value `rates.connectFailRate.toFixed(1)%`, hint "(cửa sổ 60s)"; **`--` chỉ khi `!lastTick` hoặc `lastTick.hasConnectData === false`** (UI-3); variant: `>= 30` error, `>= 5` warning, else success, `default` khi attempts 0; grid 8 → 9 (`xl:grid-cols-9`).
  - **Sparkline tile mới = SVG polyline thủ công** (PF2 — KHÔNG recharts thứ 5; guard `?? 0`; replay bỏ qua).
  - Card "CONNECT FAIL BREAKDOWN": 4 mục byType, **tổng = sum(byType)** (UI-2), nhãn "lũy kế" + chú thích giảm khi worker restart (BE-2); danger strip `rate >= 30 && ramping/steady`; empty states theo **`hasConnectData`** (UI-1: replay → "Run lịch sử không lưu dữ liệu connect", không dùng "đang chờ").
  - PhaseDonut: slice `'failed'` từ `counters.usersFailed`, trừ khỏi notConnected (bất biến tổng = usersCreated).
- `docs/UI-SPEC-loadtest-tool.md:543-563` (§4.1) — cập nhật contract `LoadTestTick` + KPI mới.
- Component test: `src/pages/loadtest/LiveDashboardPage.test.tsx` — 6 case (UI-SPEC §6, gồm hasConnectData replay).

**Acceptance criteria**:
- AC-6: mở Màn 2 trong run → KPI "Connect fail" + breakdown visible; tick mới từ WS render đúng.
- Frontend build/lint xanh; replay (`toMetricTick`, `hasConnectData: false`) không crash, không "đang chờ" giả, tile `--`.
- Mobile responsive (grid tile xếp 2 cột mobile).
- Playwright: `./qa-playwright-capture.sh http://localhost:8000 public/qa-screenshots` — ảnh Màn 2 có KPI mới (bằng chứng G7).

**Test**:
- Unit/component: LiveDashboardPage.test.tsx (render + KPI + breakdown + empty states + donut).
- G4: `npm run lint` + build frontend.

**Critics**: Code Reviewer (correctness), UI Finish-Gate Reviewer (dashboard không generic — đúng UI-SPEC), Data Visualization Engineer (breakdown đọc được, tổng nhất quán sum(byType)), Performance Benchmarker (SVG polyline — không chart thứ 5).

**Effort**: M

---

### T7 — Integration + acceptance: mock gateway, regression, bằng chứng AC
**Producer**: Test Automation Engineer

**Mô tả**: PRD §5 Integration + AC-1..AC-7 + **DESIGN §9 T7 (ST-9/ST-11/ST-12 + BE-1/BE-4)**:
- Extend `loadtest/__tests__/mock-gateway.ts`: option reject ws handshake cho token không trong allowlist (server disconnect ngay → client nhận `connect_error`) — mô phỏng "token lỗi vĩnh viễn" + **option gửi `connect_error` packet message độc qua middleware `next(new Error('độc'))`** (ST-12 — phản ánh đúng vector log-injection; server-disconnect thuần chỉ cho message generic).
- Integration (pattern `e2e-mock-gateway.test.ts` — chạy local, FakeRedis + Recording DbWriter): 1 worker × 100 users:
  - (a) 100% token OK → run finished, connectFailRate window ~0.
  - (b) 5% token lỗi → run finished, KHÔNG E2 (AC-1), 5 user phase `'failed'`, `usersFailed = 5`.
  - (c) 100% token lỗi → run tự dừng (status 'error') ≤ 60s kể từ window đủ mẫu, `stopReason` bắt đầu `E2:` (AC-2), log E2 đủ 8 trường (AC-4 + regex ST-7).
- **ST-12**: gateway gửi message độc → ring buffer không dòng log giả, errorSamples/lastError đã sanitize, TOP ERRORS không bị phá (F-2/F-3/F-4 e2e).
- Regression (AC-7): E1 (register fail > 50% — decideAutoStop E1 test giữ nguyên), E3 (kill 1 worker giữa run → restart → không auto-stop nhầm — coordinator/worker-farm test hiện có + scenario mới với mock), **BE-4 (duration hết + rate > 30% → auto-stop thắng)**, **BE-1 (ramp thấp: E2 fire chậm đúng bounded, không fire khi window chưa đủ 50)**.
- **ST-9**: auth regression — `/metrics`, `/errors`, `/users` không token → 401; có token → 200 + field mới hiện diện.
- **ST-11**: gate secret hygiene (pre-flight, không unit): `git ls-files | grep -iE 'users_accounts|accounts-|auth-secret'` rỗng + gitleaks scan sạch (F-6 debt — cùng window release).
- AC-3: test đơn vị window < 50 attempts (đã ở T2/T5) + note không có log E2 trong 5s đầu khi fail lẻ tẻ.
- AC-5 + AC-1/AC-2 ở 10k thật: script chạy (3 kịch bản env TEST allowlist — config.ts:151-154), checklist thu bằng chứng cho G7: log run (`stopReason`, rate window), dashboard screenshot, breakdown khi có fail. **10k runs = manual validation gate** (không tự chạy trong CI).
- G7 evidence bundle: kết quả 3 kịch bản mock-gateway (log + assert), Playwright screenshots (T6), log AC-2 grep `E2:` 8 trường, ST-12 sanitize e2e.

**Acceptance criteria**:
- 3 kịch bản (a)(b)(c) xanh trong CI (local, không cần gateway/Postgres/Redis thật) + ST-9/ST-12.
- AC-1..AC-7 map: (a)→AC-5 nhỏ, (b)→AC-1, (c)→AC-2+AC-4, regression→AC-7 (kèm BE-4/BE-1), dashboard→AC-6, window unit→AC-3.
- G1 full suite 0 skip; G2 mutation ≥ 60% critical (full critical scope); G4 lint/build; G6 Code Reviewer PASS; G7 Reality Checker có đủ bằng chứng (mock e2e logs + run thật + screenshots).

**Test**: như trên.

**Critics**: Code Reviewer (mock gateway + test quality), Test Automation Engineer (scenario coverage/flake), AppSec (ST-12 vector thật), Reality Checker (bằng chứng AC — default NEEDS WORK).

**Effort**: L

---

## 3. Đồ thị phụ thuộc

```
T1 (contract types) ──┬──► T2 (window wall-clock pure + threshold) ─┐
                      ├──► T3 (cap retry mọi user + skip failed) ──► T4 (classify + byType + sanitizer) ─┐
                      │                                                              ├──► T7 (integration + AC evidence)
                      ├──► T6 (UI mirror + dashboard) ───────────────────────────────┤
                      └──────────────────────────────────► T5 (coordinator wiring + E2 log) ──► T7
```

- T1 → mọi task (mọi task dùng field mới).
- T2 → T5 (helper window). T3 → T4 (cùng file socket-farm.ts, tuần tự). T4 → T5 (log E2 cần byType/usersFailed từ worker). T6 song song T2-T5 (chỉ chạm frontend). T7 → tất cả.

## 4. Kế hoạch test & HARD-GATE

| Task | Unit test | Integration | G1 | G2 | G4 | G6 | G7 |
|---|---|---|---|---|---|---|---|
| T1 | types-contract + aggregateTicks merge | — | xanh | — | lint+build | PASS | — |
| T2 | decideAutoStop window/boundary, rollWindow/sumWindow | — | xanh | coordinator-state ≥60% | lint | PASS | — |
| T3 | cap retry MỌI user, consecutive reset, skip failed, emitTick usersFailed | — | xanh | socket-farm connect ≥60% | lint | PASS | — |
| T4 | classifyConnectError fuzz, record 'connect', sanitizer 3 sink, byType, lastError | — | xanh | — | lint | PASS | — |
| T5 | window wall-clock (spike/sạch, stop, <50, log 8 field+regex, BE-4, BE-1, ST-3/ST-4) | — | xanh | coordinator E2 ≥60% | lint+build | PASS | — |
| T6 | LiveDashboardPage.test.tsx | — | xanh | — | lint+build FE | PASS | Playwright screenshot |
| T7 | (kế thừa) | mock gateway a/b/c + regression E1/E3 | xanh 0 skip | full critical ≥60% | lint+build | PASS | evidence bundle (AC-1..7) |

- **G1**: `vitest` full suite xanh, 0 skip — mỗi task sau khi merge phải giữ nguyên.
- **G2**: `vitest.mutation.config.ts` — mutation ≥ 60% critical cho logic mới (T2/T3/T5), full tại T7.
- **G4**: lint + build cả 2 phía (loadtest backend + frontend).
- **G6**: Code Reviewer PASS từng task (là lens correctness của mọi task).
- **G7**: Reality Checker — default NEEDS WORK; bằng chứng = 3 kịch bản mock-gateway logs, run thật AC-1/2/5 (env TEST allowlist — KHÔNG production), Playwright screenshots Màn 2, log E2 8 trường.
- Quy tắc chung: không background process, không server startup commands (giả định dev server đang chạy).

## 5. Nhóm task theo Phase 3 build rounds

| Round | Task | File bị chạm (không chồng nhau trong round) |
|---|---|---|
| R1 | **T1** (contract) | types.ts, coordinator.ts, coordinator-state.ts, socket-farm.ts (init counters), api-mappers.ts, tests |
| R2 | **T2 ∥ T3 ∥ T6** (3 task song song) | T2: coordinator-state.ts · T3: socket-farm.ts · T6: src/types/loadtest.ts, LiveDashboardPage.tsx, UI-SPEC |
| R3 | **T4** | socket-farm.ts (sau T3 cùng file — bắt buộc tuần tự), **logger.ts, sanitize.ts (MỚI — sanitizer chung)** |
| R4 | **T5** | coordinator.ts |
| R5 | **T7** | mock-gateway.ts, e2e-mock-gateway.test.ts, scripts, evidence |

Trong mỗi round không task nào chạm file của task khác. T1 đứng riêng vì chạm 4 file backend + mọi constructor. R3 mở rộng: sanitizer chung (DESIGN §3) chạm thêm `logger.ts` + file mới `sanitize.ts` — KHÔNG thêm task riêng (gộp T4).

## 6. Rủi ro plan

- **R1 — LoadTestTick thêm field → DB replay**: `api-mappers.toMetricTick` dựng tick từ cột MetricSample (không có cột mới) → replay hiển thị connect fail 0/0% + **`hasConnectData: false`** (UI phân biệt được — UI-1 đã xử lý). Chấp nhận MVP; migration cột = v1.1 (sửa lockstep 3 nơi: toMetricSample / store INSERT+SELECT / toMetricTick — dùng constants cột chung, PF4).
- **R2 — Đổi semantics `connectTotal` (10 → 50, window)**: vỡ test boundary cũ (coordinator-state.test.ts:134-148) — T2 cập nhật có chủ đích; E1 không đổi.
- **R3 — Mô hình đếm (chốt DESIGN §5 — F-1 mở rộng)**: đếm mọi `connect_error` đến khi cutover phase 'failed', **tối đa 5 fail/user áp MỌI user kể cả đã từng connected** (trước đây chỉ user chưa từng connected → token hết hạn giữa run = fail vô hạn = tái hiện bug gốc). AC-1: 2500 fails/12.500 attempts = **20.0%** < 30% ✓ · AC-2: 50k/50k = 100% ✓ · F-1 scenario (500 user hết hạn giữa run): 20.0% ✓. AC-1/AC-2 tests là trọng tài; producer bám DESIGN §5.
- **R4 — Dừng reconnect socket.io**: `socket.disconnect()` chưa chắc chặn manager reconnect; bắt buộc dùng cả `socket.io.reconnect(false)` + test "không còn connect_error sau failed".
- **R5 — `connect_error` không expose HTTP status** (PRD §6.1): classification heuristic; sai loại chỉ ảnh hưởng breakdown display, KHÔNG ảnh hưởng rate/auto-stop — chấp nhận.
- **R6 — Worker chết/restart giữa window**: xóa `prevConnectCumulative` khi died + **skip tick đầu sau restart** (delta 0 — chống bucket phình 2-15s, PF1) + clamp delta âm (S2/ST-3); contribution cũ trôi khỏi window theo wall-clock ≤ 60s.
- **R7 — Drift type FE/BE**: T1 (backend) và T6 (frontend) 2 PR riêng — không có type-check chéo; T6 bám DESIGN §2/UI-SPEC (không tự đặt tên), types-contract.typecheck.ts 2 chiều + Playwright gate.
- **R8 — AC-5/10k cần môi trường test + thời gian run**: manual gate; CI chỉ chạy mock-gateway. Không tự ý chạy production.
- **R9 (MỚI) — BE-4 duration-boundary**: phase-advance chạy sau E2 block (reorder T5) — duration hết + rate > 30% → auto-stop thắng; test bắt buộc.
- **R10 (MỚI) — BE-1 ramp thấp**: ramp < 1/s → E2 phản ứng chậm (~attempts/rate giây, cửa sổ "mù" dài hơn) — giới hạn tham số chấp nhận (PRD §6.6), test low-ramp + tài liệu hóa.
- **R11 (MỚI — F-6) — Credential files**: `users_accounts.json` + `loadtest/data/accounts-*.json` (14MB × 2 chứa refreshToken 10k user production) — gitignore KHÔNG phải security control; defer khỏi fix E2 nhưng gate CI (gitleaks + `git ls-files` grep) + move-out + rotate trong **cùng release window** (pre-flight đã nợ: sync OTP/DB password/gateway handshake.auth/gitleaks).
- **R12 (MỚI — F-8)**: window < 50 attempts → `connectFailRate = 0` hiển thị xanh đầu ramp — giảm thiểu bằng hint + variant `default`; field `connectWindowAttempts` → v1.1.

## 7. Ước lượng effort

| Task | Effort | Lý do |
|---|---|---|
| T1 | M | Contract + hasConnectData + 4 compile-site + test shape |
| T2 | S | Window wall-clock pure + threshold — testable |
| T3 | L | Cap mọi user (F-1) + socket.io reconnect semantics + guards + 6 unit test |
| T4 | M | Classify + sanitizer chung 3 sink (sanitize.ts + logger.ts) + fuzz/ST tests |
| T5 | M | Window wiring + reorder + log 8 field + 8-10 test mô phỏng |
| T6 | M | Type mirror + 2 component UI + hasConnectData empty state + doc + test |
| T7 | L | Mock gateway extend + 3 scenarios + ST-9/12 + regression BE-4/BE-1 + evidence |
| **Tổng** | **1S + 4M + 2L** | ~8 ngày dev (1 producer/task, rounds R1→R5) |

## 8. Map MVP → task (không bỏ mục nào)

M1→T2+T5 · M2→T2 · M3→T3 · M4→T4 · M5→T5 · M6→T1+T4+T6 · M7→T3 · M8→mọi task + T7.
AC-1→T3+T5+T7(b) · AC-2→T5+T7(c) · AC-3→T2+T5+T7 · AC-4→T5+T7(c)+ST-7 · AC-5→T7(10k) · AC-6→T6+T7 · AC-7→T3+T5(BE-4)+T7.
Security ST: ST-1→T2 · ST-2→T2 · ST-3→T5 · ST-4→T5 · ST-5→T4 · ST-6→T4 · ST-7→T5 · ST-8→T3 · ST-9→T7 · ST-10→T4 · ST-11→T7(pre-flight) · ST-12→T7.
