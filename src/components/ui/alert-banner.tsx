import { CircleAlert, TriangleAlert, Info, CircleCheck, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type AlertVariant = 'destructive' | 'warning' | 'info' | 'success';

export interface AlertBannerProps {
  variant: AlertVariant;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  dismissible?: boolean;
  onDismiss?: () => void;
  className?: string;
}

const styles: Record<AlertVariant, { box: string; icon: React.ReactNode }> = {
  destructive: {
    box: 'border-destructive/40 bg-destructive/10 text-destructive',
    icon: <CircleAlert className="h-4 w-4 shrink-0" aria-hidden />,
  },
  warning: {
    box: 'border-warning/40 bg-warning/10 text-warning',
    icon: <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden />,
  },
  info: {
    box: 'border-info/40 bg-info/10 text-info',
    icon: <Info className="h-4 w-4 shrink-0" aria-hidden />,
  },
  success: {
    box: 'border-success/40 bg-success/10 text-success',
    icon: <CircleCheck className="h-4 w-4 shrink-0" aria-hidden />,
  },
};

/**
 * Banner dính role="alert" (aria-live assertive) — UI-SPEC 1.4 #10.
 * Lỗi ảnh hưởng run KHÔNG dùng toast thoáng qua — phải là banner này.
 */
function AlertBanner({ variant, title, description, action, dismissible, onDismiss, className }: AlertBannerProps) {
  const s = styles[variant];
  return (
    <div
      role="alert"
      className={cn('flex items-start gap-2 rounded-lg border px-4 py-3', s.box, className)}
    >
      <span className="mt-0.5">{s.icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="mt-0.5 text-xs opacity-90">{description}</p>}
        {action && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="mt-1 h-9 px-0 text-current underline-offset-4 hover:underline"
            onClick={action.onClick}
          >
            {action.label}
          </Button>
        )}
      </div>
      {dismissible && onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Đóng cảnh báo"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-current opacity-70 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      )}
    </div>
  );
}

export { AlertBanner };
