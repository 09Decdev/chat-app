# CANARY — Kế hoạch staged rollout + rollback cho prod-refactor (loadtest tool + chat-app)

**Status**: 📋 KẾ HOẠCH — SRE (2026-08-05)
**Scope**: Tool load-test tự host (local/self-hosted) — KHÔNG phải internet SaaS → canary **tỉ lệ thuận**: rollout theo stage trên chính môi trường local của user, mỗi stage có cổng verify + đường rollback cụ thể. KHÔNG multi-cluster, KHÔNG traffic-shift %.
**Nguồn**: `docs/PLAN-prod-refactor.md` (§7 Rollback plan), `docs/DESIGN-prod-refactor.md` (§10 Decisions log), `docs/THREAT-MODEL.md`, `README.md`, `loadtest/db/migrate.ts`, `loadtest/db/migrations/001_init.sql`, `~/.claude/ASSURANCE.md` (RELEASE-SAFETY: canary staged + rollback plan viết sẵn + drill ≥ 1 lần + observability sẵn + không auto-promote).

## Bản đồ commit (baseline — refactor)

| Commit | Nội dung | Vai trò trong canary |
|---|---|---|
| `8c41ad8` | first commit (**pre-refactor**) | ⬅️ **Rollback target** = "hành vi cũ" |
| `370f2f3` | W0: secret cleanup + gitleaks + gitignore | nằm trong canary (bảo mật) |
| `4f5e645` | W1: config fail-fast + migration runner + DB store | Stage 0–1 |
| `7dbcaa1` | W2: API hardening + observability | Stage 1–3 |
| `cc4d0bb` | W3: frontend hardening + tests | Stage 4 |
| `8468d5b` | W4: CI + contract/E2E/mutation + docs + Docker | đã verify (G-1..G-10) |
| `82ff251` | Phase 4 fixes: race, stuck run, **log loop guard (F-1)**, CORS `*` reject | Stage 2–3 (F-1 = reentrancy guard + 5s suppress window khi DB outage) |
| `44354c4` | chore: bỏ debug artifact | head hiện tại |

---

## 1. Tiền đề deploy (pre-flight checklist) — BẮT BUỘC trước Stage 0

3 hành động **pending của user** phải xong trước khi chạy bất kỳ stage nào:

- **(a) Áp DB password mới lên Postgres**: rotate (T-01) đã đổi `LOADTEST_DATABASE_URL` trong `loadtest/.env` — password mới phải được áp lên instance `postgres-loadtest` (localhost:5439, user `appuser`, db `loadtest`) TRƯỚC. Kiểm tra: `psql -h localhost -p 5439 -U appuser -d loadtest -c 'select 1'`. Sai credential → server fail-fast (đúng thiết kế T-05) nhưng vẫn phải tránh.
- **(b) Sync OTP_SECRET sang gateway-auth-service**: `LOADTEST_OTP_SECRET` (≥ 32 ký tự) PHẢI khớp `OTP_SECRET` trong `gateway-auth-service/.env` — lệch → register account test fail (E1, TH-4/R-2). Kiểm tra: so sánh 2 giá trị, sau đó verify bằng 1 run smoke (Stage 2).
- **(c) Cài gitleaks + `npm run secret:scan` = 0 finding** (T-02): `winget install gitleaks`, chạy scan toàn repo, cài pre-commit hook `sh scripts/install-hooks.sh`. Gate G-5.

### ⚠️ Ordering dependency xuyên repo — gateway TRƯỚC chat client (Stage 4)

Client mới (T-08) gửi token socket qua **`handshake.auth` + `Authorization: Bearer` header, KHÔNG còn `query.token`** (src/lib/socket.ts:92-93, loadtest/socket-farm.ts:100-101 — grep `query.token` = 0). Gateway đọc **`handshake.auth?.token || query?.token || headers?.authorization`** (`gateway-auth-service/.../websocket.gateway.ts:147-150` — đã commit ở repo gateway, main).

**Thứ tự deploy**: gateway-auth-service commit `handshake.auth` PHẢI chạy TRƯỚC (hoặc cùng) chat-app mới.

