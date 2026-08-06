# PRD: Incident — Auto-stop E2 kích hoạt nhầm (connect fail 41% > 30%)

**Status**: Draft — chờ fix
**Author**: Alex (PM) · **Last Updated**: 2026-08-05 · **Version**: 0.1
**Stakeholders**: Backend gateway-auth-service, Content-service, FE chat-app
**Loại**: Bugfix / Incident PRD — KHÔNG thay đổi cơ chế an toàn E1-E3, chỉ sửa nguyên nhân gốc

---

## 0. Bug khách hàng báo

```
[lt][ERROR][09:24:36.183] e2: auto-stop: connect fail 41% > 30% (E2)
```

Run loadtest bị auto-stop khi tỉ lệ connect fail 41% vượt ngưỡng 30% (E2). Run bị dừng, dữ liệu partial, không biết nguyên nhân connect fail vì log chỉ in con số tổng — **không có phân bố theo mã lỗi/phase**.

**Bối cảnh bắt buộc**: 10k user seed = production users THẬT (tạo qua flow register thật của gateway → user-community Postgres). Auto-stop là cơ chế an toàn — **KHÔNG được tắt**, phải sửa nguyên nhân gốc để nó chỉ kích hoạt khi thực sự có sự cố.

---

## 1. Hiện trạng code (file:dòng)

### 1.1 Luồng connect + đếm counter (worker-side)

1. `loadtest/socket-farm.ts:117-133` — `VirtualUser.connect()`: tạo socket.io-client tới `ws://gateway/socket.io/`, transports `['websocket']`, token qua `auth` + `Authorization` header, **`reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 10_000, timeout: 20_000`**.
2. `loadtest/socket-farm.ts:137-145` — `s.on('connect')`: `runtimeStats.connectAttempts++` (đếm attempt khi connect THÀNH CÔNG).
3. `loadtest/socket-farm.ts:155-160` — `s.on('connect_error')`:
   ```ts
   this.lastError = `connect_error: ${err.message}`;
   // mỗi lần thử reconnect (thành công hay không) đều là 1 attempt → fail rate chính xác
   this.runtimeStats.connectAttempts++;
   this.runtimeStats.connectFails++;
   ```
   **Đếm MỌI lần retry** — với `reconnectionAttempts: Infinity`, 1 user lỗi vĩnh viễn sinh fail không giới hạn (~1 fail mỗi 1-10s, ~10-12 fail/phút/user). `err.message` chỉ ghi vào `lastError` (bảng users), **không vào errorSamples, không log**.
4. `loadtest/socket-farm.ts:204-205` — `runtimeStats` là counter **cumulative per-user, không reset**.
5. `loadtest/socket-farm.ts:694-700` — `emitTick()`: gộp runtimeStats mọi user vào `counters.connectAttempts/connectFails` — **cumulative toàn run**.
6. `loadtest/types.ts:108-109` — `WorkerTick.counters.connectAttempts/connectFails` (cumulative).
7. **`loadtest/types.ts:161-177`** — `LoadTestTick.counters` **KHÔNG chứa connectAttempts/connectFails** → dashboard/report không hiển thị được, không có observability cho E2.
8. `loadtest/types.ts:124-130` — `ErrorSample` **đã có sẵn** `action: 'connect'` nhưng không nơi nào record connect fail vào errorSamples (chỉ `recordError` cho action/register/login — socket-farm.ts:661-665).

### 1.2 Nơi đo E2 (coordinator-side)

1. `loadtest/coordinator.ts:531-536` — trong `aggregateTick()` (chạy mỗi 1s, phase ramping/steady):
   ```ts
   let attempts = 0, fails = 0;
   for (const t of ticks) {
     attempts += t.counters.connectAttempts;
     fails += t.counters.connectFails;
   }
   const connectFailRate = attempts >= 10 ? (fails / attempts) * 100 : 0;
   ```
   `ticks` = `[...this.workerTicks.values()]` (coordinator.ts:448) — tick MỚI NHẤT của từng worker, counter **cumulative từ đầu run**. **KHÔNG có sliding window 60s**.
