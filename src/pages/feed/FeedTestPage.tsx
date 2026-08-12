import { useCallback, useEffect, useRef, useState } from 'react';
import { feedApi } from '@/lib/feed-api';
import { useDwellTracking } from '@/hooks/useDwellTracking';
import type { Post } from '@/types/feed';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

type FeedKind = 'legacy' | 'member' | 'discover';

interface DwellLogEntry {
  postId: string;
  dwellMs: number;
  time: string;
}

/** 1 post card — có dwell tracking (IntersectionObserver) + show "recorded Xms" khi gửi view API. */
function PostCard({
  post,
  feedKind,
  onRecord,
}: {
  post: Post;
  feedKind: FeedKind;
  onRecord: (dwellMs: number) => void;
}) {
  const [recorded, setRecorded] = useState<number | null>(null);
  const ref = useDwellTracking(post.id, (dwellMs) => {
    setRecorded(dwellMs);
    onRecord(dwellMs);
  });

  const manualView = async (dwellMs: number) => {
    const startedAt = Date.now() - dwellMs;
    await feedApi.registerView(post.id, { dwellMs, clientStartedAt: startedAt });
    setRecorded(dwellMs);
    onRecord(dwellMs);
  };

  const locked = post.isPremium && !post.isPurchased && !post.hasAccess;

  return (
    <Card
      ref={ref as React.RefObject<HTMLDivElement>}
      className="p-4 flex flex-col gap-2 scroll-mt-4"
      data-post-id={post.id}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium truncate">{post.title || post.previewTitle || '(untitled)'}</div>
          <div className="text-xs text-muted-foreground truncate">
            by {post.authorId.slice(0, 8)} · {post.communityId.slice(0, 12)}
          </div>
        </div>
        <div className="flex flex-wrap gap-1 justify-end">
          {post.isPremium && <Badge variant="default">Premium</Badge>}
          {locked && <Badge variant="destructive">Locked</Badge>}
          {feedKind === 'discover' && !post.isPremium && <Badge variant="secondary">Public</Badge>}
        </div>
      </div>

      <div className="text-sm text-muted-foreground line-clamp-3">
        {locked ? (post.previewDescription || post.previewTitle || '🔒 nội dung premium — mua để xem') : (post.content || '(no content)')}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>♥ {post.likes}</span>
        <span>💬 {post.comments}</span>
        <span>👁 {post.view}</span>
        {post.isPremium && post.soldCount != null && <span>🏷 {post.soldCount} sold</span>}
        {post.averageRating != null && <span>⭐ {post.averageRating}</span>}
        <span className="ml-auto">{post.publishedAt ? new Date(post.publishedAt).toLocaleString() : ''}</span>
      </div>

      <div className="flex items-center gap-2 mt-1">
        {recorded != null ? (
          <Badge variant="default" className="bg-emerald-600">✓ recorded {recorded}ms → view API</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">scroll vào card để đo dwell…</span>
        )}
        <Button size="sm" variant="outline" onClick={() => manualView(12000)}>
          Manual view (12s)
        </Button>
        <Button size="sm" variant="ghost" onClick={() => manualView(3000)}>
          3s
        </Button>
      </div>
    </Card>
  );
}

