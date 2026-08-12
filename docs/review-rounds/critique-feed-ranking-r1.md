# Phản biện PLAN-feed-ranking-rollout — Round 1

**Date**: 2026-08-11  **Round**: R1  **Target**: `docs/PLAN-feed-ranking-rollout.md` v0.1
**Critics** (4, song song, mỗi cái 1 lăng kính hoài nghi, verify bằng code thật):
- Correctness + code-claims (Code Reviewer)
- Performance + infra (Backend Architect)
- Security + integrity (Senior SecOps)
- Product scope realism (Reality Checker)

**Verdict tổng**: **NEEDS WORK — chưa implement được**. 6 blocker, 10 major. Điểm tốt: claim §3 (hiện trạng) **8/8 chính xác** — doc không bịa; D1 (no-ML), D5 (keyset + bỏ total), D6 (integrity floor) đúng đắn. Vấn đề tập trung ở **3 vùng**: partial index không dùng được, co-engagement SQL sai ngữ nghĩa + không scale, premium-content leak qua `scoreAndRank` candidate.

---

## Blocker (6) — phải sửa trước P0/P1

### B1. Premium content leak qua `IRecommendationCandidate.content`  *(security)*
`IRecommendationCandidate.content` ([recommendation.types.ts:33](../../../content-service/src/application/ports/shared/recommendation.types.ts#L33)) là **content đầy đủ kể cả premium**, đi qua `scoreAndRank` nguyên vẹn. Doc §5.5/5.6 route member/discovery qua `scoreAndRank` rồi enrich nhưng **không bắt buộc mask layer**. Serialize `IScoredCandidate` thô ra HTTP = leak premium cho user chưa unlock.
- **Pattern đúng đã có**: `search` ([post.service.ts:1172](../../../content-service/src/core/services/post.service.ts#L1172)) làm `content: hasAccess ? item.content : ''` + `checkPostAccessSync` ([post.helper.ts:206](../../../content-service/src/core/helper/post.helper.ts#L206), đã fix B3) + `processSecureMedia`.
- **Fix**: doc §5.5/5.6 bắt buộc mọi item từ `scoreAndRank` đi qua `enrichAndMask(candidate, userId, unlockedSet, isManager)` — `content` rỗng hoá khi `!hasAccess`, `media` qua `processSecureMedia`. Cấm serialize `IScoredCandidate` thô. Regression test: `items.every(i => !i.content || i.isPurchased || i.isAuthor)`.
- **Nối tiếp B1–B3 đã fix** — đây là gap tương tự nhưng ở feed path mới.

### B2. Prisma partial index không dùng được  *(correctness + perf)*
Doc §6.1: `@@index([communityId, publishedAt], where: { isPublished, isDelete, moderationStatus: { in: [ACTIVE, UNBANNED] } })`. 3 lỗi:
1. **`in` trong partial index `where`** — Prisma partial index `where` chỉ hỗ trợ boolean equality + enum single value, **không hỗ trợ `in`**. Migration bị reject.
2. **`_activePostCondition` có `OR`** ([adapter:279-287](../../../content-service/src/infrastructure/driven-adapters/persistence/postgres/post.repository.adapter.ts#L279)): `OR: [{ publishedAt: { lte: now } }, { publishedAt: null, createdAt: { lte: now } }]`. Partial index predicate **không hỗ trợ OR** → index không match query → PG quay seq scan. Doc claim "nhảy thẳng không post-filter" sai.
3. **Thiếu tiebreaker `id`** → keyset `(publishedAt, id)` không stable khi `publishedAt` trùng (post đăng cùng giây).
- **Fix**: normalize `_activePostCondition` — bỏ OR, `publishedAt` NOT NULL default (drafts không vào feed), index `@@index([communityId, publishedAt(sort: Desc), id(sort: Desc)], where: { isPublished: true, isDelete: false })` (boolean only, hoặc `moderationStatus: ACTIVE` single enum). Prisma `^6.17.1` hỗ trợ `where` (verify OK).

### B3. Co-engagement SQL sai ngữ nghĩa + không scale  *(correctness + perf)*
Doc §5.3 self-join có 6 lỗi logic:
1. `b.action_type` không filter (chỉ `a` filter) → count phình bởi action vô nghĩa.
2. `b.ts` không filter → data mốc cũ vô hạn.
3. **Không exclude post $1 đã tương tác** → trả post đã xem, không phải discovery (sai ngữ nghĩa Instagram Explore).
4. Raw `COUNT(*)` = popularity bias (rich-get-richer); Instagram Explore thật dùng Jaccard/cosine normalized.
5. Self-join sinh bội (user view post P nhiều lần) → cần `DISTINCT (user_id, post_id)` trước join.
6. `a.user_id <> b.user_id` + `a.post_id = b.post_id` = "user khác cũng tương tác post tôi đã tương tác" → candidate là post tôi đã tương tác, không phải post mới.
- **Perf thêm** (perf critic): 10M-100M rows, 500k rows sau join + sort → P99 5-30s; cache per-user hit rate ~0% với 10M user.
- **Fix**: (a) viết lại SQL đúng — filter `b.action_type IN(...)` + `b.ts` + `NOT EXISTS (post $1 đã interact)` + `DISTINCT` + normalize count (`log`/Jaccard); (b) **precompute nightly** `post_pair_cooccur{post_a, post_b, co_score}` item-based CF trên top-1k popular posts (O(M²) khả thi), lookup user's liked → JOIN precompute → top-200. Periodic precompute thắng online self-join.

### B4. Cursor vs sort mâu thuẫn  *(correctness)*
Doc §5.4 route feed qua `scoreAndRank` (sort `score DESC`), nhưng §5.5/5.6 keyset cursor `(publishedAt, id)`. Cursor `(publishedAt, id)` chỉ stable nếu sort = `publishedAt`. Sort = score → cursor phải `(score, id)` (ForYou hiện đúng `[scorer:185](../../../content-service/src/core/helper/recommendation-scorer.helper.ts#L185)`).
- **Thêm**: score thay đổi khi A/B tune weight → cursor `(score, id)` cũ invalid.
- **Fix**: chốt 1 phương án. Khuyến nghị: member/discovery dùng sort `score DESC, id DESC` + cursor `(score, id)` (như ForYou) — nhất quán với ranking engine. Invalidation: version cursor key `feed:member:{userId}:{VERSION}:{cursor}` — bump VERSION khi đổi weight → cache miss tự nhiên, không skip/lặp.

### B5. Metrics §1.2 không đo được  *(realism)*
Analytics port hiện CHỈ có `getOverviewMetrics`/`getTopPosts`/`getChartMetrics` — **không** có `trackEvent`/`trackDwell`/`trackUnlock`/CTR. Grep `experiment|ab_test|bucket` trong content-service = no infra experiment.
- "+30% CTR", "+20% dwell" — baseline = 0 (chính P0 mới xây dwell pipeline). Vô nghĩa.
- A/B `user_id % 100` — không có assignment service, không rollback sạch, không metric join.
- **Fix**: hoặc cắt metric %, thay bằng đo được ngay ("% post có dwell signal > 0", "% feed request < 200ms", "discovery CTR raw không %"); hoặc thêm **P0.0 instrumentation 2 tuần** trước A/B.

### B6. `user_action` không tồn tại — Q2 chặn P1  *(perf + realism + security)*
Grep `schema.prisma` = **no `UserAction` model**. Chỉ có `PostLike` (689), `SavedPost` (700), `UserUnlockedContent` (244), `View` (267), `Comment`. Doc §5.3 SQL cần `user_action`統 nhất → **không chạy được**.
- 2 lựa chọn: (a) tạo `UserAction` migration + backfill cron 2 tuần từ 4 bảng; (b) union 4 bảng + self-join (chậm 5-10×).
- **Fix**: chốt Q2 **trước P0** (không P1). Khuyến nghị (a) — table thống nhất + `VIEW_MEANINGFUL` actionType. Kèm retention/cascade (xem M6).

---

## Major (10)

### M1. Integrity floor không chặn bot farm có account hợp lệ  *(security)*
Bot 1000 account (phone OTP — pipeline đã có) + rotating IP gửi `dwellMs=60000, completion=1, replayCount=5`. Throttler/clamp/anon-cap/watch-time-log-scale **pass hết**. Co-engagement CF càng tệ: 1000 user "cùng xem" post bot → recommend chéo. Nếu ranking ảnh hưởng premium payout → **blocker tài chính**.
- **Fix**: (1) **server-side dwell** — đo bằng server timestamp (request bắt đầu → view gửi về), so client dwell, chênh >30% → discard; (2) fingerprint `hash(userAgent+IP/24+lang+screen)` gom bucket throttler; (3) pattern detection — N user gửi dwell đúng `MEANINGFUL_DWELL_MS ±100ms` → flag; (4) CAPTCHA threshold cho user mới <7 ngày hoặc anomaly rate cao; (5) premium boost guard yêu cầu `unlockedCount > threshold` AND reviewer tuổi >30 ngày + phone verified.

### M2. `scoreAndRank` đổi signature break 3 caller  *(realism)*
Hiện `scoreAndRank(candidates, profile, viewedPostIds, now)` ([helper:149](../../../content-service/src/core/helper/recommendation-scorer.helper.ts#L149)) — **không `profileType`**. Thêm param break: ForYou (3039), YouMayLike (3138), `post-discovery.helper.ts:160`. Doc không liệt kê.
- **Fix**: doc §5.4 liệt kê 3 caller + default `profileType='FORYOU'` (no-regression) + snapshot test 5 feed sample.

### M3. Throttler chưa cài + đa instance fail  *(perf)*
Grep `@nestjs/throttler` trong content-service/src = **no matches**. Default in-memory storage → 4 instance = 60×4=240/phút/IP. 1 IP nhiều user (NAT VN phổ biến) → chặn nhầm.
- **Fix**: `nestjs-throttler-redis` (Redis storage, multi-instance safe). 3 bucket: per-IP loose (120/phút), per-user strict (30/phút), per-(IP+user) medium (60/phút). Anonymous >5 view/phút → require OTP/fingerprint.

### M4. Redis single-thread bottleneck viral  *(perf)*
`post:vs` 5-7 HINCRBY/event (hiện `incrementPostView` chỉ 1 lệnh [cache.service.ts:615](../../../content-service/src/config/redis/cache.service.ts#L615)). 10k view/s viral × 7 = 70k cmd/s ≈ Redis limit ~100k → starve post khác.
- **Fix**: Lua script atomic gộp 5-7 lệnh thành 1 round-trip (5-7× giảm load). Hoặc Redis Cluster sharding `postId % N`. `HINCRBYFLOAT totalDwellMs` float precision OK cho sort tương đối.

### M5. Discovery cache over-fetch cho user ít community  *(perf)*
Near-global + in-memory filter my-communities: user join 50/1000 community → 80% filtered → fetch 100 global post để có N=20. Worse than per-user cache cho light user.
- **Fix**: 2-tier (global raw page 60s + per-user filtered 30s) hoặc cohort cache (top-3 community) hoặc candidate gen từ `topHashtagIds` + `getHotWeeklyPosts` (đã có) thay global scan.

### M6. `user_action` + Kafka payload thiếu privacy policy  *(security)*
Log `VIEW_MEANINGFUL (userId, postId, dwellMs, completion)` 30 ngày = PII nhạy hơn like. Doc không nói: `ON DELETE CASCADE` (GDPR right-to-be-forgotten), retention cron delete vs chỉ exclude, bucket dwell thay log exact, Kafka SASL_SSL + ACL, Redis TLS, pseudonymous userId.
- **Fix**: doc §6.3 + §5.7: (1) `user_action.userId` FK User CASCADE; (2) cron nightly `DELETE WHERE ts < now()-30d`; (3) bucket dwell `<10s|10-30s|30-60s|>60s` không log exact; (4) Kafka SASL_SSL + topic ACL; (5) Redis `user:profile:*` TLS + ACL.

### M7. Kafka consumer lag  *(perf)*
10k event/s viral, plan không nói partitions/max.poll.records/commit/DLQ/idempotency. Lag → profile stale → feed sai.
- **Fix**: batch consumer (poll 500 → Redis pipeline 1 lần), idempotency key `hash(userId,postId,ts)` SET NX dedupe, DLQ poison, 8-16 partitions, monitor lag alert >60s.

### M8. Timeline P0 2-3 tuần không thực tế  *(realism)*
P0 gộp 8 việc: view API + Redis 4 store + throttler + scoreAndRank evolve + member feed tách + partial index + A/B + **FE payload mobile (iOS+Android)**. Mobile release cycle 4-8 tuần cho 95% upgrade. Metric "85% view có dwell" không đạt cho đến mobile rollout.
- **Fix**: tách P0a (server-only, client cũ vẫn bump count) + P0b (FE payload + member feed endpoint). 2-3 tuần → 5-7 tuần. Dời dwell target metric sang P1 sau rollout ≥80%.

### M9. Cold-start member feed  *(realism)*
Plan dùng `scoreAndRank(MEMBER)` với `dwellScore` weight cao. User mới chưa có dwell history → `dwellScore=0` mọi candidate → ranking trượt. Doc claim COLD_START có nhưng đó ForYou/YouMayLike, **không** member feed.
- **Fix**: §5.5.1 — member feed cold-start: fallback chronological + diversity khi `profile.totalInteractions < N`. Hoặc boost `popularityDecay` cho user mới.

### M10. Scope big-bang  *(realism)*
7 hệ thống song song P0+P1. Cắt giữ 80% value:
- **Cắt multi-outcome** (willComment/willUnlock/willLike/willShare, §5.4) — cần 4 signal history chưa track. Tiết kiệm 1-2 tuần.
- **Cắt Kafka `view-meaningful`** (§5.7) ra P3 — `buildUserProfile` rebuild DB + TTL cache đủ cho giờ; Kafka chỉ value khi profile stale >5ph.
- **Cắt co-engagement** nếu P0 instrumentation cho thấy action density <10/post — hashtag-match + popular decay đủ discovery 80%.
- **No-ML thiếu ngưỡng** — thêm §10.1 threshold (vd 50k MAU × 1M action/day) + Q5 khi nào reconsider ML.

---

## Minor (xem punch list)
- ZSET cap 1000/TTL 7d hiện ([cache.service.ts:797](../../../content-service/src/config/redis/cache.service.ts#L797)) vs doc claim 500/30d → raise cap 5000, lazy cleanup.
- Nightly persist `post:vs` reconcile sau Redis flush (delta từ Kafka log).
- Co-engagement cache `coengage:{userId}` access control — không expose admin/internal không token.
- Debounce key enumeration — luôn trả 204, không `tracked` field.
- Membership staleness sau kick (60-120s) — Kafka `community.member.removed` → `DEL user:comms:{userId}` hoặc re-validate page 1.
- Engagement ≠ countView — engagement là aggregate `likes*1+comments*2+views*0.05+soldCount*5+reviews*3` ([helper:30-44](../../../content-service/src/core/helper/recommendation-scorer.helper.ts#L30)); doc §3.1 misleading.
- `buildUserProfile` ref — `IUserProfile` ở types:16, hàm ở [helper:53](../../../content-service/src/core/helper/for-you-feed.helper.ts#L53); doc thiếu `accessibleCommunityIds`.
- Backward-compat endpoint cũ (`getAllPostInCommunity`/`findAll`) — giữ 2 quý + flag `deprecated:true`; FE không dùng totalPages (verify no match) nhưng caller khác có thể.
- Premium post trong member feed — access control (`hasAccess`/`isPurchased`) chưa đề cập.
- Livestream mix — member/discovery mới im; YouMayLike có mix.
- `getHotWeeklyPosts` ref — repo call ở service:2927, không phải method 2962.

---

## Điểm hội tụ (nhiều critic cùng vớt = chắc nhất)
1. **`user_action` không tồn tại** — perf + realism + security cùng chốt (B6).
2. **Partial index mismatch** — correctness + perf cùng chốt (B2).
3. **Bot integrity floor không đủ** — security chỉ ra, realism xác nhận data thưa (`MIN_SIGNALS=3`) làm CF yếu (M1 + M10).
4. **scoreAndRank signature change phá caller** — correctness + realism (M2).
5. **Premium leak risk** — security blocker B1, correctness/realism xác nhận `scoreAndRank` trả candidate thô.

## Điểm TỐT (giữ)
- §3 hiện trạng: **8/8 claim verify ĐÚNG** — doc grounded thật, không bịa.
- D1 (no-ML) ổn cho giai đoạn này (cần ngưỡng §10.1).
- D5 (keyset + bỏ total) đúng — FE không phụ thuộc totalPages.
- D6 (integrity floor) đúng hướng (cần mạnh hơn M1).
- §5.1 view API + §5.8 integrity floor vững (cộng thêm M1).
- Algorithm mapping (TikTok completion, FB MSI, Instagram CF, YouTube two-stage, Twitter Kafka) đúng ngữ nghĩa nguồn — lỗi chỉ ở implementation SQL/index, không ở conceptual.

---

## Punch list — phải sửa trước khi approve

| # | Mức | Việc | Vị trí doc |
|---|---|---|---|
| 1 | blocker | Thêm `enrichAndMask` layer bắt buộc cho 2 feed mới; cấm serialize `IScoredCandidate` thô | §5.5, §5.6 |
| 2 | blocker | Normalize `_activePostCondition` bỏ OR; partial index `where` chỉ boolean/enum single; thêm `id` tiebreaker | §6.1, §3.4 |
| 3 | blocker | Viết lại co-engagement SQL đúng ngữ nghĩa + normalize count + precompute nightly | §5.3 |
| 4 | blocker | Chốt sort `score DESC, id DESC` + cursor `(score, id)` + version key cho weight change | §5.4, §5.5 |
| 5 | blocker | Cắt metric % hoặc thêm P0.0 instrumentation 2 tuần | §1.2 |
| 6 | blocker | Chốt Q2 tạo `UserAction` migration (trước P0, không P1) | §8 Q2 |
| 7 | major | Bot-farm defense: server-side dwell + fingerprint + pattern + CAPTCHA threshold | §5.8 |
| 8 | major | Liệt kê 3 caller `scoreAndRank` + default no-regression + snapshot test | §5.4 |
| 9 | major | Cài `nestjs-throttler-redis` 3 bucket | §5.8 |
| 10 | major | Lua script atomic cho `post:vs` multi-HINCRBY | §5.1 |
| 11 | major | Discovery cache 2-tier / cohort / candidate-gen thay global scan | §5.6 |
| 12 | major | `user_action` + Kafka retention/cascade/bucket/encryption policy | §6.3, §5.7 |
| 13 | major | Kafka consumer batch + idempotency + DLQ + lag monitor | §5.7 |
| 14 | major | Tách P0a (server) / P0b (FE mobile); dời dwell metric sang P1 | §7 |
| 15 | major | Member feed cold-start strategy | §5.5 |
| 16 | major | Cắt multi-outcome + Kafka ra P2/P3; thêm no-ML threshold | §5.4, §5.7, §10 |

---

## Phased plan đề xuất (sau sửa)

- **P0.0** (1-2 tuần): instrumentation baseline — `trackEvent`/dwell/CTR + A/B infra (chặn B5).
- **P0a** (3-4 tuần, server-only): view API evolve + Redis `post:vs` (Lua) + `user:viewed` (cap 5000) + `nestjs-throttler-redis` + `scoreAndRank` thêm `dwellScore` + `profileType` (default no-regression, 3 caller migrate) + `enrichAndMask` layer. Client cũ vẫn bump count (backward-compat).
- **P0b** (4-6 tuần, FE): chat-app + mobile-app dwell payload (progressive rollout) + member feed endpoint tách + sort/cursor `(score,id)` + partial index migration (sau B2 fix).
- **P1** (3-4 tuần): `UserAction` table + backfill + co-engagement precompute nightly (sau B3 fix) + discovery endpoint + diversity(community) + exploration 20-30% + premium-boost-guard.
- **P2** (2-3 tuần): `user:viewed` graduated penalty + watch-time-weighted popularity + cron tách `processPostList` side-effect.
- **P3**: Kafka `view-meaningful` (sau M7/M13) + multi-outcome sub-scores + A/B tune chu kỳ 2.

Cắt multi-outcome + Kafka ra P3 giữ 80% value, giảm big-bang risk.

---

## Verdict
**NEEDS WORK.** Doc không implement-ready do 6 blocker (premium leak, partial index, co-engagement SQL, cursor/sort, metrics, user_action). Nhưng **nền tảng đúng** — §3 grounded 8/8, D1/D5/D6 sound, algorithm mapping đúng ngữ nghĩa nguồn. Sửa 16 punch-list item (đặc biệt 6 blocker) → READY cho P0.0. Không over-engineered hoàn toàn, nhưng cần cắt scope (M10) và tách P0a/P0b (M8) để tránh big-bang.

**File tham khảo** (đường dẫn tuyệt đối):
- Plan: `c:\MAYogu_VIASG\chat-app\docs\PLAN-feed-ranking-rollout.md`
- Code verify: `content-service/src/application/ports/shared/recommendation.types.ts:33` (content field), `:77-84` (breakdown); `content-service/src/core/helper/recommendation-scorer.helper.ts:30-44,149,185`; `content-service/src/core/helper/for-you-feed.helper.ts:42,53,84,149,188`; `content-service/src/core/services/post.service.ts:809,1023,1172,2962,2991,3039,3138`; `content-service/src/infrastructure/driven-adapters/persistence/postgres/post.repository.adapter.ts:279,930,957`; `content-service/src/config/redis/cache.service.ts:615,797`; `content-service/prisma/schema.prisma:46-86,244,267,689,700`; `content-service/package.json` (Prisma ^6.17.1); `content-service/src/application/ports/inbound/analytics.service.port.ts`.
