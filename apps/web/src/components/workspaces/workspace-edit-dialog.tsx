'use client';

import { useState, useEffect, type FormEvent } from 'react';
import { ApiError, workspacesApi, type WorkspaceView } from '@/lib/api-client';

interface WorkspaceEditDialogProps {
  readonly isOpen: boolean;
  readonly workspace: WorkspaceView | null;
  readonly onClose: () => void;
  readonly onSuccess: (ws: WorkspaceView) => void;
}

export function WorkspaceEditDialog({ isOpen, workspace, onClose, onSuccess }: WorkspaceEditDialogProps) {
  const [name, setName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isOpen && workspace) {
      setName(workspace.name);
      setIsSubmitting(false);
      setErrorMessage(null);
      setFieldErrors({});
    }
  }, [isOpen, workspace]);

  if (!isOpen || !workspace) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setFieldErrors({});

    const trimmedName = name.trim();
    if (!trimmedName) {
      setFieldErrors({ name: 'Workspace name is required' });
      return;
    } else if (trimmedName.length > 200) {
      setFieldErrors({ name: 'Name must be 200 characters or fewer' });
      return;
    }

    setIsSubmitting(true);

    try {
      // Invariant: Never send slug, isDefault, status, or orgId
      const res = await workspacesApi.update(workspace.id, { name: trimmedName });
      onSuccess(res.data);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setErrorMessage('Cannot update workspace: workspace is archived.');
        } else if (err.status === 403) {
          setErrorMessage('You do not have permission to update this workspace.');
        } else {
          setErrorMessage(err.message);
        }
      } else {
        setErrorMessage('Failed to update workspace. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-workspace-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl">
        <h2 id="edit-workspace-title" className="text-lg font-semibold tracking-tight text-[var(--color-ink)]">
          Edit Workspace
        </h2>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          Update the display name of this workspace.
        </p>

        {errorMessage && (
          <div className="mt-4 rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-[var(--color-ink-muted)]">Identifier Slug</label>
            <div className="mt-1 font-mono text-xs text-[var(--color-ink)] px-3 py-1.5 rounded-md bg-[var(--color-surface-raised)] border border-[var(--color-border-subtle)]">
              {workspace.slug}
            </div>
            <p className="mt-0.5 text-[10px] text-[var(--color-ink-muted)]">Identifier slug is immutable.</p>
          </div>

          <div>
            <label htmlFor="edit-ws-name" className="block text-xs font-medium text-[var(--color-ink)]">
              Workspace Name <span className="text-[var(--color-bad)]">*</span>
            </label>
            <input
              id="edit-ws-name"
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
