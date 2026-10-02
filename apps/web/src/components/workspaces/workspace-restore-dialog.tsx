'use client';

import { useState, useEffect } from 'react';
import { ApiError, workspacesApi, type WorkspaceView } from '@/lib/api-client';

interface WorkspaceRestoreDialogProps {
  readonly isOpen: boolean;
  readonly workspace: WorkspaceView | null;
  readonly onClose: () => void;
  readonly onSuccess: (ws: WorkspaceView) => void;
}

export function WorkspaceRestoreDialog({
  isOpen,
  workspace,
  onClose,
  onSuccess,
}: WorkspaceRestoreDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setIsSubmitting(false);
      setErrorMessage(null);
    }
  }, [isOpen]);

  if (!isOpen || !workspace) return null;

  const handleRestore = async () => {
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const res = await workspacesApi.restore(workspace.id);
      onSuccess(res.data);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setErrorMessage(
            'Cannot restore workspace: workspace is not archived or organization is suspended/closed.',
          );
        } else if (err.status === 403) {
          setErrorMessage('You do not have permission to restore workspaces.');
        } else {
          setErrorMessage(err.message);
        }
      } else {
        setErrorMessage('Failed to restore workspace. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="restore-workspace-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl">
        <h2
          id="restore-workspace-title"
          className="text-lg font-semibold tracking-tight text-[var(--color-ink)]"
        >
          Restore Workspace
        </h2>
        <p className="mt-2 text-xs text-[var(--color-ink-muted)] leading-relaxed">
          Restoring <span className="font-semibold text-[var(--color-ink)]">{workspace.name}</span>{' '}
          will re-enable creating new teams, assigning new role grants, and creating API keys within
          it.
        </p>

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
              'Restore Workspace'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
