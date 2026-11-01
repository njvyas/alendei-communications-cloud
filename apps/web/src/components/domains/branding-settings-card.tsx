'use client';

import { useState, useEffect, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { domainsApi } from '@/lib/api-client';
import { toast } from '@/lib/toast';

interface BrandingSettingsCardProps {
  readonly orgId: string;
  readonly canManage?: boolean;
}

export function BrandingSettingsCard({ orgId, canManage = true }: BrandingSettingsCardProps) {
  const [brandName, setBrandName] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [faviconUrl, setFaviconUrl] = useState('');
  const [primaryColor, setPrimaryColor] = useState('#0ea5e9');
  const [accentColor, setAccentColor] = useState('#38bdf8');
  const [supportEmail, setSupportEmail] = useState('');
  const [supportPhone, setSupportPhone] = useState('');
  const [customCss, setCustomCss] = useState('');

  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['organizations', orgId, 'branding'],
    queryFn: ({ signal }) => domainsApi.getBranding(orgId, signal),
    enabled: !!orgId,
  });

  useEffect(() => {
    if (data?.data) {
      const cfg = data.data;
      setBrandName(cfg.brandName ?? '');
      setLogoUrl(cfg.logoUrl ?? '');
      setFaviconUrl(cfg.faviconUrl ?? '');
      setPrimaryColor(cfg.primaryColor ?? '#0ea5e9');
      setAccentColor(cfg.accentColor ?? '#38bdf8');
      setSupportEmail(cfg.supportEmail ?? '');
      setSupportPhone(cfg.supportPhone ?? '');
      setCustomCss(cfg.customCss ?? '');
    }
  }, [data]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setIsSaving(true);

    try {
      await domainsApi.updateBranding(orgId, {
        brandName: brandName.trim() || undefined,
        logoUrl: logoUrl.trim() || undefined,
        faviconUrl: faviconUrl.trim() || undefined,
        primaryColor: primaryColor.trim() || undefined,
        accentColor: accentColor.trim() || undefined,
        supportEmail: supportEmail.trim() || undefined,
        supportPhone: supportPhone.trim() || undefined,
        customCss: customCss.trim() || undefined,
      });
      toast.success('Branding configuration saved successfully');
      void refetch();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to save branding');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-[var(--color-ink)]">
            Organization Branding & Customization
          </h2>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Configure white-label logos, colors, and support contacts for portals hosted on your
            domains.
          </p>
        </div>
      </div>

      {errorMessage && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]"
        >
          {errorMessage}
        </div>
      )}

      {isLoading ? (
        <div role="status" className="flex items-center justify-center py-8">
          <div className="size-4 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
          <span className="ml-2 text-xs text-[var(--color-ink-muted)]">
            Loading branding configuration…
          </span>
        </div>
      ) : error ? (
        <div
          role="alert"
          className="mt-4 rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]"
        >
          Failed to load branding: {error instanceof Error ? error.message : 'Unknown error'}
        </div>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4 lg:col-span-2">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="brand-name-input"
                  className="block text-xs font-medium text-[var(--color-ink)]"
                >
                  Brand Display Name
                </label>
                <input
                  id="brand-name-input"
                  type="text"
                  value={brandName}
                  onChange={(e) => setBrandName(e.target.value)}
                  placeholder="e.g. Acme Communications"
                  disabled={!canManage || isSaving}
                  className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
                />
              </div>

              <div>
                <label
                  htmlFor="support-email-input"
                  className="block text-xs font-medium text-[var(--color-ink)]"
                >
                  Support Email
                </label>
                <input
                  id="support-email-input"
                  type="email"
                  value={supportEmail}
                  onChange={(e) => setSupportEmail(e.target.value)}
                  placeholder="support@acme.com"
                  disabled={!canManage || isSaving}
                  className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="logo-url-input"
                  className="block text-xs font-medium text-[var(--color-ink)]"
                >
                  Logo URL (HTTPS)
                </label>
                <input
                  id="logo-url-input"
                  type="url"
                  value={logoUrl}
                  onChange={(e) => setLogoUrl(e.target.value)}
                  placeholder="https://cdn.example.com/logo.svg"
                  disabled={!canManage || isSaving}
                  className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
                />
              </div>

              <div>
                <label
                  htmlFor="favicon-url-input"
                  className="block text-xs font-medium text-[var(--color-ink)]"
                >
                  Favicon URL (HTTPS)
                </label>
                <input
                  id="favicon-url-input"
                  type="url"
                  value={faviconUrl}
                  onChange={(e) => setFaviconUrl(e.target.value)}
                  placeholder="https://cdn.example.com/favicon.ico"
                  disabled={!canManage || isSaving}
                  className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="primary-color-input"
                  className="block text-xs font-medium text-[var(--color-ink)]"
                >
                  Primary Brand Color
                </label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    id="primary-color-picker"
                    aria-label="Pick primary brand color"
                    type="color"
                    value={primaryColor}
                    onChange={(e) => setPrimaryColor(e.target.value)}
                    disabled={!canManage || isSaving}
                    className="size-7 cursor-pointer rounded border border-[var(--color-border-subtle)] bg-transparent p-0.5"
                  />
                  <input
                    id="primary-color-input"
                    type="text"
                    value={primaryColor}
                    onChange={(e) => setPrimaryColor(e.target.value)}
                    placeholder="#0ea5e9"
                    disabled={!canManage || isSaving}
                    className="block w-full font-mono rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="accent-color-input"
                  className="block text-xs font-medium text-[var(--color-ink)]"
                >
                  Accent Color
                </label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    id="accent-color-picker"
                    aria-label="Pick accent color"
                    type="color"
                    value={accentColor}
                    onChange={(e) => setAccentColor(e.target.value)}
                    disabled={!canManage || isSaving}
                    className="size-7 cursor-pointer rounded border border-[var(--color-border-subtle)] bg-transparent p-0.5"
                  />
                  <input
                    id="accent-color-input"
                    type="text"
                    value={accentColor}
                    onChange={(e) => setAccentColor(e.target.value)}
                    placeholder="#38bdf8"
                    disabled={!canManage || isSaving}
                    className="block w-full font-mono rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
                  />
                </div>
              </div>
            </div>

            <div>
              <label
                htmlFor="custom-css-input"
                className="block text-xs font-medium text-[var(--color-ink)]"
              >
                Custom CSS Overrides (Optional)
              </label>
              <textarea
                id="custom-css-input"
                rows={3}
                value={customCss}
                onChange={(e) => setCustomCss(e.target.value)}
                placeholder=":root { --border-radius: 8px; }"
                disabled={!canManage || isSaving}
                className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-2.5 font-mono text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
              />
            </div>

            {canManage && (
              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isSaving}
                  className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {isSaving ? 'Saving Changes…' : 'Save Branding'}
                </button>
              </div>
            )}
          </form>

          {/* Live Preview Card */}
          <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">
              Live Portal Preview
            </h3>
            <div className="mt-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 shadow-sm">
              <div className="flex items-center gap-2">
                {logoUrl ? (
                  <img
                    src={logoUrl}
                    alt={brandName || 'Brand logo'}
                    className="h-6 max-w-[100px] object-contain"
                  />
                ) : (
                  <div
                    className="flex size-6 items-center justify-center rounded text-[10px] font-bold text-white"
                    style={{ backgroundColor: primaryColor }}
                  >
                    {(brandName || 'A').charAt(0).toUpperCase()}
                  </div>
                )}
                <span className="text-xs font-bold text-[var(--color-ink)]">
                  {brandName || 'Alendei Cloud'}
                </span>
              </div>

              <div className="mt-4 rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
                <p className="text-[11px] font-medium text-[var(--color-ink)]">
                  Customer Console Header
                </p>
                <div className="mt-2 flex items-center justify-between text-[10px] text-[var(--color-ink-muted)]">
                  <span>Contact: {supportEmail || 'support@alendei.io'}</span>
                  <button
                    type="button"
                    tabIndex={-1}
                    className="rounded px-2 py-0.5 text-white"
                    style={{ backgroundColor: primaryColor }}
                  >
                    Action
                  </button>
                </div>
              </div>
            </div>
            <p className="mt-3 text-[11px] text-[var(--color-ink-muted)]">
              Preview updates live as you edit brand name, colors, and logo.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
