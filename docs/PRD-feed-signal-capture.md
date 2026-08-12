# PRD: Feed Signal Capture — Slice P0.0 + P0a (Server-only foundation)

**Status**: Draft (Cổng 1 — chờ founder duyệt)
**Author**: Alex (PM)  **Last Updated**: 2026-08-11  **Version**: 0.1
**Stakeholders**: Founder (decision maker), content-service dev, Eng Lead, Security/SecOps, Reality Checker
**Plan nguồn**: `docs/PLAN-feed-ranking-rollout.md` v0.2 §7 (P0.0 + P0a)  **R1**: `docs/review-rounds/critique-feed-ranking-r1.md`

---

## 0. Tóm tắt (1 đoạn, press-release)

> Slice đầu tiên của rollout feed-ranking xây **nền server-side** để mọi phase sau có tín hiệu thật để rank: (1) bộ đo lường baseline `trackEvent`/`trackDwell`/`trackUnlock` + CTR port + service A/B assignment (P0.0 — chặn B5 "metric % vô nghĩa vì baseline = 0"); (2) nâng cấp `POST /post/:id/view` thành điểm bắt signal giàu (dwell/completion/skip/rewatch) với integrity floor thật (throttler Redis 3 bucket, Lua atomic 1 round-trip, debounce Redis thay in-memory Map, clamp client input, bot-farm defense) và lưu vào Redis `post:vs` hash + `user:viewed` ZSET cap 5000; (3) mở `scoreAndRank` thêm `dwellScore` + `profileType` mặc định `'FORYOU'` (không hồi quy, 3 caller migrate + snapshot test); (4) lớp `enrichAndMask` chặn leak premium (B1); (5) tạo bảng `UserAction` thống nhất + backfill cron 2 tuần (B6 — blocker cho P1 co-engagement). Client cũ vẫn bump countView như trước (backward-compat) — FE payload + member feed endpoint + partial index ở P0b. **Không build ML, không Kafka, không co-engagement, không discovery endpoint** — tất cả ở P1/P3.

---

## 1. Mục tiêu (liên kết plan §1.2, đo được ngay, không % baseline)

4 metric raw (baseline = 0 trước P0.0, không "+30%" vô nghĩa — B5 fix):

| Metric | Hiện tại | Target sau P0a (server-only) | Ghi chú |
|---|---|---|---|
| Discovery CTR raw (unlock / discover impression) | 0 (chưa track) | Có baseline số nguyên | Cần `trackUnlock` + impression counter — P0.0 infra |
| % post-view event có `dwellMs > 0` hợp lệ | 0 (view API không nhận dwell) | Lấy được baseline số (client cũ = 0%; sau P0b FE rollout sẽ tăng) | Target >85% dời sang P1 (M8) |
| % feed request < 200ms P99 | Chưa đo | Đo được (feed endpoint cũ chưa refactor) | P99 cải thiện thật ở P0b (keyset + partial index) |
| % view event có dwell signal hợp lệ (clamp pass) | 0 | >85% các view có dwell payload (sau P0b) | P0a chỉ đo server-side, không ép FE |

> Lưu ý thực tế (M8): "85% view có dwell" không đạt cho đến P0b rollout mobile (4-8 tuần). P0a chỉ đảm bảo **đo được** và **server lưu đúng** — không đặt target cuối cho metric phụ thuộc FE.

---

## 2. Scope IN / OUT (dẫn plan §7)

### IN (slice này)

**P0.0 — Instrumentation baseline (1–2 tuần, chặn B5):**
- `trackEvent`/`trackDwell`/`trackUnlock` + CTR port trong `analytics.service.port.ts` (hiện CHỈ `getOverviewMetrics`/`getTopPosts`/`getChartMetrics` — verified).
- A/B assignment service + rollback sạch + metric join (KHÔNG `user_id % 100` ad-hoc).
- Baseline đo 4 metric §1 raw.

