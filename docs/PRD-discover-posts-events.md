# PRD: Discover — Bài viết & Sự kiện công khai từ nhóm chưa tham gia

**Status**: Draft
**Author**: Alex (Product Manager Agent)
**Last Updated**: 2026-08-11
**Version**: 1.0
**Stakeholders**: Content-Service Team, User-Community-Service Team, Frontend (chat-app / mobile-app), Design

---

## 1. Hiện trạng rút từ code

### 1.1. Entity Post (content-service)

**File**: `c:\MAYogu_VIASG\content-service\prisma\schema.prisma` (line 46-86)

| Trường | Loại | Ý nghĩa | Trạng thái |
|--------|------|---------|------------|
| `isPublic` | `Boolean @default(false)` (line 62) | Phân biệt bài public vs group-only | **DÀ CÓ** |
| `isPublished` | `Boolean @default(true)` (line 57) | Đã publish hay còn nháp | **DÀ CÓ** |
| `publishedAt` | `DateTime?` (line 58) | Thời gian publish | **DÀ CÓ** |
| `isDelete` / `deletedAt` | `Boolean?` / `DateTime?` (line 60-61) | Soft delete | **DÀ CÓ** |
| `moderationStatus` | `ModerationStatus @default(ACTIVE)` (line 67) | Trạng thái kiểm duyệt | **DÀ CÓ** |
| `communityId` | `String` (line 49) | Nhóm sở hữu bài viết | **DÀ CÓ** |
| `authorId` | `String` (line 48) | Tác giả | **DÀ CÓ** |
| `isPremium` | `Boolean @default(false)` (line 52) | Bài trả phí | **DÀ CÓ** |

**Index liên quan**:
- `@@index([communityId, publishedAt(sort: Desc)])` (line 84)
- `@@index([isPublic, publishedAt(sort: Desc)])` (line 85) — tối ưu cho query "bài public mới nhất"

**Kết luận**: Post model đã có đủ trường để filter `isPublic=true AND isPublished=true AND isDelete=false AND moderationStatus=ACTIVE`. **CẦN THÊM** method repo mới để query theo combo này + `communityId NOT IN (joinedIds)`.

---

### 1.2. Entity Event (content-service)

**File**: `c:\MAYogu_VIASG\content-service\prisma\schema.prisma` (line 275-319)

| Trường | Loại | Ý nghĩa | Trạng thái |
|--------|------|---------|------------|
| `communityId` | `String` (line 278) | Nhóm sở hữu sự kiện | **DÀ CÓ** |
| `organizerId` | `String` (line 277) | Người tổ chức | **DÀ CÓ** |
| `status` | `EventStatus @default(DRAFT)` (line 295) | DRAFT/PENDING/**PUBLISHED**/ONGOING/COMPLETED/CANCELLED/REJECTED | **DÀ CÓ** |
| `isDelete` / `deletedAt` | `Boolean?` / `DateTime?` (line 291-292) | Soft delete | **DÀ CÓ** |
| `startTime` / `endTime` | `DateTime` (line 286-287) | Thời gian sự kiện | **DÀ CÓ** |
| `address` / `city` | `String` (line 288-289) | Địa điểm | **DÀ CÓ** |
| `isPublic` | — | Không tồn tại | **CẦN THÊM** (xem giả định §5.1) |

**Index**: `@@index([communityId, status])` (line 317), `@@index([status])` (line 314)

**Kết luận**: Event **KHÔNG có** trường `isPublic`. Để filter "sự kiện công khai", có 2 hướng:
- **MVP (giả định)**: Infer "public event" = `status = PUBLISHED` AND community có `accessType = PUBLIC`. Content-service không có bảng Community (nằm ở user-community-service DB), nên cần lấy danh sách community IDs public+chưa-join từ user-community-service rồi filter `communityId IN (...)`.
- **v1.1**: Thêm cột `isPublic Boolean @default(false)` vào Event model (migration) — cho phép organizer đánh dấu sự kiện public riêng, độc lập với accessType của community.

---

### 1.3. Entity Community & CommunityMember (user-community-service)

**File**: `c:\MAYogu_VIASG\user-community-service\prisma\schema.prisma`

**Community** (line 162-203):

| Trường | Loại | Ý nghĩa | Trạng thái |
|--------|------|---------|------------|
| `accessType` | `CommunityAccessType @default(PUBLIC)` (line 165) | PUBLIC / PRIVATE / PAID | **DÀ CÓ** |
| `searchVisibility` | `CommunitySearchVisibility @default(PUBLIC)` (line 178) | PUBLIC / HIDDEN | **DÀ CÓ** |
| `joinMode` | `String @default("OPEN")` (line 166) | OPEN / REQUEST / INVITE_ONLY / PAID | **DÀ CÓ** |
| `isDeleted` | `Boolean @default(false)` (line 183) | Soft delete | **DÀ CÓ** |
| `moderationStatus` | `ModerationStatus @default(ACTIVE)` (line 179) | ACTIVE / SOFT_LOCKED / ADMIN_LOCKED | **DÀ CÓ** |
| `status` | `CommunityStatus @default(NORMAL)` (line 175) | NORMAL / VERIFIED / VIP | **DÀ CÓ** |

**CommunityMember** (line 289-311):

