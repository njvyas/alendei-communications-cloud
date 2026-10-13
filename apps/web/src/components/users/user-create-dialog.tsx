'use client';

import { useState, useEffect, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ApiError,
  rolesApi,
  teamsApi,
  usersApi,
  workspacesApi,
  type CreateUserInput,
} from '@/lib/api-client';
import { useSession } from '@/lib/session-store';

interface UserCreateDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSuccess: () => void;
}

export function UserCreateDialog({ isOpen, onClose, onSuccess }: UserCreateDialogProps) {
  const selectedOrgId = useSession((state) => state.selectedOrganizationId);

  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [scopeType, setScopeType] = useState<'organization' | 'workspace' | 'team'>('organization');
  const [workspaceId, setWorkspaceId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [roleId, setRoleId] = useState('');

  // Stable Idempotency-Key per logical submission attempt; preserved during retries
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => crypto.randomUUID());

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Reset form when opened
  useEffect(() => {
    if (isOpen) {
      setEmail('');
      setPhone('');
      setScopeType('organization');
      setWorkspaceId('');
      setTeamId('');
      setRoleId('');
      setIdempotencyKey(crypto.randomUUID());
      setErrorMessage(null);
      setFieldErrors({});
    }
  }, [isOpen]);

  // Fetch available roles in the organization
  const { data: rolesData, isLoading: rolesLoading } = useQuery({
    queryKey: ['roles', selectedOrgId],
    queryFn: ({ signal }) => rolesApi.list(signal),
    enabled: isOpen && !!selectedOrgId,
  });

  // Fetch available workspaces for workspace- or team-level assignments
  const { data: workspacesData, isLoading: workspacesLoading } = useQuery({
    queryKey: ['workspaces', selectedOrgId],
    queryFn: ({ signal }) => workspacesApi.list(signal),
    enabled: isOpen && !!selectedOrgId && (scopeType === 'workspace' || scopeType === 'team'),
  });

  // Fetch available teams when scopeType is team and a workspace is selected
  const {
    data: teamsData,
    isLoading: teamsLoading,
    error: teamsError,
  } = useQuery({
    queryKey: ['teams', 'list', selectedOrgId, workspaceId],
    queryFn: ({ signal }) => teamsApi.list({ workspaceId, status: 'active' }, signal),
    enabled: isOpen && !!selectedOrgId && scopeType === 'team' && !!workspaceId,
  });

  // Filter out platform roles (orgId === null) and ensure role admits the chosen scopeType
  const availableRoles = (rolesData?.data ?? []).filter((r) => {
    if (r.orgId === null) {
      return false;
    }
    return r.allowedScopeTypes.includes(scopeType);
  });

  // Auto-select first available role if current selection is invalid
  useEffect(() => {
    const firstRole = availableRoles[0];
    if (firstRole && !availableRoles.some((r) => r.id === roleId)) {
      setRoleId(firstRole.id);
    } else if (availableRoles.length === 0) {
      setRoleId('');
    }
  }, [availableRoles, roleId]);

  // Auto-select first workspace when scopeType is workspace or team
  useEffect(() => {
    if (scopeType === 'workspace' || scopeType === 'team') {
      const firstWs = workspacesData?.data?.[0];
      if (firstWs && !workspacesData?.data?.some((w) => w.id === workspaceId)) {
        setWorkspaceId(firstWs.id);
      }
    }
  }, [scopeType, workspacesData, workspaceId]);

  // Auto-select first team when scopeType is team
  useEffect(() => {
    if (scopeType === 'team') {
      const firstTeam = teamsData?.data?.[0];
      if (firstTeam && !teamsData?.data?.some((t) => t.id === teamId)) {
        setTeamId(firstTeam.id);
      }
    } else {
      setTeamId('');
    }
  }, [scopeType, teamsData, teamId]);

  if (!isOpen) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedOrgId) return;

    setErrorMessage(null);
    setFieldErrors({});

    // Client-side validations for immediate UX
    const errors: Record<string, string> = {};
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      errors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      errors.email = 'Please enter a valid email address';
    }

    const trimmedPhone = phone.trim();
    if (trimmedPhone && !/^\+[1-9]\d{6,14}$/.test(trimmedPhone)) {
      errors.phone = 'Phone must be in E.164 format (e.g. +919876543210)';
    }

    if (!roleId) {
      errors.roleId = 'An initial role is required';
    }

    let targetScopeId = '';
    if (scopeType === 'organization') {
      targetScopeId = selectedOrgId;
    } else if (scopeType === 'workspace') {
      targetScopeId = workspaceId;
    } else if (scopeType === 'team') {
      targetScopeId = teamId;
    }

    if (!targetScopeId) {
      errors.scopeId =
        scopeType === 'organization'
          ? 'Organization context is required'
          : scopeType === 'workspace'
            ? 'Please select a workspace'
            : 'Please select a team';
    }

    if (scopeType === 'team') {
      if (!workspaceId) {
        errors.workspaceId = 'Please select a workspace';
      } else if (teamId) {
        const team = teamsData?.data?.find((t) => t.id === teamId);
        if (team) {
          if (team.workspaceId !== workspaceId) {
            errors.scopeId = 'Selected team does not belong to the chosen workspace';
          }
          if (selectedOrgId && team.orgId !== selectedOrgId) {
            errors.scopeId = 'Selected team does not belong to the active organization';
          }
        }
      }
    }

    const selectedRole = rolesData?.data?.find((r) => r.id === roleId);
    if (selectedRole && !selectedRole.allowedScopeTypes.includes(scopeType)) {
      errors.roleId = `The chosen role does not admit ${scopeType} scope`;
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    const payload: CreateUserInput = {
      email: trimmedEmail,
      phone: trimmedPhone || null,
      initialRole: {
        roleId,
        scopeType,
        scopeId: targetScopeId,
      },
    };

    setIsSubmitting(true);

    try {
      await usersApi.create(payload, idempotencyKey);
      onSuccess();
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setErrorMessage(
            'This email address is already registered on the platform. Identity is global; you may search for existing users.',
          );
        } else if (err.code === 'AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION') {
          const rejected = (err.details?.rejected as string[])?.join(', ');
          setErrorMessage(
            `You do not hold all permissions in this role at this scope (${rejected || 'unheld permissions'}).`,
          );
        } else if (err.code === 'AUTHZ_SCOPE_TYPE_NOT_ADMITTED') {
          setErrorMessage('The chosen role does not admit the selected scope level.');
        } else if (err.status === 403) {
          setErrorMessage(
            'You do not have permission to invite users in this organization (users.invite required).',
          );
        } else if (err.status === 404) {
          setErrorMessage('The chosen role or workspace could not be found.');
        } else if (err.status === 400) {
          const issues = err.details?.issues as
            Array<{ field: string; message: string }> | undefined;
          if (Array.isArray(issues) && issues.length > 0) {
            const mapped: Record<string, string> = {};
            for (const issue of issues) {
              mapped[issue.field] = issue.message;
            }
            setFieldErrors(mapped);
          } else {
            setErrorMessage(err.message || 'Validation failed. Please verify the submitted data.');
          }
        } else {
          setErrorMessage(err.message || 'An unexpected error occurred.');
        }
      } else {
        setErrorMessage('A network error occurred. Please check your connection and try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-user-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        className="w-full max-w-lg rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
          <h2 id="create-user-title" className="text-base font-semibold text-[var(--color-ink)]">
            Invite User
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="rounded p-1 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
          >
            ✕
          </button>
        </div>

        <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
          Invited users receive an initial role assignment in this organization. In Phase 1, the
          account enters the <span className="font-semibold">invited</span> state (no credentials or
          invitation emails are sent).
        </p>

        {errorMessage && (
          <div
            role="alert"
            className="mt-4 rounded-md border border-[var(--color-bad)]/30 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]"
          >
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label
              htmlFor="user-email"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Email Address <span className="text-[var(--color-bad)]">*</span>
            </label>
            <input
              id="user-email"
              type="email"
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="colleague@example.com"
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-sm text-[var(--color-ink)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            />
            {fieldErrors.email && (
              <p className="mt-1 text-xs text-[var(--color-bad)]">{fieldErrors.email}</p>
            )}
          </div>

          <div>
            <label
              htmlFor="user-phone"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Phone Number{' '}
              <span className="text-[var(--color-ink-muted)]">(optional, E.164 format)</span>
            </label>
            <input
              id="user-phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+919876543210"
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-sm text-[var(--color-ink)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            />
            {fieldErrors.phone && (
              <p className="mt-1 text-xs text-[var(--color-bad)]">{fieldErrors.phone}</p>
            )}
          </div>

          <div className="rounded-lg border border-[var(--color-border-subtle)] p-3">
            <p className="text-xs font-semibold text-[var(--color-ink)]">
              Initial Role & Scope <span className="text-[var(--color-bad)]">*</span>
            </p>
            <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
              Every created user must receive an initial grant so they are membered in this
              organization.
            </p>

            <div className="mt-3">
              <label
                htmlFor="user-scope-type"
                className="block text-xs font-medium text-[var(--color-ink)]"
              >
                Scope Level
              </label>
              <select
                id="user-scope-type"
                value={scopeType}
                onChange={(e) => {
                  const newScope = e.target.value as 'organization' | 'workspace' | 'team';
                  setScopeType(newScope);
                  if (newScope !== 'team') {
                    setTeamId('');
                  }
                }}
                className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-sm text-[var(--color-ink)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              >
                <option value="organization">Organization (Current Organization)</option>
                <option value="workspace">Workspace</option>
                <option value="team">Team</option>
              </select>
            </div>

            {(scopeType === 'workspace' || scopeType === 'team') && (
              <div className="mt-3">
                <label
                  htmlFor="user-workspace-id"
                  className="block text-xs font-medium text-[var(--color-ink)]"
                >
                  Workspace
                </label>
                {workspacesLoading ? (
                  <p className="mt-1 text-xs text-[var(--color-ink-muted)]">Loading workspaces…</p>
                ) : workspacesData?.data && workspacesData.data.length > 0 ? (
                  <select
                    id="user-workspace-id"
                    value={workspaceId}
                    onChange={(e) => {
                      setWorkspaceId(e.target.value);
                      setTeamId('');
                    }}
                    className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-sm text-[var(--color-ink)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                  >
                    {workspacesData.data.map((ws) => (
                      <option key={ws.id} value={ws.id}>
                        {ws.name} ({ws.slug})
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="mt-1 text-xs text-[var(--color-warn)]">
                    No workspaces found in this organization. Select Organization scope instead.
                  </p>
                )}
                {fieldErrors.workspaceId && (
                  <p className="mt-1 text-xs text-[var(--color-bad)]">{fieldErrors.workspaceId}</p>
                )}
                {scopeType === 'workspace' && fieldErrors.scopeId && (
                  <p className="mt-1 text-xs text-[var(--color-bad)]">{fieldErrors.scopeId}</p>
                )}
              </div>
            )}

            {scopeType === 'team' && (
              <div className="mt-3">
                <label
                  htmlFor="user-team-id"
                  className="block text-xs font-medium text-[var(--color-ink)]"
                >
                  Team
                </label>
                {teamsLoading ? (
                  <p className="mt-1 text-xs text-[var(--color-ink-muted)]">Loading teams…</p>
                ) : teamsError ? (
                  <p className="mt-1 text-xs text-[var(--color-bad)]">Failed to load teams.</p>
                ) : teamsData?.data && teamsData.data.length > 0 ? (
                  <select
                    id="user-team-id"
                    value={teamId}
                    onChange={(e) => setTeamId(e.target.value)}
                    className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-sm text-[var(--color-ink)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                  >
                    {teamsData.data.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="mt-1 text-xs text-[var(--color-warn)]">
                    No active teams found in the selected workspace.
                  </p>
                )}
                {fieldErrors.scopeId && (
                  <p className="mt-1 text-xs text-[var(--color-bad)]">{fieldErrors.scopeId}</p>
                )}
              </div>
            )}

            <div className="mt-3">
              <label
                htmlFor="user-role-id"
                className="block text-xs font-medium text-[var(--color-ink)]"
              >
                Role
              </label>
              {rolesLoading ? (
                <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                  Loading available roles…
                </p>
              ) : availableRoles.length > 0 ? (
                <select
                  id="user-role-id"
                  value={roleId}
                  onChange={(e) => setRoleId(e.target.value)}
                  className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-sm text-[var(--color-ink)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                >
                  {availableRoles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name} {role.description ? `— ${role.description}` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="mt-1 text-xs text-[var(--color-warn)]">
                  No roles admit the selected scope level.
                </p>
              )}
              {fieldErrors.roleId && (
                <p className="mt-1 text-xs text-[var(--color-bad)]">{fieldErrors.roleId}</p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-[var(--color-border-subtle)]">
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
              disabled={
                isSubmitting ||
                rolesLoading ||
                !roleId ||
                (scopeType === 'workspace' && !workspaceId) ||
                (scopeType === 'team' && (!workspaceId || !teamId))
              }
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? 'Inviting…' : 'Invite User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