**P0a — Server-only signal capture (3–4 tuần, client cũ backward-compat):**
- View API evolve payload (§5.1 plan): `dwellMs` 0–3.6M, `completion?` 0–1, `scrollDepth?` 0–1, `replayCount?` ≥ 0, `source?`, `sessionId?` + clamp/validate.
- Redis `post:vs:{postId}` hash (viewCount/totalDwellMs/completionSum/skipCount/dwellCount/rewatchCount) + Lua atomic 1 round-trip (M4 — 5-7 HINCRBY gộp 1).
- `user:viewed:{userId}` ZSET cap **5000** (hiện 1000, `cache.service.ts:798`), TTL 30 ngày (hiện 7 ngày, `:797`), lazy cleanup.
- `view:debounce:{userId}:{postId}` Redis TTL (thay `viewDebounceMap` in-memory Map + `.clear()` mass-loss ở `post.service.ts:102,1561`).
- `nestjs-throttler-redis` 3 bucket (M3): per-IP 120/phút, per-user 30/phút, per-(IP+user) 60/phút. Anonymous >5 view/phút → require OTP/fingerprint.
- Bot-farm defense (M1): (a) server-side dwell đo bằng timestamp request bắt đầu → view gửi về, chênh client >30% → discard; (b) fingerprint `hash(userAgent+IP/24+lang+screen)` gom bucket; (c) pattern detection N user gửi dwell đúng `MEANINGFUL_DWELL_MS ±100ms`; (d) CAPTCHA threshold cho user <7 ngày.
- `scoreAndRank` thêm `dwellScore` (từ `post:vs:{postId}` avg dwell + completion) + `profileType: 'MEMBER'|'DISCOVERY'|'FORYOU'` (default `'FORYOU'` no-regression) — migrate 3 caller (M2: ForYou `post.service.ts:3039`, YouMayLike `:3138`, `post-discovery.helper.ts:160`) + snapshot test 5 feed sample fixed seed.
- `enrichAndMask(candidate, userId, unlockedSet, isManager)` layer (B1): gọi `checkPostAccessSync` (`post.helper.ts:206`) + `processSecureMedia` (`:198`), rỗng hoá `content` khi `!hasAccess`. Cấm serialize `IScoredCandidate` thô ra HTTP.
- `UserAction` table migration + `UserActionType` enum (VIEW_MEANINGFUL/LIKE/SAVE/UNLOCK/COMMENT) + backfill cron 2 tuần từ `PostLike`/`SavedPost`/`UserUnlockedContent`/`Comment` (B6 — blocker cho P1 co-engagement + Kafka dedupe).
- Privacy (M6): `userId` FK User `onDelete: Cascade` (GDPR), retention cron nightly `DELETE WHERE ts < now()-30d`, dwell bucket `<10s|10-30s|30-60s|>60s` KHÔNG log exact `dwellMs`, pseudonymous userId trong mọi payload.

### OUT (slice khác — KHÔNG scope)

- **P0b**: FE payload chat-app + mobile-app (mobile release cycle 4-8 tuần), member feed endpoint `GET /post/member-feed`, sort/cursor `(score, id)` + cache key `:v{VERSION}`, partial index migration §6.1 (cần sort/cursor chốt trước + index change risk), bỏ `total`/`totalPages`.
- **P1**: discovery feed `GET /post/discover`, co-engagement precompute nightly (B3 fix), `coengagementScore`, `popularityDecay`, nightly persist `post:vs` → DB view table.
- **P2**: graduated `viewedPenalty` (skip/short/long/completed), watch-time log-scale popularity, cron tách `processPostList` fire-and-forget.
- **P3**: Kafka `view-meaningful` producer + consumer → `user:profile` Hash (M7 batch+idempotency+DLQ+lag), multi-outcome sub-scores (willComment/willUnlock/willLike/willShare).
- **Partial index migration §6.1** (B2): defer sang P0b — cần sort/cursor chốt trước + index change risk riêng.
- **Kafka** (M10 cut): `buildUserProfile` rebuild DB + TTL cache đủ cho P0/P1/P2; Kafka chỉ value khi profile stale >5ph.

---

## 3. User stories

### US-1 — Client gửi dwell qua view API (server capture, không tin blind)
> As một client (chat-app/mobile-app/legacy), tôi muốn gửi `dwellMs`/`completion`/`replayCount` qua `POST /post/:id/view` để server có signal rank, và server phải tự validate/clamp để signal rác không vào store.

