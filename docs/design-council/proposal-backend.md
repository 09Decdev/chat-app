# Proposal — Backend Architect · E2 connect-fail fix (T1 + T2 + T5)

**Nguồn**: `docs/PRD-loadtest-e2-connect-fail.md` (M1-M8, AC-1..AC-7) · `docs/PLAN-loadtest-e2-connect-fail.md` (T1/T2/T5)
**Vai trò**: đề xuất design T1 (contract), T2 (window pure), T5 (wiring + log E2); nhận xét ngắn T3/T4 từ góc backend.
**Trạng thái**: đề xuất — chờ council phản biện. KHÔNG code.

---

## 0. Tóm tắt quyết định chính (TL;DR)

1. **T1** — Contract additive: `LoadTestTick.counters` thêm `connectAttempts/connectFails/connectFailsByType/usersFailed`, `rates` thêm `connectFailRate`. `toMetricSample` (writer.ts) không cần sửa (pick field tường minh), DB không có cột mới (R1 chấp nhận — replay = 0).
2. **T2** — 2 hàm pure `rollWindow`/`sumWindow` + hằng số `E2_MIN_ATTEMPTS = 50` đặt trong `coordinator-state.ts`; `decideAutoStop` đổi ngưỡng E2 `>= 50` với semantics `connectTotal` = attempts TRONG window. Window bucket mang theo `byType` (lệch nhỏ so với PLAN, có chủ đích — log E2 nhất quán nội bộ).
3. **T5** — Diff cumulative per-worker (`prevConnectCumulative` Map) → delta mỗi tick → `rollWindow` → rate gán vào `agg.tick.rates.connectFailRate` TRƯỚC `pushTick`. **Phát hiện mới**: stopReason E2 hiện tại bắt đầu bằng `auto-stop:` chứ không phải `E2:` (coordinator.ts:546) → vi phạm chữ nghĩa AC-2; T5 phải prefix `E2: ${reason}`.
4. **AC-1 vs AC-2** — Xác nhận mô hình PLAN R3 (bounded ≤ 5 fail/user) đáp ứng cả 2 về mặt số: AC-1 = 20.8% < 30% ✓, AC-2 = 100% ✓. Chữ "chỉ đếm 1 fail/window" trong AC-1 là tàn dư của M3 cũ, giữ nghĩa đen thì AC-2 vỡ toán học.
5. Log E2 8 trường (AC-4): `phase, elapsedSec, windowSec, windowAttempts, windowFails, byType{4}, usersFailed, workersAlive/Total` — định nghĩa chính xác + format ở mục 3.3.

---

## 1. T1 — Contract: connect metrics vào types + fix compile-sites

### 1.1 Định nghĩa mới trong `loadtest/types.ts` (additive — không đổi field cũ)

Chèn sau khối `ErrorSample` (~types.ts:130) — `ConnectFailType` là union hẹp, dùng cho cả `byType` counters lẫn T4 `classifyConnectError`:

```ts
export type ConnectFailType = 'timeout' | 'transport' | 'reject' | 'other';
export interface ConnectFailsByType {
  timeout: number;
  transport: number;
  reject: number;
  other: number;
}
/** Giá trị zero cho byType — dùng mọi nơi init counters. */
export const EMPTY_CONNECT_FAILS: ConnectFailsByType = { timeout: 0, transport: 0, reject: 0, other: 0 };
```

**`WorkerTick.counters`** (types.ts:93-110) — thêm 2 field (2 field cũ `connectAttempts/connectFails` đã có tại :108-109):

```ts
connectFailsByType: ConnectFailsByType; // cumulative per-worker (T4 tăng)
usersFailed: number;                    // số user phase='failed' (T4 đếm trong emitTick)
```

**`LoadTestTick.counters`** (types.ts:161-177) — thêm 4 field (hiện KHÔNG có field connect nào — PRD §1.1.7):

```ts
connectAttempts: number;      // tổng window? KHÔNG — CUMULATIVE toàn run (tick là snapshot)
connectFails: number;         // cumulative
connectFailsByType: ConnectFailsByType;
usersFailed: number;
```

**`LoadTestTick.rates`** (types.ts:178) — thêm:

