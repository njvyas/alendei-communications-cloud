'use client';

import { useCallback, useState } from 'react';
import { AccessibleDialog } from '@/components/ui/dialog';
import { ActionFeedback, type ActionFeedbackMessage } from '@/components/ui/action-feedback';
import {
  ApiError,
  suppressionsApi,
  type ChannelView,
  type SuppressionResponse,
} from '@/lib/api-client';
import { humanizeApiError } from '@/lib/error-mapping';

export interface LiftSuppressionDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSuccess: (suppression: SuppressionResponse) => void;
  readonly onConflict?: (suppression: SuppressionResponse, error: ApiError) => void;
  readonly suppression: SuppressionResponse | null;
  readonly channels?: readonly ChannelView[];
}

export function LiftSuppressionDialog({
  isOpen,
  onClose,
  onSuccess,
  onConflict,
  suppression,
  channels = [],
}: LiftSuppressionDialogProps) {
  const [reason, setReason] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<ActionFeedbackMessage | null>(null);

  const resetForm = useCallback(() => {
    setReason('');
    setFeedback(null);
    setIsSubmitting(false);
  }, []);

  const handleClose = useCallback(() => {
    if (isSubmitting) return;
    resetForm();
    onClose();
  }, [isSubmitting, resetForm, onClose]);

  if (!suppression) return null;

  const resolvedChannel = suppression.channelId
    ? (channels.find((c) => c.id === suppression.channelId)?.displayName ??
      channels.find((c) => c.id === suppression.channelId)?.code ??
      suppression.channelId)
    : 'All Channels (Organization-wide)';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);

    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      setFeedback({
        type: 'error',
        title: 'Validation Error',
        message: 'Reason for lifting the suppression is required.',
      });
      return;
    }

    if (trimmedReason.length > 500) {
      setFeedback({
        type: 'error',
        title: 'Validation Error',
        message: 'Reason cannot exceed 500 characters.',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await suppressionsApi.lift(suppression.id, {
        reason: trimmedReason,
      });

      resetForm();
      onSuccess(response.data);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === 'SUPPRESSION_LIFECYCLE_CONFLICT') {
        resetForm();
        onConflict?.(suppression, err);
        onClose();
        return;
      }

      const humanized = humanizeApiError(
        err,
        'Failed to Lift Suppression',
        'Could not lift suppression. Please try again.',
      );

      setFeedback({
        type: 'error',
        title: humanized.title,
        message: humanized.message,
        code: humanized.code,
        correlationId: humanized.correlationId,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AccessibleDialog
      isOpen={isOpen}
      onClose={handleClose}
      titleId="lift-suppression-title"
      dismissible={!isSubmitting}
      descriptionId="lift-suppression-desc"
      maxWidth="max-w-md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <h2
            id="lift-suppression-title"
            className="text-base font-semibold text-[var(--color-ink)]"
          >
            Lift Suppression
          </h2>
          <p id="lift-suppression-desc" className="text-xs text-[var(--color-ink-muted)]">
            Re-enable outbound message dispatch to this recipient.
          </p>
        </div>

        <ActionFeedback feedback={feedback} onDismiss={() => setFeedback(null)} />

        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
          <p className="font-medium">Important Confirmation</p>
          <p className="mt-1 opacity-90">
            Lifting this suppression will allow future campaigns and messages to reach this
            recipient address. Suppressions are never deleted; this action marks the record as
            cleared.
          </p>
        </div>

        <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 text-xs">
          <div className="space-y-1.5">
            <div>
              <span className="text-[var(--color-ink-muted)]">Address: </span>
              <span className="font-mono font-medium text-[var(--color-ink)] break-all">
                {suppression.rawAddress}
              </span>
            </div>
            <div>
              <span className="text-[var(--color-ink-muted)]">Scope: </span>
              <span className="font-medium text-[var(--color-ink)]">{resolvedChannel}</span>
            </div>
            <div>
              <span className="text-[var(--color-ink-muted)]">Original Reason: </span>
              <span className="text-[var(--color-ink)] italic break-words">
                &ldquo;{suppression.reason}&rdquo;
              </span>
            </div>
          </div>
        </div>

        <div>
          <label
            htmlFor="lift-suppression-reason"
            className="block text-xs font-medium text-[var(--color-ink)]"
          >
            Justification Reason <span className="text-rose-400">*</span>
          </label>
          <textarea
            id="lift-suppression-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g., Customer opted back in via support ticket #1234"
            rows={3}
            disabled={isSubmitting}
            required
            maxLength={500}
            className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder:text-[var(--color-ink-muted)] focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 disabled:opacity-50"
          />
          <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
            1–500 characters. Recorded in audit history as clearedReason.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-3">
          <button
            type="button"
            onClick={handleClose}
            disabled={isSubmitting}
            className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isSubmitting}
            className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-50"
          >
            {isSubmitting ? 'Lifting...' : 'Confirm Lift'}
          </button>
        </div>
      </form>
    </AccessibleDialog>
  );
}