- Client cũ (không gửi body) → vẫn bump `countView` như trước (backward-compat, không break).
- Client mới gửi body → server validate boundary + clamp trước khi ghi Redis.
- Server đo dwell 2 lần: client-reported + server-side timestamp (request bắt đầu → view gửi về) — chênh >30% → discard client dwell (chỉ giữ count).

### US-2 — Integrity floor chặn bot farm có account hợp lệ
> As một admin hệ thống, tôi muốn throttler + debounce + fingerprint + pattern detection chặn 1000 account bot gửi `dwellMs=60000` để moi premium payout, không chặn nhầm user NAT.

- Throttler 3 bucket Redis (multi-instance safe): per-IP loose 120/phút, per-user strict 30/phút, per-(IP+user) 60/phút.
- Debounce Redis TTL thay in-memory Map (sống đa instance, không `.clear()` mass-loss).
- Fingerprint gom bucket throttler (cùng fingerprint = cùng bucket, chặn 1 IP rotating user).
- Pattern: N user gửi dwell đúng `MEANINGFUL_DWELL_MS ±100ms` → flag + log.
- Anonymous >5 view/phút → require OTP/fingerprint (KHÔNG per-user signal cho anon).

### US-3 — `scoreAndRank` thêm dwellScore không break ForYou/YouMayLike hiện tại
> As một engineer content-service, tôi muốn thêm `dwellScore` + `profileType` vào `scoreAndRank` mà 3 caller hiện tại không hồi quy, để P1 có thể tune weight theo profile.

- Default `profileType='FORYOU'` (no-regression) — breakdown `dwellScore=0` khi chưa có data Redis (P0a mới bắt đầu accumulate).
- Snapshot test 5 feed sample (fixed seed) chặn drift: so sánh thứ tự + score trước/sau khi thêm param.
- 3 caller migrate liệt kê rõ: ForYou, YouMayLike, post-discovery.helper.

### US-4 — `enrichAndMask` chặn premium leak qua feed path mới
> As một user chưa unlock premium, tôi muốn khi feed ranking trả kết quả, post premium có `content` rỗng và media che, để không bị leak nội dung trả phí qua feed path mới.

- Mọi item từ `scoreAndRank` đi qua `enrichAndMask(candidate, userId, unlockedSet, isManager)`.
- `content` rỗng hoá khi `!hasAccess` (gọi `checkPostAccessSync`).
- `media` qua `processSecureMedia` (trả mảng rỗng nếu !hasAccess).
- Cấm serialize `IScoredCandidate` thô ra HTTP (pattern đúng: `search` ở `post.service.ts:1172`).
- Regression test: `items.every(i => !i.content || i.isPurchased || i.isAuthor)`.

### US-5 — `UserAction` table thống nhất + backfill cron
> As một engineer xây P1 co-engagement, tôi muốn có 1 bảng `UserAction` thống nhất thay vì union 4 bảng (`PostLike`/`SavedPost`/`UserUnlockedContent`/`Comment`), để self-join P1 không chậm 5-10×.

- Migration tạo `UserAction` + `UserActionType` enum (5 giá trị: VIEW_MEANINGFUL/LIKE/SAVE/UNLOCK/COMMENT).
- `@@unique([userId, postId, actionType, ts])` cho idempotency Kafka consumer (P3).
- `@@index([userId, ts])` cho co-engagement lookup + `@@index([postId, actionType])` cho precompute nightly.
- Backfill cron 2 tuần từ 4 bảng cũ → `UserAction`.
- Privacy: `userId` FK User `onDelete: Cascade`, retention cron nightly `DELETE WHERE ts < now()-30d`, dwell bucket không log exact.

---

## 4. ĐÃ CÓ / CẦN THÊM (grounded code thật — R1 §3 verify 8/8 đúng)

