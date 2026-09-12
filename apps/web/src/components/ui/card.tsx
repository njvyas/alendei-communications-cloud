import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section
      className={cn(
        'rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-5',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <h2 className="text-sm font-semibold tracking-tight">{children}</h2>;
}

export function CardDescription({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-sm text-[var(--color-ink-muted)]">{children}</p>;
}
