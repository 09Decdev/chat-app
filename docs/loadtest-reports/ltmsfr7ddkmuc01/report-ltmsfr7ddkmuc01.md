# MAYogu LoadTest Report — ltmsfr7ddkmuc01

**Status**: error — E3: quá nhiều worker chết
**Thời gian**: 2026-08-05T07:16:41.721Z → 2026-08-05T07:22:08.906Z (thực tế 5m 27s)

## Summary

| Metric | Giá trị |
|---|---|
| User đã tạo | 9,968 |
| Connect max | 0 |
| Active max | 3,821 |
| Actions | 0 |
| Success rate | 100% |
| Throughput avg / peak | 0/s · 1666/s |
| Chat echo rate | 100% (0/0) |
| Queue peak | 142 |

## Latency theo action

| action | p50 | p95 | p99 | count |
|---|---|---|---|---|

## Bottleneck candidates

1. **[Med]** Queue-count tăng liên tục 5 phút (142 user)
   Matching engine trần ~100 user/s (MAX_POP=200/tick 2s) — user vào phòng chậm hơn ramp.

## Top errors

- `MATCH_TIMEOUT`: 80,241
- `NO_POST_FIXTURE`: 61,692

## Cấu hình run

```json
{
  "runId": "ltmsfr7ddkmuc01",
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
  "gatewayUrl": "https://api.mayogu.com",
  "workerCount": 1,
  "socketsPerWorker": 10000,
  "registerRamp": 100,
  "useExistingAccounts": true,
  "freshAccounts": false,
  "seed": 201720,
  "createdAt": 1785914201720
}
```
