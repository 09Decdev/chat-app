# Panel Phase 4 — Correctness Review: Fix E2 loadtest (T1..T7)

**Reviewer**: Code Reviewer (panel Phase 4, autobuild) · **Date**: 2026-08-05
**Scope**: 7 commits (T1 4e05426 → T7 1a383cc) · PRD-loadtest-e2-connect-fail · DESIGN-loadtest-e2-connect-fail (hiệu đính §5.2/§5.3 + F-4/AC-1)
**Phương pháp**: đọc diff + đối chiếu code thật (`coordinator.ts`, `coordinator-state.ts`, `socket-farm.ts`, `sanitize.ts`, `logger.ts`, `types.ts`, `api-mappers.ts`, UI `src/...`) + verify hành vi thật của `socket.io-client@4.8.3` trong `node_modules/.../build/cjs/{socket,manager}.js` + đối chiếu test T5/T7 với AC.

---

## A. Phán quyết 3 finding T7

### F-T7-1 — Run kẹt `ramping` vĩnh viễn khi có user failed → **IN-SCOPE-fix (BLOCKER)**

**Xác minh (code)**:
- `loadtest/coordinator.ts:601` — ramping→steady chỉ khi `agg.tick.counters.usersConnected >= this.config.targetUsers`.
- `loadtest/coordinator.ts:605` — duration hết chỉ được kiểm khi `phase === 'steady'`.
- `grep durationSec` toàn coordinator: **duy nhất** dòng 605. KHÔNG có path ramping→cooldown theo duration. Manual stop là path duy nhất còn lại (ngoài E1/E2/E3).
- Với cap-5 (T3, `socket-farm.ts:202-214`): user `'failed'` không bao giờ connect → `usersConnected` plateaus dưới target **mãi mãi** → kẹt ramping → không bao giờ `finished`. AC-1 ("run phải `finished`") **không đạt**.
- **Bằng chứng test tự thú nhận**: `e2e-mock-gateway-e2.test.ts:248` (`phase).toBe('ramping')`), `:278-283` — "Run KHÔNG tự kết thúc (kẹt ramping — pre-existing, không phải lỗi E2) → stop thủ công". Test (b) của chính T7 **không chứng minh AC-1** — nó chứng minh "E2 không trigger + run treo + stop tay".
- **Vì sao không phải OUT-OF-SCOPE dù có nhãn "pre-existing"**: trước feature, cumulative-E2 là escape hatch — mọi chùm fail dai dẳng đều kéo cumulative rate → 100% → auto-stop. Feature này (window 60s + cap-5) **bỏ hatch đó ngay trong kịch bản AC-1** → hang trở thành deterministic và mới reachable. "Pre-existing" đúng cho class "ramp chậm không kịp target trong duration" (có từ trước), nhưng sai cho kịch bản do chính feature tạo ra. Đây là AC của chính feature → phải fix.

**Fix tối thiểu** (tại khối phase-advance, sau khối auto-stop — giữ BE-4):
```ts
if (this.phase === 'ramping') {
  if (agg.tick.counters.usersConnected >= this.config.targetUsers) {
    this.setPhase(transition(this.phase, 'steady')); ...
  } else if (elapsedSec >= this.config.durationSec) {
    // natural end dù chưa đủ target (failed users không bao giờ connect)
    this.setPhase(transition(this.phase, 'cooldown'));
    this.stopReason = 'duration hết';
    this.farm.broadcast({ type: 'stop', reason: 'duration ended', force: false });
    setTimeout(() => { if (this.phase === 'cooldown') void this.finishRun('natural', this.stopReason || 'cooldown timeout', false); }, COOLDOWN_WAIT_MS);
  }
}
```
- Hệ quả test: T7 (b) phải kết thúc `finished` + `stopReason` không chứa E2 (AC-1 đúng nghĩa); ST-12 cũng kết thúc `finished`. Không đổi ngưỡng E2.
- Chú ý: đây cũng chữa luôn hang "ramp chậm không kịp target trong duration" (pre-existing) — cùng 1 fix, không tăng scope.

