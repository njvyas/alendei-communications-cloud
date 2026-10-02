'use client';

import { useState, useEffect, useMemo, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ApiError,
  apiKeysApi,
  permissionsApi,
  workspacesApi,
  type ApiKeyScopeType,
  type CreatedApiKeyView,
} from '@/lib/api-client';
import { useSession } from '@/lib/session-store';

interface CreateApiKeyDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSuccess: () => void;
}

type ExpiryPreset = '30d' | '60d' | '90d' | '180d' | '365d' | 'custom' | 'never';

export function CreateApiKeyDialog({ isOpen, onClose, onSuccess }: CreateApiKeyDialogProps) {
  const selectedOrgId = useSession((state) => state.selectedOrganizationId);
  const authorization = useSession((state) => state.authorization);

  // Form State
  const [name, setName] = useState('');
  const [scopeType, setScopeType] = useState<ApiKeyScopeType>('organization');
  const [workspaceId, setWorkspaceId] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(new Set());
  const [expiryPreset, setExpiryPreset] = useState<ExpiryPreset>('90d');
  const [customExpiryDate, setCustomExpiryDate] = useState('');
  const [scopeSearch, setScopeSearch] = useState('');

  // Stable Idempotency-Key per dialog session, preserved across network/validation retries
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => crypto.randomUUID());

  // Mutation and result state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Ephemeral Secret State: exists ONLY in component state, never persisted
  const [createdResult, setCreatedResult] = useState<CreatedApiKeyView | null>(null);
  const [hasConfirmedSave, setHasConfirmedSave] = useState(false);
  const [copySuccess, setCopySuccess] = useState(false);

  // Reset form when dialog opens
  useEffect(() => {
    if (isOpen) {
      setName('');
      setScopeType('organization');
      setWorkspaceId('');
      setSelectedScopes(new Set());
      setExpiryPreset('90d');
      setCustomExpiryDate('');
      setScopeSearch('');
      setIdempotencyKey(crypto.randomUUID());
      setIsSubmitting(false);
      setErrorMessage(null);
      setFieldErrors({});
      setCreatedResult(null);
      setHasConfirmedSave(false);
      setCopySuccess(false);
    }
  }, [isOpen]);

  // Cleanup on unmount: guarantee secret is not retained in memory
  useEffect(() => {
    return () => {
      setCreatedResult(null);
    };
  }, []);

  // Fetch workspaces for workspace scope
  const { data: workspacesData, isLoading: workspacesLoading } = useQuery({
    queryKey: ['workspaces', selectedOrgId],
    queryFn: ({ signal }) => workspacesApi.list(signal),
    enabled: isOpen && !!selectedOrgId && scopeType === 'workspace',
  });

  // Fetch full permission catalogue for human-readable labels/domains
  const { data: permissionsData, isLoading: permissionsLoading } = useQuery({
    queryKey: ['permissions', 'catalogue'],
    queryFn: ({ signal }) => permissionsApi.list({ limit: 100 }, signal),
    enabled: isOpen,
    staleTime: 5 * 60 * 1000,
  });

  // Auto-select first workspace when switching to workspace scope
  useEffect(() => {
    if (scopeType === 'workspace') {
      const firstWs = workspacesData?.data?.[0];
      if (firstWs && !workspacesData?.data?.some((w) => w.id === workspaceId)) {
        setWorkspaceId(firstWs.id);
      }
    }
  }, [scopeType, workspacesData, workspaceId]);

  // Compute held permissions that cover the target scope (Downward scope inheritance: RBAC.md §7)
  const heldPermissions = useMemo<Set<string>>(() => {
    if (!authorization) return new Set();
    if (authorization.isPlatformAdmin) {
      // Platform admin holds all permissions in catalogue
      const all = new Set<string>();
      for (const p of permissionsData?.data ?? []) {
        all.add(p.key);
      }
      return all;
    }

    const held = new Set<string>();
    for (const grant of authorization.grants) {
      if (grant.scopeType === 'platform') {
        for (const p of grant.permissions) held.add(p);
      } else if (
        grant.scopeType === 'organization' &&
        selectedOrgId &&
        (grant.scopeId === selectedOrgId || grant.orgId === selectedOrgId)
      ) {
        for (const p of grant.permissions) held.add(p);
      } else if (
        scopeType === 'workspace' &&
        workspaceId &&
        grant.scopeType === 'workspace' &&
        grant.scopeId === workspaceId
      ) {
        for (const p of grant.permissions) held.add(p);
      }
    }
    return held;
  }, [authorization, permissionsData, selectedOrgId, scopeType, workspaceId]);

  // Auto-prune unheld scopes when scope selection changes
  useEffect(() => {
    setSelectedScopes((prev) => {
      const pruned = new Set<string>();
      for (const p of prev) {
        if (heldPermissions.has(p)) {
          pruned.add(p);
        }
      }
      return pruned;
    });
  }, [heldPermissions]);

  if (!isOpen) return null;

  const handleClose = () => {
    // Immediate ephemeral memory wipe of secret
    setCreatedResult(null);
    setHasConfirmedSave(false);
    setCopySuccess(false);
    onClose();
  };

  const handleToggleScope = (permKey: string) => {
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(permKey)) {
        next.delete(permKey);
      } else {
        if (next.size >= 64) return next;
        next.add(permKey);
      }
      return next;
    });
  };

  const handleSelectAllHeld = () => {
    const next = new Set<string>();
    for (const p of heldPermissions) {
      if (next.size >= 64) break;
      next.add(p);
    }
    setSelectedScopes(next);
  };

  const handleDeselectAll = () => {
    setSelectedScopes(new Set());
  };

  const calculateExpiresAt = (): string | null => {
    const now = Date.now();
    switch (expiryPreset) {
      case '30d':
        return new Date(now + 30 * 86400000).toISOString();
      case '60d':
        return new Date(now + 60 * 86400000).toISOString();
      case '90d':
        return new Date(now + 90 * 86400000).toISOString();
      case '180d':
        return new Date(now + 180 * 86400000).toISOString();
      case '365d':
        return new Date(now + 365 * 86400000).toISOString();
      case 'custom':
        if (!customExpiryDate) return null;
        return new Date(`${customExpiryDate}T23:59:59.999Z`).toISOString();
      case 'never':
      default:
        return null;
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedOrgId) return;

    setErrorMessage(null);
    setFieldErrors({});

    const trimmedName = name.trim();
    const errors: Record<string, string> = {};

    if (!trimmedName) {
      errors.name = 'Key name is required.';
    } else if (trimmedName.length > 120) {
      errors.name = 'Name cannot exceed 120 characters.';
    }

    if (scopeType === 'workspace' && !workspaceId) {
      errors.workspaceId = 'Please select a workspace.';
    }

    if (selectedScopes.size === 0) {
      errors.scopes = 'Select at least one permission scope for this key.';
    } else if (selectedScopes.size > 64) {
      errors.scopes = 'An API key can request at most 64 permission scopes.';
    }

    const calculatedExpiry = calculateExpiresAt();
    if (expiryPreset === 'custom') {
      if (!customExpiryDate) {
        errors.expiresAt = 'Please specify a custom expiration date.';
      } else if (calculatedExpiry && new Date(calculatedExpiry).getTime() <= Date.now()) {
        errors.expiresAt = 'Expiration date must be in the future.';
      }
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    const targetScopeId = scopeType === 'workspace' ? workspaceId : selectedOrgId;

    setIsSubmitting(true);
    try {
      const response = await apiKeysApi.create(
        {
          name: trimmedName,
          scopeType,
          scopeId: targetScopeId,
          scopes: Array.from(selectedScopes),
          expiresAt: calculatedExpiry,
        },
        idempotencyKey,
      );

      // Successfully created or replayed. Transition to secret step.
      setCreatedResult(response.data);
      onSuccess();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 403 && err.code === 'AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION') {
          const rejected = (err.details?.rejected as string[] | undefined) ?? [];
          setErrorMessage(
            `You do not hold permission to grant: ${rejected.join(', ') || 'one or more selected permissions'}.`,
          );
        } else if (err.status === 400 && err.details?.issues) {
          const issues = err.details.issues as { field?: string; message?: string }[];
          const nextFieldErrors: Record<string, string> = {};
          for (const issue of issues) {
            if (issue.field) {
              nextFieldErrors[issue.field] = issue.message ?? 'Invalid value.';
            }
          }
          setFieldErrors(nextFieldErrors);
          setErrorMessage(err.message);
        } else {
          setErrorMessage(err.message || 'Failed to create API key.');
        }
      } else {
        setErrorMessage('An unexpected error occurred. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCopyCredential = async () => {
    if (!createdResult?.secret) return;
    const fullCredential = `${createdResult.prefix}.${createdResult.secret}`;
    try {
      await navigator.clipboard.writeText(fullCredential);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2500);
    } catch {
      // Fallback
    }
  };

  // Group permission catalogue for rendering
  const catalogueList = permissionsData?.data ?? [];
  const filteredPermissions = catalogueList.filter((p) => {
    if (!heldPermissions.has(p.key)) return false;
    if (!scopeSearch) return true;
    const q = scopeSearch.toLowerCase();
    return (
      p.key.toLowerCase().includes(q) ||
      (p.description ? p.description.toLowerCase().includes(q) : false)
    );
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-api-key-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
    >
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl text-[var(--color-ink)]">
        {/* Step 2: Secret Display Screen */}
        {createdResult ? (
          <div className="space-y-6">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                <span>✓</span> Key Successfully Created
              </div>
              <h2 id="create-api-key-title" className="mt-2 text-lg font-bold tracking-tight">
                {createdResult.secret
                  ? 'Save Your API Key Secret'
                  : 'API Key Created (Idempotent Replay)'}
              </h2>
              <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                Key name: <strong className="text-[var(--color-ink)]">{createdResult.name}</strong>{' '}
                • Prefix:{' '}
                <code className="font-mono text-[var(--color-ink)]">{createdResult.prefix}</code>
              </p>
            </div>

            {createdResult.secret ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-800 dark:text-amber-300">
                  <p className="font-semibold text-amber-900 dark:text-amber-200">
                    Important: You will not be able to view this secret again!
                  </p>
                  <p className="mt-1">
                    Copy and store this secret securely. For security, only the Argon2id hash is
                    stored on the server. If you lose this credential, you must revoke this key and
                    generate a new one.
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="credential-output"
                    className="block text-xs font-medium text-[var(--color-ink-muted)]"
                  >
                    Full API Credential (
                    <code className="font-mono">&lt;prefix&gt;.&lt;secret&gt;</code>)
                  </label>
                  <div className="mt-1.5 flex items-center gap-2">
                    <input
                      id="credential-output"
                      type="text"
                      readOnly
                      value={`${createdResult.prefix}.${createdResult.secret}`}
                      className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 font-mono text-xs text-[var(--color-ink)] select-all"
                    />
                    <button
                      type="button"
                      onClick={handleCopyCredential}
                      className="shrink-0 rounded-md bg-[var(--color-accent)] px-3 py-2 text-xs font-medium text-white hover:opacity-90"
                    >
                      {copySuccess ? 'Copied!' : 'Copy Key'}
                    </button>
                  </div>
                </div>

                <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 text-xs space-y-1">
                  <div className="flex justify-between">
                    <span className="text-[var(--color-ink-muted)]">Scope:</span>
                    <span className="font-medium capitalize">{createdResult.scopeType}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--color-ink-muted)]">Permissions:</span>
                    <span className="font-medium">{createdResult.scopes.length} granted</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[var(--color-ink-muted)]">Expires:</span>
                    <span className="font-medium">
                      {createdResult.expiresAt
                        ? new Date(createdResult.expiresAt).toLocaleDateString()
                        : 'Never'}
                    </span>
                  </div>
                </div>

                <div className="pt-2">
                  <label className="flex items-start gap-2.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={hasConfirmedSave}
                      onChange={(e) => setHasConfirmedSave(e.target.checked)}
                      className="mt-0.5 size-4 rounded border-[var(--color-border-subtle)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
                    />
                    <span className="text-xs text-[var(--color-ink)]">
                      I have securely copied and saved this API key. I understand it cannot be
                      retrieved again.
                    </span>
                  </label>
                </div>

                <div className="flex justify-end pt-4 border-t border-[var(--color-border-subtle)]">
                  <button
                    type="button"
                    disabled={!hasConfirmedSave}
                    onClick={handleClose}
                    className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-xs font-medium text-white shadow-xs hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Done & Close
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-lg border border-blue-500/40 bg-blue-500/10 p-4 text-xs text-blue-800 dark:text-blue-300">
                  <p className="font-semibold text-blue-900 dark:text-blue-200">
                    Idempotent Replay Confirmed
                  </p>
                  <p className="mt-1">
                    This key was previously created using this idempotency key. Plaintext secrets
                    are generated only on the initial creation response and are never returned on
                    idempotent replays (ADR-008).
                  </p>
                  <p className="mt-2">
                    If you do not have the original secret, please revoke this key and create a new
                    one.
                  </p>
                </div>

                <div className="flex justify-end pt-4 border-t border-[var(--color-border-subtle)]">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="rounded-md border border-[var(--color-border-subtle)] px-4 py-2 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Step 1: Creation Form */
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
              <div>
                <h2 id="create-api-key-title" className="text-lg font-bold tracking-tight">
                  Create API Key
                </h2>
                <p className="text-xs text-[var(--color-ink-muted)]">
                  Mint programmatic credentials for machine workloads and automated integrations.
                </p>
              </div>
              <button
                type="button"
                onClick={handleClose}
                className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
              >
                ✕
              </button>
            </div>

            {errorMessage && (
              <div className="rounded-md border border-[var(--color-bad)]/40 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]">
                {errorMessage}
              </div>
            )}

            {/* Key Name */}
            <div>
              <label
                htmlFor="api-key-name"
                className="block text-xs font-medium text-[var(--color-ink)]"
              >
                Key Name <span className="text-[var(--color-bad)]">*</span>
              </label>
              <input
                id="api-key-name"
                type="text"
                value={name}
                maxLength={120}
                placeholder="e.g. CI/CD Deployment Bot, Webhook Producer"
                onChange={(e) => setName(e.target.value)}
                className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder:text-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
              />
              {fieldErrors.name && (
                <p className="mt-1 text-xs text-[var(--color-bad)]">{fieldErrors.name}</p>
              )}
            </div>

            {/* Scope Type Selection */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-[var(--color-ink)]">
                  Binding Scope Type
                </label>
                <div className="mt-1 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setScopeType('organization')}
                    className={`flex-1 rounded-md border py-1.5 text-xs font-medium transition-colors ${
                      scopeType === 'organization'
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                        : 'border-[var(--color-border-subtle)] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]'
                    }`}
                  >
                    Organization
                  </button>
                  <button
                    type="button"
                    onClick={() => setScopeType('workspace')}
                    className={`flex-1 rounded-md border py-1.5 text-xs font-medium transition-colors ${
                      scopeType === 'workspace'
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                        : 'border-[var(--color-border-subtle)] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]'
                    }`}
                  >
                    Workspace
                  </button>
                </div>
              </div>

              {/* Workspace Selector (Conditional) */}
              {scopeType === 'workspace' && (
                <div>
                  <label
                    htmlFor="workspace-select"
                    className="block text-xs font-medium text-[var(--color-ink)]"
                  >
                    Target Workspace <span className="text-[var(--color-bad)]">*</span>
                  </label>
                  <select
                    id="workspace-select"
                    value={workspaceId}
                    onChange={(e) => setWorkspaceId(e.target.value)}
                    disabled={workspacesLoading}
                    className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                  >
                    {workspacesLoading ? (
                      <option>Loading workspaces…</option>
                    ) : (workspacesData?.data ?? []).length === 0 ? (
                      <option value="">No workspaces available</option>
                    ) : (
                      (workspacesData?.data ?? []).map((ws) => (
                        <option key={ws.id} value={ws.id}>
                          {ws.name} ({ws.slug})
                        </option>
                      ))
                    )}
                  </select>
                  {fieldErrors.workspaceId && (
                    <p className="mt-1 text-xs text-[var(--color-bad)]">
                      {fieldErrors.workspaceId}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Expiration Settings */}
            <div>
              <label
                htmlFor="expiry-preset"
                className="block text-xs font-medium text-[var(--color-ink)]"
              >
                Expiration
              </label>
              <div className="mt-1 flex flex-wrap gap-2">
                {(
                  [
                    { id: '30d', label: '30 Days' },
                    { id: '60d', label: '60 Days' },
                    { id: '90d', label: '90 Days' },
                    { id: '180d', label: '180 Days' },
                    { id: '365d', label: '1 Year' },
                    { id: 'custom', label: 'Custom' },
                    { id: 'never', label: 'No Expiration' },
                  ] as const
                ).map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => setExpiryPreset(preset.id)}
                    className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                      expiryPreset === preset.id
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                        : 'border-[var(--color-border-subtle)] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              {expiryPreset === 'custom' && (
                <div className="mt-2">
                  <input
                    type="date"
                    value={customExpiryDate}
                    onChange={(e) => setCustomExpiryDate(e.target.value)}
                    min={new Date(Date.now() + 86400000).toISOString().split('T')[0]}
                    className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                  />
                  {fieldErrors.expiresAt && (
                    <p className="mt-1 text-xs text-[var(--color-bad)]">{fieldErrors.expiresAt}</p>
                  )}
                </div>
              )}
            </div>

            {/* Permissions / Scopes Selector */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="text-xs font-medium text-[var(--color-ink)]">
                    Permission Scopes <span className="text-[var(--color-bad)]">*</span>
                  </span>
                  <p className="text-[11px] text-[var(--color-ink-muted)]">
                    Keys can only be granted permissions you personally hold at the target scope. (
                    {selectedScopes.size}/64 selected)
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleSelectAllHeld}
                    className="text-[11px] text-[var(--color-accent)] hover:underline"
                  >
                    Select All Held
                  </button>
                  <span className="text-[var(--color-ink-muted)] text-[11px]">|</span>
                  <button
                    type="button"
                    onClick={handleDeselectAll}
                    className="text-[11px] text-[var(--color-ink-muted)] hover:underline"
                  >
                    Clear
                  </button>
                </div>
              </div>

              <input
                type="text"
                placeholder="Search available permissions…"
                value={scopeSearch}
                onChange={(e) => setScopeSearch(e.target.value)}
                className="w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder:text-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
              />

              <div className="max-h-48 overflow-y-auto rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-2 divide-y divide-[var(--color-border-subtle)]">
                {permissionsLoading ? (
                  <p className="p-3 text-center text-xs text-[var(--color-ink-muted)]">
                    Loading permissions…
                  </p>
                ) : filteredPermissions.length === 0 ? (
                  <p className="p-3 text-center text-xs text-[var(--color-ink-muted)]">
                    {heldPermissions.size === 0
                      ? 'No assignable permissions held at this scope.'
                      : 'No matching permissions found.'}
                  </p>
                ) : (
                  filteredPermissions.map((perm) => {
                    const isSelected = selectedScopes.has(perm.key);
                    return (
                      <label
                        key={perm.key}
                        className="flex items-start gap-2.5 py-1.5 px-2 hover:bg-[var(--color-surface)] rounded cursor-pointer transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => handleToggleScope(perm.key)}
                          className="mt-0.5 size-3.5 rounded border-[var(--color-border-subtle)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs text-[var(--color-ink)]">
                              {perm.key}
                            </span>
                            <span className="rounded bg-[var(--color-surface)] px-1.5 py-0.2 text-[10px] text-[var(--color-ink-muted)] border border-[var(--color-border-subtle)]">
                              {perm.domain}
                            </span>
                          </div>
                          <p className="text-[11px] text-[var(--color-ink-muted)] truncate">
                            {perm.description}
                          </p>
                        </div>
                      </label>
                    );
                  })
                )}
              </div>
              {fieldErrors.scopes && (
                <p className="text-xs text-[var(--color-bad)]">{fieldErrors.scopes}</p>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center justify-end gap-3 pt-3 border-t border-[var(--color-border-subtle)]">
              <button
                type="button"
                onClick={handleClose}
                className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-xs font-medium text-white shadow-xs hover:opacity-90 disabled:opacity-50"
              >
                {isSubmitting ? 'Creating Key…' : 'Create API Key'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
