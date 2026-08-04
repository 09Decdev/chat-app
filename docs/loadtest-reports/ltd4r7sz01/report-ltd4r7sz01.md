# MAYogu LoadTest Report — ltd4r7sz01

**Status**: error — auto-stop: connect fail 85% > 30% (E2)
**Thời gian**: 2026-08-03T11:12:44.100Z → 2026-08-03T11:20:13.081Z (thực tế 7m 29s)

## Summary

| Metric | Giá trị |
|---|---|
| User đã tạo | 982 |
| Connect max | 20 |
| Active max | 318 |
| Actions | 533 |
| Success rate | 0% |
| Throughput avg / peak | 1/s · 504/s |
| Chat echo rate | 100% (0/0) |
| Queue peak | 0 |

## Latency theo action

| action | p50 | p95 | p99 | count |
|---|---|---|---|---|
| chat | 47.71s | 47.71s | 47.71s | 366 |
| read | 1ms | 1ms | 1ms | 162 |
| comment | 1ms | 1ms | 1ms | 5 |

## Bottleneck candidates

Không phát hiện bottleneck vượt ngưỡng.

## Top errors

- `MATCH_TIMEOUT`: 357
- `NO_POST_FIXTURE`: 334
- `NETWORK`: 9

## Cấu hình run

```json
{
  "runId": "ltd4r7sz01",
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
  "seed": 564099,
  "createdAt": 1785755564099
}
```
