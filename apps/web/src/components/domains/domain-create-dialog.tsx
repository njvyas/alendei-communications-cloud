'use client';

import { useState, useEffect, type FormEvent } from 'react';
import { ApiError, domainsApi, type DomainView } from '@/lib/api-client';
import { useModalDialog } from '@/components/ui/dialog';
import { toast } from '@/lib/toast';

interface DomainCreateDialogProps {
  readonly isOpen: boolean;
  readonly orgId: string;
  readonly onClose: () => void;
  readonly onSuccess: (domain: DomainView) => void;
}

const SUBDOMAIN_PREFIX_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const FQDN_REGEX =
  /^(?=.{1,253}$)(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-zA-Z0-9-]{1,63}(?<!-))+$/;

export function DomainCreateDialog({ isOpen, orgId, onClose, onSuccess }: DomainCreateDialogProps) {
  const [domainMode, setDomainMode] = useState<'subdomain' | 'custom'>('subdomain');
  const [subdomainPrefix, setSubdomainPrefix] = useState('');
  const [customFqdn, setCustomFqdn] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isOpen) {
      setDomainMode('subdomain');
      setSubdomainPrefix('');
      setCustomFqdn('');
      setIsPrimary(false);
      setIsSubmitting(false);
      setErrorMessage(null);
      setFieldErrors({});
    }
  }, [isOpen]);

  const modal = useModalDialog(isOpen);

  if (!isOpen) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setFieldErrors({});

    let domainToRegister = '';

    if (domainMode === 'subdomain') {
      const trimmed = subdomainPrefix.trim().toLowerCase();
      if (!trimmed) {
        setFieldErrors({ subdomain: 'Subdomain prefix is required' });
        return;
      }
      if (!SUBDOMAIN_PREFIX_REGEX.test(trimmed)) {
        setFieldErrors({
          subdomain:
            'Must contain only lowercase alphanumeric characters and hyphens (cannot start or end with hyphen)',
        });
        return;
      }
      domainToRegister = `${trimmed}.alendei.io`;
    } else {
      const trimmed = customFqdn.trim().toLowerCase();
      if (!trimmed) {
        setFieldErrors({ customFqdn: 'Custom domain hostname is required' });
        return;
      }
      if (!FQDN_REGEX.test(trimmed)) {
        setFieldErrors({
          customFqdn:
            'Please enter a valid fully qualified domain name (e.g. console.yourbrand.com)',
        });
        return;
      }
      if (trimmed.endsWith('.alendei.io') || trimmed.endsWith('.alendei.com')) {
        setFieldErrors({
          customFqdn: 'Platform subdomains must be created using the Platform Subdomain option',
        });
        return;
      }
      domainToRegister = trimmed;
    }

    setIsSubmitting(true);
    try {
      const res = await domainsApi.register(orgId, {
        domain: domainToRegister,
        isPrimary,
      });
      toast.success(
        domainMode === 'subdomain'
          ? `Subdomain ${res.data.domain} registered and active`
          : `Custom domain ${res.data.domain} registered. Complete DNS verification to activate.`,
      );
      onSuccess(res.data);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'DOMAIN_ALREADY_EXISTS') {
          setErrorMessage(
            'This domain is already registered to another organization or platform service.',
          );
        } else if (err.code === 'DOMAIN_RESERVED') {
          setErrorMessage('This hostname is reserved by the platform and cannot be registered.');
        } else {
          setErrorMessage(err.message || 'Failed to register domain');
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
      aria-labelledby="register-domain-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 focus:outline-none"
      {...modal.overlayProps(onClose, !isSubmitting)}
    >
      <div
        ref={modal.panelRef}
        tabIndex={-1}
        className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl"
      >
        <h2
          id="register-domain-title"
          className="text-lg font-semibold tracking-tight text-[var(--color-ink)]"
        >
          Register Domain
        </h2>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          Map a platform subdomain or custom branded domain to this organization.
        </p>

        {errorMessage && (
          <div
            role="alert"
            className="mt-4 rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]"
          >
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <span className="block text-xs font-medium text-[var(--color-ink)]">Domain Mode</span>
            <div className="mt-1.5 flex gap-2">
              <button
                type="button"
                onClick={() => setDomainMode('subdomain')}
                className={`flex-1 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                  domainMode === 'subdomain'
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                    : 'border-[var(--color-border-subtle)] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]'
                }`}
              >
                Platform Subdomain
                <span className="mt-0.5 block text-[10px] font-normal opacity-80">
                  *.alendei.io (Instant)
                </span>
              </button>
              <button
                type="button"
                onClick={() => setDomainMode('custom')}
                className={`flex-1 rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                  domainMode === 'custom'
                    ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
                    : 'border-[var(--color-border-subtle)] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]'
                }`}
              >
                Custom Domain
                <span className="mt-0.5 block text-[10px] font-normal opacity-80">
                  White-label (DNS verified)
                </span>
              </button>
            </div>
          </div>

          {domainMode === 'subdomain' ? (
            <div>
              <label
                htmlFor="subdomain-prefix-input"
                className="block text-xs font-medium text-[var(--color-ink)]"
              >
                Subdomain Prefix <span className="text-[var(--color-bad)]">*</span>
              </label>
              <div className="mt-1 flex items-center rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 focus-within:ring-1 focus-within:ring-[var(--color-accent)]">
                <input
                  id="subdomain-prefix-input"
                  type="text"
                  value={subdomainPrefix}
                  onChange={(e) => setSubdomainPrefix(e.target.value.toLowerCase())}
                  placeholder="e.g. acme"
                  disabled={isSubmitting}
                  className="w-full bg-transparent py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none disabled:opacity-50"
                />
                <span className="select-none font-mono text-xs text-[var(--color-ink-muted)]">
                  .alendei.io
                </span>
              </div>
              {fieldErrors.subdomain && (
                <p className="mt-1 text-[11px] text-[var(--color-bad)]">{fieldErrors.subdomain}</p>
              )}
            </div>
          ) : (
            <div>
              <label
                htmlFor="custom-fqdn-input"
                className="block text-xs font-medium text-[var(--color-ink)]"
              >
                Fully Qualified Domain Name <span className="text-[var(--color-bad)]">*</span>
              </label>
              <input
                id="custom-fqdn-input"
                type="text"
                value={customFqdn}
                onChange={(e) => setCustomFqdn(e.target.value.toLowerCase())}
                placeholder="e.g. console.customerbrand.com"
                disabled={isSubmitting}
                className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
              />
              {fieldErrors.customFqdn && (
                <p className="mt-1 text-[11px] text-[var(--color-bad)]">{fieldErrors.customFqdn}</p>
              )}
              <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
                A DNS TXT challenge will be generated for domain ownership verification.
              </p>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <input
              id="set-primary-checkbox"
              type="checkbox"
              checked={isPrimary}
              onChange={(e) => setIsPrimary(e.target.checked)}
              disabled={isSubmitting}
              className="size-4 rounded border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-accent)] focus:ring-[var(--color-accent)]"
            />
            <label
              htmlFor="set-primary-checkbox"
              className="text-xs text-[var(--color-ink)] select-none"
            >
              Set as primary organization domain
            </label>
          </div>

          <div className="mt-6 flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? 'Registering…' : 'Register Domain'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
