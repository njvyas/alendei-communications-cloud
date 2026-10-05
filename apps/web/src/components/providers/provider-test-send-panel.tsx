'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  providersApi,
  type ProviderDetailView,
  type ProviderTestSendResult,
} from '@/lib/api-client';
import { SIMULATOR_BEHAVIORS, type SimulatorBehavior } from '@acc/contracts';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { ProviderCircuitBadge, ProviderHealthBadge } from './provider-status-badge';

interface ProviderTestSendPanelProps {
  provider: ProviderDetailView;
  canTestSend: boolean;
}

export function ProviderTestSendPanel({ provider, canTestSend }: ProviderTestSendPanelProps) {
  const queryClient = useQueryClient();

  const [behavior, setBehavior] = useState<SimulatorBehavior>('SUCCESS');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [circuitCountdown, setCircuitCountdown] = useState<number | null>(null);
  const [result, setResult] = useState<ProviderTestSendResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (circuitCountdown === null || circuitCountdown <= 0) return;
    const timer = setInterval(() => {
      setCircuitCountdown((prev) => (prev !== null && prev > 1 ? prev - 1 : null));
    }, 1000);
    return () => clearInterval(timer);
  }, [circuitCountdown]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);
    setResult(null);

    try {
      const res = await providersApi.testSend(provider.id, { behavior });
      setResult(res.data);
      // Invalidate queries so that provider state, health, and sample history reflect the new sample
      await queryClient.invalidateQueries({ queryKey: ['providers'] });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'PROVIDER_CIRCUIT_OPEN') {
          // Use details.retryAfterMs when present for countdown; do not use generic retryable flag
          const retryAfterMs =
            typeof err.details?.retryAfterMs === 'number' ? err.details.retryAfterMs : null;
          if (retryAfterMs !== null && retryAfterMs > 0) {
            setCircuitCountdown(Math.ceil(retryAfterMs / 1000));
          } else {
            setCircuitCountdown(null);
          }
          const stateDesc = err.details?.circuitState ? String(err.details.circuitState) : 'open';
          setErrorMessage(
            `Circuit refusal (409): Provider circuit is ${stateDesc}; submission was not sent.${
              retryAfterMs !== null ? ` Retry allowed in ${Math.ceil(retryAfterMs / 1000)}s.` : ''
            }`,
          );
        } else if (err.code === 'PROVIDER_LIFECYCLE_CONFLICT') {
          const status = err.details?.status ? String(err.details.status) : 'inactive';
          setErrorMessage(
            `Lifecycle refusal (409): Provider must be active to process test-sends (current status: ${status}).`,
          );
        } else if (
          err.status === 403 ||
          err.code === 'AUTHZ_SCOPE_DENIED' ||
          err.code === 'AUTHZ_FORBIDDEN'
        ) {
          setErrorMessage(
            'Authorization refused (403): You do not have permission (providers.test_send) to execute test submissions.',
          );
        } else {
          setErrorMessage(err.message);
        }
      } else {
        setErrorMessage('Failed to execute test submission. Please check your network connection.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!canTestSend) {
    return (
      <Card>
        <CardTitle>Simulator Test-Send</CardTitle>
        <CardDescription>
          Execute synthetic test submissions through the provider’s adapter to verify dispatch
          behavior, latency, and circuit reactions.
        </CardDescription>
        <div className="mt-4 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]/30 p-4 text-center text-xs text-[var(--color-ink-muted)]">
          You do not hold permission (<code>providers.test_send</code>) to execute synthetic test
          submissions.
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <div>
          <CardTitle>Simulator Test-Send</CardTitle>
          <CardDescription>
            Execute synthetic test submissions through the provider’s adapter to verify dispatch
            behavior, latency, and circuit reactions.
          </CardDescription>
        </div>
        <span className="font-mono text-[10px] rounded px-2 py-0.5 border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]">
          adapter: {provider.adapterKey}
        </span>
      </div>

      {errorMessage && (
        <div className="mt-4 rounded-md border border-[var(--color-bad-subtle,rgba(239,68,68,0.2))] bg-[var(--color-bad-subtle,rgba(239,68,68,0.05))] p-3 text-xs text-[var(--color-bad,#ef4444)]">
          {errorMessage}
        </div>
      )}

      <form onSubmit={handleSubmit} className="mt-4 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[200px]">
          <label
            htmlFor="test-send-behavior"
            className="block text-xs font-medium text-[var(--color-ink)]"
          >
            Simulated Behavior
          </label>
          <select
            id="test-send-behavior"
            value={behavior}
            onChange={(e) => setBehavior(e.target.value as SimulatorBehavior)}
            disabled={isSubmitting || (circuitCountdown !== null && circuitCountdown > 0)}
            className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink)] shadow-xs focus:border-[var(--color-accent)] focus:outline-hidden"
          >
            {SIMULATOR_BEHAVIORS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          disabled={isSubmitting || (circuitCountdown !== null && circuitCountdown > 0)}
          className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50 transition-opacity"
        >
          {isSubmitting
            ? 'Sending…'
            : circuitCountdown !== null && circuitCountdown > 0
              ? `Circuit Cooldown (${circuitCountdown}s)`
              : 'Execute Test Send'}
        </button>
      </form>

      {/* Result Output */}
      {result && (
        <div
          className="mt-5 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]/40 p-4 space-y-4"
          data-testid="test-send-result"
        >
          <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-[var(--color-ink)]">Outcome:</span>
              <span
                className={`rounded-full px-2.5 py-0.5 text-xs font-medium uppercase tracking-wider ${
                  result.outcome === 'accepted'
                    ? 'bg-[var(--color-ok-subtle,rgba(16,185,129,0.1))] text-[var(--color-ok,#10b981)]'
                    : 'bg-[var(--color-bad-subtle,rgba(239,68,68,0.1))] text-[var(--color-bad,#ef4444)]'
                }`}
                data-testid="test-send-outcome"
              >
                {result.outcome}
              </span>
            </div>

            <div className="flex items-center gap-3 text-xs text-[var(--color-ink-muted)]">
              <span>
                Latency:{' '}
                <strong className="font-mono text-[var(--color-ink)]">{result.latencyMs} ms</strong>
              </span>
              {result.circuitProbe && (
                <span className="rounded bg-[var(--color-warn-subtle,rgba(245,158,11,0.1))] text-[var(--color-warn,#f59e0b)] px-1.5 py-0.5 text-[10px] font-mono">
                  HALF-OPEN PROBE
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div>
              <span className="text-[var(--color-ink-muted)]">Submission ID</span>
              <p
                className="font-mono text-[11px] text-[var(--color-ink)] truncate"
                title={result.submissionId}
              >
                {result.submissionId}
              </p>
            </div>

            <div>
              <span className="text-[var(--color-ink-muted)]">Provider Message ID</span>
              <p className="font-mono text-[11px] text-[var(--color-ink)]">
                {result.providerMessageId ?? (
                  <span className="italic text-[var(--color-ink-muted)]">none</span>
                )}
              </p>
            </div>

            <div>
              <span className="text-[var(--color-ink-muted)]">Health After Submission</span>
              <div className="mt-1">
                <ProviderHealthBadge healthState={result.healthState} />
              </div>
            </div>

            <div>
              <span className="text-[var(--color-ink-muted)]">Circuit After Submission</span>
              <div className="mt-1">
                <ProviderCircuitBadge circuitState={result.circuitState} />
              </div>
            </div>
          </div>

          {result.failure && (
            <div className="rounded border border-[var(--color-bad-subtle,rgba(239,68,68,0.2))] bg-[var(--color-bad-subtle,rgba(239,68,68,0.05))] p-3 space-y-1 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-medium text-[var(--color-bad,#ef4444)]">
                  Failure: {result.failure.category}
                </span>
                <span className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                  {result.failure.retryable ? 'RETRYABLE' : 'NON-RETRYABLE'}
                </span>
              </div>
              <p className="text-[var(--color-ink)]">{result.failure.message}</p>
              {result.failure.providerCode && (
                <p className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                  Provider code: {result.failure.providerCode}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
