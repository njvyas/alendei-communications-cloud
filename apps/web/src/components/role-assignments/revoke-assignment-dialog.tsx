'use client';

import { useState } from 'react';
import { ApiError, roleAssignmentsApi, type RoleAssignmentView } from '@/lib/api-client';

interface RevokeAssignmentDialogProps {
  readonly isOpen: boolean;
  readonly assignment: RoleAssignmentView | null;
  readonly userEmail: string;
  readonly targetLabel?: string;
  readonly onClose: () => void;
  readonly onSuccess: () => void;
}

export function RevokeAssignmentDialog({
  isOpen,
  assignment,
  userEmail,
  targetLabel,
  onClose,
  onSuccess,
}: RevokeAssignmentDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen || !assignment) return null;

  const handleRevoke = async () => {
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      await roleAssignmentsApi.delete(assignment.id);
      onSuccess();
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.code === 'AUTHZ_LAST_PLATFORM_ADMIN') {
          setErrorMessage(
            'Cannot revoke the last active platform administrator. The backend rejected this action to maintain the platform admin liveness invariant. Appoint another platform administrator first.',
          );
        } else if (err.status === 404) {
          setErrorMessage('This role assignment was already revoked or does not exist.');
        } else if (err.status === 403) {
          setErrorMessage(
            'You do not have permission to revoke role assignments at this scope (role_assignments.revoke required).',
          );
        } else if (err.status === 409) {
          setErrorMessage(err.message || 'Cannot revoke this role assignment due to an active conflict.');
        } else if (err.status === 429) {
          setErrorMessage('Rate limit exceeded. Please wait a moment and try again.');
        } else {
          setErrorMessage(err.message || 'Failed to revoke role assignment.');
        }
      } else {
        setErrorMessage('Network error while revoking role assignment.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="revoke-assignment-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="revoke-assignment-title" className="text-base font-semibold text-[var(--color-ink)]">
          Revoke Role Assignment
        </h3>

        <div className="mt-3 text-xs leading-relaxed text-[var(--color-ink-muted)] space-y-2">
          <p>
            Are you sure you want to revoke the role{' '}
            <span className="font-mono font-semibold text-[var(--color-ink)]">{assignment.roleKey}</span> from{' '}
            <span className="font-semibold text-[var(--color-ink)]">{userEmail}</span>?
          </p>

          <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 space-y-1 font-mono text-[11px]">
            <p>
              <span className="text-[var(--color-ink-muted)]">Scope Level: </span>
              <span className="text-[var(--color-ink)] font-semibold">{assignment.scopeType}</span>
            </p>
            <p>
              <span className="text-[var(--color-ink-muted)]">Target Scope: </span>
              <span className="text-[var(--color-ink)]">
                {targetLabel ? `${targetLabel} (${assignment.scopeId})` : (assignment.scopeId ?? 'Global')}
              </span>
            </p>
          </div>

          <p className="text-[var(--color-bad)]">
            The user will immediately lose all permissions and access granted by this role at this scope.
          </p>
        </div>

        {errorMessage && (
          <div
            role="alert"
            className="mt-4 rounded-md border border-[var(--color-bad)]/30 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]"
          >
            {errorMessage}
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-3 border-t border-[var(--color-border-subtle)] pt-4">
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
            onClick={handleRevoke}
            disabled={isSubmitting}
            className="rounded-md bg-[var(--color-bad)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {isSubmitting ? 'Revoking…' : 'Confirm Revoke'}
          </button>
        </div>
      </div>
    </div>
  );
}
