'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, providersApi, type ProviderDetailView } from '@/lib/api-client';
import type { ProviderTransition } from '@acc/contracts';

interface ProviderTransitionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderDetailView;
  transition: ProviderTransition;
}

const TRANSITION_DETAILS: Record<
  ProviderTransition,
  { title: string; actionLabel: string; description: string; confirmClass: string }
> = {
  enable: {
    title: 'Enable Provider',
    actionLabel: 'Enable Provider',
    description:
      'This provider will be marked as active and will immediately become eligible to receive routing traffic according to channel assignments.',
    confirmClass: 'bg-[var(--color-ok,#10b981)] text-white hover:opacity-90',
  },
  disable: {
    title: 'Disable Provider',
    actionLabel: 'Disable Provider',
    description:
      'This provider will be marked as disabled and will immediately stop accepting new submissions. In-flight requests will terminate.',
    confirmClass: 'bg-[var(--color-bad,#ef4444)] text-white hover:opacity-90',
  },
  drain: {
    title: 'Drain Provider',
    actionLabel: 'Drain Provider',
    description:
      'This provider will enter draining status. It will accept no new traffic while allowing in-flight submissions and callbacks to complete gracefully.',
    confirmClass: 'bg-[var(--color-warn,#f59e0b)] text-white hover:opacity-90',
  },
};

export function ProviderTransitionDialog({
  open,
  onOpenChange,
  provider,
  transition,
}: ProviderTransitionDialogProps) {
  const queryClient = useQueryClient();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!open) return null;

  const details = TRANSITION_DETAILS[transition];

  const handleConfirm = async () => {
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      if (transition === 'enable') {
        await providersApi.enable(provider.id);
      } else if (transition === 'disable') {
        await providersApi.disable(provider.id);
      } else if (transition === 'drain') {
        await providersApi.drain(provider.id);
      }

      await queryClient.invalidateQueries({ queryKey: ['providers'] });
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'PROVIDER_LIFECYCLE_CONFLICT' || err.status === 409) {
          const currentStatus = err.details?.status ? String(err.details.status) : provider.status;
          setErrorMessage(
            `Cannot transition provider: it is currently ${currentStatus}, which conflicts with this operation.`,
          );
        } else if (err.status === 403 || err.code === 'AUTHZ_SCOPE_DENIED' || err.code === 'AUTHZ_FORBIDDEN') {
          setErrorMessage('Authorization refused (403): You do not have permission (providers.manage) to transition provider status.');
        } else {
          setErrorMessage(err.message);
        }
      } else {
        setErrorMessage('Failed to perform transition. Please check your network connection.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">{details.title}</h2>
        <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
          Target provider: <strong>{provider.name}</strong> (currently <strong>{provider.status}</strong>)
        </p>
        <p className="mt-2 text-xs text-[var(--color-ink)] leading-relaxed">
          {details.description}
        </p>

        {errorMessage && (
          <div className="mt-4 rounded-md border border-[var(--color-bad-subtle,rgba(239,68,68,0.2))] bg-[var(--color-bad-subtle,rgba(239,68,68,0.05))] p-3 text-xs text-[var(--color-bad,#ef4444)]">
            {errorMessage}
          </div>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
            className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isSubmitting}
            className={`rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${details.confirmClass}`}
          >
            {isSubmitting ? 'Updating…' : details.actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