2. `loadtest/coordinator-state.ts:56-64` — `decideAutoStop`:
   ```ts
   if (input.connectFailRate > 30 && input.connectTotal >= 10) {
     return { stop: true, reason: `auto-stop: connect fail ${...}% > 30% (E2)` };
   }
   ```
   Ngưỡng: **> 30%, tối thiểu 10 attempts**.
3. `loadtest/coordinator.ts:544-547` — log + finish:
   ```ts
   ltLog.error(`E2: ${decision.reason}`);
   return this.finishRun('auto', decision.reason ?? 'connect fail', false);
   ```
   → format `[lt][ERROR][HH:MM:SS.mmm]` (loadtest/logger.ts:252-287) — khớp log bug. Log KHÔNG kèm attempts/fails/breakdown/phase/elapsed.
4. `loadtest/coordinator-state.ts:42-46` — comment ghi "**connect fail > 30% (cửa sổ 60s)**" — **spec nói cửa sổ 60s nhưng code không làm** (đây là deviation).
5. **3 kênh reject (F-T7-2 hiệu đính Phase 4 — đã verify socket.io-client 4.8.3)**:
   - **(A)** middleware `next(new Error)` → CONNECT_ERROR 1-shot terminal (không retry).
   - **(B)** **gateway `client.disconnect()` NGAY SAU accept (websocket.gateway.ts:150-153,161-164,179-185)** → client nhận `connect` TRƯỚC rồi `disconnect` reason `'io server disconnect'` — **TERMINAL 1 lần, KHÔNG connect_error, KHÔNG retry**. **Đây là kênh reject THẬT duy nhất của gateway** — PRD cũ tưởng nhầm thành connect_error retry loop (SAI — hiệu đính §1.4). Trước fix F-T7-2, E2 mù với kênh này: attempt đếm "thành công" giả, 0 fail, user kẹt 'connecting' vĩnh viễn, E2 không bao giờ stop dù 100% token lỗi.
   - **(C)** engine-level reject/timeout (403-upgrade, 20s timeout) → `connect_error` + retry Infinity — kênh DUY NHẤT cần cap-5 (T3).

### 1.3 E1 và E3 khác E2 thế nào

| | E1 (register fail) | E2 (connect fail) | E3 (worker chết) |
|---|---|---|---|
| Nơi đo | `coordinator.ts:266-272`, 1 lần sau provisioning, từ `summary.registerFailed` (auth-factory.ts:40-52 — chỉ đếm REGISTER, không đếm login) | `coordinator.ts:513-547`, mỗi tick 1s trong ramping/steady | `coordinator.ts:518-529` (heartbeat timeout 8s → SIGKILL) + `:549-558` (worker death) |
| Ngưỡng | > 50% và total ≥ 10 | > 30% và attempts ≥ 10 | > 50% worker chết trong 60s / toàn bộ chết |
| Cửa sổ | toàn bộ provisioning (có nghĩa) | **cumulative toàn run (SAI)** | **60s thật** — `workerDeathTimes` ring buffer (coordinator.ts:105-106) |
| Đếm | 1 account = 1 fail | **1 user hỏng = vô hạn fail (retry Infinity)** | 1 worker chết = 1 lần đếm |
| Restart | không có | không có | tự restart 2s backoff (worker-farm.ts:182-196) |

**Kết luận**: E3 có cửa sổ 60s đúng như spec; E2 là mắt xích lệch — comment hứa window 60s nhưng implementation là cumulative.

### 1.4 Các ngưỡng liên quan khác

