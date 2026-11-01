'use client';

import { useState, useEffect, type FormEvent } from 'react';
import { ApiError, onboardingApi, type OnboardingResult } from '@/lib/api-client';
import { useModalDialog } from '@/components/ui/dialog';
import { toast } from '@/lib/toast';

interface CustomerOnboardingDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSuccess: (result: OnboardingResult) => void;
}

type OnboardingTab = 'direct' | 'reseller' | 'whitelabel';

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

export function CustomerOnboardingDialog({
  isOpen,
  onClose,
  onSuccess,
}: CustomerOnboardingDialogProps) {
  const [tab, setTab] = useState<OnboardingTab>('direct');

  // Common Form Fields
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [legalName, setLegalName] = useState('');
  const [gstin, setGstin] = useState('');

  // Admin User Fields
  const [adminEmail, setAdminEmail] = useState('');
  const [adminFirstName, setAdminFirstName] = useState('');
  const [adminLastName, setAdminLastName] = useState('');

  // Domain Fields
  const [subdomain, setSubdomain] = useState('');
  const [customDomain, setCustomDomain] = useState('');
  const [brandName, setBrandName] = useState('');
  const [primaryColor, setPrimaryColor] = useState('#0ea5e9');

  // Reseller-specific Fields
  const [resellerId, setResellerId] = useState('');

  // State
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<OnboardingResult | null>(null);

  useEffect(() => {
    if (isOpen) {
      setTab('direct');
      setName('');
      setSlug('');
      setSlugEdited(false);
      setLegalName('');
      setGstin('');
      setAdminEmail('');
      setAdminFirstName('');
      setAdminLastName('');
      setSubdomain('');
      setCustomDomain('');
      setBrandName('');
      setPrimaryColor('#0ea5e9');
      setResellerId('');
      setIsSubmitting(false);
      setErrorMessage(null);
      setFieldErrors({});
      setResult(null);
    }
  }, [isOpen]);

  const modal = useModalDialog(isOpen);

  if (!isOpen) return null;

  const handleNameChange = (val: string) => {
    setName(val);
    if (!slugEdited) {
      const generated = slugify(val);
      setSlug(generated);
      if (tab !== 'whitelabel') {
        setSubdomain(generated);
      }
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setFieldErrors({});

    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = 'Organization name is required';
    if (!slug.trim()) errors.slug = 'Slug identifier is required';
    if (!adminEmail.trim()) errors.adminEmail = 'Admin email is required';
    if (!adminFirstName.trim()) errors.adminFirstName = 'Admin first name is required';
    if (!adminLastName.trim()) errors.adminLastName = 'Admin last name is required';

    if (tab === 'reseller' && !resellerId.trim()) {
      errors.resellerId = 'Reseller UUID is required';
    }

    if (tab === 'whitelabel' && !customDomain.trim()) {
      errors.customDomain = 'Custom domain is required (e.g. console.customerbrand.com)';
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setIsSubmitting(true);
    try {
      let res: { data: OnboardingResult };

      const baseInput = {
        name: name.trim(),
        slug: slug.trim(),
        legalName: legalName.trim() || undefined,
        gstin: gstin.trim() || undefined,
        adminUser: {
          email: adminEmail.trim(),
          firstName: adminFirstName.trim(),
          lastName: adminLastName.trim(),
        },
      };

      if (tab === 'direct') {
        res = await onboardingApi.onboardDirect({
          ...baseInput,
          subdomain: subdomain.trim() ? `${subdomain.trim().toLowerCase()}.alendei.io` : undefined,
          brandConfig: brandName.trim() ? { brandName: brandName.trim() } : undefined,
        });
      } else if (tab === 'reseller') {
        res = await onboardingApi.onboardResellerCustomer({
          ...baseInput,
          resellerId: resellerId.trim(),
          subdomain: subdomain.trim() ? `${subdomain.trim().toLowerCase()}.alendei.io` : undefined,
        });
      } else {
        res = await onboardingApi.onboardWhiteLabel({
          ...baseInput,
          resellerId: resellerId.trim() || undefined,
          customDomain: customDomain.trim().toLowerCase(),
          brandConfig: {
            brandName: brandName.trim() || name.trim(),
            primaryColor,
          },
        });
      }

      setResult(res.data);
      toast.success(`Customer ${res.data.organizationName} onboarded successfully!`);
      onSuccess(res.data);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message || 'Customer onboarding failed');
      } else {
        setErrorMessage('An unexpected error occurred during onboarding. Please try again.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="customer-onboarding-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 focus:outline-none"
      {...modal.overlayProps(onClose, !isSubmitting)}
    >
      <div
        ref={modal.panelRef}
        tabIndex={-1}
        className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl"
      >
        <div className="flex items-start justify-between">
          <div>
            <h2
              id="customer-onboarding-title"
              className="text-lg font-semibold tracking-tight text-[var(--color-ink)]"
            >
              Onboard New Customer
            </h2>
            <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
              Turnkey multi-tenant customer provisioning across the alendei.io domain architecture.
            </p>
          </div>
        </div>

        {result ? (
          <div className="mt-6 space-y-4">
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-xs">
              <p className="font-semibold text-emerald-400">Customer Successfully Onboarded</p>
              <div className="mt-3 space-y-2 text-emerald-300">
                <div className="flex justify-between">
                  <span className="text-[var(--color-ink-muted)]">Organization:</span>
                  <span className="font-semibold text-[var(--color-ink)]">
                    {result.organizationName}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--color-ink-muted)]">Slug:</span>
                  <span className="font-mono text-[var(--color-ink)]">
                    {result.organizationSlug}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--color-ink-muted)]">Default Workspace:</span>
                  <span className="font-mono text-[var(--color-ink)]">
                    {result.defaultWorkspaceId}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--color-ink-muted)]">Assigned Domain:</span>
                  <span className="font-mono font-semibold text-[var(--color-accent)]">
                    {result.domain.domain}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--color-ink-muted)]">Portal URL:</span>
                  <span className="font-mono text-sky-400">{result.portalUrl}</span>
                </div>
              </div>
            </div>

            {result.domain.status === 'pending_verification' && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-400">
                <p className="font-semibold">DNS Verification Required</p>
                <p className="mt-1 text-[11px] text-amber-300">
                  Custom domain {result.domain.domain} requires a DNS TXT record at{' '}
                  <code className="font-mono">_alendei-challenge.{result.domain.domain}</code> with
                  value <code className="font-mono">{result.domain.verificationValue}</code>.
                </p>
              </div>
            )}

            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-xs font-medium text-white hover:opacity-90"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Tabs */}
            <div className="mt-4 flex border-b border-[var(--color-border-subtle)] text-xs font-medium">
              <button
                type="button"
                onClick={() => setTab('direct')}
                className={`border-b-2 px-4 py-2 transition-colors ${
                  tab === 'direct'
                    ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                    : 'border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
                }`}
              >
                Direct Customer
              </button>
              <button
                type="button"
                onClick={() => setTab('reseller')}
                className={`border-b-2 px-4 py-2 transition-colors ${
                  tab === 'reseller'
                    ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                    : 'border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
                }`}
              >
                Reseller-Managed
              </button>
              <button
                type="button"
                onClick={() => setTab('whitelabel')}
                className={`border-b-2 px-4 py-2 transition-colors ${
                  tab === 'whitelabel'
                    ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                    : 'border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
                }`}
              >
                White-Label
              </button>
            </div>

            {errorMessage && (
              <div
                role="alert"
                className="mt-4 rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]"
              >
                {errorMessage}
              </div>
            )}

            <form onSubmit={handleSubmit} className="mt-4 space-y-4">
              {tab === 'reseller' && (
                <div>
                  <label
                    htmlFor="onboarding-reseller-id"
                    className="block text-xs font-medium text-[var(--color-ink)]"
                  >
                    Parent Reseller UUID <span className="text-[var(--color-bad)]">*</span>
                  </label>
                  <input
                    id="onboarding-reseller-id"
                    type="text"
                    value={resellerId}
                    onChange={(e) => setResellerId(e.target.value.trim())}
                    placeholder="01955b0a-7b3b-7411-9a4f-res000000001"
                    disabled={isSubmitting}
                    className="mt-1 block w-full font-mono rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
                  />
                  {fieldErrors.resellerId && (
                    <p className="mt-1 text-[11px] text-[var(--color-bad)]">
                      {fieldErrors.resellerId}
                    </p>
                  )}
                </div>
              )}

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="onboarding-org-name"
                    className="block text-xs font-medium text-[var(--color-ink)]"
                  >
                    Organization Name <span className="text-[var(--color-bad)]">*</span>
                  </label>
                  <input
                    id="onboarding-org-name"
                    type="text"
                    value={name}
                    onChange={(e) => handleNameChange(e.target.value)}
                    placeholder="e.g. Nexus Logistics"
                    disabled={isSubmitting}
                    className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
                  />
                  {fieldErrors.name && (
                    <p className="mt-1 text-[11px] text-[var(--color-bad)]">{fieldErrors.name}</p>
                  )}
                </div>

                <div>
                  <label
                    htmlFor="onboarding-org-slug"
                    className="block text-xs font-medium text-[var(--color-ink)]"
                  >
                    Organization Slug <span className="text-[var(--color-bad)]">*</span>
                  </label>
                  <input
                    id="onboarding-org-slug"
                    type="text"
                    value={slug}
                    onChange={(e) => {
                      setSlug(e.target.value.toLowerCase());
                      setSlugEdited(true);
                    }}
                    placeholder="nexus-logistics"
                    disabled={isSubmitting}
                    className="mt-1 block w-full font-mono rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
                  />
                  {fieldErrors.slug && (
                    <p className="mt-1 text-[11px] text-[var(--color-bad)]">{fieldErrors.slug}</p>
                  )}
                </div>
              </div>

              {/* Domain Config */}
              {tab === 'whitelabel' ? (
                <div>
                  <label
                    htmlFor="onboarding-custom-domain"
                    className="block text-xs font-medium text-[var(--color-ink)]"
                  >
                    Custom Branded Domain (FQDN) <span className="text-[var(--color-bad)]">*</span>
                  </label>
                  <input
                    id="onboarding-custom-domain"
                    type="text"
                    value={customDomain}
                    onChange={(e) => setCustomDomain(e.target.value.toLowerCase())}
                    placeholder="console.nexuslogistics.com"
                    disabled={isSubmitting}
                    className="mt-1 block w-full font-mono rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
                  />
                  {fieldErrors.customDomain && (
                    <p className="mt-1 text-[11px] text-[var(--color-bad)]">
                      {fieldErrors.customDomain}
                    </p>
                  )}
                  <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
                    Generates a DNS challenge token. Verification must complete before activation.
                  </p>
                </div>
              ) : (
                <div>
                  <label
                    htmlFor="onboarding-subdomain"
                    className="block text-xs font-medium text-[var(--color-ink)]"
                  >
                    Platform Subdomain
                  </label>
                  <div className="mt-1 flex items-center rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 focus-within:ring-1 focus-within:ring-[var(--color-accent)]">
                    <input
                      id="onboarding-subdomain"
                      type="text"
                      value={subdomain}
                      onChange={(e) => setSubdomain(e.target.value.toLowerCase())}
                      placeholder={slug || 'customer-subdomain'}
                      disabled={isSubmitting}
                      className="w-full bg-transparent py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none disabled:opacity-50"
                    />
                    <span className="select-none font-mono text-xs text-[var(--color-ink-muted)]">
                      .alendei.io
                    </span>
                  </div>
                </div>
              )}

              {/* Initial Administrator User */}
              <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]/50 p-3">
                <p className="text-xs font-semibold text-[var(--color-ink)]">
                  Initial Tenant Administrator
                </p>
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <label
                      htmlFor="onboarding-admin-email"
                      className="block text-[11px] font-medium text-[var(--color-ink)]"
                    >
                      Admin Email <span className="text-[var(--color-bad)]">*</span>
                    </label>
                    <input
                      id="onboarding-admin-email"
                      type="email"
                      value={adminEmail}
                      onChange={(e) => setAdminEmail(e.target.value)}
                      placeholder="admin@nexuslogistics.com"
                      disabled={isSubmitting}
                      className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
                    />
                    {fieldErrors.adminEmail && (
                      <p className="mt-1 text-[11px] text-[var(--color-bad)]">
                        {fieldErrors.adminEmail}
                      </p>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor="onboarding-admin-first-name"
                      className="block text-[11px] font-medium text-[var(--color-ink)]"
                    >
                      First Name <span className="text-[var(--color-bad)]">*</span>
                    </label>
                    <input
                      id="onboarding-admin-first-name"
                      type="text"
                      value={adminFirstName}
                      onChange={(e) => setAdminFirstName(e.target.value)}
                      placeholder="Jane"
                      disabled={isSubmitting}
                      className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
                    />
                    {fieldErrors.adminFirstName && (
                      <p className="mt-1 text-[11px] text-[var(--color-bad)]">
                        {fieldErrors.adminFirstName}
                      </p>
                    )}
                  </div>

                  <div>
                    <label
                      htmlFor="onboarding-admin-last-name"
                      className="block text-[11px] font-medium text-[var(--color-ink)]"
                    >
                      Last Name <span className="text-[var(--color-bad)]">*</span>
                    </label>
                    <input
                      id="onboarding-admin-last-name"
                      type="text"
                      value={adminLastName}
                      onChange={(e) => setAdminLastName(e.target.value)}
                      placeholder="Doe"
                      disabled={isSubmitting}
                      className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
                    />
                    {fieldErrors.adminLastName && (
                      <p className="mt-1 text-[11px] text-[var(--color-bad)]">
                        {fieldErrors.adminLastName}
                      </p>
                    )}
                  </div>
                </div>
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
                  className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {isSubmitting ? 'Provisioning Tenant…' : 'Onboard Customer'}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
