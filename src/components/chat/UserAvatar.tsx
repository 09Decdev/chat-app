import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

function hueFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

function labelFor(name: string | null | undefined, id: string): string {
  if (name && name.trim()) return name.trim().charAt(0).toUpperCase();
  return id.charAt(0).toUpperCase() || '?';
}

interface Props {
  name: string | null | undefined;
  userId: string;
  url?: string | null;
  size?: 'sm' | 'md' | 'lg';
  ring?: boolean;
  className?: string;
}

const sizeCls: Record<NonNullable<Props['size']>, string> = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-12 w-12 text-base',
};

export function UserAvatar({ name, userId, url, size = 'md', ring, className }: Props) {
  const hue = hueFor(userId || 'x');
  return (
    <Avatar className={cn(sizeCls[size], ring && 'ring-2 ring-background', className)}>
      {url && <AvatarImage src={url} alt={name ?? 'avatar'} loading="lazy" />}
      <AvatarFallback
        style={{
          backgroundImage: `linear-gradient(135deg, hsl(${hue} 72% 56%), hsl(${(hue + 45) % 360} 68% 46%))`,
        }}
        className="font-semibold text-white"
      >
        {labelFor(name, userId)}
      </AvatarFallback>
    </Avatar>
  );
}
