'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, providersApi, type ProviderDetailView } from '@/lib/api-client';
import {
  PROVIDER_HEALTH_OVERRIDE_REASON_MAX,
  PROVIDER_HEALTH_STATES,
  type ProviderHealthState,
} from '@acc/contracts';

interface ProviderHealthOverrideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderDetailView;
}

export function ProviderHealthOverrideDialog({
  open,
  onOpenChange,
  provider,
}: ProviderHealthOverrideDialogProps) {
  const queryClient = useQueryClient();

  const [overrideState, setOverrideState] = useState<string>(provider.healthOverride ?? 'clear');
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const isClear = overrideState === 'clear';
    const targetOverride: ProviderHealthState | null = isClear
      ? null
      : (overrideState as ProviderHealthState);

    const trimmedReason = reason.trim();
    if (trimmedReason.length > PROVIDER_HEALTH_OVERRIDE_REASON_MAX) {
      setErrorMessage(`Reason cannot exceed ${PROVIDER_HEALTH_OVERRIDE_REASON_MAX} characters.`);
      return;
    }

    setIsSubmitting(true);
    try {
      await providersApi.overrideHealth(provider.id, {
        override: targetOverride,
        reason: trimmedReason || undefined,
      });

      await queryClient.invalidateQueries({ queryKey: ['providers'] });
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) {
        if (
          err.status === 403 ||
          err.code === 'AUTHZ_SCOPE_DENIED' ||
          err.code === 'AUTHZ_FORBIDDEN'
        ) {
          setErrorMessage(
            'Authorization refused (403): You do not have permission (providers.manage) to set health overrides.',
          );
        } else {
          setErrorMessage(err.message);
        }
      } else {
        setErrorMessage('Failed to update health override. Please check your network connection.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">
          Manual Health Override — {provider.name}
        </h2>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          Manually pin health state or clear back to automatic sample-based derivation. Does not
          directly modify the circuit breaker state.
        </p>

        {errorMessage && (
          <div className="mt-4 rounded-md border border-[var(--color-bad-subtle,rgba(239,68,68,0.2))] bg-[var(--color-bad-subtle,rgba(239,68,68,0.05))] p-3 text-xs text-[var(--color-bad,#ef4444)]">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label
              htmlFor="health-override-state"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Override Mode <span className="text-[var(--color-bad,#ef4444)]">*</span>
            </label>
            <select
              id="health-override-state"
              value={overrideState}
              onChange={(e) => setOverrideState(e.target.value)}
              disabled={isSubmitting}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink)] shadow-xs focus:border-[var(--color-accent)] focus:outline-hidden"
              required
            >
              <option value="clear">Clear override (Derive automatically from samples)</option>
              {PROVIDER_HEALTH_STATES.map((s) => (
                <option key={s} value={s}>
                  Pin to {s.toUpperCase()}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="health-override-reason"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Reason (Optional)
            </label>
            <textarea
              id="health-override-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Operational context for the audit log..."
              disabled={isSubmitting}
              maxLength={PROVIDER_HEALTH_OVERRIDE_REASON_MAX}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink)] shadow-xs focus:border-[var(--color-accent)] focus:outline-hidden"
            />
            <span className="mt-1 block text-[10px] text-[var(--color-ink-muted)]">
              Max {PROVIDER_HEALTH_OVERRIDE_REASON_MAX} characters. Recorded in the provider health
              history and audit trail.
            </span>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? 'Updating…' : 'Apply Override'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
