'use client';

import { useQuery } from '@tanstack/react-query';

import { fetchHealth, type HealthResponse } from '@/lib/api-client';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';
import { StatusDot, type StatusTone } from '@/components/ui/status-dot';

/**
 * Reads the API's readiness endpoint. It exists mainly to prove the console's
 * data path end to end — client, error state and loading state — against the
 * only endpoint Phase 1 exposes.
 */
export function PlatformStatus() {
  const { data, error, isPending, isError } = useQuery<HealthResponse>({
    queryKey: ['health'],
    queryFn: ({ signal }) => fetchHealth(signal),
    refetchInterval: 15_000,
  });

  if (isPending) {
    return (
      <Card>
        <CardTitle>Platform status</CardTitle>
        <CardDescription>Checking…</CardDescription>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardTitle>Platform status</CardTitle>
        <CardDescription>
          The API is unreachable. Start it with <code>npm run dev -w @acc/api</code>.
        </CardDescription>
        <p className="mt-3 text-xs text-[var(--color-ink-muted)]">
          {error instanceof Error ? error.message : 'Unknown error'}
        </p>
      </Card>
    );
  }

  const components = Object.entries({ ...data.info, ...data.error });

  return (
    <Card>
      <CardTitle>Platform status</CardTitle>
      <CardDescription>Readiness of the Phase 1 dependencies.</CardDescription>
      <ul className="mt-4 space-y-2">
        {components.map(([name, detail]) => (
          <li key={name} className="flex items-center justify-between">
            <StatusDot tone={toneFor(detail.status)} label={name} />
            <span className="text-xs text-[var(--color-ink-muted)]">{detail.status}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function toneFor(status: string): StatusTone {
  if (status === 'up') return 'ok';
  if (status === 'down') return 'bad';
  return 'unknown';
}
