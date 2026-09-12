'use client';

import { Card, CardDescription, CardTitle } from '@/components/ui/card';

export default function ConsoleError({ reset }: { error: Error; reset: () => void }) {
  return (
    <Card>
      <CardTitle>Something went wrong</CardTitle>
      <CardDescription>
        The console could not render this section. Retrying is safe.
      </CardDescription>
      <button
        type="button"
        onClick={reset}
        className="mt-4 rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-sm"
      >
        Try again
      </button>
    </Card>
  );
}
