'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import {
  permissionsApi,
  rolesApi,
  ApiError,
  type PermissionView,
  type RoleView,
  type TenantCreatableScopeType,
  type UpdateRoleInput,
} from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { useHeldOrganizationPermissions } from '@/lib/session-store';

interface RoleEditDialogProps {
  role: RoleView | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (updatedRole: RoleView) => void;
}

const CREATABLE_SCOPES: readonly { type: TenantCreatableScopeType; label: string; desc: string }[] =
  [
    {
      type: 'organization',
      label: 'Organization',
      desc: 'Can be granted at the organization level',
    },
    { type: 'workspace', label: 'Workspace', desc: 'Can be granted at the workspace level' },
    { type: 'team', label: 'Team', desc: 'Can be granted at the team level' },
  ];

export function RoleEditDialog({ role, isOpen, onClose, onSuccess }: RoleEditDialogProps) {
  const heldPermissions = useHeldOrganizationPermissions();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [allowedScopeTypes, setAllowedScopeTypes] = useState<TenantCreatableScopeType[]>([]);
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(new Set());
  const [permissionFilter, setPermissionFilter] = useState('');
  const [filterOnlyHeld, setFilterOnlyHeld] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [rejectedPermissions, setRejectedPermissions] = useState<string[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Sync state when role changes or modal opens
  useEffect(() => {
    if (isOpen && role) {
      setName(role.name);
      setDescription(role.description ?? '');
      // Cast allowedScopeTypes filtering down to tenant creatable scopes
      const tenantScopes = role.allowedScopeTypes.filter(
        (s): s is TenantCreatableScopeType =>
          s === 'organization' || s === 'workspace' || s === 'team',
      );
      setAllowedScopeTypes(tenantScopes.length > 0 ? tenantScopes : ['organization']);
      setSelectedPermissions(new Set(role.permissions));
      setPermissionFilter('');
      setFilterOnlyHeld(false);
      setErrorMessage(null);
      setRejectedPermissions([]);
      setFieldErrors({});
      setIsSubmitting(false);
    }
  }, [isOpen, role]);

  // Load permission catalogue
  const {
    data: permissionsData,
    isLoading: permissionsLoading,
    error: permissionsError,
  } = useQuery({
    queryKey: ['permissions', 'catalogue'],
    queryFn: ({ signal }) => permissionsApi.list({ limit: 100 }, signal),
    enabled: isOpen,
    staleTime: 5 * 60 * 1000,
  });

  // Filter out platform-only permissions
  const tenantAssignablePermissions = useMemo(() => {
    const all = permissionsData?.data ?? [];
    return all.filter((p) => !p.key.startsWith('platform.') && p.domain !== 'platform');
  }, [permissionsData]);

  // Group permissions by domain
  const groupedPermissions = useMemo(() => {
    const groups = new Map<string, PermissionView[]>();
    for (const perm of tenantAssignablePermissions) {
      if (filterOnlyHeld && !heldPermissions.has(perm.key)) {
        continue;
      }
      if (permissionFilter.trim()) {
        const query = permissionFilter.toLowerCase();
        const matchesKey = perm.key.toLowerCase().includes(query);
        const matchesDomain = perm.domain.toLowerCase().includes(query);
        const matchesDesc = perm.description?.toLowerCase().includes(query) ?? false;
        if (!matchesKey && !matchesDomain && !matchesDesc) {
          continue;
        }
      }
      const existing = groups.get(perm.domain);
      if (existing) {
        existing.push(perm);
      } else {
        groups.set(perm.domain, [perm]);
      }
    }
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [tenantAssignablePermissions, permissionFilter, filterOnlyHeld, heldPermissions]);

  if (!isOpen || !role) return null;

  // Protect system roles from being edited through UI
  const isImmutable = role.isSystemRole || role.orgId === null;

  const handleToggleScope = (scope: TenantCreatableScopeType) => {
    setAllowedScopeTypes((prev) => {
      if (prev.includes(scope)) {
        return prev.filter((s) => s !== scope);
      }
      return [...prev, scope];
    });
  };

  const handleTogglePermission = (permKey: string) => {
    setSelectedPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(permKey)) {
        next.delete(permKey);
      } else {
        next.add(permKey);
      }
      return next;
    });
  };

  const handleToggleGroup = (perms: PermissionView[]) => {
    const allSelected = perms.every((p) => selectedPermissions.has(p.key));
    setSelectedPermissions((prev) => {
      const next = new Set(prev);
      for (const p of perms) {
        if (allSelected) {
          next.delete(p.key);
        } else {
          next.add(p.key);
        }
      }
      return next;
    });
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (isImmutable) return;

    setErrorMessage(null);
    setRejectedPermissions([]);
    setFieldErrors({});

    const errors: Record<string, string> = {};
    const trimmedName = name.trim();

    if (!trimmedName) {
      errors.name = 'Role name is required';
    } else if (trimmedName.length > 120) {
      errors.name = 'Role name cannot exceed 120 characters';
    }

    if (allowedScopeTypes.length === 0) {
      errors.scopes = 'At least one allowed scope type must be selected';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    // IMPORTANT: PATCH permissions is a COMPLETE REPLACEMENT SET, never a delta
    const payload: UpdateRoleInput = {
      name: trimmedName,
      description: description.trim() || null,
      allowedScopeTypes,
      permissions: Array.from(selectedPermissions).sort(),
    };

    setIsSubmitting(true);

    try {
      const res = await rolesApi.update(role.id, payload);
      onSuccess(res.data);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 403) {
          const details = err.details as { rejected?: string[] } | undefined;
          if (details?.rejected && Array.isArray(details.rejected)) {
            setRejectedPermissions(details.rejected);
            setErrorMessage('Role carries permissions you do not hold at organization scope.');
          } else {
            setErrorMessage(err.message || 'System roles cannot be modified.');
          }
        } else if (err.status === 404) {
          setErrorMessage('Role not found.');
        } else if (err.status === 400) {
          setErrorMessage(err.message || 'Invalid update payload.');
        } else {
          setErrorMessage(err.message || 'Failed to update role.');
        }
      } else {
        setErrorMessage('An unexpected network error occurred.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-role-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4"
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-6 py-4">
          <div>
            <div className="flex items-center gap-2">
              <h2
                id="edit-role-dialog-title"
                className="text-base font-semibold text-[var(--color-ink)]"
              >
                Edit Role: {role.name}
              </h2>
              {isImmutable && (
                <span className="rounded bg-[var(--color-brand)]/15 px-2 py-0.5 font-mono text-[10px] text-[var(--color-brand)]">
                  System Protected
                </span>
              )}
            </div>
            <p className="mt-0.5 font-mono text-xs text-[var(--color-ink-muted)]">
              Key: {role.key}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]"
          >
            ✕
          </button>
        </div>

        {isImmutable ? (
          <div className="p-6 text-xs text-[var(--color-ink-muted)] space-y-4">
            <div className="rounded-lg border border-[var(--color-bad)]/40 bg-[var(--color-bad)]/10 p-4 text-[var(--color-bad)]">
              <p className="font-semibold">System and Platform Roles Cannot Be Modified</p>
              <p className="mt-1 text-[11px]">
                The role <code className="font-mono">{role.key}</code> is defined by the platform
                schema and is immutable. Tenant administrators cannot modify its name, description,
                allowed scope types, or permissions.
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
          <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-hidden">
            <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5 text-xs">
              {/* Top Error Alert */}
              {errorMessage && (
                <div className="rounded-lg border border-[var(--color-bad)]/40 bg-[var(--color-bad)]/10 p-3 text-[var(--color-bad)]">
                  <p className="font-semibold">{errorMessage}</p>
                  {rejectedPermissions.length > 0 && (
                    <div className="mt-2">
                      <p className="text-[11px] font-medium">Offending unheld permissions:</p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {rejectedPermissions.map((p) => (
                          <span
                            key={p}
                            className="rounded bg-[var(--color-bad)]/20 px-1.5 py-0.5 font-mono text-[10px]"
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Immutable Role Key & Editable Name */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="edit-role-key"
                    className="block font-medium text-[var(--color-ink)]"
                  >
                    Role Key
                  </label>
                  <input
                    id="edit-role-key"
                    type="text"
                    value={role.key}
                    disabled
                    className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)]/60 px-3 py-1.5 font-mono text-xs text-[var(--color-ink-muted)] cursor-not-allowed"
                  />
                  <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
                    Role key is an immutable identity.
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="edit-role-name"
                    className="block font-medium text-[var(--color-ink)]"
                  >
                    Display Name <span className="text-[var(--color-bad)]">*</span>
                  </label>
                  <input
                    id="edit-role-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Support Team Lead"
                    className={cn(
                      'mt-1 w-full rounded-md border bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1',
                      fieldErrors.name
                        ? 'border-[var(--color-bad)] focus:ring-[var(--color-bad)]'
                        : 'border-[var(--color-border-subtle)] focus:ring-[var(--color-brand)]',
                    )}
                    disabled={isSubmitting}
                  />
                  {fieldErrors.name && (
                    <p className="mt-1 text-[11px] text-[var(--color-bad)]">{fieldErrors.name}</p>
                  )}
                </div>
              </div>

              {/* Description */}
              <div>
                <label
                  htmlFor="edit-role-desc"
                  className="block font-medium text-[var(--color-ink)]"
                >
                  Description
                </label>
                <textarea
                  id="edit-role-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  placeholder="Describe role responsibilities..."
                  className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
                  disabled={isSubmitting}
                />
              </div>

              {/* Allowed Scope Types */}
              <div>
                <label className="block font-medium text-[var(--color-ink)]">
                  Allowed Grant Scope Types <span className="text-[var(--color-bad)]">*</span>
                </label>
                <p className="mt-0.5 text-[11px] text-[var(--color-ink-muted)]">
                  Levels where this role may be assigned to users.
                </p>
                {fieldErrors.scopes && (
                  <p className="mt-1 text-[11px] text-[var(--color-bad)]">{fieldErrors.scopes}</p>
                )}
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {CREATABLE_SCOPES.map((scope) => {
                    const isChecked = allowedScopeTypes.includes(scope.type);
                    return (
                      <label
                        key={scope.type}
                        className={cn(
                          'flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors',
                          isChecked
                            ? 'border-[var(--color-brand)]/50 bg-[var(--color-brand)]/5'
                            : 'border-[var(--color-border-subtle)] hover:bg-[var(--color-surface)]',
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => handleToggleScope(scope.type)}
                          className="mt-0.5 rounded border-[var(--color-border-subtle)] text-[var(--color-brand)] focus:ring-[var(--color-brand)]"
                          disabled={isSubmitting}
                        />
                        <div>
                          <span className="font-semibold text-[var(--color-ink)]">
                            {scope.label}
                          </span>
                          <p className="mt-0.5 text-[10px] text-[var(--color-ink-muted)]">
                            {scope.desc}
                          </p>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Permissions Selection (Complete Replacement Set) */}
              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-subtle)] pb-2">
                  <div>
                    <label className="font-medium text-[var(--color-ink)]">
                      Permissions ({selectedPermissions.size} selected)
                    </label>
                    <p className="mt-0.5 text-[11px] text-[var(--color-ink-muted)]">
                      Submitted as a complete replacement set.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 text-[11px] text-[var(--color-ink-muted)] cursor-pointer">
                      <input
                        type="checkbox"
                        checked={filterOnlyHeld}
                        onChange={(e) => setFilterOnlyHeld(e.target.checked)}
                        className="rounded border-[var(--color-border-subtle)]"
                      />
                      <span>Held by me only</span>
                    </label>
                  </div>
                </div>

                {/* Permission Search */}
                <div className="mt-2">
                  <input
                    type="text"
                    value={permissionFilter}
                    onChange={(e) => setPermissionFilter(e.target.value)}
                    placeholder="Filter permissions..."
                    className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
                  />
                </div>

                {/* Grouped Permission List */}
                <div className="mt-3 max-h-60 space-y-4 overflow-y-auto rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3">
                  {permissionsLoading ? (
                    <p className="text-center text-xs text-[var(--color-ink-muted)] py-4">
                      Loading catalogue...
                    </p>
                  ) : permissionsError ? (
                    <p className="text-center text-xs text-[var(--color-bad)] py-4">
                      Failed to load permissions catalogue.
                    </p>
                  ) : groupedPermissions.length === 0 ? (
                    <p className="text-center text-xs text-[var(--color-ink-muted)] py-4">
                      No matching permissions found.
                    </p>
                  ) : (
                    groupedPermissions.map(([domain, perms]) => {
                      const allInGroupSelected = perms.every((p) => selectedPermissions.has(p.key));

                      return (
                        <div
                          key={domain}
                          className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-2.5"
                        >
                          <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-1.5">
                            <span className="font-mono font-semibold uppercase tracking-wider text-[11px] text-[var(--color-brand)]">
                              {domain}
                            </span>
                            <button
                              type="button"
                              onClick={() => handleToggleGroup(perms)}
                              className="text-[10px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] underline"
                            >
                              {allInGroupSelected ? 'Deselect all' : 'Select all'}
                            </button>
                          </div>

                          <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                            {perms.map((p) => {
                              const isSelected = selectedPermissions.has(p.key);
                              const isHeld = heldPermissions.has(p.key);
                              const isOffending = rejectedPermissions.includes(p.key);

                              return (
                                <label
                                  key={p.key}
                                  className={cn(
                                    'flex cursor-pointer items-start gap-2 rounded p-1.5 transition-colors text-[11px]',
                                    isOffending
                                      ? 'border border-[var(--color-bad)] bg-[var(--color-bad)]/10'
                                      : isSelected
                                        ? 'bg-[var(--color-brand)]/10 text-[var(--color-ink)]'
                                        : 'hover:bg-[var(--color-surface)] text-[var(--color-ink-muted)]',
                                  )}
                                >
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => handleTogglePermission(p.key)}
                                    className="mt-0.5 rounded border-[var(--color-border-subtle)] text-[var(--color-brand)]"
                                    disabled={isSubmitting}
                                  />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5">
                                      <span className="font-mono font-medium text-[var(--color-ink)] truncate">
                                        {p.key}
                                      </span>
                                      {!isHeld && (
                                        <span
                                          title="You do not hold this permission at organization scope"
                                          className="shrink-0 rounded bg-[var(--color-bad)]/15 px-1 text-[9px] text-[var(--color-bad)]"
                                        >
                                          Unheld
                                        </span>
                                      )}
                                    </div>
                                    {p.description && (
                                      <p className="mt-0.5 line-clamp-1 text-[10px] text-[var(--color-ink-muted)]">
                                        {p.description}
                                      </p>
                                    )}
                                  </div>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 border-t border-[var(--color-border-subtle)] px-6 py-3">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]"
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="rounded-md bg-[var(--color-brand)] px-4 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {isSubmitting ? 'Saving Changes...' : 'Save Changes'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