- Gateway mới + client mới → websocket transport bình thường.
- Gateway cũ + client mới → browser native WebSocket **không gửi được custom header** (`extraHeaders` chỉ hoạt động polling/Node) → **websocket transport chết âm thầm, chỉ còn polling fallback**. Không phải crash, nhưng realtime mất — Stage 4 phải check transport thật (mục 6).

---

## 2. Staged rollout (canary steps)

### Stage 0 — DB migration trên DB thật
```bash
npm run loadtest:db:up          # scope 'all' — apply mọi pending
npm run loadtest:db:status      # kỳ vọng: schema_version=1, pending: (none)
```
- Trên DB đã có schema cũ (do `ensureSchema` tạo), 001 là `CREATE TABLE IF NOT EXISTS` + DDL **y hệt** `schema.sql` → thực chất là no-op ghi `schema_version=1`. Dữ liệu cũ **không bị đụng** (R-4/G-8).
- **Nếu hỏng**: migration chạy trong transaction + advisory lock — lỗi → ROLLBACK + exit ≠ 0, DB giữ nguyên. Xem log, sửa, chạy lại. `db:down` KHÔNG cần thiết ở stage này (chưa có gì mới để lùi).
- **DOWN path (khi nào cần)**: chỉ khi `db:up` được chạy trên **DB mới/trống** (vd volume Docker mới) và muốn xoá sạch → `npm run loadtest:db:down` (destructive: drop 7 bảng — 001_init.sql DOWN block). **Trên DB thật có data: KHÔNG chạy down** — rollback = stop + revert code (DB tương thích ngược, xem §3).
- Backup trước: `pg_dump -h localhost -p 5439 -U appuser -d loadtest -Fc -f loadtest-$(date +%F).dump` (README).

### Stage 1 — Server mới, DB bắt buộc
```bash
npm run loadtest:server
```
- `LOADTEST_DB_REQUIRED=true` (mặc định) + env thiếu/sai → fail-fast exit ≠ 0 (T-03/T-05) — đây là hành vi MỚI cần xác nhận đúng.
- Verify: `GET /api/loadtest/health` → `{ status:'ok', db:'up', redis:'up', workers:N, version, uptimeSec, timestamp }`; `GET /metrics` → counter `lt_dbWriteFail`/`lt_dbRetry`/`lt_apiErrors`/`lt_workerRestarts`/`lt_runFinished` + gauge `lt_coordinator_rssMb`/`lt_worker_alive` tồn tại; set `LOGTEST_LOG_FILE=loadtest/data/logs/loadtest.jsonl` → file JSONL xuất hiện, entry `{ts,level,msg,runId?,requestId?}` không chứa secret (TH-11).
- **Rollback Stage 1**: stop server → `git checkout 8c41ad8` → chạy server cũ (đọc §3).

### Stage 2 — Smoke run (≤ 100 users, 1–2 phút) chống gateway THẬT
- Từ dashboard hoặc `POST /api/loadtest/start`: target ≤ 100, duration ≤ 2 min, gateway thật (trong `LOADTEST_ALLOWLIST`).
- Verify trong lúc chạy: `/health` liên tục `ok`; `/metrics` `lt_worker_alive` > 0, `lt_dbWriteFail` = 0; JSONL không có ERROR.
- Verify sau: report MD/JSON sinh trong `docs/loadtest-reports/`; DB có row: `runs` (status != 'running'), `metric_samples` > 0, `log_events` > 0 (`psql ... -c "select run_id,status from runs order by created_at desc limit 3"`).
- Verify graceful shutdown: `kill -TERM <pid>` (SIGTERM) → log "Shutdown hoàn tất" + **exit 0**; `runs.status` không kẹt `running` (finalize barrier B-2/TH-12); quá `LOADTEST_SHUTDOWN_TIMEOUT_MS` (10s) → force exit 1 là lỗi cần điều tra.
- **Rollback Stage 2**: kill run (`POST /api/loadtest/kill` hoặc SIGTERM) → stop server → revert commit (nếu run chứng minh bug) hoặc chỉ sửa config nếu nguyên nhân env.

