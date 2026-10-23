'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { channelsApi } from '@/lib/api-client';
import { useCanReadMessages, useCanReadProviders, useSession } from '@/lib/session-store';
import { MessageListCard } from '@/components/messages/message-list-card';

export default function MessagesPage() {
  const selectedOrganizationId = useSession((state) => state.selectedOrganizationId);
  const canReadMessages = useCanReadMessages();
  const canReadProviders = useCanReadProviders();

  // Query channels catalogue if permitted to enrich channel display names
  const { data: channelsData } = useQuery({
    queryKey: ['channels', 'list', selectedOrganizationId],
    queryFn: ({ signal }) => channelsApi.list({ limit: 50, tenantScoped: true }, signal),
    enabled: Boolean(selectedOrganizationId) && (canReadProviders || canReadMessages),
    retry: false,
  });

  if (!selectedOrganizationId) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center shadow-xs">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">
          Organization Context Required
        </h2>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          Please select an organization from the header switcher to view its message dispatch
          history.
        </p>
      </div>
    );
  }

  if (!canReadMessages) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center shadow-xs">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">Access Forbidden</h2>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          You do not have permission to view message dispatch history. This section requires the{' '}
          <code className="text-xs">messages.read</code> permission for the active organization.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">
            Dispatched Messages
          </h1>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Organization message delivery history, provider attempt timelines, and outcome
            settlement.
          </p>
        </div>

        <Link
          href="/whatsapp"
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 shadow-xs transition-colors"
        >
          Dispatch Test Message
        </Link>
      </div>

      <MessageListCard
        key={selectedOrganizationId}
        orgId={selectedOrganizationId}
        channels={channelsData?.data ?? []}
      />
    </div>
  );
}