### F-T7-2 — socket.io-client: `io server disconnect` không vào connect_error → E2 mù với reject thật của gateway → **IN-SCOPE-fix (HIGH — chặn AC-2/AC-7 ở kênh reject thật)**

**Xác minh trong `node_modules/socket.io-client/build/cjs` (4.8.3)**:
- `socket.js:519-521` (packet DISCONNECT) → `ondisconnect()` `socket.js:639-643` → `destroy()` (`:651-658`) + `onclose("io server disconnect")` → emit `disconnect`, **KHÔNG có connect_error**; `destroy()` unsubscribe → `manager._destroy` (`manager.js:281-291`) → mọi namespace inactive → `_close()` → `skipReconnect = true` (`manager.js:321-326`) → `onclose` không gọi `reconnect()` (`manager.js:344-355`). **Không retry.**
- `socket.js:522-528` (packet CONNECT_ERROR — middleware `next(new Error)`) → `destroy()` + emit `connect_error` 1 lần → cũng **terminal, không retry** (đúng comment mock-gateway.ts:29-30).
- Gateway THẬT reject bằng `client.disconnect()` trong `handleConnection` (`gateway-auth-service/.../websocket.gateway.ts:150-164, 179-185, 350-352`). NestJS IoAdapter gọi handleConnection sau khi connection socket.io hoàn tất (post CONNECT-ack) → client **luôn nhận `'connect'` trước** (đếm +1 attempt, `everConnected=true`) rồi mới `'disconnect' ("io server disconnect")` → **0 fail được đếm**, không retry, user kẹt `phase='connecting'` vĩnh viễn (socket-farm.ts:184-190), không bao giờ chạm cap-5 → `usersFailed = 0`.

