/**
 * ComboBox — ô nhập "sổ ra để chọn" cho TicketRegisterPage (dropdown có tìm kiếm).
 * Dùng component UI kit có sẵn: Dialog + Input + Button + Badge + ScrollArea.
 *
 * 2 chế độ:
 * - `allowCustom=false` (chọn từ danh sách): click trigger → dialog, gõ lọc, bấm chọn.
 * - `allowCustom=true` (chọn HOẶC tự nhập): input luôn giữ value — gõ tự do vẫn có giá trị,
 *   chọn từ list sẽ fill value chính xác (dùng cho Event/Ticket Type khi nguồn chưa có/ít).
 *
 * A11y: trigger là button có aria-haspopup+expanded; dialog searchbox có aria-label;
 * từng option là button có aria-pressed. Giữ tiếng Việt cho mọi text hiển thị.
 */
import { useState } from 'react';
import { RefreshCw, Search, Loader2, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export interface ComboBoxOption {
  value: string;
  label: string;
  /** Dòng phụ (vd "20k users • gateway ..." hoặc "còn 34 vé • 250.000đ"). */
  hint?: string;
  /** Badge màu phụ (vd trạng thái event). */
  badge?: string;
}

export interface ComboBoxProps {
  /** Giá trị hiện tại (id/tệp). */
  value: string;
  onValueChange: (v: string) => void;
  options: ComboBoxOption[];
  /** Nhãn dùng cho aria-label + dialog title. */
  label: string;
  id?: string;
  placeholder?: string;
  /** false = bắt buộc chọn từ list; true = gõ tự do vẫn giữ value. */
  allowCustom?: boolean;
  disabled?: boolean;
  loading?: boolean;
  error?: string | null;
  emptyText?: string;
  /** Nút tải lại dữ liệu nguồn. */
  onRefresh?: () => void;
  /** Gọi mỗi lần dialog mở — lazy-load nguồn dữ liệu (events/ticket types). */
  onOpen?: () => void;
  className?: string;
}

export function ComboBox({
  value,
  onValueChange,
  options,
  label,
  id,
  placeholder = 'Chọn…',
  allowCustom = false,
  disabled = false,
  loading = false,
  error = null,
  emptyText = 'Không có lựa chọn phù hợp.',
  onRefresh,
  onOpen,
  className,
}: ComboBoxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const keyOf = (v: string) => options.find((o) => o.value === v);
  const selected = keyOf(value);

  const requestOpen = () => {
    if (disabled) return;
    setOpen((prev) => {
      if (!prev) onOpen?.();
      return true;
    });
  };

  const openDialog = () => {
    setSearch(allowCustom ? value : (selected?.label ?? ''));
    requestOpen();
  };

  const q = search.trim().toLowerCase();
  const matched =
    q === ''
      ? options
      : options.filter(
          (o) =>
            o.label.toLowerCase().includes(q) ||
            o.value.toLowerCase().includes(q) ||
            (o.hint ?? '').toLowerCase().includes(q),
        );

  const pick = (v: string) => {
    onValueChange(v);
    setOpen(false);
  };

  return (
    <div className={cn('w-full', className)}>
      {/* Trigger — nhìn như Input (cùng chiều cao/viền) nhưng là button */}
      {allowCustom ? (
        <div className="relative">
          <Input
            id={id}
            value={value}
            disabled={disabled}
            aria-label={label}
            placeholder={placeholder}
            onChange={(e) => onValueChange(e.target.value)}
            className="font-mono text-sm pr-9"
          />
          <button
            type="button"
            aria-label={`Mở danh sách ${label}`}
            aria-haspopup="dialog"
            aria-expanded={open}
            disabled={disabled}
            onClick={openDialog}
            className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-9 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
          >
            <ChevronsUpDown className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ) : (
        <button
          id={id}
          type="button"
          disabled={disabled}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={openDialog}
          className={cn(
            'flex h-11 w-full items-center justify-between gap-2 rounded-md border border-input bg-background/40 px-3 py-2 text-sm transition-colors',
            'placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.label : (placeholder || 'Chọn…')}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="text-base">{label}</DialogTitle>
          </DialogHeader>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              autoFocus
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                if (allowCustom) onValueChange(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && allowCustom) setOpen(false);
              }}
              aria-label={`Tìm ${label}`}
              placeholder={allowCustom ? `Gõ mã hoặc tìm — chọn từ danh sách…` : `Tìm ${label.toLowerCase()}…`}
              className="pl-9 font-mono text-sm"
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">{loading ? 'Đang tải…' : `${matched.length} lựa chọn`}</p>
            )}
            {onRefresh && (
              <Button type="button" variant="ghost" size="sm" className="min-h-8 h-8 gap-1" onClick={onRefresh} disabled={loading}>
                <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden />
                Tải lại
              </Button>
            )}
          </div>

          <ScrollArea className="max-h-72">
            {loading ? (
              <div className="flex items-center gap-2 px-1 py-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Đang tải dữ liệu…
              </div>
            ) : matched.length === 0 ? (
              <p className="px-1 py-3 text-sm text-muted-foreground">{emptyText}</p>
            ) : (
              <ul className="space-y-1 p-0.5">
                {matched.map((o) => {
                  const isSel = o.value === value;
                  return (
                    <li key={o.value}>
                      <button
                        type="button"
                        onClick={() => pick(o.value)}
                        aria-pressed={isSel}
                        className={cn(
                          'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors',
                          'hover:bg-secondary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          isSel && 'bg-secondary',
                        )}
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{o.label}</span>
                          {o.hint && <span className="truncate font-mono text-xs text-muted-foreground">{o.hint}</span>}
                        </span>
                        {o.badge && (
                          <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
                            {o.badge}
                          </Badge>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}