| Trường | Loại | Ý nghĩa | Trạng thái |
|--------|------|---------|------------|
| `userId` | `String` (line 291) | User ID | **DÀ CÓ** |
| `communityId` | `String` (line 292) | Community ID | **DÀ CÓ** |
| `isDeleted` | `Boolean @default(false)` (line 297) | Đã rời nhóm | **DÀ CÓ** |
| `role` | `CommunityMemberRole @default(MEMBER)` (line 300) | OWNER / MEMBER | **DÀ CÓ** |
| unique | `@@unique([userId, communityId])` (line 307) | 1 user/group duy nhất | **DÀ CÓ** |

**Kết luận**: Đủ trường để query "community IDs mà user CHƯA join" = `Community WHERE isDeleted=false AND moderationStatus IN (ACTIVE, UNBANNED) AND searchVisibility=PUBLIC AND accessType=PUBLIC AND id NOT IN (SELECT communityId FROM CommunityMember WHERE userId=? AND isDeleted=false)`.

---

### 1.4. Các route HIỆN TẠI gần với yêu cầu

#### content-service (global prefix: `content-service`)

**File**: `c:\MAYogu_VIASG\content-service\src\infrastructure\driving-adapters\http-rest\controllers\post.controller.ts`

| Route | Mô tả | Liên quan? |
|-------|-------|------------|
| `GET /content-service/post/trending-discovery` (line 157-168) | Top nhóm thịnh hành + bài HOT WEEKLY + livestreams (cache 6h) | Gần nhất — nhưng **không** filter "chưa join" hay "isPublic" |
| `GET /content-service/post/for-you` (line 177-189) | Feed cá nhân hoá, dùng `accessibleCommunityIds` (nhóm **ĐÃ** join) | Ngược ý — lọc theo nhóm đã join |
| `GET /content-service/post/you-may-like` (line 191-203) | Feed gợi ý hỗn hợp premium + livestream | Khác scope |
| `GET /content-service/post/search` (line 438-499) | Search theo keyword, cursor pagination | Pattern pagination tham khảo |
| `GET /content-service/post/communityId/:communityId` (line 354-373) | Bài theo community (user đã join) | Khác scope |
| `GET /content-service/post/premium` (line 539-562) | Premium preview, cursor pagination, **public không cần token** | Pattern public-access tham khảo |

**File**: `c:\MAYogu_VIASG\content-service\src\infrastructure\driving-adapters\http-rest\controllers\event.controller.ts`

| Route | Mô tả | Liên quan? |
|-------|-------|------------|
| `GET /content-service/event/communityId/:communityId` (line 124-152) | Sự kiện theo community (user đã đăng ký) | Khác scope |
| `GET /content-service/event/location` (line 109-122) | Sự kiện theo thành phố | Gần — nhưng không filter "chưa join" |
| `GET /content-service/event/popup-active` (line 68-79) | Sự kiện popup | Khác scope |
| `GET /content-service/event/:id` (line 319-338) | Chi tiết sự kiện | Dùng cho detail |

**Kết luận**: **CẦN THÊM** route `GET /content-service/post/discover` và `GET /content-service/event/discover` (hoặc `GET /content-service/discover` kết hợp).

#### user-community-service (controller prefix: `user-community/community`)

**File**: `c:\MAYogu_VIASG\user-community-service\src\infrastructure\driving-adapters\http-rest\controllers\community.controller.ts`

| Route | Mô tả | Liên quan? |
|-------|-------|------------|
| `GET /user-community/community/recommendations` (line 148-164) | Gợi ý nhóm (paginated, có `userId`) | Gần — có thể đã loại nhóm đã join |
| `GET /user-community/community/accessible-community` (line 166-182) | Nhóm user có thể truy cập | Khác scope |
| `GET /user-community/community/all` (line 130-146) | Tất cả nhóm (smart query) | Tham khảo |
| `GET /user-community/community/:id` (line 207-222) | Chi tiết nhóm | Dùng cho preview |

#### Internal endpoints (user-community-service, prefix: `user-community/internal`)

**File**: `c:\MAYogu_VIASG\user-community-service\src\infrastructure\driving-adapters\http-rest\controllers\Internal.controller.ts`

| Route | Mô tả | Liên quan? |
|-------|-------|------------|
| `GET /user-community/internal/communities/ids/accessible?userId=` (line 97-109) | Trả về **string[]** community IDs user đã join | **Tái sử dụng** cho exclusion |
| `GET /user-community/internal/community-member/by-user/:userId` (line 152-164) | Trả `{ communityId, joinedAt }[]` | Tham khảo |
| `GET /user-community/internal/communities/trending` (line 316-330) | Top nhóm theo JOIN 7 ngày (cache 6h) | Tham khảo |
| `GET /user-community/internal/communities/basic-info?ids=` (line 300-314) | Basic info cho nhiều communities | Dùng cho enrich metadata |

**Kết luận**: **CẦN THÊM** internal endpoint `GET /user-community/internal/communities/ids/discoverable?userId={userId}` — trả về community IDs public + active + chưa join. Hoặc tái sử dụng `ids/accessible` rồi để content-service tự `NOT IN` (xem §5.3 đánh giá trade-off).

---

### 1.5. Gateway resolve user & truyền userId

**File**: `c:\MAYogu_VIASG\gateway-auth-service\src\application\services\gateway.service.ts` (line 24-71)

