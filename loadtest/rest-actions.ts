/**
 * MAYogu LoadTest Tool — REST Driver (RD-1..RD-4):
 * Action library: feed, post detail, view, comment create/list, like toggle, chat enqueue/cancel/my-room/queue-count.
 * - Mỗi action: payload factory + validate response + đo latency.
 * - Retry idempotent: tối đa 2 lần cho 5xx/timeout/network (SERVER + NETWORK), KHÔNG retry 4xx (RD-2).
 * - Nội dung prefix `[lt]`, sạch profanity (RD-3).
 */

import type { LoadTestEnv } from './config';
import { requestJson, type HttpResult } from './http';
import { genCommentContent, ltLog, normalizeUrl } from './util';

export interface ActionResult {
  ok: boolean;
  latencyMs: number;
  code: string; // '' khi ok
  failClass: string;
}

/** Post id dùng cho kịch bản — lấy từ feed mới nhất (không phụ thuộc fixture). */
class PostIdCache {
  private ids: string[] = [];
  private lastFetch = 0;
  private communityWarned = false;
  constructor(private communityId: string) {}
  async get(gateway: string, token: string): Promise<string | null> {
    const now = Date.now();
    if (this.ids.length === 0 || now - this.lastFetch > 30_000) {
      const res = this.communityId
        ? await this.fetchCommunity(gateway, token)
        : await this.fetchFeed(gateway, token);
      if (res.ok) {
        this.ids = res.ids;
        this.lastFetch = now;
      }
    }
    if (this.ids.length === 0) return null;
    return this.ids[Math.floor(Math.random() * this.ids.length)];
  }
  /** Feed toàn app — hành vi cũ (không set LOADTEST_COMMUNITY_ID). */
  private async fetchFeed(gateway: string, token: string): Promise<{ ok: boolean; ids: string[] }> {
    const res = await requestJson<unknown>(gateway, '/content-service/post/getAll', {
      token,
      timeoutMs: 10_000,
      body: undefined,
      method: 'GET',
    });
    if (!res.ok) return { ok: false, ids: [] };
    const ids = extractPostIds(res.data);
    return { ok: ids.length > 0, ids };
  }
  /** Post theo community; 403 hoặc items rỗng → fallback getAll + lọc local. */
  private async fetchCommunity(gateway: string, token: string): Promise<{ ok: boolean; ids: string[] }> {
    const res = await requestJson<unknown>(
      gateway,
      `/content-service/post/communityId/${this.communityId}?page=1&limit=20`,
      { token, timeoutMs: 10_000, body: undefined, method: 'GET' },
    );
    if (!res.ok && res.failClass !== 'FORBIDDEN') return { ok: false, ids: [] };
    const ids = extractPostIds(res.data);
    if (ids.length > 0) return { ok: true, ids };
    return this.fetchCommunityLocalFallback(gateway, token);
  }
  /** findByCommunityId đòi user là member (403 COMMUNITY_NOT_MEMBER) — getAll rồi lọc local (≤3 trang). */
  private async fetchCommunityLocalFallback(gateway: string, token: string): Promise<{ ok: boolean; ids: string[] }> {
    if (!this.communityWarned) {
      this.communityWarned = true;
      ltLog.warn(
        `community ${this.communityId} không có post/403 — dùng local filter (kiểm tra membership user pool)`,
      );
    }
    const out: string[] = [];
    for (let page = 1; page <= 3 && out.length < 20; page++) {
      const res = await requestJson<unknown>(gateway, `/content-service/post/getAll?page=${page}&limit=20`, {
        token,
        timeoutMs: 10_000,
        body: undefined,
        method: 'GET',
      });
      if (!res.ok) break;
      for (const item of extractItems(res.data)) {
        if (out.length >= 20) break;
        if ((item as { communityId?: unknown } | null)?.communityId === this.communityId) {
          const id = (item as { id?: unknown } | null)?.id;
          if (typeof id === 'string') out.push(id);
        }
      }
    }
    return { ok: out.length > 0, ids: out };
  }
}

