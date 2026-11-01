'use client';

import { DomainRegistry } from '@/components/platform-domains/domain-registry';
import { useCanReadPlatformDomains } from '@/lib/platform-domains';

/**
 * Platform domain oversight (U13.3): every organization's domains, challenge
 * monitoring, DNS diagnostics and lifecycle history. Platform operators only.
 */
export default function PlatformDomainsPage() {
  const canRead = useCanReadPlatformDomains();

  if (!canRead) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center shadow-xs">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">Access Forbidden</h2>
        <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
          The domain registry spans every organization and requires platform-level read
          authorization.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">Domains</h1>
        <p className="text-xs text-[var(--color-ink-muted)]">
          Platform-wide registry of organization subdomains and white-label custom domains:
          ownership verification, challenge expiry, DNS propagation and lifecycle history.
        </p>
      </div>
      <DomainRegistry />
    </div>
  );
}