**Kết luận kênh đếm hiện tại của E2**:
- E2 (cả cũ lẫn mới) chỉ nhìn thấy **connect_error** — kênh transport/engine lỗi (gateway down, overload, upgrade-403). Đây chính là thứ log 41% gốc đếm (retry vô hạn của connect_error) — fix mới đếm **y hệt kênh cũ**, nên không làm sai lệch chẩn đoán incident gốc.
- Kênh **post-handshake reject** (enforcement ban, token invalid — PRD §2 #2 "khả năng cao", đúng thứ DESIGN F-1 nhắm tới) **vô hình với E2 mới** → (1) AC-2 không chứng minh được trước gateway thật (mock T7 dùng kênh upgrade-403 — khác kênh gateway thật dùng); (2) M4 'reject' bucket gần như rỗng khi gặp incident thật → AC-4/AC-6 mất nửa mục đích observability; (3) user kẹt 'connecting' vĩnh viễn là bug state thật.
- **KHÔNG mâu thuẫn với cap-5**: cap-5 quản lý kênh connect_error; io-server-disconnect là 1-shot reject (không tồn tại retry loop để cap) — 2 kênh cộng tác, không đối nghịch.

**Fix tối thiểu** (socket-farm.ts, handler `'disconnect'` `:184-190`):
```ts
s.on('disconnect', (reason) => {
  const prevConnected = this.socketConnected;
  this.socketConnected = false;
  if (this.phase !== 'failed') {
    if (reason === 'io server disconnect' && this.everConnected && !this.everChatted) {
      // reject post-handshake (gateway disconnect ngay sau ack — enforcement/token invalid):
      // 1-shot — đếm 1 fail, terminal (không có retry loop để chờ cap 5)
      this.runtimeStats.connectAttempts++;
      this.runtimeStats.connectFails++;
      this.runtimeStats.connectFailsByType['reject']++;
      this.consecutiveConnectFails++;
      this.onError?.('reject', 'io server disconnect', 'connect');
      this.phase = 'failed';
      this.lastError = sanitizeLogText('failed: gateway disconnect ngay sau connect (reject)', 160);
      return;
    }
    this.phase = 'connecting';
    this.reconnectCount++;
  }
});
```
(với `everChatted` = đã từng gửi/nhận action chat — cần thêm 1 flag; hoặc heuristic đơn giản hơn: `now - connectedAt < 2000ms`. Đây là quyết định thiết kế nhỏ — panel chỉ yêu cầu đếm kênh + terminal state.)
- Mock gateway: thêm mode reject theo đúng kênh thật (middleware pass + `socket.disconnect()` ngay trong `io.on('connection')`) + 1 kịch bản T7 chứng minh AC-2 trên kênh này (100% broken → E2 stop ≤ 60s; 5% broken → 5 user 'failed', rate < 30%).

### F-T7-3 — AC-1 transient phụ thuộc pacing (ramp chậm 5/s → spike > 30%) → **ACCEPT-document (ghi PRD, KHÔNG đổi code)**

**Xác minh**: E2 quyết định ngay khi window ≥ 50 attempts (`coordinator-state.ts:166-168` + `decideAutoStop` `:67`). Rate tại thời điểm quyết định = f(ramp rate × thứ tự connect × churn retry cap-5). Ramp chậm → cửa sổ 50 attempts kéo dài ~10s → 5 fail retry của user broken chiếm tỉ trọng lớn hơn → transient có thể > 30% dù steady-state 20.8%. Đội T7 **tự xác nhận đã va phải**: `e2e-mock-gateway-e2.test.ts:225-228` — "ramp quá chậm + broken cluster → transient > 30% → flaky, đã verify" (họ né bằng ramp 20/s + deterministic counter brokenEvery=20 → 2 broken trong 50 đầu → 20%).
- Ở ramp mặc định của PRD (200/s): healthy attempts tràn window → rate quyết định ≈ 0 → AC-1 đứng vững. Chỉ slow-ramp mới dính.
- KHÔNG đổi ngưỡng (PRD §6.6); hysteresis "2 tick liên tiếp" chỉ cứu được ca 1-tick sát ngưỡng, lại làm trễ genuine stop ≤ 2s — không bắt buộc cho điều kiện test AC-1 đã ghi.
- **Hành động**: bổ sung note PRD §4 — "AC-1 đảm bảo ở ramp ≥ ~20/s; ramp chậm hơn, quyết định window đầu nhạy thứ tự connect (giới hạn tham số, cùng class BE-1 DESIGN §11.1)". Tùy chọn v1.1: hysteresis 2 tick + field `connectWindowAttempts`.

---

## B. Khe hở chéo-module (4 finding sống)

### X-1 (minor) · `loadtest/coordinator.ts:504,530` + `coordinator-state.ts:333` — rate connectFailRate biến mất khi vào cooldown → report/dashboard hiển thị 0% cuối run tự nhiên/manual
**Vấn đề**: override `agg.tick.rates.connectFailRate` chỉ chạy trong guard `ramping|steady` (`:504`); cooldown/report tick dùng default 0 của `aggregateTicks` (`:333`). Run natural-end/manual: 10s cooldown tick ghi đè → tick CUỐI trong tickHistory (report + dashboard frozen) hiển thị "Connect fail 0.0%" dù run kết thúc ở 25%. Run bị E2-stop không dính (finish cùng tick). **Fix tối thiểu**: trong cooldown, gán rate từ `this.lastWindow` (frozen): `agg.tick.rates.connectFailRate = connectFailRateFromWindow(this.lastWindow.attempts, this.lastWindow.fails)` hoặc giữ rate tick trước.

### X-2 (minor) · `src/pages/loadtest/LiveDashboardPage.tsx` (ConnectFailBreakdown) + `src/components/loadtest/connect-fail.ts:31` — breakdown card dùng cumulative, tile/banner dùng window → mâu thuẫn hiển thị sau worker restart
**Vấn đề**: window là diff-based (sống sót qua restart), cumulative reset về 0 (BE-2). Sau restart toàn bộ worker: tile đỏ 30%+ + danger banner, nhưng card breakdown (cumulative byType) hiện "Không có connect fail trong run này" (`LiveDashboardPage` empty state) — thông điệp sai sự thật. Tương tự `connectFailVariant` gate trên cumulative attempts (`connect-fail.ts:31`) → variant 'default' (xám) thay vì 'error' sau restart dù window rate ≥ 30. Không ảnh hưởng E2 (dùng window). **Fix tối thiểu**: breakdown card đổi nguồn thành window (`lastWindow` — cần expose qua tick hoặc endpoint), hoặc đổi empty-state text khi `lastWindow.fails > 0`; variant gate đổi sang window attempts.

### X-3 (PASS + note) · race tick worker — KHÔNG double-count, nhưng skip-first tick đầu làm E2 mù với incident xảy ra đúng tick đầu
**Xác minh**: `prevConnectCumulative` per-workerId + diff/clamp (`coordinator-state.ts:106-121`), tick snapshot là latest-per-worker → 2 tick cùng worker trong 1 aggregateTick không đếm đúp; test "không double-count" + F4 restart-loop (20.8% invariant) pass. **Note**: skip-first (PF1) loại vĩnh viễn toàn bộ attempts/fails tick đầu tiên của mỗi worker khỏi window → incident đúng lúc spawn (gateway down ngay đầu run) vô hình với E2 — trade-off đã chấp nhận (DESIGN §4.2), nhưng hệ quả là E2 không thể là cứu cánh cho outage lúc run-start → kết hợp F-T7-1 (hang) — cần fix F-T7-1 để run tự thoát.

### X-4 (PASS) · resetRunState / handleWorkerDied xóa đủ state window
**Xác minh**: `resetRunState` clear `prevConnectCumulative` + `windowBuckets` + `lastWindow` (`coordinator.ts:244-246`) + `workerDeathTimes` (`:243`); `handleWorkerDied` delete prev (`:120`) → skip-first phát huy sau restart. Không rò state window giữa 2 run.

### X-5 (nit) · `src/pages/loadtest/LiveDashboardPage.tsx:333-344` — banner phase 'error' không hiển thị stopReason thật
**Vấn đề**: E2/E3 stop đều vào phase 'error' nhưng banner text cứng "register/connect fail vượt ngưỡng (E1/E2)" — (1) E3-stop hiện sai text E1/E2; (2) reason thật (`E2: auto-stop: ... 34% > 30%`) chỉ nằm ở report/log, dashboard không show. **Fix tối thiểu**: dùng `stopReason` từ store (đã có `loadtest.store.ts:35,157`) trong description của banner.

---

## C. Xác nhận AC — bằng chứng vs lỗ hổng

| AC | Bằng chứng | Kết luận |
|---|---|---|
| AC-1 (run finished, 5% broken, rate < 30%) | T7 (b) `e2e-mock-gateway-e2.test.ts:218-290`: E2 không trigger ✓, rate ~20.8% ✓, 5 user failed ✓ — nhưng run **không finished** (kẹt ramping, stop tay) | **KHÔNG ĐẠT** → chặn bởi F-T7-1. Thêm nữa: premise "chuyển phase 'failed' sau ≤ 5 attempt" chỉ đúng kênh connect_error — kênh gateway thật (io server disconnect) là 1-shot, user kẹt 'connecting' → chặn bởi F-T7-2 |
| AC-2 (100% broken → E2 ≤ 60s, reason 'E2:') | T7 (c) `:292-343`: pass trên kênh mock upgrade-403 | **ĐẠT trên kênh mô phỏng, CHƯA ĐÚNG kênh gateway thật** → chặn bởi F-T7-2 (gateway thật reject bằng post-handshake disconnect → 0 fail đếm được → E2 không bao giờ fire) |
| AC-3 (window < 50 attempts không evaluate) | unit `coordinator.test.ts:389-397` + `coordinator-state.test.ts` (49→0; 50+17/50→34) + wiring | **ĐẠT** |
| AC-4 (log 8 trường) | regex test `coordinator.test.ts:399-411` + e2e (c) `:329-336` khớp `E2_LOG_RE`; `formatE2Log` `:189-197` đúng 8 trường, sum byType == windowFails (SEC-1) | **ĐẠT** |
| AC-5 (10k fresh, rate < 5%) | CHỈ mini-run 100 users `(a)` `:175-216`; **không có run 10k nào**; `report.ts` **không chứa** connect metrics (AC-5 ghi "dashboard/report") | **BẰNG CHỨNG THIẾU** — cần ít nhất 1 lần chạy scale thật + note report thiếu field (hoặc sửa AC-5 thành dashboard-only) |
| AC-6 (dashboard hiển thị) | T6: `LiveDashboardPage.test.tsx` 6 case (tile/variant/breakdown/danger/replay/empty) + `user-phases.test.ts` (donut failed + clamp) | **ĐẠT** (test-level; không có screenshot — chấp nhận) |
| AC-7 (E1/E3 nguyên vẹn, E2 thật, failed không tốn CPU) | E1 boundary regression ✓ (coordinator-state.test), E3 restart ✓ (có sẵn), BE-4 ✓ (`coordinator.test.ts:413-420`), M7 scheduler skip ✓ (T3-5 `socket-farm.test.ts:258`) | **MỘT PHẦN** — "E2 vẫn là auto-stop thật sự" bị xói mòn bởi F-T7-2 (mù kênh reject thật) |

**Lỗ hổng logic test↔thực tế lớn nhất**: toàn bộ T7 dùng 2 kênh reject (upgrade-403 → connect_error retry; middleware → CONNECT_ERROR 1-shot) — **cả 2 đều KHÔNG phải kênh gateway thật dùng** (post-handshake `client.disconnect()`). Mọi kết luận AC-1/AC-2 suy ra được từ mock đều không ngoại suy được sang gateway thật cho tới khi F-T7-2 được fix + mock thêm mode kênh thật.

---

## D. Verdict tổng

| Finding | Severity | Phán quyết |
|---|---|---|
| F-T7-1 (kẹt ramping vĩnh viễn, AC-1 vỡ) | 🔴 HIGH | **IN-SCOPE-fix** (duration escape trong ramping, mô tả ở A) |
| F-T7-2 (E2 mù kênh io server disconnect — reject thật gateway) | 🔴 HIGH | **IN-SCOPE-fix** (đếm 1-shot reject + terminal 'failed' + mock mode kênh thật + T7 mới) |
| F-T7-3 (transient phụ thuộc pacing) | 🟡 MEDIUM | **ACCEPT-document** (ghi note PRD §4 — giới hạn tham số ramp ≥ ~20/s; không đổi code) |
| X-1 (rate mất khi cooldown → report 0% cuối run) | 🟡 minor | fix nhỏ (frozen rate từ lastWindow) |
| X-2 (breakdown cumulative vs window mâu thuẫn sau restart) | 🟡 minor | fix nhỏ (đổi nguồn window / sửa empty-state) |
| X-3 / X-4 (race tick, reset state) | — | **PASS** (verified, không sửa) |
| X-5 (banner error không show stopReason, E3 hiện text E1/E2) | 💭 nit | fix nhỏ (dùng stopReason từ store) |
| AC-5 (10k) | — | thiếu bằng chứng — thêm 1 lần chạy scale thật + report thiếu connect metrics |

**VERDICT: FAIL (chờ fix F-T7-1 + F-T7-2; F-T7-3 ACCEPT-document)** — không merge khi AC-1 (run 'finished') và AC-2 (E2 trên kênh reject thật của gateway) chưa được chứng minh bằng code + test. Sau khi fix 2 blocker, cần re-run T7 (b)/(c) trên mock mode kênh thật + 1 lần chạy scale thật cho AC-5 trước khi PASS.