/** Envelope defensive: lấy mảng từ `data` (getAll) hoặc `items` (community endpoint). */
function extractItems(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  const data = (body as { data?: unknown } | null)?.data;
  if (Array.isArray(data)) return data;
  const items = (body as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items : [];
}

/** Envelope defensive: tối đa 50 item đầu, 20 id. */
function extractPostIds(body: unknown): string[] {
  const out: string[] = [];
  for (const item of extractItems(body).slice(0, 50)) {
    const id = (item as { id?: unknown } | null)?.id;
    if (typeof id === 'string') out.push(id);
    if (out.length >= 20) break;
  }
  return out;
}

export class RestDriver {
  private postIdCache: PostIdCache;
  private lastLikeAt = new Map<string, number>(); // key `${action}:${id}` — like toggle ≥30s/cặp (AC4.4)
  private noFixtureLogged = false;

  constructor(
    private gateway: string,
    _env: LoadTestEnv,
  ) {
    this.gateway = normalizeUrl(gateway);
    this.postIdCache = new PostIdCache(_env.communityId);
  }

  /** T-07/S-12: NO_POST_FIXTURE — log 1 lần để không lặp spam; khách hàng đọc rõ. */
  private noFixture(): ActionResult {
    if (!this.noFixtureLogged) {
      this.noFixtureLogged = true;
      ltLog.warn('Không có post fixture — bỏ qua bước đọc feed (NO_POST_FIXTURE). Seed nội dung trước khi chạy run.');
    }
    return { ok: false, latencyMs: 0, code: 'NO_POST_FIXTURE', failClass: 'CLIENT' };
  }

  private async exec(token: string, path: string, opts: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {}): Promise<HttpResult> {
    let attempt = 0;
    for (;;) {
      attempt++;
      const res = await requestJson(this.gateway, path, {
        method: opts.method ?? 'GET',
        token,
        body: opts.body,
        timeoutMs: 15_000,
      });
      // F-2: retry CẢ SERVER (5xx) lẫn NETWORK (timeout/ECONNREFUSED/socket error) — 1 lần.
      // KHÔNG retry 4xx/401/403/429 (client error — retry vô ích, RD-2).
      if (res.ok || (res.failClass !== 'SERVER' && res.failClass !== 'NETWORK')) return res;
      if (attempt >= 2) return res;
      await new Promise((r) => setTimeout(r, 200 * attempt)); // backoff nhẹ
    }
  }

  private action<T>(res: HttpResult<T>, _action: string): ActionResult {
    return {
      ok: res.ok,
      latencyMs: res.latencyMs,
      code: res.code,
      failClass: res.failClass,
    };
  }

  /** GET feed phân trang (RD-4 read:feed). */
  async readFeed(token: string): Promise<ActionResult> {
    const page = 1 + Math.floor(Math.random() * 3);
    const res = await this.exec(token, `/content-service/post/getAll?page=${page}&limit=20`);
    return this.action(res, 'read');
  }

  /** GET post chi tiết + POST view (đo riêng 2 action). */
  async readPostDetail(token: string): Promise<{ detail: ActionResult; view: ActionResult | null }> {
    const postId = await this.postIdCache.get(this.gateway, token);
    if (!postId) return { detail: this.noFixture(), view: null };
    const d = await this.exec(token, `/content-service/post/${postId}`);
    const detail = this.action(d, 'read');
    const view = await this.viewPost(token, postId);
    return { detail, view };
  }

  /** POST view — dedupe server 7 ngày (retry vô hại). */
  async viewPost(token: string, postId?: string): Promise<ActionResult> {
    const id = postId ?? (await this.postIdCache.get(this.gateway, token));
    if (!id) return this.noFixture();
    const res = await this.exec(token, `/content-service/post/${id}/view`, { method: 'POST', body: {} });
    return this.action(res, 'view');
  }

  /** POST comment root — content ≤ 2000, prefix [lt] (AC4.3). */
  async createComment(token: string, userIndex: number): Promise<ActionResult> {
    const postId = await this.postIdCache.get(this.gateway, token);
    if (!postId) return this.noFixture();
    const res = await this.exec(token, `/content-service/comments/posts/${postId}`, {
      method: 'POST',
      body: { content: genCommentContent(userIndex) },
    });
    return this.action(res, 'comment');
  }

  /** GET comments list của post. */
  async readComments(token: string): Promise<ActionResult> {
    const postId = await this.postIdCache.get(this.gateway, token);
    if (!postId) return this.noFixture();
    const res = await this.exec(token, `/content-service/comments/posts/${postId}?page=1&limit=20`);
    return this.action(res, 'comment');
  }

  /** POST like toggle — ≥30s/cặp user+post (AC4.4); retry an toàn qua unique pair. */
  async likePost(token: string): Promise<ActionResult> {
    const postId = await this.postIdCache.get(this.gateway, token);
    if (!postId) return this.noFixture();
    const key = `post:${postId}`;
    const last = this.lastLikeAt.get(key) ?? 0;
    if (Date.now() - last < 30_000) {
      return { ok: true, latencyMs: 0, code: 'LIKE_PACED_SKIP', failClass: 'OK' };
    }
    const res = await this.exec(token, `/content-service/like/post/${postId}`, { method: 'POST', body: {} });
    if (res.ok || res.failClass !== 'SERVER') this.lastLikeAt.set(key, Date.now());
    return this.action(res, 'like');
  }

  // ─── Chat REST (aux — đa số chat qua socket farm) ─────────────────────

  async chatEnqueue(token: string, topic?: string): Promise<ActionResult> {
    const res = await this.exec(token, '/content-service/chat/match', {
      method: 'POST',
      body: topic ? { topic } : {},
    });
    return this.action(res, 'chat');
  }

  async chatCancel(token: string): Promise<ActionResult> {
    const res = await this.exec(token, '/content-service/chat/match', { method: 'DELETE' });
    return this.action(res, 'chat');
  }

  async chatMyRoom(token: string): Promise<ActionResult & { roomId: string | null }> {
    const res = await this.exec(token, '/content-service/chat/match/my-room');
    const roomId =
      res.ok && res.data && typeof res.data === 'object'
        ? ((res.data as { roomId?: unknown }).roomId as string | null) ?? null
        : null;
    return { ...this.action(res, 'chat'), roomId };
  }

  /** GET queue-count — không cần token (chat.controller.ts:52-57). */
  async chatQueueCount(): Promise<HttpResult<{ count?: number }>> {
    return requestJson<{ count?: number }>(this.gateway, '/content-service/chat/match/queue-count', {
      timeoutMs: 10_000,
    });
  }

  /** PUT topic — rate 15s/user server-side; retry an toàn (HASH field=userId). */
  async setTopic(token: string, roomId: string, title: string): Promise<ActionResult> {
    const res = await this.exec(token, `/content-service/chat/rooms/${encodeURIComponent(roomId)}/my-topic`, {
      method: 'PUT',
      body: { title },
    });
    return this.action(res, 'topic');
  }

  // ─── Helper cho worker log ──────────────────────────────────────────────

  logOnce(action: string, msg: string) {
    ltLog.info(`[REST:${action}] ${msg}`);
  }
}
