'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ApiError,
  roleAssignmentsApi,
  rolesApi,
  teamsApi,
  workspacesApi,
  type CreateRoleAssignmentInput,
  type RoleView,
  type ScopeLevel,
  type TeamView,
  type WorkspaceItem,
} from '../../lib/api-client';
import { useSession } from '../../lib/session-store';
import { useModalDialog } from '@/components/ui/dialog';
import { toast } from '@/lib/toast';

interface AssignRoleDialogProps {
  readonly isOpen: boolean;
  readonly userId: string;
  readonly userEmail: string;
  readonly onClose: () => void;
  readonly onSuccess: () => void;
}

/**
 * Determines whether a role is eligible for assignment within tenant administration.
 *
 * Requirements (RBAC.md §§3-4, §§7-8):
 * 1. Platform-level roles (orgId === null) are strictly excluded from tenant administration.
 * 2. Roles must belong to the active organization (orgId === activeOrgId).
 * 3. Seeded system roles (isSystemRole === true) that belong to the active organization
 *    are eligible for tenant assignment within their admitted scope types.
 * 4. The role must admit at least one tenant scope level ('organization', 'workspace', 'team').
 */
export function isAssignableTenantRole(role: RoleView, activeOrgId: string | null): boolean {
  if (role.orgId === null) return false;
  if (activeOrgId && role.orgId !== activeOrgId) return false;
  return role.allowedScopeTypes.some(
    (scope) => scope === 'organization' || scope === 'workspace' || scope === 'team',
  );
}

