'use client';

import { useState, useEffect, type FormEvent } from 'react';
import {
  ApiError,
  resellersApi,
  type ResellerView,
  type UpdateResellerInput,
} from '@/lib/api-client';
import { useSession } from '@/lib/session-store';
import { useModalDialog } from '@/components/ui/dialog';
import { toast } from '@/lib/toast';

interface EditResellerDialogProps {
  readonly isOpen: boolean;
  readonly reseller: ResellerView;
  readonly onClose: () => void;
  readonly onSuccess: (updated: ResellerView) => void;
}

const HOSTNAME_REGEX = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const MARKUP_REGEX = /^(?:[0-9]{1,3}(?:\.[0-9]{1,3})?)$/;

export function EditResellerDialog({
  isOpen,
  reseller,
  onClose,
  onSuccess,
}: EditResellerDialogProps) {
  const isPlatformAdmin = useSession((state) => state.authorization?.isPlatformAdmin ?? false);

  const [name, setName] = useState(reseller.name);
  const [domain, setDomain] = useState(reseller.domain ?? '');
  const [defaultMarkupPct, setDefaultMarkupPct] = useState(reseller.defaultMarkupPct ?? '0');
  const [brandName, setBrandName] = useState(reseller.brandConfig?.brandName ?? '');
  const [supportPhone, setSupportPhone] = useState(reseller.brandConfig?.supportPhone ?? '');
  const [supportEmail, setSupportEmail] = useState(reseller.brandConfig?.supportEmail ?? '');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isOpen) {
      setName(reseller.name);
      setDomain(reseller.domain ?? '');
      setDefaultMarkupPct(reseller.defaultMarkupPct ?? '0');
      setBrandName(reseller.brandConfig?.brandName ?? '');
      setSupportPhone(reseller.brandConfig?.supportPhone ?? '');
      setSupportEmail(reseller.brandConfig?.supportEmail ?? '');
      setIsSubmitting(false);
      setErrorMessage(null);
      setFieldErrors({});
    }
  }, [isOpen, reseller]);

  const modal = useModalDialog(isOpen);

  if (!isOpen) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setFieldErrors({});

    const errors: Record<string, string> = {};
    const trimmedName = name.trim();
    const trimmedDomain = domain.trim();
    const trimmedMarkup = defaultMarkupPct.trim();

    if (!trimmedName) {
      errors.name = 'Reseller name is required';
    } else if (trimmedName.length > 200) {
      errors.name = 'Reseller name cannot exceed 200 characters';
    }

    if (isPlatformAdmin && trimmedDomain && !HOSTNAME_REGEX.test(trimmedDomain)) {
      errors.domain = 'Domain must be a valid fully-qualified hostname';
    }

    if (trimmedMarkup && !MARKUP_REGEX.test(trimmedMarkup)) {
      errors.defaultMarkupPct = 'Markup must be a non-negative number with up to 3 decimal places';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    const payload: UpdateResellerInput = {
      name: trimmedName,
      ...(isPlatformAdmin ? { domain: trimmedDomain ? trimmedDomain.toLowerCase() : null } : {}),
      defaultMarkupPct: trimmedMarkup || '0',
      brandConfig: {
        ...(brandName.trim() ? { brandName: brandName.trim() } : {}),
        ...(supportPhone.trim() ? { supportPhone: supportPhone.trim() } : {}),
        ...(supportEmail.trim() ? { supportEmail: supportEmail.trim() } : {}),
      },
    };

    setIsSubmitting(true);
    try {
      const res = await resellersApi.update(reseller.id, payload);
      toast.success('Reseller updated successfully');
      onSuccess(res.data);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message || 'Failed to update reseller');
      } else {
        setErrorMessage('An unexpected error occurred. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-reseller-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 focus:outline-none"
      {...modal.overlayProps(onClose, !isSubmitting)}
    >
      <div
        ref={modal.panelRef}
        tabIndex={-1}
        className="w-full max-w-lg rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
          <h2 id="edit-reseller-title" className="text-lg font-semibold text-[var(--color-ink)]">
            Edit Reseller: {reseller.name}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        {errorMessage && (
          <div
            role="alert"
            className="mt-4 rounded-md border border-[var(--color-bad)] bg-[var(--color-bad-subtle,#fee2e2)] p-3 text-sm text-[var(--color-bad)]"
          >
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label
              htmlFor="edit-reseller-name"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Reseller Name *
            </label>
            <input
              id="edit-reseller-name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isSubmitting}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-ink)] focus:border-[var(--color-primary)] focus:outline-none"
            />
            {fieldErrors.name && (
              <p className="mt-1 text-xs text-[var(--color-bad)]">{fieldErrors.name}</p>
            )}
          </div>

          <div>
            <label
              htmlFor="edit-reseller-markup"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Default Markup Percentage (%)
            </label>
            <input
              id="edit-reseller-markup"
              type="text"
              value={defaultMarkupPct}
              onChange={(e) => setDefaultMarkupPct(e.target.value)}
              placeholder="e.g. 15.000"
              disabled={isSubmitting}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-ink)] focus:border-[var(--color-primary)] focus:outline-none"
            />
            {fieldErrors.defaultMarkupPct && (
              <p className="mt-1 text-xs text-[var(--color-bad)]">{fieldErrors.defaultMarkupPct}</p>
            )}
          </div>

          {isPlatformAdmin ? (
            <div>
              <label
                htmlFor="edit-reseller-domain"
                className="block text-xs font-medium text-[var(--color-ink)]"
              >
                White-label Portal Domain
              </label>
              <input
                id="edit-reseller-domain"
                type="text"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                placeholder="e.g. console.apextelecom.com"
                disabled={isSubmitting}
                className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-ink)] font-mono focus:border-[var(--color-primary)] focus:outline-none"
              />
              <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                Domain administration requires platform administrator permissions.
              </p>
              {fieldErrors.domain && (
                <p className="mt-1 text-xs text-[var(--color-bad)]">{fieldErrors.domain}</p>
              )}
            </div>
          ) : (
            <div>
              <span className="block text-xs font-medium text-[var(--color-ink)]">
                Portal Domain
              </span>
              <p className="mt-1 font-mono text-sm text-[var(--color-ink-muted)]">
                {reseller.domain || '(Platform default)'}
              </p>
            </div>
          )}

          <div className="border-t border-[var(--color-border-subtle)] pt-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-muted)] mb-2">
              Branding Configuration
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="edit-brand-name"
                  className="block text-xs font-medium text-[var(--color-ink)]"
                >
                  Brand Display Name
                </label>
                <input
                  id="edit-brand-name"
                  type="text"
                  value={brandName}
                  onChange={(e) => setBrandName(e.target.value)}
                  placeholder="e.g. Apex Portal"
                  disabled={isSubmitting}
                  className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-ink)] focus:border-[var(--color-primary)] focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="edit-support-phone"
                  className="block text-xs font-medium text-[var(--color-ink)]"
                >
                  Support Phone
                </label>
                <input
                  id="edit-support-phone"
                  type="text"
                  value={supportPhone}
                  onChange={(e) => setSupportPhone(e.target.value)}
                  placeholder="e.g. +1-800-555-0199"
                  disabled={isSubmitting}
                  className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-ink)] focus:border-[var(--color-primary)] focus:outline-none"
                />
              </div>

              <div className="sm:col-span-2">
                <label
                  htmlFor="edit-support-email"
                  className="block text-xs font-medium text-[var(--color-ink)]"
                >
                  Support Email
                </label>
                <input
                  id="edit-support-email"
                  type="email"
                  value={supportEmail}
                  onChange={(e) => setSupportEmail(e.target.value)}
                  placeholder="e.g. support@apextelecom.com"
                  disabled={isSubmitting}
                  className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-ink)] focus:border-[var(--color-primary)] focus:outline-none"
                />
              </div>
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-3 border-t border-[var(--color-border-subtle)] pt-4">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-sm text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-md bg-[var(--color-primary,#2563eb)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
