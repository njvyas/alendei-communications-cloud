'use client';

import { useMemo, useState } from 'react';

import { type RoleView } from '@/lib/api-client';
import { useHasPermission } from '@/lib/session-store';
import { RoleDeleteDialog } from './role-delete-dialog';
import { RoleEditDialog } from './role-edit-dialog';

interface RoleDetailViewProps {
  role: RoleView;
  onBack?: () => void;
  onRoleUpdated: (updatedRole: RoleView) => void;
  onRoleDeleted: (deletedRoleId: string) => void;
}

export function RoleDetailView({ role, onBack, onRoleUpdated, onRoleDeleted }: RoleDetailViewProps) {
  const canUpdate = useHasPermission('roles.update');
  const canDelete = useHasPermission('roles.delete');

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);

  const isPlatformRole = role.orgId === null;
  const isSystemRole = role.isSystemRole;
  const isCustomRole = !isPlatformRole && !isSystemRole;

  // Group permissions by domain (e.g. "users.read" -> domain "users")
  const groupedPermissions = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const perm of role.permissions) {
      const dotIndex = perm.lastIndexOf('.');
      const domain = dotIndex > 0 ? perm.slice(0, dotIndex) : 'general';
      const existing = groups.get(domain);
      if (existing) {
        existing.push(perm);
      } else {
        groups.set(domain, [perm]);
      }
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [role.permissions]);

  return (
    <div className="space-y-6">
      {/* Role Header Card */}
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-6 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-border-subtle)] pb-4">
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-semibold text-[var(--color-ink)]">{role.name}</h1>
              {isPlatformRole ? (
                <span className="rounded bg-[var(--color-brand)]/15 px-2 py-0.5 font-mono text-xs font-medium text-[var(--color-brand)]">
                  Platform Role
                </span>
              ) : isSystemRole ? (
                <span className="rounded bg-[var(--color-brand)]/10 px-2 py-0.5 font-mono text-xs font-medium text-[var(--color-brand)]">
                  System Role
                </span>
              ) : (
                <span className="rounded bg-[var(--color-surface)] border border-[var(--color-border-subtle)] px-2 py-0.5 font-mono text-xs font-medium text-[var(--color-ink)]">
                  Custom Role
                </span>
              )}
            </div>
            <p className="mt-1 font-mono text-xs text-[var(--color-ink-muted)]">Key: {role.key}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
              >
                ← Back to Roles
              </button>
            )}

            {isCustomRole && canUpdate && (
              <button
                type="button"
                onClick={() => setIsEditOpen(true)}
                className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
              >
                Edit Role
              </button>
            )}

            {isCustomRole && canDelete && (
              <button
                type="button"
                onClick={() => setIsDeleteOpen(true)}
                className="rounded-md border border-[var(--color-bad)]/40 bg-[var(--color-bad)]/10 px-3 py-1.5 text-xs font-medium text-[var(--color-bad)] hover:bg-[var(--color-bad)]/20"
              >
                Delete Role
              </button>
            )}
          </div>
        </div>

        {/* System Immutability Banner */}
        {!isCustomRole && (
          <div className="mt-4 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/60 p-3 text-xs text-[var(--color-ink-muted)]">
            <span className="font-semibold text-[var(--color-ink)]">System-Defined Role: </span>
            This role is defined by the platform architecture and is immutable. Its name, description, allowed scope levels,
            and bundled permissions cannot be modified or deleted by tenant administrators.
          </div>
        )}

        {/* Role Attributes Grid */}
        <div className="mt-5 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="text-xs font-medium text-[var(--color-ink-muted)]">Ownership</p>
            <p className="mt-1 text-sm font-medium text-[var(--color-ink)]">
              {isPlatformRole ? 'Platform-defined (Shared)' : 'Organization-owned'}
            </p>
          </div>

          <div>
            <p className="text-xs font-medium text-[var(--color-ink-muted)]">Allowed Grant Scopes</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {role.allowedScopeTypes.map((scope) => (
                <span
                  key={scope}
                  className="rounded bg-[var(--color-surface)] border border-[var(--color-border-subtle)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-ink)]"
                >
                  {scope}
                </span>
              ))}
            </div>
          </div>

          <div>
            <p className="text-xs font-medium text-[var(--color-ink-muted)]">Total Permissions</p>
            <p className="mt-1 text-sm font-semibold text-[var(--color-ink)]">{role.permissions.length}</p>
          </div>

          <div>
            <p className="text-xs font-medium text-[var(--color-ink-muted)]">Last Updated</p>
            <p className="mt-1 text-sm text-[var(--color-ink)]">{new Date(role.updatedAt).toLocaleString()}</p>
          </div>
        </div>

        {/* Description */}
        {role.description && (
          <div className="mt-5 border-t border-[var(--color-border-subtle)] pt-4">
            <p className="text-xs font-medium text-[var(--color-ink-muted)]">Description</p>
            <p className="mt-1 text-xs text-[var(--color-ink)] leading-relaxed">{role.description}</p>
          </div>
        )}
      </div>

      {/* Permissions Breakdown */}
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-6 shadow-xs">
        <div className="border-b border-[var(--color-border-subtle)] pb-3">
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">
            Permissions ({role.permissions.length})
          </h2>
          <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
            Granular actions conferred to holders of this role across permitted scopes.
          </p>
        </div>

        {groupedPermissions.length === 0 ? (
          <p className="mt-4 text-xs text-[var(--color-ink-muted)]">This role carries no permissions.</p>
        ) : (
          <div className="mt-4 space-y-4">
            {groupedPermissions.map(([domain, perms]) => (
              <div
                key={domain}
                className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3.5"
              >
                <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-2">
                  <span className="font-mono text-xs font-semibold uppercase tracking-wider text-[var(--color-brand)]">
                    {domain}
                  </span>
                  <span className="text-[11px] text-[var(--color-ink-muted)]">
                    {perms.length} {perms.length === 1 ? 'action' : 'actions'}
                  </span>
                </div>

                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {perms.map((perm) => (
                    <span
                      key={perm}
                      className="rounded bg-[var(--color-surface-raised)] border border-[var(--color-border-subtle)] px-2 py-1 font-mono text-xs text-[var(--color-ink)]"
                    >
                      {perm}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modals */}
      {isCustomRole && (
        <>
          <RoleEditDialog
            role={role}
            isOpen={isEditOpen}
            onClose={() => setIsEditOpen(false)}
            onSuccess={onRoleUpdated}
          />
          <RoleDeleteDialog
            role={role}
            isOpen={isDeleteOpen}
            onClose={() => setIsDeleteOpen(false)}
            onSuccess={onRoleDeleted}
          />
        </>
      )}
    </div>
  );
}
