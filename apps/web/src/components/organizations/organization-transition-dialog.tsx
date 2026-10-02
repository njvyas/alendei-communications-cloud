'use client';

import { useState, useEffect, type FormEvent } from 'react';
import { ApiError, organizationsApi, type OrganizationView } from '@/lib/api-client';

export type OrganizationLifecycleAction = 'suspend' | 'reactivate' | 'close';

interface OrganizationTransitionDialogProps {
  readonly isOpen: boolean;
  readonly organization: OrganizationView | null;
  readonly action: OrganizationLifecycleAction;
  readonly onClose: () => void;
  readonly onSuccess: (org: OrganizationView) => void;
}

const ACTION_TITLES: Record<OrganizationLifecycleAction, string> = {
  suspend: 'Suspend Organization',
  reactivate: 'Reactivate Organization',
  close: 'Close Organization (Terminal)',
};

export function OrganizationTransitionDialog({
  isOpen,
  organization,
  action,
  onClose,
  onSuccess,
}: OrganizationTransitionDialogProps) {
  const [reason, setReason] = useState('');
  const [confirmSlug, setConfirmSlug] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setReason('');
      setConfirmSlug('');
      setIsSubmitting(false);
      setErrorMessage(null);
    }
  }, [isOpen, action]);

  if (!isOpen || !organization) return null;

  const isClose = action === 'close';
  const requiresSlugConfirmation = isClose;
  const isSlugConfirmed = !requiresSlugConfirmation || confirmSlug === organization.slug;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isSlugConfirmed) return;

    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      let res;
      if (action === 'suspend') {
        res = await organizationsApi.suspend(organization.id, reason.trim() || undefined);
      } else if (action === 'reactivate') {
        res = await organizationsApi.reactivate(organization.id, reason.trim() || undefined);
      } else {
        res = await organizationsApi.close(organization.id, reason.trim() || undefined);
      }

      onSuccess(res.data);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setErrorMessage(
            `Lifecycle conflict: organization is currently in status "${organization.status}".`,
          );
        } else if (err.status === 403) {
          setErrorMessage(
            'You do not have permission to execute this platform lifecycle transition.',
          );
        } else {
          setErrorMessage(err.message);
        }
      } else {
        setErrorMessage('Failed to transition organization status. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="transition-org-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl">
        <h2
          id="transition-org-title"
          className="text-lg font-semibold tracking-tight text-[var(--color-ink)]"
        >
          {ACTION_TITLES[action]}
        </h2>

        {isClose ? (
          <div className="mt-3 rounded-md border border-[var(--color-bad)]/30 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]">
            <p className="font-semibold">Terminal Lifecycle Action</p>
            <p className="mt-1 text-[11px] leading-relaxed">
              Closing an organization is permanent and cannot be undone or reactivated. Existing
              data is retained for audit and compliance, but all tenant access, credentials, and
              mutations will cease immediately.
            </p>
          </div>
        ) : action === 'suspend' ? (
          <div className="mt-3 rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 p-3 text-xs text-[var(--color-warn)]">
            <p className="font-semibold">Operational Suspension</p>
            <p className="mt-1 text-[11px] leading-relaxed">
              Tenant members without platform grants will be refused selection and blocked from
              mutations. Organization API keys will immediately stop authenticating.
            </p>
          </div>
        ) : (
          <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
            Reactivating this organization will restore normal access for tenant members and resume
            API key authentication.
          </p>
        )}

        {errorMessage && (
          <div className="mt-4 rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label
              htmlFor="transition-reason"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Reason (Optional, max 500 characters)
            </label>
            <textarea
              id="transition-reason"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Provide a rationale for this lifecycle transition for the audit trail…"
              disabled={isSubmitting}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-2.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
            />
          </div>

          {requiresSlugConfirmation && (
            <div>
              <label
                htmlFor="confirm-slug"
                className="block text-xs font-medium text-[var(--color-bad)]"
              >
                Type organization slug{' '}
                <code className="font-mono font-bold">{organization.slug}</code> to confirm:
              </label>
              <input
                id="confirm-slug"
                type="text"
                value={confirmSlug}
                onChange={(e) => setConfirmSlug(e.target.value)}
                placeholder={organization.slug}
                disabled={isSubmitting}
                className="mt-1 block w-full font-mono rounded-md border border-[var(--color-bad)]/40 bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-bad)] disabled:opacity-50"
              />
            </div>
          )}

          <div className="mt-6 flex justify-end gap-2 pt-2 border-t border-[var(--color-border-subtle)]">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !isSlugConfirmed}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white transition-opacity disabled:opacity-50 ${
                isClose
                  ? 'bg-[var(--color-bad)] hover:opacity-90'
                  : action === 'suspend'
                    ? 'bg-[var(--color-warn)] hover:opacity-90'
                    : 'bg-[var(--color-accent)] hover:opacity-90'
              }`}
            >
              {isSubmitting ? (
                <>
                  <span className="size-3 animate-spin rounded-full border border-white border-t-transparent" />
                  Transitioning…
                </>
              ) : (
                ACTION_TITLES[action]
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
