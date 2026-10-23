'use client';

import { useQuery } from '@tanstack/react-query';
import { channelsApi } from '@/lib/api-client';
import { useCanReadProviders, useCanReadSuppressions, useSession } from '@/lib/session-store';
import { SuppressionListCard } from '@/components/suppressions/suppression-list-card';

export default function SuppressionsPage() {
  const selectedOrganizationId = useSession((state) => state.selectedOrganizationId);
  const canReadSuppressions = useCanReadSuppressions();
  const canReadProviders = useCanReadProviders();

  // Query channels catalogue if permitted to enrich channel display names (migration 0035)
  const { data: channelsData } = useQuery({
    queryKey: ['channels', 'list', selectedOrganizationId],
    queryFn: ({ signal }) => channelsApi.list({ limit: 50, tenantScoped: true }, signal),
    enabled: Boolean(selectedOrganizationId) && (canReadProviders || canReadSuppressions),
    retry: false,
  });

  if (!selectedOrganizationId) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center shadow-xs">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">
          Organization Context Required
        </h2>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          Please select an organization from the header switcher to manage its suppression list.
        </p>
      </div>
    );
  }

  if (!canReadSuppressions) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center shadow-xs">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">Access Forbidden</h2>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          You do not have permission to view suppressions for this organization.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight text-[var(--color-ink)]">
          Suppressions
        </h1>
        <p className="text-xs text-[var(--color-ink-muted)]">
          Organization recipient suppressions, opt-out management, and dispatch blocklist.
        </p>
      </div>

      <SuppressionListCard
        key={selectedOrganizationId}
        orgId={selectedOrganizationId}
        channels={channelsData?.data ?? []}
      />
    </div>
  );
}
