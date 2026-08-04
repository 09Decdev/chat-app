# MAYogu LoadTest Report — ltd5uq1001

**Status**: error — E1: register fail 100% > 50%
**Thời gian**: 2026-08-03T11:43:27.300Z → 2026-08-03T11:45:07.919Z (thực tế 2m 41s)

## Summary

| Metric | Giá trị |
|---|---|
| User đã tạo | 837 |
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
  "runId": "ltd5uq1001",
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
  "seed": 407300,
  "createdAt": 1785757407300
}
```
