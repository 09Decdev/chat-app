# PLAN: Feed Ranking & Signal Capture Rollout (Áp dụng thuật toán feed vào content-service)

**Status**: Draft
**Author**: Eng (w/ Claude)  **Last Updated**: 2026-08-11  **Version**: 0.2
**Stakeholders**: Founder (decision maker), content-service dev, user-community-service dev, FE dev (chat-app/mobile-app)

> **Changelog 0.2**: chặn 6 blocker + 10 major từ phản biện R1 (`docs/review-rounds/critique-feed-ranking-r1.md`):
> - **Blocker**: B1 premium leak → `enrichAndMask` layer (§5.5, §5.6); B2 partial index → normalize `_activePostCondition` + boolean-only `where` + `id` tiebreaker (§6.1); B3 co-engagement SQL → viết lại đúng ngữ nghĩa + precompute nightly (§5.3); B4 cursor/sort → chốt `score DESC, id DESC` + cursor `(score, id)` + cache key `:v{VERSION}` (§5.4, §5.5, §5.6); B5 metrics → cắt % vô nghĩa, thay bằng đo được ngay + P0.0 instrumentation (§1.2); B6 `UserAction` → tạo table thống nhất, chuyển trước P0 (§6.3, §8 Q2).
> - **Major**: M1 bot-farm defense (§5.8.1); M2 `scoreAndRank` 3 caller + default no-regression + snapshot test (§5.4); M3 `nestjs-throttler-redis` 3 bucket (§5.8); M4 Redis Lua atomic (§5.1); M5 discovery cache 2-tier/cohort (§5.6); M6 privacy policy cascade/retention/bucket/SASL/TLS (§6.3, §5.7); M7 Kafka consumer batch+idempotency+DLQ+lag (§5.7); M8 tách P0a/P0b (§7); M9 member feed cold-start (§5.5.1); M10 cắt multi-outcome + Kafka ra P3 + no-ML threshold (§5.4, §5.7, §10.1).
> - §7 phased plan viết lại theo R1 đề xuất (P0.0 → P0a → P0b → P1 → P2 → P3).

> **Scope**: Biến 3 điểm — `POST /post/:id/view` (signal capture), `GET /post/getPostByCommunityId` (member feed), `GET /post/getAll` (discovery feed) — từ thuần chronological/counter thành pipeline ranking heuristic tín hiệu nặng, lấy cảm hứng TikTok/Facebook/Instagram/YouTube/Twitter, **không build ML**. Doc này gộp toàn bộ research (algorithm + 2 feed API + view API + signal stores + Kafka + integrity).

---

## 0. Tóm tắt 1 đoạn (press-release)

Hệ thống feed content-service hiện chạy **thuần chronological** (`ORDER BY publishedAt DESC`) cho member feed + discovery feed, và `POST /post/:id/view` chỉ bump một counter + đánh dấu "đã xem". Đó là chỗ mọi thuật toán feed lớn cần signal mạnh nhất (TikTok: completion/dwell; YouTube: watch-time; FB: meaningful interaction; Instagram: co-engagement) đều bị bỏ trống. Kế hoạch: (1) nâng cấp view API thành **điểm bắt signal giàu** (dwell/completion/skip/rewatch) với integrity floor (throttler + Redis-debounce + clamp); (2) lưu signal vào Redis hash/ZSET (per-post aggregate + per-user graduated seen); (3) đưa 2 feed API qua cùng engine `scoreAndRank` đã có, mỗi feed một **weight profile** + candidate source riêng (member = relationship-heavy; discovery = co-engagement + popularity + exploration-heavy); (4) Kafka `view-meaningful` → consumer cập nhật user profile gần real-time (pattern Twitter); (5) tách 2 feed thành 2 endpoint riêng + keyset cursor + partial index + bỏ count. Toàn bộ heuristic SQL/Redis — không ML, không DNN, không embedding infra. Lợi thế cỡ app này: tune weight với feedback loop nhanh, chính lớp surface TikTok/FB cho ra value trước khi cần ML sâu.

---

## 1. Bối cảnh & mục tiêu

### 1.1 Vấn đề
- Member feed (`getAllPostInCommunity`) và discovery feed (`findAll`) sắp theo `publishedAt DESC` — không phân biệt relationship, popularity, dwell. Một post viral cũ chìm, một author post liên tục tràn ngập.
- View API (`incrementViewCount`) bắt **0/4** signal thuật toán cần: không dwell, không completion, không skip, không rewatch — chỉ `countView` raw + boolean "đã xem".
- `viewDebounceMap` in-memory Map + `.clear()` tại threshold → mất state, vô hiệu đa instance (xem review M4).

### 1.2 Mục tiêu (đo được ngay, không % baseline — B5 fix)
- **Discovery CTR raw**: số unlock / số discover-feed impression (không %, baseline = 0 trước P0.0).
- **Member feed dwell signal**: % post view event có `dwellMs > 0` hợp lệ (target >85% sau P0b rollout ≥80%).
- **Feed request latency**: % feed request < 200ms P99 (keyset O(1), bỏ offset scan).
- **View signal coverage**: % view event có `dwellMs` hợp lệ (target >85% sau P0b).

> **Note (B5)**: A/B tune weight cần **P0.0 instrumentation** trước — `trackEvent`/`trackDwell`/`trackUnlock`/CTR port + experiment bucket service (hiện CHỈ có `getOverviewMetrics`/`getTopPosts`/`getChartMetrics`, không track event; không có assignment service). Không có P0.0 → metric % "+30%/+20%" vô nghĩa (baseline = 0). P0.0 chặn A/B P0/P1 (xem §7).

### 1.3 Phi mục tiêu
- Không thay SQL heuristic bằng ML model. Không xây DNN/embedding/SimClusters infra. Không real-time per-swipe embedding.

---

## 2. Nguyên tắc thiết kế