- `loadtest/config.ts:306-309` — `durationMin` ≤ 60 phút (access token TTL 1h).
- `loadtest/config.ts:313-315` — warning nếu `rampRate > 2000/s`; default rampRate 200/s (routes/run.ts:41).
- Gateway throttler: `gateway-auth-service/src/app.module.ts:68-93` — short 1000/8s, medium 15000/30s, long 20000/60s; `THROTTLER_ENABLED` default true. Chỉ áp cho REST pipeline (register/login guest bucket), ws handshake không đi qua HTTP pipeline.
- Gateway ws handshake: `gateway-auth-service/src/infrastructure/driving-adapters/websocket/gateway/websocket.gateway.ts:142-193`:
  - Thiếu token → `client.disconnect()` (`:150-153`)
  - Token invalid/hết hạn → `client.disconnect()` (`:161-164`)
  - Enforcement `enforcement:user:{id}` level ≥ 3 → `client.disconnect()` (`:179-185`, fail-open khi Redis lỗi)
  - Exception bất kỳ trong handleConnection → `client.disconnect()` (`:350-352`)
  - **`client.disconnect()` (kênh B) → client nhận `connect` rồi `disconnect` reason `'io server disconnect'` — TERMINAL 1 lần, KHÔNG connect_error, KHÔNG retry** (đã verify socket.io-client 4.8.3; hiệu đính Phase 4 — PRD cũ ghi sai "connect_error → retry Infinity → loop fail", thực tế retry Infinity chỉ xảy ra ở kênh C engine-level: client-side reject trước CONNECT packet, vd 403-upgrade / timeout — KHÔNG phải hành vi gateway thật).
- Access token TTL 1h: `gateway-auth-service/src/infrastructure/driven-adapters/providers/jwt/token.provider.adapter.ts:17-22` (`expiresIn: '1h'` default).

---

## 2. Nguyên nhân giả định (xếp hạng khả năng cao → thấp)

### #1 — Counter E2 sai thiết kế: cumulative toàn run + threshold attempts ≥ 10 quá nhỏ + đếm cả retry vô hạn (FALSE POSITIVE) — **khả năng cao nhất**

**Cơ chế**:
- Tỉ lệ connect fail KHÔNG tính trên cửa sổ 60s như spec (coordinator-state.ts:44-46) mà trên **cumulative toàn run** (coordinator.ts:531-536 + socket-farm.ts:694-700). Fail nào đã xảy ra (vd đầu run) kéo tỉ lệ lên **mãi mãi**, không bao giờ phục hồi kể cả khi gateway khỏe lại.
- Threshold tối thiểu **10 attempts** (coordinator-state.ts:60) quá nhỏ: đầu phase ramping, chỉ cần 4/10 connect đầu fail (vd gateway đang rate-limit/restart, vài token lỗi trong batch đầu) là 40% → **E2 stop chỉ sau vài giây ramp**.
- `reconnectionAttempts: Infinity` (socket-farm.ts:130) + đếm mọi `connect_error` (socket-farm.ts:155-160): **1 user lỗi vĩnh viễn = vô hạn fail**. Tính toán: 500/10k user lỗi (5%) × ~10 fail/phút = ~5.000 fail/60s; attempts thành công ~10k (1 lần/user) → fail rate ≈ 33% → **vượt 30% dù 95% connect OK**. Đây chính xác là dáng dấp số 41%.

**Cách xác minh** (code/log chứng minh):
- `loadtest/coordinator-state.ts:42-46` (comment nói cửa sổ 60s) vs `coordinator.ts:531-536` (sum cumulative) — mismatch trực tiếp.
- `socket-farm.ts:129-133` (retry Infinity) + `:155-160` (đếm mọi retry).
- Log run trước khi E2: nếu `connected` cao + echo rate tốt nhưng E2 vẫn stop → false positive (periodic summary coordinator.ts:487-495 có in connected/echo mỗi 15s — kiểm tra log run bị lỗi).

**Mức ảnh hưởng**: Rất cao — dừng run hợp lệ; đây là lỗi nền tảng, không phụ thuộc hạ tầng có sự cố hay không.

