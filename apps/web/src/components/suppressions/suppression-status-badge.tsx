import type { SuppressionStatus } from '@/lib/api-client';
import { cn } from '@/lib/cn';

export interface SuppressionStatusBadgeProps {
  readonly status: SuppressionStatus;
  readonly className?: string;
}

export function SuppressionStatusBadge({ status, className }: SuppressionStatusBadgeProps) {
  const isActive = status === 'active';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        isActive
          ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
          : 'bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)] border border-[var(--color-border-subtle)]',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 rounded-full',
          isActive ? 'bg-emerald-400' : 'bg-[var(--color-ink-muted)]',
        )}
      />
      {isActive ? 'Active' : 'Cleared'}
    </span>
  );
}
