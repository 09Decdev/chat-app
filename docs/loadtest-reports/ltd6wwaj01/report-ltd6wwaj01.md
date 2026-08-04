# MAYogu LoadTest Report — ltd6wwaj01

**Status**: error — auto-stop: connect fail 56% > 30% (E2)
**Thời gian**: 2026-08-03T12:13:08.347Z → 2026-08-03T12:14:28.918Z (thực tế 1m 21s)

## Summary

| Metric | Giá trị |
|---|---|
| User đã tạo | 668 |
| Connect max | 65 |
| Active max | 297 |
| Actions | 412 |
| Success rate | 5.1% |
| Throughput avg / peak | 5/s · 316/s |
| Chat echo rate | 100% (0/0) |
| Queue peak | 0 |

## Latency theo action

| action | p50 | p95 | p99 | count |
|---|---|---|---|---|
| chat | 47.71s | 47.71s | 47.71s | 341 |
| read | 1ms | 1ms | 1ms | 66 |
| comment | 1ms | 1ms | 1ms | 3 |
| like | 1ms | 1ms | 1ms | 2 |

## Bottleneck candidates

Không phát hiện bottleneck vượt ngưỡng.

## Top errors

- `MATCH_TIMEOUT`: 268
- `NO_POST_FIXTURE`: 142
- `CHAT_ALREADY_SEATED`: 45
- `NETWORK`: 7

## Cấu hình run

```json
{
  "runId": "ltd6wwaj01",
  "targetUsers": 1000,
  "rampRate": 200,
  "rampMode": "rate",
  "durationMin": 30,
  "durationSec": 1800,
  "profile": {
    "chat": 40,
    "read": 30,
    "comment": 20,
    "like": 10,
    "view": 0
  },
  "gatewayUrl": "http://localhost:3000",
  "workerCount": 1,
  "socketsPerWorker": 1000,
  "registerRamp": 100,
  "useExistingAccounts": true,
  "freshAccounts": false,
  "seed": 188347,
  "createdAt": 1785759188347
}
```
