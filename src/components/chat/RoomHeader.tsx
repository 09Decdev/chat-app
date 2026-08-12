import { useEffect, useState } from 'react';
import { LogOut, Wifi, WifiOff, Hash, Clock, Search } from 'lucide-react';
import { useChatStore } from '@/store/chat.store';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { RoomSearchPanel } from './RoomSearchPanel';

/** VÁ-4: countdown còn lại của phòng từ roomEndsAt (epoch ms) — không tính TTL, chống trôi đồng hồ. */
function useRoomCountdown(endsAt: number | null) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!endsAt) return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [endsAt]);
  if (!endsAt) return null;
  const remain = Math.max(0, endsAt - Date.now());
  const h = Math.floor(remain / 3600000);
  const m = Math.floor((remain % 3600000) / 60000);
  const s = Math.floor((remain % 60000) / 1000);
  return h > 0 ? `${h}h${m.toString().padStart(2, '0')}` : `${m}:${s.toString().padStart(2, '0')}`;
}

export function RoomHeader() {
  const roomId = useChatStore((s) => s.roomId);
  const roomEndsAt = useChatStore((s) => s.roomEndsAt);
  const connected = useChatStore((s) => s.socketConnected);
  const memberCount = useChatStore((s) => s.members.length);
  const leave = useChatStore((s) => s.leaveRoom);
  const [open, setOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const roomRemaining = useRoomCountdown(roomEndsAt);

  return (
    <div className="flex items-center gap-3 border-b border-border/60 bg-card/40 px-4 py-3 backdrop-blur">
      <div className="brand-gradient flex h-10 w-10 items-center justify-center rounded-xl shadow-lg shadow-primary/20">
        <Hash className="h-5 w-5 text-white" />
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold">
          Phong {roomId ? roomId.slice(0, 8) : '---'}
        </p>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          {connected ? (
            <Wifi className="h-3 w-3 text-emerald-400" />
          ) : (
            <WifiOff className="h-3 w-3 animate-pulse text-amber-400" />
          )}
          {connected ? 'Dang ket noi' : 'Dang ket noi lai...'} &middot; {memberCount} thanh vien
          {roomRemaining !== null && (
            <>
              {' '}
              &middot; <Clock className="h-3 w-3" />
              <span className="tabular-nums">{roomRemaining}</span>
            </>
          )}
        </p>
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => setPanelOpen(true)}
        disabled={!roomId}
        title="Tìm tin nhắn / xem ảnh & file trong phòng"
      >
        <Search className="h-4 w-4" /> Tìm / Ảnh
      </Button>
      <RoomSearchPanel open={panelOpen} onOpenChange={setPanelOpen} />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <LogOut className="h-4 w-4" /> Roi phong
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Roi phong?</DialogTitle>
            <DialogDescription>
              Ban se bi khoa 15 phut truoc khi duoc ghep phong moi, va khong the quay lai phong nay.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Huy</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                leave();
                setOpen(false);
              }}
            >
              Xac nhan roi
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
