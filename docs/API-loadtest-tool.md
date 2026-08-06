# API — MAYogu LoadTest Tool (server)

> Backend contract cho dashboard React (`/loadtest`). Server: `chat-app` Node process,
> chạy `npm run loadtest:server`, HTTP `http://localhost:{LOADTEST_PORT}` (mặc định 3401).
> Response envelope thống nhất: `{ success, statusCode, data }` / lỗi: `{ success: false, statusCode, message, ... }`.
> Dashboard polling 1s (`/api/loadtest/metrics`) — MVP KHÔNG dùng WebSocket push.

## Danh sách route

| Method | Path | Mục đích | Màn UI-SPEC |
|---|---|---|---|
| GET | `/api/loadtest/health` | Health check | — |
| GET | `/api/loadtest/config` | Config template: allowlist, presets, giới hạn, hasOtpSecret | Màn 1 |
| POST | `/api/loadtest/start` | Bắt đầu run (validate + chặn cứng allowlist/1M-10M) | Màn 1 |
| POST | `/api/loadtest/stop` | Dừng (graceful ≤ 10s) | Màn 1 |
| POST | `/api/loadtest/kill` | Kill-switch (mọi worker ≤ 5s) — `{ force: true }` cũng được | Màn 1 |
| POST | `/api/loadtest/pause` / `resume` | Tạm dừng / tiếp tục sinh action | Màn 1 |
| GET | `/api/loadtest/status` | Run snapshot: phase, elapsed, config, lastTick, stopReason | Màn 1/2 |
| GET | `/api/loadtest/metrics?since=&limit=` | Tick 1s (ring 3600) — dashboard live | Màn 2 |
| GET | `/api/loadtest/errors` | Top errors + error samples | Màn 2 |
| GET | `/api/loadtest/logs?limit=` | Log gần đây (ring 500) | Màn 1/2 |
| GET | `/api/loadtest/users?offset=&limit=&filter=` | Virtual user rows (worker farm query) | v1.1 Màn 3 |
| GET | `/api/loadtest/report` | Report cuối run (404 nếu chưa có) | Màn 5 |
| GET | `/api/loadtest/report/export?format=json|md|csv` | Export file | Màn 5 |
| GET | `/api/loadtest/allowlist` | Allowlist hiện tại (env + settings) | Màn 6 |
| POST | `/api/loadtest/allowlist` | Ghi allowlist settings file `{ urls: string[] }` | Màn 6 |
| GET | `/api/loadtest/pools` | Token pool disk (run cũ) | Màn 5/6 |
| POST | `/api/loadtest/cleanup` | Cleanup 3 tầng `{ runId, dryRun }` (mặc định dry-run) | Màn 7 |

## POST /start — request / response

```jsonc
// Request
{
  "targetUsers": 10000,            // 1000..LOADTEST_MAX_TARGET (mặc định 200000) — 1M/10M chặn cứng
  "rampRate": 200,                 // user/s connect (mặc định 200)
  "rampMode": "rate",              // "rate" | "minutes"
  "durationMin": 30,               // ≤ LOADTEST_MAX_DURATION_MIN (60) — access token 1h
  "profile": { "chat": 40, "read": 30, "comment": 20, "like": 10, "view": 0 },  // tổng = 100
  "gatewayUrl": "ws://test-01.mayogu.test",  // PHẢI trong allowlist — ngoài → 400
  "freshAccounts": false           // true = bỏ token pool, register mới
}
// 200
{
  "success": true, "statusCode": 200,
  "data": {
    "runId": "ltm3x5k01",
    "config": { "runId": "...", "targetUsers": 10000, "workerCount": 4, "socketsPerWorker": 2500, "rampRate": 200, "durationSec": 1800, "profile": {...}, "gatewayUrl": "http://test-01.mayogu.test", "registerRamp": 100, "seed": 123, "createdAt": 1754200000000 },
    "warnings": ["Matching engine trần ~100 user/s: ..."],
    "estimate": { "workers": 4, "ramGB": 1, "seatMin": 2 }
  }
}
// 400 — config không hợp lệ / ngoài allowlist: { "success": false, "statusCode": 400, "message": "Cấu hình run không hợp lệ (SD-1 chặn cứng)", "errors": [...], "warnings": [...] }
// 409 — đang có run chạy
```

## GET /status

```jsonc
{
  "success": true, "statusCode": 200,
  "data": {
    "runId": "ltm3x5k01",
    "phase": "ramping",            // idle|provisioning|ramping|steady|cooldown|report|finished|stopped|error
    "startAt": 1754200000000,
    "elapsedSec": 42,
    "isRunning": true,
    "stopReason": "",
    "config": { ... },
    "lastTick": { ... LoadTestTick ... }
  }
}
```

## GET /metrics — LiveTick (1 tick/s, ring 3600)

