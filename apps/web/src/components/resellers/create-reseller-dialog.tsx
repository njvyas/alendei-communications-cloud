'use client';

import { useState, useEffect, type FormEvent } from 'react';
import {
  ApiError,
  resellersApi,
  type CreateResellerInput,
  type ResellerView,
} from '@/lib/api-client';
import { useModalDialog } from '@/components/ui/dialog';
import { toast } from '@/lib/toast';

interface CreateResellerDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSuccess: (reseller: ResellerView) => void;
}

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,62}$/;
const HOSTNAME_REGEX = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const MARKUP_REGEX = /^(?:[0-9]{1,3}(?:\.[0-9]{1,3})?)$/;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

export function CreateResellerDialog({ isOpen, onClose, onSuccess }: CreateResellerDialogProps) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);
  const [domain, setDomain] = useState('');
  const [defaultMarkupPct, setDefaultMarkupPct] = useState('0');
  const [brandName, setBrandName] = useState('');
  const [supportEmail, setSupportEmail] = useState('');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isOpen) {
      setName('');
      setSlug('');
      setSlugManuallyEdited(false);
      setDomain('');
      setDefaultMarkupPct('0');
      setBrandName('');
      setSupportEmail('');
      setIsSubmitting(false);
      setErrorMessage(null);
      setFieldErrors({});
    }
  }, [isOpen]);

  const modal = useModalDialog(isOpen);

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
    const trimmedDomain = domain.trim();
    const trimmedMarkup = defaultMarkupPct.trim();

    if (!trimmedName) {
      errors.name = 'Reseller name is required';
    } else if (trimmedName.length > 200) {
      errors.name = 'Reseller name cannot exceed 200 characters';
    }

    if (!trimmedSlug) {
      errors.slug = 'Slug is required';
    } else if (!SLUG_REGEX.test(trimmedSlug)) {
      errors.slug = 'Slug must be 2-63 lowercase alphanumeric characters or hyphens';
    }

    if (trimmedDomain && !HOSTNAME_REGEX.test(trimmedDomain)) {
      errors.domain = 'Domain must be a valid fully-qualified hostname (e.g. portal.reseller.com)';
    }

    if (trimmedMarkup && !MARKUP_REGEX.test(trimmedMarkup)) {
      errors.defaultMarkupPct =
        'Markup must be a non-negative number with up to 3 decimal places (e.g. 15.000)';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    const payload: CreateResellerInput = {
      name: trimmedName,
      slug: trimmedSlug,
      ...(trimmedDomain ? { domain: trimmedDomain.toLowerCase() } : {}),
      ...(trimmedMarkup ? { defaultMarkupPct: trimmedMarkup } : {}),
      ...(brandName.trim() || supportEmail.trim()
        ? {
            brandConfig: {
              ...(brandName.trim() ? { brandName: brandName.trim() } : {}),
              ...(supportEmail.trim() ? { supportEmail: supportEmail.trim() } : {}),
            },
          }
        : {}),
    };

    setIsSubmitting(true);
    try {
      const res = await resellersApi.create(payload);
      toast.success('Reseller created successfully');
      onSuccess(res.data);
      onClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          setErrorMessage(err.message || 'A reseller with this slug or domain already exists');
        } else {
          setErrorMessage(err.message || 'Failed to create reseller');
        }
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
      aria-labelledby="create-reseller-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 focus:outline-none"
      {...modal.overlayProps(onClose, !isSubmitting)}
    >
      <div
        ref={modal.panelRef}
        tabIndex={-1}
        className="w-full max-w-lg rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
          <h2 id="create-reseller-title" className="text-lg font-semibold text-[var(--color-ink)]">
            Create Reseller
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
              htmlFor="reseller-name"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Reseller Name *
            </label>
            <input
              id="reseller-name"
              type="text"
              required
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="e.g. Apex Global Communications"
              disabled={isSubmitting}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-ink)] focus:border-[var(--color-primary)] focus:outline-none"
            />
            {fieldErrors.name && (
              <p className="mt-1 text-xs text-[var(--color-bad)]">{fieldErrors.name}</p>
            )}
          </div>

          <div>
            <label
              htmlFor="reseller-slug"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Slug *
            </label>
            <input
              id="reseller-slug"
              type="text"
              required
              value={slug}
              onChange={(e) => handleSlugChange(e.target.value)}
              placeholder="e.g. apex-global"
              disabled={isSubmitting}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-ink)] font-mono focus:border-[var(--color-primary)] focus:outline-none"
            />
            {fieldErrors.slug && (
              <p className="mt-1 text-xs text-[var(--color-bad)]">{fieldErrors.slug}</p>
            )}
          </div>

          <div>
            <label
              htmlFor="reseller-domain"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              White-label Portal Domain (Optional)
            </label>
            <input
              id="reseller-domain"
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="e.g. console.apextelecom.com"
              disabled={isSubmitting}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-ink)] font-mono focus:border-[var(--color-primary)] focus:outline-none"
            />
            {fieldErrors.domain && (
              <p className="mt-1 text-xs text-[var(--color-bad)]">{fieldErrors.domain}</p>
            )}
          </div>

          <div>
            <label
              htmlFor="reseller-markup"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Default Markup Percentage (%)
            </label>
            <input
              id="reseller-markup"
              type="text"
              value={defaultMarkupPct}
              onChange={(e) => setDefaultMarkupPct(e.target.value)}
              placeholder="e.g. 15.000"
              disabled={isSubmitting}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-sm text-[var(--color-ink)] focus:border-[var(--color-primary)] focus:outline-none"
            />
            <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
              Applied automatically across customer organizations under this reseller.
            </p>
            {fieldErrors.defaultMarkupPct && (
              <p className="mt-1 text-xs text-[var(--color-bad)]">{fieldErrors.defaultMarkupPct}</p>
            )}
          </div>

          <div className="border-t border-[var(--color-border-subtle)] pt-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-muted)] mb-2">
              Branding Configuration (Optional)
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="brand-name"
                  className="block text-xs font-medium text-[var(--color-ink)]"
                >
                  Brand Display Name
                </label>
                <input
                  id="brand-name"
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
                  htmlFor="support-email"
                  className="block text-xs font-medium text-[var(--color-ink)]"
                >
                  Support Email
                </label>
                <input
                  id="support-email"
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
              {isSubmitting ? 'Creating…' : 'Create Reseller'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
