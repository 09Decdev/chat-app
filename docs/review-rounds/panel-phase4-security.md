# Panel Phase 4 (lens Security) — fix E2 loadtest connect-fail

**Vai trò**: Security Architect — đánh giá CUỐI CÙNG, default HOÀI NGHI.
**Phạm vi**: 7 commit T1–T7 (`main...HEAD`: 4e05426 T1 · c470b56 T2 · f8248a2 T3 · 9eaa9d8 T6 · f51dc40 T4 · 0895e23 T5 · 1a383cc T7), 29 file, +2966/−119.
**Verify thủ công**: chạy thật 7 test suite (sanitize 13 · secret-hygiene 2 · logger 11 · socket-farm 46 · auth-regression 12 · coordinator+state 66 · e2e-mock-gateway 4) = **154 test, toàn bộ xanh**, trong đó e2e T7 chạy 60s với mock gateway thật.
**Ghi chú**: `panel-phase4-correctness.md` và `panel-phase4-realtime.md` CHƯA tồn tại tại thời điểm verify — không đối chiếu chéo được; mục F-T7-2 (blind channel) tự đánh giá theo residual note của critique R2 (đã đọc code thật).

---

## A. Finding SỐNG (đã verify bằng code + test chạy thật)

### R-1 [LOW] — stopReason nhận raw `err.message` (pre-existing, KHÔNG trong diff) → report file/DB có thể nhận text chưa sanitize

- **Vị trí**: `loadtest/coordinator.ts:304` — `return this.finishRun('auto', err instanceof Error ? err.message : String(err));`
- **Vấn đề**: exception provisioning đưa raw `err.message` vào `stopReason` → `store.writeRunFinish` (`loadtest/db/store.ts:338` cột `stop_reason`) + report markdown `**Status** — ${stopReason}` (`loadtest/report.ts:230`) + report JSON + `/api/loadtest/report/export` (routes/run.ts:136-152). Không qua `sanitizeLogText` — ngoài 3 sink DESIGN §3 (recordError/lastError/redactMsg). `provisionAccounts` (auth-factory.ts) chạm gateway REST (register/login) nên text lỗi có thể gateway-controlled; newline/control char lọt vào report sẽ phá định dạng markdown/tạo dòng giả. Đây là sink duy nhất còn sót trong toàn bộ luồng "text lạ → report file" (các sink khác — recordError/lastError/redactMsg/relay worker → ltLog — đều đã qua sanitize, xem mục B).
- **Fix** (1 dòng): `this.finishRun('auto', sanitizeLogText(err instanceof Error ? err.message : String(err), 200))` tại :304 (import `sanitizeLogText` từ `./sanitize`). Hoặc sanitize chung ở biên `finishRun` để chặn mọi caller tương lai (defense-in-depth — khuyên dùng cách này).

### R-2 [LOW] — Blind channel "accept-then-drop": E2 mù + cap-5 không cắt → churn vô hạn, "khỏe giả" (pre-existing, ghi nợ v1.1)

- **Vị trí**: `loadtest/socket-farm.ts:164-184` (handler `connect`/`disconnect`) — disconnect churn không sinh `connect_error` nên không vào window.
- **Vấn đề**: gateway accept rồi drop ngay → `connect` (+1 attempt) + `disconnect` (+1 reconnectCount), KHÔNG `connect_error` → `connectFailsByType` toàn 0 → E2 rate luôn 0 (kể cả khi 0 user thực sự hoạt động), cap-5 không bao giờ kích hoạt (user không chuyển `failed`), backoff socket.io reset sau mỗi connect thành công → churn ~1 chu kỳ/s/user kéo dài hết run. Góc bảo mật: (a) **measurement integrity** — gateway lỗi được báo "0% connect fail" (khỏe giả, đúng class F-8/S-1 đã fix cho đường connect_error nhưng đường này mù); (b) **resource amplification tool-side** — churn vô hạn bởi gateway thù địch, giới hạn bởi backoff nhưng không bị cap-5 chặn. KHÔNG lộ secret, KHÔNG bypass auth — không phải regression của diff (R2 đã ghi residual này).
- **Fix** (v1.1, không chặn merge): đếm "accept-then-drop" vào window — ví dụ `connect` mà không có `chat:join`/echo trong X giây tính 1 fail churn; hoặc cap tần suất reconnect/user.

