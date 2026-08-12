# STAGED PRODUCTION LOAD TEST — MAYogu

Hướng dẫn vận hành test sức chịu tải THẬT của hệ thống production
(gateway `https://api.mayogu.com` + matching service) bằng loadtest tool
(UI `:5173`, API `:3401`) theo kiểu tăng dần từng bậc, KHÔNG sập production.

**Mục tiêu:** xác định **capacity thật** = bậc users lớn nhất mà hệ thống
production chịu được bền vững (connect fail < 5%, 0 E2, match > 80%) — có số
liệu, không phỏng đoán.

**Hiện trạng (bằng chứng 3 run gần đây — ghi nhận trước khi bắt đầu):**

| Run | Kết quả | Đọc được gì |
|---|---|---|
| 1000u | E2 stop @ connect fail **31.4%** | Đây là bậc vượt ngưỡng hoặc cận ngưỡng của cấu hình đã chạy |
| 10k | 41% fail | Càng xa khỏi capacity, fail càng cao |
| 10k **burst** | **80.3% fail toàn reject** | 1 IP đánh đồng loạt → gateway production reject hàng loạt — burst là kịch bản tự sát |
| Diagnostic 1 user | OK, match ~1s | Hệ thống sống, luồng cơ bản ngon |
| Diagnostic 5 user song song | 1 timeout | Ngay ở mức 5 users đã thấy latency bất thường — matching có thể không scale tuyến tính |

**Hệ quả:** capacity thật có thể ĐANG < 1000u với profile hỗn hợp. Bậc 1000u
chat-only là bậc quyết định của phiên test này.

---

## 1. Nguyên tắc (3-5 dòng)

1. **Tăng dần từng bậc** — mỗi bậc là 1 run riêng; CHỈ tiến bậc sau khi bậc trước PASS
   toàn bộ tiêu chí (connect fail < 5% duy trì, 0 E2, match > 80%).
2. **Đo rồi mới chuyển bậc** — sau mỗi run, chờ **settle 5-10 phút** (dashboard về
   baseline, queue rỗng, CPU gateway hạ) rồi mới chạy bậc tiếp theo.
3. **Dừng ngay khi có dấu hiệu quá tải** — E2 fire (tự dừng), connect fail > 10%,
   hay dashboard/API không phản hồi 5s → dừng thủ công, KHÔNG "cố chạy cho xong".
4. **Ramp ≥ 20/s, luôn `rampMode: 'rate'`** — ramp chậm hơn 20/s gây transient spike
   connect fail > 30% → E2 false-positive (F-T7-3); burst = connect toàn bộ user
   ngay tick đầu → chính là kịch bản 80.3% reject ở trên. **Không burst production.**
5. **Ghi lại capacity thật, không xóa kết quả fail** — run fail cũng là dữ liệu:
   nó vẽ ra biên capacity.

---

## 2. Bảng staged protocol

> **Lưu ý ràng buộc tool (đã verify trong code):** `validateRunRequest`
> (loadtest/config.ts) và UI (ControlPanelPage.tsx) **chặn cứng `targetUsers < 1000`**
> — mọi run qua API/UI phải ≥ 1000 users. Do đó:
> - Bậc 1/2 (100u, 300u) và bậc chia nhỏ 500u **không chạy được qua Control Panel**
>   → dùng **diagnostic thủ công** (script/socket client tự viết, 1-10 users) chỉ để
>   xác nhận hệ thống còn sống + đo baseline logic — KHÔNG dùng số liệu < 1000u làm
>   số capacity chính thức.
> - Số capacity chính thức bắt đầu từ bậc 1000u (tool floor).

| Bậc | Users | Duration đề xuất | Ramp | Burst/Rate | Cách chạy | PASS criteria | STOP criteria (dừng ngay) | Settle trước bậc kế |
|---|---|---|---|---|---|---|---|---|
| 0 (diagnostic) | 1 → 5 → 10 | ~1 phút / mức | thủ công từng user | thủ công | Ngoài tool (socket client thủ công) | match thành công ~1s, 0 timeout ở 5 users | ≥ 1 timeout liên tiếp ở mức hiện tại | 5 phút |
| 1 | 100u (baseline) | ~2 phút | thủ công / vài user | thủ công | Ngoài tool (tool chặn < 1000) | 0 lỗi, match OK | bất kỳ timeout/reject nào | 5 phút |
| 2 | 300u | ~2 phút | thủ công / vài user | thủ công | Ngoài tool (tool chặn < 1000) | 0 lỗi, match OK | bất kỳ timeout/reject nào | 5 phút |
| 3 | 1000u (bậc quyết định — từng fail 31.4%) | 10 phút (AC-5: ≥ 10p để E2 có đủ cửa sổ 60s) | 50/s (`rate`) | rate | Control Panel | connect fail < 5% **duy trì suốt steady**, 0 E2, match/echo > 80%, MATCH_TIMEOUT < 5% chat actions | E2 fire / connect fail > 10% / dashboard treo 5s | 5-10 phút |
| 4 | 2000u | 10 phút | 100/s (`rate`) | rate | Control Panel | như trên | như trên | 5-10 phút |
| 5 | 5000u | 10 phút | 150/s (`rate`) | rate | Control Panel | như trên | như trên | 5-10 phút |
| 6 | 10000u | 10 phút | 200/s (`rate`) | rate | Control Panel | như trên | như trên | 5-10 phút |

