'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
  ApiError,
  providersApi,
  type ListProviderHealthParams,
} from '@/lib/api-client';
import {
  useCanManageProviders,
  useCanReadProviders,
  useCanTestSendProviders,
} from '@/lib/session-store';
import {
  ProviderCircuitBadge,
  ProviderHealthBadge,
  ProviderLifecycleBadge,
} from '@/components/providers/provider-status-badge';
import { ProviderTransitionDialog } from '@/components/providers/provider-transition-dialog';
import { ProviderCapabilitiesDialog } from '@/components/providers/provider-capabilities-dialog';
import { ProviderHealthOverrideDialog } from '@/components/providers/provider-health-override-dialog';
import { ProviderHealthProbeDialog } from '@/components/providers/provider-health-probe-dialog';
import { ProviderTestSendPanel } from '@/components/providers/provider-test-send-panel';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import type { ProviderTransition } from '@acc/contracts';

export default function ProviderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const canReadProviders = useCanReadProviders();
  const canManageProviders = useCanManageProviders();
  const canTestSend = useCanTestSendProviders();

  // Dialog controls
  const [transitionTarget, setTransitionTarget] = useState<ProviderTransition | null>(null);
  const [isCapabilitiesOpen, setIsCapabilitiesOpen] = useState(false);
  const [isHealthOverrideOpen, setIsHealthOverrideOpen] = useState(false);
  const [isHealthProbeOpen, setIsHealthProbeOpen] = useState(false);

  // Health samples pagination cursor stack
  const [sampleCursorStack, setSampleCursorStack] = useState<string[]>([]);
  const currentSampleCursor =
    sampleCursorStack.length > 0
      ? sampleCursorStack[sampleCursorStack.length - 1]
      : undefined;

  // Provider Detail Query
  const {
    data: providerData,
    isLoading: isProviderLoading,
    error: providerError,
    refetch: refetchProvider,
    isFetching,
  } = useQuery({
    queryKey: ['providers', 'detail', id],
    queryFn: ({ signal }) => providersApi.get(id, signal),
    enabled: canReadProviders,
    refetchInterval: 10_000,
  });

  const provider = providerData?.data;

  // Health Samples Query
  const sampleParams: ListProviderHealthParams = {
    cursor: currentSampleCursor,
    limit: 10,
  };

  const {
    data: samplesData,
    isLoading: isSamplesLoading,
    refetch: refetchSamples,
  } = useQuery({
    queryKey: ['providers', 'health-samples', id, sampleParams],
    queryFn: ({ signal }) => providersApi.listHealth(id, sampleParams, signal),
    enabled: canReadProviders && !!provider,
    refetchInterval: 10_000,
  });

  const handleNextSamplePage = () => {
    if (samplesData?.page.nextCursor) {
      setSampleCursorStack((prev) => [...prev, samplesData.page.nextCursor!]);
    }
  };

  const handlePrevSamplePage = () => {
    setSampleCursorStack((prev) => prev.slice(0, -1));
  };

  if (!canReadProviders) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center shadow-xs">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">Access Forbidden</h2>
        <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
          You do not have permission to view provider details.
        </p>
      </div>
    );
  }

  if (isProviderLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="size-6 animate-spin rounded-full border-2 border-[var(--color-ink-muted)] border-t-transparent" />
      </div>
    );
  }

  if (providerError) {
    return (
      <div className="rounded-xl border border-[var(--color-bad-subtle,rgba(239,68,68,0.2))] bg-[var(--color-surface)] p-6 text-center shadow-xs">
        <p className="text-xs font-medium text-[var(--color-bad,#ef4444)]">
          Failed to load provider details.
        </p>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          {providerError instanceof ApiError ? providerError.message : 'Unknown communication error'}
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <Link
            href="/providers"
            className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
          >
            Back to Providers
          </Link>
          <button
            type="button"
            onClick={() => void refetchProvider()}
            className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!provider) return null;

  const samples = samplesData?.data ?? [];
  const samplePageInfo = samplesData?.page;

  return (
    <div className="space-y-6">
      {/* Breadcrumb & Navigation */}
      <div className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
        <Link href="/providers" className="hover:underline">
          Providers
        </Link>
        <span>/</span>
        <span className="font-mono text-[var(--color-ink)]">{provider.name}</span>
      </div>

      {/* Header & Lifecycle Actions */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-border-subtle)] pb-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">
              {provider.name}
            </h1>
            <ProviderLifecycleBadge status={provider.status} />
            <ProviderHealthBadge
              healthState={provider.healthState}
              healthOverride={provider.healthOverride}
            />
            <ProviderCircuitBadge
              circuitState={provider.circuitState}
              cooldownUntil={provider.circuitCooldownUntil}
            />
          </div>
          <p className="mt-1 font-mono text-xs text-[var(--color-ink-muted)]">
            Channel: <span className="uppercase">{provider.channelCode}</span> • Adapter: {provider.adapterKey}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canManageProviders && (
            <>
              {provider.status !== 'active' && (
                <button
                  type="button"
                  onClick={() => setTransitionTarget('enable')}
                  className="rounded-md bg-[var(--color-ok,#10b981)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 transition-opacity"
                  data-testid="enable-provider-btn"
                >
                  Enable
                </button>
              )}

              {provider.status === 'active' && (
                <button
                  type="button"
                  onClick={() => setTransitionTarget('drain')}
                  className="rounded-md bg-[var(--color-warn,#f59e0b)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 transition-opacity"
                  data-testid="drain-provider-btn"
                >
                  Drain
                </button>
              )}

              {provider.status !== 'disabled' && (
                <button
                  type="button"
                  onClick={() => setTransitionTarget('disable')}
                  className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-bad,#ef4444)] hover:bg-[var(--color-bad-subtle,rgba(239,68,68,0.05))] transition-colors"
                  data-testid="disable-provider-btn"
                >
                  Disable
                </button>
              )}
            </>
          )}

          <button
            type="button"
            onClick={() => {
              void refetchProvider();
              void refetchSamples();
            }}
            disabled={isFetching}
            className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] transition-colors disabled:opacity-50"
          >
            {isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Grid: Health & Circuit + Capabilities */}
      <div className="grid gap-6 sm:grid-cols-2">
        {/* Health & Circuit Status Card */}
        <Card>
          <div className="flex items-center justify-between">
            <CardTitle>Health & Circuit Breaker</CardTitle>
            <div className="flex gap-1.5">
              {canManageProviders && (
                <>
                  <button
                    type="button"
                    onClick={() => setIsHealthProbeOpen(true)}
                    className="rounded border border-[var(--color-border-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                    data-testid="run-probe-btn"
                  >
                    Run Probe
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsHealthOverrideOpen(true)}
                    className="rounded border border-[var(--color-border-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                    data-testid="health-override-btn"
                  >
                    Override
                  </button>
                </>
              )}
            </div>
          </div>

          <dl className="mt-4 divide-y divide-[var(--color-border-subtle)] text-xs">
            <div className="flex items-center justify-between py-2">
              <dt className="text-[var(--color-ink-muted)]">Observed Health</dt>
              <dd>
                <ProviderHealthBadge
                  healthState={provider.healthState}
                  healthOverride={provider.healthOverride}
                />
              </dd>
            </div>
            <div className="flex items-center justify-between py-2">
              <dt className="text-[var(--color-ink-muted)]">Manual Pin</dt>
              <dd className="font-mono">
                {provider.healthOverride ? (
                  <span className="text-[var(--color-warn,#f59e0b)] font-semibold uppercase">
                    {provider.healthOverride}
                  </span>
                ) : (
                  <span className="text-[var(--color-ink-muted)]">Automatic (no pin)</span>
                )}
              </dd>
            </div>
            <div className="flex items-center justify-between py-2">
              <dt className="text-[var(--color-ink-muted)]">Health Changed At</dt>
              <dd className="text-[var(--color-ink)]">
                {provider.healthChangedAt
                  ? new Date(provider.healthChangedAt).toLocaleString()
                  : '—'}
              </dd>
            </div>
            <div className="flex items-center justify-between py-2">
              <dt className="text-[var(--color-ink-muted)]">Circuit Breaker</dt>
              <dd>
                <ProviderCircuitBadge
                  circuitState={provider.circuitState}
                  cooldownUntil={provider.circuitCooldownUntil}
                />
              </dd>
            </div>
            <div className="flex items-center justify-between py-2">
              <dt className="text-[var(--color-ink-muted)]">Circuit Changed At</dt>
              <dd className="text-[var(--color-ink)]">
                {provider.circuitChangedAt
                  ? new Date(provider.circuitChangedAt).toLocaleString()
                  : '—'}
              </dd>
            </div>
            <div className="flex items-center justify-between py-2">
              <dt className="text-[var(--color-ink-muted)]">Cooldown Ends At</dt>
              <dd className="font-mono text-[11px] text-[var(--color-ink)]">
                {provider.circuitCooldownUntil
                  ? new Date(provider.circuitCooldownUntil).toLocaleTimeString()
                  : '—'}
              </dd>
            </div>
          </dl>
        </Card>

        {/* Capabilities Card */}
        <Card>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Declared Capabilities</CardTitle>
              <CardDescription>Non-secret provider adapter attributes</CardDescription>
            </div>
            {canManageProviders && (
              <button
                type="button"
                onClick={() => setIsCapabilitiesOpen(true)}
                className="rounded border border-[var(--color-border-subtle)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                data-testid="edit-capabilities-btn"
              >
                Edit
              </button>
            )}
          </div>

          <div className="mt-4">
            {provider.capabilities.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-6 text-center text-xs text-[var(--color-ink-muted)]">
                No capabilities declared for this provider.
              </div>
            ) : (
              <div className="max-h-[220px] overflow-y-auto divide-y divide-[var(--color-border-subtle)] pr-1">
                {provider.capabilities.map((c) => (
                  <div key={c.key} className="py-2 text-xs flex justify-between items-start gap-2">
                    <span className="font-mono font-medium text-[var(--color-ink)]">
                      {c.key}
                    </span>
                    <pre className="font-mono text-[11px] text-[var(--color-ink-muted)] max-w-[200px] overflow-x-auto text-right">
                      {JSON.stringify(c.value)}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Simulator Test-Send Interactive Panel */}
      <ProviderTestSendPanel provider={provider} canTestSend={canTestSend} />

      {/* Health Samples History Table */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-ink)]">
              Health Sample History
            </h2>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Recent test-send submissions, health-check probes, and manual overrides (newest first).
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refetchSamples()}
            className="text-xs text-[var(--color-ink-muted)] hover:underline"
          >
            Refresh history
          </button>
        </div>

        {isSamplesLoading ? (
          <div className="flex justify-center py-6">
            <div className="size-5 animate-spin rounded-full border-2 border-[var(--color-ink-muted)] border-t-transparent" />
          </div>
        ) : samples.length === 0 ? (
          <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 text-center text-xs text-[var(--color-ink-muted)]">
            No health samples observed yet. Run a probe or execute a test-send to generate samples.
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs" data-testid="health-samples-table">
                <thead className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Observed At
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Kind
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Outcome
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Classification
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Latency
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Health
                    </th>
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Circuit
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border-subtle)]">
                  {samples.map((s) => (
                    <tr
                      key={s.id}
                      className="hover:bg-[var(--color-surface-raised)]/50 transition-colors"
                    >
                      <td className="px-4 py-2.5 whitespace-nowrap text-[var(--color-ink)]">
                        {new Date(s.observedAt).toLocaleTimeString()}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[11px] uppercase text-[var(--color-ink-muted)]">
                        {s.kind}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[11px] font-medium text-[var(--color-ink)]">
                        {s.outcome}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                            s.classification === 'success'
                              ? 'bg-[var(--color-ok-subtle,rgba(16,185,129,0.1))] text-[var(--color-ok,#10b981)]'
                              : s.classification === 'failure'
                              ? 'bg-[var(--color-bad-subtle,rgba(239,68,68,0.1))] text-[var(--color-bad,#ef4444)]'
                              : 'bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]'
                          }`}
                        >
                          {s.classification}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-[var(--color-ink)]">
                        {s.latencyMs !== null ? `${s.latencyMs} ms` : '—'}
                      </td>
                      <td className="px-4 py-2.5">
                        <ProviderHealthBadge healthState={s.healthState} />
                      </td>
                      <td className="px-4 py-2.5">
                        <ProviderCircuitBadge circuitState={s.circuitState} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {(samplePageInfo?.hasMore || sampleCursorStack.length > 0) && (
              <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] px-4 py-2.5 bg-[var(--color-surface)]">
                <span className="text-[11px] text-[var(--color-ink-muted)]">
                  Showing {samples.length} samples
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handlePrevSamplePage}
                    disabled={sampleCursorStack.length === 0}
                    className="rounded border border-[var(--color-border-subtle)] px-2 py-0.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={handleNextSamplePage}
                    disabled={!samplePageInfo?.hasMore}
                    className="rounded border border-[var(--color-border-subtle)] px-2 py-0.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Dialogs */}
      {transitionTarget && (
        <ProviderTransitionDialog
          open={!!transitionTarget}
          onOpenChange={(open) => !open && setTransitionTarget(null)}
          provider={provider}
          transition={transitionTarget}
        />
      )}

      {isCapabilitiesOpen && (
        <ProviderCapabilitiesDialog
          open={isCapabilitiesOpen}
          onOpenChange={setIsCapabilitiesOpen}
          provider={provider}
        />
      )}

      {isHealthOverrideOpen && (
        <ProviderHealthOverrideDialog
          open={isHealthOverrideOpen}
          onOpenChange={setIsHealthOverrideOpen}
          provider={provider}
        />
      )}

      {isHealthProbeOpen && (
        <ProviderHealthProbeDialog
          open={isHealthProbeOpen}
          onOpenChange={setIsHealthProbeOpen}
          provider={provider}
        />
      )}
    </div>
  );
}