### Stage 3 — Full-size run (lên tới 5k users)
- Tăng dần: 1k → 2.5k → 5k (không nhảy thẳng 5k).
- Monitor trong run: `lt_coordinator_rssMb` (tăng ổn định, không rò rỉ); `lt_worker_alive` = workers thật đang sống; `lt_dbWriteFail` **= 0**; `lt_workerRestarts` không tăng đột biến; error rate từ report/tick; JSONL chỉ ERROR tạm thời.
- **Optional drill — log loop guard (F-1)**: giữa run, tạm dừng Postgres 1–2 phút → kỳ vọng: `lt_dbWriteFail` tăng, log **KHÔNG** flood vô hạn (5s suppress window — F-1, commit `82ff251`), run **không chết**, health = `degraded`. Restart Postgres → flush hồi phục (retry ≥ 1, US-DB-2). Khuyến nghị chạy ở lần 5k đầu tiên (drill §7 làm bài bản hơn).
- **Rollback Stage 3**: kill run → kiểm tra root cause. Bug code → revert; bug môi trường (DB/Redis/gateway) → xử lý infra, không cần revert.

### Stage 4 — Frontend (chat-app mới)
```bash
npm run build        # tsc --noEmit && vite build
npm run preview      # hoặc serve dist qua nginx (docker/Dockerfile.frontend)
```
- **Tiền đề**: gateway `handshake.auth` đã chạy (§1 ordering).
- Verify trong `dist/index.html`: CSP meta có `script-src 'self'` + `connect-src` = origins explicit (KHÔNG `ws:`/`wss:` wildcard — TH-13); không chuỗi `[DEBUG-LOGIN]` (grep = 0, G-10).
- Verify runtime (DevTools → Network): socket handshake response **HTTP 101 Switching Protocols** = websocket transport, **KHÔNG** `?token=` trong URL, **KHÔNG** polling `engine.io?transport=polling` liên tục. Nếu thấy polling → gateway cũ hoặc `auth` chưa tới (điều tra trước khi coi là deployed).
- Verify refresh: để session chạy, tạo 401 → interceptor gọi `POST /auth/refresh-token` → retry thành công, không logout (US-FE-1).
- Verify ErrorBoundary: forced error (vd tắt server loadtest rồi mở dashboard) → fallback UI, không trắng trang.
- **Rollback Stage 4**: frontend là static build — rollback = `git checkout 8c41ad8` (hoặc `cc4d0bb`~) → build lại → serve; **không** đụng DB/server loadtest.

---

## 3. Rollback plan (per stage)

| Stage | Kích hoạt rollback | Lệnh cụ thể | Lưu ý |
|---|---|---|---|
| 0 (DB) | Migration lỗi / schema sai | Không có gì để lùi (transaction ROLLBACK tự xử lý). DB mới/trống + muốn xoá: `npm run loadtest:db:down` | **DOWN destructive** — chỉ trên DB không có data cần giữ |
| 1 (server) | health sai / metrics không có / fail-fast sai | Stop server → `git checkout 8c41ad8 -- loadtest/` → `npm install` (nếu cần) → `npm run loadtest:server` | DB giữ nguyên — 001 baseline tương thích ngược (DDL = schema.sql) |
| 2 (smoke) | Report sai / DB row thiếu / shutdown kẹt | Kill run → stop → revert như Stage 1 | Không cần `db:down` |
| 3 (full) | dbWriteFail>0 kéo dài / worker chết / rssMb rò rỉ | Kill run → root-cause → revert code hoặc xử lý infra | F-1 phải chặn flood log — nếu không, đây là bug mới |
| 4 (frontend) | Socket chỉ polling / refresh vỡ / CSP chặn app | `git checkout 8c41ad8` (hoặc `cc4d0bb`~) → `npm run build` → serve lại | Không ảnh hưởng server loadtest/DB |

