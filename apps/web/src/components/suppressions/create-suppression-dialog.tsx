'use client';

import { useState } from 'react';
import { AccessibleDialog } from '@/components/ui/dialog';
import { ActionFeedback, type ActionFeedbackMessage } from '@/components/ui/action-feedback';
import { suppressionsApi, type ChannelView, type SuppressionResponse } from '@/lib/api-client';
import { humanizeApiError } from '@/lib/error-mapping';

export interface CreateSuppressionDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSuccess: (suppression: SuppressionResponse) => void;
  readonly channels?: readonly ChannelView[];
}

export function CreateSuppressionDialog({
  isOpen,
  onClose,
  onSuccess,
  channels = [],
}: CreateSuppressionDialogProps) {
  const [channelId, setChannelId] = useState<string>('');
  const [rawAddress, setRawAddress] = useState<string>('');
  const [reason, setReason] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<ActionFeedbackMessage | null>(null);

  // Selected channel metadata for helper text
  const selectedChannel = channels.find((c) => c.id === channelId);
  const isEmailChannel =
    selectedChannel?.code === 'email' || (!selectedChannel && rawAddress.includes('@'));

  const resetForm = () => {
    setChannelId('');
    setRawAddress('');
    setReason('');
    setFeedback(null);
    setIsSubmitting(false);
  };

  const handleClose = () => {
    if (isSubmitting) return;
    resetForm();
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFeedback(null);

    const trimmedAddress = rawAddress.trim();
    const trimmedReason = reason.trim();

    if (!trimmedAddress) {
      setFeedback({
        type: 'error',
        title: 'Validation Error',
        message: 'Recipient address is required.',
      });
      return;
    }

    if (trimmedAddress.length > 500) {
      setFeedback({
        type: 'error',
        title: 'Validation Error',
        message: 'Recipient address cannot exceed 500 characters.',
      });
      return;
    }

    if (!trimmedReason) {
      setFeedback({
        type: 'error',
        title: 'Validation Error',
        message: 'Suppression reason is required.',
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

    // Client-side format sanity check
    if (selectedChannel?.code === 'email' && !trimmedAddress.includes('@')) {
      setFeedback({
        type: 'error',
        title: 'Invalid Email Address',
        message: 'Email address must include "@" and a valid domain.',
      });
      return;
    }

    if (
      selectedChannel &&
      ['sms', 'whatsapp', 'rcs', 'voice'].includes(selectedChannel.code) &&
      !trimmedAddress.startsWith('+')
    ) {
      setFeedback({
        type: 'error',
        title: 'Missing Country Code',
        message:
          'Phone number must start with "+" and include a valid country code (E.164 format).',
      });
      return;
    }

    setIsSubmitting(true);
    // Generate fresh idempotency key per submission attempt
    const idempotencyKey = crypto.randomUUID();

    try {
      const response = await suppressionsApi.create(
        {
          channelId: channelId ? channelId : null,
          rawAddress: trimmedAddress,
          reason: trimmedReason,
        },
        idempotencyKey,
      );

      resetForm();
      onSuccess(response.data);
      onClose();
    } catch (err: unknown) {
      const humanized = humanizeApiError(
        err,
        'Failed to Add Suppression',
        'Could not create suppression. Please review your input and try again.',
      );

      // Check for details.existingSuppressionId in error
      let extraMessage = humanized.message;
      const details = (err as { details?: Record<string, unknown> })?.details;
      if (details?.existingSuppressionId && typeof details.existingSuppressionId === 'string') {
        extraMessage = `${humanized.message} (Existing ID: ${details.existingSuppressionId})`;
      }

      setFeedback({
        type: 'error',
        title: humanized.title,
        message: extraMessage,
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
      titleId="create-suppression-title"
      descriptionId="create-suppression-desc"
      maxWidth="max-w-md"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <h2
            id="create-suppression-title"
            className="text-base font-semibold text-[var(--color-ink)]"
          >
            Add Suppression
          </h2>
          <p id="create-suppression-desc" className="text-xs text-[var(--color-ink-muted)]">
            Manually suppress a recipient address to prevent outbound messages from being
            dispatched.
          </p>
        </div>

        <ActionFeedback feedback={feedback} onDismiss={() => setFeedback(null)} />

        <div className="space-y-3">
          <div>
            <label
              htmlFor="create-suppression-channel"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Channel Scope
            </label>
            <select
              id="create-suppression-channel"
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              disabled={isSubmitting}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink)] focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-50"
            >
              <option value="">All Channels (Organization-wide)</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName || c.code.toUpperCase()}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
              {channelId
                ? 'Suppression applies only to dispatches on this channel.'
                : 'Organization-wide suppression applies across all communication channels.'}
            </p>
          </div>

          <div>
            <label
              htmlFor="create-suppression-address"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Recipient Address <span className="text-rose-400">*</span>
            </label>
            <input
              type="text"
              id="create-suppression-address"
              value={rawAddress}
              onChange={(e) => setRawAddress(e.target.value)}
              placeholder={isEmailChannel ? 'user@example.com' : '+12025550123'}
              disabled={isSubmitting}
              required
              maxLength={500}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 font-mono text-xs text-[var(--color-ink)] placeholder:font-sans placeholder:text-[var(--color-ink-muted)] focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-50"
            />
            <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
              {selectedChannel?.code === 'email'
                ? 'Standard email format (RFC 5322).'
                : selectedChannel
                  ? 'Standard E.164 phone format (+ followed by country code and digits).'
                  : 'Phone numbers must be E.164 (e.g. +12025550123); emails must include @.'}
            </p>
          </div>

          <div>
            <label
              htmlFor="create-suppression-reason"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Suppression Reason <span className="text-rose-400">*</span>
            </label>
            <textarea
              id="create-suppression-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g., Customer requested opt-out via support ticket #1234"
              rows={3}
              disabled={isSubmitting}
              required
              maxLength={500}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder:text-[var(--color-ink-muted)] focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 disabled:opacity-50"
            />
            <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
              1–500 characters. Recorded in audit history (without sensitive recipient data).
            </p>
          </div>
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
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50"
          >
            {isSubmitting ? 'Adding...' : 'Add Suppression'}
          </button>
        </div>
      </form>
    </AccessibleDialog>
  );
}