```ts
rates: { successRate: number; echoRate: number; connectFailRate: number }; // 0-100, window 60s, coordinator tính mỗi tick
```

Lưu ý semantics quan trọng: `counters.connectAttempts/connectFails` trong LoadTestTick là **cumulative toàn run** (snapshot — khớp mọi counter khác); `rates.connectFailRate` là **rate window 60s** (giá trị quyết định E2). Không trộn 2 khái niệm vào 1 field — dashboard hiển thị rate, report/context dùng cumulative.

### 1.2 Compile-sites phải sửa (đã xác minh từng chỗ)

| # | Nơi | Hiện trạng (file:dòng) | Sửa |
|---|---|---|---|
| 1 | **Provisioning tick** — `coordinator.ts:428-443` | counters literal không có field connect | thêm `connectAttempts: 0, connectFails: 0, connectFailsByType: {...EMPTY_CONNECT_FAILS}, usersFailed: 0`; `rates` thêm `connectFailRate: 0` |
| 2 | **`aggregateTicks`** — `coordinator-state.ts:89-93` (C init) + `:104-144` (loop) + `:165-181` (tick build) + `:182-185` (rates) | C không có field connect; loop không sum | C init thêm 4 field zero; loop thêm `C.connectAttempts += t.counters.connectAttempts; C.connectFails += t.counters.connectFails;` + merge byType theo từng key + `C.usersFailed += ...`; tick build thêm field; `rates.connectFailRate: 0` (coordinator T5 sẽ override TRƯỚC pushTick) |
| 3 | **`WorkerRuntime.counters` init** — `socket-farm.ts:435-440` | không có 2 field mới | thêm `connectFailsByType: {...EMPTY_CONNECT_FAILS}, usersFailed: 0`. `emitTick` (`:724` `counters: { usersTotal, ...this.counters }`) spread tự mang theo — **KHÔNG sửa logic ở T1** |
| 4 | **`toMetricTick` (DB replay)** — `api-mappers.ts:42-79` | counters thiếu field; `rates` thiếu | thêm 4 field default 0 + `rates.connectFailRate: 0` — DB không có cột (R1: replay lịch sử hiển thị 0, chấp nhận MVP) |
| 5 | **Frontend mirror** — `src/types/loadtest.ts:129-152` | `counters`/`rates` thiếu | T6 bám CHÍNH XÁC tên field ở 1.1 (không tự đặt tên — R7) |

**KHÔNG cần sửa** (đã kiểm tra):
- `db/writer.ts:412-441` `toMetricSample` — pick field tường minh theo cột, KHÔNG spread `t.counters` → field mới bị bỏ im lặng, không vỡ compile, không vỡ INSERT (cột `metric_samples` không đổi — store.ts:59-86, 381-401). Đây là điểm mấu chốt cho R1: DB writer impact = **0** ở MVP.
- `WorkerTick` IPC: child_process fork dùng structured clone — field số thuần không ảnh hưởng.
- `LoadTestTick` HTTP/WS: JSON serialization — field số thuần, không cần map.
- `VirtualUser.runtimeStats` (`socket-farm.ts:205`) — shape `{connectAttempts, connectFails}` đổi sang có `connectFailsByType` là việc của **T4** (T1 chỉ chốt contract để T4 implement đúng tên field).

### 1.3 Ripple — ai vỡ khi thêm field

Field mới là **required** trong interface TS → mọi literal tick thủ công trong test vỡ compile. Danh sách đã soi:
- `loadtest/__tests__/coordinator-state.test.ts:5-27` — `fakeTick()` phải thêm 2 field counters.
- `loadtest/__tests__/types-contract.typecheck.ts` — nếu có cross-assign LoadTestTick — cần bổ sung assert field mới (2 chiều BE↔FE).
- `loadtest/__tests__/e2e-mock-gateway.test.ts`, `int.test.ts`, `api-server.test.ts` — nơi nào dựng `LoadTestTick`/`WorkerTick` thủ công.
- Không đổi field cũ, không đổi behavior → test cũ xanh trừ shape bắt buộc.

---

## 2. T2 — Sliding window 60s pure + threshold 50

### 2.1 Vị trí & hằng số