### #2 — Account/token lỗi vĩnh viễn: access token hết hạn giữa run / enforcement ban (nguồn fail thật cho #1) — **khả năng cao**

**Cơ chế**:
- Account = production user THẬT. Access token TTL 1h (token.provider.adapter.ts:17-22). Nếu run dài (30-60 phút) hoặc dùng pool cũ (useExistingAccounts — login lại lúc provisioning, config.ts:172-207), token có thể hết hạn giữa run. **Reconnect sau disconnect** (network hiccup, room kick, gateway restart) → handshake với token hết hạn → gateway `client.disconnect()` (websocket.gateway.ts:161-164) → **kênh B: client nhận `io server disconnect` — TERMINAL 1 lần, KHÔNG retry** (hiệu đính Phase 4 — PRD cũ ghi "client retry vô hạn" là SAI: đó là kênh C engine-level, không phải hành vi gateway thật; F-T7-2 đếm kênh B = 1 reject-fail + cutover failed ngay).
- Enforcement level ≥ 3 (websocket.gateway.ts:179-185): user bị ban (vd nội dung chat dính profanity filter dù đã prefix `[lt]`) → mọi connect bị từ chối.
- Token version bump (đổi password / logout all) khi account bị người khác động vào.

**Cách xác minh**: hiện KHÔNG có log nào (connect_error chỉ vào `lastError` — socket-farm.ts:156; không vào errorSamples). Cần thêm log (Mục 3) + kiểm tra: JWT `exp` vs timeline run, Redis `enforcement:user:{id}`, gateway log `❌ Token invalid → disconnect` / `❌ Enforcement level ... → disconnect`.

