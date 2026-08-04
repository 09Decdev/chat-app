# MAYogu LoadTest Report — ltd47m8f01

**Status**: error — E1: register fail 100% > 50%
**Thời gian**: 2026-08-03T10:57:29.679Z → 2026-08-03T10:59:21.609Z (thực tế 2m 52s)

## Summary

| Metric | Giá trị |
|---|---|
| User đã tạo | 0 |
| Connect max | 0 |
| Active max | 0 |
| Actions | 0 |
| Success rate | 100% |
| Throughput avg / peak | 0/s · 0/s |
| Chat echo rate | 100% (0/0) |
| Queue peak | 0 |

## Latency theo action

| action | p50 | p95 | p99 | count |
|---|---|---|---|---|

## Bottleneck candidates

Không phát hiện bottleneck vượt ngưỡng.

## Top errors

Không có lỗi.

## Cấu hình run

```json
{
  "runId": "ltd47m8f01",
  "targetUsers": 10000,
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
  "socketsPerWorker": 10000,
  "registerRamp": 100,
  "useExistingAccounts": true,
  "freshAccounts": false,
  "seed": 649679,
  "createdAt": 1785754649679
}
```
