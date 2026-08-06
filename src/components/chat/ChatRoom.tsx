import { RoomHeader } from './RoomHeader';
import { MemberBar } from './MemberBar';
import { TopicStrip } from './TopicStrip';
import { VoteKickDialog } from './VoteKickDialog';
import { TopicEditSheet } from './TopicEditSheet';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';

export function ChatRoom() {
  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col">
      <RoomHeader />
      <MemberBar />
      <TopicStrip />
      <VoteKickDialog />
      <TopicEditSheet />
      <MessageList />
      <MessageInput />
    </div>
  );
}