| Component | Hiện trạng code | Cần build (slice này) | Dẫn file:dòng |
|---|---|---|---|
| Analytics port | 3 method chỉ đọc: `getOverviewMetrics`/`getTopPosts`/`getChartMetrics`. KHÔNG track event. | `trackEvent`/`trackDwell`/`trackUnlock` + CTR port + A/B assignment service | `content-service/src/application/ports/inbound/analytics.service.port.ts:1-12` |
| View API controller | `POST /post/:id/view` return 204, `userId?` optional, KHÔNG nhận body | Thêm body optional `dwellMs`/`completion`/`scrollDepth`/`replayCount`/`source`/`sessionId` + clamp | `content-service/src/infrastructure/driving-adapters/http-rest/controllers/post.controller.ts:624-643` |
| `incrementViewCount` service | `redis.incrementPostView(postId)` 1 lệnh INCR + debounce in-memory Map + `trackUserViewedPost` boolean. KHÔNG dwell. | Evolve: validate+clamp → throttler → Lua atomic (5-7 HINCRBY gộp) → Redis debounce → per-user ZSET graduated | `content-service/src/core/services/post.service.ts:1542-1575` |
| `viewDebounceMap` | In-memory `Map<string,number>`, `.clear()` khi size > 10000 → mất state đa instance | Thay bằng `view:debounce:{userId}:{postId}` Redis TTL | `content-service/src/core/services/post.service.ts:102-104, 1560-1562` |
| `incrementPostView` Redis | 1 lệnh `redis.incr(key)` — Redis single-thread bottleneck viral 10k view/s × 7 = 70k cmd/s ≈ limit | Lua script atomic gộp 5-7 lệnh thành 1 round-trip (M4) | `content-service/src/config/redis/cache.service.ts:615-622` |
| `trackUserViewedPost` | ZSET cap **1000**, TTL **7 ngày** | Raise cap **5000**, TTL **30 ngày**, lazy cleanup, lưu dwell hash riêng | `content-service/src/config/redis/cache.service.ts:797-829` (`TTL_VIEWED_POSTS = 60*60*24*7`, `MAX_VIEWED_POSTS = 1000`) |
| `getUserViewedPostIds` | Default limit 500, cứng 1000 | Hỗ trợ limit 5000 (P0a chỉ cần cho `scoreAndRank` đọc viewedSet) | `content-service/src/config/redis/cache.service.ts:831-849` |
| Throttler | `@nestjs/throttler` KHÔNG có trong `package.json` (grep = no matches) → default in-memory storage, 4 instance × 60 = 240/phút/IP | `nestjs-throttler-redis` (Redis storage) 3 bucket + fingerprint + pattern + CAPTCHA threshold | `content-service/package.json` (verify no `@nestjs/throttler`) |
| `scoreAndRank` | Signature `(candidates, profile, viewedPostIds, now)` — KHÔNG `profileType`. Sort `b.candidate.id.localeCompare(a.candidate.id)` = id DESC. Breakdown 7 signal: hashtag/author/engagement/community/recency/viewedPenalty/ratingBonus. KHÔNG dwellScore/coengagementScore/popularityDecay. | Thêm param `profileType: 'MEMBER'|'DISCOVERY'|'FORYOU'` default `'FORYOU'`; thêm `dwellScore` vào breakdown (từ `post:vs` avg dwell); snapshot test 5 feed; migrate 3 caller | `content-service/src/core/helper/recommendation-scorer.helper.ts:9-15` (weights), `:22-28` (engagement formula), `:30-44` (calcEngagementRaw dùng `c.view?.countView` raw), `:70-146` (scoreCandidate), `:149-169` (scoreAndRank), `:185-216` (cursor `(score, postId)`) |
| `ENGAGEMENT_FORMULA` | `likes*1 + comments*2 + views*0.05 + soldCount*5 + totalReviews*3` (dùng `c.view?.countView` raw) | Giữ nguyên P0a (multi-outcome cut P3 — M10); `dwellScore` là signal riêng, không pha vào engagement aggregate | `content-service/src/core/helper/recommendation-scorer.helper.ts:22-44` |
| `buildUserProfile` | `MIN_SIGNALS=3`, `hasEnoughSignals` flag, profile cache TTL 60ph, đọc `profile:foryou:v1:{userId}`. Signals: topHashtagIds/topAuthorIds/topCommunityIds/blockedUserIds/hiddenPostIds/unlockedPostIds/accessibleCommunityIds. | KHÔNG đổi P0a (Kafka refresh cut P3 — M10); DB rebuild + TTL đủ | `content-service/src/core/helper/for-you-feed.helper.ts:42` (`MIN_SIGNALS=3`), `:53-93` (buildUserProfile), `:84` (hasEnoughSignals) |
| `checkPostAccessSync` | Trả `true` khi author/isManager/!isPremium/premiumStatus !== APPROVED/unlockedSet.has | Reuse cho `enrichAndMask` — KHÔNG đổi logic | `content-service/src/core/helper/post.helper.ts:206-218` |
| `processSecureMedia` | Trả `[]` khi `!hasAccess`, trả `mediaList` khi `hasAccess` | Reuse cho `enrichAndMask` — KHÔNG đổi logic | `content-service/src/core/helper/post.helper.ts:198-204` |
| `search` pattern mask | `content: hasAccess ? item.content : ''` (pattern đúng đã có) | Reuse làm template cho `enrichAndMask` | `content-service/src/core/services/post.service.ts:1172` (pattern) |
| `Post` schema | `isPublic Boolean @default(false)`, index `[communityId, publishedAt(sort:Desc)]` + `[isPublic, publishedAt(sort:Desc)]` — KHÔNG partial index `where`, KHÔNG `id` tiebreaker | KHÔNG scope P0a (partial index defer P0b) | `content-service/prisma/schema.prisma:46-86` (Post), `:62` (isPublic), `:84-85` (index) |
| `View` schema | Chỉ `id, countView, postId` — KHÔNG `totalDwellMs`/`avgCompletion`/`skipCount` | KHÔNG scope P0a (DB view table mở rộng là P1 nightly persist) | `content-service/prisma/schema.prisma:267-273` |
| `UserAction` schema | KHÔNG tồn tại (grep = no matches). Chỉ có `PostLike` (:689), `SavedPost` (:700), `UserUnlockedContent` (:244), `Comment`, `View` (:267) | Migration tạo `UserAction` model + `UserActionType` enum + backfill cron 2 tuần | `content-service/prisma/schema.prisma:244-265` (UserUnlockedContent), `:267-273` (View), `:689-698` (PostLike), `:700-709` (SavedPost) |
| Prisma version | `^6.17.1` (hỗ trợ partial index `where` — verify OK cho P0b, KHONG dùng P0a) | KHÔNG cần upgrade | `content-service/package.json:37, 84` |

