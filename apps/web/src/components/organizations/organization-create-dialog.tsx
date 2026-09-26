'use client';

import { useState, useEffect, type FormEvent } from 'react';
import { ApiError, organizationsApi, type BillingMode, type BillingPolicy, type CreateOrganizationParams, type OrganizationView } from '@/lib/api-client';
import { useCanManagePlatformTenants, useSession } from '@/lib/session-store';

interface OrganizationCreateDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSuccess: (org: OrganizationView) => void;
}

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,62}$/;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

export function OrganizationCreateDialog({ isOpen, onClose, onSuccess }: OrganizationCreateDialogProps) {
  const isPlatformAdmin = useSession((state) => state.authorization?.isPlatformAdmin ?? false);
  const canManagePlatformTenants = useCanManagePlatformTenants();
  const showBillingOptions = isPlatformAdmin || canManagePlatformTenants;

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [legalName, setLegalName] = useState('');
  const [gstin, setGstin] = useState('');
  const [resellerId, setResellerId] = useState('');
  const [billingMode, setBillingMode] = useState<BillingMode>('prepaid');
  const [billingPolicy, setBillingPolicy] = useState<BillingPolicy>('charge_per_logical_message');

  // Stable Idempotency-Key per logical submission attempt; preserved across retry attempts
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => crypto.randomUUID());

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isOpen) {
      setName('');
      setSlug('');
      setSlugManuallyEdited(false);
      setLegalName('');
      setGstin('');
      setResellerId('');
      setBillingMode('prepaid');
      setBillingPolicy('charge_per_logical_message');
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
    setErrorMessage(null);
    setFieldErrors({});

    const errors: Record<string, string> = {};
    const trimmedName = name.trim();
    const trimmedSlug = slug.trim();
    const trimmedLegalName = legalName.trim();
    const trimmedGstin = gstin.trim().toUpperCase();
    const trimmedResellerId = resellerId.trim();

    if (!trimmedName) {
      errors.name = 'Organization name is required';
    } else if (trimmedName.length > 200) {
      errors.name = 'Name must be 200 characters or fewer';
    }

    if (!trimmedSlug) {
      errors.slug = 'Slug is required';
    } else if (!SLUG_REGEX.test(trimmedSlug)) {
      errors.slug = 'Slug must be 2-63 lower-case letters, digits or hyphens and start with alphanumeric';
    }

    if (trimmedLegalName && trimmedLegalName.length > 200) {
      errors.legalName = 'Legal name must be 200 characters or fewer';
    }

    if (trimmedGstin && !GSTIN_REGEX.test(trimmedGstin)) {
      errors.gstin = 'Must be a valid 15-character GSTIN format (e.g. 24ABCDE1234F1Z5)';
    }

    if (trimmedResellerId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmedResellerId)) {
      errors.resellerId = 'Reseller ID must be a valid UUID';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setIsSubmitting(true);

    const payload: CreateOrganizationParams = {
      name: trimmedName,
      slug: trimmedSlug,
      legalName: trimmedLegalName || undefined,
      gstin: trimmedGstin || undefined,
      resellerId: (isPlatformAdmin && trimmedResellerId) ? trimmedResellerId : undefined,
      ...(showBillingOptions ? { billingMode, billingPolicy } : {}),
    };

    try {
      const res = await organizationsApi.create(payload, idempotencyKey);
      onSuccess(res.data);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setErrorMessage('An organization with this slug already exists.');
          setFieldErrors((prev) => ({ ...prev, slug: 'Slug already taken' }));
        } else if (err.status === 403) {
          setErrorMessage('You do not have permission to create organizations beneath the target scope.');
        } else if (err.status === 400 && err.details && typeof err.details === 'object') {
          setErrorMessage(err.message);
          const issues = (err.details as { issues?: string[] }).issues;
          if (Array.isArray(issues)) {
            const newFieldErrors: Record<string, string> = {};
            for (const issue of issues) {
              if (issue.toLowerCase().includes('slug')) newFieldErrors.slug = issue;
              else if (issue.toLowerCase().includes('name')) newFieldErrors.name = issue;
              else if (issue.toLowerCase().includes('gstin')) newFieldErrors.gstin = issue;
            }
            if (Object.keys(newFieldErrors).length > 0) {
              setFieldErrors(newFieldErrors);
            }
          }
        } else {
          setErrorMessage(err.message);
        }
      } else {
        setErrorMessage('Failed to create organization. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-org-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-lg rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl max-h-[90vh] overflow-y-auto">
        <h2 id="create-org-title" className="text-lg font-semibold tracking-tight text-[var(--color-ink)]">
          Create New Organization
        </h2>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          Provision a new tenant organization with default workspace and system roles.
        </p>

        {errorMessage && (
          <div className="mt-4 rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label htmlFor="org-name" className="block text-xs font-medium text-[var(--color-ink)]">
              Organization Name <span className="text-[var(--color-bad)]">*</span>
            </label>
            <input
              id="org-name"
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. Acme Corporation"
              disabled={isSubmitting}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
            />
            {fieldErrors.name && (
              <p className="mt-1 text-[11px] text-[var(--color-bad)]">{fieldErrors.name}</p>
            )}
          </div>

          <div>
            <label htmlFor="org-slug" className="block text-xs font-medium text-[var(--color-ink)]">
              Identifier Slug <span className="text-[var(--color-bad)]">*</span>
            </label>
            <input
              id="org-slug"
              type="text"
              value={slug}
              onChange={(e) => handleSlugChange(e.target.value)}
              placeholder="e.g. acme-corporation"
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

          <div>
            <label htmlFor="org-legal-name" className="block text-xs font-medium text-[var(--color-ink)]">
              Legal Name (Optional)
            </label>
            <input
              id="org-legal-name"
              type="text"
              value={legalName}
              onChange={(e) => setLegalName(e.target.value)}
              placeholder="e.g. Acme Corporation Private Limited"
              disabled={isSubmitting}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
            />
            {fieldErrors.legalName && (
              <p className="mt-1 text-[11px] text-[var(--color-bad)]">{fieldErrors.legalName}</p>
            )}
          </div>

          <div>
            <label htmlFor="org-gstin" className="block text-xs font-medium text-[var(--color-ink)]">
              GSTIN (Optional)
            </label>
            <input
              id="org-gstin"
              type="text"
              value={gstin}
              onChange={(e) => setGstin(e.target.value.toUpperCase())}
              placeholder="e.g. 24ABCDE1234F1Z5"
              disabled={isSubmitting}
              className="mt-1 block w-full font-mono uppercase rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
            />
            {fieldErrors.gstin && (
              <p className="mt-1 text-[11px] text-[var(--color-bad)]">{fieldErrors.gstin}</p>
            )}
          </div>

          {isPlatformAdmin && (
            <div>
              <label htmlFor="org-reseller" className="block text-xs font-medium text-[var(--color-ink)]">
                Target Reseller ID (Optional)
              </label>
              <input
                id="org-reseller"
                type="text"
                value={resellerId}
                onChange={(e) => setResellerId(e.target.value)}
                placeholder="Defaults to platform default reseller"
                disabled={isSubmitting}
                className="mt-1 block w-full font-mono rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
              />
              {fieldErrors.resellerId && (
                <p className="mt-1 text-[11px] text-[var(--color-bad)]">{fieldErrors.resellerId}</p>
              )}
            </div>
          )}

          {showBillingOptions && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-[var(--color-border-subtle)]">
              <div>
                <label htmlFor="org-billing-mode" className="block text-xs font-medium text-[var(--color-ink)]">
                  Billing Mode
                </label>
                <select
                  id="org-billing-mode"
                  value={billingMode}
                  onChange={(e) => setBillingMode(e.target.value as BillingMode)}
                  disabled={isSubmitting}
                  className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
                >
                  <option value="prepaid">Prepaid</option>
                  <option value="postpaid">Postpaid</option>
                </select>
              </div>

              <div>
                <label htmlFor="org-billing-policy" className="block text-xs font-medium text-[var(--color-ink)]">
                  Billing Policy
                </label>
                <select
                  id="org-billing-policy"
                  value={billingPolicy}
                  onChange={(e) => setBillingPolicy(e.target.value as BillingPolicy)}
                  disabled={isSubmitting}
                  className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
                >
                  <option value="charge_per_logical_message">Charge per logical message</option>
                  <option value="charge_per_attempt">Charge per attempt</option>
                </select>
              </div>
            </div>
          )}

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
                'Create Organization'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
