'use client';

import { useState, useEffect, type FormEvent } from 'react';
import { ApiError, resellersApi, type ResellerView } from '@/lib/api-client';
import { useModalDialog } from '@/components/ui/dialog';
import { toast } from '@/lib/toast';

interface ResellerTransitionDialogProps {
  readonly isOpen: boolean;
  readonly reseller: ResellerView;
  readonly transition: 'suspend' | 'reactivate';
  readonly onClose: () => void;
  readonly onSuccess: (updated: ResellerView) => void;
}

export function ResellerTransitionDialog({
  isOpen,
  reseller,
  transition,
  onClose,
  onSuccess,
}: ResellerTransitionDialogProps) {
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setReason('');
      setIsSubmitting(false);
      setErrorMessage(null);
    }
  }, [isOpen]);

  const modal = useModalDialog(isOpen);

  if (!isOpen) return null;

  const isSuspend = transition === 'suspend';
  const title = isSuspend
    ? `Suspend Reseller: ${reseller.name}`
    : `Reactivate Reseller: ${reseller.name}`;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const trimmedReason = reason.trim() || undefined;
      const res = isSuspend
        ? await resellersApi.suspend(reseller.id, { reason: trimmedReason })
        : await resellersApi.reactivate(reseller.id, { reason: trimmedReason });

      toast.success(isSuspend ? 'Reseller suspended' : 'Reseller reactivated');
      onSuccess(res.data);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message || `Failed to ${transition} reseller`);
      } else {
        setErrorMessage('An unexpected error occurred. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="transition-reseller-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 focus:outline-none"
      {...modal.overlayProps(onClose, !isSubmitting)}
    >
      <div
        ref={modal.panelRef}
        tabIndex={-1}
        className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
          <h2
            id="transition-reseller-title"
            className="text-lg font-semibold text-[var(--color-ink)]"
          >
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        {errorMessage && (
          <div
            role="alert"
            className="mt-4 rounded-md border border-[var(--color-bad)] bg-[var(--color-bad-subtle,#fee2e2)] p-3 text-sm text-[var(--color-bad)]"
          >
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {isSuspend ? (
            <div className="rounded-md border border-[var(--color-warn)] bg-[var(--color-warn-subtle,#fef3c7)] p-3 text-sm text-[var(--color-ink)]">
              <p className="font-medium text-[var(--color-warn)]">Warning: Reseller Suspension</p>
              <p className="mt-1 text-xs">
                Suspending this reseller halts portal access and prevents onboarding of new customer
                organizations under this hierarchy.
              </p>
            </div>
          ) : (
            <div className="rounded-md border border-[var(--color-ok)] bg-[var(--color-ok-subtle,#dcfce7)] p-3 text-sm text-[var(--color-ink)]">
              <p className="font-medium text-[var(--color-ok)]">Reseller Reactivation</p>
              <p className="mt-1 text-xs">
                Reactivating restores active status and allows normal administration and customer
                management.
              </p>
            </div>
          )}

          <div>
            <label
              htmlFor="transition-reason"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Reason (Optional)
            </label>
            <textarea
              id="transition-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                isSuspend ? 'e.g. Terms compliance review' : 'e.g. Account reinstated after review'
              }
              disabled={isSubmitting}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-ink)] focus:border-[var(--color-primary)] focus:outline-none"
            />
          </div>

          <div className="mt-6 flex justify-end gap-3 border-t border-[var(--color-border-subtle)] pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-sm text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || (isSuspend && reseller.isPlatformDefault)}
              className={
                isSuspend
                  ? 'rounded-md bg-[var(--color-bad,#dc2626)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50'
                  : 'rounded-md bg-[var(--color-primary,#2563eb)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50'
              }
            >
              {isSubmitting
                ? 'Processing…'
                : isSuspend
                  ? 'Suspend Reseller'
                  : 'Reactivate Reseller'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
