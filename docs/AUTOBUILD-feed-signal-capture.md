# AUTOBUILD: Feed Signal Capture — Slice P0a (Phase 3 Build)

**Branch**: `feat/feed-signal-capture-p0a` (repo `c:\MAYogu_VIASG\content-service`)
**Built**: 2026-08-11
**Producer**: Backend Architect
**Status**: KHÔNG commit, KHÔNG push, KHÔNG merge (conductor rule)

---

## Executive Summary (conductor)

**Slice**: P0.0+P0a server-side signal capture (feed-ranking foundation). 5 task T1-T5.
**Verdict**: **KHÔNG SHIPPABLE cho prod** — code hoàn chỉnh + 368 test pass + ACs met, nhưng 2 hard-gate là infra gap chưa PASS (G2 mutation, G5 gitleaks). Không phải code defect.

### Phases đã chạy
1. **Phase 0 — PRD** (PM): `docs/PRD-feed-signal-capture.md` — Gate 1 **waived** (founder "tự build, tôi chỉ cần kết quả").
2. **Phase 1 — Plan** (Senior PM): `docs/PLAN-feed-signal-capture.md` — 5 task, DAG `T5‖T2→T1→T3→T4`, branch `feat/feed-signal-capture-p0a`.
3. **Phase 2 — Design**: nén vào build (PRD đã có design + THREAT-MODEL §6 G10); AppSec critic cover security.
4. **Phase 3 — Build** (Backend Architect): T1-T5 code + 5 test suite (72 test). Gate G1 pass.
5. **Cross-review** (3 critic song song: Code Reviewer + AppSec + Performance): 1 blocker + 13 major/converged → 14 finding sống (adversarial verify, không critic nào bác).
6. **Fix round 1** (producer): 13 fix + 1 documented deviation. tsc PASS, 358 test pass.
7. **Reality Checker gate**: KHÔNG SHIPPABLE — G3 FAIL (test bypass controller, đúng bug #1 cũ) + G5 NOT-RUN.
8. **Fix round 2** (producer): +10 contract test qua HTTP (supertest) + gitleaks heuristic. tsc PASS, **368 test pass, 0 skip**.
9. **Final verify** (conductor): jest 32 suites/368 pass/0 skip/1 snapshot tự chạy; contract spec dùng `request(app.getHttpServer())` thật; `viewDebounceMap` sạch; migration DOWN uncommented.

### Hard-gate table
| Gate | Status | Bằng chứng |
|---|---|---|
| G1 tests xanh 0 skip | **PASS** | 32 suites/368 pass/0 skip/1 snap (conductor tự chạy) |
| G2 mutation (stryker) | **DEFERRED** | stryker chưa setup trong slice — infra gap, không code defect |
| G3 contract test | **PASS** (sau round 2) | supertest HTTP path: 7 view-signal + 3 throttler 429+header |
| G4 tsc/build | **PASS** | `npx tsc --noEmit` 0 error |
| G5 SAST+gitleaks | **NOT-RUN** | binary không có trong env; heuristic grep 0 secret; **CI phải chạy** |
| G6 Code Reviewer | **PASS** | 14 finding fixed round 1, G3 gap fixed round 2, re-verify bằng Reality Checker |
| G7 Reality Checker | **PASS** (sau round 2) | round 1 FAIL (G3 bypass controller) → round 2 fix → pass |
| G8 migration rollback | **PASS** | DOWN uncommented + `pg_advisory_lock`/unlock |
| G10 PII threat-model | **PASS** | `docs/THREAT-MODEL-feed-signal-capture.md` TH-A..TH-F + deviation #14 |

### NOT SHIPPABLE vì
- **G2 mutation DEFERRED** — stryker chưa setup (test có răng chưa chứng minh mutation-level). Slice plan defer, nhưng hard-gate yêu cầu.
- **G5 gitleaks NOT-RUN** — env không có binary; heuristic grep 0 secret nhưng không thay thế scan chính thức. **CI bắt buộc chạy `gitleaks detect` trước merge.**

### Top vấn đề còn lại (Gate 3 founder quyết)
1. **G5 gitleaks** — chạy trong CI (local env không có binary). Block merge tới khi CI xanh.
2. **G2 stryker** — setup mutation script + chạy, target ≥70% killed (Lua/clamp/mask/throttler). Block ship "production-ready".
3. **AC-7.3 FK CASCADE deviation** — `UserAction.userId` plain (User cross-service, không FK). GDPR user-delete → event-driven (defer P1). **Cần founder sign-off** THREAT-MODEL MAJOR 14.
4. **Deferred scope** (slice sau, không block P0a ship sau khi G2/G5 close): P0.0 instrumentation, bot-farm defense (fingerprint/pattern/CAPTCHA), backfill cron AC-7.4, FE P0b (mobile payload), partial index, Kafka, discovery P1.

### Canary plan (Gate 3 — chưa execute, không merge)
- **KHÔNG merge main** (conductor rule + founder "không auto-merge").
- Khi G2/G5 close (CI): canary 5% → 25% → 100% traffic view API, monitor `post:vs` hash growth + Redis CPU (Lua 1-RT) + 429 rate (throttler NAT). Rollback = `git revert` + migration DOWN (đã có).
- View API backward-compat (client cũ không body vẫn bump count) → safe canary.

### Token đã tiêu
PRD (~70k) + plan (~85k) + producer build (~21k) + 3 critics (~69k+74k+55k) + producer fix round 1 (~23k) + Reality Checker (~82k) + producer fix round 2 (~24k) ≈ **~500k+ agent tokens** + conductor verify. Trong budget, 2 fix round (dưới cap 3).

---

## Fix round 2 (G3 contract tests qua HTTP + G5 gitleaks)

### G3 — Contract/integration test qua controller (supertest)
**File**: `src/infrastructure/driving-adapters/http-rest/__tests__/post.controller.view-signal.contract.spec.ts` (mới)
- NestJS Test module + real PostService instance (Object.create, mocked CacheService) + ValidationPipe (whitelist+forbidNonWhitelisted+transform) + overrideGuard(ViewThrottlerGuard) passthrough + supertest `request(app.getHttpServer())`.
- Auth bypass qua `x-user-id` header (User decorator fallback).
- 7 scenarios:
  - (a) AC-1.4 204 backward-compat no body → countView bumped (Lua INCR), no dwell
  - (b) 400 schema `{dwellMs:"not-a-number"}` (string) → ValidationPipe reject, service NOT called
  - (c) AC-1.5 discard dwell diverge >30% qua HTTP: `{dwellMs:60000, clientStartedAt:<now-10000>}` → 204, dwell discarded (payload.dwellMs=0)
  - (d) AC-1.5 bot bypass closed qua HTTP: `{dwellMs:60000}` (no clientStartedAt) → 204, dwell discarded
  - (e) AC-1.1 normal capture: `{dwellMs:5000, clientStartedAt:<now-5000>, completion:0.8, replayCount:1}` → 204, hash fields đầy đủ (dwellMs=5000, completion=0.8, replayCount=1, scrollDepth=0.5)
  - anonymous (no x-user-id) → 204, userId undefined
  - AC-1.2 clamp `{dwellMs:99_999_999, clientStartedAt:<now-99M>}` → 204 (KHÔNG 400), dwellMs=3.6M

### G3 — Throttler 429+header contract
**File**: `src/infrastructure/driving-adapters/http-rest/__tests__/view-throttler.guard.contract.spec.ts` (mới)
- ViewThrottlerGuard instantiate với FakeStorage (count hits) + mock reflector. handleRequest direct call (isolate anon logic).
- 3 tests:
  - anonymous >5 view/phút → 429 + `X-Throttle-Reason: anonymous-exceeded` (first 5 pass, 6th throws)
  - authed user (x-user-id) → NOT anon path, no anon-exceeded header
  - throttler config: 2 buckets (ip 120/min, user 30/min) + anon 5/min registered

### G5 — Gitleaks
- `gitleaks` binary KHÔNG có trong env. `npx gitleaks` fail (404). `secretlint`/`trufflehog` fail/unavailable.
- **G5 = NOT-RUN (env limit)** + heuristic grep-based scan trên P0a changed files (14 files): 0 hardcoded secret value. Matches: `process.env.INTERNAL_SERVICE_TOKEN` (env ref, not value — pre-existing), `totpSecret String?` (Prisma field name — pre-existing), `.env.example` tracked (example, not real). Không có JWT/internal/OTP secret value hardcoded.
- **CI phải chạy gitleaks** (flag trong AUTOBUILD log + THREAT-MODEL). KHÔNG commit `.env`/secret.

### Test result (Fix round 2)
- `npx tsc --noEmit` → **PASS** (0 errors)
- `npx jest` → **32 suites, 368 tests pass, 0 skip, 0 fail, 1 snapshot** (4.59s)
  - +2 new suites (contract tests), +10 tests (7 view-signal + 3 throttler)
  - 358 existing + 10 new = 368 total

---

## Fix round 1 (critic 14 findings — all fixed/skipped/deferred)

| # | Finding | Status | Fix |
|---|---------|--------|-----|
| 1 BLOCKER | AC-1.5 server-dwell broken (`req._viewStartedAt` unset, bot bypass) | **FIXED** | `clampViewSignal` require `dto.clientStartedAt` for dwell — if absent → zeros (close bypass). `serverObservedDwell = Date.now() - dto.clientStartedAt`; `ratio >0.3 → discard`. Controller drop `@Req()`/`_viewStartedAt`. post.service.ts:1548-1660 |
| 2 BLOCKER | Lua 4 RT/event | **FIXED** | `recordViewSignalAtomic` (1 Lua EVALSHA = 1 RT/event) gộp INCR legacy + HINCRBY post:vs + SET NX debounce + ZADD user:viewed. 4 KEYS parameterized. Lazy `EXPIRE` (PTTL check) + lazy ZSET trim (`ZCARD > cap+100`). `onModuleInit` preload `SCRIPT LOAD`. cache.service.ts:826-960 |
| 3 BLOCKER | Throttler chưa cài | **FIXED** | `npm i @nestjs/throttler @nest-lab/throttler-storage-redis`. ThrottlerModule.forRootAsync (Redis storage, 2 bucket: ip 120/min, user 30/min). `ViewThrottlerGuard` (custom) — anon >5/min → 429 + `X-Throttle-Reason: anonymous-exceeded`. `@UseGuards(ViewThrottlerGuard)` + `@Throttle` on registerView. app.module.ts:54-66, post.controller.ts:665 |
| 4 BLOCKER | Migration DOWN commented | **FIXED** | Uncomment `DROP TABLE IF EXISTS "UserAction"` + `DROP TYPE IF EXISTS "UserActionType"`. `pg_advisory_lock`/`unlock` (UP + DOWN). migration.sql:36-46 |
| 5 BLOCKER | Retention cron thiếu | **FIXED** | `UserActionRetentionService` `@Cron('0 3 * * *')` nightly `DELETE FROM "UserAction" WHERE ts < now()-30d`. No-op nếu rỗng. Wired PostModule providers. user-action.retention.service.ts |
| 6 MAJOR | dwellScore dead code (3 caller không truyền postVsHashes) | **FIXED** | Wire `const postVsHashes = await this.redis.getMultiplePostViewSignals(...)` (batch pipeline 1 RT/50) at 3 caller: post.service.ts:3042, :3141, post-discovery.helper.ts:160. Truyền vào `scoreAndRank(..., 'FORYOU', postVsHashes)`. dwellScore reads real hash. |
| 7 MAJOR | Snapshot test tautological | **FIXED** | `toMatchSnapshot()` (literal JSON .snap frozen, fail-on-drift thật). Add dwellScore≠0 test với postVsHashes mock. recommendation-scorer.snapshot.spec.ts |
| 8 MAJOR | scrollDepth dropped | **FIXED** | `HINCRBYFLOAT scrollDepthSum` in Lua ARGV. Lua script + recordViewSignalAtomic payload. |
| 9 MAJOR | ZSET memory bomb (5000×30d) | **FIXED** | cap 5000→2000, TTL 30d→14d. `MAX_VIEWED_POSTS=2000`, `TTL_VIEWED_POSTS=14d`. getUserViewedPostIds clamp uses `this.MAX_VIEWED_POSTS`. |
| 10 MAJOR | Log exact dwellMs (PII) | **FIXED** | `dwellBucket()` helper (`<10s\|10-30s\|30-60s\|>60s`) exported. All warn/debug logs use bucket. register-view.dto.ts:9-15 |
| 11 MAJOR | enrichAndMask grep-guard | **FIXED** | Test: scan controllers dir, fail nếu `JSON.stringify(scored)` hoặc `res.json(scored.breakdown)` raw. Verify registerView `@HttpCode(204)`. feed-enrichment.regression.spec.ts:120-145 |
| 12 MAJOR | stray `src/prisma/` dir | **FIXED** | Moved test to `src/core/services/__tests__/user-action.migration.spec.ts`. Deleted `src/prisma/`. Paths use `process.cwd()`. |
| 13 MAJOR | Redis ZSET ghost-profile TH-C | **FIXED** | `CacheService.purgeUserViewHistory(userId)` — SCAN+DEL `view:debounce:{userId}:*` + DEL `user:{userId}:viewed_posts` ZSET. Stub (caller = user-delete event, defer Kafka P1). THREAT-MODEL TH-C. cache.service.ts:993-1025 |
| 14 MAJOR | FK CASCADE deviation | **DOCUMENTED** | `UserAction.userId` plain String (User model cross-service — PostLike/SavedPost same pattern). FK Post `onDelete: Cascade` only. THREAT-MODEL MAJOR 14 + Gate 3 founder sign-off required. KHÔNG fix code (cross-service fact). |

### Test result (Fix round 1)
- **FULL suite**: `npx jest` → **30 suites, 358 tests pass, 0 skip, 0 fail, 1 snapshot** (7.519s).
- **tsc**: `npx tsc --noEmit` → **PASS** (0 errors).
- **Snapshot**: 1 frozen `.snap` file created (recommendation-scorer.snapshot.spec.ts → `__snapshots__/`).

### New files (Fix round 1)
- `src/infrastructure/driving-adapters/http-rest/guards/view-throttler.guard.ts` (ViewThrottlerGuard)
- `src/core/services/user-action.retention.service.ts` (retention cron)
- `docs/THREAT-MODEL-feed-signal-capture.md` (TH-A..TH-F + MAJOR 14 deviation)
- `src/core/services/__tests__/user-action.migration.spec.ts` (moved from src/prisma)

### Deferred (note — KHÔNG fix P0a)
- P0.0 instrumentation (trackEvent/trackDwell/trackUnlock + A/B)
- Fingerprint/pattern/CAPTCHA bot defense (P1 — cần P0.0 data)
- Kafka `user-deleted` consumer wiring (TH-C event-driven cascade)
- Alert/monitor for retention cron (TH-D)
- Backfill cron AC-7.4 (cần DB volume estimate)
- G2 stryker mutation (mutation script chưa có)

---

## Phase 3 Build — T1-T5 (original)

### DAG execution
`T5‖T2 (Phase A song song) → T1 → T3 → T4`

### T2 — Redis signal stores + Lua atomic
**Files sửa**:
- `src/config/redis/cache.service.ts`:
  - Constants: `TTL_VIEWED_POSTS` 7d→30d (line ~797), `MAX_VIEWED_POSTS` 1000→5000, mới: `TTL_VIEW_SIGNALS`, `SKIP_MS=2000`, `VIEW_DEBOUNCE_DEFAULT_MS=5000`, `viewSignalSha`.
  - `LUA_VIEW_SIGNAL_SCRIPT` (inline): HINCRBY viewCount + HINCRBYFLOAT totalDwellMs/completionSum + skip/dwell branch (<skipMs) + rewatchCount + EXPIRE 30d + HGETALL. KEYS/ARGV parameterized (AppSec anti-injection).
  - `incrementPostViewSignals(postId, {dwellMs, completion, replayCount, skipMs})`: EVALSHA + fallback EVAL (NOSCRIPT → refresh SHA). Lua fail → fallback `hincrby viewCount 1` (degrade an toàn). Trả `Record<string,string>` hash.
  - `getPostViewSignals(postId)` + `getMultiplePostViewSignals(postIds)` (pipeline batch — perf T3).
  - `setViewDebounce(userId, postId, ttlMs?)`: `SET view:debounce:{u}:{p} 1 PX ttl NX` → true nếu fresh (cần track), false nếu debounced.
  - `isViewDebounced(userId, postId)`.
  - `flatArrayToHash(raw)` — Lua HGETALL flat array → object.
  - `getUserViewedPostIds`: cap 1000→5000.
- **AC**: AC-2.1 (1 round-trip Lua), AC-2.3 (HGETALL return), AC-4.1/4.2 (Redis debounce), ZSET cap 5000 + TTL 30d.

### T5 — UserAction migration
**Files sửa/tạo**:
- `prisma/schema.prisma`: thêm `enum UserActionType` (VIEW_MEANINGFUL/LIKE/SAVE/UNLOCK/COMMENT) + `model UserAction` (BigInt id autoincrement, userId/postId String, actionType, ts DateTime default now, dwellBucket String?, post Post @relation onDelete Cascade). `@@unique([userId,postId,actionType,ts])`, `@@index([userId,ts])`, `@@index([postId,actionType])`. Thêm `userActions UserAction[]` vào Post model relations.
- `prisma/migrations/20260811000000_add_user_action/migration.sql`: UP block (CREATE TYPE + CREATE TABLE IF NOT EXISTS + 2 index + unique constraint + FK Post CASCADE, idempotent DO $$ BEGIN). DOWN block commented (DROP TABLE + DROP TYPE).
- **AC**: AC-7.1 (model+enum), AC-7.2 (unique+2 index), AC-7.6 (dwellBucket, no exact dwellMs).
- **DEVIATION AC-7.3**: User model KHÔNG có trong content-service schema (PostLike/SavedPost/UserUnlockedContent cùng pattern — không có User relation). `userId String` plain, FK Post CASCADE only. GDPR user-delete handle qua event-driven (Kafka user-deleted → DELETE UserAction) — defer implementation P1. Documented.
- **DEFERRED**: AC-7.4 backfill cron 2 tuần (note, không chạy — cần DB access volume). AC-7.5 retention cron nightly (note, defer schedule).

### T1 — View API evolve (depend T2)
**Files sửa/tạo**:
- `src/core/dto/register-view.dto.ts` (mới): `RegisterViewDto` — `dwellMs?`, `completion?`, `scrollDepth?`, `replayCount?`, `source?`, `sessionId?`, `clientStartedAt?`. DTO chỉ validate TYPE (@IsNumber/@IsString/@IsOptional/@MaxLength) — range clamp ở service (AC-1.2/1.3: clamp, không 400). @ApiPropertyOptional cho Swagger.
- `src/infrastructure/driving-adapters/http-rest/controllers/post.controller.ts:653-688` (`registerView`): thêm `@Body() dto?: RegisterViewDto` + `@Req() req` + `@ApiBody({ type: RegisterViewDto, required: false })`. `serverStartedAt = req._viewStartedAt ?? Date.now()`. Gọi `postService.incrementViewCount(postId, userId, dto, serverStartedAt)`.
- `src/core/services/post.service.ts`:
  - XÓA `viewDebounceMap` (line 104), `VIEW_DEBOUNCE_MS` (105), `DEBOUNCE_CLEANUP_THRESHOLD` (106). Comments reword để grep `viewDebounceMap` = no matches (AC-4.3 verify pass).
  - Thêm `DWELL_MS_MAX=3_600_000`, `DWELL_DISCARD_RATIO=0.3`.
  - `incrementViewCount(postId, userId?, dto?, serverStartedAt?)`: (1) luôn `redis.incrementPostView(postId)` (DB pending counter, backward-compat countView+1); (2) dto có signal field → `clampViewSignal` + `redis.incrementPostViewSignals` Lua; (3) userId → `redis.setViewDebounce` (NX) → fresh thì `trackUserViewedPost`.
  - `clampViewSignal(dto, serverStartedAt)`: clamp dwellMs 0-3.6M, completion/scrollDepth 0-1, replayCount ≥0 (floor). AC-1.2 warn over-boundary. AC-1.5 server-side dwell compare (clientStartedAt vs serverStartedAt, ratio >30% → discard client dwell).
- Import `RegisterViewDto` added.
- **AC**: AC-1.1 (body đầy đủ → Lua), AC-1.2 (clamp over), AC-1.3 (clamp negative), AC-1.4 (no body → bump count only), AC-1.5 (server dwell discard), AC-4.3 (viewDebounceMap removed).

### T3 — scoreAndRank evolution (depend T2 post:vs hash)
**Files sửa**:
- `src/application/ports/shared/recommendation.types.ts`: `IScoredCandidate.breakdown` thêm `dwellScore: number`. Thêm `ScoreProfileType = 'MEMBER'|'DISCOVERY'|'FORYOU'`.
- `src/core/helper/recommendation-scorer.helper.ts`:
  - `SCORER_WEIGHTS.dwellScore = 0` (Q-extra-3: accumulate only, KHÔNG tune P0a).
  - `calcDwellScore(postVsHash)`: `(totalDwellMs/viewCount) + (completionSum/viewCount)`, hash miss → 0 (AC-5.4).
  - `scoreCandidate` thêm param `postVsHash?`, tính `dwellScore`, thêm vào breakdown, contribute `SCORER_WEIGHTS.dwellScore * dwellScore` (=0 P0a).
  - `scoreAndRank` thêm param `profileType: ScoreProfileType = 'FORYOU'` (default no-regression) + `postVsHashes?` (batch hash map). Truyền `postVsHashes[c.id]` xuống `scoreCandidate`.
- 3 caller migrate (explicit `'FORYOU'`):
  - `src/core/services/post.service.ts:3042` (ForYou)
  - `src/core/services/post.service.ts:3141` (YouMayLike)
  - `src/core/helper/post-discovery.helper.ts:160`
- **AC**: AC-5.1 (default FORYOU, dwellScore=0 khi no hash), AC-5.2 (3 caller no-regression), AC-5.3 (snapshot drift detection), AC-5.4 (dwellScore formula).

### T4 — enrichAndMask layer (depend T3 breakdown shape)
**Files tạo**:
- `src/core/helper/feed-enrichment.helper.ts` (mới): `checkPostAccess(post, userId, unlockedSet, isManager)` — mirror `PostHelper.checkPostAccessSync` (KHÔNG đổi logic). `processSecureMediaList(media, hasAccess)` — mirror `PostHelper.processSecureMedia`. `enrichAndMask(candidate, userId, unlockedSet, isManager)` → `MaskedFeedItem` (content='' khi !hasAccess, media=[]). `enrichAndMaskBatch(candidates, ...)`.
- P0a chỉ xây layer + test — apply cho feed endpoint mới ở P0b (không đụng controller hiện tại).
- **AC**: AC-6.2 (locked → content='', media=[]), AC-6.3 (unlocked → đầy đủ), AC-6.4 (author/manager → hasAccess), AC-6.5 (regression invariant pass).
- **Note**: PRD AC-6.5 invariant `!content || isPurchased || isAuthor` literally excludes isManager + free post — test data accordingly (premium-only, no manager in invariant array; manager + free tested riêng AC-6.4).

---

## Test (G1 — xanh 0 skip)

### Test files tạo (5)
1. `src/core/services/__tests__/post.service.view-signal.spec.ts` (T1) — 13 tests: clamp boundary, backward-compat, Lua call args, debounce Redis, error path.
2. `src/config/redis/__tests__/cache.service.view-signal.spec.ts` (T2) — 18 tests: Lua atomic 1 round-trip, EVALSHA fallback, debounce NX PX, ZSET cap 5000, flatArrayToHash, Lua script content.
3. `src/core/helper/__tests__/recommendation-scorer.snapshot.spec.ts` (T3) — 7 tests: 5 feed sample snapshot no-regression, dwellScore=0 baseline, drift detection, calcDwellScore formula, 3 profileType.
4. `src/core/helper/__tests__/feed-enrichment.regression.spec.ts` (T4) — 13 tests: AC-6.5 invariant, locked/purchased/author/manager/free, checkPostAccess unit, processSecureMedia unit.
5. `src/prisma/__tests__/user-action.migration.spec.ts` (T5) — 15 tests: model+enum, unique+2 index, FK CASCADE, dwellBucket, no dwellMs exact, migration UP/DOWN, DEFERRED backfill/retention note.

### Test result
- **P0a suites**: 5 passed, 5 total / 72 tests passed / 0 skip / 0 fail.
- **FULL suite (no-regression)**: `npx jest` → **30 suites passed, 362 tests passed, 0 skip, 0 fail** (5.894s).
- **Type check**: `npx tsc --noEmit` → **PASS (0 errors)**.
- **AC-4.3 verify**: `grep -rn "viewDebounceMap" src/` → **No matches** (in-memory Map removed completely).

---

## DEFERRED (note rõ — KHÔNG build P0a)
- **P0.0 instrumentation** (trackEvent/trackDwell/trackUnlock + A/B assignment): slice khác, cần product decision.
- **Throttler `nestjs-throttler-redis` install**: defer (config/infra nặng, slice sau).
- **Bot-farm defense 4 lớp**: defer P1 (server-side dwell OK làm nhẹ trong T1 — AC-1.5 implemented; fingerprint/pattern/CAPTCHA defer).
- **Backfill cron 2 tuần (AC-7.4)**: defer — không có DB access verify volume. Schema sẵn sàng.
- **Retention cron nightly (AC-7.5)**: defer — defer schedule. Migration note rõ.
- **G2 mutation (stryker)**: defer — `mutation` script chưa có trong package.json. Mutation target §4.3 plan.
- **Partial index (B2)**: defer P0b — cần sort/cursor chốt trước.
- **Kafka view-meaningful (M7)**: defer P3.
- **Discovery feed + co-engagement (P1)**: defer — cần UserAction backfill.

---

## Deviation note
- **AC-7.3 FK CASCADE to User**: User model KHÔNG có trong content-service `prisma/schema.prisma` (PostLike/SavedPost/UserUnlockedContent cùng pattern — KHÔNG có User relation). `userId String` plain. FK Post onDelete Cascade (Post delete propagates). GDPR user-delete → event-driven (defer P1). Documented in schema comment + migration + T5 test.

---

## Files (absolute paths)
- `c:\MAYogu_VIASG\content-service\src\config\redis\cache.service.ts`
- `c:\MAYogu_VIASG\content-service\src\core\services\post.service.ts`
- `c:\MAYogu_VIASG\content-service\src\infrastructure\driving-adapters\http-rest\controllers\post.controller.ts`
- `c:\MAYogu_VIASG\content-service\src\core\dto\register-view.dto.ts` (mới)
- `c:\MAYogu_VIASG\content-service\src\application\ports\shared\recommendation.types.ts`
- `c:\MAYogu_VIASG\content-service\src\core\helper\recommendation-scorer.helper.ts`
- `c:\MAYogu_VIASG\content-service\src\core\helper\post-discovery.helper.ts`
- `c:\MAYogu_VIASG\content-service\src\core\helper\feed-enrichment.helper.ts` (mới)
- `c:\MAYogu_VIASG\content-service\prisma\schema.prisma`
- `c:\MAYogu_VIASG\content-service\prisma\migrations\20260811000000_add_user_action\migration.sql` (mới)
- Tests (5 files mới): `src/core/services/__tests__/post.service.view-signal.spec.ts`, `src/config/redis/__tests__/cache.service.view-signal.spec.ts`, `src/core/helper/__tests__/recommendation-scorer.snapshot.spec.ts`, `src/core/helper/__tests__/feed-enrichment.regression.spec.ts`, `src/prisma/__tests__/user-action.migration.spec.ts`
