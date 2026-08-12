# PLAN: Feed Signal Capture — Slice P0a (Server-only foundation)

**Status**: Ready for Phase 2 (Build) — Cổng 1 (PRD) waived bởi founder; Phase 1 (Plan) này là output của SeniorProjectManager.
**Author**: Alex (Senior PM + Workflow Architect)  **Last Updated**: 2026-08-11  **Version**: 0.1
**Stakeholders**: Founder (decision maker, waived Q-extra), Backend Architect (producer), Code Reviewer + AppSec + Performance Benchmarker (critics Phase 2), Reality Checker (gate Phase 3)
**Inputs**:
- PRD (Cổng 1 waived): `c:\MAYogu_VIASG\chat-app\docs\PRD-feed-signal-capture.md` v0.1
- Plan nguồn: `c:\MAYogu_VIASG\chat-app\docs\PLAN-feed-ranking-rollout.md` v0.2 §7 (P0.0 + P0a)
- R1 phản biện: `c:\MAYogu_VIASG\chat-app\docs\review-rounds\critique-feed-ranking-r1.md`
- Code verify: `c:\MAYogu_VIASG\content-service\` (8 file target, dòng verify ghi §1)

---

## 0. Tóm tắt (1 đoạn, press-release)

Slice P0a này xây **5 thành phần server-side** để feed-ranking có signal thật trước khi tune weight (chặn B1 premium leak + B6 UserAction blocker + M2/M4 integrity floor): (1) **T1 View API evolve** — `POST /post/:id/view` nhận thêm `dwellMs`/`completion`/`scrollDepth`/`replayCount`/`source`/`sessionId` + clamp/validate, client cũ vẫn 204 backward-compat; (2) **T2 Redis signal stores + Lua atomic** — `post:vs:{postId}` hash (Lua gộp 5-7 HINCRBY 1 round-trip), `user:viewed:{userId}` ZSET raise cap 1000→5000 + TTL 7d→30d, `view:debounce:{userId}:{postId}` Redis TTL thay in-memory `viewDebounceMap` (xóa khỏi code); (3) **T3 `scoreAndRank` evolution** — thêm `dwellScore` (đọc `post:vs` hash, weight=0 default FORYOU — accumulate only, KHÔNG tune P0a) + `profileType: 'MEMBER'|'DISCOVERY'|'FORYOU'` default `'FORYOU'` no-regression, migrate 3 caller (ForYou, YouMayLike, post-discovery.helper) + snapshot test 5 feed fixed seed; (4) **T4 `enrichAndMask`** — layer chặn premium leak, gọi `checkPostAccessSync` + `processSecureMedia`, rỗng `content` khi `!hasAccess`, cấm serialize `IScoredCandidate` thô; (5) **T5 `UserAction` migration** — `UserAction` model + `UserActionType` enum (5 giá trị) + `@@unique([userId,postId,actionType,ts])` + 2 index + `userId` FK User `onDelete: Cascade`, DOWN block rollback sạch. **Slice này KHÔNG build** P0.0 instrumentation (defer — cần product decision A/B), throttler 3-bucket install (config/infra nặng), bot-farm defense 4 lớp (defer P1 — không bot data), backfill cron (defer — không verify được trong run), partial index (P0b), Kafka (P3), discovery/co-engagement (P1). Mục tiêu: 5 task build được trong 1 run autonomous, L_tests xanh 0 skip, G1/G3/G4/G5/G6/G7/G8/G10 PASS.

---

## 1. Task breakdown (T1–T5)

> Tiền tố dòng ghi theo **code thật verify 2026-08-11** (một vài dòng lệch 2-3 so với PRD/R1 do version drift — plan dùng dòng thật). Mọi AC dẫn trực tiếp từ PRD §5.

### T1 — View API evolve (signal capture point)

**Description**: Nâng cấp `POST /post/:id/view` nhận body optional `dwellMs`/`completion`/`scrollDepth`/`replayCount`/`source`/`sessionId`. Service `incrementViewCount` validate + clamp boundary trước khi ghi Redis. Client cũ (không body) vẫn bump `countView` như cũ (backward-compat 204). Đây là điểm bắt signal giàu duy nhất trong pipeline.

**File target (verify)**:
- `content-service/src/infrastructure/driving-adapters/http-rest/controllers/post.controller.ts:653-672` (`registerView`, hiện `userId?` optional, KHÔNG `@Body()`, return 204) → thêm `@Body() dto: ViewSignalDto` (optional, `class-validator` `@IsOptional` + `@IsInt`/`@IsNumber`/`@IsString` + boundary).
- `content-service/src/core/services/post.service.ts:1545-1578` (`incrementViewCount`, hiện chỉ `redis.incrementPostView(postId)` + debounce in-memory) → evolve: parse dto → clamp `dwellMs` 0–3_600_000, `completion`/`scrollDepth` 0–1, `replayCount` ≥ 0 → gọi T2 Lua atomic (thay `incrementPostView`).
- Tạo `content-service/src/core/dto/view-signal.dto.ts` (mới) — DTO class.

**AC dẫn từ PRD**:
- AC-1.1: body `{"dwellMs": 12000, "completion": 0.8, "replayCount": 2, "source": "feed"}` → 204, Redis `post:vs:{postId}` hash có `viewCount+1`, `totalDwellMs+12000`, `completionSum+0.8`, `dwellCount+1`, `rewatchCount+2`.
- AC-1.2: body `{"dwellMs": 99999999}` (>3.6M) → clamp 3.6M + log warn, KHÔNG reject (giữ 204 backward-compat).
- AC-1.3: body `{"dwellMs": -5, "completion": 1.5}` → clamp về 0 / 1.0.
- AC-1.4: body rỗng hoặc thiếu `dwellMs` (client cũ) → vẫn bump `countView+1`, KHÔNG ghi dwell (backward-compat).
- AC-1.5: server-side dwell (timestamp request bắt đầu → view gửi về) chênh client-reported >30% → discard client dwell, vẫn bump count. *(Note: AC-1.5 cần request-start timestamp middleware — implement tối giản trong controller `@Req() req` gán `req.startTime`, không cần middleware riêng.)*

**Dependency**: T1 phụ thuộc T2 (Lua atomic + `post:vs` hash phải có trước khi service gọi).
**Assignment**: Producer = Backend Architect. Critics = Code Reviewer (clamp logic + backward-compat) + AppSec (DTO boundary, inject) + Performance Benchmarker (round-trip count). Gate = Reality Checker.

---

### T2 — Redis signal stores + Lua atomic (integrity floor M4 + debounce Redis AC-4)

**Description**: Thay 3 cơ chế Redis hiện tại (1 lệnh `INCR` rời, ZSET cap 1000/TTL 7d, in-memory `viewDebounceMap`) bằng: (a) `post:vs:{postId}` hash lưu 5-7 counter (viewCount/totalDwellMs/completionSum/skipCount/dwellCount/rewatchCount) cập nhật qua **Lua script atomic 1 round-trip** (gộp 5-7 HINCRBY/HINCRBYFLOAT — M4); (b) `user:viewed:{userId}` ZSET raise cap 1000→5000, TTL 7d→30d, lazy cleanup; (c) `view:debounce:{userId}:{postId}` Redis TTL thay in-memory `Map` (sống đa instance, không `.clear()` mass-loss — AC-4).

**File target (verify)**:
- `content-service/src/config/redis/cache.service.ts:615-622` (`incrementPostView`, hiện `redis.incr(key)` 1 lệnh) → thay bằng method `recordViewSignal(postId, payload)` gọi Lua `EVALSHA` (fallback `EVAL`).
- `content-service/src/config/redis/cache.service.ts:797-798` (`TTL_VIEWED_POSTS = 60*60*24*7`, `MAX_VIEWED_POSTS = 1000`) → raise `TTL_VIEWED_POSTS = 60*60*24*30`, `MAX_VIEWED_POSTS = 5000`.
- `content-service/src/config/redis/cache.service.ts:804-829` (`trackUserViewedPost`, ZADD + ZREMRANGEBYRANK + EXPIRE) → giữ logic, chỉ đổi constant (cap 5000, TTL 30d). Lazy cleanup đã có qua `zremrangebyrank`.
- `content-service/src/config/redis/cache.service.ts:831-852` (`getUserViewedPostIds`, default 500, cứng max 1000) → nới max 5000 (cho `scoreAndRank` đọc viewedSet đầy đủ).
- `content-service/src/core/services/post.service.ts:104` (`viewDebounceMap = new Map<string, number>()`) + `:105` (`VIEW_DEBOUNCE_MS = 5000`) + `:106` (`DEBOUNCE_CLEANUP_THRESHOLD = 10000`) + `:1555-1565` (debounce logic + `.clear()`) → **XÓA `viewDebounceMap` khỏi code** (AC-4.3), thay bằng `redis.setViewDebounce(userId, postId, ttl)` kiểm tra `EXISTS` trước khi track per-user.
- Thêm Lua script file hoặc inline trong `cache.service.ts` (PRD §5.1 step 3 spec script đã có — implement đúng spec, thêm `skipCount`/`dwellCount` nhánh `dwellMs < SKIP_MS` với `SKIP_MS=2000`).

**AC dẫn từ PRD**:
- AC-2.1: 1 view event = 1 Redis round-trip (Lua script) thay 5-7 HINCRBY rời. Verify bằng `MONITOR` log trong test.
- AC-2.2: viral test 10k view/s trên 1 post → Redis CPU < 70%.
- AC-2.3: Lua script trả `HGETALL post:vs:{postId}` để service log/return mà không cần thêm lệnh.
- AC-4.1: cùng user view cùng post 2 lần trong 5s → chỉ track per-user 1 lần (ZSET), vẫn bump countView 2 lần.
- AC-4.2: restart content-service → debounce state không mất (Redis TTL).
- AC-4.3: `viewDebounceMap` in-memory Map XÓA khỏi code — grep `viewDebounceMap` = no matches sau migrate.

**Dependency**: T2 độc lập (không phụ thuộc task nào). Có thể build song song với T5.
**Assignment**: Producer = Backend Architect. Critics = Code Reviewer (Lua atomic, EVALSHA fallback) + AppSec (Lua script injection — `KEYS`/`ARGV` parameterized, KHÔNG string concat) + Performance Benchmarker (round-trip benchmark). Gate = Reality Checker (verify MONITOR log, verify grep `viewDebounceMap` = no matches).

---

### T3 — `scoreAndRank` evolution (dwellScore + profileType, M2 no-regression)

**Description**: Mở rộng signature `scoreAndRank` thêm param `profileType: 'MEMBER'|'DISCOVERY'|'FORYOU'` (default `'FORYOU'` no-regression) + thêm `dwellScore` vào breakdown. `dwellScore` đọc từ `post:vs:{postId}` hash (T2): `(totalDwellMs / viewCount)` + `(completionSum / viewCount)`, hash miss → `dwellScore=0`. **P0a accumulate only — weight `dwellScore`=0 trong `SCORER_WEIGHTS` default FORYOU** (Q-extra-3 chốt: KHÔNG tune cho đến P1 khi có 1 tuần data thật). Migrate 3 caller hiện tại sang signature mới + snapshot test 5 feed sample fixed seed chặn drift.

**File target (verify)**:
- `content-service/src/application/ports/shared/recommendation.types.ts:74-88` (`IScoredCandidate.breakdown` 7 signal: hashtag/author/engagement/community/recency/viewedPenalty/ratingBonus) → thêm `dwellScore: number` vào breakdown (8 signal).
- `content-service/src/core/helper/recommendation-scorer.helper.ts:9-15` (`SCORER_WEIGHTS` — hashtag 30/author 25/engagement 20/community 15/recency 10) → thêm `dwellScore: 0` default (accumulate only, không contribute score — Q-extra-3).
- `content-service/src/core/helper/recommendation-scorer.helper.ts:70-147` (`scoreCandidate`) → thêm tham số `postVsHash?: Record<string, number>` (hoặc Inject Redis client — design decision Backend Architect), tính `dwellScore = hash miss ? 0 : (totalDwellMs/viewCount + completionSum/viewCount)`, thêm vào `breakdown`.
- `content-service/src/core/helper/recommendation-scorer.helper.ts:149-169` (`scoreAndRank`) → thêm param `profileType: 'MEMBER'|'DISCOVERY'|'FORYOU' = 'FORYOU'`, truyền xuống `scoreCandidate`.
- 3 caller migrate:
  - `content-service/src/core/services/post.service.ts:3042` (ForYou `scoreAndRank(deduped, profile, viewedSet, now)`) → thêm `profileType='FORYOU'` (default, không cần explicit nhưng phải verify output không đổi).
  - `content-service/src/core/services/post.service.ts:3141` (YouMayLike `scoreAndRank(dedupeCandidates(postCandidates), profile, viewedSet, now)`) → thêm `profileType='FORYOU'`.
  - `content-service/src/core/helper/post-discovery.helper.ts:160` (`scoreAndRank(deduped, profile, viewedSet, now)`) → thêm `profileType='FORYOU'`.
- Tạo snapshot test: `content-service/src/core/helper/__tests__/recommendation-scorer.snapshot.spec.ts` (mới) — 5 feed sample fixed seed, so sánh thứ tự + score trước/sau khi thêm param + `dwellScore`.

**AC dẫn từ PRD**:
- AC-5.1: `scoreAndRank(candidates, profile, viewedSet, now)` (signature cũ) → default `profileType='FORYOU'`, breakdown có `dwellScore: 0` (chưa có data Redis trong test).
- AC-5.2: 3 caller migrate, output không đổi (so sánh snapshot 5 feed sample fixed seed).
- AC-5.3: snapshot test chặn drift — đổi weight → test fail (phải bump VERSION + cập nhật snapshot có chủ đích).
- AC-5.4: `dwellScore` đọc từ `post:vs:{postId}` hash: `(totalDwellMs / viewCount) + (completionSum / viewCount)`. Hash miss → `dwellScore=0`.

**Dependency**: T3 phụ thuộc T2 (`post:vs` hash phải có trước khi `scoreCandidate` đọc). KHÔNG phụ thuộc T1 (scoreAndRank không gọi view API).
**Assignment**: Producer = Backend Architect. Critics = Code Reviewer (snapshot test discipline, breakdown shape) + Performance Benchmarker (Redis read trong scoreCandidate — batch HGETALL nhiều post 1 lần, không 1 round-trip/post). Gate = Reality Checker (verify 3 caller thật bằng grep, verify snapshot diff = 0).

---

### T4 — `enrichAndMask` layer (B1 premium leak guard)

**Description**: Layer bắt buộc mọi item từ `scoreAndRank` đi qua trước khi serialize ra HTTP. `enrichAndMask(candidate, userId, unlockedSet, isManager)` gọi `checkPostAccessSync` + `processSecureMedia` (2 helper đã có — KHÔNG đổi logic), rỗng `content` khi `!hasAccess`, trả `media: []`. Cấm serialize `IScoredCandidate` thô ra HTTP (pattern đúng đã có ở `search`). P0a chỉ xây layer + regression test — áp dụng cho feed endpoint mới sẽ làm ở P0b.

**File target (verify)**:
- `content-service/src/core/helper/post.helper.ts:198-204` (`processSecureMedia` — trả `[]` khi `!hasAccess`, `mediaList` khi `hasAccess`) → reuse, KHÔNG đổi logic.
- `content-service/src/core/helper/post.helper.ts:206-218` (`checkPostAccessSync` — author/isManager/!isPremium/premiumStatus !== APPROVED/unlockedSet.has) → reuse, KHÔNG đổi logic.
- `content-service/src/core/services/post.service.ts:1171-1179` (search pattern `content: hasAccess ? item.content : ''` + `isManager`/`isAuthor`/`isPurchased` resolve) → extract thành helper `enrichAndMask(candidate, userId, unlockedSet, isManager)` reusable (chỗ này đang inline trong search — generalize).
- Tạo `content-service/src/core/helper/feed-enrichment.helper.ts` (mới) hoặc thêm method vào `post.helper.ts` — `enrichAndMask(candidate: IRecommendationCandidate, userId: string, unlockedSet: Set<string>, isManager: boolean)` trả masked item `{...candidate, content: hasAccess ? candidate.content : '', media: processSecureMedia(candidate.media, hasAccess), isPurchased: unlockedSet.has(candidate.id), isAuthor: candidate.authorId === userId}`.
- Tạo regression test: `content-service/src/core/helper/__tests__/feed-enrichment.regression.spec.ts` (mới) — `items.every(i => !i.content || i.isPurchased || i.isAuthor)` pass 100%.

**AC dẫn từ PRD**:
- AC-6.1: mọi item đi qua `scoreAndRank` ra HTTP phải qua `enrichAndMask` — grep HTTP response trong controller feed mới không có `IScoredCandidate` thô (P0a chỉ xây layer + test, áp dụng endpoint P0b).
- AC-6.2: post premium chưa unlock → `content: ''`, `media: []` (qua `processSecureMedia`).
- AC-6.3: post premium đã unlock (`unlockedSet.has(post.id)`) → `content` đầy đủ, `media` đầy đủ.
- AC-6.4: author post hoặc manager → `hasAccess=true`.
- AC-6.5: regression test `items.every(i => !i.content || i.isPurchased || i.isAuthor)` pass 100%.

**Dependency**: T4 phụ thuộc T3 (`IScoredCandidate.breakdown` phải có `dwellScore` shape mới — nếu enrich trước T3 thì shape sai). KHÔNG phụ thuộc T1/T2.
**Assignment**: Producer = Backend Architect. Critics = AppSec (access control — đây là B1 security blocker, focus cao nhất) + Code Reviewer (generalize pattern không break search hiện tại). Gate = Reality Checker (verify regression test pass, verify `IScoredCandidate` không serialize thô qua grep `JSON.stringify(scored)` = no matches trong controller).

---

### T5 — `UserAction` migration (B6 + M6 privacy)

**Description**: Tạo bảng `UserAction` thống nhất (thay union 4 bảng `PostLike`/`SavedPost`/`UserUnlockedContent`/`Comment` — self-join chậm 5-10×). Migration UP tạo model + enum + index + `@@unique` idempotency (Kafka P3) + `userId` FK User `onDelete: Cascade` (GDPR). Migration DOWN block rollback sạch. **DEFER backfill cron** (2 tuần, không verify được trong run này — note trong §6) — schema sẵn sàng cho P1 co-engagement.

**File target (verify)**:
- `content-service/prisma/schema.prisma:46-86` (Post), `:244-265` (UserUnlockedContent), `:267-273` (View chỉ `id/countView/postId`), `:689-698` (PostLike), `:700-710` (SavedPost) — KHÔNG có `UserAction` model (verify grep no matches).
- Thêm vào `content-service/prisma/schema.prisma` (cuối file hoặc gần các action table):
  ```prisma
  model UserAction {
    id          BigInt        @id @default(autoincrement())
    userId      String
    postId      String
    actionType  UserActionType
    ts          DateTime      @default(now())
    dwellBucket String?       // M6: "<10s"|"10-30s"|"30-60s"|">60s" — KHÔNG log exact dwellMs
    user        User          @relation(fields: [userId], references: [id], onDelete: Cascade)
    post        Post          @relation(fields: [postId], references: [id], onDelete: Cascade)

    @@unique([userId, postId, actionType, ts])  // M7 idempotency Kafka P3
    @@index([userId, ts])        // co-engagement lookup
    @@index([postId, actionType]) // precompute nightly
  }

  enum UserActionType {
    VIEW_MEANINGFUL
    LIKE
    SAVE
    UNLOCK
    COMMENT
  }
  ```
- Tạo migration: `content-service/prisma/migrations/<timestamp>_add_user_action/migration.sql` — UP block (CREATE TYPE + CREATE TABLE + 2 index + unique constraint + FK CASCADE) + DOWN block (DROP TABLE + DROP TYPE) — G8 rollback sạch.
- Verify `User` model có relation `userActions UserAction[]` (thêm vào `schema.prisma` User model nếu thiếu — Backend Architect check).

**AC dẫn từ PRD**:
- AC-7.1: `UserAction` model + `UserActionType` enum có trong `schema.prisma` sau migration.
- AC-7.2: `@@unique([userId, postId, actionType, ts])` + `@@index([userId, ts])` + `@@index([postId, actionType])`.
- AC-7.3: `userId` FK User `onDelete: Cascade` (GDPR right-to-be-forgotten).
- AC-7.6: `dwellBucket` (`<10s|10-30s|30-60s|>60s`) lưu thay `dwellMs` exact (PII). KHÔNG log `dwellMs` exact vào DB.

**DEFER (note rõ trong §6)**: AC-7.4 backfill cron 2 tuần (4 bảng → UserAction) + AC-7.5 retention cron nightly `DELETE WHERE ts < now()-30d` — defer sang run sau vì (a) không có DB access verify volume, (b) Q-extra-2 chốt incremental chunk 10k/batch cần infra cron riêng, (c) slice này chỉ cần schema sẵn sàng cho P1.

**Dependency**: T5 độc lập (chỉ schema + migration, không đụng code T1-T4). Build song song với T2.
**Assignment**: Producer = Backend Architect. Critics = AppSec (FK CASCADE — verify User delete propagation, dwellBucket PII) + Code Reviewer (migration UP/DOWN block idempotent). Gate = Reality Checker (verify `prisma migrate deploy` thành công + `prisma migrate resolve --rolled-back` DOWN block rollback sạch trên staging).

---

## 2. Dependency DAG (thứ tự build)

```
┌─────────────────────────────────────────────────────────┐
│  Phase A (song song, không phụ thuộc nhau):              │
│    T5 (migration schema)  ||  T2 (Redis stores + Lua)   │
└─────────────────────────────────────────────────────────┘
              │                              │
              ▼                              ▼