export function AssignRoleDialog({
  isOpen,
  userId,
  userEmail,
  onClose,
  onSuccess,
}: AssignRoleDialogProps) {
  const selectedOrgId = useSession((state) => state.selectedOrganizationId);

  // Form State
  const [selectedRoleId, setSelectedRoleId] = useState<string>('');
  const [selectedScopeType, setSelectedScopeType] = useState<ScopeLevel | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('');
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const [idempotencyKey, setIdempotencyKey] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [rejectedPermissions, setRejectedPermissions] = useState<readonly string[] | null>(null);

  // Generate / reset idempotency key when dialog opens
  useEffect(() => {
    if (isOpen) {
      setIdempotencyKey(crypto.randomUUID());
      setSelectedRoleId('');
      setSelectedScopeType(null);
      setSelectedWorkspaceId('');
      setSelectedTeamId('');
      setErrorMessage(null);
      setRejectedPermissions(null);
    }
  }, [isOpen]);

  // Fetch roles for active organization
  const {
    data: rolesData,
    isLoading: rolesLoading,
    error: rolesError,
  } = useQuery({
    queryKey: ['roles', 'assignable-list', selectedOrgId],
    queryFn: ({ signal }) => rolesApi.list({ limit: 100 }, signal),
    enabled: isOpen && !!selectedOrgId,
  });

  // Fetch workspaces for active organization
  const { data: workspacesData, isLoading: workspacesLoading } = useQuery({
    queryKey: ['workspaces', 'list', selectedOrgId],
    queryFn: ({ signal }) => workspacesApi.list(signal),
    enabled: isOpen && !!selectedOrgId,
  });

  // Fetch teams for active organization and selected workspace when team scope is active
  const {
    data: teamsData,
    isLoading: teamsLoading,
    error: teamsError,
  } = useQuery({
    queryKey: ['teams', 'list', selectedOrgId, selectedWorkspaceId],
    queryFn: ({ signal }) =>
      teamsApi.list({ workspaceId: selectedWorkspaceId, status: 'active' }, signal),
    enabled: isOpen && !!selectedOrgId && selectedScopeType === 'team' && !!selectedWorkspaceId,
  });

  const allRoles: readonly RoleView[] = rolesData?.data ?? [];
  // Filter assignable roles: Platform roles (orgId === null) are protected from tenant role assignment.
  // Seeded system tenant roles and custom tenant roles are assignable within their admitted scope types.
  const assignableRoles = allRoles.filter((r) => isAssignableTenantRole(r, selectedOrgId));

  const selectedRole = allRoles.find((r) => r.id === selectedRoleId);
  const workspaces: readonly WorkspaceItem[] = workspacesData?.data ?? [];
  const teams: readonly TeamView[] = teamsData?.data ?? [];

  // Allowed scope types for the selected role
  const roleAllowedScopes: readonly ScopeLevel[] = selectedRole?.allowedScopeTypes ?? [];

  // Handle role selection change
  const handleRoleChange = (newRoleId: string) => {
    setSelectedRoleId(newRoleId);
    setSelectedScopeType(null);
    setSelectedWorkspaceId('');
    setSelectedTeamId('');
    setErrorMessage(null);
    setRejectedPermissions(null);
  };

  // Handle scope type selection
  const handleScopeTypeSelect = (scope: ScopeLevel) => {
    setSelectedScopeType(scope);
    setErrorMessage(null);
    setRejectedPermissions(null);
    if (
      (scope === 'workspace' || scope === 'team') &&
      workspaces.length > 0 &&
      !selectedWorkspaceId
    ) {
      setSelectedWorkspaceId(workspaces[0]!.id);
    }
    if (scope !== 'team') {
      setSelectedTeamId('');
    }
  };

  // Ensure workspace selection when entering workspace or team scope
  useEffect(() => {
    if (
      (selectedScopeType === 'workspace' || selectedScopeType === 'team') &&
      workspaces.length > 0
    ) {
      if (!selectedWorkspaceId || !workspaces.some((w) => w.id === selectedWorkspaceId)) {
        setSelectedWorkspaceId(workspaces[0]!.id);
      }
    }
  }, [selectedScopeType, workspaces, selectedWorkspaceId]);

  // Ensure team selection when entering team scope
  useEffect(() => {
    if (selectedScopeType === 'team' && teams.length > 0) {
      if (!selectedTeamId || !teams.some((t) => t.id === selectedTeamId)) {
        setSelectedTeamId(teams[0]!.id);
      }
    } else if (selectedScopeType !== 'team') {
      setSelectedTeamId('');
    }
  }, [selectedScopeType, teams, selectedTeamId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setRejectedPermissions(null);

    if (!selectedRoleId || !selectedRole) {
      setErrorMessage('Please select a role to assign.');
      return;
    }

    if (selectedRole.orgId === null) {
      setErrorMessage('Platform-level roles cannot be granted through tenant administration.');
      return;
    }

    if (selectedOrgId && selectedRole.orgId !== selectedOrgId) {
      setErrorMessage('Roles from other organizations cannot be granted.');
      return;
    }

    if (!selectedScopeType) {
      setErrorMessage('Please choose an assignment scope.');
      return;
    }

    if (!selectedRole.allowedScopeTypes.includes(selectedScopeType)) {
      setErrorMessage(`The chosen role does not admit ${selectedScopeType} scope.`);
      return;
    }

    let targetScopeId = '';
    if (selectedScopeType === 'organization') {
      if (!selectedOrgId) {
        setErrorMessage('No active organization context found.');
        return;
      }
      targetScopeId = selectedOrgId;
    } else if (selectedScopeType === 'workspace') {
      if (!selectedWorkspaceId) {
        setErrorMessage('Please select a target workspace.');
        return;
      }
      targetScopeId = selectedWorkspaceId;
    } else if (selectedScopeType === 'team') {
      if (!selectedWorkspaceId) {
        setErrorMessage('Please select a target workspace.');
        return;
      }
      if (!selectedTeamId) {
        setErrorMessage('Please select a target team.');
        return;
      }
      const team = teams.find((t) => t.id === selectedTeamId);
      if (team) {
        if (team.workspaceId !== selectedWorkspaceId) {
          setErrorMessage('Selected team does not belong to the chosen workspace.');
          return;
        }
        if (selectedOrgId && team.orgId !== selectedOrgId) {
          setErrorMessage('Selected team does not belong to the active organization.');
          return;
        }
      }
      targetScopeId = selectedTeamId;
    } else {
      setErrorMessage(`Scope type "${selectedScopeType}" is not supported for tenant assignment.`);
      return;
    }

    const payload: CreateRoleAssignmentInput = {
      userId,
      roleId: selectedRoleId,
      scopeType: selectedScopeType,
      scopeId: targetScopeId,
    };

    setIsSubmitting(true);
    try {
      await roleAssignmentsApi.create(payload, idempotencyKey);
      onSuccess();
      toast.success('Role Assigned', `Role granted to ${userEmail}.`);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.code === 'AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION') {
          const rejected = err.details?.rejected as string[] | undefined;
          setRejectedPermissions(rejected ?? []);
          setErrorMessage(
            'This role carries permissions you do not hold at the target scope. You cannot grant authority you do not possess.',
          );
        } else if (err.code === 'AUTHZ_SCOPE_TYPE_NOT_ADMITTED') {
          setErrorMessage(
            `The chosen role does not admit ${selectedScopeType} scope (${err.message || 'Scope type not admitted'}).`,
          );
        } else if (err.code === 'AUTHZ_PLATFORM_ROLE_REQUIRED') {
          setErrorMessage('Platform-level roles cannot be granted through tenant administration.');
        } else if (err.status === 409) {
          setErrorMessage(
            'The role could not be assigned due to a conflict (e.g. target user is disabled or inactive).',
          );
        } else if (err.status === 404) {
          setErrorMessage('The role, user, or target scope could not be found.');
        } else if (err.status === 403) {
          setErrorMessage(
            'You do not have permission to grant roles at this scope (role_assignments.grant required).',
          );
        } else if (err.status === 429) {
          setErrorMessage('Rate limit exceeded. Please wait a moment and try again.');
        } else {
          setErrorMessage(err.message || 'Failed to assign role.');
        }
      } else {
        setErrorMessage('Network or client error while creating role assignment.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const modal = useModalDialog(isOpen);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="assign-role-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 focus:outline-none"
      {...modal.overlayProps(onClose, !isSubmitting)}
    >
      <div
        ref={modal.panelRef}
        tabIndex={-1}
        className="w-full max-w-lg rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-4">
          <div>
            <h3 id="assign-role-title" className="text-base font-semibold text-[var(--color-ink)]">
              Assign Role
            </h3>
            <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
              Grant a tenant role to{' '}
              <span className="font-semibold text-[var(--color-ink)]">{userEmail}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-5">
          {/* Step 1: Select Role */}
          <div>
            <label
              htmlFor="assign-role-select"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Select Role <span className="text-[var(--color-bad)]">*</span>
            </label>
            {rolesLoading ? (
              <p role="status" className="mt-1 text-xs text-[var(--color-ink-muted)]">
                Loading roles…
              </p>
            ) : rolesError ? (
              <p role="alert" className="mt-1 text-xs text-[var(--color-bad)]">
                Failed to load roles.
              </p>
            ) : assignableRoles.length === 0 ? (
              <div className="mt-1 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 text-xs text-[var(--color-ink-muted)]">
                No assignable roles found in this organization. Platform roles cannot be assigned
                via tenant administration.
              </div>
            ) : (
              <select
                id="assign-role-select"
                value={selectedRoleId}
                onChange={(e) => handleRoleChange(e.target.value)}
                className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
              >
                <option value="">-- Choose a tenant role --</option>
                {assignableRoles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name} ({role.key})
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Role Metadata & Allowed Scopes Preview */}
          {selectedRole && (
            <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3.5 space-y-2 text-xs">
              <div>
                <p className="font-semibold text-[var(--color-ink)]">{selectedRole.name}</p>
                <p className="font-mono text-[11px] text-[var(--color-ink-muted)]">
                  {selectedRole.key}
                </p>
              </div>
              {selectedRole.description && (
                <p className="text-[var(--color-ink-muted)] leading-relaxed">
                  {selectedRole.description}
                </p>
              )}
              <div>
                <span className="font-medium text-[var(--color-ink)]">Admitted Scope Levels: </span>
                <span className="inline-flex gap-1.5 ml-1">
                  {roleAllowedScopes.map((scope) => (
                    <span
                      key={scope}
                      className="inline-flex items-center rounded bg-[var(--color-surface)] px-2 py-0.5 text-[10px] font-mono font-medium text-[var(--color-ink)] border border-[var(--color-border-subtle)]"
                    >
                      {scope}
                    </span>
                  ))}
                </span>
              </div>
            </div>
          )}

          {/* Step 2: Choose Scope Type */}
          {selectedRole && (
            <div className="space-y-3">
              <label className="block text-xs font-medium text-[var(--color-ink)]">
                Select Scope Level <span className="text-[var(--color-bad)]">*</span>
              </label>

              <div className="grid gap-2">
                {/* Organization scope option */}
                {roleAllowedScopes.includes('organization') && (
                  <label
                    className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer text-xs transition-colors ${
                      selectedScopeType === 'organization'
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/5'
                        : 'border-[var(--color-border-subtle)] hover:bg-[var(--color-surface-raised)]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="scopeType"
                      value="organization"
                      checked={selectedScopeType === 'organization'}
                      onChange={() => handleScopeTypeSelect('organization')}
                      className="mt-0.5 text-[var(--color-accent)]"
                    />
                    <div>
                      <p className="font-semibold text-[var(--color-ink)]">Organization Scope</p>
                      <p className="text-[var(--color-ink-muted)] mt-0.5">
                        Applies across the entire organization hierarchy.
                      </p>
                      {selectedScopeType === 'organization' && (
                        <div className="mt-2 rounded bg-[var(--color-surface)] px-2.5 py-1 font-mono text-[11px] border border-[var(--color-border-subtle)] text-[var(--color-ink)]">
                          Target: Current Organization ({selectedOrgId})
                        </div>
                      )}
                    </div>
                  </label>
                )}

                {/* Workspace scope option */}
                {roleAllowedScopes.includes('workspace') && (
                  <label
                    className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer text-xs transition-colors ${
                      selectedScopeType === 'workspace'
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/5'
                        : 'border-[var(--color-border-subtle)] hover:bg-[var(--color-surface-raised)]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="scopeType"
                      value="workspace"
                      checked={selectedScopeType === 'workspace'}
                      onChange={() => handleScopeTypeSelect('workspace')}
                      className="mt-0.5 text-[var(--color-accent)]"
                    />
                    <div className="w-full">
                      <p className="font-semibold text-[var(--color-ink)]">Workspace Scope</p>
                      <p className="text-[var(--color-ink-muted)] mt-0.5">
                        Restricts role authority strictly to a specific workspace.
                      </p>
                      {selectedScopeType === 'workspace' && (
                        <div className="mt-2">
                          {workspacesLoading ? (
                            <p role="status" className="text-[11px] text-[var(--color-ink-muted)]">
                              Loading workspaces…
                            </p>
                          ) : workspaces.length === 0 ? (
                            <p className="text-[11px] text-[var(--color-bad)]">
                              No workspaces exist in this organization.
                            </p>
                          ) : (
                            <select
                              value={selectedWorkspaceId}
                              onChange={(e) => setSelectedWorkspaceId(e.target.value)}
                              className="w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                            >
                              {workspaces.map((ws) => (
                                <option key={ws.id} value={ws.id}>
                                  {ws.name} ({ws.slug})
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      )}
                    </div>
                  </label>
                )}

                {/* Team scope option */}
                {roleAllowedScopes.includes('team') && (
                  <label
                    className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer text-xs transition-colors ${
                      selectedScopeType === 'team'
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/5'
                        : 'border-[var(--color-border-subtle)] hover:bg-[var(--color-surface-raised)]'
                    }`}
                  >
                    <input
                      type="radio"
                      name="scopeType"
                      value="team"
                      checked={selectedScopeType === 'team'}
                      onChange={() => handleScopeTypeSelect('team')}
                      className="mt-0.5 text-[var(--color-accent)]"
                    />
                    <div className="w-full">
                      <p className="font-semibold text-[var(--color-ink)]">Team Scope</p>
                      <p className="text-[var(--color-ink-muted)] mt-0.5">
                        Restricts role authority strictly to a specific team within a workspace.
                      </p>
                      {selectedScopeType === 'team' && (
                        <div className="mt-3 space-y-2.5">
                          <div>
                            <label
                              htmlFor="assign-role-team-workspace-select"
                              className="block text-[11px] font-medium text-[var(--color-ink)]"
                            >
                              Workspace
                            </label>
                            {workspacesLoading ? (
                              <p
                                role="status"
                                className="mt-1 text-[11px] text-[var(--color-ink-muted)]"
                              >
                                Loading workspaces…
                              </p>
                            ) : workspaces.length === 0 ? (
                              <p className="mt-1 text-[11px] text-[var(--color-bad)]">
                                No workspaces exist in this organization.
                              </p>
                            ) : (
                              <select
                                id="assign-role-team-workspace-select"
                                value={selectedWorkspaceId}
                                onChange={(e) => {
                                  setSelectedWorkspaceId(e.target.value);
                                  setSelectedTeamId('');
                                }}
                                className="mt-1 w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                              >
                                {workspaces.map((ws) => (
                                  <option key={ws.id} value={ws.id}>
                                    {ws.name} ({ws.slug})
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>

                          <div>
                            <label
                              htmlFor="assign-role-team-select"
                              className="block text-[11px] font-medium text-[var(--color-ink)]"
                            >
                              Team
                            </label>
                            {teamsLoading ? (
                              <p
                                role="status"
                                className="mt-1 text-[11px] text-[var(--color-ink-muted)]"
                              >
                                Loading teams…
                              </p>
                            ) : teamsError ? (
                              <p role="alert" className="mt-1 text-[11px] text-[var(--color-bad)]">
                                Failed to load teams.
                              </p>
                            ) : teams.length === 0 ? (
                              <p className="mt-1 text-[11px] text-[var(--color-warn)]">
                                No active teams exist in the selected workspace.
                              </p>
                            ) : (
                              <select
                                id="assign-role-team-select"
                                value={selectedTeamId}
                                onChange={(e) => setSelectedTeamId(e.target.value)}
                                className="mt-1 w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                              >
                                {teams.map((team) => (
                                  <option key={team.id} value={team.id}>
                                    {team.name}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </label>
                )}
              </div>
            </div>
          )}

          {/* Error Message Alert */}
          {errorMessage && (
            <div
              role="alert"
              className="rounded-md border border-[var(--color-bad)]/30 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)] space-y-1.5"
            >
              <p className="font-semibold">{errorMessage}</p>
              {rejectedPermissions && rejectedPermissions.length > 0 && (
                <div className="mt-1">
                  <p className="font-medium text-[11px]">Unheld permissions rejected by backend:</p>
                  <ul className="list-disc list-inside mt-0.5 space-y-0.5 font-mono text-[10px]">
                    {rejectedPermissions.map((perm) => (
                      <li key={perm}>{perm}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-3 border-t border-[var(--color-border-subtle)] pt-4">
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
                !selectedRoleId ||
                !selectedScopeType ||
                (selectedScopeType === 'workspace' && !selectedWorkspaceId) ||
                (selectedScopeType === 'team' && (!selectedWorkspaceId || !selectedTeamId))
              }
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? 'Assigning…' : 'Assign Role'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
