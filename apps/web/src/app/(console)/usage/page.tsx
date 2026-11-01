'use client';

import { MessageUsageReport } from '@/components/usage/message-usage-report';
import { useCanReadMessages, useSession } from '@/lib/session-store';

export default function UsagePage() {
  const selectedOrganizationId = useSession((state) => state.selectedOrganizationId);
  const canReadMessages = useCanReadMessages();

  if (!selectedOrganizationId) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center shadow-xs">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">
          Organization Context Required
        </h2>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          Select an organization from the header switcher to view its message usage.
        </p>
      </div>
    );
  }

  if (!canReadMessages) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center shadow-xs">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">Access Forbidden</h2>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          Message usage requires the <code className="text-xs">messages.read</code> permission for
          the active organization.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">Message Usage</h1>
        <p className="text-xs text-[var(--color-ink-muted)]">
          Messages created by this organization over a period: by outcome, channel and day.
        </p>
      </div>
      {/* Keyed by organization so no filter or result carries over a switch. */}
      <MessageUsageReport key={selectedOrganizationId} orgId={selectedOrganizationId} />
    </div>
  );
}