**Emergency config overrides (không revert code, dùng khi cần khôi phục dịch vụ NGAY)**:
- `LOADTEST_DB_REQUIRED=false` — override khẩn cấp (R-4/PLAN §7): server chạy được khi DB chết, **run sẽ không ghi history** (cảnh báo to lúc start). Khôi phục DB xong → set lại `true`.
- `LOADTEST_CORS_ORIGIN=http://localhost:5173` (hoặc origin thật) — nếu dashboard CORS lỗi (SEC-2: **không** đặt `*` — validateEnv reject từ `82ff251`).
- `LOADTEST_ALLOW_REGISTER=true` — dev cần register admin (R-5); nhớ set `false` khi xong.
- `LOADTEST_RATE_LIMIT_DISABLED=1` — escape hatch test/CI (B-6), KHÔNG dùng trong vận hành bình thường.
- `VITE_REFRESH_ENDPOINT` — nếu gateway thật chưa có `/auth/refresh-token` (chỉ khi deploy frontend trước gateway — không khuyến khích).

**"Không cần rollback" — thay đổi additive** (PLAN §7):
- `/health` thêm field (client cũ chỉ đọc `status` — vẫn OK); logger JSONL sink song song text sink; envelope thêm `timestamp`/`requestId`; `/metrics` tool mới; `/config.allowRegister`. Các thay đổi này KHÔNG phá contract cũ — rollback là chọn không dùng, không cần revert.
- Bỏ `query.token` socket: gateway vẫn chấp nhận query (fallback) → KHÔNG phá contract (TH-7, PLAN §7).
- CSP/ErrorBoundary: additive — chỉ rollback nếu CSP chặn dev/HMR (xoá meta CSP trong dev).

---

## 4. Observability during rollout

| Chỉ số | Nguồn | Ngưỡng alert (self-hosted) | Hành động |
|---|---|---|---|
| `/api/loadtest/health` status | curl /health (probe cache 10s) | khác `ok` > 2 phút trong run | Tra JSONL, check DB/Redis (`degraded` là trạng thái hợp lệ khi có outage — không false alarm) |
| `lt_dbWriteFail` | `GET /metrics` | > 0 kéo dài > 5 phút | Điều tra (DB down/credential/disk); run vẫn sống (best-effort) nhưng history thiếu |
| `lt_worker_alive` | `GET /metrics` | = 0 trong lúc run > 30s | **Kill-switch** `POST /api/loadtest/kill` → check E3 auto-stop |
| `lt_workerRestarts` / `lt_apiErrors` | `GET /metrics` | tăng đột biến > 2× baseline | Điều tra log theo requestId |
| `lt_coordinator_rssMb` | `GET /metrics` | tăng liên tục, không plateau | Rò rỉ memory → stop run, điều tra |
| JSONL log (`LOGTEST_LOG_FILE`) | tail file | ERROR mới trong run (trừ khi đang drill outage) | Trace theo runId/requestId |
| Report correctness | `docs/loadtest-reports/` sau run | thiếu summary/perAction/errors/bottleneck; `runs.status` kẹt `running` > 5 phút sau end | Bug finalize (B-2) → revert |

> Self-hosted → "alert" = user đang đứng trước terminal; ngưỡng chỉ mang tính "khi nào cần dừng lại điều tra", không cần tooling alert riêng. Nếu chạy Docker: healthcheck chấp nhận `degraded` (HTTP 200 — D-25), `GET /metrics` public như health.

---

## 5. Kill-switch & emergency

1. **Dừng run**: `POST /api/loadtest/kill` (auth Bearer) — kill cứng; `POST /api/loadtest/stop` — dừng mềm (graceful). Nếu API không trả lời → SIGTERM process → graceful shutdown (finalize barrier) → SIGKILL chỉ khi 10s timeout.
2. **DB chết**: `LOADTEST_DB_REQUIRED=false` trong `loadtest/.env` → restart server → dịch vụ sống, history tạm không ghi. Khôi phục DB → set lại `true` → restart.
3. **CORS vỡ dashboard**: set `LOADTEST_CORS_ORIGIN` đúng origin (Vite proxy `changeOrigin:true` gửi origin `http://localhost:5173` — R-2/R-7). Không revert code.
4. **Register chặn dev**: `LOADTEST_ALLOW_REGISTER=true` (dev only).
5. **Gateway cũ chưa deploy xong**: KHÔNG deploy frontend mới (ordering §1) — hoặc tạm dùng polling (hoạt động nhưng realtime chết âm thầm — chỉ là tình huống chuyển tiếp, không phải trạng thái deploy hoàn tất).

