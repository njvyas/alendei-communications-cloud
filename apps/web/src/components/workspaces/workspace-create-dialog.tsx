'use client';

import { useState, useEffect, type FormEvent } from 'react';
import { ApiError, workspacesApi, type WorkspaceView } from '@/lib/api-client';
import { useSession } from '@/lib/session-store';

interface WorkspaceCreateDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSuccess: (ws: WorkspaceView) => void;
}

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,62}$/;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

export function WorkspaceCreateDialog({ isOpen, onClose, onSuccess }: WorkspaceCreateDialogProps) {
  const selectedOrgId = useSession((state) => state.selectedOrganizationId);

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);

  // Stable Idempotency-Key preserved across retries
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => crypto.randomUUID());

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isOpen) {
      setName('');
      setSlug('');
      setSlugManuallyEdited(false);
      setIdempotencyKey(crypto.randomUUID());
      setIsSubmitting(false);
      setErrorMessage(null);
      setFieldErrors({});
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleNameChange = (val: string) => {
    setName(val);
    if (!slugManuallyEdited) {
      setSlug(slugify(val));
    }
  };

  const handleSlugChange = (val: string) => {
    setSlug(val.toLowerCase());
    setSlugManuallyEdited(true);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedOrgId) return;

    setErrorMessage(null);
    setFieldErrors({});

    const errors: Record<string, string> = {};
    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();

    if (!trimmedName) {
      errors.name = 'Workspace name is required';
    } else if (trimmedName.length > 200) {
      errors.name = 'Name must be 200 characters or fewer';
    }

    if (!trimmedSlug) {
      errors.slug = 'Slug is required';
    } else if (!SLUG_REGEX.test(trimmedSlug)) {
      errors.slug = 'Slug must be 2-63 lower-case letters, digits or hyphens and start with alphanumeric';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await workspacesApi.create({ name: trimmedName, slug: trimmedSlug }, idempotencyKey);
      onSuccess(res.data);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setErrorMessage('A workspace with this slug already exists in this organization.');
          setFieldErrors((prev) => ({ ...prev, slug: 'Slug already taken in this organization' }));
        } else if (err.status === 403) {
          setErrorMessage('You do not have permission to create workspaces in this organization.');
        } else {
          setErrorMessage(err.message);
        }
      } else {
        setErrorMessage('Failed to create workspace. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-workspace-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl">
        <h2 id="create-workspace-title" className="text-lg font-semibold tracking-tight text-[var(--color-ink)]">
          Create Workspace
        </h2>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          Workspaces partition communications, teams, campaigns, and operational resources.
        </p>

        {errorMessage && (
          <div className="mt-4 rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label htmlFor="ws-name" className="block text-xs font-medium text-[var(--color-ink)]">
              Workspace Name <span className="text-[var(--color-bad)]">*</span>
            </label>
            <input
              id="ws-name"
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. Support & Operations"
              disabled={isSubmitting}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
            />
            {fieldErrors.name && (
              <p className="mt-1 text-[11px] text-[var(--color-bad)]">{fieldErrors.name}</p>
            )}
          </div>

          <div>
            <label htmlFor="ws-slug" className="block text-xs font-medium text-[var(--color-ink)]">
              Identifier Slug <span className="text-[var(--color-bad)]">*</span>
            </label>
            <input
              id="ws-slug"
              type="text"
              value={slug}
              onChange={(e) => handleSlugChange(e.target.value)}
              placeholder="e.g. support-operations"
              disabled={isSubmitting}
              className="mt-1 block w-full font-mono rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
            />
            <p className="mt-0.5 text-[10px] text-[var(--color-ink-muted)]">
              Immutable once created. 2–63 lowercase alphanumeric characters and hyphens.
            </p>
            {fieldErrors.slug && (
              <p className="mt-1 text-[11px] text-[var(--color-bad)]">{fieldErrors.slug}</p>
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
              disabled={isSubmitting}
              className="flex items-center gap-1.5 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <span className="size-3 animate-spin rounded-full border border-white border-t-transparent" />
                  Creating…
                </>
              ) : (
                'Create Workspace'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
