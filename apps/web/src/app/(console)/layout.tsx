import Link from 'next/link';
import type { ReactNode } from 'react';

import { SessionBadge } from '@/components/session-badge';

/**
 * Authentication-aware console shell.
 *
 * Only routes that actually exist are listed: `typedRoutes` is on, so a link to
 * an unbuilt section is a compile error rather than a dead link. Tenant, user
 * and role sections join this list in the phase that implements them.
 */
const SECTIONS = [{ href: '/', label: 'Overview' }] as const;

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-border-subtle)] pb-4">
        <div>
          <p className="text-sm font-semibold tracking-tight">Alendei Communications Cloud</p>
          <p className="text-xs text-[var(--color-ink-muted)]">Control plane</p>
        </div>
        <SessionBadge />
      </header>

      <div className="flex flex-1 flex-col gap-6 pt-6 md:flex-row">
        <nav aria-label="Sections" className="md:w-44 md:shrink-0">
          <ul className="flex flex-wrap gap-1 md:flex-col">
            {SECTIONS.map((section) => (
              <li key={section.href}>
                <Link
                  href={section.href}
                  className="block rounded-md px-3 py-1.5 text-sm text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
                >
                  {section.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
