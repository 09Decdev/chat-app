import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface ChipOption {
  value: string;
  label: string;
  warning?: boolean;
  warningText?: string;
  disabled?: boolean;
}

export interface ChipGroupProps {
  options: ChipOption[];
  value?: string;
  onChange: (v: string) => void;
  ariaLabel: string;
  size?: 'default' | 'lg';
  className?: string;
}

/**
 * Chip group dạng radiogroup (UI-SPEC 1.4 #9) — touch target >= 44px (min-h-11).
 */
function ChipGroup({ options, value, onChange, ariaLabel, size = 'default', className }: ChipGroupProps) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn('flex flex-wrap gap-2', className)}>
      {options.map((opt) => {
        const active = opt.value === value;
        const chip = (
          <Button
            key={opt.value}
            type="button"
            variant={active ? 'default' : 'outline'}
            size={size === 'lg' ? 'lg' : 'default'}
            role="radio"
            aria-checked={active}
            aria-pressed={active}
            disabled={opt.disabled}
            className={cn('min-h-11', active && 'disabled:opacity-100')}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
            {opt.warning && <TriangleAlert className="h-4 w-4 text-warning" aria-hidden />}
          </Button>
        );
        if (opt.warning && opt.warningText) {
          return (
            <Tooltip key={opt.value}>
              <TooltipTrigger asChild>{chip}</TooltipTrigger>
              <TooltipContent>{opt.warningText}</TooltipContent>
            </Tooltip>
          );
        }
        return chip;
      })}
    </div>
  );
}

export { ChipGroup };