---

## 6. Definition of "deployed" (per stage)

| Stage | User thấy gì để coi là XONG |
|---|---|
| 0 | `db:status` → `schema_version=1`, `pending: (none)`; chạy lại lần 2 không lỗi (idempotent) |
| 1 | Server start không fail-fast oan; `/health` = `ok` đầy đủ field (db/redis/workers/version); `/metrics` liệt kê đủ counters/gauges; file JSONL mọc ra + entry JSON có runId/requestId |
| 2 | 1 run smoke hoàn tất: report đầy đủ + DB có `runs`/`metric_samples`/`log_events` + SIGTERM exit 0 + `runs.status` không `running` |
| 3 | Full run 5k users xong: `dbWriteFail=0`, `worker.alive` > 0 suốt run, rssMb ổn định, report đúng số liệu, không run kẹt |
| 4 | `dist/index.html` có CSP meta (connect-src explicit origins); Network tab thấy **HTTP 101 websocket** (không polling); refresh token không logout; ErrorBoundary hoạt động; grep `[DEBUG-LOGIN]` = 0 |

Cổng chuyển stage: Stage N xong → Stage N+1; stage fail → rollback stage đó (§3) → fix → chạy lại. **Không auto-promote** (ASSURANCE RELEASE-SAFETY).

---

## 7. Rollback drill — 1 drill bắt buộc (DB outage giữa run)

> ASSURANCE: "rollback drill đã chạy ≥ 1 lần (không chỉ nói có thể rollback)". Đây là drill duy nhất khuyến nghị — nó verify luôn 3 tính năng mới nguy hiểm nhất: **health degraded (TH-14), log loop guard (F-1), best-effort write + retry (T-05)**.

```bash
# (a) Run smoke trên DB thật (Stage 2 cấu hình)
npm run loadtest:server &          # chờ health = ok
curl -s localhost:3401/api/loadtest/health   # {status:'ok', db:'up', ...}

# (b) Simulate DB outage — stop Postgres
pg_ctl -D <PGDATA> stop            # hoặc docker stop postgres-loadtest / net stop postgresql-x64-16

# (c) VERIFY trong 30–60s:
curl -s localhost:3401/api/loadtest/health
#   → status:'degraded', db:'down'  (KHÔNG 500, KHÔNG 'ok' giả — TH-14)
curl -s localhost:3401/metrics | grep lt_dbWriteFail
#   → counter tăng (best-effort write ghi nhận fail — T-05)
tail -50 loadtest/data/logs/loadtest.jsonl
#   → có ERROR/warn kèm runId nhưng KHÔNG flood vô hạn (F-1: reentrancy guard + 5s suppress)
#   → worker vẫn tick: lt_worker_alive > 0 — run KHÔNG chết

# (d) Restart Postgres (khôi phục)
pg_ctl -D <PGDATA> start           # hoặc docker start postgres-loadtest

# (e) VERIFY recovery trong 30–60s:
curl -s localhost:3401/api/loadtest/health      # → status trở lại 'ok'
curl -s localhost:3401/metrics | grep -E 'lt_dbWriteFail|lt_dbRetry'
#   → dbRetry > 0 (retry ≥ 1 khi DB hồi phục — US-DB-2); dbWriteFail DỪNG tăng
curl -s localhost:3401/api/loadtest/status | jq .phase
#   → run còn sống, tiếp tục; hoặc nếu run đã tự dừng → status rõ ràng, không kẹt 'running'
# Kết thúc: POST /api/loadtest/stop → report hoàn chỉnh (duration không bị mất)
```

**Kết quả đạt (PASS)**: health degraded đúng + log không flood + run không chết + hồi phục có retry + finalize không kẹt. **FAIL bất kỳ dòng nào** → bug mới cần fix trước khi Stage 3 (đặc biệt nếu log flood vô hạn → F-1 hỏng).

**Drill thứ 2 (tuỳ chọn, 2 phút) — shutdown giữa run**: chạy smoke run → SIGTERM → kỳ vọng exit 0 trong ≤ 10s + `runs.status` không `running` (B-2 finalize barrier). Đây là drill cho Stage 2 gate, làm 1 lần là đủ.
