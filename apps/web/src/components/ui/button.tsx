import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { cn } from '@/lib/cn';

/**
 * Button (U15.1 specification §5.1). Colours come only from `--acc-*` tokens:
 * `on-primary` / `on-destructive` encode the per-theme text rule (white in light,
 * #0D1222 in dark, where white on #8585FF would be 3.09:1).
 * Focus: 2px solid primary outline with a 2px offset (WCAG 1.4.11, 2.4.7, 2.4.13).
 */
export const buttonVariants = cva(
  [
    'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap select-none',
    'transition-[background-color,color,transform] duration-100 ease-out active:scale-[0.98]',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc-primary',
    'disabled:pointer-events-none disabled:active:scale-100',
    'aria-disabled:pointer-events-none',
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-acc-primary text-acc-on-primary hover:bg-acc-primary-hover disabled:bg-acc-surface-raised disabled:text-acc-text-muted',
        secondary:
          'bg-acc-accent text-acc-on-accent hover:bg-acc-accent-hover disabled:bg-acc-surface-raised disabled:text-acc-text-muted',
        outline:
          'border border-acc-border-input bg-transparent text-acc-text-primary hover:bg-acc-surface-raised disabled:border-acc-border disabled:text-acc-text-muted',
        ghost:
          'bg-transparent text-acc-primary hover:bg-acc-primary-subtle disabled:text-acc-text-muted',
        destructive:
          'bg-acc-destructive text-acc-on-destructive hover:bg-acc-destructive-hover disabled:bg-acc-surface-raised disabled:text-acc-text-muted',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-[38px] px-4 text-sm',
        lg: 'h-11 px-5 text-base',
        icon: 'size-[38px] p-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']>;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Disables the button, sets `aria-busy` and replaces the leading icon with a spinner. */
  readonly loading?: boolean;
  readonly leadingIcon?: ReactNode;
  readonly trailingIcon?: ReactNode;
}

export function Spinner({ className }: { readonly className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={cn('size-4 animate-spin motion-reduce:animate-none', className)}
      fill="none"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant,
    size,
    loading = false,
    leadingIcon,
    trailingIcon,
    disabled,
    className,
    children,
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {loading ? <Spinner /> : leadingIcon}
      {children !== undefined && (
        <span className={cn(loading && 'opacity-70 transition-opacity')}>{children}</span>
      )}
      {!loading && trailingIcon}
    </button>
  );
});

export interface IconButtonProps extends Omit<
  ButtonProps,
  'children' | 'size' | 'leadingIcon' | 'trailingIcon'
> {
  /** Required accessible name: an icon-only button has no visible text. */
  readonly label: string;
  readonly icon: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, loading, variant = 'ghost', ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      variant={variant}
      size="icon"
      loading={loading}
      aria-label={label}
      title={label}
      {...props}
    >
      {loading ? undefined : <span aria-hidden="true">{icon}</span>}
    </Button>
  );
});
