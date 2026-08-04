# MAYogu LoadTest Report — ltd5a7ox02

**Status**: error — E3: quá nhiều worker chết
**Thời gian**: 2026-08-03T11:27:30.417Z → 2026-08-03T11:31:39.160Z (thực tế 4m 9s)

## Summary

| Metric | Giá trị |
|---|---|
| User đã tạo | 974 |
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
  "runId": "ltd5a7ox02",
  "targetUsers": 1000,
  "rampRate": 200,
  "rampMode": "rate",
  "durationMin": 3,
  "durationSec": 180,
  "profile": {
    "chat": 100,
    "read": 0,
    "comment": 0,
    "like": 0,
    "view": 0
  },
  "gatewayUrl": "http://localhost:3000",
  "workerCount": 1,
  "socketsPerWorker": 1000,
  "registerRamp": 100,
  "useExistingAccounts": true,
  "freshAccounts": false,
  "seed": 450417,
  "createdAt": 1785756450417
}
```
