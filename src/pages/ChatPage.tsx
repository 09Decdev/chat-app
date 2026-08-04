import { useEffect } from 'react';
import { Phone } from 'lucide-react';
import { useChatStore } from '@/store/chat.store';
import { StartScreen } from '@/components/chat/StartScreen';
import { MatchingScreen } from '@/components/chat/MatchingScreen';
import { ChatRoom } from '@/components/chat/ChatRoom';
import { Button } from '@/components/ui/button';

export default function ChatPage() {
  const phase = useChatStore((s) => s.phase);
  const init = useChatStore((s) => s.init);
  const requirePhoneVerify = useChatStore((s) => s.requirePhoneVerify);

  useEffect(() => {
    void init();
  }, [init]);

  if (requirePhoneVerify) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="max-w-sm text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/15">
            <Phone className="h-7 w-7 text-amber-400" />
          </div>
          <h2 className="text-lg font-semibold">Can xac minh so dien thoai</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            De su dung chat ban can xac minh so dien thoai. Vui long hoan thanh tai ung dung
            chinh, sau do thu lai.
          </p>
          <Button
            variant="outline"
            className="mt-5"
            onClick={() => useChatStore.setState({ requirePhoneVerify: false })}
          >
            Thu lai
          </Button>
        </div>
      </div>
    );
  }

  if (phase === 'matching' || phase === 'matched') return <MatchingScreen />;
  if (phase === 'in_room') return <ChatRoom />;
  return <StartScreen />;
}