Quy tắc bảng: **Bậc N chỉ được chạy khi bậc N-1 PASS.** Nếu 1000u (Bậc 3) fail →
capacity thật nằm dưới 1000u; không được nhảy lên 2000u trong cùng phiên. Nghi
ngờ biên tại 1000u → chạy lại 1000u 1 lần nữa sau settle 10 phút để loại trừ nhiễu
thay vì đổi tham số giữa chừng.

**Về profile theo bậc:**
- Bậc 0-3: **chat-only** (`chat: 100`) — đo đúng socket + matching (đường biên chính
  đang yếu nhất: 5 users đã 1 timeout). Không kéo REST theo để cô lập biến.
- Bậc 4 trở lên: thêm dần REST (`like`/`comment`/`view`) — vd 40/30/20/10
  (chat/read/comment/like — profile mặc định của tool) để đo áp lực tổng hợp.
- Cần `LOADTEST_COMMUNITY_ID` khi bật like/comment/view/read (khóa về 1 community).

**Burst dùng khi nào:** gần như KHÔNG BAO GIỜ trên production. Chỉ dùng khi (a) cố
tình kiểm chứng hành vi reconnect/connect-storm ở mức thấp đã biết an toàn, hoặc
(b) trên môi trường staging, hoặc (c) sau khi đã biết capacity và có sẵn sàng chịu
fail-toàn-bộ. Burst trên production với 1 IP = bóp nghẹt gateway (bằng chứng 80.3%).

---

## 3. Cách cấu hình từng bậc

### 3.1 Env (`loadtest/.env`) — cấu hình 1 lần cho cả phiên

```env
# ── Cho phép production TƯỜNG MINH (guard mặc định chỉ allow localhost:3000) ──
# Nếu thiếu dòng này → POST /start trả lỗi + UI cảnh báo đỏ.
LOADTEST_ALLOWLIST=http://localhost:3000,https://api.mayogu.com

# ── Target = production ──
LOADTEST_GATEWAY_URL=https://api.mayogu.com

# ── Account pool (BẮT BUỘC khi chạy production — tránh register OTP/rate-limit) ──
# File JSON account THẬT, đặt NGOÀI cây repo (credential). Pool phải đủ ≥ 10000
# accounts cho bậc 6 — cạn pool → run fail sớm. Chế độ pool file = KHÔNG register.
LOADTEST_POOL_FILE=C:/MAYogu_VIASG/secrets/users_accounts.json

# ── Khóa REST actions vào đúng 1 community test (Bậc 4+) ──
LOADTEST_COMMUNITY_ID=<community-id-test>

# ── Giới hạn an toàn (mặc định đã đủ: maxTarget 200k, maxDurationMin 60) ──
```

Lưu ý: `LOADTEST_OTP_SECRET`/`LOADTEST_REDIS_URL` chỉ cần khi register — dùng pool
file thì không cần (register trên production = thêm gánh nặng + rate-limit IP).

### 3.2 UI (Control Panel `:5173`) — từng bậc

| Trường | Bậc 3 (1000u) | Bậc 4 (2000u) | Bậc 5 (5000u) | Bậc 6 (10000u) |
|---|---|---|---|---|
| Users (target) | 1000 | 2000 | 5000 | 10000 |
| Duration | 10 phút | 10 phút | 10 phút | 10 phút |
| Ramp | 50/s | 100/s | 150/s | 200/s |
| Mode | rate | rate | rate | rate |
| Action profile | chat 100 | chat 100 | chat 40 / read 30 / comment 20 / like 10 | chat 40 / read 30 / comment 20 / like 10 |
| freshAccounts | Tắt (dùng pool file) | Tắt | Tắt | Tắt |