**Mức ảnh hưởng**: Cao nếu có — là nguồn fail thực tế; nhưng ngay cả khi có, E2 vẫn không được phép đếm 1 user hỏng = vô hạn fail (#1 vẫn phải sửa).

### #3 — Gateway từ chối/overload nhất thời: handshake timeout hoặc quá tải event loop — **trung bình**

**Cơ chế**: 1 gateway instance giữ 10k+ ws + matching + Kafka consumer; khi event loop bão hòa hoặc GC pause → handshake chậm → client timeout 20s (socket-farm.ts:133) → `connect_error` → retry. Một đợt từ chối 30-60s đầu ramp cộng với counter cumulative = tỉ lệ kẹt cao mãi.

**Cách xác minh**: gateway log (ws handshake timeout, `ws_connections` từ /metrics — coordinator.ts:581-603), thời điểm run start vs spike fail; sau fix #1 (window 60s) số này sẽ tự hết hiệu lực nếu chỉ là nhất thời.

**Mức ảnh hưởng**: Trung bình — nếu thật, là vấn đề hạ tầng cần theo dõi, nhưng không được phép dừng run chỉ vì 1 đợt 30s.

### #4 — Spawn ồ ạt / worker restart loop (E3) gây connect lại đồng loạt — **thấp-trung bình**

**Cơ chế**: worker crash → E3 restart (worker-farm.ts:182-196) → `worker.start()` reset `rampStartedAt` (socket-farm.ts:483-484) → connect lại theo pacing (KHÔNG ồ ạt trừ ratePerWorker cao). Khi restart liên tục + gateway đang quá tải → connect-error loạt. Đồng thời attempts bị đếm kép (user connect lại từ đầu) — nhưng attempts tăng thì tỉ lệ giảm, nên chỉ phóng đại khi fail cũng tăng.

**Cách xác minh**: counter `workerRestarts` (toolMetrics — coordinator.ts:335-338), log `coordinator: worker#N died` (coordinator.ts:109).

**Mức ảnh hưởng**: Thấp — tác nhân phụ, không phải nguyên nhân độc lập.

### #5 — Multi-worker double-count — **LOẠI TRỪ**

Mỗi worker đếm `runtimeStats` của users mình (socket-farm.ts:694-700); coordinator sum đúng 1 tick/worker (coordinator.ts:531-536) — không có trùng lặp giữa worker.

### #6 — OTP-seed Redis lệch / hết seed — **LOẠI TRỪ cho E2**

OTP-seed ảnh hưởng register → **E1** (register fail > 50%, coordinator.ts:266-272), không phải connect. Nếu xảy ra, E1 đã stop trước khi tới ramping — log báo E2 nghĩa là register OK, accounts có token.

---

## 3. Phạm vi fix

### MVP — sửa false positive + observability tối thiểu

| # | Mục | Đánh dấu | Chi tiết |
|---|---|---|---|
| M1 | **E2 đo trên sliding window 60s thật** (không cumulative toàn run) | **CẦN THÊM** | Coordinator giữ ring buffer 60s `{attempts, fails}` (hoặc diff counter cumulative giữa 2 mốc 60s — đơn giản hơn, đủ chính xác cho auto-stop). Sửa `coordinator.ts:531-536`; `coordinator-state.ts` nhận window input. Đúng spec đã hứa (coordinator-state.ts:44-46). |
| M2 | **Threshold tối thiểu window ≥ 50 attempts** (thay 10 cumulative) | **CẦN THÊM** | Sửa `coordinator-state.ts:60`: chỉ evaluate khi window đã có đủ mẫu — chống trigger đầu ramp với 10-20 attempt. |
| M3 | **Cap retry cho lỗi vĩnh viễn: 1 user hỏng = 1 fail (không vô hạn)** | **CẦN THÊM** | Trong `socket-farm.ts:155-160`: nếu user chưa từng connected và fail ≥ N liên tiếp (N=5) → chuyển phase `'failed'` (UserPhase đã có — types.ts:15), ngừng reconnect (disconnect socket / giới hạn reconnectionAttempts theo trạng thái). Fail sau đó không đếm vào window. Giữ retry vô hạn cho user ĐÃ TỪNG connected (lỗi transient của hệ thống phải tự phục hồi). |
| M4 | **Phân loại connect fail theo nguyên nhân** | **CẦN THÊM** | Trong `connect_error` handler: tách timeout (20s) / transport error / server-reject (disconnect ngay sau handshake) / HTTP status nếu có; record vào `errorSamples` với `action: 'connect'` (type đã có sẵn — types.ts:126). Log raw err (redact qua logger — logger.ts:90-135) khi verbose. |
| M5 | **Log E2 trigger kèm breakdown** | **CẦN THÊM** | Sửa `coordinator.ts:544-547`: log phải chứa phase, elapsedSec, window seconds, attempts/fails trong window, fails phân theo loại (M4), số user ảnh hưởng, worker alive/total. |
| M6 | **Thêm connect metrics vào LoadTestTick + dashboard** | **CẦN THÊM** | Thêm `connectAttempts/connectFails` (+ breakdown) vào `types.ts:161-177` (LoadTestTick); cập nhật UI-SPEC §4.1 (docs/UI-SPEC-loadtest-tool.md:543-563); hiển thị "Connect fail %" trên Màn 2. Bảng users đã có `phase: 'failed'` (types.ts:15) — hiển thị luôn. |
| M7 | **Retry-join thất bại khi phase 'failed'**: user bị đánh dấu failed không tham gia vòng lặp action (socket-farm.ts:549-565) | **CẦN THÊM** | Tránh user chết vẫn tốn CPU chat cycle. |
| M8 | Unit test đi kèm (decideAutoStop window, ring buffer, classification, cap retry) | **CẦN THÊM** | — |

**ĐÃ CÓ (kế thừa, không sửa)**: toàn bộ hạ tầng E2 hiện có (coordinator.ts:513-547, decideAutoStop, WorkerTick counters, `ErrorSample.action: 'connect'`, `UserPhase: 'failed'`), logger redaction, sliding-window pattern đã có ở E3 (workerDeathTimes — coordinator.ts:105-106) — **dùng lại pattern này cho M1**.

### v1.1 — nâng cấp (không nằm trong fix lần này)

| # | Mục | Đánh dấu | Ghi chú |
|---|---|---|---|
| V1 | Refresh token hàng loạt trước hết hạn + reconnect bằng token mới (AF-5 — docs/PRD-loadtest-tool.md:161) | **CẦN THÊM** | Giải tận gốc #2 cho run dài; hiện token pool có refreshToken (types.ts:74) nhưng chưa dùng. |
| V2 | Auto-adapt pacing (SE-6 — docs/PRD-loadtest-tool.md:196): khi connect fail tăng → tự giảm ramp | **CẦN THÊM** | |
| V3 | User Detail hiển thị phase 'failed' + lý do (Màn 3 — docs/UI-SPEC-loadtest-tool.md:370-373) | **CẦN THÊM** | |

---

## 4. Acceptance criteria đo được — MVP

| # | AC | Cách đo |
|---|---|---|
| AC-1 | **E2 không trigger khi connect-fail thật < 30% trong window 60s**, kể cả khi có ≤ 5% user lỗi vĩnh viễn (500/10k) — các user này chuyển phase 'failed' sau ≤ 5 attempt và chỉ đếm 1 fail/window | Chạy test 10k với 5% accounts token lỗi (env test, không production): run phải `finished`, stopReason không chứa 'E2'; `connectFailRate` (window 60s) < 30% suốt run |
| AC-2 | **E2 vẫn dừng run khi connect-fail thật > 30% window 60s với ≥ 50 attempts** | Chạy test 10k với 100% accounts token lỗi: run tự dừng (status='error') trong ≤ 60s kể từ khi window đủ mẫu; stopReason bắt đầu bằng 'E2:' |
| AC-3 | **E2 không evaluate khi window chưa đủ 50 attempts** (bỏ qua đầu ramp) | Test đơn vị + chạy 10k ramp 200/s: không có log E2 trong 5s đầu dù có fail lẻ tẻ |
| AC-4 | **Log E2 trigger phải liệt kê phân bố nguyên nhân**: phase, elapsedSec, window seconds, attempts/fails window, fails theo loại (timeout/auth/transport/reject), số user ảnh hưởng, worker alive/total | Grep log của run AC-2: entry `E2:` phải chứa đủ 8 trường trên |
| AC-5 | **Run 10k fresh hợp lệ (token OK, ramp 200/s, duration ≥ 10 phút): connect-fail rate window < 5% toàn run** | Chạy trên môi trường test: đọc metric "Connect fail %" (dashboard/report) — phải < 5%; nếu ≥ 5% → có sự cố thật, phân tích breakdown (M4) |
| AC-6 | **Dashboard hiển thị Connect fail % (window 60s) + breakdown theo mã** — không cần đoán | Mở Màn 2 Live Dashboard trong run: KPI "Connect fail" + breakdown visible |
| AC-7 | **Không đổi cơ chế an toàn**: E1/E3 nguyên vẹn; E2 vẫn là auto-stop thật sự (AC-2); user 'failed' không tốn CPU action | Regression: test cũ E1/E3 (nếu có) + AC-2 + kiểm tra scheduler bỏ qua user failed (socket-farm.ts:549-565) |

**Quy tắc đo**: tất cả đo trên môi trường TEST (allowlist — config.ts:151-154), không production. Connect fail rate = fails/attempts trong window 60s (M1), tính mỗi tick 1s, hiển thị như metric riêng.

---

## 5. Test plan sơ bộ

### Unit (thuần, không IO — pattern coordinator-state.ts đã có)

1. `decideAutoStop` với input window: fail rate > 30% + attempts ≥ 50 → stop; attempts < 50 → không stop; rate = 30% (boundary) → không stop; window rỗng → không stop.
2. Ring buffer sliding window 60s: sum đúng khi roll, không giữ giá trị quá hạn, không leak.
3. `classifyConnectError` (M4): mock err `{message, description, type}` → timeout / transport / auth-reject / http-status; không throw khi err thiếu field.
4. Cap retry (M3): user chưa từng connected fail N liên tiếp → phase 'failed', ngừng reconnect, fail không tăng thêm; user từng connected fail → vẫn retry + đếm (transient).
5. `emitTick` khi có user 'failed': counters không tính fail thêm; user bị loại khỏi vòng lặp action.

### Integration (coordinator + worker thật, gateway giả/môi trường test)

1. **Gateway ws giả (local)**: accept token trong allowlist, reject token khác → chạy 1 worker × 100 users: (a) 100% token OK → finish, fail rate ~0; (b) 5% token lỗi → không E2, 5 user 'failed'; (c) 100% lỗi → E2 stop ≤ 60s, log có breakdown.
2. **Run thật 10k trên môi trường test** 3 kịch bản (AC-1, AC-2, AC-5) — xác minh AC-1..AC-7.
3. **Regression**: E1 (register fail > 50% — coordinator.ts:266-272), E3 (kill worker giữa run → restart → không auto-stop nhầm), dashboard load với tick mới có connect metrics.

---

## 6. Giả định & rủi ro (tự quyết định, không hỏi lại)

1. **socket.io-client `connect_error` không expose HTTP status khi server reject ngay** (thường `err.message = 'websocket error'` hoặc timeout). Fix M4 sẽ log raw err (redact) + phân loại heuristic (timeout / transport / reject-sau-handshake); nếu spike cho thấy gateway trả status cụ thể thì dùng luôn — không chặn MVP.
2. **Không truy được dữ liệu run 09:24:36 chi tiết** (log chỉ có 1 dòng E2; không chắc LOGTEST_LOG_FILE bật — logger.ts:227). Chấp nhận: không backtrack; fix xong, run mới có đủ data (M4-M6).
3. **Token hết hạn giữa run 60 phút vẫn tồn tại ở MVP** (cap retry + phase 'failed', không refresh). Rủi ro: user bị 'failed' không tự hồi phục khi hết run — chấp nhận vì đếm đúng còn hơn đếm sai; refresh nằm ở v1.1 (V1).
4. **Không sửa source hệ thống** (docs/PRD-loadtest-tool.md §8.8). Nếu root cause thật là gateway-side (enforcement/secret rotate/overload), MVP chỉ chặn false-positive + cung cấp dữ liệu để điều tra; không vá gateway.
5. **Chi phí cửa sổ 60s**: 60 tick × 2-4 counter sum/tick ở coordinator — không đáng kể so với tick 1s hiện tại (coordinator.ts:418-560).
6. **Ngưỡng 50 attempts là ước lượng hợp lý** (đủ mẫu thống kê với ramp 200/s ≈ 0.25s ramp; với ramp thấp hơn chỉ trì hoãn quyết định vài giây — an toàn). Không cấu hình hóa ở MVP (thêm config = thêm mặt tấn công); tách riêng nếu có yêu cầu.
7. **User 'failed' không retry** có thể làm connected đỉnh thấp hơn target khi nhiều user hỏng — đúng mong muốn (phản ánh sự thật), AC-5 định nghĩa ngưỡng hợp lệ < 5%.

---

## Phụ lục — chuỗi dẫn chứng ngắn

- `[lt][ERROR][09:24:36.183] e2: ...` ← `loadtest/logger.ts:256` format ← `loadtest/coordinator.ts:545`
- Tỉ lệ 41% ← `loadtest/coordinator.ts:531-536` (sum cumulative) ← `loadtest/socket-farm.ts:694-700` ← `loadtest/socket-farm.ts:155-160` (đếm mọi retry) ← `loadtest/socket-farm.ts:129-133` (retry Infinity)
- Ngưỡng 30% + attempts ≥ 10 ← `loadtest/coordinator-state.ts:60-61`
- Gateway từ chối handshake (nguồn fail thật) ← `gateway-auth-service/.../websocket.gateway.ts:150-164, 179-185, 350-352`
