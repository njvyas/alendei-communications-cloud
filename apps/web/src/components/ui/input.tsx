'use client';

import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';

import { cn } from '@/lib/cn';

/**
 * Text inputs (U15.1 specification §5.2).
 *
 * - Every input has a programmatic label (visible by default; `hideLabel` keeps it
 *   for assistive technology only).
 * - The boundary uses `--acc-border-input` (>= 3:1 against card and canvas in both
 *   themes, WCAG 1.4.11); focus adds the 2px primary outline.
 * - With `error`, the input gets `aria-invalid="true"`, an error border with a 3px
 *   subtle ring, and the message (`role="alert"`) is referenced by `aria-describedby`
 *   together with any helper text.
 */

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'prefix'> {
  readonly label: string;
  readonly hideLabel?: boolean;
  readonly helperText?: ReactNode;
  readonly error?: ReactNode;
  readonly prefixIcon?: ReactNode;
  readonly suffix?: ReactNode;
  readonly containerClassName?: string;
}

const fieldClass = [
  'block h-[38px] w-full min-w-0 rounded-lg border bg-acc-card px-3 text-sm text-acc-text-primary',
  'placeholder:text-acc-text-secondary',
  'transition-[border-color,box-shadow] duration-100',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc-primary',
  'disabled:cursor-not-allowed disabled:bg-acc-surface-raised disabled:text-acc-text-muted',
].join(' ');

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    hideLabel = false,
    helperText,
    error,
    prefixIcon,
    suffix,
    id,
    className,
    containerClassName,
    'aria-describedby': describedBy,
    ...props
  },
  ref,
) {
  const generated = useId();
  const inputId = id ?? `input-${generated}`;
  const helperId = helperText ? `${inputId}-helper` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedByIds = [describedBy, errorId, helperId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', containerClassName)}>
      <label
        htmlFor={inputId}
        className={cn('text-sm font-medium text-acc-text-primary', hideLabel && 'sr-only')}
      >
        {label}
      </label>
      <div className="relative flex items-center">
        {prefixIcon && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-3 flex text-acc-text-secondary"
          >
            {prefixIcon}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedByIds}
          className={cn(
            fieldClass,
            error
              ? 'border-acc-error shadow-[0_0_0_3px_var(--acc-error-subtle)]'
              : 'border-acc-border-input',
            prefixIcon && 'pl-9',
            suffix && 'pr-10',
            className,
          )}
          {...props}
        />
        {suffix && <span className="absolute right-1 flex items-center">{suffix}</span>}
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-xs font-medium text-acc-error-text">
          {error}
        </p>
      )}
      {helperText && (
        <p id={helperId} className="text-xs text-acc-text-secondary">
          {helperText}
        </p>
      )}
    </div>
  );
});

function EyeIcon({ crossed }: { readonly crossed: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {crossed && <path d="M3 3l18 18" strokeLinecap="round" />}
    </svg>
  );
}

export type PasswordInputProps = Omit<InputProps, 'type' | 'suffix'>;

/**
 * Password input with a show/hide toggle. Deviation from the specification's
 * `tabIndex={-1}`: the toggle stays in the tab order, otherwise keyboard users
 * could not reveal the password (WCAG 2.1.1). Its state is exposed by `aria-pressed`.
 */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ disabled, ...props }, ref) {
    const [visible, setVisible] = useState(false);
    return (
      <Input
        ref={ref}
        type={visible ? 'text' : 'password'}
        autoComplete="current-password"
        disabled={disabled}
        suffix={
          <button
            type="button"
            disabled={disabled}
            aria-label="Show password"
            aria-pressed={visible}
            onClick={() => setVisible((v) => !v)}
            className="inline-flex size-8 items-center justify-center rounded-md text-acc-text-secondary hover:bg-acc-surface-raised hover:text-acc-text-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-acc-primary disabled:text-acc-text-muted"
          >
            <EyeIcon crossed={visible} />
          </button>
        }
        {...props}
      />
    );
  },
);

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" strokeLinecap="round" />
    </svg>
  );
}

export type SearchInputProps = Omit<InputProps, 'type' | 'prefixIcon'>;

/** Search field (`type="search"`, implicit searchbox role) with a decorative icon. */
export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  function SearchInput(props, ref) {
    return <Input ref={ref} type="search" prefixIcon={<SearchIcon />} {...props} />;
  },
);
