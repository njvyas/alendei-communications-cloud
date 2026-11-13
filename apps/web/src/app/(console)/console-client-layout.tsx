'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';

import { authApi } from '@/lib/api-client';
import { useCanReadPlatformDomains } from '@/lib/platform-domains';
import {
  bootstrapSession,
  useCanAccessPlatformSupport,
  useCanReadCampaigns,
  useCanReadJourneys,
  useCanReadOrganizations,
  useCanReadProviders,
  useCanReadResellers,
  useCanReadSuppressions,
  useHasPermission,
  useSession,
} from '@/lib/session-store';
import { OrgSelectionView } from '@/components/org-selection-view';
import { SessionBadge } from '@/components/session-badge';
import { ZeroOrgView } from '@/components/zero-org-view';
import { EnvironmentBadge } from '@/components/ui/environment-badge';
import { ToastContainer } from '@/components/ui/toast';
import {
  Sidebar,
  Header,
  BreadcrumbBar,
  CommandPalette,
  MobileNav,
  type NavVisibilityContext,
} from '@/components/shell';
import ConsoleLoading from './loading';

/**
 * Modern Application Shell & Navigation (U15.2 Client Boundary).
 *
 * Implements protected-route invariant:
 * - Unauthenticated users are redirected to `/login` without flashing protected content.
 * - Authenticated users with zero organizations see an explicit access empty state, unless viewing /organizations or platform catalogue with appropriate read permissions.
 * - Authenticated users with multiple organizations must select an organization before accessing console views.
 * - Active organization is exposed in the shell header with switching capability.
 * - Navigation links are strictly capability-gated: visual visibility does not confer authority.
 * - Initial sidebar collapsed state is supplied via SSR prop to prevent post-mount layout shift.
 */
const SECTIONS = [
  { href: '/', label: 'Overview' },
  { href: '/messages', label: 'Messages' },
  { href: '/usage', label: 'Usage' },
  { href: '/whatsapp', label: 'WhatsApp' },
  { href: '/templates', label: 'Templates' },
  { href: '/campaigns', label: 'Campaigns' },
  { href: '/contacts', label: 'Contacts' },
  { href: '/suppressions', label: 'Suppressions' },
  { href: '/channels', label: 'Channels' },
  { href: '/providers', label: 'Providers' },
  { href: '/resellers', label: 'Resellers' },
  { href: '/organizations', label: 'Organizations' },
  { href: '/domains', label: 'Domains' },
  { href: '/workspaces', label: 'Workspaces' },
  { href: '/teams', label: 'Teams' },
  { href: '/users', label: 'Users' },
  { href: '/roles', label: 'Roles' },
  { href: '/api-keys', label: 'API Keys' },
  { href: '/audit-logs', label: 'Audit Logs' },
  { href: '/support', label: 'Support & Ops' },
] as const;

export interface ConsoleClientLayoutProps {
  readonly children?: ReactNode;
  readonly initialCollapsed?: boolean;
}

