import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

/**
 * Empty state (U15.1 specification §5.8): centred decorative graphic, title,
 * explanation and an optional primary action supplied by the caller (for example a
 * Button). The graphic is decorative (`aria-hidden`); the text carries the meaning.
 */
export interface EmptyStateProps {
  readonly title: string;
  readonly description?: ReactNode;
  readonly icon?: ReactNode;
  readonly action?: ReactNode;
  /** Heading level of the title (default 3). */
  readonly headingLevel?: 2 | 3 | 4;
  readonly className?: string;
}

function DefaultGraphic() {
  return (
    <svg viewBox="0 0 64 64" className="size-14" fill="none" aria-hidden="true">
      <rect
        x="8"
        y="14"
        width="48"
        height="36"
        rx="6"
        className="fill-acc-surface-raised stroke-acc-border-strong"
        strokeWidth="2"
      />
      <path d="M8 24h48" className="stroke-acc-border-strong" strokeWidth="2" />
      <circle cx="32" cy="38" r="6" className="stroke-acc-primary" strokeWidth="2.5" />
      <path
        d="m36.5 42.5 5 5"
        className="stroke-acc-primary"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  headingLevel = 3,
  className,
}: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div
      className={cn(
        'mx-auto flex max-w-md flex-col items-center px-6 py-10 text-center',
        className,
      )}
    >
      <span aria-hidden="true" className="mb-4 flex">
        {icon ?? <DefaultGraphic />}
      </span>
      <Heading className="text-base font-semibold text-acc-text-primary">{title}</Heading>
      {description && <p className="mt-1.5 text-sm text-acc-text-secondary">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