1. **Heuristic, không ML** — ở cỡ app hiện tại, tune weight SQL/Redis + feedback loop nhanh thắng ML (cần data volume + GPU + training pipeline chưa có). Xem §10.
2. **Một ranking engine, nhiều "chế độ" feed** — TikTok/YouTube đều dùng 1 ranker, candidate source + weight profile khác nhau mỗi surface. Tận dụng `scoreAndRank` + `buildUserProfile` đã có.
3. **View API là đầu vào** — mọi signal ranking bắt từ đây. Không có dwell → mọi signal phía sau vô nghĩa. View API = priority #1.
4. **Integrity floor trước signal** — client-reported dwell có thể fake; không có throttler/clamp/anonymous-cap thì signal rác → ranking rác.
5. **Read path không có side-effect write** — tách `processPostList` fire-and-forget `updateStatus` ra cron (review m4).
6. **Cache theo profile, không per-user khi có thể** — discovery feed cache gần-global (public post, shared) → hit rate cao; member feed per-user.

---

## 3. Hiện trạng (grounded trong code)

### 3.1 Ranking infrastructure đã có (không xây lại)
- `buildUserProfile` → signals: topHashtagIds/topAuthorIds/topCommunityIds/blockedUserIds/hiddenPostIds/unlockedPostIds ([recommendation.types.ts:16](../content-service/src/application/ports/shared/recommendation.types.ts#L16))
- `scoreAndRank` breakdown 7 signal: hashtag/author/engagement/community/recency/viewedPenalty/ratingBonus ([recommendation.types.ts:74](../content-service/src/application/ports/shared/recommendation.types.ts#L74)); engagement hiện lấy `c.view?.countView` raw ([recommendation-scorer.helper.ts:33](../content-service/src/core/helper/recommendation-scorer.helper.ts#L33))
- Nhánh COLD_START/PERSONALIZED (`hasEnoughSignals`), `gatherPersonalizedCandidates`, `runColdStart` ([post.service.ts:3029](../content-service/src/core/services/post.service.ts#L3029))
- `diversifyMixedItems` (chỉ dùng cho YouMayLike, **chưa** cho ForYou/2 feed API mới)
- Cursor (score, postId) + cache Redis per-user TTL
- `getHotWeeklyPosts`/`getPopularPaidPosts` ([post.service.ts:2962](../content-service/src/core/services/post.service.ts#L2962)) — sẵn data popularity để reuse

### 3.2 2 feed API hiện tại (cần nâng cấp)
- `getAllPostInCommunity` ([post.service.ts:809](../content-service/src/core/services/post.service.ts#L809)) → repo `findAllPostByCommunityIds` ([post.repository.adapter.ts:930](../content-service/src/infrastructure/driven-adapters/persistence/postgres/post.repository.adapter.ts#L930)) dùng `WHERE _activePostCondition AND (communityId IN (my) OR isPublic=true)` — **gộp member + discovery trong 1 query OR**, offset `skip/take`, count `includePublic=true` (đếm cả public app-wide → total vô nghĩa).
- `findAll` ([post.service.ts:1023](../content-service/src/core/services/post.service.ts#L1023)) → repo `findAll` ([post.repository.adapter.ts:717](../content-service/src/infrastructure/driven-adapters/persistence/postgres/post.repository.adapter.ts#L717)) — toàn bộ post, không phân biệt membership.

### 3.3 View API hiện tại
- `registerView` ([post.controller.ts:621](../content-service/src/infrastructure/driving-adapters/http-rest/controllers/post.controller.ts#L621)): `POST /post/:id/view`, `userId?` optional, return 204.
- `incrementViewCount` ([post.service.ts:1542](../content-service/src/core/services/post.service.ts#L1542)): `redis.incrementPostView(postId)` (bump countView) + debounce in-memory `viewDebounceMap` ([post.service.ts:102](../content-service/src/core/services/post.service.ts#L102)) + `redis.trackUserViewedPost(userId, postId)` (boolean seen).
- Redis: `getUserViewedPostIds(userId, 500)` ([cache.service.ts:831](../content-service/src/config/redis/cache.service.ts#L831)) → `viewedPostIds` boolean.

### 3.4 Schema
- `Post.isPublic Boolean @default(false)` ([schema.prisma:62](../content-service/prisma/schema.prisma#L62)) — **post-level flag** (author opt-in broadcast app-wide), không phải community accessType. Index đã có: `[communityId, publishedAt]` + `[isPublic, publishedAt]` ([schema.prisma:84](../content-service/prisma/schema.prisma#L84)). Thiếu partial index lọc active post.

### 3.5 Bug đã fix (trước doc này, không phải scope rollout)
B1–B6 + M5/M6 (IDOR, countAll filter, findByAuthor pagination, etc.) — đã đóng. Rollout này xây trên nền đã sửa.

---

## 4. Kiến trúc tổng thể (pipeline)

```
[Client]                                          [Ranking]
   │                                                  ▲
   │  POST /post/:id/view                              │ scoreAndRank(profile)
   │  { dwellMs, completion, scrollDepth, replayCount,│  + diversity re-rank
   │    source, sessionId }                            │  + exploration injection
   ▼                                                    │
[View API] ──validate+clamp──► [Redis signal stores]──►│
   │  throttler              ┌─ post:vs:{id} hash       │
   │  Redis-debounce         │  (dwell/completion/skip) │
   │                         ├─ user:viewed:{user} ZSET │
   │                         │  (graduated seen)        │
   │                         └─ co-action set (dense)  │
   │ Kafka 'view-meaningful' (dwell > threshold)       │
   ▼                                                    │
[Consumer] ─► increment user:profile:{user} ────────────┘
              (topHashtag/author/community near real-time)

[Member feed]  GET /post/member-feed   ─► scoreAndRank(profile=MEMBER)   ─► diversity(author/hashtag)
[Discovery]   GET /post/discover      ─► scoreAndRank(profile=DISCOVERY)─► diversity(community)
```

Pipeline 4 bước Facebook (Inventory → Signals → Predictions → Relevance) realizze bằng: Inventory = SQL candidate set; Signals = Redis counters + columns; Predictions = weighted sub-scores (willUnlock/willLike/willComment); Relevance = SUM(weight × signal).

---

## 5. Thành phần chi tiết

### 5.1 View API (signal capture) — P0

**Endpoint mới** (giữ `POST /post/:id/view` backward-compatible, mở rộng body optional fields):
```
POST /post/:id/view
Body (mới, optional nhưng khuyến nghị):
{
  "dwellMs": number,          // 0..3_600_000, clamp
  "completion"?: number,      // 0..1, cho video/premium có chiều dài
  "scrollDepth"?: number,     // 0..1, cho text/image
  "replayCount"?: number,     // >=0, TikTok strong positive
  "source"?: string,          // "feed"|"profile"|"share"|"discover"
  "sessionId"?: string
}
```

**Service logic** (`incrementViewCount` evolve):
1. Validate + clamp (boundary — client input không tin blind): `dwellMs` 0–3.6M, `completion`/`scrollDepth` 0–1, `replayCount` ≥ 0. Reject/Mặc-lệnhg if absurd.
2. Throttler pass (per-IP + per-user) — xem §5.8.
3. Redis atomic — **Lua script (M4)** gộp 5-7 HINCRBY/HINCRBYFLOAT thành 1 round-trip (giảm 5-7× load dưới Redis single-thread bottleneck; viral 10k view/s × 7 = 70k cmd/s ≈ Redis limit ~100k → starve post khác). Float precision OK cho sort tương đối. Script:
   ```lua
   -- KEYS[1] = post:vs:{postId}  ARGV = {dwellMs, completion, replayCount, now, SKIP_MS}
   redis.call('HINCRBY', KEYS[1], 'viewCount', 1)
   redis.call('HINCRBYFLOAT', KEYS[1], 'totalDwellMs', ARGV[1])
   redis.call('HINCRBYFLOAT', KEYS[1], 'completionSum', ARGV[2])
   if tonumber(ARGV[1]) < tonumber(ARGV[5]) then
     redis.call('HINCRBY', KEYS[1], 'skipCount', 1)
   else
     redis.call('HINCRBY', KEYS[1], 'dwellCount', 1)
   end
   if tonumber(ARGV[3]) > 0 then
     redis.call('HINCRBY', KEYS[1], 'rewatchCount', ARGV[3])
   end
   return redis.call('HGETALL', KEYS[1])
   ```
4. Debounce: `SET view:debounce:{userId}:{postId} 1 EX {VIEW_DEBOUNCE_MS/1000}` (Redis, không in-memory Map) — nếu key tồn tại → skip track per-user (vẫn bump count).
5. Per-user graduated seen: `ZADD user:viewed:{userId} {now} {postId}` + `EXPIRE 30 ngày`. Score = `now` (giữ cho sort); value dwell lưu ở hash riêng `user:viewed-dwell:{userId} {postId} {dwellMs}` hoặc encode vào member.
6. Nếu `userId` && `dwellMs >= MEANINGFUL_DWELL_MS` (vd 5000): Kafka emit `view-meaningful {userId, postId, communityId, hashtagIds[], dwellBucket, completion}` → consumer (§5.7, **P3** — M10 cut). P0/P1/P2 không cần Kafka, `buildUserProfile` rebuild DB + TTL cache đủ.
7. Anonymous (`userId` thiếu): chỉ step 3 (popularity post-level), KHÔNG step 4–6 (không per-user signal — không tin được). Hoặc weight anon thấp + device fingerprint (xem §8 quyết định mở).

**Giữ backward-compat**: client cũ không gửi body → vẫn bump countView (như cũ), không dwell. Rollout từ từ: FE thêm payload dần.

### 5.2 Signal stores (Redis) — P0

| Key | Type | Mục đích | TTL |
|---|---|---|---|
| `post:vs:{postId}` | Hash | aggregate per-post: viewCount/totalDwellMs/completionSum/skipCount/dwellCount/rewatchCount | persistent + nightly persist DB |
| `user:viewed:{userId}` | ZSET | graduated seen (postId → score=now) | 30 ngày |
| `view:debounce:{userId}:{postId}` | String | debounce per-user per-post | VIEW_DEBOUNCE_MS |
| `user:comms:{userId}` | Set | cached community membership (thay RPC `fetchApprovedCommunityIds`) | 60–120s |
| `feed:member:{userId}:{cursorKey}:l{limit}` | String | cached member feed page | 30–60s |
| `feed:discover:{cursorHash}:l{limit}` | String | cached discovery page (gần-global, không userId) | 30–60s |
| `user:profile:{userId}` | Hash | real-time-ish signal profile (§5.7) | 5–10ph + Kafka refresh |

**Persist**: `post:vs` hash nightly job → DB `view` table (countView + thêm cột totalDwellMs/avgCompletion) để survive Redis flush + dùng cho analytics.

### 5.3 Co-engagement CF (Instagram Explore) — P1

Discovery feed chính signal. "User nào cũng dwell/unlock/like post A → họ còn tương tác post B (community khác)".

**Co-action**: save/unlock/comment (hiện có) **+ view-meaningful** (dwell > threshold, mới) — view Dense hơn save hàng chục lần → CF có data thật sự.

**B3 fix**: SQL self-join cũ có 6 lỗi ngữ nghĩa — (1) `b.action_type` không filter (chỉ `a` filter) → count phình; (2) `b.ts` không filter → data mốc cũ; (3) không exclude post $1 đã tương tác → trả post đã xem (sai ngữ nghĩa Instagram Explore); (4) raw `COUNT(*)` = popularity bias (rich-get-richer, Instagram thật dùng Jaccard/cosine normalized); (5) self-join sinh bội (user view post P nhiều lần) → cần `DISTINCT (user_id, post_id)`; (6) `a.user_id <> b.user_id` + `a.post_id = b.post_id` = "user khác cũng tương tác post tôi đã tương tác" → candidate là post tôi đã tương tác, không phải post mới. Perf thêm: 10M-100M rows, 500k rows sau join + sort → P99 5-30s; cache per-user hit rate ~0% với 10M user.

→ Thay bằng **precompute nightly** item-based CF (default), bỏ online self-join.

**Precompute nightly** (cron 1 lần/ngày, O(M²) khả thi trên top-1k popular posts):
```sql
-- Step 1 (nightly): build post-pair co-occurrence trên top-1k popular posts
WITH top_posts AS (
  SELECT post_id FROM user_action
  WHERE ts > now() - interval '30 days'
  GROUP BY post_id ORDER BY count(*) DESC LIMIT 1000
)
INSERT INTO post_pair_cooccur (post_a, post_b, co_score)
SELECT a.post_id, b.post_id, LOG(1 + count(DISTINCT a.user_id)) AS co_score  -- log normalize, tránh rich-get-richer
FROM user_action a
JOIN user_action b ON a.user_id = b.user_id AND a.post_id < b.post_id  -- chặn duplicate (a<b)
JOIN top_posts ta ON a.post_id = ta.post_id
JOIN top_posts tb ON b.post_id = tb.post_id
WHERE a.action_type IN ('VIEW_MEANINGFUL','UNLOCK','SAVE','COMMENT')
  AND b.action_type IN ('VIEW_MEANINGFUL','UNLOCK','SAVE','COMMENT')
  AND a.ts > now() - interval '30 days'
  AND b.ts > now() - interval '30 days'
GROUP BY a.post_id, b.post_id
ON CONFLICT (post_a, post_b) DO UPDATE SET co_score = EXCLUDED.co_score;
```

**Lookup online** (user's interacted posts → JOIN precompute → top-200, cache 10ph):
```sql
-- top co-engaged postIds cho user (discovery candidate), post user CHƯA tương tác
SELECT pc.post_b AS post_id, sum(pc.co_score) AS co_score
FROM user_action u
JOIN post_pair_cooccur pc ON pc.post_a = u.post_id
WHERE u.user_id = $1
  AND u.action_type IN ('VIEW_MEANINGFUL','UNLOCK','SAVE','COMMENT')
  AND u.ts > now() - interval '30 days'
  AND NOT EXISTS (SELECT 1 FROM user_action u2 WHERE u2.user_id = $1 AND u2.post_id = pc.post_b)  -- exclude đã interact
GROUP BY pc.post_b
ORDER BY co_score DESC
LIMIT 200;
```
Index: `post_pair_cooccur(post_a, post_b)` PK, `@@index([post_b, post_a])`. Cache `coengage:{userId}` Set TTL 10ph. `scoreAndRank` thêm `coengagementScore` (weight cao DISCOVERY).

> **B3 bỏ**: online self-join 500k rows sau join + sort → P99 5-30s, cache per-user hit rate ~0% với 10M user. Precompute nightly + online lookup (index hit) thắng cả perf lẫn correctness. `UserAction` table cần tạo trước (B6, §6.3) — không dùng union 4 bảng (self-join chậm 5-10×).

### 5.4 Ranking engine (`scoreAndRank` evolution) — P0/P1

**Thêm signal vào breakdown** (mở `IScoredCandidate.breakdown`):
- `dwellScore` — từ `post:vs:{postId}`: `totalDwellMs / viewCount` (avg dwell) + `completionSum/viewCount`. TikTok #1.
- `coengagementScore` — từ `coengage:{userId}` (P1).
- `popularityDecay` — reuse `getHotWeeklyPosts`/`getPopularPaidPosts` data + `exp(-age_h/τ)`.
- `recency` → đổi từ step sang `exp(-age_h/τ)` (τ per profile).

**M10 scope cut**: Multi-outcome prediction (FB MSI — `willComment`/`willUnlock`/`willLike`/`willShare` sub-scores riêng) **cắt ra P3** — cần 4 signal history chưa track (comment rate with author/community, unlocked history, like history, share history). P0/P1 dùng engagement aggregate (hiện có, `helper:30-44` = `likes*1+comments*2+views*0.05+soldCount*5+reviews*3`) đủ. Relevance = SUM(weight × signal) đơn giản. Xem §10.1 threshold khi reconsider.

**M2 caller migrate**: Hiện `scoreAndRank(candidates, profile, viewedPostIds, now)` ([helper:149](../../../content-service/src/core/helper/recommendation-scorer.helper.ts#L149)) — **không `profileType`**. Thêm param break 3 caller:
- ForYou ([post.service.ts:3039](../../../content-service/src/core/services/post.service.ts#L3039))
- YouMayLike ([post.service.ts:3138](../../../content-service/src/core/services/post.service.ts#L3138))
- `post-discovery.helper.ts:160`

Default `profileType='FORYOU'` (no-regression). Snapshot test 5 feed sample (fixed seed) chặn drift.

**B4 sort + cursor chốt**: sort `score DESC, id DESC` + cursor `(score, id)` — nhất quán với ForYou hiện [scorer:185](../../../content-service/src/core/helper/recommendation-scorer.helper.ts#L185). Bỏ cursor `(publishedAt, id)`. Cache key thêm `:v{VERSION}`: `feed:member:{userId}:v{VERSION}:{cursorKey}:l{limit}` — bump VERSION khi đổi weight → cache miss tự nhiên, không skip/lặp.

**Weight profile param** (signature mới):
```ts
scoreAndRank(candidates, profile, viewedSet, now, profileType: 'MEMBER'|'DISCOVERY'|'FORYOU')
```
Mỗi profileType có weight table riêng (A/B tune được). Default:

| Signal | MEMBER | DISCOVERY | FORYOU |
|---|---|---|---|
| hashtag | cao | trung | cao |
| author | cao | thấp | trung |
| engagement | cao (sub-scores) | thấp | trung |
| community | cao | — | trung |
| recency | τ nhỏ (fresh) | τ lớn | trung |
| viewedPenalty | tốt cấp độ | tốt cấp độ | tốt cấp độ |
| ratingBonus | trung | cao (chống pay-to-rank) | cao |
| **dwellScore** | cao | trung | cao |
| **coengagementScore** | thấp | **cao nhất** | trung |
| **popularityDecay** | trung | cao | thấp |
| exploration injection | ~10% | ~20–30% | ~15–20% |

### 5.5 Member feed (API 1) — P0

**Endpoint mới** `GET /post/member-feed` (tách khỏi `getPostByCommunityId`):
- Candidate source: `WHERE communityId IN (myCommunities) AND _activePostCondition` — bỏ nhánh `OR isPublic`.
- Cache `fetchApprovedCommunityIds` → `user:comms:{userId}` Set TTL 60–120s (thay RPC mỗi request).
- Route qua `scoreAndRank(profileType='MEMBER')`.
- Diversity re-rank (mở rộng `diversifyMixedItems`): không 2 liên tiếp cùng author/hashtag.
- Exploration ~10%: inject post từ community member nhưng lâu không tương tác.
- **B4**: Keyset cursor `(score, id)` + sort `score DESC, id DESC` (chốt §5.4). Bỏ `total`/`totalPages`, trả `hasNextPage` (LIMIT N+1).
- Cache per-user `feed:member:{userId}:v{VERSION}:{cursorKey}:l{limit}` TTL 30–60s (bump VERSION khi đổi weight).
- **B1 premium leak guard**: Mọi item từ `scoreAndRank` đi qua `enrichAndMask(candidate, userId, unlockedSet, isManager)` — gọi `checkPostAccessSync` ([post.helper.ts:206](../../../content-service/src/core/helper/post.helper.ts#L206), đã fix B3), rỗng hoá `content` khi `!hasAccess`, `media` qua `processSecureMedia`. **Cấm serialize `IScoredCandidate` thô** ra HTTP (pattern đúng: `search` [post.service.ts:1172](../../../content-service/src/core/services/post.service.ts#L1172)). Regression test: `items.every(i => !i.content || i.isPurchased || i.isAuthor)`.

#### 5.5.1 Cold-start member feed (M9)

User mới chưa có dwell history → `dwellScore=0` mọi candidate → ranking trượt. Plan claim COLD_START có nhưng đó ForYou/YouMayLike, **không** member feed. Fix:
- Khi `profile.totalInteractions < N` (vd N=3, như `hasEnoughSignals`): fallback chronological + diversity (không score), hoặc
- Boost `popularityDecay` weight cho user mới (popularity không cần history user).

### 5.6 Discovery feed (API 2) — P1

**Endpoint mới** `GET /post/discover`:
- Candidate source: `WHERE isPublic=true AND communityId NOT IN (myCommunities) AND _activePostCondition` — loại trùng với member feed.
- Candidate gen 3 nguồn (YouTube two-stage analog): co-engagement CF ∪ hashtag-match (`topHashtagIds`) ∪ popular pool (`getHotWeeklyPosts`/`getPopularPaidPosts` decay).
- Route qua `scoreAndRank(profileType='DISCOVERY')`.
- Diversity re-rank: không 2 liên tiếp cùng community.
- Exploration ~20–30%: inject post không khớp hashtag nào (novel — TikTok "stumble upon new category").
- Quality floor: `moderationStatus` strict (đã có `_activePostCondition`) + engagement tối thiểu + **premium boost chỉ khi `reviewAvg >= threshold` AND reviewer tuổi >30 ngày + phone verified AND `unlockedCount > threshold`** (M1 premium-boost guard, chống pay-to-rank + bot farm ở community lạ).
- **B4**: Keyset cursor `(score, id)` + sort `score DESC, id DESC` (chốt §5.4). Bỏ `total`/`totalPages`, trả `hasNextPage` (LIMIT N+1).
- **B1 premium leak guard**: Mọi item từ `scoreAndRank` đi qua `enrichAndMask(candidate, userId, unlockedSet, isManager)` — `content` rỗng hoá khi `!hasAccess`, `media` qua `processSecureMedia`. **Cấm serialize `IScoredCandidate` thô**. Regression test như §5.5.
- **M5 discovery cache**: bỏ "near-global + in-memory filter" làm default (user join 50/1000 community → 80% filtered → fetch 100 global post để có N=20, worse than per-user cache cho light user). 3 lựa chọn:
  1. **2-tier**: global raw page `feed:discover:raw:{cursorHash}:l{limit}` TTL 60s (fetch 1 lần) + per-user filtered `feed:discover:{userId}:v{VERSION}:{cursorKey}:l{limit}` TTL 30s.
  2. **Cohort**: cache theo top-3 community user (hit rate cao cho user cùng cohort).
  3. **Candidate-gen**: thay global scan bằng `topHashtagIds` + `getHotWeeklyPosts` (đã có) — fetch đúng candidate, không over-fetch.
  Default: 2-tier (1) + candidate-gen (3) cho user ít community.

### 5.7 Real-time-ish profile update (Kafka) — P3 (M10 cut)

Twitter pattern: Kafka → consumer → Redis feature store. Không full embedding per-swipe (quá nặng), mà signal accumulator. **M10**: cắt ra P3 — `buildUserProfile` rebuild DB + TTL cache đủ cho P0/P1/P2; Kafka chỉ value khi profile stale >5ph.

- Producer: View API emit `view-meaningful` (§5.1 step 6) khi `dwellMs >= MEANINGFUL_DWELL_MS`.
- **M7 consumer**: batch consumer — `poll 500 records → Redis pipeline 1 lần` (không commit từng message), idempotency key `hash(userId,postId,ts)` SET NX dedupe, DLQ poison message (parse/processing error không block), 8-16 partitions (parallelism + throughput viral 10k event/s), monitor lag alert >60s (profile stale → feed sai).
- Consumer: cập nhật `user:profile:{userId}` Hash increment:
  - `topHashtag:{hashtagId}` HINCRBY (weight theo dwell bucket, không log exact — xem M6)
  - `topAuthor:{authorId}` HINCRBY
  - `topCommunity:{communityId}` HINCRBY
  - periodic (cron 1–5ph): sort lấy top-N → ghi lại `topHashtagIds`/`topAuthorIds`/`topCommunityIds` cho `buildUserProfile` đọc.
- `buildUserProfile` đọc `user:profile:{userId}` trước, fallback rebuild full từ DB nếu cache miss/stale.
- Kết quả: profile "fresh trong vài giây" thay vì TTL tĩnh.

**M6 privacy policy** (Kafka + Redis):
- Kafka: SASL_SSL + topic ACL (producer/consumer auth, không anonymous).
- Redis `user:profile:*`: TLS + ACL (chỉ content-service user đọc/ghi).
- Dwell bucket `<10s|10-30s|30-60s|>60s` không log exact (giảm PII nhạy cảm — VIEW_MEANINGFUL 30 ngày = PII nhạy hơn like).
- Pseudonymous userId trong payload (không email/phone).

### 5.8 Integrity floor — P0

Client-reported dwell có thể fake → không có floor thì signal rác:
1. **M3 throttler** (`nestjs-throttler-redis`, Redis storage, multi-instance safe — grep `@nestjs/throttler` trong content-service/src = no matches; default in-memory storage = 4 instance × 60 = 240/phút/IP; 1 IP nhiều user NAT VN phổ biến = chặn nhầm). 3 bucket: per-IP loose 120/phút, per-user strict 30/phút, per-(IP+user) 60/phút. Anonymous >5 view/phút → require OTP/fingerprint.
2. **Redis-debounce** (thay in-memory Map): `view:debounce:{userId}:{postId}` TTL — sống đa instance, không `.clear()` mass-loss.
3. **Clamp + validate** (§5.1 step 1): boundary, không tin blind.
4. **Anonymous capped**: anon chỉ count popularity post-level, không per-user signal/co-engagement (không userId tin được).
5. **Watch-time popularity** (YouTube): xếp post theo `totalDwellMs` (log-scale) thay `countView` raw → 100 view×60s > 1000 view×1s, chống rich-get-richer + bot count.
6. **Floor threshold**: view < `SKIP_MS` (2000) = skip, không tính positive, tính negative nhẹ.

#### 5.8.1 Bot-farm defense (M1)

Throttler/clamp/anon-cap/watch-time-log-scale **pass hết** cho bot 1000 account hợp lệ (phone OTP pipeline đã có) + rotating IP gửi `dwellMs=60000, completion=1, replayCount=5`. Co-engagement CF càng tệ: 1000 user "cùng xem" post bot → recommend chéo. Nếu ranking ảnh hưởng premium payout → **blocker tài chính**. Fix:
- (a) **Server-side dwell**: đo bằng server timestamp (request bắt đầu → view gửi về), so client dwell, chênh >30% → discard.
- (b) **Fingerprint**: `hash(userAgent+IP/24+lang+screen)` gom bucket throttler (cùng fingerprint = cùng bucket, chặn 1 IP rotating user).
- (c) **Pattern detection**: N user gửi dwell đúng `MEANINGFUL_DWELL_MS ±100ms` → flag (bot farm signature).
- (d) **CAPTCHA threshold**: user <7 ngày hoặc anomaly rate cao → trigger CAPTCHA.
- (e) **Premium-boost guard**: yêu cầu reviewer tuổi >30 ngày + phone verified + `unlockedCount > threshold` (xem §5.6 quality floor).

---

## 6. Data model / schema changes

### 6.1 Prisma — partial index (P0, migration, B2 fix)

**B2 lỗi cũ**: (1) `in` trong partial index `where` — Prisma partial index `where` chỉ hỗ trợ boolean equality + enum single value, **không hỗ trợ `in`** → migration reject; (2) `_activePostCondition` có `OR` ([adapter:279-287](../../../content-service/src/infrastructure/driven-adapters/persistence/postgres/post.repository.adapter.ts#L279): `OR: [{ publishedAt: { lte: now } }, { publishedAt: null, createdAt: { lte: now } }]`) → partial index predicate **không hỗ trợ OR** → index không match query → PG quay seq scan; (3) thiếu tiebreaker `id` → keyset `(publishedAt, id)` không stable khi `publishedAt` trùng (post đăng cùng giây).

**B2 fix**:
1. Normalize `_activePostCondition` — bỏ OR branch, `publishedAt` NOT NULL default (drafts không publish thì không vào feed, không cần OR `createdAt` fallback).
2. Partial index `where` chỉ boolean/enum single (KHÔNG `in`, KHÔNG `OR`):
```prisma
// schema.prisma — Post model (Prisma ^6.17.1 hỗ trợ `where` trong @@index — verify OK)
@@index([communityId, publishedAt(sort: Desc), id(sort: Desc)],
        where: { isPublished: true, isDelete: false })
@@index([isPublic, publishedAt(sort: Desc), id(sort: Desc)],
        where: { isPublished: true, isDelete: false })
```
3. `id` tiebreaker cho keyset stable khi sort value trùng (cũng apply cho keyset `(score, id)` §5.4 B4).

Partial index nhỏ hơn, query nhảy thẳng không post-filter.

### 6.2 DB — view table mở rộng (P0/P1)
Thêm cột vào `view` table: `totalDwellMs BigInt`, `avgCompletion Float`, `skipCount Int` (nightly persist từ Redis `post:vs`).

### 6.3 DB — `UserAction` table thống nhất (B6 chốt — trước P0, không P1)

Grep `schema.prisma` = **no `UserAction` model** (chỉ `PostLike` [:689], `SavedPost` [:700], `UserUnlockedContent` [:244], `View` [:267], `Comment`). Doc §5.3 SQL cần `user_action` thống nhất → **không chạy được**. B6 chốt: tạo table thống nhất (KHÔNG union 4 bảng — union self-join chậm 5-10×). Chuyển từ "P1" thành **trước P0** (blocker cho P1 co-engagement + P0a Kafka dedupe).

**Schema**:
```prisma
model UserAction {
  id          BigInt        @id @default(autoincrement())
  userId      String
  postId      String
  actionType  UserActionType  // VIEW_MEANINGFUL | LIKE | SAVE | UNLOCK | COMMENT
  ts          DateTime      @default(now())
  dwellBucket String?       // M6: "<10s"|"10-30s"|"30-60s"|">60s" — không log exact dwellMs
  user        User          @relation(fields: [userId], references: [id], onDelete: Cascade)  // M6 GDPR right-to-be-forgotten
  post        Post          @relation(fields: [postId], references: [id], onDelete: Cascade)

  @@index([userId, ts])        // co-engagement lookup user's history
  @@index([postId, actionType]) // precompute nightly scan
  @@unique([userId, postId, actionType, ts])  // M7 idempotency cho Kafka consumer SET NX
}

enum UserActionType {
  VIEW_MEANINGFUL
  LIKE
  SAVE
  UNLOCK
  COMMENT
}
```

**Migration + backfill**: cron 2 tuần backfill từ `PostLike`/`SavedPost`/`UserUnlockedContent`/`Comment` (4 bảng) → `UserAction`. Co-engagement precompute (§5.3) cần table này trước P1.

**M6 privacy policy** (xem §5.7 cho Kafka/Redis):
1. `userId` FK User `onDelete: Cascade` — GDPR right-to-be-forgotten xóa user → xóa hết action.
2. Cron nightly `DELETE FROM user_action WHERE ts < now() - interval '30 days'` (retention 30 ngày).
3. Dwell bucket `<10s|10-30s|30-60s|>60s` không log exact `dwellMs` (PII nhạy cảm hơn like).
4. Kafka SASL_SSL + topic ACL (§5.7).
5. Redis `user:profile:*` TLS + ACL (§5.7).

---

## 7. Phased rollout (M8 tách P0a/P0b, B6 UserAction trước P0)

### P0.0 — Instrumentation baseline (1–2 tuần, chặn B5)
- [ ] `trackEvent`/`trackDwell`/`trackUnlock`/CTR port trong analytics service (hiện CHỈ có `getOverviewMetrics`/`getTopPosts`/`getChartMetrics` — không track event).
- [ ] A/B infra: assignment service + rollback sạch + metric join (không `user_id % 100` ad-hoc — không rollback, không metric join).
- [ ] Baseline đo metric §1.2 raw (không %).

### P0a — Server-only (3–4 tuần, client cũ bump count backward-compat)
- [ ] View API evolve payload (§5.1) + Lua atomic (M4) + clamp/validate.
- [ ] Redis `post:vs` hash + `user:viewed` ZSET (cap 5000, lazy cleanup — hiện cap 1000/TTL 7d) + debounce Redis.
- [ ] `nestjs-throttler-redis` 3 bucket (M3) + bot-farm defense (M1) — §5.8.
- [ ] `scoreAndRank` thêm `dwellScore` + `profileType` (default `'FORYOU'` no-regression, 3 caller migrate — M2, snapshot test) — §5.4.
- [ ] `enrichAndMask` layer (B1) — §5.5, §5.6.
- [ ] `UserAction` table migration + backfill cron 2 tuần (B6, trước P1 co-engagement) — §6.3.

### P0b — FE payload + member feed endpoint (4–6 tuần, progressive rollout)
- [ ] chat-app + mobile-app dwell payload progressive (mobile release cycle 4-8 tuần cho 95% upgrade — không gộp vào P0a 2-3 tuần).
- [ ] Member feed endpoint tách `GET /post/member-feed` (§5.5) + cold-start (§5.5.1, M9).
- [ ] Sort/cursor `(score, id)` + cache key `:v{VERSION}` (B4) — §5.4, §5.5, §5.6.
- [ ] Partial index migration (sau B2 fix) — §6.1.
- [ ] Bỏ `total`/`totalPages` cho feed, trả `hasNextPage`.
- [ ] Dời dwell target metric ("85% view có dwell") sang P1 sau rollout ≥80% (M8).

### P1 — Co-engagement + discovery (3–4 tuần)
- [ ] `UserAction` backfill xong + co-engagement precompute nightly (B3 fix) + cache `coengage:{userId}` — §5.3.
- [ ] `coengagementScore` vào breakdown (weight cao DISCOVERY) — §5.4.
- [ ] Discovery feed tách endpoint `GET /post/discover` + 3 candidate source + diversity(community) + exploration 20–30% + premium-boost-guard (M1) + discovery cache 2-tier/cohort (M5) — §5.6.
- [ ] `popularityDecay` reuse hot/popular data + log-scale watch-time — §5.4, §5.8.5.
- [ ] Nightly persist `post:vs` → DB view table — §6.2.
- [ ] A/B tune weight chu kỳ 1 (sau P0.0 infra).

### P2 — Graduated penalty + polish (2–3 tuần)
- [ ] Graduated `viewedPenalty` (skip/short/long/completed) — §5.1 step 5.
- [ ] Watch-time-weighted popularity (log-scale) — §5.8.5.
- [ ] Cron tách `processPostList` fire-and-forget `updateStatus` ra read path — review m4, §2.5.
- [ ] A/B tune τ + weight chu kỳ 2, đo metric §1.2.

### P3 — Real-time Kafka + multi-outcome (M10 cut)
- [ ] Kafka `view-meaningful` producer + consumer → `user:profile` Hash (M7 batch+idempotency+DLQ+lag) — §5.7.
- [ ] `buildUserProfile` đọc cache `user:profile` trước, fallback rebuild.
- [ ] Multi-outcome sub-scores (willComment/willUnlock/willLike/willShare) — §5.4 (M10 cut, cần 4 signal history).
- [ ] A/B tune chu kỳ 3+.

> **M8**: 2-3 tuần P0 cũ không thực tế (gộp 8 việc + FE mobile). Tách P0a (server) + P0b (FE mobile 4-6 tuần) → 5-7 tuần thực tế. Cắt multi-outcome + Kafka ra P3 giữ 80% value, giảm big-bang risk (M10).

---

## 8. Quyết định đã chốt & quyết định mở

### Đã chốt
- **D1**: Heuristic SQL/Redis, KHÔNG ML/DNN/embedding (§2.1, §10).
- **D2**: Tách 2 feed thành 2 endpoint riêng (member + discovery) — weight profile + candidate source + exploration khác hẳn, gộp mất giá trị algorithm (§5.5/5.6).
- **D3**: View API = signal capture point, priority #1 (§2.3).
- **D4**: `isPublic` giữ nguyên (post-level flag, author opt-in) — không đổi sang `community.accessType`. Không leak vì deliberate broadcast (§3.4).
- **D5**: Keyset cursor + bỏ `total`/`totalPages` cho feed (§5.5/5.6).
- **D6**: Integrity floor (throttler + Redis-debounce + clamp + anon-cap + watch-time popularity) là tiền đề, không optional (§5.8).

### Mở (cần quyết định)
- **Q1 — Anonymous view weight**: anon chỉ count popularity (không per-user signal) [mặc định, đề xuất] hay device fingerprint + weight thấp? Phụ thuộc có bot-inflation thật không.
- **Q2 — `UserAction` table (B6 chốt)**: tạo table log thống nhất (KHÔNG union 4 bảng `PostLike`/`SavedPost`/`UserUnlockedContent`/`Comment` — self-join chậm 5-10×). Migration + backfill cron 2 tuần. Chuyển từ "P1" thành **trước P0** (blocker cho P1 co-engagement + P0a Kafka dedupe). Schema §6.3.
- **Q3 — `MEANINGFUL_DWELL_MS` threshold**: 5000ms đề xuất; tune theo phân phối dwell thật (A/B).
- **Q4 — Co-engagement refresh**: periodic SQL (5–10ph) [đề xuất] hay Kafka stream join? Periodic đủ cho mid-scale, stream phức tạp hơn.

---

## 9. Risks & trade-offs

| Risk | Mitigation |
|---|---|
| Client fake dwell → ranking sai | Integrity floor §5.8 + watch-time popularity log-scale (giảm weight raw count) |
| Co-engagement self-join chậm khi `user_action` lớn | Cache 5–10ph, index `(userId, ts)` + `(postId, actionType)`, limit 200 |
| Redis flush mất `post:vs` | Nightly persist DB §6.2; countView vẫn có (DB persist hiện) |
| Keyset cursor không stable nếu sort đổi | Tiebreaker `id` DESC + sort order cố định per profile |
| Discovery cache gần-global lo per-user exclusion | Over-fetch + in-memory lọc my-communities (hit rate >> precision loss) |
| Weight tune sai → feed tồi lúc đầu | A/B bucket, rollback nhanh (weight table Redis, đổi value không deploy) |
| Kafka consumer lag → profile stale | Fallback rebuild DB trong `buildUserProfile` + TTL cache |

---

## 10. Out of scope (đã verify ngoài tầm)

- **DNN/softmax YouTube** (Covington 2016) — cần ML platform + GPU training pipeline.
- **Twitter SimClusters** — cần graph compute + community-detection infra chuyên dụng.
- **Real-time embedding interest drift** — quá nặng; thay bằng Kafka signal accumulator (§5.7, P3).
- **Content embedding/kNN cho Explore** — Instagram Explore thật dùng co-engagement CF (KHÔNG phải embedding) → không cần.
- **M10 cut**: multi-outcome sub-scores (§5.4) + Kafka `view-meaningful` (§5.7) ra P3 — giữ 80% value, giảm big-bang risk.
- Lợi thế cỡ app: tune weight SQL/Redis feedback loop nhanh = lớp surface TikTok/FB cho value trước ML sâu.

### 10.1 No-ML threshold (M10)

D1 (no-ML) ổn cho giai đoạn này, nhưng cần ngưỡng rõ khi reconsider ML:
- **Threshold**: 50k MAU × 1M action/day (≈ 20 action/user/day) — dưới ngưỡng này, heuristic SQL/Redis + feedback loop nhanh thắng ML (data volume không đủ train, GPU training pipeline chưa có).
- **Co-engagement conditional**: nếu P0.0 instrumentation cho thấy action density <10/post → co-engagement CF yếu → giữ hashtag-match + popular decay đủ discovery 80% (bỏ precompute nightly, tiết kiệm 1-2 tuần).

**Q5 — Khi nào reconsider ML?**: khi 1 trong các điều kiện: (a) MAU >50k AND action/day >1M; (b) heuristic A/B tune không cải thiện metric sau 3 chu kỳ; (c) có ML platform + GPU budget; (d) cần personalization sâu hơn weight profile (sub-community interest). Trước đó, ML = debt không payoff.

---

## 11. References (algorithm sources, đã verify)

- TikTok For You — [TikTok Newsroom: How TikTok recommends videos](https://newsroom.tiktok.com/en-us/how-tiktok-recommends-videos-for-you)
- Facebook News Feed — [Meta Transparency: How ranking works](https://transparency.meta.com/en/about/meta/how-ranking-works/)
- Instagram Feed + Explore — [Instagram Blog: Shedding more light on how Instagram works](https://about.instagram.com/blog/announcements/shedding-more-light-on-how-instagram-works)
- YouTube Watch Next — [Covington, Adams, Sargin, RecSys 2016: Deep Neural Networks for YouTube Recommendations](https://research.google/pubs/deep-neural-networks-for-youtube-recommendations/)
- Twitter/X Home + SimClusters — [Twitter/X Engineering: Otternet embedding-based recommendations](https://blog.x.com/engineering/en_us/topics/insights/2020/otternet-embedding-based-recommendations-on-twitter)

> **Lưu ý đính chính**: Instagram Explore dùng **collaborative filtering co-engagement** (self-join "ai cũng like post này → họ còn like gì"), KHÔNG phải content-based embedding/kNN như thường bị hiểu nhầm. Đây là cơ chế §5.3 áp dụng.