- `GatewayService.buildUrlAndHeaders()`: verify JWT qua `tokenProviderAdapter.verifyToken()` → inject headers `x-user-id`, `x-user-email`, `x-installation-id` xuống downstream service.
- Route theo prefix qua `ROUTE_MAP` (`c:\MAYogu_VIASG\gateway-auth-service\src\infrastructure\gateway\routing\router.map.ts`): `user-community` → port 3001, `content-service` → port 3004.

**File**: `c:\MAYogu_VIASG\content-service\src\middleware\jwt.middleware.ts`

- Nếu header `x-user-id` đã có (gateway inject) → skip. Nếu không, decode Bearer JWT lấy `sub`.
- Decorator `@User('id')` (file `src/decorator/userAuth.decorator.ts`) đọc `x-user-id` header.

**Kết luận**: Cơ chế resolve user **DÀ CÓ**. Discover API chỉ cần dùng `@User('id') userId` như các route hiện tại.

---

### 1.6. Cross-service communication

**File**: `c:\MAYogu_VIASG\content-service\src\config\nginx\internalHttpService.ts`

- `InternalHttpService.callService(path, method, body, headers)` → gọi qua nginx proxy (`NGINX_PROXY_URL`, default `http://localhost:8088`).
- Path pattern: `/user-community/internal/communities/ids/accessible?userId=...`
- Auth: header `x-service-token: process.env.INTERNAL_SERVICE_TOKEN`.
- Đã có pattern cache Redis: `CacheService.getRaw / setRaw` với TTL (xem `PostDiscoveryHelper` line 46-78 cache 6h).

**File**: `c:\MAYogu_VIASG\content-service\src\core\helper\for-you-feed.helper.ts` (line 113-147)

- `fetchAccessibleCommunityIds(userId)` gọi `/user-community/internal/communities/ids/accessible?userId=`, cache Redis 30 phút.
- Đây chính là pattern để tái sử dụng cho discover: fetch "non-joined public community IDs" rồi cache.

---

### 1.7. Frontend API calling pattern

**File**: `c:\MAYogu_VIASG\chat-app\src\lib\api.ts`

- Axios instance với `baseURL: env.gatewayUrl`, `Authorization: Bearer <token>` từ `tokenStorage`.
- Gọi qua gateway: `/content-service/...` hoặc `/user-community/...`.
- Response envelope: `{ success, statusCode, data, message }` — hàm `unwrap()` trích `.data`.
- `apiGet<T>(url, params)` là helper chính cho GET requests.

**Kết luận**: Frontend **CẦN THÊM** hàm discoverApi trong `api.ts` (hoặc module riêng) để gọi `GET /content-service/post/discover` và `GET /content-service/event/discover`.

---

## 2. Danh sách tính năng theo module

### Module 1: Discover API — Post (content-service) — **MVP**

| # | Tính năng | Mô tả | Trạng thái |
|---|----------|-------|-----------|
| 1.1 | Route `GET /content-service/post/discover` | API trả về bài viết `isPublic=true` từ nhóm user chưa join, cursor pagination | **CẦN THÊM** |
| 1.2 | Repo method `findDiscoverablePublicPosts` | Query Prisma: `isPublic=true, isPublished=true, isDelete=false, moderationStatus=ACTIVE, communityId NOT IN (joinedIds)`, orderBy `publishedAt DESC`, cursor paginate | **CẦN THÊM** |
| 1.3 | DTO request `DiscoverPostsQueryDto` | `cursor?`, `limit?` (default 20, max 50), `hasMedia?`, `hashtag?` | **CẦN THÊM** |
| 1.4 | DTO response | Post preview: `id, communityId, authorId, content (truncate 200 chars), media[], publishedAt, likeCount, commentCount, viewCount` + `communityBasicInfo` (enrich) | **CẦN THÊM** |
| 1.5 | Redis cache | Cache kết quả theo `userId + cursor + limit`, TTL 15 phút (giống ForYou feed) | **CẦN THÊM** |

### Module 2: Discover API — Event (content-service) — **MVP**

| # | Tính năng | Mô tả | Trạng thái |
|---|----------|-------|-----------|
| 2.1 | Route `GET /content-service/event/discover` | API trả về sự kiện `status=PUBLISHED` từ nhóm public user chưa join, cursor pagination | **CẦN THÊM** |
| 2.2 | Repo method `findDiscoverableEvents` | Query Prisma: `status=PUBLISHED, isDelete=false, communityId IN (discoverableCommunityIds)`, orderBy `startTime ASC` (sắp diễn ra), cursor paginate | **CẦN THÊM** |
| 2.3 | DTO request `DiscoverEventsQueryDto` | `cursor?`, `limit?` (default 20, max 50), `city?`, `upcomingOnly?` | **CẦN THÊM** |
| 2.4 | DTO response | Event preview: `id, communityId, title, description (truncate), avatarFileId, startTime, endTime, address, city, maxParticipants, ticketTypes[]` + `communityBasicInfo` | **CẦN THÊM** |
| 2.5 | Redis cache | Cache theo `userId + cursor + limit + city`, TTL 15 phút | **CẦN THÊM** |

### Module 3: Internal Community IDs — Discoverable (user-community-service) — **MVP**