Đặt trong `loadtest/coordinator-state.ts` (cùng file `decideAutoStop` — cùng semantics E2, giữ pattern "logic pure tập trung 1 file test được"; mutation scope G2 đã trỏ file này — T2 tự nhiên nằm trong scope). Tái dùng **pattern** ring buffer của E3 (`workerDeathTimes` — coordinator.ts:104-106: push + shift theo cutoff), nhưng dạng **bucket delta** thay vì timestamp — lý do: cần sum attempts/fails chứ không chỉ đếm số sự kiện.

```ts
/** Delta connect của 1 tick 1s (worker đã diff — coordinator T5). */
export interface ConnectWindowBucket {
  attempts: number;
  fails: number;
  byType: ConnectFailsByType;
}
export const E2_WINDOW_BUCKETS = 60;   // 60 tick × 1s = cửa sổ 60s
export const E2_MIN_ATTEMPTS = 50;     // threshold M2 — thay 10 cumulative (PRD §3 M2, §6.6)

export function rollWindow(
  buckets: ConnectWindowBucket[],
  entry: ConnectWindowBucket,
  max = E2_WINDOW_BUCKETS,
): ConnectWindowBucket[]

export function sumWindow(
  buckets: ConnectWindowBucket[],
): { attempts: number; fails: number; byType: ConnectFailsByType }

export function connectFailRateFromWindow(
  sum: { attempts: number; fails: number },
  minAttempts = E2_MIN_ATTEMPTS,
): number // 0-100; 0 khi attempts < minAttempts
```

**Lệch nhỏ so với PLAN T2** (`WindowBucket = {attempts, fails}`): bucket mang thêm `byType` (4 số). Lý do: (a) log E2 AC-4 yêu cầu "fails theo loại" — nếu lấy byType cumulative thì log mâu thuẫn nội bộ (tổng 4 loại ≠ windowFails); (b) dashboard breakdown đồng bộ với window; (c) chi phí ~0. T2 vẫn thuần test được như PLAN.

### 2.2 Thuật toán (spec chính xác)

```ts
export function rollWindow(buckets, entry, max = 60) {
  // PURE: không mutate input (test assert immutability)
  const next = [...buckets, entry];
  while (next.length > max) next.shift(); // O(max) ≤ 60 — rẻ
  return next;
}

export function sumWindow(buckets) {
  let attempts = 0, fails = 0;
  const byType = { ...EMPTY_CONNECT_FAILS };
  for (const b of buckets) {
    attempts += b.attempts;
    fails += b.fails;
    byType.timeout += b.byType.timeout;
    byType.transport += b.byType.transport;
    byType.reject += b.byType.reject;
    byType.other += b.byType.other;
  }
  return { attempts, fails, byType };
}
```

### 2.3 Edge cases & giới hạn bộ nhớ

| Case | Hành vi | Test |
|---|---|---|
| Window rỗng | `sumWindow([])` → `{0, 0, zeros}`; rate 0; `decideAutoStop` không stop (attempts 0 < 50) | unit |
| Window đầy (60) | push entry 61 → shift entry 1; sum = 60 mới nhất | unit |
| Push 65 entries | length giữ ≤ 60; sum = 5 cuối (không leak phần tử quá hạn) | unit |
| `max` tùy chỉnh | `rollWindow(b, e, 10)` → length ≤ 10 (test param) | unit |
| **Bộ nhớ** | 60 bucket × ~50 byte ≈ **~3 KB** toàn run; `prevConnectCumulative` ≤ workerCount entry (~16 × 64 B). Không có ràng buộc nào đáng lo (PRD §6.5 xác nhận chi phí không đáng kể) | — |
| Tick bị bỏ lỡ (coordinator GC pause / worker stall 8s → kill) | delta gộp N giây vào 1 bucket → window trượt tối đa vài giây; rate vẫn đúng về mặt sự kiện. Chấp nhận (bounded, R6) | ghi rõ comment |
| Delta âm (worker restart reset counter) | KHÔNG xử lý ở T2 — T5 guard (mục 3.2) | — |

### 2.4 `decideAutoStop` (coordinator-state.ts:56-64)