```jsonc
{
  "success": true, "statusCode": 200,
  "data": {
    "runId": "ltm3x5k01",
    "ticks": [{
      "type": "tick",
      "ts": 1754200042000,          // trục X
      "phase": "steady",
      "elapsedSec": 42,
      "counters": {
        "usersCreated": 10000, "usersConnected": 10000, "usersActive": 9800,
        "usersQueued": 120, "usersInRoom": 8400,
        "actionsTotal": 420000, "successTotal": 414000, "failTotal": 6000,
        "echoOk": 3300, "echoSent": 3600,          // chat success = echo khớp clientMsgId
        "queueCount": 120, "roomCount": 1400,      // queue từ Redis, rooms ≈ in_room/6
        "droppedOutbox": 0, "reconnectCount": 3, "rateLimitedNoEcho": 300
      },
      "rates": { "successRate": 98.6, "echoRate": 91.7 },
      "actionsPerSec": { "chat": 401, "read": 299, "comment": 198, "like": 99, "view": 0, "typing": 52, "topic": 4 },
      "latency": { "p50": 45, "p95": 210, "p99": 840 },   // ms — histogram log-scale gộp
      "errors": [{ "code": "NO_ECHO_TIMEOUT", "count": 300 }, { "code": "HTTP_429", "count": 12 }],
      "server": { "wsConnections": 10000, "wsMessagesEmitted": 1200000, "wsMessagesPerSec": 5800 },  // gateway /metrics scrape 5s
      "workers": { "alive": 4, "total": 4, "cpuAvg": 42 }
    }]
  }
}
```

## GET /report — RunReport (sau khi run kết thúc ≤ 30s)

```jsonc
{
  "runId": "ltm3x5k01", "status": "finished",        // finished|stopped|error
  "startAt": 1754200000000, "endAt": 1754201200000, "durationSec": 1198,
  "config": { ... full snapshot ... },
  "summary": {
    "usersCreated": 10000, "usersConnectedMax": 10000, "usersActiveMax": 9800,
    "actionsTotal": 4200000, "successTotal": 4140000, "failTotal": 60000,
    "successRate": 98.6, "echoOk": 33000, "echoSent": 36000, "echoRate": 91.7,
    "throughputAvg": 3504, "throughputPeak": 4120, "queueCountPeak": 500
  },
  "perAction": [
    { "action": "chat", "count": 36000, "success": 33000, "fail": 3000, "successRate": 91.7, "avgMs": 48, "p50Ms": 45, "p95Ms": 210, "p99Ms": 840 }
  ],
  "errors": [{ "code": "NO_ECHO_TIMEOUT", "count": 3000 }],
  "bottlenecks": [
    { "level": "High", "title": "Chat echo rate 91.7% (< 95% dự kiến)", "detail": "...", "evidence": [{ "ts": 1754200042000, "value": 91.7, "threshold": 95 }] }
  ],
  "stopReason": "duration hết"
}
```

## POST /cleanup

```jsonc
// Request { "runId": "ltm3x5k01", "dryRun": true }   // mặc định dryRun = true
// 200
{
  "success": true, "statusCode": 200,
  "data": {
    "runId": "ltm3x5k01", "dryRun": true, "cleaned": false,
    "steps": [
      { "name": "Tầng 1 — API nghiệp vụ: delete user/post/comment test", "status": "skipped", "detail": "Không có admin bulk-delete...", "count": 0 },
      { "name": "Tầng 2 — Redis keys (dry-run: chỉ đếm)", "status": "ok", "detail": "Sẽ xóa 1234 keys...", "count": 1234 },
      { "name": "Tầng 3 — Kiểm tra baseline", "status": "ok", "detail": "Sạch...", "count": 0 }
    ],
    "baseline": { "otpKeys": 0, "userKeys": 0 }
  }
}
```

## Pha run (CP-3)

```
idle → provisioning → ramping → steady → cooldown → report → finished
                        ↘  (dừng tay) cooldown → stopped
                        ↘  (auto-stop E1/E2/E3) → error
```

- `isRunning` = phase ∈ { provisioning, ramping, steady }.
- Auto-stop: E1 register fail > 50%, E2 connect fail > 30%, E3 > 50% worker chết trong 60s.
- Dashboard dùng `phase` badge + `lastTick`/`metrics.ticks`; khi `phase ∈ {finished, stopped, error}` → FROZEN (chờ tick cuối, không poll mới) + mở tab Report.

## Lỗi chuẩn

| statusCode | Ý nghĩa |
|---|---|
| 400 | Config không hợp lệ (kèm `errors[]`); cleanup thiếu runId |
| 404 | Chưa có report / route không tồn tại |
| 409 | Đang có run chạy — không start được |
| 500 | Lỗi server (kèm message) |
