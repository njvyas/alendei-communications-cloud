'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { authApi } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { bootstrapSession, useCanReadOrganizations, useSession } from '@/lib/session-store';
import { OrgSelectionView } from '@/components/org-selection-view';
import { OrgSwitcher } from '@/components/org-switcher';
import { SessionBadge } from '@/components/session-badge';
import { ZeroOrgView } from '@/components/zero-org-view';
import ConsoleLoading from './loading';

/**
 * Authentication-aware console shell.
 *
 * Implements protected-route invariant:
 * - Unauthenticated users are redirected to `/login` without flashing protected content.
 * - Authenticated users with zero organizations see an explicit access empty state, unless viewing /organizations with appropriate read permissions.
 * - Authenticated users with multiple organizations must select an organization before accessing console views.
 * - Active organization is exposed in the shell header with switching capability.
 */
const SECTIONS = [
  { href: '/', label: 'Overview' },
  { href: '/organizations', label: 'Organizations' },
  { href: '/workspaces', label: 'Workspaces' },
  { href: '/teams', label: 'Teams' },
  { href: '/users', label: 'Users' },
  { href: '/roles', label: 'Roles' },
  { href: '/api-keys', label: 'API Keys' },
  { href: '/audit-logs', label: 'Audit Logs' },
] as const;

export default function ConsoleLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const status = useSession((state) => state.status);
  const user = useSession((state) => state.user);
  const clearSession = useSession((state) => state.clearSession);
  const canReadOrganizations = useCanReadOrganizations();
  const isNavigatingOrganizations =
    pathname === '/organizations' || pathname.startsWith('/organizations/');

  useEffect(() => {
    if (status === 'idle') {
      void bootstrapSession();
    } else if (status === 'unauthenticated') {
      router.replace('/login');
    }
  }, [status, router]);

  const handleSignOut = async () => {
    try {
      await authApi.logout();
    } finally {
      clearSession();
      router.replace('/login');
    }
  };

  // 1. Initial authentication loading state (flash prevention)
  if (status === 'idle' || status === 'authenticating') {
    return (
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-border-subtle)] pb-4">
          <div>
            <p className="text-sm font-semibold tracking-tight">Alendei Communications Cloud</p>
            <p className="text-xs text-[var(--color-ink-muted)]">Control plane</p>
          </div>
          <SessionBadge />
        </header>
        <div className="mt-8 flex justify-center">
          <ConsoleLoading />
        </div>
      </div>
    );
  }

  // 2. Unauthenticated: Redirecting to login
  if (status === 'unauthenticated') {
    return (
      <div className="mx-auto flex min-h-dvh max-w-6xl items-center justify-center px-4">
        <ConsoleLoading />
      </div>
    );
  }

  // 3. Authenticated, but holding zero authorized organizations
  if (status === 'zero_organizations') {
    if (!isNavigatingOrganizations || !canReadOrganizations) {
      return (
        <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 py-6 sm:px-6">
          <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-border-subtle)] pb-4">
            <div>
              <p className="text-sm font-semibold tracking-tight">Alendei Communications Cloud</p>
              <p className="text-xs text-[var(--color-ink-muted)]">Control plane</p>
            </div>
            <SessionBadge />
          </header>
          <ZeroOrgView />
        </div>
      );
    }
  }

  // 4. Authenticated, multiple organizations requiring selection
  if (status === 'selecting_organization') {
    return (
      <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-border-subtle)] pb-4">
          <div>
            <p className="text-sm font-semibold tracking-tight">Alendei Communications Cloud</p>
            <p className="text-xs text-[var(--color-ink-muted)]">Control plane</p>
          </div>
          <SessionBadge />
        </header>
        <OrgSelectionView />
      </div>
    );
  }

  // 5. Authenticated and ready with valid organization context
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl flex-col px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-border-subtle)] pb-4">
        <div>
          <p className="text-sm font-semibold tracking-tight">Alendei Communications Cloud</p>
          <p className="text-xs text-[var(--color-ink-muted)]">Control plane</p>
        </div>

        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          <OrgSwitcher />
          <SessionBadge />
          {user?.userId && (
            <span className="hidden font-mono text-xs text-[var(--color-ink-muted)] sm:inline">
              {user.userId.slice(0, 8)}…
            </span>
          )}
          <button
            type="button"
            onClick={handleSignOut}
            className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]"
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-6 pt-6 md:flex-row">
        <nav aria-label="Sections" className="md:w-44 md:shrink-0">
          <ul className="flex flex-wrap gap-1 md:flex-col">
            {SECTIONS.map((section) => {
              const isActive =
                section.href === '/'
                  ? pathname === '/'
                  : pathname === section.href || pathname.startsWith(`${section.href}/`);
              return (
                <li key={section.href}>
                  <Link
                    href={section.href}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'block rounded-md px-3 py-1.5 text-sm transition-colors',
                      isActive
                        ? 'border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] font-medium text-[var(--color-ink)] shadow-xs'
                        : 'text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)]',
                    )}
                  >
                    {section.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
