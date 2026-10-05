'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  providerCircuitPolicyApi,
  type CircuitPolicyView,
} from '@/lib/api-client';
import { PROVIDER_CIRCUIT_POLICY_BOUNDS as B } from '@acc/contracts';

interface CircuitPolicyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CircuitPolicyDialog({ open, onOpenChange }: CircuitPolicyDialogProps) {
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['provider-circuit-policy'],
    queryFn: ({ signal }) => providerCircuitPolicyApi.get(signal),
    enabled: open,
    refetchInterval: 15_000,
  });

  const currentPolicy = data?.data;

  // Form fields
  const [windowMs, setWindowMs] = useState<number>(60000);
  const [windowMaxSamples, setWindowMaxSamples] = useState<number>(20);
  const [minSamples, setMinSamples] = useState<number>(5);
  const [failurePercent, setFailurePercent] = useState<number>(50);
  const [cooldownMs, setCooldownMs] = useState<number>(30000);
  const [halfOpenMaxProbes, setHalfOpenMaxProbes] = useState<number>(1);
  const [probeLeaseMs, setProbeLeaseMs] = useState<number>(10000);
  const [halfOpenSuccessesToClose, setHalfOpenSuccessesToClose] = useState<number>(2);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Sync state from query
  useEffect(() => {
    if (currentPolicy) {
      setWindowMs(currentPolicy.windowMs);
      setWindowMaxSamples(currentPolicy.windowMaxSamples);
      setMinSamples(currentPolicy.minSamples);
      setFailurePercent(currentPolicy.failurePercent);
      setCooldownMs(currentPolicy.cooldownMs);
      setHalfOpenMaxProbes(currentPolicy.halfOpenMaxProbes);
      setProbeLeaseMs(currentPolicy.probeLeaseMs);
      setHalfOpenSuccessesToClose(currentPolicy.halfOpenSuccessesToClose);
    }
  }, [currentPolicy]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPolicy) return;

    setErrorMessage(null);
    setSuccessMessage(null);

    if (minSamples > windowMaxSamples) {
      setErrorMessage(
        `Validation error: Minimum samples (${minSamples}) cannot exceed window maximum samples (${windowMaxSamples}).`,
      );
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await providerCircuitPolicyApi.update({
        windowMs: Number(windowMs),
        windowMaxSamples: Number(windowMaxSamples),
        minSamples: Number(minSamples),
        failurePercent: Number(failurePercent),
        cooldownMs: Number(cooldownMs),
        halfOpenMaxProbes: Number(halfOpenMaxProbes),
        probeLeaseMs: Number(probeLeaseMs),
        halfOpenSuccessesToClose: Number(halfOpenSuccessesToClose),
        expectedVersion: currentPolicy.version,
      });

      setSuccessMessage(`Circuit policy updated to version ${res.data.version}.`);
      await queryClient.invalidateQueries({ queryKey: ['provider-circuit-policy'] });
      await queryClient.invalidateQueries({ queryKey: ['providers'] });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 409) {
          const currentVersion = err.details?.currentVersion ?? 'unknown';
          setErrorMessage(
            `Concurrency conflict (409): The policy was modified by another operator (current version: ${currentVersion}). Your changes were rejected. Please refresh to load the latest policy.`,
          );
          void refetch();
        } else {
          setErrorMessage(err.message);
        }
      } else {
        setErrorMessage('Failed to update circuit policy. Please check your connection.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
      <div className="w-full max-w-xl rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-ink)]">
              Platform Circuit Breaker Policy
            </h2>
            <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
              Governs circuit breaker trips, cooldown windows, and probe recovery across all providers.
            </p>
          </div>
          {currentPolicy && (
            <span className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-ink-muted)]">
              v{currentPolicy.version}
            </span>
          )}
        </div>

        {errorMessage && (
          <div className="mt-4 rounded-md border border-[var(--color-bad-subtle,rgba(239,68,68,0.2))] bg-[var(--color-bad-subtle,rgba(239,68,68,0.05))] p-3 text-xs text-[var(--color-bad,#ef4444)]">
            {errorMessage}
          </div>
        )}

        {successMessage && (
          <div className="mt-4 rounded-md border border-[var(--color-ok-subtle,rgba(16,185,129,0.2))] bg-[var(--color-ok-subtle,rgba(16,185,129,0.05))] p-3 text-xs text-[var(--color-ok,#10b981)]">
            {successMessage}
          </div>
        )}

        {isLoading ? (
          <div className="flex justify-center py-12">
            <div className="size-6 animate-spin rounded-full border-2 border-[var(--color-ink-muted)] border-t-transparent" />
          </div>
        ) : error ? (
          <div className="p-6 text-center text-xs text-[var(--color-bad,#ef4444)]">
            Failed to load circuit policy. {error instanceof Error ? error.message : ''}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-4 flex-1 overflow-y-auto space-y-4 pr-1">
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <label
                  htmlFor="circuit-window-ms"
                  className="block font-medium text-[var(--color-ink)]"
                >
                  Sliding Window (ms)
                </label>
                <input
                  id="circuit-window-ms"
                  type="number"
                  min={B.windowMs.min}
                  max={B.windowMs.max}
                  value={windowMs}
                  onChange={(e) => setWindowMs(Number(e.target.value))}
                  disabled={isSubmitting}
                  className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-mono text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-hidden"
                  required
                />
                <span className="text-[10px] text-[var(--color-ink-muted)]">
                  {B.windowMs.min} – {B.windowMs.max} ms
                </span>
              </div>

              <div>
                <label
                  htmlFor="circuit-window-max-samples"
                  className="block font-medium text-[var(--color-ink)]"
                >
                  Max Samples in Window
                </label>
                <input
                  id="circuit-window-max-samples"
                  type="number"
                  min={B.windowMaxSamples.min}
                  max={B.windowMaxSamples.max}
                  value={windowMaxSamples}
                  onChange={(e) => setWindowMaxSamples(Number(e.target.value))}
                  disabled={isSubmitting}
                  className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-mono text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-hidden"
                  required
                />
                <span className="text-[10px] text-[var(--color-ink-muted)]">
                  {B.windowMaxSamples.min} – {B.windowMaxSamples.max}
                </span>
              </div>

              <div>
                <label
                  htmlFor="circuit-min-samples"
                  className="block font-medium text-[var(--color-ink)]"
                >
                  Minimum Samples to Evaluate
                </label>
                <input
                  id="circuit-min-samples"
                  type="number"
                  min={B.minSamples.min}
                  max={B.minSamples.max}
                  value={minSamples}
                  onChange={(e) => setMinSamples(Number(e.target.value))}
                  disabled={isSubmitting}
                  className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-mono text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-hidden"
                  required
                />
                <span className="text-[10px] text-[var(--color-ink-muted)]">
                  Must be ≤ Max Samples ({minSamples <= windowMaxSamples ? 'valid' : 'invalid'})
                </span>
              </div>

              <div>
                <label
                  htmlFor="circuit-failure-percent"
                  className="block font-medium text-[var(--color-ink)]"
                >
                  Failure Threshold (%)
                </label>
                <input
                  id="circuit-failure-percent"
                  type="number"
                  min={B.failurePercent.min}
                  max={B.failurePercent.max}
                  value={failurePercent}
                  onChange={(e) => setFailurePercent(Number(e.target.value))}
                  disabled={isSubmitting}
                  className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-mono text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-hidden"
                  required
                />
                <span className="text-[10px] text-[var(--color-ink-muted)]">
                  {B.failurePercent.min} – {B.failurePercent.max} %
                </span>
              </div>

              <div>
                <label
                  htmlFor="circuit-cooldown-ms"
                  className="block font-medium text-[var(--color-ink)]"
                >
                  Cooldown Duration (ms)
                </label>
                <input
                  id="circuit-cooldown-ms"
                  type="number"
                  min={B.cooldownMs.min}
                  max={B.cooldownMs.max}
                  value={cooldownMs}
                  onChange={(e) => setCooldownMs(Number(e.target.value))}
                  disabled={isSubmitting}
                  className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-mono text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-hidden"
                  required
                />
                <span className="text-[10px] text-[var(--color-ink-muted)]">
                  Time in open before half-open ({B.cooldownMs.min} – {B.cooldownMs.max} ms)
                </span>
              </div>

              <div>
                <label
                  htmlFor="circuit-half-open-max-probes"
                  className="block font-medium text-[var(--color-ink)]"
                >
                  Half-Open Max Probes
                </label>
                <input
                  id="circuit-half-open-max-probes"
                  type="number"
                  min={B.halfOpenMaxProbes.min}
                  max={B.halfOpenMaxProbes.max}
                  value={halfOpenMaxProbes}
                  onChange={(e) => setHalfOpenMaxProbes(Number(e.target.value))}
                  disabled={isSubmitting}
                  className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-mono text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-hidden"
                  required
                />
                <span className="text-[10px] text-[var(--color-ink-muted)]">
                  {B.halfOpenMaxProbes.min} – {B.halfOpenMaxProbes.max} concurrent probes
                </span>
              </div>

              <div>
                <label
                  htmlFor="circuit-probe-lease-ms"
                  className="block font-medium text-[var(--color-ink)]"
                >
                  Probe Lease Timeout (ms)
                </label>
                <input
                  id="circuit-probe-lease-ms"
                  type="number"
                  min={B.probeLeaseMs.min}
                  max={B.probeLeaseMs.max}
                  value={probeLeaseMs}
                  onChange={(e) => setProbeLeaseMs(Number(e.target.value))}
                  disabled={isSubmitting}
                  className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-mono text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-hidden"
                  required
                />
                <span className="text-[10px] text-[var(--color-ink-muted)]">
                  {B.probeLeaseMs.min} – {B.probeLeaseMs.max} ms
                </span>
              </div>

              <div>
                <label
                  htmlFor="circuit-half-open-successes"
                  className="block font-medium text-[var(--color-ink)]"
                >
                  Successes to Close Circuit
                </label>
                <input
                  id="circuit-half-open-successes"
                  type="number"
                  min={B.halfOpenSuccessesToClose.min}
                  max={B.halfOpenSuccessesToClose.max}
                  value={halfOpenSuccessesToClose}
                  onChange={(e) => setHalfOpenSuccessesToClose(Number(e.target.value))}
                  disabled={isSubmitting}
                  className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-mono text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-hidden"
                  required
                />
                <span className="text-[10px] text-[var(--color-ink-muted)]">
                  Consecutive successes to close ({B.halfOpenSuccessesToClose.min} – {B.halfOpenSuccessesToClose.max})
                </span>
              </div>
            </div>

            <div className="flex justify-between items-center pt-4 border-t border-[var(--color-border-subtle)]">
              <button
                type="button"
                onClick={() => void refetch()}
                disabled={isFetching || isSubmitting}
                className="text-xs text-[var(--color-ink-muted)] hover:underline"
              >
                {isFetching ? 'Refreshing…' : 'Reload latest'}
              </button>

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  disabled={isSubmitting}
                  className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || minSamples > windowMaxSamples}
                  className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {isSubmitting ? 'Saving…' : 'Save Policy'}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