---

## 5. Acceptance criteria (đo được, test được)

### AC-1 — View API nhận dwell + clamp
- AC-1.1: `POST /post/:id/view` body `{"dwellMs": 12000, "completion": 0.8, "replayCount": 2, "source": "feed"}` → 204, Redis `post:vs:{postId}` hash có `viewCount+1`, `totalDwellMs+12000`, `completionSum+0.8`, `dwellCount+1`, `rewatchCount+2`.
- AC-1.2: Body `{"dwellMs": 99999999}` (over 3.6M) → clamp về 3.6M + log warn. KHÔNG reject (giữ backward-compat 204).
- AC-1.3: Body `{"dwellMs": -5, "completion": 1.5}` → clamp về 0 / 1.0.
- AC-1.4: Body rỗng hoặc thiếu `dwellMs` (client cũ) → vẫn bump `countView+1`, KHÔNG ghi dwell (backward-compat).
- AC-1.5: Server-side dwell (timestamp request bắt đầu → view gửi về) chênh client-reported >30% → discard client dwell, vẫn bump count.

### AC-2 — Lua atomic 1 round-trip (M4)
- AC-2.1: 1 view event = 1 Redis round-trip (Lua script) thay 5-7 HINCRBY rời. Verify bằng Redis `MONITOR` log trong test.
- AC-2.2: Viral test 10k view/s trên 1 post → Redis CPU < 70% (so với 5-7× load cũ ≈ starve post khác).
- AC-2.3: Lua script trả `HGETALL post:vs:{postId}` để service log/return mà không cần thêm lệnh.

### AC-3 — Throttler Redis 3 bucket (M3)
- AC-3.1: `@nestjs/throttler` + `nestjs-throttler-redis` cài trong `package.json` (verify grep có matches).
- AC-3.2: 4 instance content-service → cùng 1 IP giới hạn 120/phút tổng (không 240/phút).
- AC-3.3: Per-user 30/phút → user gửi 31 view trong 1 phút → 429 trên cái thứ 31.
- AC-3.4: Anonymous >5 view/phút → 429 + response header `X-Throttle-Reason: anonymous-exceeded` (FE P0b sẽ xử lý prompt OTP).

