'use client';

import { useState, useEffect } from 'react';
import { ApiError, teamsApi, type TeamView } from '@/lib/api-client';

interface TeamArchiveDialogProps {
  readonly isOpen: boolean;
  readonly team: TeamView | null;
  readonly onClose: () => void;
  readonly onSuccess: (team: TeamView) => void;
}

export function TeamArchiveDialog({ isOpen, team, onClose, onSuccess }: TeamArchiveDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setIsSubmitting(false);
      setErrorMessage(null);
    }
  }, [isOpen]);

  if (!isOpen || !team) return null;

  const handleArchive = async () => {
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const res = await teamsApi.archive(team.id);
      onSuccess(res.data);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setErrorMessage('Cannot archive team: team is already archived.');
        } else if (err.status === 403) {
          setErrorMessage('You do not have permission to archive teams in this workspace.');
        } else {
          setErrorMessage(err.message);
        }
      } else {
        setErrorMessage('Failed to archive team. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="archive-team-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl">
        <h2
          id="archive-team-title"
          className="text-lg font-semibold tracking-tight text-[var(--color-ink)]"
        >
          Archive Team
        </h2>
        <div className="mt-3 rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 p-3 text-xs text-[var(--color-warn)]">
          <p className="font-semibold">Archive Team</p>
          <p className="mt-1 leading-relaxed">
            Archiving <span className="font-semibold text-[var(--color-ink)]">{team.name}</span>{' '}
            prevents assigning new roles or granting permissions at this team scope. Existing grants
            will continue to function.
          </p>
        </div>

        {errorMessage && (
          <div className="mt-4 rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]">
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
            onClick={handleArchive}
            disabled={isSubmitting}
            className="flex items-center gap-1.5 rounded-md bg-[var(--color-warn)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {isSubmitting ? (
              <>
                <span className="size-3 animate-spin rounded-full border border-white border-t-transparent" />
                Archiving…
              </>
            ) : (
              'Archive Team'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
