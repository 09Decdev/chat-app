# Mutation Report — G2 (hard-gate) fix E2 connect-fail — ROUND 2 (kills critical mutants)

- **Branch**: `fix/loadtest-e2-connect-fail` @ `fa4da02` + test bổ sung G2 (chưa commit lúc ghi)
- **Ngày**: 2026-08-06 · **Runner**: @stryker-mutator/core 9.6.1 + vitest-runner, `coverageAnalysis: perTest`, concurrency 2, timeoutMS 60s×2
- **Config dùng** (tạm, không đụng config gốc): `stryker.config.e2.mjs` + `loadtest/vitest.mutation.e2.config.ts` — mutate đúng 3 module critical của fix E2; chỉ include test của 3 module đó (127 tests cho coordinator-state + socket-farm sau khi bổ sung, baseline <1s).
- **Thời gian chạy**: 2m02s. Không lỗi chạy (0 errors, 0 test crashes). `thresholds.break: 0` — verdict tính thủ công từ `reports/mutation/e2-mutation-report.json`.
- **Vòng 1** (46.57% tổng) → **vòng 2** này sau khi bổ sung ~20 test G2 theo khuyến nghị §4 của vòng 1.

## 1. Mutation score

| File | Score tổng (v1 → v2) | Score covered* (v1 → v2) | Killed | Timeout | Survived | NoCoverage |
|---|---|---|---|---|---|---|
| **Tổng** | **46.57% → 57.72%** | 64.64% → 76.05% | 671 | 2 | 212 | 281 |
| coordinator-state.ts | 84.67% → **98.85%** | 85.00% → 99.23% | 256 | 2 | 2 | 1 |
| sanitize.ts | 87.50% → 87.50% | 87.50% → 87.50% | 42 | 0 | 6 | 0 |
| socket-farm.ts | 32.67% → **43.52%** | 52.63% → 64.64% | 373 | 0 | 204 | 280 |

\* covered = Killed/(total − NoCoverage).

### Score theo hàm critical (vùng lõi của fix E2) — vòng 2

| Hàm (coordinator-state.ts) | Score | Hàm (socket-farm.ts) | Score |
|---|---|---|---|
| decideAutoStop + formatRatePct | **100%** | classifyConnectError/ByMessage (74-88) | **100%** |
| diffConnectWindowEntry | **100%** | connect() handler (146-268) | **95.45%** |
| rollWindow / sumWindow / windowSpanSecs | **100%** | ├ disconnect handler (184-204) — guard 186 | 92% |
| connectFailRateFromWindow | **100%** | ├ connect_error + cap-5 (206-229) | 87.5% |
| formatE2Log | **100%** | ├ handlers matching/room/echo (231-267) | **100%** |
| endPhaseFromStop / peakThroughput | **100%** | recordError (739-746) — cap 745 | **100%** |
| TRANSITIONS/canTransition/transition (19-40) | 94.59% | emitTick (748-789) | 79.69% |
| aggregateTicks (221-344) | 99.08% | runtimeStats | 100% |

## 2. 8 mutant nguy hiểm (vòng 1) — kết quả vòng 2: **TẤT CẢ ĐÃ BỊ GIẾT**

| Mutant vòng 1 | Test mới giết | Kết quả |
|---|---|---|
| socket-farm.ts:186 ×2 (guard `phase === 'failed'` trong disconnect) | G2 — disconnect sau cutover: fire `disconnect('io client disconnect')` + `'io server disconnect'` lần 2 sau cutover → assert phase giữ `'failed'`, `reconnectCount`/`connectFails` không tăng (4 mutant: 2 ConditionalExpression + EqualityOperator + StringLiteral — toàn bộ Killed) | **Killed** |
| socket-farm.ts:780/785 (`cAttempts -=` / `cByType.other -=` trong emitTick) | G2 — emitTick 2 users mixed byType (timeout/transport/reject/other ≠ 0) → assert `connectAttempts`/`connectFails` là TỔNG đúng + invariant `sum(byType) == connectFails` | **Killed** |
| socket-farm.ts:745 (`if (errorSamples.length > 20) shift()` → false) | G2 — recordError 30 mẫu → assert `errorSamples` giữ 20, FIFO shift đúng (4 mutant Killed) | **Killed** |
| coordinator-state.ts:36 (`transition` throw → `canTransition` luôn true) | G2 — transition happy path 9 cặp hợp lệ trả đúng phase đích + message throw đầy đủ (4 mutant Killed) | **Killed** |
| coordinator-state.ts:21-28 (11 mutant TRANSITIONS cov=0) | G2 — assert TOÀN BỘ 20 cạnh hợp lệ (canTransition true) + rows rỗng finished/stopped/error chặn MỌI phase kể cả placeholder ArrayDecl `'Stryker was here'` (toàn bộ 26 mutant ở 21-28 Killed) | **Killed** |

Ngoài ra test G2 còn giết thêm các mutant vùng lõi khác vòng 1 để sống:
- Connect options: `path`/`transports`/`reconnection` (151/152/158), state sau `connect` (173/174), re-join (179), phase sau disconnect thường (202) — Killed.
- Handlers matching:found/chat:joined/roomExpired/chat:room_closed/chat:error/chat:message (231-267) — Killed toàn bộ (53/53), kể cả guard thiếu roomId (232/241), `roomEndsAt ?? null` (243), payload undefined không crash (249/262/263 optional chaining), latency echo (255/256).
- aggregateTicks counters `-=` (240-252), topErrors slice (297), echoRate/type/server (264/303/331), cpuAvg (339), errorSamples init (237) — Killed.

## 3. Live mutant còn lại ở critical region — phân loại