```ts
export function decideAutoStop(input: AutoStopInput): StopDecision {
  if (input.registerFailRate > 50 && input.registeredTotal >= 10) { ... } // E1 — KHÔNG đổi
  // E2: connectTotal giờ = attempts TRONG window 60s (semantics đổi — PRD §6.6).
  // Rate 0 khi window chưa đủ 50 attempts (AC-3) — coordinator gửi rate từ connectFailRateFromWindow.
  if (input.connectFailRate > 30 && input.connectTotal >= E2_MIN_ATTEMPTS) {
    return { stop: true, reason: `auto-stop: connect fail ${input.connectFailRate.toFixed(0)}% > 30% (E2)` };
  }
  return { stop: false };
}
```

- Threshold: `> 30` (strict — boundary 30% KHÔNG stop, giữ test cũ :133-149) + `>= 50` (thay 10).
- Ghi comment dòng 42-46 cho đúng spec đã hứa ("cửa sổ 60s" — giờ là sự thật).
- `AutoStopInput` interface không đổi field — `connectTotal` đổi semantics (documented). E1 giữ `registeredTotal >= 10`.
- KHÔNG cấu hình hóa ngưỡng (PRD §6.6).

---

## 3. T5 — Wiring window vào coordinator + log E2 breakdown

### 3.1 State mới trong `LoadTestCoordinator`

Cạnh `workerDeathTimes` (coordinator.ts:67):

```ts
/** Cumulative connect của tick MỚI NHẤT từng worker — diff ra delta mỗi tick (T5). */
private prevConnectCumulative = new Map<number, { attempts: number; fails: number; byType: ConnectFailsByType }>();
/** Sliding window 60s — bucket delta 1 tick (T2). */
private windowBuckets: ConnectWindowBucket[] = [];
```

### 3.2 Luồng `aggregateTick` (thay khối cumulative :531-536)

**Bước A — hoist computation lên TRƯỚC `pushTick` (:484)**, trong guard `phase === 'ramping' || 'steady'` (giữ nguyên guard hiện tại :514):

```ts
if (this.phase === 'ramping' || this.phase === 'steady') {
  // 1. Diff cumulative per-worker — KHÔNG double-count:
  //    mỗi tick worker đọc đúng 1 lần (prev lưu tick mới nhất; tick cũ không tới lần 2 vì workerTicks.set overwrite).
  let dA = 0, dF = 0;
  const dByType = { ...EMPTY_CONNECT_FAILS };
  for (const t of ticks) {                       // ticks = [...this.workerTicks.values()] (đã có :448)
    const prev = this.prevConnectCumulative.get(t.workerId);
    const cur = t.counters;
    // Guard delta âm: worker restart reset counter → coi như worker mới (delta = cumulative hiện tại).
    const base = prev && cur.connectAttempts >= prev.attempts && cur.connectFails >= prev.fails
      ? prev : { attempts: 0, fails: 0, byType: EMPTY_CONNECT_FAILS };
    const dA_w = cur.connectAttempts - base.attempts;
    const dF_w = cur.connectFails - base.fails;
    dA += dA_w; dF += dF_w;
    dByType.timeout   += cur.connectFailsByType.timeout   - base.byType.timeout;
    dByType.transport += cur.connectFailsByType.transport - base.byType.transport;
    dByType.reject    += cur.connectFailsByType.reject    - base.byType.reject;
    dByType.other     += cur.connectFailsByType.other     - base.byType.other;
    this.prevConnectCumulative.set(t.workerId, { attempts: cur.connectAttempts, fails: cur.connectFails, byType: cur.connectFailsByType });
  }
  // 2. Roll + sum window (T2)
  this.windowBuckets = rollWindow(this.windowBuckets, { attempts: dA, fails: dF, byType: dByType });
  this.lastWindow = sumWindow(this.windowBuckets);
  // 3. Rate — gán TRƯỚC pushTick để dashboard/report có đúng rate (AC-6)
  agg.tick.rates.connectFailRate = connectFailRateFromWindow(this.lastWindow);
}
```

**Bước B — khối E2 hiện tại (:513-547)** giữ vị trí, thay nguồn dữ liệu:

```ts
const connectFailRate = agg.tick.rates.connectFailRate;            // từ window (không sum cumulative nữa)
const decision = decideAutoStop({
  phase: this.phase, registerFailRate: 0, connectFailRate,
  registeredTotal: 0, connectTotal: this.lastWindow.attempts,       // attempts TRONG window
});
if (decision.stop) {
  ltLog.error(formatE2Log(decision.reason, this, agg, this.lastWindow)); // 3.3
  return this.finishRun('auto', `E2: ${decision.reason}`, false);  // 3.4 — prefix E2:
}
```

### 3.3 Log E2 — định nghĩa 8 trường (AC-4) + format

8 trường = `phase, elapsedSec, windowSec, windowAttempts, windowFails, failsByType{4}, usersFailed, workersAlive/Total`:

| # | Trường | Nguồn | Ghi chú |
|---|---|---|---|
| 1 | `phase` | `this.phase` | — |
| 2 | `elapsedSec` | `agg.tick.elapsedSec` | — |
| 3 | `windowSec` | `E2_WINDOW_BUCKETS` (60) | hằng số |
| 4 | `windowAttempts` | `window.attempts` | sum window — đồng bộ với `connectTotal` đã evaluate |
| 5 | `windowFails` | `window.fails` | sum window |
| 6 | `failsByType` | `window.byType` (4 key) | **LẤY TỪ WINDOW** (không lấy cumulative từ ticks — lệch chủ đích với PLAN T5 "sum connectFailsByType từ ticks", lý do: tổng 4 loại phải == windowFails để log tự nhất quán) |
| 7 | `usersFailed` | `sum(t.counters.usersFailed)` từ ticks mới nhất | cumulative context — chú thích "(cumulative)" trong log để khỏi hiểu nhầm là "trong window" |
| 8 | `workersAlive/Total` | `this.farm.alive` / `this.farm.total` | getters đã có (worker-farm.ts:60-68) |

Format log (1 dòng, `ltLog.error` → prefix `[lt][ERROR][HH:MM:SS.mmm]` — logger.ts:252-287):

```
E2: auto-stop: connect fail 41% > 30% (E2) | phase=ramping elapsedSec=87 windowSec=60 windowAttempts=8120 windowFails=3330 failRate=41.0% byType=timeout:2500,transport:500,reject:300,other:30 usersFailed=450(cumulative) workers=10/10
```

Grep AC-4: entry `E2:` chứa đủ các token `phase=`, `elapsedSec=`, `windowSec=`, `windowAttempts=`, `windowFails=`, `byType=`, `usersFailed=`, `workers=` — 8/8. Nên tách `formatE2Log` thành hàm pure để unit test assert chuỗi (test-list 4d).

### 3.4 PHÁT HIỆN MỚI: stopReason E2 vi phạm AC-2 hiện tại

- Hiện trạng coordinator.ts:546: `finishRun('auto', decision.reason ?? 'connect fail', false)` với `decision.reason = 'auto-stop: connect fail 41% > 30% (E2)'` → stopReason lưu DB **bắt đầu bằng `auto-stop:`**.
- AC-2 yêu cầu **"stopReason bắt đầu bằng 'E2:'"** → với code hiện tại AC-2 grep/assert sẽ FAIL.
- Fix T5: `finishRun('auto', `E2: ${decision.reason}`, false)` → `E2: auto-stop: connect fail 41% > 30% (E2)`. Log line giữ `E2: ${decision.reason} | breakdown`. E1 không bị ảnh hưởng (đã prefix `E1:` sẵn — coordinator.ts:271).

### 3.5 Cleanup & quan hệ E1/E3

- `resetRunState` (coordinator.ts:211-233) — thêm `this.prevConnectCumulative.clear(); this.windowBuckets = []; this.lastWindow = { attempts: 0, fails: 0, byType: EMPTY_CONNECT_FAILS };` (thiếu → run sau kế thừa window run trước — lỗi nghiêm trọng, giống bug workerDeathTimes đã sửa ở :231).
- `handleWorkerDied` (coordinator.ts:103-119) — thêm `this.prevConnectCumulative.delete(workerId);` — worker chết → restart → counter reset → delta tính từ 0 (R6: contribution cũ còn trong bucket ≤ 60s, chấp nhận; delta âm đã có guard 3.2).
- **E1**: không đụng — check provisioning coordinator.ts:266-272 + nhánh E1 decideAutoStop giữ nguyên.
- **E3**: block coordinator.ts:548-558 không đụng. `workerDeathTimes` (ring buffer timestamp) KHÔNG thay thế được bằng `rollWindow` (đếm sự kiện ≠ sum bucket) → dùng song song. Điểm chung chỉ là *pattern* (array + shift cutoff) — T2 mượn pattern, không tái dùng code.

