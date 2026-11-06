import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

/**
 * StatCard (U15.1 specification §5.5): a metric tile that only displays the value it
 * is given. There are no defaults, samples or placeholders that look like data:
 * loading shows a skeleton (announced as busy), a missing value shows an em dash
 * announced as "No data", and an error shows "Unavailable".
 */
export interface StatCardProps {
  readonly label: string;
  /** The real value from the backend; `null`/`undefined` means "no data". */
  readonly value: number | string | null | undefined;
  readonly isLoading?: boolean;
  readonly error?: boolean;
  /** Formats numeric values (default: locale grouping). */
  readonly format?: (value: number) => string;
  readonly description?: ReactNode;
  readonly icon?: ReactNode;
  readonly className?: string;
}

export function StatCard({
  label,
  value,
  isLoading = false,
  error = false,
  format = (v) => v.toLocaleString(),
  description,
  icon,
  className,
}: StatCardProps) {
  let body: ReactNode;
  if (isLoading) {
    body = (
      <span className="mt-2 block h-8 w-24 animate-pulse rounded-md bg-acc-surface-raised motion-reduce:animate-none">
        <span className="sr-only">Loading {label}</span>
      </span>
    );
  } else if (error) {
    body = <span className="mt-2 block text-sm font-medium text-acc-error-text">Unavailable</span>;
  } else if (value === null || value === undefined || value === '') {
    body = (
      <span className="mt-2 block text-2xl font-semibold text-acc-text-secondary">
        <span aria-hidden="true">—</span>
        <span className="sr-only">No data</span>
      </span>
    );
  } else {
    body = (
      <span className="mt-2 block text-2xl font-semibold tabular-nums text-acc-text-primary">
        {typeof value === 'number' ? format(value) : value}
      </span>
    );
  }
  return (
    <section
      aria-busy={isLoading || undefined}
      className={cn('rounded-xl border border-acc-border bg-acc-card p-5', className)}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-medium text-acc-text-secondary">{label}</h3>
        {icon && (
          <span aria-hidden="true" className="text-acc-primary">
            {icon}
          </span>
        )}
      </div>
      {body}
      {description && <p className="mt-1 text-xs text-acc-text-secondary">{description}</p>}
    </section>
  );
}