Gateway URL trong UI phải đúng `https://api.mayogu.com` và phải nằm trong
allowlist — nếu UI báo đỏ, kiểm tra `LOADTEST_ALLOWLIST` + `dataDir/settings.json`
(Màn 6 Settings: cho phép bổ sung URL qua UI, gộp với env allowlist).

---

## 4. Theo dõi trong lúc chạy

### 4.1 Trong dashboard (`:5173`)
- **Connect fail %** (rates.connectFailRate) — chỉ số quyết định; xem có duy trì
  < 5% suốt phase steady không (spike lẻ đầu ramp là bình thường, duy trì > 5% là báo động).
- **Breakdown connect fail theo loại** (`byType`): timeout / transport / reject / other —
  sum 4 loại == tổng fail (bất biến của tool). Loại nào chiếm ưu thế → kênh hỏng là kênh đó.
- **usersActive / usersConnected / usersQueued** — queue tăng không giảm → matching tắc.
- **queueCount** (Redis `match:queue`) — server-side view; > 0 kéo dài = matching service chậm.
- **MATCH_TIMEOUT** (code lỗi chat — chờ `matching:found` > 60s) — đếm phải thấp
  (< 5% chat actions); tăng dần = matching không theo kịp.
- **workersAlive / workersTotal** — worker chết/restart (E3) = tool bên máy test bị bão hòa,
  phân biệt với production quá tải.
- **E2 log** — dòng `E2: …` 8 trường trong log tool (xem mục 5).

### 4.2 Ngoài tool (bắt buộc — đây mới là bằng chứng phía production)
- **nginx/CDN logs gateway `api.mayogu.com`**: 5xx? `429`? reject handshake? tốc độ
  connect/s từ IP máy test.
- **CPU/RAM gateway production** (host/vm metrics): quá 80% CPU / swap → gateway là
  điểm nghẽn; còn thấp mà vẫn fail → nghi match service hoặc network.
- **matching-tick service logs**: vòng matching có kịp tick không, **có rate-limit
  theo IP không** (1 IP máy test gõ 1000-10000 connect/s rất dễ chạm bucket IP của
  gateway — nếu thấy rate-limit theo IP, phải báo giới hạn đó làm "trần" của tool:
  tool chỉ đo được đến mức gateway cho phép từ 1 IP).

---

## 5. Khi E2 fire — quy trình xử lý

E2 = auto-stop: connect fail > 30% trong cửa sổ trượt 60s, ≥ 50 attempts
(loadtest/coordinator-state.ts — ngưỡng cố định, không cấu hình được). Run chuyển
`status: error`, `stopReason` bắt đầu bằng `E2:`.

**Bước 1 — Đọc log E2 (8 trường), ví dụ:**
```
E2: auto-stop: connect fail 31.4% > 30% (E2) |
phase=steady elapsedSec=412 windowSec=60 windowAttempts=980 windowFails=308 |
byType=timeout:12,transport:0,reject:296,other:0 usersFailedCum=308 workersAlive=2 workersTotal=2
```
| Trường | Ý nghĩa | Nếu bất thường |
|---|---|---|
| phase | pha run lúc dừng | fail ở `ramping` = spike ramp; ở `steady` = quá tải thật |
| windowSec / windowAttempts / windowFails | cửa sổ 60s trượt, mẫu thật | attempts << users = tool không kịp connect |
| **byType** | **kênh fail: timeout / transport / reject / other** (sum == windowFails) | xem dưới |
| usersFailedCum | tổng user failed tích lũy | tăng dù byType nhỏ = hệ thống nghẹt dần |
| workersAlive / workersTotal | worker tool sống/chết | alive < total = tool (máy test) sập, không phải production |

**Bước 2 — Xác định kênh fail chủ đạo:**
- **`reject` chiếm ưu thế** (trường hợp 80.3% và 31.4% gần đây): gateway chủ động
  reject/handshake-fail (auth, server full, **rate-limit IP** — 429). Kênh reject là
  **TERMINAL** (tool không retry) → đây là tín hiệu "gateway đang chặn/quá tải" rõ nhất.
  Kiểm tra nginx logs + rate-limit IP ngay.
- **`timeout` chiếm ưu thế**: gateway không accept kịp (backlog đầy / CPU cao) →
  xem CPU/RAM gateway, matching service.
- **`transport` chiếm ưu thế**: lỗi lớp vận chuyển (TLS/đứt kết nối) → nghi hạ tầng
  mạng/CDN giữa máy test và gateway, không phải logic.