---

## 4. Nhận xét ngắn T3/T4 (góc backend)

**T3 (cap retry + skip failed — socket-farm.ts)** — đồng ý design PLAN, 3 lưu ý:
1. Đếm model phải khớp CHÍNH XÁC R3: `connect_error` handler đếm attempts+fails **đến khi phase='failed'** (tối đa 5 fail/user chưa từng connected); sau cutover `return` sớm (không đếm). `'connect'` handler reset `consecutiveConnectFails=0` + `everConnected=true` (socket-farm.ts:137-145) — quan trọng: user "fail 3, success 1, fail 5" KHÔNG bị cutover nhầm.
2. Dừng reconnect: `socket.disconnect()` chưa chắc chặn manager retry → dùng `socket.disconnect()` + `socket.io?.reconnect(false)` (R4). KHÔNG null `this.socket` (khác `disconnect()` :394-402) — tránh `connect()` re-invoke; guard `if (this.socket) return` (:118) + scheduler chỉ connect user mới qua `connectStarted` nên user failed không bao giờ connect lại.
3. Tương tác E3: worker restart = process mới = user failed được tạo lại → retry 5 lần nữa → re-failed (bounded). Attempt bump sau restart là tín hiệu THẬT (đúng mong muốn — R6) — không cần sửa gì ở coordinator.

**T4 (classify + byType + recordError)** — đồng ý, 2 lưu ý:
1. `classifyConnectError` thứ tự heuristic: (1) `type==='TimeoutError'` hoặc `/timeout/i` → timeout; (2) `/xhr poll error|transport/i` → transport; (3) `'websocket error'` (server đóng handshake — gồm cả auth-reject, gateway websocket.gateway.ts:150-185) → reject; (4) else → other. **AC-4 viết "timeout/auth/transport/reject" nhưng T1/PLAN chốt key 'other' không có 'auth'** — client socket.io KHÔNG phân biệt được auth-reject (PRD §6.1, không expose HTTP status) → auth-reject nằm trong 'reject'; 4 key log luôn in đủ để grep không vỡ. Ghi chú mâu thuẫn từ ngữ này vào UI-SPEC để T6 không đặt key 'auth'.
2. `recordError` (:661-665) thêm param `action: ErrorSample['action'] = 'chat'` — backward compat đủ cho mọi caller cũ (onError :194, recordAction :585, onNoEcho :624, recordResult :653). Message đã slice 160 (:663) — connect_error message ngắn ('websocket error'/'timeout'), rủi ro lộ token thấp nhưng vẫn phải redact khi log verbose (logger.ts:90-135).

---

## 5. Xác nhận mâu thuẫn AC-1 vs AC-2 (đã chốt PLAN R3)

Mô hình đếm (PLAN R3): user chưa từng connected, fail liên tiếp ≥ 5 → phase='failed', ngừng reconnect, **fail sau cutover không đếm**. Số liệu:

| Kịch bản | attempts (window) | fails (window) | rate | Kết luận |
|---|---|---|---|---|
| **AC-1**: 5% token lỗi (500/10k) | 10.000 (healthy, 1 attempt/user) + 2.500 (500×5 fails) = **12.500** | **2.500** | **20.8% < 30%** | ✓ KHÔNG trigger — run finished |
| **AC-2**: 100% token lỗi (10k) | 10.000 × 5 = **50.000** | **50.000** | **100% > 30%**, attempts ≥ 50 | ✓ Stop, reason `E2:` |

