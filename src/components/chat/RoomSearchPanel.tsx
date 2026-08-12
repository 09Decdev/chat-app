import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import {
  Search,
  Image as ImageIcon,
  FileText,
  Loader2,
  Inbox,
} from 'lucide-react';
import { toast } from 'sonner';
import { useChatStore } from '@/store/chat.store';
import { chatApi, ApiError } from '@/lib/api';
import type {
  SearchResultItem,
  RoomMediaItem,
} from '@/types/chat';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { UserAvatar } from './UserAvatar';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Panel test 3 API: search tin nhắn / ảnh (gallery) / file (attachments) trong room. */
export function RoomSearchPanel({ open, onOpenChange }: Props) {
  const roomId = useChatStore((s) => s.roomId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[95vw] max-w-2xl flex-col gap-3 p-4">
        <DialogHeader>
          <DialogTitle>Tìm &amp; Ảnh trong phòng</DialogTitle>
          <DialogDescription>
            {roomId
              ? `Phòng ${roomId.slice(0, 8)}… — test 3 API search / ảnh / file`
              : 'Chưa vào phòng — vào phòng để dùng.'}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="search" className="flex min-h-0 flex-1 flex-col">
          <TabsList>
            <TabsTrigger value="search" className="gap-1.5">
              <Search className="h-3.5 w-3.5" /> Tìm tin nhắn
            </TabsTrigger>
            <TabsTrigger value="images" className="gap-1.5">
              <ImageIcon className="h-3.5 w-3.5" /> Ảnh
            </TabsTrigger>
            <TabsTrigger value="files" className="gap-1.5">
              <FileText className="h-3.5 w-3.5" /> File
            </TabsTrigger>
          </TabsList>

          <TabsContent value="search" className="min-h-0 flex-1">
            <SearchTab roomId={roomId} />
          </TabsContent>
          <TabsContent value="images" className="min-h-0 flex-1">
            <MediaTab roomId={roomId} mode="images" />
          </TabsContent>
          <TabsContent value="files" className="min-h-0 flex-1">
            <MediaTab roomId={roomId} mode="attachments" />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// ─── Search tab ─────────────────────────────────────────────────────────────

function SearchTab({ roomId }: { roomId: string | null }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<SearchResultItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searched, setSearched] = useState(false);

  if (!roomId) return <EmptyState text="Chưa vào phòng." />;

  const run = async (reset: boolean) => {
    const query = q.trim();
    if (query.length < 2) {
      toast.error('Nhập tối thiểu 2 ký tự để tìm.');
      return;
    }
    if (reset) setLoading(true);
    else {
      if (!cursor) return;
      setLoadingMore(true);
    }
    try {
      const page = await chatApi.searchMessages(
        roomId,
        query,
        reset ? null : cursor,
        20,
      );
      setItems((prev) => (reset ? page.data : [...prev, ...page.data]));
      setCursor(page.nextCursor);
      setHasNext(page.hasNextPage);
      setSearched(true);
    } catch (e) {
      toast.error((e as ApiError).message ?? 'Tìm thất bại.');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(true);
        }}
        className="flex gap-2"
      >
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Từ khoá (tối thiểu 2 ký tự, bỏ dấu được)…"
          autoFocus
        />
        <Button type="submit" disabled={loading} className="shrink-0">
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
          Tìm
        </Button>
      </form>

      <div className="max-h-[55vh] overflow-y-auto pr-1">
        {loading ? (
          <LoadingRows />
        ) : items.length === 0 ? (
          <EmptyState
            text={searched ? 'Không tìm thấy tin nhắn.' : 'Nhập từ khoá để tìm.'}
          />
        ) : (
          <div className="flex flex-col">
            {items.map((it) => (
              <SearchResultRow key={it.id} item={it} />
            ))}
            {hasNext && cursor && (
              <Button
                variant="ghost"
                className="mt-1 w-full"
                onClick={() => void run(false)}
                disabled={loadingMore}
              >
                {loadingMore && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Tải thêm
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SearchResultRow({ item }: { item: SearchResultItem }) {
  return (
    <div className="flex gap-2 rounded-lg p-2 hover:bg-secondary/50">
      <div className="shrink-0">
        <UserAvatar
          name={item.displayName}
          userId={item.userId}
          url={item.avatarUrl}
          size="sm"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-1.5 text-xs">
          <span className="font-medium text-foreground/90">
            {item.displayName ?? 'Thành viên'}
          </span>
          <span className="text-muted-foreground">
            {format(new Date(item.createdAt), 'HH:mm dd/MM')}
          </span>
        </div>
        <p className="break-words text-sm leading-relaxed text-foreground/80">
          {renderHeadline(item.headline)}
        </p>
      </div>
    </div>
  );
}

/** Render ts_headline '...<b>match</b>...' thành bold KHÔNG dùng dangerouslySetInnerHTML. */
function renderHeadline(headline: string) {
  const parts = headline.split(/(<b>.*?<\/b>)/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith('<b>') && p.endsWith('</b>')) {
      return (
        <b key={i} className="font-semibold text-primary">
          {p.slice(3, -4)}
        </b>
      );
    }
    return <span key={i}>{p}</span>;
  });
}

// ─── Media tab (images grid + attachments list — image-only hiện tại) ───────

function MediaTab({
  roomId,
  mode,
}: {
  roomId: string | null;
  mode: 'images' | 'attachments';
}) {
  const [items, setItems] = useState<RoomMediaItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Load preview khi vào phòng (images: 5, attachments: 20). Radix Dialog unmount
  // content khi đóng → remount khi mở lại → state reset, fetch tươi mỗi lần mở.
  useEffect(() => {
    if (!roomId) {
      setItems([]);
      setCursor(null);
      setLoaded(false);
      return;
    }
    let cancelled = false;
    const initialLimit = mode === 'images' ? 5 : 20;
    (async () => {
      setLoading(true);
      try {
        const page = await chatApi.listRoomMedia(roomId, null, initialLimit);
        if (cancelled) return;
        setItems(page.data);
        setCursor(page.nextCursor);
        setLoaded(true);
      } catch (e) {
        if (!cancelled) toast.error((e as ApiError).message ?? 'Tải media thất bại.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId, mode]);

  const loadMore = async () => {
    if (!roomId || !cursor) return;
    setLoadingMore(true);
    try {
      const page = await chatApi.listRoomMedia(roomId, cursor, 20);
      setItems((prev) => [...prev, ...page.data]);
      setCursor(page.nextCursor);
    } catch (e) {
      toast.error((e as ApiError).message ?? 'Tải thêm thất bại.');
    } finally {
      setLoadingMore(false);
    }
  };

  if (!roomId) return <EmptyState text="Chưa vào phòng." />;

  return (
    <div className="flex flex-col gap-2">
      <div className="max-h-[55vh] overflow-y-auto pr-1">
        {loading ? (
          <LoadingRows />
        ) : items.length === 0 ? (
          <EmptyState text={loaded ? 'Không có ảnh/file trong phòng.' : 'Đang tải…'} />
        ) : mode === 'images' ? (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {items.map((it) => (
              <a
                key={it.messageId}
                href={it.presignedUrl ?? undefined}
                target="_blank"
                rel="noreferrer"
                className="group relative aspect-square overflow-hidden rounded-lg bg-secondary"
              >
                {it.presignedUrl ? (
                  <img
                    src={it.presignedUrl}
                    alt="ảnh chat"
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform group-hover:scale-105"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <ImageIcon className="h-6 w-6 text-muted-foreground" />
                  </div>
                )}
              </a>
            ))}
          </div>
        ) : (
          <div className="flex flex-col">
            {items.map((it) => (
              <div
                key={it.messageId}
                className="flex items-center gap-2 rounded-lg p-2 hover:bg-secondary/50"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-secondary">
                  <ImageIcon className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {it.senderDisplayName ?? 'Thành viên'}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {it.mimeType ?? 'image'}
                    {it.fileWidth && it.fileHeight ? ` · ${it.fileWidth}x${it.fileHeight}` : ''}
                    {' · '}
                    {format(new Date(it.createdAt), 'HH:mm dd/MM')}
                  </p>
                </div>
                {it.presignedUrl && (
                  <a
                    href={it.presignedUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-xs text-primary hover:underline"
                  >
                    Xem
                  </a>
                )}
              </div>
            ))}
          </div>
        )}

        {cursor && !loading && (
          <Button
            variant="ghost"
            className="mt-2 w-full"
            onClick={() => void loadMore()}
            disabled={loadingMore}
          >
            {loadingMore && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Xem thêm
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── Shared bits ─────────────────────────────────────────────────────────────

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
      <Inbox className="h-8 w-8 opacity-60" />
      <span>{text}</span>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="flex flex-col gap-2 py-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-2">
          <div className="h-8 w-8 animate-pulse rounded-full bg-secondary" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-1/3 animate-pulse rounded bg-secondary" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-secondary" />
          </div>
        </div>
      ))}
    </div>
  );
}
