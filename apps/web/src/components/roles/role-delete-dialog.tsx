'use client';

import { useState } from 'react';

import { rolesApi, ApiError, type RoleView } from '@/lib/api-client';

interface RoleDeleteDialogProps {
  role: RoleView | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (deletedRoleId: string) => void;
}

export function RoleDeleteDialog({ role, isOpen, onClose, onSuccess }: RoleDeleteDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen || !role) return null;

  const isImmutable = role.isSystemRole || role.orgId === null;

  const handleDelete = async () => {
    if (isImmutable) return;

    setErrorMessage(null);
    setIsDeleting(true);

    try {
      await rolesApi.delete(role.id);
      onSuccess(role.id);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setErrorMessage(
            'The role is still assigned to one or more users. Revoke those assignments before deleting the role.',
          );
        } else if (err.status === 403) {
          setErrorMessage('System and platform roles cannot be deleted.');
        } else if (err.status === 404) {
          // Already deleted, proceed cleanly
          onSuccess(role.id);
          onClose();
        } else {
          setErrorMessage(err.message || 'Failed to delete role.');
        }
      } else {
        setErrorMessage('An unexpected network error occurred.');
      }
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-role-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-6 shadow-xl">
        <h2 id="delete-role-dialog-title" className="text-base font-semibold text-[var(--color-ink)]">
          Delete Role: {role.name}
        </h2>

        {isImmutable ? (
          <div className="mt-3 space-y-4 text-xs text-[var(--color-ink-muted)]">
            <div className="rounded-lg border border-[var(--color-bad)]/40 bg-[var(--color-bad)]/10 p-3 text-[var(--color-bad)]">
              <p className="font-semibold">System Roles Cannot Be Deleted</p>
              <p className="mt-1 text-[11px]">
                The role <code className="font-mono">{role.key}</code> is defined by the platform and is protected from deletion.
              </p>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3 space-y-4 text-xs text-[var(--color-ink-muted)]">
            <p>
              Are you sure you want to permanently delete custom role{' '}
              <strong className="font-semibold text-[var(--color-ink)]">{role.name}</strong> (
              <code className="font-mono text-[11px]">{role.key}</code>)?
            </p>
            <p className="text-[11px] text-[var(--color-ink-muted)]">
              Roles that are currently granted to any active users cannot be deleted until all grants are revoked.
            </p>

            {errorMessage && (
              <div className="rounded-lg border border-[var(--color-bad)]/40 bg-[var(--color-bad)]/10 p-3 text-[var(--color-bad)]">
                <p className="font-semibold">Deletion Blocked</p>
                <p className="mt-1 text-[11px]">{errorMessage}</p>
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                disabled={isDeleting}
                className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={isDeleting}
                className="rounded-md bg-[var(--color-bad)] px-4 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {isDeleting ? 'Deleting...' : 'Delete Role'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
