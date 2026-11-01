'use client';

import { useQuery } from '@tanstack/react-query';
import { platformSupportApi, type PlatformSupportRoutingDiagnostics } from '@/lib/api-client';
import { StatusDot, type StatusTone } from '@/components/ui/status-dot';

function getCircuitTone(circuitState: string): StatusTone {
  switch (circuitState.toLowerCase()) {
    case 'closed':
      return 'ok';
    case 'half_open':
    case 'half-open':
      return 'warn';
    case 'open':
      return 'bad';
    default:
      return 'unknown';
  }
}

function getHealthTone(classification: string): StatusTone {
  switch (classification.toLowerCase()) {
    case 'healthy':
      return 'ok';
    case 'degraded':
      return 'warn';
    case 'offline':
      return 'bad';
    default:
      return 'unknown';
  }
}

export function SupportRoutingTab({ orgId }: { orgId: string }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['platform-support', 'routing', orgId],
    queryFn: ({ signal }) => platformSupportApi.getRouting(orgId, signal),
    enabled: Boolean(orgId),
  });

  if (isLoading) {
    return (
      <div
        role="status"
        className="py-12 text-center text-sm text-[var(--color-ink-muted)]"
        data-testid="support-routing-loading"
      >
        Loading routing & provider diagnostics…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-[var(--color-bad)]/30 bg-[var(--color-bad)]/10 p-4 text-sm text-[var(--color-ink)]"
        data-testid="support-routing-error"
      >
        <p className="font-semibold text-[var(--color-bad)]">Failed to load routing diagnostics</p>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">{(error as Error).message}</p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="mt-3 rounded-md bg-[var(--color-surface-raised)] px-3 py-1 text-xs font-medium border border-[var(--color-border-subtle)]"
        >
          Retry
        </button>
      </div>
    );
  }

  const routing: PlatformSupportRoutingDiagnostics | undefined = data?.data;
  if (!routing) return null;

  const { channels, assignments, providerHealth } = routing;

  return (
    <div className="space-y-6" data-testid="support-routing-tab">
      {/* Privacy & Security Safeguard Banner */}
      <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3.5 text-xs text-[var(--color-ink-muted)]">
        <svg
          className="size-4 shrink-0 text-[var(--color-ok)]"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
          />
        </svg>
        <span>
          <strong className="font-semibold text-[var(--color-ink)]">Zero Secrets Exposed:</strong>{' '}
          All provider credentials, webhook signing secrets, auth tokens, and account keys are
          strictly redacted at the backend boundary.
        </span>
      </div>

      {/* Provider Health & Circuits */}
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
        <h3 className="text-sm font-semibold tracking-tight">Provider Health & Circuit Status</h3>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          Live circuit breaker telemetry and latency across providers for this tenant.
        </p>

        {providerHealth.length === 0 ? (
          <p className="mt-3 text-xs text-[var(--color-ink-muted)]">
            No active provider health records available.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--color-border-subtle)] text-[var(--color-ink-muted)]">
                <tr>
                  <th scope="col" className="pb-2 font-medium">
                    Provider
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Circuit State
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Health State
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Failure Count
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Last Failure
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)]">
                {providerHealth.map((ph) => (
                  <tr key={ph.providerId}>
                    <td className="py-2.5 font-medium">
                      {ph.providerName}
                      <span className="block font-mono text-2xs text-[var(--color-ink-muted)]">
                        {ph.providerId}
                      </span>
                    </td>
                    <td className="py-2.5">
                      <StatusDot tone={getCircuitTone(ph.circuitState)} label={ph.circuitState} />
                    </td>
                    <td className="py-2.5">
                      <StatusDot tone={getHealthTone(ph.healthState)} label={ph.healthState} />
                    </td>
                    <td className="py-2.5">{ph.failureCount}</td>
                    <td className="py-2.5">
                      {ph.lastFailureAt ? new Date(ph.lastFailureAt).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Channels Configuration */}
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
        <h3 className="text-sm font-semibold tracking-tight">Channel Configurations</h3>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-[var(--color-border-subtle)] text-[var(--color-ink-muted)]">
              <tr>
                <th scope="col" className="pb-2 font-medium">
                  Code
                </th>
                <th scope="col" className="pb-2 font-medium">
                  Name
                </th>
                <th scope="col" className="pb-2 font-medium">
                  Status
                </th>
                <th scope="col" className="pb-2 font-medium">
                  Default Provider ID
                </th>
                <th scope="col" className="pb-2 font-medium">
                  Fallback Provider ID
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-subtle)]">
              {channels.map((ch) => (
                <tr key={ch.id}>
                  <td className="py-2.5 font-mono uppercase font-semibold">{ch.code}</td>
                  <td className="py-2.5 font-medium">{ch.name}</td>
                  <td className="py-2.5 capitalize">{ch.status}</td>
                  <td className="py-2.5 font-mono text-[var(--color-ink-muted)]">
                    {ch.defaultProviderId ?? '—'}
                  </td>
                  <td className="py-2.5 font-mono text-[var(--color-ink-muted)]">
                    {ch.fallbackProviderId ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Provider Assignments */}
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
        <h3 className="text-sm font-semibold tracking-tight">Active Provider Assignments</h3>
        {assignments.length === 0 ? (
          <p className="mt-3 text-xs text-[var(--color-ink-muted)]">
            No custom provider assignments configured for this organization.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--color-border-subtle)] text-[var(--color-ink-muted)]">
                <tr>
                  <th scope="col" className="pb-2 font-medium">
                    Channel
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Provider Name
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Priority
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Role
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)]">
                {assignments.map((a) => (
                  <tr key={a.id}>
                    <td className="py-2.5 font-mono uppercase font-medium">{a.channel}</td>
                    <td className="py-2.5">
                      {a.providerName}
                      <span className="block font-mono text-2xs text-[var(--color-ink-muted)]">
                        {a.providerId}
                      </span>
                    </td>
                    <td className="py-2.5">{a.priority}</td>
                    <td className="py-2.5">{a.isFallback ? 'Fallback' : 'Primary'}</td>
                    <td className="py-2.5">
                      <StatusDot tone={a.status === 'active' ? 'ok' : 'unknown'} label={a.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