| # | Tính năng | Mô tả | Trạng thái |
|---|----------|-------|-----------|
| 3.1 | Internal endpoint `GET /user-community/internal/communities/ids/discoverable?userId=` | Trả `string[]` community IDs: `accessType=PUBLIC AND searchVisibility=PUBLIC AND isDeleted=false AND moderationStatus IN (ACTIVE, UNBANNED) AND id NOT IN (CommunityMember where userId=? AND isDeleted=false)` | **CẦN THÊM** |
| 3.2 | Service method `getDiscoverableCommunityIds(userId)` | Implement query trong `InternalService` + `CommunityPrismaRepository` | **CẦN THÊM** |
| 3.3 | Cap & pagination safety | Giới hạn trả tối đa 5000 IDs (đủ cho IN clause), sort ngẫu nhiên hoặc theo `totalMember DESC` để ưu tiên nhóm lớn | **CẦN THÊM** |

### Module 4: Auth & Permission — **MVP** (phần lớn DÀ CÓ)

| # | Tính năng | Mô tả | Trạng thái |
|---|----------|-------|-----------|
| 4.1 | Gateway inject `x-user-id` | Verify JWT → inject header (đã có) | **DÀ CÓ** |
| 4.2 | content-service `@User('id')` | Đọc userId từ header (đã có) | **DÀ CÓ** |
| 4.3 | Discover route yêu cầu đăng nhập | `userId` required (không hỗ trợ anonymous cho v1) | **CẦN THÊM** (decorator/validator) |
| 4.4 | Privacy guard: không rò rỉ bài non-public | Repo method chỉ query `isPublic=true` — không bao giờ trả `isPublic=false` cho user chưa join | **CẦN THÊM** (test xác nhận) |

### Module 5: Enrichment & Media — **MVP**

| # | Tính năng | Mô tả | Trạng thái |
|---|----------|-------|-----------|
| 5.1 | Enrich community basic info | Gọi `/user-community/internal/communities/basic-info?ids=` để lấy `name, avatarUrl` cho mỗi community trong kết quả | **DÀ CÓ** (endpoint tồn tại) — **CẦN THÊM** caller trong discover service |
| 5.2 | Enrich author basic info | Gọi `/user-community/internal/users/basic-info?ids=` để lấy `displayName, avatarUrl` | **DÀ CÓ** (endpoint tồn tại) — **CẦN THÊM** caller |
| 5.3 | Media đính kèm | Trả `Media[]` cho mỗi post/event (đã có relation trong Prisma) | **DÀ CÓ** — query include |

### Module 6: Ranking & Recommendation — **v1.1**

| # | Tính năng | Mô tả | Trạng thái |
|---|----------|-------|-----------|
| 6.1 | Điểm ưu tiên | Sắp xếp bài/sự kiện theo độ "nóng" (likes + comments + views trong 7 ngày) thay vì chỉ `publishedAt DESC` | **CẦN THÊM** (v1.1) |
| 6.2 | Personalization | Ưu tiên community có cùng hashtag/type với nhóm user đã join | **CẦN THÊM** (v1.1) |
| 6.3 | Deja-vu filter | Loại bài đã xem (dùng Redis `userViewedPostIds` đã có) | **CẦN THÊM** (v1.1) |

### Module 7: Combined Discover Feed — **v1.1**

| # | Tính năng | Mô tả | Trạng thái |
|---|----------|-------|-----------|
| 7.1 | Route `GET /content-service/discover` | Trả mix post + event trong 1 call, sắp xếp theo score chung | **CẦN THÊM** (v1.1) |
| 7.2 | Tab switching | Frontend toggle: "Bài viết" / "Sự kiện" / "Tất cả" | **CẦN THÊM** (v1.1) |

### Module 8: Event `isPublic` field — **Future**

| # | Tính năng | Mô tả | Trạng thái |
|---|----------|-------|-----------|
| 8.1 | Thêm cột `isPublic Boolean @default(false)` vào Event model | Cho phép organizer đánh dấu event public độc lập community accessType | **CẦN THÊM** (Future, cần migration) |
| 8.2 | Filter event discover theo `isPublic=true` | Thay thế việc infer từ community accessType | **CẦN THÊM** (Future) |

### Module 9: Frontend Discover Screen — **MVP**

| # | Tính năng | Mô tả | Trạng thái |
|---|----------|-------|-----------|
| 9.1 | `discoverApi` module trong `api.ts` | `discoverPosts(cursor?, limit?)`, `discoverEvents(cursor?, limit?, city?)` | **CẦN THÊM** |
| 9.2 | Discover Feed page | Infinite scroll, card bài viết + card sự kiện, nút "Tham gia nhóm" | **CẦN THÊM** |
| 9.3 | Community Preview modal | Tap vào community name → preview (avatar, name, description, totalMember, joinMode) + nút join | **CẦN THÊM** |

---

## 3. User story + Acceptance Criteria (MVP)

### Story 1: Xem bài viết public từ nhóm chưa join

**As a** người dùng đã đăng nhập,
**I want to** xem danh sách bài viết public từ các nhóm tôi chưa tham gia,
**so that** tôi có thể khám phá nội dung thú vị và quyết định có nên join nhóm hay không.

**Acceptance Criteria**:

- [ ] **Given** user đã đăng nhập (gateway inject `x-user-id`), **when** gọi `GET /content-service/post/discover?limit=20`, **then** trả về tối đa 20 bài viết thoả:
  - `isPublic = true`
  - `isPublished = true`
  - `isDelete = false` (hoặc `null`)
  - `moderationStatus = ACTIVE`
  - `communityId NOT IN` (danh sách community user đã join, lấy từ `/user-community/internal/communities/ids/accessible`)
  - Sắp xếp theo `publishedAt DESC`
- [ ] **Given** user chưa join nhóm X, **when** gọi discover, **then** KHÔNG trả về bài viết nào có `isPublic = false` từ nhóm X (kể cả nếu bài đó thuộc nhóm X).
- [ ] **Given** user đã join nhóm Y, **when** gọi discover, **then** KHÔNG trả về bất kỳ bài viết nào từ nhóm Y (dù bài đó `isPublic = true`).
- [ ] **Given** kết quả trả về đúng 20 item, **when** response, **then** có `nextCursor` không null. Dùng `cursor` đó cho request tiếp theo trả về trang 2 không trùng item.
- [ ] **Given** user chưa đăng nhập (không có `x-user-id`), **when** gọi discover, **then** trả `401 Unauthorized`.
- [ ] **Performance**: P95 response time < 800ms khi user đã join <= 200 communities. Cache Redis hit < 50ms.
- [ ] **Given** user-community-service không phản hồi (timeout), **when** gọi discover, **then** fallback trả kết quả không filter exclusion (chỉ `isPublic=true`) + gắn header `x-discover-degraded: true`, KHÔNG crash.

### Story 2: Xem sự kiện từ nhóm public chưa join

**As a** người dùng đã đăng nhập,
**I want to** xem danh sách sự kiện sắp diễn ra từ các nhóm public tôi chưa tham gia,
**so that** tôi có thể tìm sự kiện quan tâm và tham gia nhóm để đăng ký.

**Acceptance Criteria**:

- [ ] **Given** user đã đăng nhập, **when** gọi `GET /content-service/event/discover?limit=20`, **then** trả về tối đa 20 sự kiện thoả:
  - `status = PUBLISHED`
  - `isDelete = false` (hoặc `null`)
  - `communityId IN` (danh sách community IDs public + active + chưa join, lấy từ `/user-community/internal/communities/ids/discoverable`)
  - `endTime >= now` (sự kiện chưa kết thúc) khi `upcomingOnly=true` (mặc định)
  - Sắp xếp theo `startTime ASC` (sắp diễn ra trước)
- [ ] **Given** user đã join nhóm Z (private), **when** gọi discover, **then** KHÔNG trả về sự kiện từ nhóm Z.
- [ ] **Given** nhóm W có `accessType = PRIVATE`, **when** gọi discover, **then** KHÔNG trả về sự kiện từ nhóm W (dù user chưa join).
- [ ] **Given** query có `city=Hanoi`, **when** gọi discover, **then** chỉ trả sự kiện có `city = 'Hanoi'` (case-insensitive nếu có thể).
- [ ] **Given** kết quả trả về đúng 20 item, **when** response, **then** có `nextCursor` cho trang tiếp.
- [ ] **Performance**: P95 < 800ms. Cache hit < 50ms.
- [ ] **Given** internal service không phản hồi, **when** gọi discover, **then** fallback trả `503` với message rõ ràng (KHÔNG fallback cho event vì không có cách an toàn để suy ra community accessType).

### Story 3: Enrich metadata community & author

**As a** người dùng,
**I want to** thấy tên nhóm, avatar nhóm, tên tác giả khi xem discover feed,
**so that** tôi nhận biết được nội dung thuộc nhóm ai và do ai đăng.

**Acceptance Criteria**:

- [ ] **Given** discover API trả N posts, **when** response, **then** mỗi item có field `community: { id, name, avatarUrl, totalMember, joinMode }` và `author: { id, displayName, avatarUrl }`.
- [ ] **Given** posts thuộc M community khác nhau, **when** enrich, **then** gọi đúng 1 batch `/user-community/internal/communities/basic-info?ids=...` (không N+1).
- [ ] **Given** posts thuộc K author khác nhau, **when** enrich, **then** gọi đúng 1 batch `/user-community/internal/users/basic-info?ids=...` (không N+1).
- [ ] **Given** internal enrich call thất bại, **when** response, **then** vẫn trả posts/events nhưng `community` và `author` = `null` (không crash, degrade gracefully).

### Story 4: Phân trang cursor

**As a** người dùng,
**I want to** cuộn xuống xem thêm bài/sự kiện mà không bị trùng lặp,
**so that** trải nghiệm khám phá liên tục.

**Acceptance Criteria**:

- [ ] **Given** trang 1 trả 20 item với `nextCursor = "abc123"`, **when** gọi `?cursor=abc123&limit=20`, **then** trang 2 trả 20 item tiếp theo, không trùng item nào của trang 1.
- [ ] **Given** kết quả ít hơn `limit`, **when** response, **then** `nextCursor = null` (không còn trang sau).
- [ ] **Given** cursor không hợp lệ (sai format, expire), **when** gọi, **then** trả `400 Bad Request` với message "Invalid cursor".
- [ ] Cursor encoding: base64 của JSON `{ publishedAt: ISO string, id: string }` (cho post) hoặc `{ startTime: ISO string, id: string }` (cho event) — nhất quán với pattern `decodeCursor/encodeCursor` đã có trong `recommendation-scorer.helper.ts`.