**Bước 3 — Hành động:**
1. Dừng hẳn (E2 đã tự dừng; xác nhận run = `error`).
2. Đối chiếu 4.1 + 4.2 (dashboard, nginx, CPU/RAM, matching logs).
3. **Lùi 1 bậc** (vd đang 2000u fail → quay về 1000u).
4. **Settle 10 phút**, đợi queue rỗng + CPU hạ.
5. Chạy lại bậc lùi 1 lần để xác nhận nó PASS (loại trừ nhiễu).
6. Nếu bậc lùi lại fail lần 2 → **đó là capacity thật**, ghi nhận, kết thúc phiên —
   không thử bậc cao hơn trong cùng ngày.

---

## 6. Ghi kết quả — template

Ghi từng bậc vào bảng sau (có thể gộp nhiều phiên theo ngày):

| Bậc | Ngày/giờ | Users | Profile | Connect fail % (đỉnh / duy trì) | E2? (kênh chủ đạo) | Match/echo % | MATCH_TIMEOUT count | Gateway CPU đỉnh | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| 3 | 2026-08-06 22:00 | 1000 | chat 100 | 2% / 1% | Không | 98% | 3 | 45% | **PASS** |
| 4 | 2026-08-06 22:20 | 2000 | chat 100 | 6% / 4% | Không | 92% | 41 | 70% | PASS (biên) |
| 5 | 2026-08-06 22:45 | 5000 | 40/30/20/10 | 12% / 9% | Có (reject) | 71% | 230 | 88% | **FAIL → E2** |

**Kết luận capacity:**
> Capacity thật = bậc lớn nhất mà **connect fail < 5% duy trì suốt steady + 0 E2 +
> match > 80%**. Trong ví dụ trên → capacity ≈ 1000-2000u chat-only. Ghi rõ:
> "Production chịu được X users chat-only / Y users hỗn hợp; trên đó, kênh fail là
> reject (gateway quá tải/rate-limit IP)".

Kèm theo mỗi bậc: report JSON/MD/CSV của tool (`docs/loadtest-reports/`) + ảnh chụp
dashboard + log E2 (nếu có) — để phiên sau đối chiếu, không phải chạy lại từ đầu.

---

## 7. An toàn — checklist trước mỗi phiên

- [ ] **Không nhảy bậc**: chưa có 1000u PASS thì không chạy 2000u, và đặc biệt
  **không chạy 10000u production** khi chưa qua đủ bậc nhỏ.
- [ ] **Không burst** production (bằng chứng: 10k burst = 80.3% reject).
- [ ] **Giờ chạy**: tránh giờ cao điểm người dùng thật (khuyến nghị ngoài giờ —
  tối muộn / cuối tuần) và thông báo change window cho team.
- [ ] **Có người on-call** xem gateway production trong suốt run (nginx/CPU/RAM),
  sẵn sàng chặn IP máy test nếu cần khống chế.
- [ ] 1 IP duy nhất đánh production → biết trước giới hạn rate-limit IP của gateway;
  tool chỉ đo được tới mức đó.
- [ ] Pool accounts riêng (≥ 10000 accounts, file ngoài repo), KHÔNG đụng user thật;
  `freshAccounts: false`.
- [ ] `LOADTEST_ALLOWLIST` chứa `https://api.mayogu.com` tường minh (guard chặn
  production nếu không khai báo — nếu thấy UI báo đỏ là ĐÚNG, không bypass bằng
  cách sửa allowlist trong lúc chạy).
- [ ] Bậc 1000u = bậc quyết định (đã fail 31.4% trước đó) — chuẩn bị tâm lý nó fail
  và quy trình mục 5 sẵn sàng.

---

## Phụ lục — tham chiếu

- Cấu hình run/allowlist: `loadtest/config.ts` (guard `LOADTEST_ALLOWLIST`, validate
  `targetUsers ≥ 1000`, presets, maxTarget) · `loadtest/.env.example`
- E2 auto-stop + log 8 trường: `loadtest/coordinator-state.ts` (E2_FAIL_RATE_PCT=30,
  E2_WINDOW_MS=60s, E2_MIN_ATTEMPTS=50) · `loadtest/coordinator.ts` (wire, reorder)
- Phân loại connect fail: `loadtest/types.ts` (`ConnectFailType`, `byType`) ·
  `loadtest/socket-farm.ts` (reject TERMINAL, MATCH_WAIT_MS=60s)
- Dashboard tick: `loadtest/types.ts` (`LoadTestTick` — connectFailRate, usersActive,
  MATCH_TIMEOUT qua per-action errors)
- Ràng buộc ramp (F-T7-3): `docs/CANARY-loadtest-e2-connect-fail.md` (ramp ≥ 20/s)
- Kịch bản canary tham khảo: `docs/CANARY-loadtest-e2-connect-fail.md`
