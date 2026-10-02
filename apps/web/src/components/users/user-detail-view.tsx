'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  roleAssignmentsApi,
  usersApi,
  workspacesApi,
  type RoleAssignmentView,
  type UserView,
} from '@/lib/api-client';
import { useHasPermission, useSession } from '@/lib/session-store';
import { StatusDot, type StatusTone } from '@/components/ui/status-dot';
import { AssignRoleDialog } from '@/components/role-assignments/assign-role-dialog';
import { RevokeAssignmentDialog } from '@/components/role-assignments/revoke-assignment-dialog';

interface UserDetailViewProps {
  readonly userId: string;
  readonly onBack?: () => void;
  readonly onUserMutated?: () => void;
}

export function UserDetailView({ userId, onBack, onUserMutated }: UserDetailViewProps) {
  const queryClient = useQueryClient();
  const selectedOrgId = useSession((state) => state.selectedOrganizationId);

  // Permissions for gating actions
  const canUpdate = useHasPermission('users.update');
  const canDisable = useHasPermission('users.disable');
  const canReactivate = useHasPermission('users.reactivate');
  const canReadAssignments = useHasPermission('role_assignments.read');
  const canGrantAssignment = useHasPermission('role_assignments.grant');
  const canRevokeAssignment = useHasPermission('role_assignments.revoke');

  // Role Assignment Dialog States
  const [isAssignDialogOpen, setIsAssignDialogOpen] = useState(false);
  const [revokingAssignment, setRevokingAssignment] = useState<RoleAssignmentView | null>(null);

  // Phone editing state
  const [isEditingPhone, setIsEditingPhone] = useState(false);
  const [phoneInput, setPhoneInput] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [isSavingPhone, setIsSavingPhone] = useState(false);

  // Lifecycle confirmation dialog state
  const [confirmAction, setConfirmAction] = useState<'disable' | 'reactivate' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isSubmittingAction, setIsSubmittingAction] = useState(false);

  // Fetch single user detail
  const {
    data: userData,
    isLoading: userLoading,
    error: userError,
    refetch: refetchUser,
  } = useQuery({
    queryKey: ['users', 'detail', selectedOrgId, userId],
    queryFn: ({ signal }) => usersApi.get(userId, signal),
    enabled: !!selectedOrgId && !!userId,
  });

  // Fetch role assignments for this user
  const {
    data: assignmentsData,
    isLoading: assignmentsLoading,
    error: assignmentsError,
    refetch: refetchAssignments,
  } = useQuery({
    queryKey: ['role-assignments', selectedOrgId, userId],
    queryFn: ({ signal }) => roleAssignmentsApi.listForUser(userId, signal),
    enabled: !!selectedOrgId && !!userId && canReadAssignments,
  });

  // Fetch workspaces for resolving human-readable names
  const { data: workspacesData } = useQuery({
    queryKey: ['workspaces', 'list', selectedOrgId],
    queryFn: ({ signal }) => workspacesApi.list(signal),
    enabled: !!selectedOrgId && canReadAssignments,
  });

  const workspaceMap = new Map<string, string>();
  for (const ws of workspacesData?.data ?? []) {
    workspaceMap.set(ws.id, ws.name);
  }

  const user: UserView | undefined = userData?.data;

  // Status mapping
  const statusTone: Record<string, StatusTone> = {
    active: 'ok',
    invited: 'warn',
    disabled: 'bad',
  };

  const handlePhoneSave = async () => {
    setPhoneError(null);
    const trimmed = phoneInput.trim();
    if (trimmed && !/^\+[1-9]\d{6,14}$/.test(trimmed)) {
      setPhoneError('Phone must be in E.164 format, e.g. +919876543210');
      return;
    }

    setIsSavingPhone(true);
    try {
      await usersApi.update(userId, { phone: trimmed || null });
      setIsEditingPhone(false);
      await refetchUser();
      void queryClient.invalidateQueries({ queryKey: ['users', 'list', selectedOrgId] });
      onUserMutated?.();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 400) {
          const issues = err.details?.issues as
            Array<{ field: string; message: string }> | undefined;
          if (issues && issues.length > 0 && issues[0]) {
            setPhoneError(issues[0].message);
          } else {
            setPhoneError(err.message || 'Validation failed');
          }
        } else if (err.status === 403) {
          setPhoneError('You do not have permission to update users (users.update required).');
        } else {
          setPhoneError(err.message);
        }
      } else {
        setPhoneError('Failed to save phone number.');
      }
    } finally {
      setIsSavingPhone(false);
    }
  };

  const handleLifecycleAction = async () => {
    if (!confirmAction) return;
    setActionError(null);
    setIsSubmittingAction(true);

    try {
      if (confirmAction === 'disable') {
        await usersApi.disable(userId);
      } else {
        await usersApi.reactivate(userId);
      }

      setConfirmAction(null);
      await refetchUser();
      void queryClient.invalidateQueries({ queryKey: ['users', 'list', selectedOrgId] });
      onUserMutated?.();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.code === 'AUTHZ_LAST_PLATFORM_ADMIN') {
          setActionError(
            'Cannot disable the last active platform administrator. Appoint another administrator first.',
          );
        } else if (err.code === 'USER_LIFECYCLE_CONFLICT') {
          // Re-sync state
          await refetchUser();
          void queryClient.invalidateQueries({ queryKey: ['users', 'list', selectedOrgId] });
          setActionError(
            `User status was already modified by another operator (${(err.details?.status as string) || 'updated'}). State has been refreshed.`,
          );
        } else if (err.status === 403) {
          setActionError('You lack permission for this lifecycle action in this organization.');
        } else {
          setActionError(err.message || 'Action failed.');
        }
      } else {
        setActionError('Network error while processing lifecycle action.');
      }
    } finally {
      setIsSubmittingAction(false);
    }
  };

  if (userLoading) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-6">
        <div className="flex items-center gap-3">
          <div className="size-4 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
          <p className="text-sm text-[var(--color-ink-muted)]">Loading user details…</p>
        </div>
      </div>
    );
  }

  if (userError || !user) {
    const isNotFound = userError instanceof ApiError && userError.status === 404;
    const isForbidden = userError instanceof ApiError && userError.status === 403;

    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-6">
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-4">
          <h2 className="text-base font-semibold text-[var(--color-ink)]">User Details</h2>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="text-xs text-[var(--color-accent)] hover:underline"
            >
              ← Back to Users
            </button>
          )}
        </div>
        <div className="mt-6 text-center">
          {isNotFound ? (
            <>
              <p className="text-sm font-semibold text-[var(--color-ink)]">User Not Found</p>
              <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                This user does not exist or does not belong to the selected organization.
              </p>
            </>
          ) : isForbidden ? (
            <>
              <p className="text-sm font-semibold text-[var(--color-bad)]">Access Forbidden</p>
              <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                You lack the <code className="font-mono">users.read</code> permission required to
                view this user.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-[var(--color-bad)]">Error Loading User</p>
              <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                {userError instanceof ApiError
                  ? userError.message
                  : 'An unexpected error occurred.'}
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-6 shadow-xs">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-border-subtle)] pb-4">
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold text-[var(--color-ink)]">{user.email}</h2>
              <StatusDot tone={statusTone[user.status] ?? 'unknown'} label={user.status} />
            </div>
            <p className="mt-0.5 font-mono text-xs text-[var(--color-ink-muted)]">ID: {user.id}</p>
          </div>

          <div className="flex items-center gap-3">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
              >
                ← Back to Users
              </button>
            )}

            {/* Lifecycle action buttons */}
            {user.status !== 'disabled' && canDisable && (
              <button
                type="button"
                onClick={() => {
                  setActionError(null);
                  setConfirmAction('disable');
                }}
                className="rounded-md border border-[var(--color-bad)]/40 bg-[var(--color-bad)]/10 px-3 py-1 text-xs font-medium text-[var(--color-bad)] hover:bg-[var(--color-bad)]/20"
              >
                Disable Account
              </button>
            )}

            {user.status === 'disabled' && canReactivate && (
              <button
                type="button"
                onClick={() => {
                  setActionError(null);
                  setConfirmAction('reactivate');
                }}
                className="rounded-md bg-[var(--color-ok)] px-3 py-1 text-xs font-medium text-white hover:opacity-90"
              >
                Reactivate Account
              </button>
            )}
          </div>
        </div>

        {/* Global Lifecycle Warning Banner when viewing disabled user */}
        {user.status === 'disabled' && (
          <div className="mt-4 rounded-md border border-[var(--color-bad)]/30 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]">
            This account is currently <span className="font-semibold">disabled globally</span>{' '}
            across all organizations and has all sessions terminated.
          </div>
        )}

        {/* Details Grid */}
        <div className="mt-6 grid gap-6 sm:grid-cols-2">
          {/* Email */}
          <div>
            <p className="text-xs font-medium text-[var(--color-ink-muted)]">Login Email</p>
            <p className="mt-1 text-sm font-medium text-[var(--color-ink)]">{user.email}</p>
            <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
              Login identities are immutable and cannot be edited.
            </p>
          </div>

          {/* Phone */}
          <div>
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-[var(--color-ink-muted)]">Phone Number</p>
              {!isEditingPhone && canUpdate && (
                <button
                  type="button"
                  onClick={() => {
                    setPhoneInput(user.phone ?? '');
                    setPhoneError(null);
                    setIsEditingPhone(true);
                  }}
                  className="text-xs text-[var(--color-accent)] hover:underline"
                >
                  Edit
                </button>
              )}
            </div>

            {isEditingPhone ? (
              <div className="mt-1 space-y-2">
                <input
                  type="tel"
                  value={phoneInput}
                  onChange={(e) => setPhoneInput(e.target.value)}
                  placeholder="+919876543210 (or leave empty to clear)"
                  className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                />
                {phoneError && <p className="text-xs text-[var(--color-bad)]">{phoneError}</p>}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handlePhoneSave}
                    disabled={isSavingPhone}
                    className="rounded bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {isSavingPhone ? 'Saving…' : 'Save'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsEditingPhone(false)}
                    disabled={isSavingPhone}
                    className="rounded border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <p className="mt-1 text-sm font-medium text-[var(--color-ink)]">
                {user.phone ?? (
                  <span className="text-[var(--color-ink-muted)]">Not configured</span>
                )}
              </p>
            )}
          </div>

          {/* Timestamps */}
          <div>
            <p className="text-xs font-medium text-[var(--color-ink-muted)]">Created At</p>
            <p className="mt-1 text-sm text-[var(--color-ink)]">
              {new Date(user.createdAt).toLocaleString()}
            </p>
          </div>

          <div>
            <p className="text-xs font-medium text-[var(--color-ink-muted)]">Last Updated</p>
            <p className="mt-1 text-sm text-[var(--color-ink)]">
              {new Date(user.updatedAt).toLocaleString()}
            </p>
          </div>

          <div>
            <p className="text-xs font-medium text-[var(--color-ink-muted)]">Last Login</p>
            <p className="mt-1 text-sm text-[var(--color-ink)]">
              {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never logged in'}
            </p>
          </div>
        </div>
      </div>

      {/* Role Assignments Section */}
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-6 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-border-subtle)] pb-4">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-ink)]">Role Assignments</h3>
            <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
              Grants held by this user within the current organization hierarchy.
            </p>
          </div>
          {canGrantAssignment && (
            <button
              type="button"
              onClick={() => setIsAssignDialogOpen(true)}
              disabled={user.status === 'disabled'}
              title={
                user.status === 'disabled' ? 'Cannot assign roles to a disabled user' : undefined
              }
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              + Assign Role
            </button>
          )}
        </div>

        {user.status === 'disabled' && (
          <div className="mt-3 rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/5 p-2.5 text-xs text-[var(--color-bad)]">
            This account is disabled. Role assignment mutations are blocked for disabled users.
          </div>
        )}

        {!canReadAssignments ? (
          <p className="mt-4 text-xs text-[var(--color-ink-muted)]">
            Viewing role assignments requires{' '}
            <code className="font-mono">role_assignments.read</code> permission.
          </p>
        ) : assignmentsLoading ? (
          <p className="mt-4 text-xs text-[var(--color-ink-muted)]">Loading assignments…</p>
        ) : assignmentsError ? (
          <p className="mt-4 text-xs text-[var(--color-bad)]">
            Failed to load assignments:{' '}
            {assignmentsError instanceof ApiError ? assignmentsError.message : 'Unknown error'}
          </p>
        ) : assignmentsData?.data && assignmentsData.data.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[var(--color-border-subtle)] text-[var(--color-ink-muted)]">
                  <th className="pb-2 font-medium">Role Key</th>
                  <th className="pb-2 font-medium">Scope Level</th>
                  <th className="pb-2 font-medium">Target Scope</th>
                  <th className="pb-2 font-medium">Granted At</th>
                  {canRevokeAssignment && <th className="pb-2 font-medium text-right">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)]">
                {assignmentsData.data.map((grant) => {
                  let targetDisplay = grant.scopeId ?? 'Global';
                  if (grant.scopeType === 'organization') {
                    targetDisplay =
                      grant.scopeId === selectedOrgId
                        ? `Current Org (${grant.scopeId})`
                        : (grant.scopeId ?? 'Organization');
                  } else if (grant.scopeType === 'workspace' && grant.scopeId) {
                    const wsName = workspaceMap.get(grant.scopeId);
                    targetDisplay = wsName ? `${wsName} (${grant.scopeId})` : grant.scopeId;
                  }

                  return (
                    <tr key={grant.id}>
                      <td className="py-2.5 font-mono font-medium text-[var(--color-ink)]">
                        {grant.roleKey}
                      </td>
                      <td className="py-2.5">
                        <span className="inline-flex items-center rounded bg-[var(--color-surface)] px-2 py-0.5 text-[10px] font-mono font-medium text-[var(--color-ink)] border border-[var(--color-border-subtle)]">
                          {grant.scopeType}
                        </span>
                      </td>
                      <td className="py-2.5 text-[var(--color-ink-muted)] font-mono text-[11px]">
                        {targetDisplay}
                      </td>
                      <td className="py-2.5 text-[var(--color-ink-muted)]">
                        {new Date(grant.createdAt).toLocaleDateString()}
                      </td>
                      {canRevokeAssignment && (
                        <td className="py-2.5 text-right">
                          <button
                            type="button"
                            onClick={() => setRevokingAssignment(grant)}
                            className="text-xs font-medium text-[var(--color-bad)] hover:underline"
                          >
                            Revoke
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-4 text-xs text-[var(--color-ink-muted)]">
            No role assignments found in this organization context.
          </p>
        )}
      </div>

      {/* Assign Role Dialog */}
      <AssignRoleDialog
        isOpen={isAssignDialogOpen}
        userId={userId}
        userEmail={user.email}
        onClose={() => setIsAssignDialogOpen(false)}
        onSuccess={() => {
          void refetchAssignments();
          void queryClient.invalidateQueries({
            queryKey: ['role-assignments', selectedOrgId, userId],
          });
          onUserMutated?.();
        }}
      />

      {/* Revoke Assignment Dialog */}
      <RevokeAssignmentDialog
        isOpen={!!revokingAssignment}
        assignment={revokingAssignment}
        userEmail={user.email}
        targetLabel={
          revokingAssignment
            ? revokingAssignment.scopeType === 'organization'
              ? 'Current Organization'
              : (workspaceMap.get(revokingAssignment.scopeId ?? '') ?? undefined)
            : undefined
        }
        onClose={() => setRevokingAssignment(null)}
        onSuccess={() => {
          void refetchAssignments();
          void queryClient.invalidateQueries({
            queryKey: ['role-assignments', selectedOrgId, userId],
          });
          onUserMutated?.();
        }}
      />

      {/* Confirmation Modal for Lifecycle Actions */}
      {confirmAction && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-action-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        >
          <div
            className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3
              id="confirm-action-title"
              className="text-base font-semibold text-[var(--color-ink)]"
            >
              {confirmAction === 'disable' ? 'Disable User Account' : 'Reactivate User Account'}
            </h3>

            <div className="mt-3 text-xs leading-relaxed text-[var(--color-ink-muted)]">
              {confirmAction === 'disable' ? (
                <>
                  <p className="font-semibold text-[var(--color-bad)]">
                    Warning: Disabling is GLOBAL to the identity across all organizations.
                  </p>
                  <p className="mt-2">
                    This will immediately revoke all active browser sessions, tokens, and API keys
                    created by{' '}
                    <span className="font-semibold text-[var(--color-ink)]">{user.email}</span>.
                    This does not merely remove them from this organization.
                  </p>
                </>
              ) : (
                <>
                  <p className="font-semibold text-[var(--color-ink)]">
                    Reactivating will restore the account globally across organizations.
                  </p>
                  <p className="mt-2">
                    Note: Users who have not yet set credentials return to the{' '}
                    <span className="font-semibold">invited</span> state. Prior terminated sessions
                    are not restored; the user must sign in anew.
                  </p>
                </>
              )}
            </div>

            {actionError && (
              <div
                role="alert"
                className="mt-4 rounded-md border border-[var(--color-bad)]/30 bg-[var(--color-bad)]/10 p-2.5 text-xs text-[var(--color-bad)]"
              >
                {actionError}
              </div>
            )}

            <div className="mt-6 flex items-center justify-end gap-3 border-t border-[var(--color-border-subtle)] pt-4">
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                disabled={isSubmittingAction}
                className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleLifecycleAction}
                disabled={isSubmittingAction}
                className={`rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 ${
                  confirmAction === 'disable'
                    ? 'bg-[var(--color-bad)] hover:opacity-90'
                    : 'bg-[var(--color-accent)] hover:opacity-90'
                }`}
              >
                {isSubmittingAction
                  ? 'Processing…'
                  : confirmAction === 'disable'
                    ? 'Confirm Disable'
                    : 'Confirm Reactivate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