- Chữ "chỉ đếm 1 fail/window" trong AC-1 (PRD:180) là tàn dư của M3 cũ ("1 user hỏng = 1 fail"). Nếu giữ nghĩa đen: 50.000 attempts / 10.000 fails = **20% < 30% → AC-2 VỠ toán học** (chính là lý do PLAN R3 đã chốt hướng bounded-5). **Design T1-T5 đáp ứng cả 2 AC dưới mô hình bounded-5; T3 phải bám đúng mô hình này, không quay về "1 fail/user".**
- Lưu ý timing AC-1: tỉ lệ window giữ ≈20.8% bất kể điểm đo trong ramp (healthy luôn 1 attempt, broken bounded 5) — không có cửa sổ thời gian nào làm rate vọt > 30% với đúng 5% broken. An toàn.
- Margin: 5% broken → 20.8%; 7.5% broken → 10.000/(10.000+3.750)... tính lại: 3.750 fails / 13.750 = 27.3%; ~8% broken → 30% boundary. **Nếu tỉ lệ token lỗi thực tế > 8% thì AC-1 không còn đảm bảo** — không phải lỗi design mà là giới hạn tham số (đưa vào rủi ro, mục 7).

---

## 6. Test list T1 / T2 / T5

### T1 (contract)
1. `types-contract.typecheck.ts` — cross-assign 2 chiều BE↔FE: LoadTestTick FE có đủ 4 counter + 1 rate mới (bắt R7 drift).
2. `coordinator-state.test.ts` — `aggregateTicks` merge: worker A `byType={timeout:1,transport:2}`, worker B `byType={transport:3,reject:1}` → `{timeout:1,transport:5,reject:1,other:0}`; `connectAttempts/connectFails/usersFailed` sum đúng; `rates.connectFailRate === 0` (coordinator override).
3. `coordinator.test.ts` — provisioning tick (aggregateTick phase='provisioning') đủ field mới = 0.
4. `api-mappers` test — `toMetricTick` từ MetricSampleRow cũ trả 0 default (không crash, không NaN).
5. JSON round-trip LoadTestTick (HTTP) giữ đủ field số — serialize/DB writer không mất field.

### T2 (window pure + threshold)
1. `rollWindow`: 1 entry → `[e]`; 65 entries → length 60, sum = 5 cuối; `max` param; **immutability** (input không bị mutate).
2. `sumWindow`: rỗng → zeros; nhiều bucket → sum attempts/fails + merge byType từng key.
3. `connectFailRateFromWindow`: attempts 49 → 0; 50 + fails 17/50 → 34; rỗng → 0.
4. `decideAutoStop`: rate 100 + attempts 49 → KHÔNG stop; 50 → stop (E2); rate 30 + 50 → KHÔNG stop; 30.1 + 50 → stop; window rỗng → KHÔNG stop.
5. Regression E1 boundary tests (:115-149) giữ nguyên — chỉ đổi 2 case E2 từ `connectTotal 10 → 50` (PLAN T2: sửa có chủ đích, R2).

### T5 (wiring — pattern `coordinator.test.ts` priv() + workerTicks.set)
1. **Spike 5s rồi sạch**: cumulative fails dừng sau 5 tick, attempts tiếp tục → sau ~60 tick rate về ~0, `finishRun` KHÔNG gọi (rate phục hồi — AC-1 core).
2. **Fail liên tục 100%**: window ≥ 50 attempts → `finishRun('auto', reason bắt đầu 'E2:')` (AC-2 + 3.4).
3. **Window < 50 attempts**: rate 100% nhưng attempts 30 → KHÔNG gọi finish, KHÔNG log E2 (AC-3).
4. **Log E2 8 trường**: `vi.spyOn(ltLog, 'error')` (pattern logger.test.ts) → assert chuỗi có đủ 8 token (`phase=`, `elapsedSec=`, `windowSec=`, `windowAttempts=`, `windowFails=`, `byType=`, `usersFailed=`, `workers=`).
5. **resetRunState**: chạy 2 run mô phỏng → window run 1 không rò sang run 2.
6. **Worker chết giữa window**: `handleWorkerDied` → `prevConnectCumulative` xóa; tick worker mới (counter reset) → delta tính từ 0, không âm (guard 3.2).
7. **Không double-count**: 2 aggregateTick liên tiếp với cùng tick worker → delta tick 2 = 0, window không tăng đúp.

---

## 7. Rủi ro (backend)

