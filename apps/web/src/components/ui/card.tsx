import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

export function Card({
  className,
  children,
  ...props
}: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        'rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-5',
        className,
      )}
      {...props}
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

/*
 * U15.1 additions (layout only, so they compose with the existing Card and with
 * pages that later move to the `--acc-*` tokens). Card, CardTitle and
 * CardDescription above are unchanged: production pages use them.
 */
export function CardHeader({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('flex flex-col gap-1', className)}>{children}</div>;
}

export function CardContent({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('mt-4', className)}>{children}</div>;
}

export function CardFooter({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('mt-4 flex items-center justify-end gap-2', className)}>{children}</div>
  );
}