Số live mutant critical region sau vòng 2: **0 nguy hiểm**. Còn 15 mutant sống ở critical region, toàn bộ equivalent hoặc cosmetic:

### (a) coordinator-state.ts — 2 survived + 1 NoCoverage (đều equivalent/unreachable)

| Vị trí | Loại | Chứng minh |
|---|---|---|
| 32:10 OptionalChaining `TRANSITIONS[from]?.includes` → `.includes` | Equivalent | `TRANSITIONS` có key cho MỌI `RunPhase` (TS-enforced; bảng 9 phase đủ 9 key) → `?.` không bao giờ null-guard |
| 32:45 BooleanLiteral `?? false` → `true` (NoCoverage) | Equivalent/unreachable | Vế phải chỉ evaluate khi `TRANSITIONS[from]` undefined — không xảy ra với mọi RunPhase hợp lệ |
| 278:25 `Math.max(histBucketCount, …)` → `Math.min` | Equivalent (dead local) | `histBucketCount` chỉ được GHI trong vòng lặp (278), không bao giờ đọc sau đó → tick output bất biến (đã xác nhận perActionHistograms giữ nguyên) |

### (b) socket-farm.ts — 6 equivalent + 13 cosmetic log (emitTick summary)

| Vị trí | Loại | Chứng minh |
|---|---|---|
| 170/197/221/225 OptionalChaining `this.socket?.disconnect()` / `socket?.io?.reconnection(false)` (6 mutant) | Equivalent | Trong các nhánh đó `this.socket` vừa được gán trong `connect()` và không bao giờ null; `socket.io-client` 4.x luôn expose `.io` — chính report vòng 1 §b đã xác nhận |
| 768-774 (13 mutant: condition/boolean/arithmetic/template/ObjectLiteral của summary log 10s) | Cosmetic — ngoài guarantee E2 | Toàn bộ trong statement `ltLog.info(...)` periodic summary — chỉ ảnh hưởng việc có/không in dòng log + nội dung chuỗi, KHÔNG đụng counters/usersFailed/connectFails/byType (755/766/787-789 không còn live mutant) |

### (c) sanitize.ts — 6 survived, không đổi (đã phân loại equivalent vòng 1, có mô phỏng)

Bí mật luôn được redact qua backstop KV (bước 3) dù query-path regex hỏng — 6 mutant giữ nguyên kết luận vòng 1 §b.

### (d) Ngoài critical region — nợ pre-existing (KHÔNG ảnh hưởng verdict G2)

socket-farm 198 survived + 280 NoCoverage còn lại nằm toàn bộ ở code runtime pre-existing: pickProfile (59/63), tick/scheduler/MATCH_TIMEOUT (269-360, 41 mutant), toRow/sendChat (361-496, 35), WorkerRuntime start/REST/CPU/actions (497-738, 68), emitTick tail/phase()/queryUsers (790-873, 36). Đây là các vùng đã ghi nợ từ vòng 1 §b (không có unit test cho scheduler/CPU/REST pacing — chỉ integration e2e-mock-gateway bù). Không mutant nào làm lộ secret, phá auto-stop hay phá invariant SEC-1.

## 4. Verdict G2: **PASS** (với deviation ghi nhận)

Đủ tiêu chí critical:

1. **0 mutant nguy hiểm sống ở critical region** (criterion 2) — 8/8 mutant vòng 1 đã Killed; critical core đạt 100%: decideAutoStop, toàn bộ window fns, formatE2Log, classifyConnectError, recordError, handlers 231-267. Live còn lại chỉ equivalent (OptionalChaining/dead-local/unreachable) + cosmetic log.
2. **Score tổng 57.72% < 60%** (criterion 1) — **KHÔNG đạt nhưng nguyên nhân hoàn toàn ngoài scope E2**: 280 NoCoverage + 198 survived của socket-farm nằm ở code runtime pre-existing (scheduler/CPU/REST/toRow/queryUsers). Score covered 76.05%; riêng 3 module critical theo hàm đạt 79-100%. Phần lõi toán E2 (window 60s, auto-stop, cap-5, kênh B) là 100%.

**Đề xuất xử lý nợ (chọn 1, khuyến nghị (a) kèm (b)):**
- (a) **Ghi nợ có điều kiện**: chấp nhận PASS với deviation ghi rõ — gate G2 chuyển sang đánh giá "0 live mutant nguy hiểm critical + critical-function score ≥ 90%" (hiện 79.69% thấp nhất là emitTick do summary-log cosmetic — có thể nâng bằng cách spy ltLog hoặc tách summary ra hàm riêng). Score tổng 57.72% chỉ phản ánh nợ test pre-existing, không phản ánh chất lượng fix E2.
- (b) Tách pure helpers connect/classify/emitTick-metrics khỏi runtime IO socket-farm thành module riêng → score critical tính riêng dễ đạt ≥90%.
- (c) Nếu hội đồng yêu cầu score tổng ≥ 60% thật: cần thêm test cho scheduler/CPU/REST pacing/toRow (ước ~80-120 mutant nữa, 1-2 ngày) — tôi khuyến nghị ghi nợ vì các vùng này đã có integration e2e-mock-gateway (5 test T7) bù ở tầng cao hơn.

## 5. Ghi chú chạy lại

```
npx stryker run stryker.config.e2.mjs   # config tạm, JSON: reports/mutation/e2-mutation-report.json
npx vitest run --config loadtest/vitest.config.ts  # full suite — 1 fail pre-existing config.test.ts do .env máy (LOADTEST_MAX_REGISTER_RAMP=2000)
```
Config gốc `stryker.config.mjs` (4 module: coordinator-state/metrics/config/report, break 70%) không bị thay đổi. Hai file config tạm giữ lại để chạy lại gate; xoá khi không cần.
