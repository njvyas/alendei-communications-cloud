'use client';

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import {
  permissionsApi,
  rolesApi,
  ApiError,
  type CreateRoleInput,
  type PermissionView,
  type RoleView,
  type TenantCreatableScopeType,
} from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { useHeldOrganizationPermissions, useSession } from '@/lib/session-store';

interface RoleCreateDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (role: RoleView) => void;
}

const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;
const CREATABLE_SCOPES: readonly { type: TenantCreatableScopeType; label: string; desc: string }[] = [
  { type: 'organization', label: 'Organization', desc: 'Can be granted at the organization level' },
  { type: 'workspace', label: 'Workspace', desc: 'Can be granted at the workspace level' },
  { type: 'team', label: 'Team', desc: 'Can be granted at the team level' },
];

export function RoleCreateDialog({ isOpen, onClose, onSuccess }: RoleCreateDialogProps) {
  const selectedOrgId = useSession((state) => state.selectedOrganizationId);
  const heldPermissions = useHeldOrganizationPermissions();

  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [allowedScopeTypes, setAllowedScopeTypes] = useState<TenantCreatableScopeType[]>(['organization']);
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(new Set());
  const [permissionFilter, setPermissionFilter] = useState('');
  const [filterOnlyHeld, setFilterOnlyHeld] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [rejectedPermissions, setRejectedPermissions] = useState<string[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Reset form and generate fresh idempotency key when dialog opens
  useEffect(() => {
    if (isOpen) {
      setKey('');
      setName('');
      setDescription('');
      setAllowedScopeTypes(['organization']);
      setSelectedPermissions(new Set());
      setPermissionFilter('');
      setFilterOnlyHeld(false);
      setIdempotencyKey(crypto.randomUUID());
      setErrorMessage(null);
      setRejectedPermissions([]);
      setFieldErrors({});
      setIsSubmitting(false);
    }
  }, [isOpen]);

  // Load permission catalogue
  const { data: permissionsData, isLoading: permissionsLoading, error: permissionsError } = useQuery({
    queryKey: ['permissions', 'catalogue'],
    queryFn: ({ signal }) => permissionsApi.list({ limit: 100 }, signal),
    enabled: isOpen,
    staleTime: 5 * 60 * 1000,
  });

  // Filter out platform-only permissions (tenant roles can never carry platform.* permissions)
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

  if (!isOpen) return null;

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
    if (!selectedOrgId) return;

    setErrorMessage(null);
    setRejectedPermissions([]);
    setFieldErrors({});

    const errors: Record<string, string> = {};
    const trimmedKey = key.trim();
    const trimmedName = name.trim();

    if (!trimmedKey) {
      errors.key = 'Role key is required';
    } else if (!ROLE_KEY_PATTERN.test(trimmedKey)) {
      errors.key = 'Key must be lower snake_case, 3-64 characters, starting with a letter (e.g. support_lead)';
    }

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

    const payload: CreateRoleInput = {
      key: trimmedKey,
      name: trimmedName,
      description: description.trim() || null,
      allowedScopeTypes,
      permissions: Array.from(selectedPermissions).sort(),
    };

    setIsSubmitting(true);

    try {
      const res = await rolesApi.create(payload, idempotencyKey);
      onSuccess(res.data);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setErrorMessage('A role with this key already exists in this organization.');
          setFieldErrors({ key: 'Role key already taken' });
        } else if (err.status === 403) {
          const details = err.details as { rejected?: string[] } | undefined;
          if (details?.rejected && Array.isArray(details.rejected)) {
            setRejectedPermissions(details.rejected);
            setErrorMessage('Role carries permissions you do not hold at organization scope.');
          } else {
            setErrorMessage(err.message || 'You do not have permission to create this role.');
          }
        } else if (err.status === 400) {
          setErrorMessage(err.message || 'Invalid role payload.');
        } else {
          setErrorMessage(err.message || 'Failed to create role.');
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
      aria-labelledby="create-role-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4"
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-6 py-4">
          <div>
            <h2 id="create-role-dialog-title" className="text-base font-semibold text-[var(--color-ink)]">
              Create Custom Role
            </h2>
            <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
              Define a new tenant-scoped role with granular permissions and permitted grant scopes.
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

        {/* Form Body */}
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
                        <span key={p} className="rounded bg-[var(--color-bad)]/20 px-1.5 py-0.5 font-mono text-[10px]">
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Role Key & Name */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="role-key" className="block font-medium text-[var(--color-ink)]">
                  Role Key <span className="text-[var(--color-bad)]">*</span>
                </label>
                <input
                  id="role-key"
                  type="text"
                  value={key}
                  onChange={(e) => setKey(e.target.value.toLowerCase().trim())}
                  placeholder="e.g. support_lead"
                  className={cn(
                    'mt-1 w-full rounded-md border bg-[var(--color-surface)] px-3 py-1.5 font-mono text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1',
                    fieldErrors.key
                      ? 'border-[var(--color-bad)] focus:ring-[var(--color-bad)]'
                      : 'border-[var(--color-border-subtle)] focus:ring-[var(--color-brand)]',
                  )}
                  disabled={isSubmitting}
                />
                {fieldErrors.key ? (
                  <p className="mt-1 text-[11px] text-[var(--color-bad)]">{fieldErrors.key}</p>
                ) : (
                  <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
                    Lower snake_case, 3-64 chars. Permanent identity.
                  </p>
                )}
              </div>

              <div>
                <label htmlFor="role-name" className="block font-medium text-[var(--color-ink)]">
                  Display Name <span className="text-[var(--color-bad)]">*</span>
                </label>
                <input
                  id="role-name"
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
              <label htmlFor="role-desc" className="block font-medium text-[var(--color-ink)]">
                Description (Optional)
              </label>
              <textarea
                id="role-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="Briefly describe what responsibilities this custom role confers..."
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
                Choose the scope levels where administrators are permitted to grant this role.
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
                        <span className="font-semibold text-[var(--color-ink)]">{scope.label}</span>
                        <p className="mt-0.5 text-[10px] text-[var(--color-ink-muted)]">{scope.desc}</p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Permissions Selection */}
            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-subtle)] pb-2">
                <div>
                  <label className="font-medium text-[var(--color-ink)]">
                    Role Permissions ({selectedPermissions.size} selected)
                  </label>
                  <p className="mt-0.5 text-[11px] text-[var(--color-ink-muted)]">
                    Only permissions you currently hold at organization scope can be granted.
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

              {/* Permission Search Input */}
              <div className="mt-2">
                <input
                  type="text"
                  value={permissionFilter}
                  onChange={(e) => setPermissionFilter(e.target.value)}
                  placeholder="Filter permissions by keyword or domain..."
                  className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-brand)]"
                />
              </div>

              {/* Grouped Permission List */}
              <div className="mt-3 max-h-60 space-y-4 overflow-y-auto rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3">
                {permissionsLoading ? (
                  <p className="text-center text-xs text-[var(--color-ink-muted)] py-4">Loading catalogue...</p>
                ) : permissionsError ? (
                  <p className="text-center text-xs text-[var(--color-bad)] py-4">Failed to load permissions catalogue.</p>
                ) : groupedPermissions.length === 0 ? (
                  <p className="text-center text-xs text-[var(--color-ink-muted)] py-4">No matching permissions found.</p>
                ) : (
                  groupedPermissions.map(([domain, perms]) => {
                    const allInGroupSelected = perms.every((p) => selectedPermissions.has(p.key));

                    return (
                      <div key={domain} className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-2.5">
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
              {isSubmitting ? 'Creating Role...' : 'Create Role'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
