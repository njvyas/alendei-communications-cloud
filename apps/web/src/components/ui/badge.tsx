import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '@/lib/cn';

/**
 * Badge and StatusBadge (U15.1 specification §5.4, §2.4).
 *
 * Text is normal text under WCAG 1.4.3 (12px semibold is not "large"), so every
 * variant meets >= 4.5:1: semantic variants use the refined `--acc-*-text` tokens on
 * the preserved subtle fills; `neutral` and `accent` use primary text (the light
 * secondary text would be 4.44:1 on the raised fill). StatusBadge never relies on
 * colour alone (WCAG 1.4.1): it shows a distinct shape and visible text, with a
 * screen-reader prefix.
 */

export type BadgeVariant = 'success' | 'warning' | 'error' | 'accent' | 'neutral';

const VARIANT_CLASSES: Record<BadgeVariant, string> = {
  success: 'bg-acc-success-subtle text-acc-success-text',
  warning: 'bg-acc-warning-subtle text-acc-warning-text',
  error: 'bg-acc-error-subtle text-acc-error-text',
  accent: 'bg-acc-accent-subtle text-acc-text-primary',
  neutral: 'bg-acc-surface-raised text-acc-text-primary',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly variant?: BadgeVariant;
  readonly icon?: ReactNode;
}

export function Badge({ variant = 'neutral', icon, className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs leading-5 font-semibold',
        VARIANT_CLASSES[variant],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </span>
  );
}

/** Distinct glyphs per status, so meaning survives without colour. */
function StatusGlyph({ variant }: { readonly variant: BadgeVariant }) {
  const common = {
    viewBox: '0 0 12 12',
    className: 'size-3 shrink-0',
    'aria-hidden': true,
  } as const;
  switch (variant) {
    case 'success':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m2.5 6.5 2.2 2.2 4.8-5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'warning':
      return (
        <svg {...common} fill="currentColor">
          <path d="M6 1.5 11 10.5H1L6 1.5Z" />
        </svg>
      );
    case 'error':
      return (
        <svg {...common} fill="none" stroke="currentColor" strokeWidth="2">
          <path d="m3 3 6 6M9 3 3 9" strokeLinecap="round" />
        </svg>
      );
    case 'accent':
      return (
        <svg {...common} fill="currentColor">
          <rect x="2" y="2" width="8" height="8" rx="1" transform="rotate(45 6 6)" />
        </svg>
      );
    default:
      return (
        <svg {...common} fill="currentColor">
          <circle cx="6" cy="6" r="3.5" />
        </svg>
      );
  }
}

export interface StatusBadgeProps extends Omit<BadgeProps, 'icon' | 'children'> {
  readonly label: string;
  /** Screen-reader prefix announced before the label. */
  readonly srPrefix?: string;
}

export function StatusBadge({
  variant = 'neutral',
  label,
  srPrefix = 'Status',
  ...props
}: StatusBadgeProps) {
  return (
    <Badge variant={variant} icon={<StatusGlyph variant={variant} />} {...props}>
      <span className="sr-only">{srPrefix}: </span>
      {label}
    </Badge>
  );
}