┌─────────────────────────────────────────────────────────┐
│  Phase B: T1 (View API evolve) — depend T2             │
│    (service gọi Lua atomic + post:vs hash từ T2)        │
└─────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│  Phase C: T3 (scoreAndRank evolve) — depend T2          │
│    (scoreCandidate đọc post:vs hash từ T2)             │
└─────────────────────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────┐
│  Phase D: T4 (enrichAndMask) — depend T3                │
│    (IScoredCandidate.breakdown có dwellScore shape T3)  │
└─────────────────────────────────────────────────────────┘
```

**Tóm tắt 1 dòng**: `T5‖T2 → T1 → T3 → T4` (T5 + T2 song song Phase A; T1 depend T2; T3 depend T2; T4 depend T3).

**Lý do DAG này**:
- T2 phải trước T1: `incrementViewCount` (T1) gọi `recordViewSignal` Lua (T2) — không có Lua thì service không ghi được `post:vs` hash.
- T2 phải trước T3: `scoreCandidate` (T3) đọc `post:vs` hash (T2) — hash miss → `dwellScore=0` (acceptable fallback, nhưng method đọc phải tồn tại).
- T3 phải trước T4: `enrichAndMask` (T4) nhận `IScoredCandidate` đã có `dwellScore` trong breakdown (T3) — nếu enrich trước, shape breakdown sai → type error.
- T5 độc lập: chỉ schema + migration, không import code T1-T4. Build song song T2 để rút ngắn critical path.

**Critical path**: T2 → T1 → T3 → T4 (4 task tuần tự). T5 hidden trong Phase A song song. Ước tính producer 1 task = 30-60 min code + 30 min test = ~1h/task → critical path ~4-5h + buffer review.

---

## 3. Branch + rollback

### Branch
- **Repo**: `c:\MAYogu_VIASG\content-service` (git repo riêng — verify bằng `.git`).
- **Branch name**: `feat/feed-signal-capture-p0a` (tạo từ `main` hiện tại).
- **Commit convention**: conventional commits — `feat(view-api):`, `feat(redis):`, `feat(ranking):`, `feat(enrich):`, `feat(db):` cho T1-T5. 1 commit/task hoặc squash theo preference producer.

### Rollback plan
- **Code rollback**: `git revert` (T1-T4 code) + `git checkout main -- content-service/prisma/` (T5 schema) — KHÔNG `reset --hard` (conductor rule: tránh destructive).
- **Migration rollback (G8)**: T5 migration phải có DOWN block:
  ```sql
  -- DOWN
  DROP TABLE IF EXISTS "UserAction";
  DROP TYPE IF EXISTS "UserActionType";
  ```
  Test rollback trên staging: `prisma migrate resolve --rolled-back <timestamp>_add_user_action` → verify `UserAction` table + `UserActionType` type gone, các bảng cũ (PostLike/SavedPost/UserUnlockedContent/Comment) không đụng.
- **Redis rollback**: Lua script + `post:vs` hash + `view:debounce` key là **additive** (không xóa `incrementPostView` cũ ngay — giữ fallback 1 release). Nếu revert: client cũ quay lại bump count, `post:vs` hash không được ghi nhưng không corrupt (hash chỉ thiếu data, không sai data). `MAX_VIEWED_POSTS` 5000 → 1000 rollback qua revert code.
- **Data rollback**: KHÔNG xóa `UserAction` rows (chưa có data — backfill defer). KHÔNG xóa `post:vs` hash (additive, không ảnh hưởng ranking vì `dwellScore` weight=0).

---

## 4. Test plan

> L_tests (toàn bộ test suite content-service) phải xanh 0 skip sau slice này. Skip-by-design local OK nếu CI closes (verify pattern skip-if-no-DB).

### 4.1 Unit tests

| Task | Test file (mới hoặc sửa) | Test cases |
|---|---|---|
| T1 | `content-service/src/core/services/__tests__/post.service.view-signal.spec.ts` | (a) clamp `dwellMs` 0–3.6M, `completion` 0–1, `replayCount` ≥ 0 (AC-1.2/1.3); (b) body rỗng/thiếu `dwellMs` → vẫn bump count (AC-1.4); (c) body đầy đủ → 5-7 field lưu Redis (AC-1.1, verify qua mock Redis `recordViewSignal` call args); (d) server-side dwell chênh client >30% → discard client dwell (AC-1.5). |
| T2 | `content-service/src/config/redis/__tests__/cache.service.view-signal.spec.ts` | (a) Lua script atomic — 1 round-trip, verify `redis.eval` called 1 lần (AC-2.1, dùng `redis-mock` hoặc spy `ioredis`); (b) `EVALSHA` fallback `EVAL` khi SHA miss; (c) `trackUserViewedPost` cap 5000 + TTL 30d (verify `zremrangebyrank` + `expire` args); (d) `getUserViewedPostIds` hỗ trợ limit 5000; (e) `setViewDebounce` + `EXISTS` check; (f) grep `viewDebounceMap` no matches (AC-4.3). |
| T3 | `content-service/src/core/helper/__tests__/recommendation-scorer.snapshot.spec.ts` | (a) snapshot 5 feed sample fixed seed — so sánh thứ tự + score trước/sau thêm `profileType` + `dwellScore` (AC-5.2/5.3); (b) `dwellScore` đọc `post:vs` hash đúng công thức (AC-5.4); (c) hash miss → `dwellScore=0` (AC-5.1); (d) default `profileType='FORYOU'` no-regression; (e) đổi weight `dwellScore` 0→1 → snapshot fail (verify drift detection). |
| T4 | `content-service/src/core/helper/__tests__/feed-enrichment.regression.spec.ts` | (a) `items.every(i => !i.content || i.isPurchased || i.isAuthor)` pass 100% (AC-6.5); (b) premium chưa unlock → `content: ''`, `media: []` (AC-6.2); (c) premium đã unlock → đầy đủ (AC-6.3); (d) author/manager → `hasAccess=true` (AC-6.4); (e) grep `JSON.stringify(scored)` trong controller = no matches (AC-6.1). |
| T5 | `content-service/prisma/__tests__/user-action.migration.spec.ts` (hoặc validate qua `prisma migrate diff`) | (a) `UserAction` model + `UserActionType` enum có trong schema sau migrate (AC-7.1); (b) `@@unique` + 2 `@@index` đúng (AC-7.2); (c) `userId` FK CASCADE (AC-7.3); (d) `dwellBucket` field có, KHÔNG có `dwellMs` exact column (AC-7.6); (e) DOWN block rollback sạch (G8). |

### 4.2 Contract tests (G3)

- **View API body schema** (T1): `POST /post/:id/view` body mới — OpenAPI/Swagger schema update (`@ApiBody({ type: ViewSignalDto })`). Contract test: (a) body đúng schema → 204; (b) body sai type (`dwellMs: "abc"`) → 400; (c) body over boundary → clamp (không 400) (AC-1.2); (d) body rỗng → 204 (backward-compat AC-1.4).
- **204 backward-compat** (T1): client cũ không gửi body → 204, response body rỗng (như cũ). Verify `HttpCode(204)` không đổi.
- **Throttler 429 envelope**: defer (throttler defer slice sau — note trong §6). Khi throttler install, contract test 429 + `X-Throttle-Reason` header (AC-3.4) — KHÔNG test slice này.

### 4.3 Mutation target (G2 — defer, note rõ)

> Slice này **defer G2 mutation** sang run sau vì (a) `mutation` script chưa có trong `package.json` (chỉ `test`/`test:cov`/`test:e2e`), (b) setup `stryker`/`mutode` infra nặng — không fit 1 run autonomous. Khi setup xong, mutation target cho slice này:
- **T2 Lua atomic**: mutate `HINCRBY` → `HSET` (sẽ overwrite thay accumulate) — mutant phải killed.
- **T2 clamp**: mutate boundary `0..3.6M` → `0..3600` — mutant phải killed.
- **T1 backward-compat**: mutate `if (!dto) return bumpCountOnly()` → `if (!dto) return` — mutant phải killed (client cũ vẫn nhận 204 nhưng KHÔNG bump count — break backward-compat).
- **T4 mask**: mutate `content: hasAccess ? candidate.content : ''` → `content: candidate.content` — mutant phải killed (premium leak).
- **T3 snapshot drift**: mutation `dwellScore` weight 0→1 — snapshot test phải kill.

**Note**: G2 defer không block slice này ship (G2 N/A cho slice — §5 note rõ). Stryker setup + G2 run sang run sau.

### 4.4 L_tests xanh 0 skip

- Chạy `cd content-service && npm run test` — exit 0, 0 skip (skip-by-design local OK nếu CI closes).
- Chạy `cd content-service && npm run test:cov` — coverage ≥ 70% stmts/branch/funcs (G1).
- Chạy `cd content-service && npm run test:e2e` — exit 0 (nếu có e2e liên quan view API).

---

## 5. Hard-gate mapping (G1–G10)

> Từ `c:\MAYogu_VIASG\chat-app\docs\ASSURANCE-prod-refactor.md` G1–G10. Slice này mapping:

| Gate | Trạng thái slice này | Evidence |
|---|---|---|
| **G1 Tests** | PASS | `npm run test` exit 0, 0 skip strict. Coverage ≥ 70% stmts/branch/funcs. Test files §4.1. |
| **G2 Mutation** | **N/A (defer)** | `mutation` script chưa có trong `package.json`. Defer stryker setup + mutation run sang run sau. Mutation target §4.3. KHÔNG block ship slice này. |
| **G3 Contract** | PASS | View API body schema + 204 backward-compat (§4.2). Throttler 429 contract defer. |
| **G4 Type/Lint/Build** | PASS | `npx tsc --noEmit` exit 0 (note: `package.json` không có `typecheck` script — chạy `tsc --noEmit` trực tiếp). `npm run build` exit 0. `npm run lint` echo disabled (pre-existing). 0 lint error mới. |
| **G5 SAST + secret-scan** | PASS | `gitleaks detect` install + chạy (hiện dormancy — must install per ASSURANCE gap #1). Scan: Lua script, ViewSignalDto, `enrichAndMask`, `UserAction` migration, FK CASCADE config. Git history sạch. |
| **G6 Code Reviewer** | PASS | 0 Critical/Major/High surviving. Focus: T2 Lua script atomic (AppSec — KEYS/ARGV parameterized, KHÔNG string concat), T4 `enrichAndMask` access control (B1 blocker — highest focus), T5 FK CASCADE (AppSec — User delete propagation). |
| **G7 Reality Checker** | PASS | Verify claim bằng test thật: (a) "3 caller migrate no-regression" — snapshot 5 feed diff = 0 (T3); (b) "Lua 1 round-trip" — `MONITOR` log 1 `EVAL` per view (T2); (c) "viewDebounceMap xóa" — grep `viewDebounceMap` = no matches (T2/AC-4.3); (d) "FK CASCADE" — test User delete propagation (T5); (e) "premium không leak" — regression test `items.every(...)` pass (T4/AC-6.5). KHÔNG tin doc claim. |
| **G8 Migration** | PASS | T5 `UserAction` migration UP + DOWN block. `pg_advisory_lock` + per-migration BEGIN/COMMIT. DOWN block: `DROP TABLE UserAction; DROP TYPE UserActionType`. Test rollback trên staging. |
| **G9 Payment** | **N/A** | Slice này KHÔNG đụng payment code. `UserUnlockedContent` (schema 244-265) KHÔNG đổi — chỉ là source cho backfill P1 (defer). |
| **G10 Auth/PII** | PASS | THREAT-MODEL.md cập nhật cho `UserAction` + dwell = PII. Threats: (TH-A) leak dwell bucket qua admin endpoint — `UserAction` query chỉ admin/internal, KHÔNG expose HTTP; (TH-B) bot farm moi premium boost — M1 defense defer P1 (note), nhưng `dwellScore` weight=0 P0a → bot boost không ảnh hưởng ranking ngay; (TH-C) GDPR right-to-be-forgotten — `userId` FK CASCADE test (T5); (TH-D) retention cron fail — defer cron (note), khi install alert + monitor. Authz test: throttler endpoint không expose (defer), `UserAction` query chỉ admin/internal. |

---

## 6. Deferred ra run sau (list rõ + lý do)

> Mọi item deferred có lý do cụ thể (không đủ data / infra nặng / không verify được trong run autonomous). KHÔNG phải bỏ quên — list cho run sau rõ ràng.

### 6.1 P0.0 instrumentation (T1-inst — Analytics port)
- **Defer**: `trackEvent`/`trackDwell`/`trackUnlock` + CTR port trong `analytics.service.port.ts` + A/B assignment service + 4 metric §1 baseline.
- **Lý do**: Cần product decision A/B experiment design (experimentId naming, bucket allocation rule, metric join). Founder waived Q-extra, không trả lời → slice này không build A/B. **Blocker cho A/B tune weight P1** — phải build trước P1 start.
- **Run sau**: Run #2 — "P0.0 instrumentation baseline" (1-2 tuần).

### 6.2 Throttler 3-bucket install (nestjs-throttler-redis)
- **Defer**: `nestjs-throttler-redis` 3 bucket (per-IP 120/phút, per-user 30/phút, per-(IP+user) 60/phút) + anonymous >5 view/phút → require OTP.
- **Lý do**: (a) `@nestjs/throttler` KHÔNG có trong `package.json` (verify §1) → cần install + config infra (Redis storage adapter, guard wiring, module import). (b) Q-extra-1 chốt: chưa có bot data → throttler 3-bucket rẻ an toàn, nhưng install + config + 4-instance test là infra nặng, không fit 1 run autonomous. (c) Slice này đủ covered bằng `view:debounce` Redis (T2) — 1 user view 1 post nhiều lần trong 5s đã debounce.
- **Run sau**: Run #3 — "throttler 3-bucket install + 4-instance test" (AC-3.1/3.2/3.3/3.4).

### 6.3 Bot-farm defense 4 lớp (M1)
- **Defer**: (a) server-side dwell đo timestamp, (b) fingerprint `hash(userAgent+IP/24+lang+screen)`, (c) pattern detection N user gửi dwell đúng threshold ±100ms, (d) CAPTCHA threshold user <7 ngày.
- **Lý do**: Q-extra-1 — chưa có evidence bot farm. P0.0 instrumentation (defer §6.1) sẽ cho data. Slice này đủ `dwellScore` weight=0 (Q-extra-3) → bot moi premium boost KHÔNG ảnh hưởng ranking ngay (no-regression guard).
- **Run sau**: Run #4 (sau P0.0 có data) — "bot-farm defense 4 lớp" — quyết định build 4 lớp hay subset dựa data thật.

### 6.4 Backfill cron 2 tuần (AC-7.4) + retention cron nightly (AC-7.5)
- **Defer**: Cron 2 tuần backfill từ `PostLike`/`SavedPost`/`UserUnlockedContent`/`Comment` → `UserAction` (actionType LIKE/SAVE/UNLOCK/COMMENT). Cron nightly `DELETE WHERE ts < now()-30d` + metric count.
- **Lý do**: (a) Q-extra-2 — không có DB access verify rows volume (có thể hàng triệu) → cần incremental chunk 10k/batch (safe default). (b) Cron infra (`@nestjs/schedule` đã có trong deps) + backfill idempotency logic + dry-run test là infra nặng. (c) Slice này chỉ cần schema sẵn sàng cho P1 — `UserAction` table rỗng OK, P1 co-engagement precompute chạy trên data accumulate từ P0a forward.
- **Run sau**: Run #5 — "UserAction backfill cron + retention cron" — cần DB access + volume estimate.

### 6.5 Partial index migration §6.1 (B2)
- **Defer**: Normalize `_activePostCondition` bỏ OR + partial index `where: { isPublished: true, isDelete: false }` + `id` tiebreaker.
- **Lý do**: B2 fix cần sort/cursor chốt trước (P0b — `(score, id)` keyset) + index change risk riêng. Slice này không build member feed endpoint (P0b).
- **Run sau**: Run #6 — "P0b member feed + partial index" (4-6 tuần, FE payload + mobile release).

### 6.6 Kafka `view-meaningful` (M7) + multi-outcome (M10)
- **Defer**: Kafka producer (view API emit khi `dwellMs >= MEANINGFUL_DWELL_MS=5000`) + batch consumer → `user:profile` Hash + multi-outcome sub-scores (willComment/willUnlock/willLike/willShare).
- **Lý do**: M10 cut — `buildUserProfile` rebuild DB + TTL cache đủ cho P0/P1/P2. Kafka chỉ value khi profile stale >5ph. Slice này không cần.
- **Run sau**: Run #7 — "P3 Kafka + multi-outcome" (sau P1 co-engagement data đủ).

### 6.7 Discovery feed + co-engagement precompute (P1)
- **Defer**: `GET /post/discover` endpoint + co-engagement CF precompute nightly (B3 fix) + `coengagementScore` + `popularityDecay`.
- **Lý do**: Cần `UserAction` backfill xong (§6.4) + P0.0 instrumentation (§6.1). Slice này chỉ xây `dwellScore` accumulate + `profileType` param sẵn sàng cho P1.
- **Run sau**: Run #8 — "P1 discovery + co-engagement" (3-4 tuần, sau backfill).

### 6.8 G2 mutation (stryker setup)
- **Defer**: `stryker` install + config + mutation run ≥ 70% killed.
- **Lý do**: `mutation` script chưa có trong `package.json`. Setup infra + baseline mutation run nặng, không fit 1 run autonomous. Mutation target §4.3 liệt kê rõ cho run sau.
- **Run sau**: Run #9 — "stryker setup + G2 mutation baseline" (chạy song song các run khác).

---

## 7. Open decisions baked into plan (founder waived — không hỏi lại)

> Founder waived Q-extra (không trả lời) + conductor quyết định mặc định an toàn. Ghi vào plan để producer không cần hỏi lại.

| Q | Quyết định | Lý do |
|---|---|---|
| **Q-extra-1** (bot-inflation) | DEFER pattern detection + CAPTCHA sang P1. Build throttler 3-bucket (rẻ, an toàn) — defer install sang run sau (§6.2). | Chưa có evidence bot farm. P0.0 instrumentation (§6.1) cho data. |
| **Q-extra-2** (backfill volume) | DEFER backfill cron. Schema `UserAction` sẵn sàng, table rỗng OK. Khi build cron, incremental chunk 10k/batch. | Không có DB access verify volume. |
| **Q-extra-3** (tune weight) | P0a accumulate only. `dwellScore` weight=0 trong `SCORER_WEIGHTS` default FORYOU. KHÔNG tune cho đến P1 (1 tuần data thật). | Tune sớm = ranking drift không baseline. |
| **Q1** (anon) | Anonymous chỉ count popularity post-level (popularity post-level), KHÔNG per-user signal. | Anon userId không tin được. |
| **Q3** (MEANINGFUL_DWELL_MS) | 5000ms. Slice này KHÔNG dùng cho Kafka (defer P3), chỉ note cho pattern detection (defer P1). | Plan §8 đề xuất. |

---

## 8. References

- PRD: `c:\MAYogu_VIASG\chat-app\docs\PRD-feed-signal-capture.md` v0.1 (AC-1 → AC-7 dẫn trực tiếp).
- Plan nguồn: `c:\MAYogu_VIASG\chat-app\docs\PLAN-feed-ranking-rollout.md` v0.2 §7 (P0a scope).
- R1 phản biện: `c:\MAYogu_VIASG\chat-app\docs\review-rounds\critique-feed-ranking-r1.md` (B1/B6 + M2/M4/M6 punch list).
- ASSURANCE hard-gate: `c:\MAYogu_VIASG\chat-app\docs\ASSURANCE-prod-refactor.md` G1–G10.
- Code verify (đường dẫn tuyệt đối, dòng verify 2026-08-11):
  - `c:\MAYogu_VIASG\content-service\src\infrastructure\driving-adapters\http-rest\controllers\post.controller.ts:653-672` (registerView)
  - `c:\MAYogu_VIASG\content-service\src\core\services\post.service.ts:104-106` (viewDebounceMap + VIEW_DEBOUNCE_MS + DEBOUNCE_CLEANUP_THRESHOLD), `:1171-1179` (search pattern mask), `:1545-1578` (incrementViewCount), `:3042` (ForYou caller), `:3141` (YouMayLike caller)
  - `c:\MAYogu_VIASG\content-service\src\core\helper\post-discovery.helper.ts:160` (3rd caller)
  - `c:\MAYogu_VIASG\content-service\src\config\redis\cache.service.ts:615-622` (incrementPostView), `:797-798` (TTL/MAX cap), `:804-829` (trackUserViewedPost), `:831-852` (getUserViewedPostIds)
  - `c:\MAYogu_VIASG\content-service\src\core\helper\recommendation-scorer.helper.ts:9-15` (SCORER_WEIGHTS), `:22-44` (ENGAGEMENT_FORMULA + calcEngagementRaw), `:70-147` (scoreCandidate), `:149-169` (scoreAndRank), `:185-216` (cursor)
  - `c:\MAYogu_VIASG\content-service\src\application\ports\shared\recommendation.types.ts:29-64` (IRecommendationCandidate), `:74-88` (IScoredCandidate.breakdown)
  - `c:\MAYogu_VIASG\content-service\src\core\helper\post.helper.ts:198-204` (processSecureMedia), `:206-218` (checkPostAccessSync)
  - `c:\MAYogu_VIASG\content-service\prisma\schema.prisma:46-86` (Post), `:244-265` (UserUnlockedContent), `:267-273` (View), `:689-698` (PostLike), `:700-710` (SavedPost) — KHÔNG UserAction
  - `c:\MAYogu_VIASG\content-service\package.json` (Prisma ^6.17.1, KHÔNG throttler, KHÔNG mutation script)
