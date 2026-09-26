'use client';

import { useState, useEffect, type FormEvent } from 'react';
import { ApiError, teamsApi, type TeamView } from '@/lib/api-client';

interface TeamEditDialogProps {
  readonly isOpen: boolean;
  readonly team: TeamView | null;
  readonly onClose: () => void;
  readonly onSuccess: (team: TeamView) => void;
}

export function TeamEditDialog({ isOpen, team, onClose, onSuccess }: TeamEditDialogProps) {
  const [name, setName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isOpen && team) {
      setName(team.name);
      setIsSubmitting(false);
      setErrorMessage(null);
      setFieldErrors({});
    }
  }, [isOpen, team]);

  if (!isOpen || !team) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setFieldErrors({});

    const trimmedName = name.trim();
    if (!trimmedName) {
      setFieldErrors({ name: 'Team name is required' });
      return;
    } else if (trimmedName.length > 200) {
      setFieldErrors({ name: 'Name must be 200 characters or fewer' });
      return;
    }

    setIsSubmitting(true);

    try {
      // Invariant: NEVER send orgId, workspaceId, or status (causes 400 VALIDATION_FAILED)
      const res = await teamsApi.update(team.id, { name: trimmedName });
      onSuccess(res.data);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setErrorMessage('Cannot update team: team is archived.');
        } else if (err.status === 403) {
          setErrorMessage('You do not have permission to update this team.');
        } else {
          setErrorMessage(err.message);
        }
      } else {
        setErrorMessage('Failed to update team. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-team-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl">
        <h2 id="edit-team-title" className="text-lg font-semibold tracking-tight text-[var(--color-ink)]">
          Edit Team
        </h2>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          Update the display name of this team.
        </p>

        {errorMessage && (
          <div className="mt-4 rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label htmlFor="edit-team-name" className="block text-xs font-medium text-[var(--color-ink)]">
              Team Name <span className="text-[var(--color-bad)]">*</span>
            </label>
            <input
              id="edit-team-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isSubmitting}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
            />
            {fieldErrors.name && (
              <p className="mt-1 text-[11px] text-[var(--color-bad)]">{fieldErrors.name}</p>
            )}
          </div>

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
              disabled={isSubmitting}
              className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <span className="size-3 animate-spin rounded-full border border-white border-t-transparent" />
                  Saving…
                </>
              ) : (
                'Save Changes'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