### R-3 [LOW] — F-6 debt: phần vận hành chưa xong (gate test đã có, move-out + rotate còn treo)

- **Vị trí**: `loadtest/data/accounts-*.json` + `auth-secret.json` vẫn nằm TRÊN ĐĨA trong cây repo (gitignored — đã verify `git check-ignore` + `git ls-files` sạch); `loadtest/__tests__/secret-hygiene.test.ts` (ST-11) đã chạy và PASS.
- **Vấn đề**: ST-11 chỉ chặn **tracked** file — không move-out, không rotate. Crown jewel (refreshToken 10k user production) vẫn phơi qua `git add -f`, zip/backup cây, sync máy Windows (vector F-6 đã chốt ở design council). DESIGN §11.3 ràng buộc "cùng release window" — điều kiện chưa thỏa tại thời điểm này.
- **Fix**: move-out khỏi cây repo + chạy gitleaks + rotate refreshToken TRONG cùng release window với fix E2 (đúng cam kết DESIGN §11.3) — không tách ra "pre-flight sau".

### R-4 [INFO] — Test fixtures chứa chuỗi giống secret (false-positive gitleaks tiềm năng)

- **Vị trí**: `loadtest/__tests__/auth-regression.test.ts:20` (`AUTH_SECRET = 't7-auth-secret-…'`), `:95` (`Bearer eyJ…forged-sig`), `loadtest/__tests__/sanitize.test.ts:8` (JWT giả), `e2e-mock-gateway-e2.test.ts:105` (`MALICIOUS`).
- **Vấn đề**: toàn bộ là fixture giả trong `__tests__/` (đã đối chiếu — không credential thật), nhưng pattern `secret=`/`Bearer eyJ` khớp heuristics gitleaks → CI `npm run secret:scan` có thể fail vặt.
- **Fix**: allowlist path `__tests__/` trong cấu hình gitleaks, hoặc đổi fixture thành chuỗi không khớp pattern.

---

## B. Đã xác minh ĐÚNG (không bác được — đối chiếu code thật + test chạy thật)