### AC-4 — Debounce Redis thay in-memory Map
- AC-4.1: Cùng user view cùng post 2 lần trong 5s → chỉ track per-user 1 lần (ZSET), vẫn bump countView 2 lần.
- AC-4.2: Restart content-service → debounce state không mất (Redis TTL, không in-memory).
- AC-4.3: `viewDebounceMap` in-memory Map XÓA khỏi code (grep `viewDebounceMap` = no matches sau migrate).

### AC-5 — `scoreAndRank` profileType default no-regression + snapshot test (M2)
- AC-5.1: `scoreAndRank(candidates, profile, viewedSet, now)` (signature cũ) → default `profileType='FORYOU'`, breakdown có `dwellScore: 0` (chưa có data Redis trong test).
- AC-5.2: 3 caller (ForYou `post.service.ts:3039`, YouMayLike `:3138`, `post-discovery.helper.ts:160`) migrate sang signature mới, output không đổi (so sánh snapshot 5 feed sample fixed seed).
- AC-5.3: Snapshot test chặn drift: đổi weight → test fail (phải bump VERSION + cập nhật snapshot có chủ đích).
- AC-5.4: `dwellScore` đọc từ `post:vs:{postId}` hash: `(totalDwellMs / viewCount)` + `(completionSum / viewCount)`. Hash miss → `dwellScore=0`.

### AC-6 — `enrichAndMask` chặn premium leak (B1)
- AC-6.1: Mọi item đi qua `scoreAndRank` ra HTTP phải qua `enrichAndMask` — grep HTTP response trong controller feed mới không có `IScoredCandidate` thô (sẽ áp dụng P0b; P0a chỉ xây layer + test).
- AC-6.2: Post premium chưa unlock → `content: ''`, `media: []` (qua `processSecureMedia`).
- AC-6.3: Post premium đã unlock (`unlockedSet.has(post.id)`) → `content` đầy đủ, `media` đầy đủ.
- AC-6.4: Author post hoặc manager → `hasAccess=true`.
- AC-6.5: Regression test: `items.every(i => !i.content || i.isPurchased || i.isAuthor)` pass 100%.

### AC-7 — `UserAction` migration + backfill cron (B6)
- AC-7.1: `UserAction` model + `UserActionType` enum có trong `schema.prisma` sau migration.
- AC-7.2: `@@unique([userId, postId, actionType, ts])` (Kafka idempotency P3) + `@@index([userId, ts])` + `@@index([postId, actionType])`.
- AC-7.3: `userId` FK User `onDelete: Cascade` (GDPR right-to-be-forgotten).
- AC-7.4: Backfill cron chạy 2 tuần → `UserAction` có rows từ `PostLike` (actionType LIKE), `SavedPost` (SAVE), `UserUnlockedContent` (UNLOCK), `Comment` (COMMENT). VIEW_MEANINGFUL chỉ bắt đầu track từ P0a (backfill không có).
- AC-7.5: Retention cron nightly `DELETE FROM user_action WHERE ts < now() - interval '30 days'` chạy thành công + có metric đếm rows xóa.
- AC-7.6: `dwellBucket` (`<10s|10-30s|30-60s|>60s`) lưu thay `dwellMs` exact (PII). KHÔNG log `dwellMs` exact vào DB.

### AC-8 — P0.0 instrumentation baseline
- AC-8.1: `trackEvent(eventName, props)` port có trong `analytics.service.port.ts` + implementation.
- AC-8.2: `trackDwell(userId, postId, dwellMs, completion)` port + implementation (gọi từ view API sau Lua atomic).
- AC-8.3: `trackUnlock(userId, postId)` port + implementation.
- AC-8.4: CTR port = `impression` counter + `unlock` counter → ratio raw (không % baseline).
- AC-8.5: A/B assignment service: `assignBucket(userId, experimentId) → 'control'|'treatment'` deterministic + rollback sạch (Redis hash, không `user_id % 100`).
- AC-8.6: 4 metric §1 đo được ngay sau P0.0 (số nguyên raw, không %).

---

## 6. Hard-gate checklist (từ `docs/ASSURANCE-prod-refactor.md` G1–G10)

Trước khi đánh dấu P0a "shipped", mọi gate phải PASS trên evidence live (không tin từ doc):

