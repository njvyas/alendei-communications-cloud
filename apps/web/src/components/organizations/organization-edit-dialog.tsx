'use client';

import { useState, useEffect, type FormEvent } from 'react';
import { ApiError, organizationsApi, type BillingMode, type BillingPolicy, type OrganizationView, type UpdateOrganizationParams } from '@/lib/api-client';
import { useCanManagePlatformTenants, useSession } from '@/lib/session-store';

interface OrganizationEditDialogProps {
  readonly isOpen: boolean;
  readonly organization: OrganizationView | null;
  readonly onClose: () => void;
  readonly onSuccess: (org: OrganizationView) => void;
}

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

export function OrganizationEditDialog({
  isOpen,
  organization,
  onClose,
  onSuccess,
}: OrganizationEditDialogProps) {
  const isPlatformAdmin = useSession((state) => state.authorization?.isPlatformAdmin ?? false);
  const canManagePlatformTenants = useCanManagePlatformTenants();
  const showBillingOptions = isPlatformAdmin || canManagePlatformTenants;

  const [name, setName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [gstin, setGstin] = useState('');
  const [billingMode, setBillingMode] = useState<BillingMode>('prepaid');
  const [billingPolicy, setBillingPolicy] = useState<BillingPolicy>('charge_per_logical_message');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isOpen && organization) {
      setName(organization.name);
      setLegalName(organization.legalName ?? '');
      setGstin(organization.gstin ?? '');
      setBillingMode(organization.billingMode);
      setBillingPolicy(organization.billingPolicy);
      setIsSubmitting(false);
      setErrorMessage(null);
      setFieldErrors({});
    }
  }, [isOpen, organization]);

  if (!isOpen || !organization) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setFieldErrors({});

    const errors: Record<string, string> = {};
    const trimmedName = name.trim();
    const trimmedLegalName = legalName.trim();
    const trimmedGstin = gstin.trim().toUpperCase();

    if (!trimmedName) {
      errors.name = 'Organization name is required';
    } else if (trimmedName.length > 200) {
      errors.name = 'Name must be 200 characters or fewer';
    }

    if (trimmedLegalName && trimmedLegalName.length > 200) {
      errors.legalName = 'Legal name must be 200 characters or fewer';
    }

    if (trimmedGstin && !GSTIN_REGEX.test(trimmedGstin)) {
      errors.gstin = 'Must be a valid 15-character GSTIN format (e.g. 24ABCDE1234F1Z5)';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setIsSubmitting(true);

    // Invariant: Do NOT include slug, resellerId, or status in update payload
    const payload: UpdateOrganizationParams = {
      name: trimmedName,
      legalName: trimmedLegalName ? trimmedLegalName : null,
      gstin: trimmedGstin ? trimmedGstin : null,
      ...(showBillingOptions ? { billingMode, billingPolicy } : {}),
    };

    try {
      const res = await organizationsApi.update(organization.id, payload);
      onSuccess(res.data);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setErrorMessage('Cannot update organization: organization is not in active state.');
        } else if (err.status === 403) {
          setErrorMessage('You do not have permission to update this organization.');
        } else {
          setErrorMessage(err.message);
        }
      } else {
        setErrorMessage('Failed to update organization. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-org-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="w-full max-w-lg rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl max-h-[90vh] overflow-y-auto">
        <h2 id="edit-org-title" className="text-lg font-semibold tracking-tight text-[var(--color-ink)]">
          Edit Organization
        </h2>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          Update display name, legal entity information, and billing configuration.
        </p>

        {errorMessage && (
          <div className="mt-4 rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-[var(--color-ink-muted)]">Identifier Slug</label>
            <div className="mt-1 font-mono text-xs text-[var(--color-ink)] px-3 py-1.5 rounded-md bg-[var(--color-surface-raised)] border border-[var(--color-border-subtle)]">
              {organization.slug}
            </div>
            <p className="mt-0.5 text-[10px] text-[var(--color-ink-muted)]">Identifier slug is immutable.</p>
          </div>

          <div>
            <label htmlFor="edit-org-name" className="block text-xs font-medium text-[var(--color-ink)]">
              Organization Name <span className="text-[var(--color-bad)]">*</span>
            </label>
            <input
              id="edit-org-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isSubmitting}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
            />
            {fieldErrors.name && (
              <p className="mt-1 text-[11px] text-[var(--color-bad)]">{fieldErrors.name}</p>
            )}
          </div>

          <div>
            <label htmlFor="edit-org-legal-name" className="block text-xs font-medium text-[var(--color-ink)]">
              Legal Name (Optional)
            </label>
            <input
              id="edit-org-legal-name"
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
            <label htmlFor="edit-org-gstin" className="block text-xs font-medium text-[var(--color-ink)]">
              GSTIN (Optional)
            </label>
            <input
              id="edit-org-gstin"
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

          {showBillingOptions && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-[var(--color-border-subtle)]">
              <div>
                <label htmlFor="edit-org-billing-mode" className="block text-xs font-medium text-[var(--color-ink)]">
                  Billing Mode
                </label>
                <select
                  id="edit-org-billing-mode"
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
                <label htmlFor="edit-org-billing-policy" className="block text-xs font-medium text-[var(--color-ink)]">
                  Billing Policy
                </label>
                <select
                  id="edit-org-billing-policy"
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
                  Saving…
                </>
              ) : (
                'Save Changes'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