---

## 4. User flow chính

### Flow 1: Khám phá bài viết — chính

```
User mở app → tap tab "Khám phá" (Discover)
  → Frontend gọi GET /content-service/post/discover?limit=20
    (Authorization: Bearer <token> qua gateway)
  → Gateway verify JWT, inject x-user-id, forward đến content-service
  → content-service PostController.discover(userId, query)
    → PostService.discover(userId, query)
      1. Fetch joined community IDs:
         InternalHttpService.callService(
           '/user-community/internal/communities/ids/accessible?userId={userId}',
           'GET', undefined, { 'x-service-token': INTERNAL_SERVICE_TOKEN }
         ) → string[] joinedIds  (cache Redis 30 min)
      2. Query Prisma:
         Post.findMany({
           where: {
             isPublic: true,
             isPublished: true,
             isDelete: { not: true },
             moderationStatus: 'ACTIVE',
             communityId: { notIn: joinedIds },
             publishedAt: { lt: cursor.publishedAt } // cursor paginate
           },
           orderBy: { publishedAt: 'desc' },
           take: limit + 1,
           include: { media: true, view: true, _count: { likes: true, comments: true } }
         })
      3. Batch enrich:
         - communityBasicInfo: /user-community/internal/communities/basic-info?ids=...
         - authorInfo: /user-community/internal/users/basic-info?ids=...
      4. Cache Redis (key = discover:posts:{userId}:{cursorHash}:{limit}, TTL 15 min)
      5. Return { items: [...], nextCursor: "..." }
  → Frontend render card list:
    [Avatar nhóm] [Tên nhóm] [totalMember] [Join button]
    [Avatar tác giả] [DisplayName] • [thời gian]
    [Nội dung (truncate 200 chars)]
    [Media thumbnails]
    [Like count] [Comment count] [View count]
```

### Flow 2: Khám phá sự kiện

```
User tap "Sự kiện" sub-tab trong Discover
  → Frontend gọi GET /content-service/event/discover?limit=20
  → Gateway → content-service EventController.discover(userId, query)
    → EventService.discover(userId, query)
      1. Fetch discoverable community IDs:
         InternalHttpService.callService(
           '/user-community/internal/communities/ids/discoverable?userId={userId}',
           'GET', undefined, { 'x-service-token': INTERNAL_SERVICE_TOKEN }
         ) → string[] discoverableIds  (cache Redis 30 min)
         (những community PUBLIC + ACTIVE + chưa join)
      2. Query Prisma:
         Event.findMany({
           where: {
             status: 'PUBLISHED',
             isDelete: { not: true },
             communityId: { in: discoverableIds },
             endTime: { gte: now },
             ...(city ? { city: { equals: city, mode: 'insensitive' } } : {})
           },
           orderBy: { startTime: 'asc' },
           take: limit + 1,
           include: { ticketTypes: true, _count: { comments: true } }
         })
      3. Batch enrich communityBasicInfo (same as Flow 1)
      4. Cache + Return
  → Frontend render event card list:
    [Event avatar] [Title] [StartTime - EndTime]
    [Address, City]
    [Community name + avatar] [Join button]
    [Max participants] [Ticket price range]
```

### Flow 3: Tap vào bài viết → xem chi tiết

```
User tap vào 1 post card trong discover feed
  → Frontend gọi GET /content-service/post/{id}
    (route đã có, line 579-590)
  → Nếu post.isPublic = true AND user chưa join community:
    trả chi tiết bài viết (content đầy đủ, media, comments)
  → Nếu post.isPublic = false AND user chưa join community:
    trả 403 "This post is not public" (không rò rỉ nội dung)
```

### Flow 4: Tap vào community → preview → join

```
User tap vào tên/avatar nhóm trong card
  → Frontend gọi GET /user-community/community/{id}
    (route đã có, community.controller.ts line 207-222)
  → Hiển thị Community Preview modal:
    - Avatar, name, description, rules, types
    - totalMember / maxMembers
    - joinMode (OPEN / REQUEST / INVITE_ONLY)
  - Nếu joinMode = OPEN:
      Tap "Tham gia" → POST /user-community/community-member/join (route communityMember)
      → Thành công → ẩn nút Join, hiện "Đã tham gia"
  - Nếu joinMode = REQUEST:
      Tap "Yêu cầu tham gia" → POST /user-community/join-request (route joinRequest)
      → Hiện "Đã gửi yêu cầu"
  - Nếu joinMode = INVITE_ONLY:
      Ẩn nút Join, hiện "Nhóm chỉ nhận lời mời"
```

---

## 5. Đặc thù miền

### 5.1. Giả định "public" cho Event (KHÔNG hỏi lại PO — đã chốt)

Event model **không có** trường `isPublic` (chỉ có `status`). Quyết định:

- **MVP**: "Sự kiện công khai" = `status = PUBLISHED` AND community có `accessType = PUBLIC`. Content-service không sở hữu bảng Community nên phải lấy danh sách community IDs public+chưa-join từ user-community-service (internal endpoint mới). Điều này đảm bảo KHÔNG rò rỉ sự kiện từ nhóm private.
- **Future (Module 8)**: Thêm cột `isPublic Boolean @default(false)` vào Event model qua Prisma migration. Cho phép organizer chọn "hiển thị sự kiện này ra ngoài nhóm" độc lập. Khi đó filter event discover = `isPublic = true` (giống post), không cần phụ thuộc community accessType.