export function ConsoleClientLayout({
  children,
  initialCollapsed = false,
}: ConsoleClientLayoutProps) {
  const router = useRouter();
  const pathname = usePathname();
  const status = useSession((state) => state.status);
  const user = useSession((state) => state.user);
  const clearSession = useSession((state) => state.clearSession);

  const canReadOrganizations = useCanReadOrganizations();
  const canReadProviders = useCanReadProviders();
  const canReadPlatformDomains = useCanReadPlatformDomains();
  const canReadResellers = useCanReadResellers();
  const canReadSuppressions = useCanReadSuppressions();
  const canReadUsers = useHasPermission('users.read');
  const canReadWorkspaces = useHasPermission('workspaces.read');
  const canReadTeams = useHasPermission('teams.read');
  const canReadRoles = useHasPermission('roles.read');
  const canReadApiKeys = useHasPermission('api_keys.read');
  const canReadAudit = useHasPermission('audit.read');
  const canReadTemplates = useHasPermission('templates.read');
  const canReadCampaigns = useCanReadCampaigns();
  const canReadJourneys = useCanReadJourneys();
  const canReadContacts = useHasPermission('contacts.read');
  const canReadMessages = useHasPermission('messages.read');
  const canSendMessages = useHasPermission('messages.send');
  const canAccessSupport = useCanAccessPlatformSupport();

  const isSectionVisible = (href: string) => {
    if (status === 'zero_organizations') {
      switch (href) {
        case '/organizations':
          return canReadOrganizations;
        case '/domains':
          return canReadPlatformDomains;
        case '/channels':
        case '/providers':
          return canReadProviders;
        case '/resellers':
          return canReadResellers;
        case '/support':
          return canAccessSupport;
        default:
          return false;
      }
    }

    switch (href) {
      case '/messages':
      case '/usage':
        return canReadMessages;
      case '/whatsapp':
        return canReadMessages || canSendMessages;
      case '/templates':
        return canReadTemplates;
      case '/campaigns':
        return canReadCampaigns;
      case '/journeys':
        return canReadJourneys;
      case '/contacts':
        return canReadContacts;
      case '/suppressions':
        return canReadSuppressions;
      case '/channels':
      case '/providers':
        return canReadProviders;
      case '/resellers':
        return canReadResellers;
      case '/organizations':
        return canReadOrganizations;
      case '/domains':
        return canReadPlatformDomains;
      case '/workspaces':
        return canReadWorkspaces;
      case '/teams':
        return canReadTeams;
      case '/users':
        return canReadUsers;
      case '/roles':
        return canReadRoles;
      case '/api-keys':
        return canReadApiKeys;
      case '/audit-logs':
        return canReadAudit;
      case '/support':
        return canAccessSupport;
      default:
        return true;
    }
  };

  void SECTIONS;
  void isSectionVisible;

  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);

  const isNavigatingOrganizations =
    pathname === '/organizations' || pathname.startsWith('/organizations/');
  const isNavigatingDomains = pathname === '/domains' || pathname.startsWith('/domains/');
  const isNavigatingCatalogue =
    pathname === '/channels' ||
    pathname.startsWith('/channels/') ||
    pathname === '/providers' ||
    pathname.startsWith('/providers/');
  const isNavigatingResellers = pathname === '/resellers' || pathname.startsWith('/resellers/');
  const isNavigatingSupport = pathname === '/support' || pathname.startsWith('/support/');

  useEffect(() => {
    if (status === 'idle') {
      void bootstrapSession();
    } else if (status === 'unauthenticated') {
      router.replace('/login');
    }
  }, [status, router]);

  // Global shortcut for Command Palette: Cmd+K / Ctrl+K
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setIsCommandPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSignOut = async () => {
    try {
      await authApi.logout();
    } finally {
      clearSession();
      router.replace('/login');
    }
  };

  const navContext: NavVisibilityContext = {
    status,
    canReadMessages,
    canSendMessages,
    canReadTemplates,
    canReadCampaigns,
    canReadJourneys,
    canReadContacts,
    canReadSuppressions,
    canReadProviders,
    canReadResellers,
    canReadOrganizations,
    canReadPlatformDomains,
    canReadWorkspaces,
    canReadTeams,
    canReadUsers,
    canReadRoles,
    canReadApiKeys,
    canReadAudit,
    canAccessSupport,
  };

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
    const isPermittedNavigation =
      (isNavigatingOrganizations && canReadOrganizations) ||
      (isNavigatingCatalogue && canReadProviders) ||
      (isNavigatingDomains && canReadPlatformDomains) ||
      (isNavigatingResellers && canReadResellers) ||
      (isNavigatingSupport && canAccessSupport);
    if (!isPermittedNavigation) {
      return (
        <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 py-6 sm:px-6">
          <header className="flex flex-wrap items-center justify-between gap-4 border-b border-acc-border pb-4">
            <div>
              <p className="text-sm font-semibold tracking-tight text-acc-text-primary">
                Alendei Communications Cloud
              </p>
              <p className="text-xs text-acc-text-secondary">Control plane</p>
            </div>
            <div className="flex flex-wrap items-center gap-3 sm:gap-4">
              <SessionBadge />
              {user?.userId && (
                <span className="hidden font-mono text-xs text-acc-text-secondary sm:inline">
                  {user.email ?? `${user.userId.slice(0, 8)}…`}
                </span>
              )}
            </div>
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
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-acc-border pb-4">
          <div>
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold tracking-tight text-acc-text-primary">
                Alendei Communications Cloud
              </p>
              <EnvironmentBadge />
            </div>
            <p className="text-xs text-acc-text-secondary">Control plane</p>
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:gap-4">
            <SessionBadge />
            {user?.userId && (
              <span className="hidden font-mono text-xs text-acc-text-secondary sm:inline">
                {user.email ?? `${user.userId.slice(0, 8)}…`}
              </span>
            )}
          </div>
        </header>
        <OrgSelectionView />
        <ToastContainer />
      </div>
    );
  }

  // 5. Authenticated and ready with valid organization context (or permitted zero-org navigation)
  return (
    <div className="flex min-h-dvh w-full bg-acc-bg text-acc-text-primary">
      {/* Persistent Collapsible Application Sidebar (Desktop) */}
      <Sidebar
        navContext={navContext}
        defaultCollapsed={initialCollapsed}
        className="hidden md:flex"
      />

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Universal Application Header */}
        <Header
          user={user}
          onOpenMobileNav={() => setIsMobileNavOpen(true)}
          onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
          onSignOut={handleSignOut}
        />

        {/* Universal Breadcrumbs */}
        <BreadcrumbBar status={status} />

        {/* Interior Page Container */}
        <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
          {status === 'idle' || status === 'authenticating' ? (
            <div className="mt-8 flex justify-center">
              <ConsoleLoading />
            </div>
          ) : (
            children
          )}
        </main>
      </div>

      {/* Mobile Navigation Drawer */}
      <MobileNav
        isOpen={isMobileNavOpen}
        onClose={() => setIsMobileNavOpen(false)}
        navContext={navContext}
      />

      {/* Global Search & Command Palette */}
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        navContext={navContext}
        onSignOut={handleSignOut}
      />

      <ToastContainer />
    </div>
  );
}