function FeedSection({ feedKind }: { feedKind: FeedKind }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dwellLog, setDwellLog] = useState<DwellLogEntry[]>([]);
  const topRef = useRef<HTMLDivElement | null>(null);

  const log = useCallback((postId: string, dwellMs: number) => {
    setDwellLog((l) =>
      [{ postId, dwellMs, time: new Date().toLocaleTimeString() }, ...l].slice(0, 20),
    );
  }, []);

  const fetchPage = async (reset: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const fp =
        feedKind === 'legacy'
          ? await feedApi.getPostByCommunityId(reset ? 1 : page + 1, 10)
          : feedKind === 'member'
            ? await feedApi.getMemberFeed(10, reset ? null : cursor)
            : await feedApi.getDiscover(10, reset ? null : cursor);
      setPosts((prev) => (reset ? fp.posts : [...prev, ...fp.posts]));
      setCursor(fp.nextCursor);
      setHasNext(fp.hasNextPage);
      if (feedKind === 'legacy') {
        setPage(reset ? 1 : page + 1);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'fetch failed');
    } finally {
      setLoading(false);
    }
  };

  // Auto-fetch first page when tab opens
  useEffect(() => {
    setPosts([]);
    setCursor(null);
    setPage(1);
    setHasNext(false);
    setDwellLog([]);
    fetchPage(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedKind]);

  return (
    <div className="flex flex-col gap-3">
      <div ref={topRef} className="flex items-center gap-2 flex-wrap">
        <Button size="sm" variant="outline" onClick={() => fetchPage(true)} disabled={loading}>
          {loading ? 'Đang tải…' : 'Tải lại trang 1'}
        </Button>
        {feedKind === 'legacy' && (
          <span className="text-xs text-muted-foreground">
            offset page/limit · chronological `publishedAt DESC` · member-only
          </span>
        )}
        {feedKind === 'member' && (
          <span className="text-xs text-muted-foreground">
            cursor `(score,id)` · ranked scoreAndRank MEMBER + diversity · member-only
          </span>
        )}
        {feedKind === 'discover' && (
          <span className="text-xs text-muted-foreground">
            cursor · ranked DISCOVERY (public, community CHƯA join) + exploration 25%
          </span>
        )}
      </div>

      {error && <div className="text-sm text-destructive">Lỗi: {error}</div>}

      <div className="grid gap-3">
        {posts.length === 0 && !loading && (
          <div className="text-sm text-muted-foreground py-8 text-center">
            Không có bài viết. (User chưa join community nào? Hoặc chưa có post?)
          </div>
        )}
        {posts.map((p) => (
          <PostCard key={p.id} post={p} feedKind={feedKind} onRecord={(d) => log(p.id, d)} />
        ))}
      </div>

      {hasNext && (
        <Button size="sm" variant="secondary" onClick={() => fetchPage(false)} disabled={loading}>
          {loading ? 'Đang tải…' : 'Tải thêm (trang sau)'}
        </Button>
      )}

      {/* Dwell log — show algorithm đang ghi signal */}
      {dwellLog.length > 0 && (
        <div className="mt-4 border-t pt-3">
          <div className="text-xs font-medium text-muted-foreground mb-2">
            Dwell log (view API đã ghi — feed vào dwellScore ranking):
          </div>
          <div className="flex flex-col gap-1 max-h-48 overflow-auto text-xs font-mono">
            {dwellLog.map((e, i) => (
              <div key={i} className="flex gap-3">
                <span className="text-muted-foreground">{e.time}</span>
                <span className="truncate">{e.postId.slice(0, 12)}</span>
                <span className="text-emerald-600 font-semibold">{e.dwellMs}ms</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function FeedTestPage() {
  return (
    <div className="min-h-screen bg-muted/30 p-4 md:p-6">
      <div className="max-w-3xl mx-auto flex flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Feed Algorithm Test</h1>
          <p className="text-sm text-muted-foreground">
            Test 3 feed endpoint + dwell tracking (scroll vào post → đo thời gian xem → gửi view API → feed dwellScore ranking). So sánh ranked (member-feed) vs legacy (getPostByCommunityId).
          </p>
        </header>

        <Tabs defaultValue="member" className="w-full">
          <TabsList className="grid grid-cols-3 w-full">
            <TabsTrigger value="member">member-feed (ranked)</TabsTrigger>
            <TabsTrigger value="legacy">getPostByCommunityId (legacy)</TabsTrigger>
            <TabsTrigger value="discover">discover</TabsTrigger>
          </TabsList>
          <TabsContent value="member" className="mt-4">
            <FeedSection feedKind="member" />
          </TabsContent>
          <TabsContent value="legacy" className="mt-4">
            <FeedSection feedKind="legacy" />
          </TabsContent>
          <TabsContent value="discover" className="mt-4">
            <FeedSection feedKind="discover" />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
