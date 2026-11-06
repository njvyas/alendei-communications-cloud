import { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import {
  Sidebar,
  Header,
  BreadcrumbBar,
  CommandPalette,
  MobileNav,
  type NavVisibilityContext,
} from '../../src/components/shell';
import { startThemeSync } from '../../src/lib/theme-store';

function ShellHarness() {
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  const log = (msg: string) => setLogs((prev) => [...prev, msg]);

  // Global shortcut for Command Palette: Cmd+K / Ctrl+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setIsCommandPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const navContext: NavVisibilityContext = {
    status: 'ready',
    canReadMessages: true,
    canSendMessages: true,
    canReadTemplates: true,
    canReadContacts: true,
    canReadSuppressions: true,
    canReadProviders: true,
    canReadResellers: true,
    canReadOrganizations: true,
    canReadPlatformDomains: true,
    canReadWorkspaces: true,
    canReadTeams: true,
    canReadUsers: true,
    canReadRoles: true,
    canReadApiKeys: true,
    canReadAudit: true,
    canAccessSupport: true,
  };

  const mockUser = {
    userId: '01955b0a-7b3b-7411-9a4f-testuser1111',
    actorType: 'user' as const,
    authMethod: 'session' as const,
    sessionId: 'session-123',
    authenticatedAt: '2026-11-06T00:00:00.000Z',
    tenant: {
      orgId: null,
      workspaceId: null,
      resellerId: null,
      isPlatformAdmin: false,
    },
    authorizedOrganizationIds: ['01955b0a-7b3b-7411-9a4f-orgAAAAAAAAAA'],
    roles: [],
    permissions: [],
    email: 'admin@alendei.com',
  };

  return (
    <div className="flex min-h-dvh w-full bg-acc-bg text-acc-text-primary font-sans" id="shell-container">
      {/* Sidebar */}
      <Sidebar
        navContext={navContext}
        defaultCollapsed={collapsed}
        onCollapsedChange={setCollapsed}
        className="hidden md:flex"
      />

      {/* Main Content Area */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <Header
          user={mockUser}
          onOpenMobileNav={() => setIsMobileNavOpen(true)}
          onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
          onSignOut={() => log('sign-out')}
        />

        {/* Breadcrumbs */}
        <BreadcrumbBar status="ready" />

        {/* Page Area */}
        <main className="min-w-0 flex-1 p-6" id="main-content">
          <div className="rounded-xl border border-acc-border bg-acc-card p-6 shadow-xs">
            <h1 className="text-xl font-bold tracking-tight text-acc-text-primary">Console Content</h1>
            <p className="mt-2 text-sm text-acc-text-secondary">
              Active shell state: {collapsed ? 'collapsed' : 'expanded'}
            </p>
            <div className="mt-4 flex gap-3">
              <button
                type="button"
                id="btn-open-cmd"
                onClick={() => setIsCommandPaletteOpen(true)}
                className="rounded-md bg-acc-primary px-3 py-1.5 text-xs font-medium text-acc-on-primary"
              >
                Open Command Palette
              </button>
            </div>
            <div id="test-logs" className="mt-4 font-mono text-xs text-acc-text-muted">
              {logs.join('|')}
            </div>
          </div>
        </main>
      </div>

      {/* Mobile Nav Drawer */}
      <MobileNav
        isOpen={isMobileNavOpen}
        onClose={() => setIsMobileNavOpen(false)}
        navContext={navContext}
      />

      {/* Command Palette */}
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        navContext={navContext}
        onSignOut={() => log('sign-out')}
      />
    </div>
  );
}

startThemeSync();
createRoot(document.getElementById('root')!).render(<ShellHarness />);
