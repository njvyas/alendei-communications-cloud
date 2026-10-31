'use client';

import { useState } from 'react';
import { ApiError, apiKeysApi, type ApiKeyView } from '@/lib/api-client';
import { useModalDialog } from '@/components/ui/dialog';
import { toast } from '@/lib/toast';

interface RevokeApiKeyDialogProps {
  readonly isOpen: boolean;
  readonly apiKey: ApiKeyView | null;
  readonly onClose: () => void;
  readonly onSuccess: () => void;
}

export function RevokeApiKeyDialog({
  isOpen,
  apiKey,
  onClose,
  onSuccess,
}: RevokeApiKeyDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const modal = useModalDialog(isOpen && !!apiKey);

  if (!isOpen || !apiKey) return null;

  const handleRevoke = async () => {
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      await apiKeysApi.revoke(apiKey.id);
      onSuccess();
      toast.success('API Key Revoked', `API key "${apiKey.name}" has been revoked.`);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 409 && err.code === 'API_KEY_LIFECYCLE_CONFLICT') {
          // Already revoked: treat status as authoritative and refresh
          onSuccess();
          toast.info('API Key Already Revoked', `API key "${apiKey.name}" was already revoked.`);
          onClose();
          return;
        } else if (err.status === 403) {
          setErrorMessage('You lack permission to revoke this API key at its binding scope.');
        } else {
          setErrorMessage(err.message || 'Failed to revoke API key.');
        }
      } else {
        setErrorMessage('An unexpected network error occurred.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="revoke-key-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs focus:outline-none"
      {...modal.overlayProps(onClose, !isSubmitting)}
    >
      <div
        ref={modal.panelRef}
        tabIndex={-1}
        className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl text-[var(--color-ink)]"
      >
        <div className="flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[var(--color-bad)]/15 text-[var(--color-bad)] font-bold text-lg">
            !
          </div>
          <div>
            <h2 id="revoke-key-dialog-title" className="text-base font-bold tracking-tight">
              Revoke API Key
            </h2>
            <p className="text-xs text-[var(--color-ink-muted)]">Permanent lifecycle revocation</p>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          <p className="text-xs text-[var(--color-ink-muted)]">
            Are you sure you want to revoke{' '}
            <strong className="text-[var(--color-ink)]">{apiKey.name}</strong> (
            <code className="font-mono text-[var(--color-ink)]">{apiKey.prefix}…</code>)?
          </p>

          <div className="rounded-lg border border-[var(--color-bad)]/30 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]">
            <p className="font-semibold">This action cannot be undone.</p>
            <p className="mt-1">
              Revocation is immediate and terminal. Any machine process, background job, or
              integration presenting this key will immediately fail with{' '}
              <code>401 Unauthorized</code>.
            </p>
          </div>

          {errorMessage && (
            <div
              role="alert"
              className="rounded-md border border-[var(--color-bad)]/40 bg-[var(--color-bad)]/10 p-2.5 text-xs text-[var(--color-bad)]"
            >
              {errorMessage}
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            disabled={isSubmitting}
            onClick={onClose}
            className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={handleRevoke}
            className="rounded-md bg-[var(--color-bad)] px-4 py-1.5 text-xs font-medium text-white shadow-xs hover:opacity-90 disabled:opacity-50"
          >
            {isSubmitting ? 'Revoking…' : 'Revoke Key'}
          </button>
        </div>
      </div>
    </div>
  );
}
