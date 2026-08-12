# Panel Phase 4 — Realtime lens: F-T7-2 verify — E2 có MÙ với reject thật của gateway?

**Lens**: socket semantics (realtime-collaboration-engineer) · **Ngày**: 2026-08-05 · **Chế độ**: HOÀI NGHI — verify bằng đọc mã nguồn node_modules (socket.io-client **4.8.3** / engine.io-client 6.6.6 / socket.io server 4.8.3 — root node_modules, loadtest không có package.json riêng) + **experiment thật** (script tạm, đã xóa) chạy cả 5 kênh với client options GIỐNG HỆT socket-farm.ts:150-163.

---

## 1. Verify 5 kênh reject (code + experiment)

Experiment: server socket.io thật + client `io(url, { transports:['websocket'], reconnection:true, reconnectionAttempts:Infinity, reconnectionDelay:1000, reconnectionDelayMax:10000, timeout:20000 })` — đúng options socket-farm.ts:150-163. Mỗi kênh quan sát 4s, log mọi event client + `manager._readyState/_reconnecting/skipReconnect`.

| Kênh | Client nhận gì | Retry? | Bằng chứng code (node_modules) | Experiment |
|---|---|---|---|---|
| **A** — middleware `next(new Error)` → CONNECT_ERROR packet | `connect_error` 1 lần, `err.message` = đúng message middleware (`"AUTH_FAIL: middleware reject"`) | **KHÔNG — terminal** | socket.js:522-528 (`CONNECT_ERROR` → `destroy()` → unsubs + `io._destroy`) + manager.js:281-291 (`_destroy` → `_close` → `skipReconnect=true`) + manager.js:361-364 (`reconnect()` return khi skipReconnect) | `connect_error ×1`, `skipReconnect=true`, `_reconnecting=false`, không reconnect_attempt |
| **B** — server `client.disconnect()` trong connection handler (**kênh reject của gateway thật**) | `connect` TRƯỚC (server đã gửi CONNECT ack — server socket.js:406-420 `_onconnect()` ghi packet CONNECT trước khi emit `connection`), rồi `disconnect` reason **`"io server disconnect"`**. **KHÔNG có connect_error** | **KHÔNG — terminal** | socket.js:639-643 (`ondisconnect` → `destroy()` → `onclose("io server disconnect")`) + manager `_close` → skipReconnect=true | `connect` → `disconnect(io server disconnect)`, `skipReconnect=true`, không retry |
| **B3** — server `socket.disconnect(true)` (enforcement kick — websocket-emitter.service.ts:98-105) | GIỐNG HỆT B (Client._disconnect gọi `socket.disconnect()` từng namespace TRƯỚC khi close engine → client vẫn nhận DISCONNECT packet) | KHÔNG — terminal | socket.io/dist/client.js `_disconnect()` | `connect` → `disconnect(io server disconnect)`, terminal |
| **B4** — `ioServer.close()` (deploy drain / shutdown) | `disconnect` reason **`"transport close"`**, `socket.active = true` → manager GIỮ socket và retry → vòng kênh C | **CÓ** (về kênh C) | manager.js:344-355 (`onclose`: `_reconnection && !skipReconnect` → `reconnect()`) | `disconnect(transport close)` → `connect_error "websocket error"` retry liên tục |
| **C** — engine-level: HTTP 403 at upgrade / refused / timeout | `connect_error` **mỗi attempt**, message `"websocket error"` (hoặc `"timeout"` khi hết 20s) | **CÓ — vô hạn** (backoff 1s→10s + jitter) | socket.js:454-458 (`onerror`: `!connected` → `connect_error`) + manager.js:344-355 (reconnect) | 3× `connect_error` trong 4s, `_reconnecting=true` cuối cùng |

**Kết luận verify F-T7-2(a)(b)(c)**: (a) middleware reject = `connect_error` **1 lần terminal**, không retry. (b) `client.disconnect()` phía server = client nhận `disconnect` reason `"io server disconnect"` (KHÔNG connect_error), **không retry**. (c) engine-level = `connect_error` retry **vô hạn**. Cả 3 đúng như bảng trên, xác minh 2 chiều (mã nguồn + experiment).

---

## 2. Kênh nào là reject thật của gateway? E2 đếm được kênh nào?

**Gateway thật CHỈ dùng kênh B** — 100% reject path trong `websocket.gateway.ts` dùng `client.disconnect()` không middleware, không engine-reject:
- Thiếu token → `client.disconnect()` (:150-153)
- Token invalid/hết hạn → `client.disconnect()` (:161-164)
- Enforcement level ≥ 3 → `client.disconnect()` (:179-185)
- Exception trong handleConnection → `client.disconnect()` (:350-352)
- Grep toàn `gateway-auth-service/src`: **không có `io.use` / middleware socket.io nào**; `disconnect(true)` chỉ ở websocket-emitter.service.ts:104 (kick enforcement) = kênh B3, client-side giống hệt B.

