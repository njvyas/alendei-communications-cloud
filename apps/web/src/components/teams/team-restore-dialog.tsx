'use client';

import { useState, useEffect } from 'react';
import { ApiError, teamsApi, type TeamView } from '@/lib/api-client';

interface TeamRestoreDialogProps {
  readonly isOpen: boolean;
  readonly team: TeamView | null;
  readonly onClose: () => void;
  readonly onSuccess: (team: TeamView) => void;
}

export function TeamRestoreDialog({ isOpen, team, onClose, onSuccess }: TeamRestoreDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setIsSubmitting(false);
      setErrorMessage(null);
    }
  }, [isOpen]);

  if (!isOpen || !team) return null;

  const handleRestore = async () => {
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const res = await teamsApi.restore(team.id);
      onSuccess(res.data);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          if (err.code === 'WORKSPACE_LIFECYCLE_CONFLICT') {
            setErrorMessage(
              'Cannot restore team: its parent workspace is archived. You must restore the parent workspace first before this team can be restored.',
            );
          } else {
            setErrorMessage(
              'Cannot restore team: team is not archived or organization is suspended/closed.',
            );
          }
        } else if (err.status === 403) {
          setErrorMessage('You do not have permission to restore teams in this workspace.');
        } else {
          setErrorMessage(err.message);
        }
      } else {
        setErrorMessage('Failed to restore team. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="restore-team-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl">
        <h2
          id="restore-team-title"
          className="text-lg font-semibold tracking-tight text-[var(--color-ink)]"
        >
          Restore Team
        </h2>
        <p className="mt-2 text-xs text-[var(--color-ink-muted)] leading-relaxed">
          Restoring <span className="font-semibold text-[var(--color-ink)]">{team.name}</span> will
          re-enable team role assignments and permissions.
        </p>

        {errorMessage && (
          <div className="mt-4 rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)] leading-relaxed">
            {errorMessage}
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
            type="button"
            onClick={handleRestore}
            disabled={isSubmitting}
            className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {isSubmitting ? (
              <>
                <span className="size-3 animate-spin rounded-full border border-white border-t-transparent" />
                Restoring…
              </>
            ) : (
              'Restore Team'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
