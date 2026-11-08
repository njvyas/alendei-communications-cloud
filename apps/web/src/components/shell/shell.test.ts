import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

import {
  Sidebar,
  type SidebarProps,
  SIDEBAR_COOKIE_NAME,
  SIDEBAR_COOKIE_MAX_AGE,
  parseSidebarCollapsedCookie,
  readSidebarCollapsedCookie,
  sidebarCookie,
  writeSidebarCollapsedCookie,
  serverSidebarCollapsed,
} from './sidebar';
import ConsoleLayout from '@/app/(console)/layout';
import { ConsoleClientLayout } from '@/app/(console)/console-client-layout';
import { CommandPalette } from './command-palette';
import { MobileNav } from './mobile-nav';
import { BreadcrumbBar } from './breadcrumb-bar';
import type { NavVisibilityContext } from './types';
import { useSession } from '@/lib/session-store';

(globalThis as unknown as { React: typeof React }).React = React;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

describe('U15.2 Shell & Global Navigation (Unit & Accessibility Tests)', () => {
  const mockRouter = {
    push: () => {},
    replace: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  };

  const createNavContext = (
    overrides: Partial<NavVisibilityContext> = {},
  ): NavVisibilityContext => ({
    status: 'ready',
    canReadMessages: true,
    canSendMessages: true,
    canReadTemplates: true,
    canReadCampaigns: true,
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
    ...overrides,
  });

  const renderWithRouter = (element: React.ReactElement, pathname = '/') =>
    renderToStaticMarkup(
      React.createElement(
        AppRouterContext.Provider,
        {
          value: mockRouter as unknown as React.ComponentProps<
            typeof AppRouterContext.Provider
          >['value'],
        },
        React.createElement(PathnameContext.Provider, { value: pathname }, element),
      ),
    );

  // =========================================================================
  // 1. Sidebar Component Tests
  // =========================================================================
  describe('Sidebar Component', () => {
    it('renders expanded width (w-60) by default with brand title and section headers', () => {
      const html = renderWithRouter(
        React.createElement(Sidebar, { navContext: createNavContext() }),
        '/',
      );

      assert.ok(html.includes('w-60'), 'Must render expanded width class');
      assert.ok(html.includes('Alendei'), 'Must display brand name');
      assert.ok(html.includes('Control plane'), 'Must display subtitle');
      assert.ok(html.includes('aria-label="Sections"'), 'Must render Sections navigation');
      assert.ok(html.includes('Collapse sidebar'), 'Must have collapse toggle button');
      assert.ok(html.includes('Operations'), 'Must display section header');
      assert.ok(html.includes('Administration'), 'Must display admin section header');
    });

    it('renders collapsed mini-rail (w-16) when defaultCollapsed is true', () => {
      const html = renderWithRouter(
        React.createElement(Sidebar, {
          navContext: createNavContext(),
          defaultCollapsed: true,
        }),
        '/',
      );

      assert.ok(html.includes('w-16'), 'Must render collapsed width class');
      assert.ok(html.includes('ACC'), 'Must display compact brand monogram');
      assert.ok(html.includes('Expand sidebar'), 'Must have expand toggle button');
      // When collapsed, link title attributes provide accessible tooltips
      assert.ok(html.includes('title="Overview"'), 'Must have title tooltip on link');
      assert.ok(html.includes('title="Messages"'), 'Must have title tooltip on link');
    });

    it('sets aria-current="page" on the active route', () => {
      const html = renderWithRouter(
        React.createElement(Sidebar, { navContext: createNavContext() }),
        '/messages',
      );

      assert.match(
        html,
        /<a[^>]*href="\/messages"[^>]*aria-current="page"|<a[^>]*aria-current="page"[^>]*href="\/messages"/,
        'Active route link must have aria-current="page"',
      );
      assert.doesNotMatch(
        html,
        /<a[^>]*href="\/templates"[^>]*aria-current="page"|<a[^>]*aria-current="page"[^>]*href="\/templates"/,
        'Inactive route must not have aria-current="page"',
      );
    });

    it('preserves exact canonical order across all navigation groups', () => {
      const html = renderWithRouter(
        React.createElement(Sidebar, { navContext: createNavContext() }),
        '/',
      );

      const expectedSequence = [
        'href="/"',
        'href="/messages"',
        'href="/usage"',
        'href="/whatsapp"',
        'href="/templates"',
        'href="/contacts"',
        'href="/suppressions"',
        'href="/channels"',
        'href="/providers"',
        'href="/resellers"',
        'href="/organizations"',
        'href="/domains"',
        'href="/workspaces"',
        'href="/teams"',
        'href="/users"',
        'href="/roles"',
        'href="/api-keys"',
        'href="/audit-logs"',
        'href="/support"',
      ];

      let lastIndex = -1;
      for (const href of expectedSequence) {
        const idx = html.indexOf(href);
        assert.ok(idx > -1, `Expected link ${href} to be present`);
        assert.ok(
          idx > lastIndex,
          `Expected ${href} to appear after preceding link in canonical sequence`,
        );
        lastIndex = idx;
      }
    });

    it('dynamically hides unauthorized navigation links based on navContext', () => {
      const ctx = createNavContext({
        canReadMessages: false,
        canSendMessages: false,
        canReadTemplates: false,
        canReadUsers: false,
        canReadRoles: false,
      });

      const html = renderWithRouter(React.createElement(Sidebar, { navContext: ctx }), '/');

      assert.ok(!html.includes('href="/messages"'), 'Messages must be hidden');
      assert.ok(!html.includes('href="/whatsapp"'), 'WhatsApp must be hidden');
      assert.ok(!html.includes('href="/templates"'), 'Templates must be hidden');
      assert.ok(!html.includes('href="/users"'), 'Users must be hidden');
      assert.ok(!html.includes('href="/roles"'), 'Roles must be hidden');

      // Still visible: authorized sections
      assert.ok(html.includes('href="/"'), 'Overview must remain visible');
      assert.ok(html.includes('href="/workspaces"'), 'Workspaces must remain visible');
    });

    it('guarantees WCAG 2.2 AA accessible names and discernible text for all collapsed links, brand header, and toggle', () => {
      const html = renderWithRouter(
        React.createElement(Sidebar, {
          navContext: createNavContext(),
          defaultCollapsed: true,
        }),
        '/',
      );

      // 1. Brand header in collapsed mode
      assert.ok(
        html.includes('aria-label="Alendei Communications Cloud"'),
        'Brand header in collapsed state must have explicit aria-label',
      );
      assert.ok(
        html.includes('Alendei Communications Cloud</span>'),
        'Brand header in collapsed state must have visually hidden accessible text for screen readers',
      );
      assert.ok(
        html.includes('aria-hidden="true">ACC</span>'),
        'Visual monogram must have aria-hidden to prevent redundant or confusing reading',
      );

      // 2. Navigation items
      const expectedItems = [
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
      ];

      for (const item of expectedItems) {
        const escapedLabel = item.label.replace(/&/g, '&amp;');
        // Must have aria-label on link
        assert.ok(
          html.includes(`aria-label="${escapedLabel}"`),
          `Collapsed link for ${item.label} must have aria-label="${escapedLabel}"`,
        );
        // Must have discernible text node inside the link (via sr-only span)
        assert.ok(
          html.includes(`class="sr-only">${escapedLabel}</span>`),
          `Collapsed link for ${item.label} must have <span class="sr-only">${escapedLabel}</span>`,
        );
        // Must maintain hover tooltip via title
        assert.ok(
          html.includes(`title="${escapedLabel}"`),
          `Collapsed link for ${item.label} must have title="${escapedLabel}" for hover tooltip`,
        );
      }

      // 3. Toggle button in collapsed mode
      assert.ok(
        html.includes('aria-label="Expand sidebar"'),
        'Toggle button in collapsed mode must have aria-label="Expand sidebar"',
      );
      assert.ok(
        html.includes('aria-expanded="false"'),
        'Toggle button in collapsed mode must have aria-expanded="false"',
      );
      assert.ok(
        html.includes('class="sr-only">Expand sidebar</span>'),
        'Toggle button in collapsed mode must contain discernible sr-only text',
      );

      // 4. Expanded mode comparison
      const expandedHtml = renderWithRouter(
        React.createElement(Sidebar, {
          navContext: createNavContext(),
          defaultCollapsed: false,
        }),
        '/',
      );

      assert.ok(
        expandedHtml.includes('aria-label="Collapse sidebar"'),
        'Toggle button in expanded mode must have aria-label="Collapse sidebar"',
      );
      assert.ok(
        expandedHtml.includes('aria-expanded="true"'),
        'Toggle button in expanded mode must have aria-expanded="true"',
      );
      assert.ok(
        expandedHtml.includes('<span>Collapse sidebar</span>'),
        'Toggle button in expanded mode must display visible text',
      );
      assert.ok(
        expandedHtml.includes('class="truncate">Overview</span>'),
        'Expanded links must display visible truncated text',
      );
    });

    it('supports hydration-safe cookie parsing, serialization, and SSR resilience', () => {
      // 1. parseSidebarCollapsedCookie
      assert.equal(parseSidebarCollapsedCookie('acc_sidebar_collapsed=1'), true);
      assert.equal(parseSidebarCollapsedCookie('acc_sidebar_collapsed=0'), false);
      assert.equal(
        parseSidebarCollapsedCookie('session=abc; acc_sidebar_collapsed=1; theme=dark'),
        true,
      );
      assert.equal(
        parseSidebarCollapsedCookie('session=abc; acc_sidebar_collapsed=0; theme=dark'),
        false,
      );
      assert.equal(parseSidebarCollapsedCookie(''), null);
      assert.equal(parseSidebarCollapsedCookie(undefined), null);
      assert.equal(parseSidebarCollapsedCookie(null), null);
      assert.equal(parseSidebarCollapsedCookie('acc_sidebar_collapsed='), null);
      assert.equal(parseSidebarCollapsedCookie('acc_sidebar_collapsed=2'), null);

      // 2. sidebarCookie serialization
      assert.equal(
        sidebarCookie(true),
        `${SIDEBAR_COOKIE_NAME}=1; Path=/; Max-Age=${SIDEBAR_COOKIE_MAX_AGE}; SameSite=Lax`,
      );
      assert.equal(
        sidebarCookie(false),
        `${SIDEBAR_COOKIE_NAME}=0; Path=/; Max-Age=${SIDEBAR_COOKIE_MAX_AGE}; SameSite=Lax`,
      );

      // 3. SSR environment resilience (Node.js where document is undefined)
      assert.equal(readSidebarCollapsedCookie(), null);
      // writeSidebarCollapsedCookie must safely be a no-op in SSR without throwing
      assert.doesNotThrow(() => {
        writeSidebarCollapsedCookie(true);
        writeSidebarCollapsedCookie(false);
      });

      // 4. suppressHydrationWarning on <aside> element prop for SSR hydration safety
      const capturedProps: { suppressHydrationWarning?: boolean } = {};
      function Inspector() {
        const vdom = (Sidebar as unknown as (props: SidebarProps) => React.ReactNode)({
          navContext: createNavContext(),
          defaultCollapsed: true,
        });
        if (React.isValidElement<{ suppressHydrationWarning?: boolean }>(vdom)) {
          Object.assign(capturedProps, vdom.props);
        }
        return vdom;
      }
      renderWithRouter(React.createElement(Inspector), '/');
      assert.equal(
        capturedProps.suppressHydrationWarning,
        true,
        'Sidebar <aside> must include suppressHydrationWarning prop for SSR hydration safety',
      );

      // 5. SSR markup width classes
      const collapsedHtml = renderWithRouter(
        React.createElement(Sidebar, {
          navContext: createNavContext(),
          defaultCollapsed: true,
        }),
        '/',
      );
      assert.ok(collapsedHtml.includes('w-16'), 'Collapsed sidebar must render w-16 in SSR');

      const expandedHtml = renderWithRouter(
        React.createElement(Sidebar, {
          navContext: createNavContext(),
          defaultCollapsed: false,
        }),
        '/',
      );
      assert.ok(expandedHtml.includes('w-60'), 'Expanded sidebar must render w-60 in SSR');
    });

    it('SSR output with cookie value "1" renders collapsed and with "0" renders expanded', async () => {
      // Cookie value resolution
      assert.equal(serverSidebarCollapsed('1'), true);
      assert.equal(serverSidebarCollapsed('acc_sidebar_collapsed=1'), true);
      assert.equal(serverSidebarCollapsed('0'), false);
      assert.equal(serverSidebarCollapsed('acc_sidebar_collapsed=0'), false);
      assert.equal(serverSidebarCollapsed(undefined), false);
      assert.equal(serverSidebarCollapsed(null), false);
      assert.equal(serverSidebarCollapsed('invalid'), false);

      // 1. SSR output with cookie value '1' renders collapsed (w-16, Expand button, ACC monogram)
      const collapsedSsrHtml = renderWithRouter(
        React.createElement(Sidebar, {
          navContext: createNavContext(),
          defaultCollapsed: serverSidebarCollapsed('1'),
        }),
        '/',
      );
      assert.ok(collapsedSsrHtml.includes('w-16'), 'SSR with cookie 1 must render w-16');
      assert.ok(!collapsedSsrHtml.includes('w-60'), 'SSR with cookie 1 must NOT render w-60');
      assert.ok(
        collapsedSsrHtml.includes('aria-label="Expand sidebar"'),
        'SSR with cookie 1 must render Expand button',
      );
      assert.ok(
        collapsedSsrHtml.includes('aria-expanded="false"'),
        'SSR with cookie 1 must have aria-expanded="false"',
      );
      assert.ok(
        collapsedSsrHtml.includes('>ACC</span>'),
        'SSR with cookie 1 must render ACC brand monogram',
      );

      // 2. SSR output with cookie value '0' renders expanded (w-60, Collapse button, Alendei text)
      const expandedSsrHtml = renderWithRouter(
        React.createElement(Sidebar, {
          navContext: createNavContext(),
          defaultCollapsed: serverSidebarCollapsed('0'),
        }),
        '/',
      );
      assert.ok(expandedSsrHtml.includes('w-60'), 'SSR with cookie 0 must render w-60');
      assert.ok(!expandedSsrHtml.includes('w-16'), 'SSR with cookie 0 must NOT render w-16');
      assert.ok(
        expandedSsrHtml.includes('aria-label="Collapse sidebar"'),
        'SSR with cookie 0 must render Collapse button',
      );
      assert.ok(
        expandedSsrHtml.includes('aria-expanded="true"'),
        'SSR with cookie 0 must have aria-expanded="true"',
      );
      assert.ok(
        expandedSsrHtml.includes('>Alendei</p>'),
        'SSR with cookie 0 must render full brand text',
      );

      // 3. ConsoleLayout & ConsoleClientLayout SSR output with session in ready state
      useSession.getState().setSession({
        accessToken: 'test-token',
        user: {
          userId: 'test-user',
          actorType: 'user',
          authMethod: 'session',
          sessionId: 'session-123',
          authenticatedAt: '2026-09-23T00:00:00.000Z',
          tenant: { orgId: 'org-1', workspaceId: null, resellerId: null, isPlatformAdmin: false },
          roles: [
            {
              roleKey: 'org_admin',
              scopeType: 'organization',
              scopeId: 'org-1',
              orgId: 'org-1',
            },
          ],
          authorizedOrganizationIds: ['org-1'],
          permissions: [],
        },
        authorization: {
          actorType: 'user',
          userId: 'test-user',
          apiKeyId: null,
          grants: [
            {
              roleId: 'role-1',
              roleKey: 'org_admin',
              scopeType: 'organization',
              scopeId: 'org-1',
              orgId: 'org-1',
              permissions: ['messages.read'],
            },
          ],
          organizationIds: ['org-1'],
          isPlatformAdmin: false,
        },
      });

      try {
        const layoutCollapsedEl = await ConsoleLayout({
          initialCollapsed: serverSidebarCollapsed('1'),
          children: React.createElement('div', null, 'Console Content'),
        });
        const layoutCollapsedHtml = renderWithRouter(layoutCollapsedEl, '/');
        assert.ok(
          layoutCollapsedHtml.includes('w-16'),
          'ConsoleLayout SSR with cookie 1 must render w-16 on sidebar',
        );
        assert.ok(
          !layoutCollapsedHtml.includes('w-60'),
          'ConsoleLayout SSR with cookie 1 must NOT render w-60 on sidebar',
        );

        const layoutExpandedEl = await ConsoleLayout({
          initialCollapsed: serverSidebarCollapsed('0'),
          children: React.createElement('div', null, 'Console Content'),
        });
        const layoutExpandedHtml = renderWithRouter(layoutExpandedEl, '/');
        assert.ok(
          layoutExpandedHtml.includes('w-60'),
          'ConsoleLayout SSR with cookie 0 must render w-60 on sidebar',
        );
        assert.ok(
          !layoutExpandedHtml.includes('w-16'),
          'ConsoleLayout SSR with cookie 0 must NOT render w-16 on sidebar',
        );

        // 4. ConsoleClientLayout SSR output directly
        const clientCollapsedHtml = renderWithRouter(
          React.createElement(
            ConsoleClientLayout,
            { initialCollapsed: true },
            React.createElement('div', null, 'Console Content'),
          ),
          '/',
        );
        assert.ok(
          clientCollapsedHtml.includes('w-16'),
          'ConsoleClientLayout SSR with initialCollapsed=true must render w-16',
        );

        const clientExpandedHtml = renderWithRouter(
          React.createElement(
            ConsoleClientLayout,
            { initialCollapsed: false },
            React.createElement('div', null, 'Console Content'),
          ),
          '/',
        );
        assert.ok(
          clientExpandedHtml.includes('w-60'),
          'ConsoleClientLayout SSR with initialCollapsed=false must render w-60',
        );
      } finally {
        useSession.getState().clearSession();
      }
    });
  });

  // =========================================================================
  // 2. Command Palette Component Tests
  // =========================================================================
  describe('Command Palette Component', () => {
    it('renders null when isOpen is false', () => {
      const html = renderWithRouter(
        React.createElement(CommandPalette, {
          isOpen: false,
          onClose: () => {},
          navContext: createNavContext(),
        }),
      );

      assert.equal(html, '');
    });

    it('renders accessible dialog with combobox pattern when isOpen is true', () => {
      const html = renderWithRouter(
        React.createElement(CommandPalette, {
          isOpen: true,
          onClose: () => {},
          navContext: createNavContext(),
        }),
      );

      // Dialog semantics
      assert.ok(html.includes('role="dialog"'), 'Must have role="dialog"');
      assert.ok(html.includes('aria-modal="true"'), 'Must have aria-modal="true"');
      assert.ok(
        html.includes('aria-labelledby="command-palette-title"'),
        'Must reference command-palette-title',
      );
      assert.ok(
        html.includes('id="command-palette-title"'),
        'Must render title element with matching ID',
      );

      // Combobox semantics
      assert.ok(html.includes('role="combobox"'), 'Input must have role="combobox"');
      assert.ok(html.includes('aria-autocomplete="list"'), 'Must declare autocomplete list');
      assert.ok(html.includes('aria-controls="command-results"'), 'Must control command-results');
      assert.ok(
        html.includes('aria-label="Search commands or destinations"'),
        'Input must have programmatic aria-label',
      );

      // Results listbox semantics
      assert.ok(html.includes('id="command-results" role="listbox"'), 'Must render listbox');
      assert.ok(html.includes('role="option"'), 'Must render option items');
    });

    it('strictly filters quick actions by user permissions', () => {
      // Case 1: Full authority
      const fullHtml = renderWithRouter(
        React.createElement(CommandPalette, {
          isOpen: true,
          onClose: () => {},
          navContext: createNavContext(),
        }),
      );

      assert.ok(
        fullHtml.includes('Open Messages (Send message)'),
        'Must show Open Messages (Send message) when authorized',
      );
      assert.ok(
        fullHtml.includes('Open Users (Invite user)'),
        'Must show Open Users (Invite user) when authorized',
      );
      assert.ok(
        fullHtml.includes('Open Templates (Create template)'),
        'Must show Open Templates (Create template) when authorized',
      );

      // Case 2: Restricted authority (no message sending, no user invite)
      const restrictedHtml = renderWithRouter(
        React.createElement(CommandPalette, {
          isOpen: true,
          onClose: () => {},
          navContext: createNavContext({
            canSendMessages: false,
            canReadUsers: false,
          }),
        }),
      );

      assert.ok(
        !restrictedHtml.includes('Open Messages (Send message)'),
        'Must NOT show Open Messages (Send message) without permission',
      );
      assert.ok(
        !restrictedHtml.includes('Open Users (Invite user)'),
        'Must NOT show Open Users (Invite user) without permission',
      );

      // Case 3: Zero-organizations state: must NOT show organization-scoped quick actions
      const zeroOrgHtml = renderWithRouter(
        React.createElement(CommandPalette, {
          isOpen: true,
          onClose: () => {},
          navContext: createNavContext({
            status: 'zero_organizations',
            canSendMessages: true,
            canReadTemplates: true,
            canReadUsers: true,
          }),
        }),
      );

      assert.ok(
        !zeroOrgHtml.includes('Open Messages (Send message)'),
        'Must NOT show Open Messages in zero_organizations state',
      );
      assert.ok(
        !zeroOrgHtml.includes('Open Templates (Create template)'),
        'Must NOT show Open Templates in zero_organizations state',
      );
      assert.ok(
        !zeroOrgHtml.includes('Open Users (Invite user)'),
        'Must NOT show Open Users in zero_organizations state',
      );
    });
  });

  // =========================================================================
  // 3. Mobile Navigation Component Tests
  // =========================================================================
  describe('Mobile Navigation Component', () => {
    it('renders null when closed', () => {
      const html = renderWithRouter(
        React.createElement(MobileNav, {
          isOpen: false,
          onClose: () => {},
          navContext: createNavContext(),
        }),
      );

      assert.equal(html, '');
    });

    it('renders drawer anchored to left side when open', () => {
      const html = renderWithRouter(
        React.createElement(MobileNav, {
          isOpen: true,
          onClose: () => {},
          navContext: createNavContext(),
        }),
      );

      assert.ok(html.includes('role="dialog"'), 'Drawer must have role="dialog"');
      assert.ok(html.includes('justify-start'), 'Must be anchored to left side');
      assert.ok(html.includes('aria-label="Mobile Navigation"'), 'Must have nav element');
      assert.ok(html.includes('Close navigation menu'), 'Must have close button');
      assert.ok(html.includes('href="/messages"'), 'Must contain navigation links');
    });
  });

  // =========================================================================
  // 4. Universal Breadcrumbs Component Tests
  // =========================================================================
  describe('BreadcrumbBar Component', () => {
    it('renders breadcrumbs matching current route path with truncation and title', () => {
      const html = renderWithRouter(
        React.createElement(BreadcrumbBar, { status: 'ready' }),
        '/workspaces/01955b0a-7b3b-7411-9a4f-9e67d4f90001',
      );

      assert.ok(html.includes('aria-label="Breadcrumb"'), 'Must render breadcrumb navigation');
      assert.ok(html.includes('Overview'), 'Must have root breadcrumb');
      assert.ok(html.includes('href="/workspaces"'), 'Must have link to workspaces collection');
      assert.ok(
        html.includes('01955b0a-7b3b-7411-9a4f-9e67d4f90001'),
        'Must contain full identifier in title and text',
      );
      assert.ok(html.includes('max-w-[160px]'), 'Must include 160px truncation class');
      assert.ok(html.includes('aria-current="page"'), 'Current item must have aria-current="page"');
    });

    it('suppresses root Overview link when user is in zero_organizations status', () => {
      const html = renderWithRouter(
        React.createElement(BreadcrumbBar, { status: 'zero_organizations' }),
        '/organizations',
      );

      assert.ok(!html.includes('href="/"'), 'Root Overview must NOT have a link');
      assert.ok(html.includes('Overview'), 'Overview label is still present as non-link text');
      assert.ok(html.includes('Organizations'), 'Current page Organizations is present');
    });
  });

  // =========================================================================
  // 5. Option A Typography Verification (WOFF2 Assets & Integrity)
  // =========================================================================
  describe('Option A Typography Verification', () => {
    const fontsDir = fs.existsSync(path.join(process.cwd(), 'public', 'fonts'))
      ? path.join(process.cwd(), 'public', 'fonts')
      : path.join(process.cwd(), 'apps', 'web', 'public', 'fonts');

    const EXPECTED_FONTS = [
      'Inter-Regular.woff2',
      'Inter-Medium.woff2',
      'Inter-SemiBold.woff2',
      'Inter-Bold.woff2',
      'GeistMono-Regular.woff2',
      'GeistMono-Medium.woff2',
      'GeistMono-SemiBold.woff2',
      'GeistMono-Bold.woff2',
    ];

    it('bundles all 8 self-hosted Inter and Geist Mono WOFF2 font assets locally', () => {
      assert.ok(fs.existsSync(fontsDir), 'fonts directory must exist');

      for (const fontName of EXPECTED_FONTS) {
        const filePath = path.join(fontsDir, fontName);
        assert.ok(fs.existsSync(filePath), `Font asset ${fontName} must exist on disk`);
        const stats = fs.statSync(filePath);
        assert.ok(stats.size > 5000, `Font asset ${fontName} must be non-empty (>5KB)`);
      }
    });

    it('all bundled font files have valid WOFF2 magic header bytes (wOF2)', () => {
      // WOFF2 magic number is ASCII 'wOF2' (0x77 0x4F 0x46 0x32)
      for (const fontName of EXPECTED_FONTS) {
        const filePath = path.join(fontsDir, fontName);
        const buffer = fs.readFileSync(filePath);
        assert.equal(buffer[0], 0x77, `${fontName}: byte 0 must be 0x77 ('w')`);
        assert.equal(buffer[1], 0x4f, `${fontName}: byte 1 must be 0x4F ('O')`);
        assert.equal(buffer[2], 0x46, `${fontName}: byte 2 must be 0x46 ('F')`);
        assert.equal(buffer[3], 0x32, `${fontName}: byte 3 must be 0x32 ('2')`);
      }
    });

    it('fonts.ts and globals.css configure self-hosted typography with zero external CDNs', () => {
      const fontsTsPath = fs.existsSync(path.join(process.cwd(), 'src', 'app', 'fonts.ts'))
        ? path.join(process.cwd(), 'src', 'app', 'fonts.ts')
        : path.join(process.cwd(), 'apps', 'web', 'src', 'app', 'fonts.ts');
      const fontsTs = fs.readFileSync(fontsTsPath, 'utf8');

      assert.match(fontsTs, /localFont\(/);
      assert.match(fontsTs, /--font-inter/);
      assert.match(fontsTs, /--font-geist-mono/);
      assert.match(fontsTs, /Inter-Regular\.woff2/);
      assert.match(fontsTs, /GeistMono-Regular\.woff2/);
      assert.match(fontsTs, /display:\s*'swap'/);
      assert.doesNotMatch(fontsTs, /https?:\/\//, 'Zero external CDN font URLs in fonts.ts');

      const cssPath = fs.existsSync(path.join(process.cwd(), 'src', 'app', 'globals.css'))
        ? path.join(process.cwd(), 'src', 'app', 'globals.css')
        : path.join(process.cwd(), 'apps', 'web', 'src', 'app', 'globals.css');
      const css = fs.readFileSync(cssPath, 'utf8');

      assert.match(css, /--font-sans:\s*'Inter'/);
      assert.match(css, /--font-mono:\s*'Geist Mono'/);
      assert.doesNotMatch(css, /https?:\/\//, 'Zero external CDN font URLs in CSS');
    });
  });
});