| Kênh | Gateway thật có dùng? | E2 hiện tại đếm? |
|---|---|---|
| A (middleware) | KHÔNG | Có (1 fail/user — terminal, an toàn) |
| **B (disconnect trong handleConnection)** | **CÓ — mọi reject auth/enforcement** | **KHÔNG — BLIND** |
| B3 (kick) | Có (enforcement) | KHÔNG — BLIND |
| B4/C (engine-level) | Chỉ khi hạ tầng từ chối (nginx/network/overload/timeout) | Có (fail/attempt mỗi retry — đây là nguồn 41%) |

**Kênh B hoạt động thế nào trên client loadtest**: server gửi CONNECT ack TRƯỚC khi reject → client 'connect' handler chạy (`socket-farm.ts:166-182`: `connectAttempts++`, `everConnected=true`, phase='connected') → rồi 'disconnect' handler (`socket-farm.ts:184-190`: phase='connecting', `reconnectCount++`). Kết cục: **user kẹt phase 'connecting' VĨNH VIỄN** — socket sống (`this.socket` không null, `connect()` :147 guard `if (this.socket) return`), manager `skipReconnect=true` không retry, không bao giờ có `connect_error` → **0 fail, 1 attempt "thành công" giả**. Không chạm cap-5, không vào 'failed', `usersFailed` = 0, `connected` đỉnh thấp âm thầm. E2 rate không bị ảnh hưởng → **E2 MÙ hoàn toàn với reject thật của gateway**.

**41% của founder đến từ kênh nào?** Không thể là B (B sinh 0 fail). Chỉ có kênh C (websocket error/timeout ở engine level — gateway quá tải/restart/nginx/network trong cửa sổ ramp) + counter cumulative toàn run + retry Infinity = vô hạn fail không bao giờ trôi → 41%. Khớp root cause #1 (thiết kế counter) + #3 (từ chối nhất thời). **Root cause #2 (token hết hạn → retry loop) SAI về cơ chế**: reconnect với token hết hạn gặp kênh B = terminal, không retry, không fail count — user chết âm thầm, không hề thổi phồng 41%. (Tác hại thật của #2 là user chết vô hình, không phải inflate counter.)

---

## 3. Phán quyết F-T7-2

### **FIX CẦN THÊM** (không accept-document)

Lý do: E2 sau fix (window + cap-5 + classify) vẫn **MÙ với kênh reject duy nhất của gateway thật** (B). Hệ quả thực: chạy 10k với 100% token lỗi trên gateway THẬT → E2 KHÔNG bao giờ stop (rate 0%); AC-2 trong e2e-mock-gateway-e2.test.ts (c) chạy đúng chỉ vì mock dùng 403-upgrade (kênh C) — **test pass nhưng không phản ánh production semantics**. Đồng thời user bị reject kẹt 'connecting' vĩnh viễn, vô hình trên dashboard và usersFailed.

### Đề xuất fix tối thiểu (CHỈ ĐỀ XUẤT — không sửa code)

Trong `socket-farm.ts:184-190` ('disconnect' handler), phân biệt reason:

```ts
s.on('disconnect', (reason) => {
  if (this.phase === 'failed') return;
  this.socketConnected = false;
  if (reason === 'io server disconnect') {
    // Kênh B/B3 (đã verify): server cố tình refuse session — terminal theo protocol
    // (skipReconnect=true, client KHÔNG retry) → cutover NGAY, không chờ cap-5.
    // Attempt đã đếm ở 'connect' (:175) — chỉ thêm fail, KHÔNG đếm attempt nữa
    // (giữ invariant fails <= attempts, sum(byType) == fails).
    this.runtimeStats.connectFails++;
    this.runtimeStats.connectFailsByType.reject++;
    this.consecutiveConnectFails++;
    this.onError?.('reject', 'server namespace disconnect (io server disconnect)', 'connect');
    this.phase = 'failed';
    this.socket?.disconnect();
    this.socket?.io?.reconnection(false); // mặc dù đã skipReconnect — phòng race
    this.lastError = sanitizeLogText(`${this.lastError} | server từ chối session (io server disconnect) → failed`, 160);
    return; // KHÔNG reconnectCount++ (reconnect này không bao giờ xảy ra)
  }
  this.phase = 'connecting';   // engine-level (transport close/ping timeout) — giữ retry bình thường
  this.reconnectCount++;
});
```

Kèm theo (cùng PR): thêm mode reject kênh B vào `mock-gateway.ts` (io.on('connection') → socket.disconnect() khi token không hợp lệ — giống hệt gateway thật) + 1 integration case "100% token lỗi kênh B → E2 stop, byType.reject, usersFailed" — hiện suite chỉ test kênh A (ST-12) và C (403).

### Trade-off (bắt buộc ghi rõ)

