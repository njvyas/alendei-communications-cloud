'use client';

export interface ActionFeedbackMessage {
  readonly type: 'success' | 'error' | 'info';
  readonly title?: string;
  readonly message: string;
  readonly code?: string;
  readonly correlationId?: string;
}

export interface ActionFeedbackProps {
  readonly feedback: ActionFeedbackMessage | null;
  readonly onDismiss?: () => void;
  readonly className?: string;
}

export function ActionFeedback({ feedback, onDismiss, className = '' }: ActionFeedbackProps) {
  if (!feedback) return null;

  const isSuccess = feedback.type === 'success';
  const isError = feedback.type === 'error';

  const toneClass = isSuccess
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
    : isError
      ? 'border-rose-500/30 bg-rose-500/10 text-rose-400'
      : 'border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink)]';

  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live="polite"
      className={`rounded-lg border p-3.5 text-xs transition-all ${toneClass} ${className}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          {feedback.title && <p className="font-semibold">{feedback.title}</p>}
          <p className="leading-relaxed">{feedback.message}</p>
          {(feedback.code || feedback.correlationId) && (
            <div className="flex flex-wrap items-center gap-2 pt-1 font-mono text-[10px] opacity-75">
              {feedback.code && <span>Code: {feedback.code}</span>}
              {feedback.correlationId && <span>Ref: {feedback.correlationId}</span>}
            </div>
          )}
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss notification"
            className="rounded p-1 hover:bg-black/10 focus:outline-none focus:ring-1 focus:ring-current"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
