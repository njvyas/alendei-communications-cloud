'use client';

import { useState, useEffect } from 'react';
import { ApiError, workspacesApi, type WorkspaceView } from '@/lib/api-client';

interface WorkspaceArchiveDialogProps {
  readonly isOpen: boolean;
  readonly workspace: WorkspaceView | null;
  readonly onClose: () => void;
  readonly onSuccess: (ws: WorkspaceView) => void;
}

export function WorkspaceArchiveDialog({
  isOpen,
  workspace,
  onClose,
  onSuccess,
}: WorkspaceArchiveDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setIsSubmitting(false);
      setErrorMessage(null);
    }
  }, [isOpen]);

  if (!isOpen || !workspace) return null;

  const isDefault = workspace.isDefault;

  const handleArchive = async () => {
    if (isDefault) return;

    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const res = await workspacesApi.archive(workspace.id);
      onSuccess(res.data);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          const details = err.details as { status?: string; isDefault?: boolean; activeTeams?: number } | undefined;
          if (details?.isDefault) {
            setErrorMessage('The default workspace cannot be archived.');
          } else if (typeof details?.activeTeams === 'number' && details.activeTeams > 0) {
            setErrorMessage(
              `Cannot archive workspace: ${details.activeTeams} active team(s) exist within it. Please archive all teams first before archiving this workspace.`,
            );
          } else {
            setErrorMessage(err.message || 'Cannot archive workspace due to lifecycle conflict.');
          }
        } else if (err.status === 403) {
          setErrorMessage('You do not have permission to archive workspaces.');
        } else {
          setErrorMessage(err.message);
        }
      } else {
        setErrorMessage('Failed to archive workspace. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="archive-workspace-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl">
        <h2 id="archive-workspace-title" className="text-lg font-semibold tracking-tight text-[var(--color-ink)]">
          Archive Workspace
        </h2>

        {isDefault ? (
          <div className="mt-3 rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 p-3 text-xs text-[var(--color-warn)]">
            <p className="font-semibold">Default Workspace Protected</p>
            <p className="mt-1 leading-relaxed">
              <code className="font-mono font-bold">{workspace.name}</code> is the organization&apos;s default workspace. The default workspace cannot be archived.
            </p>
          </div>
        ) : (
          <div className="mt-3 rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 p-3 text-xs text-[var(--color-warn)]">
            <p className="font-semibold">Archive Workspace</p>
            <p className="mt-1 leading-relaxed">
              Archiving <span className="font-semibold text-[var(--color-ink)]">{workspace.name}</span> prevents creating new teams, assigning new roles, or generating new API keys bound to it. Existing grants and keys will continue to work.
            </p>
          </div>
        )}

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
          {!isDefault && (
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
                'Archive Workspace'
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
