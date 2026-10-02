'use client';

import { useState, useEffect, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, teamsApi, workspacesApi, type TeamView } from '@/lib/api-client';
import { useSession } from '@/lib/session-store';

interface TeamCreateDialogProps {
  readonly isOpen: boolean;
  readonly initialWorkspaceId?: string;
  readonly onClose: () => void;
  readonly onSuccess: (team: TeamView) => void;
}

export function TeamCreateDialog({
  isOpen,
  initialWorkspaceId,
  onClose,
  onSuccess,
}: TeamCreateDialogProps) {
  const selectedOrgId = useSession((state) => state.selectedOrganizationId);

  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId ?? '');
  const [name, setName] = useState('');

  // Stable Idempotency-Key preserved across retries
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => crypto.randomUUID());

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Fetch active workspaces in the organization
  const { data: workspacesData, isLoading: workspacesLoading } = useQuery({
    queryKey: ['workspaces', 'active', selectedOrgId],
    queryFn: ({ signal }) => workspacesApi.list({ status: 'active' }, signal),
    enabled: isOpen && !!selectedOrgId && !initialWorkspaceId,
  });

  const activeWorkspaces = workspacesData?.data ?? [];

  useEffect(() => {
    if (isOpen) {
      setWorkspaceId(initialWorkspaceId ?? '');
      setName('');
      setIdempotencyKey(crypto.randomUUID());
      setIsSubmitting(false);
      setErrorMessage(null);
      setFieldErrors({});
    }
  }, [isOpen, initialWorkspaceId]);

  // Auto-select first active workspace if none selected
  useEffect(() => {
    if (isOpen && !initialWorkspaceId && !workspaceId && activeWorkspaces.length > 0) {
      setWorkspaceId(activeWorkspaces[0]!.id);
    }
  }, [isOpen, initialWorkspaceId, workspaceId, activeWorkspaces]);

  if (!isOpen) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setFieldErrors({});

    const errors: Record<string, string> = {};
    const trimmedName = name.trim();

    if (!workspaceId) {
      errors.workspaceId = 'Please select a parent workspace';
    }

    if (!trimmedName) {
      errors.name = 'Team name is required';
    } else if (trimmedName.length > 200) {
      errors.name = 'Name must be 200 characters or fewer';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setIsSubmitting(true);

    try {
      // Invariant: NEVER send orgId (causes 400 VALIDATION_FAILED)
      const res = await teamsApi.create(
        {
          workspaceId,
          name: trimmedName,
        },
        idempotencyKey,
      );
      onSuccess(res.data);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          if (err.code === 'WORKSPACE_LIFECYCLE_CONFLICT') {
            setErrorMessage('Cannot create team: the selected workspace is archived.');
          } else {
            setErrorMessage('A team with this name already exists in the selected workspace.');
            setFieldErrors((prev) => ({
              ...prev,
              name: 'Team name already in use in this workspace',
            }));
          }
        } else if (err.status === 403) {
          setErrorMessage('You do not have permission to create teams in this workspace.');
        } else if (err.status === 404) {
          setErrorMessage('The selected workspace was not found or is outside your tenant reach.');
        } else {
          setErrorMessage(err.message);
        }
      } else {
        setErrorMessage('Failed to create team. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-team-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl">
        <h2
          id="create-team-title"
          className="text-lg font-semibold tracking-tight text-[var(--color-ink)]"
        >
          Create Team
        </h2>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          Teams group operators, routing configurations, and channel access within a workspace.
        </p>

        {errorMessage && (
          <div className="mt-4 rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)] leading-relaxed">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {!initialWorkspaceId ? (
            <div>
              <label
                htmlFor="team-workspace"
                className="block text-xs font-medium text-[var(--color-ink)]"
              >
                Parent Workspace <span className="text-[var(--color-bad)]">*</span>
              </label>
              {workspacesLoading ? (
                <div className="mt-1 text-xs text-[var(--color-ink-muted)]">
                  Loading workspaces…
                </div>
              ) : activeWorkspaces.length === 0 ? (
                <div className="mt-1 text-xs text-[var(--color-bad)]">
                  No active workspaces available. Please create or restore an active workspace
                  first.
                </div>
              ) : (
                <select
                  id="team-workspace"
                  value={workspaceId}
                  onChange={(e) => setWorkspaceId(e.target.value)}
                  disabled={isSubmitting}
                  className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
                >
                  {activeWorkspaces.map((ws) => (
                    <option key={ws.id} value={ws.id}>
                      {ws.name} ({ws.slug})
                    </option>
                  ))}
                </select>
              )}
              {fieldErrors.workspaceId && (
                <p className="mt-1 text-[11px] text-[var(--color-bad)]">
                  {fieldErrors.workspaceId}
                </p>
              )}
            </div>
          ) : null}

          <div>
            <label
              htmlFor="team-name"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Team Name <span className="text-[var(--color-bad)]">*</span>
            </label>
            <input
              id="team-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Tier 1 Support"
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
              disabled={isSubmitting || (!initialWorkspaceId && activeWorkspaces.length === 0)}
              className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <span className="size-3 animate-spin rounded-full border border-white border-t-transparent" />
                  Creating…
                </>
              ) : (
                'Create Team'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
