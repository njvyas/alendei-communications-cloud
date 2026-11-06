'use client';

import { cn } from '@/lib/cn';
import type { UserIdentity } from '@/lib/api-client';
import { OrgSwitcher } from '@/components/org-switcher';
import { SessionBadge } from '@/components/session-badge';
import { EnvironmentBadge } from '@/components/ui/environment-badge';
import { ThemePreferenceControl } from '@/components/ui/theme-preference-control';
import { IconMenu, IconSearch } from './icons';

export interface HeaderProps {
  readonly user?: UserIdentity | null;
  readonly onOpenMobileNav: () => void;
  readonly onOpenCommandPalette: () => void;
  readonly onSignOut: () => void;
  readonly className?: string;
}

export function Header({
  user,
  onOpenMobileNav,
  onOpenCommandPalette,
  onSignOut,
  className,
}: HeaderProps) {
  return (
    <header
      className={cn(
        'sticky top-0 z-30 flex h-16 w-full items-center justify-between border-b border-acc-border bg-acc-card px-4 sm:px-6',
        className,
      )}
    >
      {/* Left Area: Mobile hamburger & Command Palette trigger */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onOpenMobileNav}
          aria-label="Open navigation menu"
          className="flex items-center justify-center rounded-md p-1.5 text-acc-text-secondary hover:bg-acc-surface-raised hover:text-acc-text-primary md:hidden"
        >
          <IconMenu className="size-5" />
        </button>

        {/* Global Search / Command Palette trigger */}
        <button
          type="button"
          onClick={onOpenCommandPalette}
          aria-label="Search or jump to command"
          className="flex items-center gap-2 rounded-lg border border-acc-border bg-acc-bg px-3 py-1.5 text-xs text-acc-text-secondary transition-colors hover:border-acc-primary hover:text-acc-text-primary"
        >
          <IconSearch className="size-3.5 text-acc-text-muted" />
          <span className="hidden sm:inline">Search or jump to...</span>
          <span className="sm:hidden">Search</span>
          <kbd className="hidden sm:inline-block rounded border border-acc-border bg-acc-card px-1.5 py-0.5 font-mono text-[10px] text-acc-text-muted">
            ⌘K
          </kbd>
        </button>
      </div>

      {/* Right Area: OrgSwitcher, Session, Theme, User Pill, Sign Out */}
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <OrgSwitcher />
        <EnvironmentBadge />
        <SessionBadge />
        <ThemePreferenceControl className="hidden lg:inline-flex" />

        {user?.userId && (
          <span className="hidden font-mono text-xs text-acc-text-secondary xl:inline">
            {user.email ?? `${user.userId.slice(0, 8)}…`}
          </span>
        )}

        <button
          type="button"
          onClick={onSignOut}
          className="rounded-md border border-acc-border px-2.5 py-1 text-xs text-acc-text-secondary hover:bg-acc-surface-raised hover:text-acc-text-primary transition-colors focus-visible:outline-2 focus-visible:outline-acc-primary"
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
