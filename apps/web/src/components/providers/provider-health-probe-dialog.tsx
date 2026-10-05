'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  providersApi,
  type ProviderDetailView,
  type ProviderHealthCheckResult,
} from '@/lib/api-client';
import { SIMULATOR_HEALTH_BEHAVIORS, type SimulatorHealthBehavior } from '@acc/contracts';
import { ProviderCircuitBadge, ProviderHealthBadge } from './provider-status-badge';

interface ProviderHealthProbeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ProviderDetailView;
}

export function ProviderHealthProbeDialog({
  open,
  onOpenChange,
  provider,
}: ProviderHealthProbeDialogProps) {
  const queryClient = useQueryClient();

  const [behavior, setBehavior] = useState<SimulatorHealthBehavior>('HEALTHY');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<ProviderHealthCheckResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);
    setResult(null);

    try {
      const res = await providersApi.healthCheck(provider.id, { behavior });
      setResult(res.data);
      await queryClient.invalidateQueries({ queryKey: ['providers'] });
    } catch (err) {
      if (err instanceof ApiError) {
        if (
          err.status === 403 ||
          err.code === 'AUTHZ_SCOPE_DENIED' ||
          err.code === 'AUTHZ_FORBIDDEN'
        ) {
          setErrorMessage(
            'Authorization refused (403): You do not have permission (providers.manage) to execute health check probes.',
          );
        } else {
          setErrorMessage(err.message);
        }
      } else {
        setErrorMessage('Failed to execute health check probe.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setResult(null);
    setErrorMessage(null);
    onOpenChange(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
      <div className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">
          Run Health Probe — {provider.name}
        </h2>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          Triggers a synchronous health probe against the adapter. Records a probe sample that moves
          health state.
        </p>

        {errorMessage && (
          <div className="mt-4 rounded-md border border-[var(--color-bad-subtle,rgba(239,68,68,0.2))] bg-[var(--color-bad-subtle,rgba(239,68,68,0.05))] p-3 text-xs text-[var(--color-bad,#ef4444)]">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label
              htmlFor="health-probe-behavior"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Simulated Probe Answer
            </label>
            <select
              id="health-probe-behavior"
              value={behavior}
              onChange={(e) => setBehavior(e.target.value as SimulatorHealthBehavior)}
              disabled={isSubmitting}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink)] shadow-xs focus:border-[var(--color-accent)] focus:outline-hidden"
            >
              {SIMULATOR_HEALTH_BEHAVIORS.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={handleClose}
              disabled={isSubmitting}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? 'Probing…' : 'Execute Probe'}
            </button>
          </div>
        </form>

        {result && (
          <div
            data-testid="health-probe-result"
            className="mt-4 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]/40 p-4 space-y-3"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[var(--color-ink)]">Probe Result</span>
              <span
                data-testid="health-probe-outcome"
                className={`rounded px-1.5 py-0.5 text-[11px] font-mono font-medium ${
                  result.outcome === 'healthy'
                    ? 'bg-[var(--color-ok-subtle,rgba(16,185,129,0.1))] text-[var(--color-ok,#10b981)]'
                    : 'bg-[var(--color-bad-subtle,rgba(239,68,68,0.1))] text-[var(--color-bad,#ef4444)]'
                }`}
              >
                {result.outcome.toUpperCase()}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-[var(--color-ink-muted)]">Latency</span>
                <p className="font-mono">{result.latencyMs} ms</p>
              </div>
              <div>
                <span className="text-[var(--color-ink-muted)]">Correlation ID</span>
                <p className="font-mono text-[10px] truncate" title={result.correlationId}>
                  {result.correlationId.slice(0, 8)}…
                </p>
              </div>
              <div>
                <span className="text-[var(--color-ink-muted)]">New Health State</span>
                <div className="mt-0.5">
                  <ProviderHealthBadge healthState={result.healthState} />
                </div>
              </div>
              <div>
                <span className="text-[var(--color-ink-muted)]">Circuit State</span>
                <div className="mt-0.5">
                  <ProviderCircuitBadge circuitState={result.circuitState} />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