### 5.2. Quyền riêng tư — không rò rỉ bài non-public

Đây là ràng buộc ĐÃ CHỐT: **bài viết chỉ trả về `isPublic = true`**. Đảm bảo:

- Repo method `findDiscoverablePublicPosts` có điều kiện `where: { isPublic: true }` — hardcoded, không truyền từ controller.
- Test integration: tạo 10 bài (5 `isPublic=true`, 5 `isPublic=false`) trong nhóm user chưa join → discover chỉ trả 5 bài public.
- Audit: thêm log `discover.leaked` nếu query vô tình trả bài `isPublic=false` (defensive logging).

### 5.3. Cross-service dependency & failure

- content-service phụ thuộc user-community-service để lấy:
  1. Joined community IDs (đã có endpoint `/ids/accessible`)
  2. Discoverable community IDs (endpoint mới `/ids/discoverable`) — chỉ cần cho event discover
  3. Community basic info (đã có `/basic-info`)
  4. User basic info (đã có `/users/basic-info`)

- **Post discover**: nếu `/ids/accessible` timeout → fallback: trả bài `isPublic=true` KHÔNG filter exclusion + header `x-discover-degraded: true`. Frontend hiển thị banner "Có thể hiển thị bài từ nhóm bạn đã tham gia" — tạm chấp nhận.
- **Event discover**: nếu `/ids/discoverable` timeout → KHÔNG fallback (trả 503). Lý do: không có cách an toàn để infer community accessType ở content-service; fallback = rò rỉ event từ nhóm private → vi phạm quyền riêng tư.

### 5.4. Phân trang lớn & NOT IN performance

- User join tối đa `maxMembers` nhóm (default 20, nhưng có thể nhiều hơn). `NOT IN` clause với <= 500 IDs là OK cho PostgreSQL.
- Nếu user join > 500 nhóm: nội bộ chia `NOT IN` thành batch hoặc dùng subquery. Đặt cap 5000 IDs trong internal response để tránh IN clause quá lớn.
- Cursor pagination (không offset) để tránh skip performance issue.

### 5.5. Cache strategy

| Cache key | TTL | Invalidate trigger |
|-----------|-----|-------------------|
| `discover:joined-ids:{userId}` | 30 min | User join/leave community → Kafka event `user.community.changed` → content-service listener del key |
| `discover:discoverable-ids:{userId}` | 30 min | Same trigger |
| `discover:posts:{userId}:{cursorHash}:{limit}` | 15 min | TTL expire (không cần real-time) |
| `discover:events:{userId}:{cursorHash}:{limit}` | 15 min | TTL expire |

Pattern: cache theo user (không cache global) vì exclusion list khác nhau per user.

### 5.6. Rate limit

- Gateway đã có `JwtThrottlerGuard` với 3 tier (short/medium/long).
- Discover API kế thừa throttler mặc định — không cần custom limit cho MVP.
- Nếu cần: thêm `@Throttle({ default: { limit: 30, ttl: 60_000 } })` cho discover route (30 req/phút/user).

### 5.7. Timezone của event

- `startTime` / `endTime` lưu dạng `DateTime` (UTC) trong PostgreSQL.
- Response trả ISO 8601 string (UTC). Frontend convert sang local timezone của device.
- Filter `upcomingOnly=true` dùng `endTime >= now()` với `now()` = server time (UTC) — an toàn vì compare cùng UTC.

### 5.8. Đa ngôn ngữ (i18n)

- Post content và Event title/description lưu raw (ngôn ngữ gốc của author).
- Không cần i18n server-side cho MVP — frontend render raw content.
- v1.1: nếu cần, thêm field `language` vào Post/Event và filter theo ngôn ngữ device.

### 5.9. Media upload

- Media (ảnh/video) đính kèm post/event đã có relation `Media[]` trong Prisma (file `schema.prisma` line 374-393).
- `fileId` tham chiếu tới upload-service. Frontend dùng fileId để lấy URL (qua upload-service API hoặc CDN).
- Discover response trả `media[]` với `fileId, type, mimeType, width, height, blurFileId` — đủ cho frontend render thumbnail. KHÔNG trả URL trực tiếp (URL do upload-service / CDN quản lý).

### 5.10. Moderation & safety

- Chỉ trả bài/sự kiện có `moderationStatus = ACTIVE` (post) hoặc community `moderationStatus IN (ACTIVE, UNBANNED)`.
- Bài/sự kiện bị `SOFT_LOCKED` / `ADMIN_LOCKED` không xuất hiện trong discover.
- `HiddenUser` (bảng trong content-service, line 676-687): nếu user đã hide một author, loại bài của author đó khỏi discover. Tái sử dụng `hiddenUserRepo.findAllBlockedUserIds(userId, [])` (đã có trong ForYouFeedHelper line 96-102).

---

## 6. Danh sách màn hình cần design

### 6.1. Discover Feed (MVP — chính)