| Rủi ro | Mức | Đánh giá |
|---|---|---|
| **False positive**: enforcement kick user KHỎE giữa run (ban/đổi mật khẩu → websocket-emitter.service.ts:104) cũng đến client dưới dạng 'io server disconnect' (B3 — không phân biệt được trên wire với B) → đếm 1 fail | Thấp | Đây THỰC SỰ là "server từ chối session của user" — fail thật, có ý nghĩa vận hành; bounded 1 fail/user, không loop; loadtest user prefix `[lt]` nên ban ngẫu nhiên hiếm |
| **False positive**: disconnect tự nhiên (network hiccup, ping timeout) bị đếm nhầm | **Không xảy ra** | Các kênh này ra reason "transport close"/"ping timeout" (engine-level) — đã verify B4 — KHÔNG phải 'io server disconnect' |
| **False positive**: deploy drain bị đếm nhầm | **Không xảy ra** | B4: `ioServer.close()` → reason "transport close", `socket.active=true` → chạy kênh C bình thường (retry + đếm theo attempt, cap-5 chặn) |
| Số học AC-1/AC-2 đổi | Không vỡ | Kênh B giờ đóng góp 1 fail + 1 attempt/user (attempt đã đếm ở 'connect') → 5% broken = 10.000 attempts/500 fails = **5%** < 30% (AC-1 càng an toàn); 100% broken = 10.000/10.000 = **100%** ≥ 50 attempts (AC-2 vẫn stop). Cap-5 vẫn giữ làm giới hạn tối đa |

---

## 4. Cross-check T3 cap-5 với terminal rejects (Q4)

- Kênh A: 1 `connect_error` terminal — cap-5 **không bao giờ chạm** (1 < 5). Kênh B: 0 `connect_error` — cap-5 không liên quan. Kênh C: retry vô hạn — **cap-5 là rào duy nhất**.
- **Đánh giá**: cap-5 chỉ còn cần thiết cho kênh C — và kênh C CHÍNH LÀ kênh đã tạo 41% (mục 2) → **cap-5 vẫn cần thiết, giữ nguyên thiết kế**. Nếu chỉ có reject auth (kênh A/B), cap-5 thành dead code — nhưng thực tế hạ tầng reject/timeout là kênh loadtest đối mặt thường xuyên nhất. Không đổi thiết kế.
- Ghi chú nhỏ: với đề xuất mục 3, user kênh B cutover NGAY (1 fail) thay vì chờ 5 — nhanh hơn và đúng semantics terminal; cap-5 vẫn là trần an toàn tổng thể.

## 5. Khe hở realtime khác (Q5)

1. **[CHÍNH] 'disconnect' handler không phân biệt reason** (socket-farm.ts:184-190): mọi disconnect → phase 'connecting' + `reconnectCount++` — kể cả terminal 'io server disconnect' (reconnect không bao giờ xảy ra → reconnectCount đếm ảo) và kẹt vĩnh viễn. Fix = mục 3.
2. **connectAttempts đếm "thành công giả"**: kênh B được đếm 1 attempt thành công ở 'connect' (socket-farm.ts:175) — làm phình mẫu số, che fail thật. Được sửa bởi mục 3 (fail + attempt đi cùng).
3. **Heartbeat/watchdog không có**: user phase 'connecting' kẹt không có cơ chế phát hiện (không lastActivity, không watchdog) — mục 3 xử lý kênh phổ biến nhất; kênh C đã có cap-5. Không cần thêm watchdog ở MVP.
4. **Mock-gateway comment sai version** (mock-gateway.ts:26 ghi "4.8.1", thực tế cài 4.8.3) + **sai vector**: comment "403 upgrade → đúng vector PRD §1.2" — PRD §1.2 mô tả cơ chế client.disconnect() (kênh B) nhưng mock mô phỏng bằng 403 (kênh C); 2 kênh khác hẳn semantics (terminal vs retry). Chính PRD §1.4 dòng "Client socket.io nhận connect_error khi server disconnect ngay trong handshake — retry Infinity → loop fail" **sai sự thật** (đã verify kênh B: 'disconnect', không retry). Cần sửa PRD §1.4 + mock.

---

## 6. Tóm tắt phán quyết

| Câu hỏi | Trả lời |
|---|---|
| (a) middleware next(Error) | `connect_error` message đúng, **1 lần terminal**, không retry (socket.js:522-528 + manager _destroy/_close; probe A) |
| (b) server socket.disconnect() | `connect` → `disconnect "io server disconnect"`, **không connect_error, không retry** (socket.js:639-643; probe B/B2/B3) |
| (c) engine-level 403/refused/timeout | `connect_error` mỗi attempt, **retry vô hạn** (manager.js:344-355; probe C) |
| Kênh gateway thật | **B** (mọi reject = client.disconnect(), không middleware) + B3 (kick) |
| E2 sau fix có mù không | **CÓ** — kênh B sinh 0 fail, 1 attempt giả; E2 không bao giờ stop kể cả 100% reject; AC-2 test dựng trên kênh C sai vector |
| F-T7-2 phán quyết | **FIX CẦN THÊM** — đếm 'io server disconnect' = 1 reject-fail + cutover failed ngay (mục 3), kèm mock kênh B + sửa PRD §1.4 |
| Cap-5 | Giữ nguyên — chỉ cần cho kênh C (nguồn 41% thật); A/B terminal sẵn, cap là dead code vô hại |
| Trade-off chính | Kick enforcement user khỏe → 1 fail (bounded, không loop, đúng nghĩa "server từ chối session"); disconnect tự nhiên/drain KHÔNG bị đếm (đã verify reason khác) |
