import { axiosInstance } from './api';
import type { FeedPage, Post, ViewSignal } from '@/types/feed';

/** Unwrap gateway envelope {success, data} nếu có. */
function unwrap(body: unknown): unknown {
  if (body && typeof body === 'object' && 'success' in (body as Record<string, unknown>)) {
    return (body as { data: unknown }).data;
  }
  return body;
}

/** Defensive parse — handle cả `data` (member-feed/getPostByCommunityId) lẫn `items` (discover) + envelope. */
function parseFeedPage(body: unknown): FeedPage {
  const obj = unwrap(body) as Record<string, unknown> | null;
  const arr = Array.isArray(obj?.data)
    ? (obj!.data as Post[])
    : Array.isArray(obj?.items)
      ? (obj!.items as Post[])
      : Array.isArray(obj)
        ? (obj as unknown as Post[])
        : [];
  const nextCursor = (obj?.nextCursor as string | null) ?? null;
  const hasNextPage = (obj?.hasNextPage as boolean | undefined) ?? !!nextCursor;
  const meta = obj?.meta as FeedPage['meta'] | undefined;
  return { posts: arr, nextCursor, hasNextPage, meta };
}

/**
 * Feed API — gọi content-service.
 * - getPostByCommunityId: legacy member-only, offset (page/limit) — FE hiện đang gọi.
 * - getMemberFeed: ranked member (scoreAndRank MEMBER), cursor.
 * - getDiscover: ranked public (community CHƯA join), cursor.
 * - registerView: signal capture (dwell) — fire-and-forget (204).
 */
export const feedApi = {
  getPostByCommunityId: async (page = 1, limit = 10): Promise<FeedPage> => {
    const res = await axiosInstance.get('/content-service/post/getPostByCommunityId', {
      params: { page, limit },
    });
    return parseFeedPage(res.data);
  },

  getMemberFeed: async (limit = 20, cursor?: string | null): Promise<FeedPage> => {
    const res = await axiosInstance.get('/content-service/post/member-feed', {
      params: { limit, ...(cursor ? { cursor } : {}) },
    });
    return parseFeedPage(res.data);
  },

  getDiscover: async (limit = 20, cursor?: string | null): Promise<FeedPage> => {
    const res = await axiosInstance.get('/content-service/post/discover', {
      params: { limit, ...(cursor ? { cursor } : {}) },
    });
    return parseFeedPage(res.data);
  },

  /** POST /post/:id/view — 204, fire-and-forget (swallow error, không block UX). */
  registerView: async (postId: string, signal: ViewSignal): Promise<void> => {
    try {
      await axiosInstance.post(`/content-service/post/${encodeURIComponent(postId)}/view`, signal);
    } catch {
      // view tracking không block UX
    }
  },
};