Màn hình chính của tab "Khám phá". Infinite scroll list hiển thị card bài viết public từ nhóm chưa join. Mỗi card: community avatar + name + "Chưa tham gia" badge + nút "Tham gia" (primary), author avatar + name, content preview (truncate), media thumbnail (1-4 ảnh), like/comment/view count. Top bar có sub-tab toggle: "Bài viết" / "Sự kiện". Pull-to-refresh xoá cache và load trang 1 mới.

### 6.2. Discover Events (MVP)

Sub-tab "Sự kiện" trong Discover. Card sự kiện dạng ngang hoặc dọc: event avatar, title, startTime (relative: "Còn 3 ngày"), address + city, community name + nút "Tham gia", max participants progress bar, ticket price range (min-max). Filter bar: "Thành phố" dropdown, "Sắp diễn ra" toggle.

### 6.3. Community Preview Modal (MVP)

Modal/bottom-sheet khi tap vào tên nhóm trong bất kỳ card nào. Hiển thị: avatar (lớn), group banner, name, description, rules (list), types (chips), totalMember / maxMembers, joinMode badge. Nút行动: "Tham gia" (OPEN, green), "Yêu cầu tham gia" (REQUEST, outline), hoặc text "Nhóm chỉ nhận lời mời" (INVITE_ONLY, disabled). Sau khi join thành công: modal chuyển sang "Đã tham gia" + nút "Vào nhóm".

### 6.4. Post Detail (Discover context) (MVP — tái sử dụng)

Màn hình chi tiết bài viết khi tap từ discover card. Tái sử dụng post detail screen hiện có (`GET /content-service/post/:id`). Thêm: banner top "Bài viết từ nhóm {name} — bạn chưa tham gia" + nút "Tham gia nhóm" sticky. Nếu post `isPublic = false` và user chưa join: hiển thị placeholder "Nội dung này chỉ dành cho thành viên nhóm. Tham gia để xem." + nút join.

### 6.5. Event Detail (Discover context) (MVP — tái sử dụng)

Màn hình chi tiết sự kiện khi tap từ discover. Tái sử dụng event detail screen hiện có (`GET /content-service/event/:id`). Thêm: banner "Sự kiện từ nhóm {name} — chưa tham gia" + nút "Tham gia nhóm để đăng ký". Nếu sự kiện yêu cầu đăng ký vé (ticketTypes có giá): hiển thị danh sách vé + nút "Mua vé" (chỉ active nếu đã join nhóm, hoặc cho phép mua luôn nếu community accessType = PUBLIC).

### 6.6. Discover Empty State (MVP)

Khi discover feed không có kết quả (user đã join tất cả nhóm public, hoặc chưa có bài public nào). Hiển thị illustration + text "Hãy tham gia nhóm mới để khám phá thêm nội dung" + nút "Tìm nhóm" (điều hướng đến community search/recommendations).

### 6.7. Degraded State Banner (MVP)

Khi `x-discover-degraded: true` (internal service timeout). Banner vàng top feed: "Tạm thời không thể lọc bài theo nhóm đã tham gia. Có thể bạn thấy bài từ nhóm đã join." + nút "Thử lại".

---

## Appendix — Route map đề xuất

| Service | Method | Route | Auth | Mô tả |
|---------|--------|-------|------|-------|
| content-service | GET | `/content-service/post/discover` | Bearer JWT | Bài public, nhóm chưa join, cursor pagination |
| content-service | GET | `/content-service/event/discover` | Bearer JWT | Sự kiện published, nhóm public chưa join, cursor pagination |
| user-community-service | GET | `/user-community/internal/communities/ids/discoverable?userId=` | x-service-token | Community IDs public + active + chưa join |
| user-community-service | GET | `/user-community/internal/communities/ids/accessible?userId=` | x-service-token | (DÀ CÓ) Community IDs đã join — tái sử dụng cho post exclusion |

### Service chịu trách nhiệm chính

- **content-service**: Implement discover API routes, repo methods, cache, enrich. Đây là service sở hữu Post và Event.
- **user-community-service**: Thêm 1 internal endpoint mới (`/ids/discoverable`). Phần lớn infra (auth, routing, consul) đã sẵn sàng.

### Giả định & quyết định quan trọng

1. **Event "public"**: MVP infer từ `community.accessType=PUBLIC` + `event.status=PUBLISHED`. Future: thêm cột `isPublic` vào Event model.
2. **Post "public"**: Dùng trực tiếp `Post.isPublic` field (đã có, có index).
3. **Joined exclusion**: Tái sử dụng `/user-community/internal/communities/ids/accessible?userId=` (đã có) cho post. Thêm `/user-community/internal/communities/ids/discoverable?userId=` (mới) cho event — endpoint này vừa lọc accessType=PUBLIC vừa exclude joined, trả về sẵn IDs để content-service chỉ việc `IN`.
4. **Cursor pagination**: Base64-encoded JSON, nhất quán với `recommendation-scorer.helper.ts` pattern.
5. **Cache**: Per-user, Redis, TTL 15-30 min. Invalidation qua Kafka event khi user join/leave.
6. **No anonymous**: Discover API yêu cầu đăng nhập (userId required). Không hỗ trợ anonymous cho v1.
7. **Degraded fallback**: Post discover fallback gracefully (bỏ exclusion, gắn header). Event discover KHÔNG fallback (trả 503) để bảo vệ quyền riêng tư.
