# MAYogu LoadTest Report — ltd6lwra01

**Status**: error — auto-stop: connect fail 71% > 30% (E2)
**Thời gian**: 2026-08-03T12:04:35.734Z → 2026-08-03T12:05:53.290Z (thực tế 1m 18s)

## Summary

| Metric | Giá trị |
|---|---|
| User đã tạo | 759 |
| Connect max | 47 |
| Active max | 268 |
| Actions | 358 |
| Success rate | 0% |
| Throughput avg / peak | 5/s · 273/s |
| Chat echo rate | 100% (0/0) |
| Queue peak | 49 |

## Latency theo action

| action | p50 | p95 | p99 | count |
|---|---|---|---|---|
| chat | 47.71s | 47.71s | 47.71s | 279 |
| read | 1ms | 1ms | 1ms | 71 |
| comment | 1ms | 1ms | 1ms | 7 |
| like | 1ms | 1ms | 1ms | 1 |

## Bottleneck candidates

Không phát hiện bottleneck vượt ngưỡng.

## Top errors

- `MATCH_TIMEOUT`: 273
- `NO_POST_FIXTURE`: 158
- `NETWORK`: 6

## Cấu hình run

```json
{
  "runId": "ltd6lwra01",
  "targetUsers": 1000,
  "rampRate": 200,
  "rampMode": "rate",
  "durationMin": 2,
  "durationSec": 120,
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
  "seed": 675734,
  "createdAt": 1785758675734
}
```