- **R3 (AC-1 vs AC-2)** — đã xác nhận ở mục 5: bounded-5 đáp ứng cả 2; "1 fail/user" phá AC-2. T3 phải bám bounded-5.
- **R-mới: prefix `E2:`** — nếu T5 quên prefix (giữ nguyên finishRun :546), AC-2 grep stopReason vỡ. Đã đưa vào spec 3.4 + test 6-T5.2.
- **R1 (DB replay)** — field mới không persist (metric_samples không cột); replay = 0. Migration cột = v1.1. Dashboard LIVE không ảnh hưởng (rate gán trước pushTick).
- **R2 (semantics đổi)** — `connectTotal` 10→50, window; test boundary cũ sửa có chủ đích.
- **R6 (worker chết/restart)** — delta âm guard + xóa prevConnectCumulative khi died; contribution cũ trôi ≤ 60s.
- **R7 (drift FE/BE)** — T1 chốt tên field, T6 bám nguyên; typecheck 2 chiều là gate.
- **Margin AC-1** — nếu > ~8% account token lỗi, rate vượt 30% dù design đúng (tham số, không phải bug).
- **Thứ tự log/stopReason** — `formatE2Log` pure + tách khỏi `finishRun` để test chuỗi dễ.

---

## 8. Điểm dễ bị tấn công trong design này

1. **Window phụ thuộc nhịp tick 1s + diff cumulative**: nếu worker tick thưa (heartbeat stall 8s → kill/restart) hoặc coordinator GC pause kéo dài, 1 bucket chứa delta nhiều giây → cửa sổ trượt thời gian thực (có thể 65-70s thay vì 60s) và rate nhích theo. Bounded và chấp nhận (R6), nhưng kẻ tấn công có thể khai thác việc worker chết liên tục để làm méo tỉ lệ — T5 test 6-T5.6 chỉ cover 1 lần chết, không cover chuỗi chết liên tiếp.
2. **`rates.connectFailRate = 0` khi window < 50 attempts là "mù" chứ không phải "0 thật"**: dashboard AC-6 hiển thị 0% đầu ramp — operator đọc nhầm "khỏe mạnh tuyệt đối" thay vì "chưa đủ mẫu". Không có field/flag phân biệt N/A vs 0 trong contract T1; nếu muốn phân biệt phải thêm field (vd `connectSampleReady`) — tăng mặt contract, cân nhắc v1.1.
3. **Heuristic classify (`reject` vs `transport`) mơ hồ — cùng message `'websocket error'`**: theo PRD §6.1, server-reject và transport error đều có thể ra cùng message; thứ tự heuristic (mục 4) có thể gán sai loại. Không ảnh hưởng auto-stop (rate dùng fails tổng), NHƯNG ảnh hưởng trực tiếp mục tiêu điều tra root-cause — thứ chính của fix này. Mâu thuẫn từ ngữ AC-4 "auth" vs key 'other' làm grep thủ công dễ hiểu nhầm.
4. **Mô hình bounded-5 không scale theo % broken**: AC-1 chỉ đúng khi ≤ 5% token lỗi; ~8% đã chạm boundary 30% (mục 5). Không có cơ chế tự điều chỉnh ngưỡng theo tỉ lệ user failed (vd rate = fails/(attempts) với fails đã biết bounded) — ngưỡng 50 attempts và 30% là hardcode 2 chiều (mẫu tối thiểu × tỉ lệ), nếu run target nhỏ (1k user) tỉ lệ % broken cần thiết để vượt ngưỡng giảm (1k × 5% × 5 = 250 fails / 1.250 attempts = 20% — vẫn an toàn, nhưng 10% broken ở 1k user = 500/1.500 = 33% → trigger). Không phải bug nhưng là giới hạn tham số cần ghi trong report.
5. **Log E2 trộn 2 cửa sổ thời gian**: `windowFails`/`byType` là window 60s nhưng `usersFailed` là cumulative (chú thích trong log không đủ để máy parse) — nếu sau này viết script grep log để tính lại rate sẽ nhầm mẫu số/tử số. Nên cân nhắc log thêm `usersFailedWindow` (delta) hoặc tách dòng — chi phí nhỏ, tránh hiểu nhầm tương lai.
