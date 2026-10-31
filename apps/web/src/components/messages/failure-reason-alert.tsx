import React from 'react';
import { formatFailureReason, type FailureReasonDetails } from '../../lib/failure-reasons';

export interface FailureReasonAlertProps {
  readonly failureReason: string | null | undefined;
  readonly className?: string;
}

/**
 * Renders a structured, actionable guidance card for message and attempt failure reasons (U5).
 * Replaces raw machine error codes with user-friendly explanations and next steps.
 */
export function FailureReasonAlert({ failureReason, className = '' }: FailureReasonAlertProps) {
  const formatted: FailureReasonDetails | null = formatFailureReason(failureReason);

  if (!formatted) {
    return null;
  }

  const isWarning = formatted.severity === 'warning';
  const borderClass = isWarning ? 'border-amber-500/30' : 'border-rose-500/30';
  const bgClass = isWarning ? 'bg-amber-500/10' : 'bg-rose-500/10';
  const textClass = isWarning ? 'text-amber-400' : 'text-rose-400';
  const titleClass = isWarning ? 'text-amber-300' : 'text-rose-300';
  const actionBorder = isWarning ? 'border-amber-500/20' : 'border-rose-500/20';

  return (
    <div
      className={`rounded-lg border ${borderClass} ${bgClass} p-3.5 text-xs ${className}`}
      role="alert"
      aria-label={`Dispatch failure: ${formatted.title}`}
      data-testid="failure-reason-alert"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className={`font-semibold ${titleClass}`}>{formatted.title}</span>
            <span
              className="rounded bg-[var(--color-surface)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-ink-muted)] border border-[var(--color-border-subtle)]"
              title={`Technical failure code: ${formatted.code}`}
              data-testid="failure-code-badge"
            >
              {formatted.code}
            </span>
          </div>
          <p className={`mt-1 text-[11px] leading-relaxed ${textClass}`}>{formatted.description}</p>
        </div>
      </div>

      {formatted.action && (
        <div
          className={`mt-2.5 rounded border ${actionBorder} bg-[var(--color-surface)]/60 p-2.5 text-[11px]`}
        >
          <span className="font-medium text-[var(--color-ink)]">What to do next: </span>
          <span className="text-[var(--color-ink-muted)]">{formatted.action}</span>
        </div>
      )}
    </div>
  );
}