1. **S-1 (R2) CLOSED — dashboard connect-fail không còn dead data**: T5 override `agg.tick.rates.connectFailRate` TRƯỚC `pushTick` (coordinator.ts:522-524); `emitTick` sum `connectFailsByType` per-user (socket-farm.ts:763-768, invariant sum(byType)==connectFails — test P2); `hasConnectData` true/false phân biệt live vs replay; `connectFailVariant` trả `default` khi replay/chưa attempt (connect-fail.ts:36-42) — hết "0% xanh giả". Auth-regression test assert field connect mới hiện diện trên tick live qua HTTP.
2. **S-2 CLOSED — 'failed' là TERMINAL**: handler `connect` guard `phase === 'failed'` → disconnect + return, không resurrect, không reset cap (socket-farm.ts:164-171); handler `disconnect` giữ phase failed (:178-184); test (S-2) socket-farm.test.ts:295 PASS. Tiền đề "tối đa 5 fail/user" của F-1 đứng vững.
3. **S-3 CLOSED — lastError sanitize MỌI điểm gán, cap 160**: 6/6 điểm: `connect_error` (:193), `chat:error` (:248 — T4 đã thêm, đúng yêu cầu verify), `leaveRoom` (:273), `MATCH_TIMEOUT` (:282), `enqueue` (:430), `recordResult` (:720), kể cả append "failed sau 5…" (:208). Test (S-3) :377 + e2e ST-12 assert GET /users sink sạch.
4. **S-4 CLOSED — errorCounters bounded 20 + bucket OTHER**: `MAX_ERROR_CODES = 20` (socket-farm.ts:40), `recordError` (socket-farm.ts:719-734) — key mới khi map đủ 20 → `'OTHER'` (thậm chí chặt hơn đề xuất 50 của R2); map ≤ 21 key → tick.errors/report file bounded. Test (S-4) :411 PASS. Bucket `'OTHER'` là label tĩnh — không leak code thật (code đã sanitize + cap 64 trước khi vào map).
5. **F-1 cap 5 MỌI user (kể cả everConnected)** — socket-farm.ts:202-208, test T3-2/T3-3 PASS; số học 20.8% < 30% xác nhận bằng e2e (b) 5% token lỗi → KHÔNG trigger.
6. **Sanitizer phủ sạch 3 sink DESIGN §3 + chống bypass F-5**: `sanitizeLogText` (sanitize.ts, PURE, không import — không cycle) — strip control chars + newline, URL credential không anchor ^, query secret key giữ key redact value, KV không cần word-boundary, JWT không prefix eyJ, token 2-part, hex ≥ 32, cap length. Test phủ từng bypass (sanitize.test.ts:36-74) + fuzz null/undefined/thiếu field (classifyConnectError ST-5) + ST-12 e2e với message độc thật (JWT + newline + control chars) → errorSamples/lastError/log sạch, không dòng giả.
7. **Field `code` cap 64 mọi nơi**: chỉ recordError đưa code vào sink (errorCounters/tick.errors/TOP ERRORS/report); `chat:error` code vào qua recordError; stopReason E1/E2 là số format nội bộ (formatRatePct). Report file (report.ts:66-73, 268-270) chỉ nhận code đã sanitize.
8. **Auth KHÔNG bị đụng**: `git diff main...HEAD --name-only` — 0 thay đổi ở auth.ts/guards.ts/api-server.ts/http-server.ts (chỉ file test mới auth-regression.test.ts). Mọi route dashboard `auth: true` (api-server.ts:86-92); T6 dùng route có sẵn, KHÔNG mở endpoint mới. ST-9: 12 test PASS (401 không token / 401 token giả / 200 token hợp lệ).
9. **Secret scan diff**: 1779→2966 dòng diff — chỉ fixture giả trong `__tests__/` (mục R-4); `git ls-files` sạch (users_accounts/accounts-*/auth-secret/.env thật); ST-11 chạy thật PASS.
10. **Window T2/T5 an toàn + bounded**: rollWindow evict wall-clock + cap 120 bucket; diff clamp max(0,·) chống rate âm; skip-first-tick sau restart (handleWorkerDied xóa prev — coordinator.ts:120); resetRunState clear window/prev (ST-4). E2 log 8 trường đúng format ST-7 (test coordinator PASS, log thực tế: `E2: auto-stop: connect fail 100% > 30% (E2) | phase=ramping elapsedSec=2 windowSec=1 windowAttempts=10000 …`).
11. **UI không có vector XSS mới**: `grep dangerouslySetInnerHTML/innerHTML` toàn src → 0 hit; connect-fail.ts/user-phases.ts/stat-card.tsx chỉ số + label tĩnh; TOP ERRORS render code/count đã sanitize qua React escape.

---

## C. Verdict CUỐI

**SEC: PASS (kèm 3 điều kiện) — không chặn merge fix E2.**

Lý do PASS: toàn bộ finding S-1..S-4 (R2) và F-1..F-8 (design council) đã đóng và được verify bằng test chạy thật (154 test xanh, trong đó e2e T7 60s + ST-12 message độc + ST-9 auth + ST-11 secret gate); sanitizer phủ đúng 3 sink DESIGN §3 + mọi điểm gán lastError + cap code 64 + cap errorCounters 20; auth không đụng; diff sạch secret thật. Không còn finding nào ở mức chặn merge.

**Điều kiện (đều ≤ LOW — ghi nợ có lịch, không phải blocker):**

1. **R-1** (LOW): sanitize `stopReason` tại coordinator.ts:304 (1 dòng) — hoặc sanitize ở biên `finishRun`. Nên làm trong release này vì là sink report file còn sót duy nhất.
2. **R-3** (LOW): hoàn tất phần vận hành F-6 — move-out `loadtest/data/accounts-*.json` + `auth-secret.json` khỏi cây repo + gitleaks + rotate — **TRONG CÙNG release window** (cam kết DESIGN §11.3, gate test ST-11 đã sẵn sàng).
3. **R-2** (LOW): ghi nợ v1.1 — đếm accept-then-drop vào window (blind channel E2) + cap churn reconnect; không chặn release này (pre-existing semantics).

**Verdict dự phòng**: nếu hội đồng muốn chặt tối đa, R-1 (1 dòng) có thể được yêu cầu sửa trước merge — chi phí gần 0, đóng nốt sink cuối cùng trên đường report file.