- [ ] **G1 Tests**: `npm run test` exit 0, 0 skip strict (skip-by-design local OK nếu CI closes — verify pattern skip-if-no-DB). Coverage ≥ 70% stmts/branch/funcs.
- [ ] **G2 Mutation**: `npm run loadtest:mutation` (hoặc tương đương content-service) ≥ 70% killed. Survivors = trivial log strings, không live mutant ở code throttler/Lua/clamp/mask.
- [ ] **G3 Contract**: contract test cho view API mới (body schema, clamp behavior, 204 backward-compat) + throttler 429 envelope.
- [ ] **G4 Type/Lint/Build**: `npm run typecheck` + `npm run build` exit 0. 0 lint error (warning OK nếu pre-existing).
- [ ] **G5 SAST + secret-scan**: gitleaks cài + chạy (`gitleaks detect` — hiện tại dormancy, must install per ASSURANCE gap #1). Git history sạch (no `.env`, no `JWT_INTERNAL_SECRET` value, no `OTP_SECRET` value). Lua script, throttler config, A/B assignment — scan tất cả.
- [ ] **G6 Code Reviewer**: 0 Critical/Major/High surviving ở review P0a. Đặc biệt: Lua script atomic, `enrichAndMask` access control, throttler config, `UserAction` cascade.
- [ ] **G7 Reality Checker**: Verify claim "3 caller migrate no-regression" bằng test thật (snapshot 5 feed sample). Verify "Lua 1 round-trip" bằng `MONITOR` log. Verify "throttler 3 bucket" bằng 4 instance test. Không tin doc claim.
- [ ] **G8 Migration**: `UserAction` migration có UP + DOWN block (rollback sạch). `pg_advisory_lock` + per-migration BEGIN/COMMIT. Rollback plan viết trong PR. Test rollback trên staging.
- [ ] **G9 Payment**: N/A (P0a không đụng payment code — `UserUnlockedContent` chỉ backfill actionType UNLOCK, không đổi payment logic).
- [ ] **G10 Auth/PII**: THREAT-MODEL.md cập nhật cho `UserAction` + dwell = PII. Threats: (TH-A) leak dwell bucket qua admin endpoint, (TH-B) bot farm moi premium boost (M1 guard), (TH-C) GDPR right-to-be-forgotten (cascade test), (TH-D) retention cron fail → data lưu quá 30 ngày (alert + monitor). Authz test: throttler endpoint không expose, `UserAction` query chỉ admin/internal.

---

## 7. Open questions cho Cổng 1 (founder quyết trước P0a dev start)

- **Q1 — Anonymous view weight**: anon chỉ count popularity post-level (không per-user signal) [mặc định, đề xuất] hay device fingerprint + weight thấp? Phụ thuộc có bot-inflation thật chưa — **cần data P0.0 instrumentation** để quyết fingerprint weight. Slice này: anon KHÔNG per-user signal (an toàn), fingerprint chỉ gom bucket throttler (không ranking weight). Founder confirm OK?
- **Q3 — `MEANINGFUL_DWELL_MS` threshold**: 5000ms đề xuất (plan §8). P0a chỉ dùng cho bot pattern detection (N user gửi dwell đúng threshold ±100ms) — KHÔNG dùng cho Kafka `view-meaningful` (cut P3). Founder chốt 5000ms OK cho P0a? Hay cần đo phân phối dwell thật từ P0.0 trước?
- **Q4 — Co-engagement refresh**: periodic SQL 5–10ph [đề xuất] hay Kafka stream join? Slice này DEFER hoàn toàn sang P1 — chỉ flag ở đây để founder biết P1 sẽ cần quyết định. KHÔNG ảnh hưởng P0a scope.
- **Q-extra-1 — Bot-inflation thật chưa?** P0a build 4 lớp defense (server-side dwell, fingerprint, pattern, CAPTCHA) với effort không nhỏ. Nếu P0.0 instrumentation cho thấy chưa có bot farm thật → có thể defer một phần (pattern detection, CAPTCHA) sang P1 để giảm scope P0a 1 tuần? Founder có data support ticket / anomaly rate hiện tại không?
- **Q-extra-2 — Backfill 2 tuần có thể trễ?** Backfill cron chạy 2 tuần từ 4 bảng cũ → `UserAction`. Nếu data `PostLike`/`SavedPost`/`UserUnlockedContent`/`Comment` lớn (hàng triệu rows) → cron có thể trễ, block P1 co-engagement start. Cần estimate data volume thực + quyết (a) backfill incremental chunk 10k/batch, hay (b) parallel backfill, hay (c) chấp nhận 2 tuần trễ P1. Founder có số liệu rows hiện tại?
- **Q-extra-3 — `dwellScore` weight P0a**: P0a chỉ accumulate data vào `post:vs` hash, KHÔNG tune weight (weight = 0 trong breakdown cho FORYOU default). Founder confirm OK không tune weight cho đến khi có 1 tuần data thật (P1)? Tune sớm = ranking drift không có baseline.

---

## 8. Risks (slice này)

| Risk | Khả năng | Ảnh hưởng | Mitigation |
|---|---|---|---|
| Lua script bug corrupt Redis hash | Thấp | Mất signal aggregate | Test atomic + rollback (script có `EVALSHA` fallback `EVAL`), nightly persist DB sau (P1) |
| Throttler 3 bucket chặn nhầm user NAT VN | Trung bình | User thật bị 429 | Per-IP loose 120/phút + per-(IP+user) 60/phút (không quá strict); monitor 429 rate + alert nếu >5% user thật |
| Backfill 2 tuần trễ → block P1 | Trung bình | P1 start muộn | Estimate volume trước (Q-extra-2); incremental chunk 10k/batch; parallel nếu cần |
| `scoreAndRank` migrate 3 caller miss 1 | Thấp | Hồi quy feed hiện tại | Snapshot test 5 sample + grep caller thorough (R1 đã liệt kê 3 rõ) |
| `enrichAndMask` leak premium nếu apply thiếu chỗ | Trung bình | Leak content trả phí | Regression test `items.every(i => !i.content \|\| i.isPurchased \|\| i.isAuthor)` bắt buộc pass; code review G6 focus layer này |
| `UserAction` migration fail trên staging | Thấp | Delay slice | DOWN block rollback sạch (G8); test trên staging trước prod |
| Bot farm moi premium boost trước P0a xong | Trung bình | Ranking sai + payout sai | M1 defense 4 lớp đủ chặn; nếu Q-extra-1 cho thấy chưa có bot thật → defense đủ cho P0a |
| P0.0 instrumentation trễ → P0a không có baseline | Trung bình | Metric §1 vô nghĩa | P0.0 chặn P0a (plan §7) — KHÔNG chạy song song |
| Dwell = PII, leak qua log | Trung bình | Vi phạm quyền riêng tư | M6: dwell bucket không log exact + pseudonymous userId + retention 30 ngày + G10 THREAT-MODEL |

---

## 9. Out of scope (lặp lại rõ cho Cổng 1)

- P0b (FE payload mobile, member feed endpoint, partial index migration §6.1, sort/cursor `(score, id)` + cache `:v{VERSION}`, bỏ `total`/`totalPages`).
- P1 (discovery endpoint, co-engagement precompute nightly B3, `coengagementScore`, `popularityDecay`, nightly persist `post:vs` → DB view table).
- P2 (graduated `viewedPenalty`, watch-time log-scale popularity, cron tách `processPostList`).
- P3 (Kafka `view-meaningful` producer + consumer M7 batch/idempotency/DLQ/lag, multi-outcome sub-scores).
- ML/DNN/embedding (D1 — không bao giờ trong plan này).

---

## 10. Appendix

- Plan nguồn: `c:\MAYogu_VIASG\chat-app\docs\PLAN-feed-ranking-rollout.md` v0.2 (§7 P0.0 + P0a, §5.1 view API, §5.4 ranking engine, §5.8 integrity floor, §6.3 UserAction).
- R1 phản biện: `c:\MAYogu_VIASG\chat-app\docs\review-rounds\critique-feed-ranking-r1.md` (B1/B5/B6 + M1/M2/M3/M4/M6 punch list).
- ASSURANCE hard-gate: `c:\MAYogu_VIASG\chat-app\docs\ASSURANCE-prod-refactor.md` (G1–G10, G5 gitleaks dormancy must-fix).
- Code verify (R1 §3 + PRD §4): các file dẫn trong bảng §4 — toàn bộ verify bằng Read tool, KHÔNG bịa.
