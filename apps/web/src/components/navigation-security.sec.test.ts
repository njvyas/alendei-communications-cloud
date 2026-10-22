import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

import ConsoleLayout from '../app/(console)/layout';
import { type EffectiveAuthorization, type UserIdentity } from '../lib/api-client';
import { useSession, hasPermission } from '../lib/session-store';

// Ensure React is globally available for JSX and SSR transforms
(globalThis as unknown as { React: typeof React }).React = React;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

describe('SEC-08: Console Navigation Security & Permission Gating (Production Component Tests)', () => {
  const ORG_A = '01955b0a-7b3b-7411-9a4f-orgAAAAAAAAAA';
  const ORG_B = '01955b0a-7b3b-7411-9a4f-orgBBBBBBBBBB';

  const mockRouter = {
    push: () => {},
    replace: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  };

  const renderLayout = (pathname = '/') =>
    renderToStaticMarkup(
      React.createElement(
        AppRouterContext.Provider,
        {
          value: mockRouter as unknown as React.ComponentProps<
            typeof AppRouterContext.Provider
          >['value'],
        },
        React.createElement(
          PathnameContext.Provider,
          { value: pathname },
          React.createElement(
            ConsoleLayout,
            null,
            React.createElement('div', null, 'Console Content'),
          ),
        ),
      ),
    );

  const createMockUser = (orgIds: string[] = [ORG_A]): UserIdentity => ({
    userId: '01955b0a-7b3b-7411-9a4f-testuser1111',
    actorType: 'user',
    authMethod: 'session',
    sessionId: 'session-123',
    authenticatedAt: '2026-09-23T00:00:00.000Z',
    tenant: {
      orgId: null,
      workspaceId: null,
      resellerId: null,
      isPlatformAdmin: false,
    },
    authorizedOrganizationIds: orgIds,
    roles: [],
    permissions: [],
  });

  const createMockAuthorization = (
    permissions: string[],
    orgId: string = ORG_A,
  ): EffectiveAuthorization => ({
    actorType: 'user',
    userId: '01955b0a-7b3b-7411-9a4f-testuser1111',
    apiKeyId: null,
    grants: [
      {
        roleId: 'role-test',
        roleKey: 'test_role',
        scopeType: 'organization',
        scopeId: orgId,
        orgId,
        permissions,
      },
    ],
    organizationIds: [orgId],
    isPlatformAdmin: false,
  });

  const createMockPlatformAuthorization = (permissions: string[]): EffectiveAuthorization => ({
    actorType: 'user',
    userId: '01955b0a-7b3b-7411-9a4f-testuser1111',
    apiKeyId: null,
    grants: [
      {
        roleId: 'role-platform',
        roleKey: 'alendei_support',
        scopeType: 'platform',
        scopeId: null,
        orgId: null,
        permissions,
      },
    ],
    organizationIds: [ORG_A],
    isPlatformAdmin: false,
  });

  const createMockFullAuthorization = (orgId: string = ORG_A): EffectiveAuthorization => ({
    actorType: 'user',
    userId: '01955b0a-7b3b-7411-9a4f-testuser1111',
    apiKeyId: null,
    grants: [
      {
        roleId: 'role-platform',
        roleKey: 'alendei_support',
        scopeType: 'platform',
        scopeId: null,
        orgId: null,
        permissions: ['providers.read'],
      },
      {
        roleId: 'role-org',
        roleKey: 'org_admin',
        scopeType: 'organization',
        scopeId: orgId,
        orgId,
        permissions: [
          'organizations.read',
          'workspaces.read',
          'teams.read',
          'users.read',
          'roles.read',
          'api_keys.read',
          'audit.read',
        ],
      },
    ],
    organizationIds: [orgId],
    isPlatformAdmin: false,
  });

  afterEach(() => {
    useSession.getState().clearSession();
  });

  // ---------------------------------------------------------------------------
  // C.1: Unauthenticated Session Flash Prevention
  // ---------------------------------------------------------------------------
  it('SEC-08.C1: unauthenticated session redirects to /login and renders no console navigation links (flash prevention)', () => {
    useSession.getState().clearSession();
    assert.equal(useSession.getState().status, 'unauthenticated');

    const html = renderLayout('/');

    // 1. Must NOT render any navigation bar
    assert.equal(
      html.includes('<nav aria-label="Sections">'),
      false,
      'Unauthenticated state must not render navigation sidebar',
    );
    // 2. Must NOT render protected child content
    assert.equal(
      html.includes('Console Content'),
      false,
      'Unauthenticated state must not render protected child content',
    );
    // 3. Must render loading spinner / redirect shell
    assert.ok(
      html.includes('Fetching console data') || html.includes('Loading'),
      'Must render loading state during redirect',
    );
  });

  // ---------------------------------------------------------------------------
  // C.2: Multiple Organizations Selection Gating
  // ---------------------------------------------------------------------------
  it('SEC-08.C2: selecting_organization status renders OrgSelectionView and suppresses navigation links', () => {
    useSession.getState().setSession({
      accessToken: 'token-multi',
      user: createMockUser([ORG_A, ORG_B]),
      authorization: createMockAuthorization(['users.read'], ORG_A),
      selectedOrgId: null, // No selected org -> status transitions to selecting_organization
    });

    assert.equal(useSession.getState().status, 'selecting_organization');

    const html = renderLayout('/');

    // 1. Must NOT render navigation sections
    assert.equal(
      html.includes('<nav aria-label="Sections">'),
      false,
      'Navigation sidebar must NOT be rendered when selecting organization',
    );
    // 2. Must render OrgSelectionView
    assert.ok(
      html.includes('Select Organization'),
      'Must render OrgSelectionView when selecting organization',
    );
  });

  // ---------------------------------------------------------------------------
  // C.3: Zero Authorized Organizations Shell Gating
  // ---------------------------------------------------------------------------
  it('SEC-08.C3: zero_organizations status renders ZeroOrgView unless navigating permitted catalogue/organizations', () => {
    useSession.getState().setSession({
      accessToken: 'token-zero-org',
      user: createMockUser([]),
      authorization: {
        actorType: 'user',
        userId: '01955b0a-7b3b-7411-9a4f-testuser1111',
        apiKeyId: null,
        grants: [],
        organizationIds: [],
        isPlatformAdmin: false,
      },
      selectedOrgId: null,
    });

    assert.equal(useSession.getState().status, 'zero_organizations');

    // Navigating non-exempt route (e.g. /overview or /workspaces)
    const html = renderLayout('/');

    // 1. Navigation sections suppressed
    assert.equal(
      html.includes('<nav aria-label="Sections">'),
      false,
      'Navigation sidebar must NOT be rendered for zero_organizations on non-exempt route',
    );
    // 2. Must render ZeroOrgView
    assert.ok(
      html.includes('No Organization Access'),
      'Must render ZeroOrgView when user has zero organizations',
    );
  });

  // ---------------------------------------------------------------------------
  // C.3a: Platform Administrator in zero_organizations state sees only authorized Organizations, Channels, Providers
  // ---------------------------------------------------------------------------
  it('SEC-08.C3a: platform administrator in zero_organizations state sees only permission-authorized Organizations, Channels, and Providers navigation entries', () => {
    useSession.getState().setSession({
      accessToken: 'token-platform-admin-zero-org',
      user: {
        userId: '01955b0a-7b3b-7411-9a4f-adminuser111',
        actorType: 'user',
        authMethod: 'session',
        sessionId: 'session-admin',
        authenticatedAt: '2026-09-23T00:00:00.000Z',
        tenant: {
          orgId: null,
          workspaceId: null,
          resellerId: null,
          isPlatformAdmin: true,
        },
        authorizedOrganizationIds: [],
        roles: [],
        permissions: [],
      },
      authorization: {
        actorType: 'user',
        userId: '01955b0a-7b3b-7411-9a4f-adminuser111',
        apiKeyId: null,
        grants: [
          {
            roleId: 'role-providers',
            roleKey: 'providers_manager',
            scopeType: 'platform',
            scopeId: null,
            orgId: null,
            permissions: ['providers.read'],
          },
        ],
        organizationIds: [],
        isPlatformAdmin: true,
      },
      selectedOrgId: null,
    });

    assert.equal(useSession.getState().status, 'zero_organizations');

    // Navigating permitted /organizations route
    const html = renderLayout('/organizations');

    // 1. Sidebar is rendered
    assert.ok(
      html.includes('aria-label="Sections"'),
      'Navigation sidebar must be rendered on permitted route',
    );

    // 2. Only permission-authorized entries are present
    assert.ok(html.includes('href="/organizations"'), 'Organizations entry must be visible');
    assert.ok(html.includes('href="/channels"'), 'Channels entry must be visible');
    assert.ok(html.includes('href="/providers"'), 'Providers entry must be visible');

    // 3. Destinations blocked by zero-org gate are strictly suppressed
    assert.equal(html.includes('href="/"'), false, 'Overview link must NOT be visible');
    assert.equal(html.includes('href="/users"'), false, 'Users link must NOT be visible');
    assert.equal(html.includes('href="/roles"'), false, 'Roles link must NOT be visible');
    assert.equal(html.includes('href="/audit-logs"'), false, 'Audit Logs link must NOT be visible');
    assert.equal(html.includes('href="/workspaces"'), false, 'Workspaces link must NOT be visible');
    assert.equal(html.includes('href="/teams"'), false, 'Teams link must NOT be visible');
    assert.equal(html.includes('href="/messages"'), false, 'Messages link must NOT be visible');
    assert.equal(html.includes('href="/whatsapp"'), false, 'WhatsApp link must NOT be visible');
    assert.equal(html.includes('href="/templates"'), false, 'Templates link must NOT be visible');
    assert.equal(html.includes('href="/contacts"'), false, 'Contacts link must NOT be visible');
    assert.equal(
      html.includes('href="/suppressions"'),
      false,
      'Suppressions link must NOT be visible',
    );
    assert.equal(html.includes('href="/api-keys"'), false, 'API Keys link must NOT be visible');

    // 4. Direct navigation to blocked destination renders ZeroOrgView instead of target page
    const blockedHtml = renderLayout('/users');
    assert.equal(
      blockedHtml.includes('aria-label="Sections"'),
      false,
      'Direct URL to /users must not render sidebar',
    );
    assert.ok(
      blockedHtml.includes('No organizations exist yet'),
      'Direct URL to /users must intercept with first-run ZeroOrgView',
    );
  });

  // ---------------------------------------------------------------------------
  // C.3b: Users without organization-creation permission retain existing message and see no privileged action
  // ---------------------------------------------------------------------------
  it('SEC-08.C3b: users without organization-creation permission do not see the privileged first-run action and retain the appropriate existing message', () => {
    useSession.getState().setSession({
      accessToken: 'token-unprivileged-zero-org',
      user: createMockUser([]),
      authorization: {
        actorType: 'user',
        userId: '01955b0a-7b3b-7411-9a4f-testuser1111',
        apiKeyId: null,
        grants: [],
        organizationIds: [],
        isPlatformAdmin: false,
      },
      selectedOrgId: null,
    });

    assert.equal(useSession.getState().status, 'zero_organizations');

    const html = renderLayout('/');

    // 1. Retains existing title and guidance message
    assert.ok(
      html.includes('No Organization Access'),
      'Must retain existing title "No Organization Access"',
    );
    assert.ok(
      html.includes(
        'Your account is successfully authenticated, but you do not hold active grants in any organization.',
      ),
      'Must retain existing description for unprivileged users',
    );

    // 2. Suppresses privileged first-run action and message
    assert.equal(
      html.includes('Manage Organizations'),
      false,
      'Must NOT display privileged Manage Organizations action',
    );
    assert.equal(
      html.includes('No organizations exist yet'),
      false,
      'Must NOT display first-run guidance to unprivileged user',
    );
  });

  // ---------------------------------------------------------------------------
  // C.3c: Platform administrators receive the new first-run guidance
  // ---------------------------------------------------------------------------
  it('SEC-08.C3c: platform administrators receive the new first-run guidance', () => {
    useSession.getState().setSession({
      accessToken: 'token-platform-admin-zero-org',
      user: {
        userId: '01955b0a-7b3b-7411-9a4f-adminuser111',
        actorType: 'user',
        authMethod: 'session',
        sessionId: 'session-admin',
        authenticatedAt: '2026-09-23T00:00:00.000Z',
        tenant: {
          orgId: null,
          workspaceId: null,
          resellerId: null,
          isPlatformAdmin: true,
        },
        authorizedOrganizationIds: [],
        roles: [],
        permissions: [],
      },
      authorization: {
        actorType: 'user',
        userId: '01955b0a-7b3b-7411-9a4f-adminuser111',
        apiKeyId: null,
        grants: [],
        organizationIds: [],
        isPlatformAdmin: true,
      },
      selectedOrgId: null,
    });

    assert.equal(useSession.getState().status, 'zero_organizations');

    const html = renderLayout('/');

    // 1. Receives first-run guidance
    assert.ok(
      html.includes('No organizations exist yet. Create the first organization to continue.'),
      'Must display first-run guidance message',
    );
    assert.ok(html.includes('No Organizations'), 'Must render No Organizations header');

    // 2. Primary action is Manage Organizations link
    assert.ok(html.includes('Manage Organizations'), 'Must display Manage Organizations button');
    assert.ok(
      html.includes('href="/organizations"'),
      'Manage Organizations must link to /organizations',
    );

    // 3. Does not display standard unprivileged access denied text
    assert.equal(
      html.includes(
        'Your account is successfully authenticated, but you do not hold active grants in any organization.',
      ),
      false,
      'Must not treat platform administrator as user lacking grants',
    );
  });

  // ---------------------------------------------------------------------------
  // C.4: Dynamic Permission Gating for Users Section
  // ---------------------------------------------------------------------------
  it('SEC-08.C4: Users navigation link is dynamically gated on users.read permission in ConsoleLayout', () => {
    // Case 1: Unauthorized user (lacks users.read)
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(['roles.read'], ORG_A),
      selectedOrgId: ORG_A,
    });

    assert.equal(hasPermission('users.read'), false);
    const unauthorizedHtml = renderLayout('/roles');

    assert.equal(
      unauthorizedHtml.includes('href="/users"'),
      false,
      'Users link must NOT be rendered when user lacks users.read',
    );

    // Case 2: Authorized user (holds users.read)
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(['users.read'], ORG_A),
      selectedOrgId: ORG_A,
    });

    assert.equal(hasPermission('users.read'), true);
    const authorizedHtml = renderLayout('/users');

    assert.ok(
      authorizedHtml.includes('href="/users"'),
      'Users link MUST be rendered when user holds users.read',
    );
  });

  // ---------------------------------------------------------------------------
  // C.5: Canonical Navigation Order
  // ---------------------------------------------------------------------------
  it('SEC-08.C5: canonical navigation sections preserve defined order when user holds full read authority', () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockFullAuthorization(ORG_A),
      selectedOrgId: ORG_A,
    });

    const html = renderLayout('/');

    const canonicalHrefOrder = [
      'href="/"',
      'href="/channels"',
      'href="/providers"',
      'href="/organizations"',
      'href="/workspaces"',
      'href="/teams"',
      'href="/users"',
      'href="/roles"',
      'href="/api-keys"',
      'href="/audit-logs"',
    ];

    let lastIndex = -1;
    for (const href of canonicalHrefOrder) {
      const idx = html.indexOf(href);
      assert.ok(
        idx > -1,
        `Navigation link ${href} must be rendered when user holds full authority`,
      );
      assert.ok(
        idx > lastIndex,
        `Navigation link ${href} must appear after preceding section in canonical order`,
      );
      lastIndex = idx;
    }
  });

  // ---------------------------------------------------------------------------
  // C.6: Dynamic Gating Across All Sections in Production ConsoleLayout
  // ---------------------------------------------------------------------------
  it('SEC-08.C6: unauthorized user holding no permissions sees only Overview link in ConsoleLayout', () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization([], ORG_A), // No permissions held
      selectedOrgId: ORG_A,
    });

    const html = renderLayout('/');

    // 1. Overview is accessible to all authenticated organization members
    assert.ok(html.includes('href="/"'), 'Overview link must be present');

    // 2. All 9 permission-gated sections are dynamically suppressed
    assert.equal(html.includes('href="/channels"'), false, 'Channels must be hidden');
    assert.equal(html.includes('href="/providers"'), false, 'Providers must be hidden');
    assert.equal(html.includes('href="/organizations"'), false, 'Organizations must be hidden');
    assert.equal(html.includes('href="/workspaces"'), false, 'Workspaces must be hidden');
    assert.equal(html.includes('href="/teams"'), false, 'Teams must be hidden');
    assert.equal(html.includes('href="/users"'), false, 'Users must be hidden');
    assert.equal(html.includes('href="/roles"'), false, 'Roles must be hidden');
    assert.equal(html.includes('href="/api-keys"'), false, 'API Keys must be hidden');
    assert.equal(html.includes('href="/audit-logs"'), false, 'Audit Logs must be hidden');
  });

  // ---------------------------------------------------------------------------
  // C.7: Fail-Closed on Absent or Null Authorization Context
  // ---------------------------------------------------------------------------
  it('SEC-08.C7: fail-closed on absent or null authorization context in ConsoleLayout', () => {
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization([]),
      selectedOrgId: ORG_A,
    });
    // Explicitly transition authorization state to null to test fail-closed behavior
    useSession.setState({ authorization: null });

    assert.equal(hasPermission('users.read'), false);
    assert.equal(hasPermission('roles.read'), false);
    assert.equal(hasPermission('workspaces.read'), false);
    assert.equal(hasPermission('providers.read'), false);
    assert.equal(hasPermission('organizations.read'), false);

    const html = renderLayout('/');

    // Invariant: all 9 gated sections fail closed when authorization context is null
    assert.equal(html.includes('href="/channels"'), false);
    assert.equal(html.includes('href="/providers"'), false);
    assert.equal(html.includes('href="/organizations"'), false);
    assert.equal(html.includes('href="/workspaces"'), false);
    assert.equal(html.includes('href="/teams"'), false);
    assert.equal(html.includes('href="/users"'), false);
    assert.equal(html.includes('href="/roles"'), false);
    assert.equal(html.includes('href="/api-keys"'), false);
    assert.equal(html.includes('href="/audit-logs"'), false);
  });

  // ===========================================================================
  // PRODUCTION CONSOLE NAVIGATION MATRIX TESTS (SEC-08)
  //
  // Negative, positive, scope, and isolation tests exercising production ConsoleLayout:
  // 1. Channels — channels.read / providers.read
  // 2. Providers — providers.read
  // 3. Organizations — organizations.read
  // 4. Workspaces — workspaces.read
  // 5. Teams — teams.read
  // 6. Roles — roles.read
  // 7. API Keys — api_keys.read
  // 8. Audit Logs — audit_logs.read / audit.read
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // C.8: Channels Navigation Gating
  // ---------------------------------------------------------------------------
  it('SEC-08.C8: Channels link in ConsoleLayout is hidden without permission and rendered with catalogue read authority', () => {
    // 1. Negative (unheld): user lacks catalogue read permission
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(['workspaces.read', 'roles.read'], ORG_A),
      selectedOrgId: ORG_A,
    });
    let html = renderLayout('/');
    assert.equal(
      html.includes('href="/channels"'),
      false,
      'Channels link must NOT be rendered when actor lacks catalogue read authority',
    );

    // 2. Negative (uncatalogued): synthetic/uncatalogued channels.read fails closed
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(['channels.read'], ORG_A),
      selectedOrgId: ORG_A,
    });
    html = renderLayout('/');
    assert.equal(
      html.includes('href="/channels"'),
      false,
      'Synthetic uncatalogued channels.read must not bypass catalogue authorization',
    );

    // 3. Positive: platform grant with canonical providers.read renders Channels
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockPlatformAuthorization(['providers.read']),
      selectedOrgId: ORG_A,
    });
    html = renderLayout('/');
    assert.ok(
      html.includes('href="/channels"'),
      'Channels link MUST be rendered when actor holds catalogue read authority',
    );

    // 4. Isolation: catalogue authority does NOT render tenant sections
    assert.equal(html.includes('href="/workspaces"'), false);
    assert.equal(html.includes('href="/teams"'), false);
    assert.equal(html.includes('href="/roles"'), false);
    assert.equal(html.includes('href="/api-keys"'), false);
    assert.equal(html.includes('href="/audit-logs"'), false);
    assert.equal(html.includes('href="/users"'), false);
  });

  // ---------------------------------------------------------------------------
  // C.9: Providers Navigation Gating
  // ---------------------------------------------------------------------------
  it('SEC-08.C9: Providers link in ConsoleLayout is hidden without providers.read and rendered when held at platform scope', () => {
    // 1. Negative (unheld):
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(['roles.read'], ORG_A),
      selectedOrgId: ORG_A,
    });
    let html = renderLayout('/');
    assert.equal(
      html.includes('href="/providers"'),
      false,
      'Providers link must NOT be rendered without providers.read',
    );

    // 2. Negative (wrong scope): providers.read on an organization grant does not satisfy platform catalogue requirement
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(['providers.read'], ORG_A),
      selectedOrgId: ORG_A,
    });
    html = renderLayout('/');
    assert.equal(
      html.includes('href="/providers"'),
      false,
      'Providers link requires platform-scope authority and must NOT render for tenant grant',
    );

    // 3. Positive:
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockPlatformAuthorization(['providers.read']),
      selectedOrgId: ORG_A,
    });
    html = renderLayout('/');
    assert.ok(
      html.includes('href="/providers"'),
      'Providers link MUST be rendered when held at platform scope',
    );

    // 4. Isolation:
    assert.equal(html.includes('href="/workspaces"'), false);
    assert.equal(html.includes('href="/teams"'), false);
    assert.equal(html.includes('href="/roles"'), false);
    assert.equal(html.includes('href="/api-keys"'), false);
    assert.equal(html.includes('href="/audit-logs"'), false);
  });

  // ---------------------------------------------------------------------------
  // C.10: Organizations Navigation Gating
  // ---------------------------------------------------------------------------
  it('SEC-08.C10: Organizations link in ConsoleLayout is hidden without organizations.read and rendered when held', () => {
    // 1. Negative:
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(['workspaces.read'], ORG_A),
      selectedOrgId: ORG_A,
    });
    let html = renderLayout('/');
    assert.equal(
      html.includes('href="/organizations"'),
      false,
      'Organizations link must NOT be rendered without organizations.read',
    );

    // 2. Positive:
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(['organizations.read'], ORG_A),
      selectedOrgId: ORG_A,
    });
    html = renderLayout('/');
    assert.ok(
      html.includes('href="/organizations"'),
      'Organizations link MUST be rendered when holding organizations.read',
    );

    // 3. Isolation:
    assert.equal(html.includes('href="/channels"'), false);
    assert.equal(html.includes('href="/providers"'), false);
    assert.equal(html.includes('href="/workspaces"'), false);
    assert.equal(html.includes('href="/teams"'), false);
    assert.equal(html.includes('href="/users"'), false);
    assert.equal(html.includes('href="/roles"'), false);
    assert.equal(html.includes('href="/api-keys"'), false);
    assert.equal(html.includes('href="/audit-logs"'), false);
  });

  // ---------------------------------------------------------------------------
  // C.11: Workspaces Navigation Gating
  // ---------------------------------------------------------------------------
  it('SEC-08.C11: Workspaces link in ConsoleLayout is hidden without workspaces.read and rendered when held', () => {
    // 1. Negative:
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(['teams.read'], ORG_A),
      selectedOrgId: ORG_A,
    });
    let html = renderLayout('/');
    assert.equal(
      html.includes('href="/workspaces"'),
      false,
      'Workspaces link must NOT be rendered without workspaces.read',
    );

    // 2. Positive:
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(['workspaces.read'], ORG_A),
      selectedOrgId: ORG_A,
    });
    html = renderLayout('/');
    assert.ok(
      html.includes('href="/workspaces"'),
      'Workspaces link MUST be rendered when holding workspaces.read',
    );

    // 3. Isolation:
    assert.equal(html.includes('href="/channels"'), false);
    assert.equal(html.includes('href="/providers"'), false);
    assert.equal(html.includes('href="/organizations"'), false);
    assert.equal(html.includes('href="/teams"'), false);
    assert.equal(html.includes('href="/users"'), false);
    assert.equal(html.includes('href="/roles"'), false);
    assert.equal(html.includes('href="/api-keys"'), false);
    assert.equal(html.includes('href="/audit-logs"'), false);
  });

  // ---------------------------------------------------------------------------
  // C.12: Teams Navigation Gating
  // ---------------------------------------------------------------------------
  it('SEC-08.C12: Teams link in ConsoleLayout is hidden without teams.read and rendered when held', () => {
    // 1. Negative:
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(['workspaces.read'], ORG_A),
      selectedOrgId: ORG_A,
    });
    let html = renderLayout('/');
    assert.equal(
      html.includes('href="/teams"'),
      false,
      'Teams link must NOT be rendered without teams.read',
    );

    // 2. Positive:
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(['teams.read'], ORG_A),
      selectedOrgId: ORG_A,
    });
    html = renderLayout('/');
    assert.ok(
      html.includes('href="/teams"'),
      'Teams link MUST be rendered when holding teams.read',
    );

    // 3. Isolation:
    assert.equal(html.includes('href="/workspaces"'), false);
    assert.equal(html.includes('href="/roles"'), false);
    assert.equal(html.includes('href="/users"'), false);
    assert.equal(html.includes('href="/api-keys"'), false);
    assert.equal(html.includes('href="/audit-logs"'), false);
  });

  // ---------------------------------------------------------------------------
  // C.13: Roles Navigation Gating
  // ---------------------------------------------------------------------------
  it('SEC-08.C13: Roles link in ConsoleLayout is hidden without roles.read and rendered when held', () => {
    // 1. Negative:
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(['workspaces.read'], ORG_A),
      selectedOrgId: ORG_A,
    });
    let html = renderLayout('/');
    assert.equal(
      html.includes('href="/roles"'),
      false,
      'Roles link must NOT be rendered without roles.read',
    );

    // 2. Positive:
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(['roles.read'], ORG_A),
      selectedOrgId: ORG_A,
    });
    html = renderLayout('/');
    assert.ok(
      html.includes('href="/roles"'),
      'Roles link MUST be rendered when holding roles.read',
    );

    // 3. Isolation:
    assert.equal(html.includes('href="/workspaces"'), false);
    assert.equal(html.includes('href="/teams"'), false);
    assert.equal(html.includes('href="/users"'), false);
    assert.equal(html.includes('href="/api-keys"'), false);
    assert.equal(html.includes('href="/audit-logs"'), false);
  });

  // ---------------------------------------------------------------------------
  // C.14: API Keys Navigation Gating
  // ---------------------------------------------------------------------------
  it('SEC-08.C14: API Keys link in ConsoleLayout is hidden without api_keys.read and rendered when held', () => {
    // 1. Negative:
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(['roles.read'], ORG_A),
      selectedOrgId: ORG_A,
    });
    let html = renderLayout('/');
    assert.equal(
      html.includes('href="/api-keys"'),
      false,
      'API Keys link must NOT be rendered without api_keys.read',
    );

    // 2. Positive:
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(['api_keys.read'], ORG_A),
      selectedOrgId: ORG_A,
    });
    html = renderLayout('/');
    assert.ok(
      html.includes('href="/api-keys"'),
      'API Keys link MUST be rendered when holding api_keys.read',
    );

    // 3. Isolation:
    assert.equal(html.includes('href="/workspaces"'), false);
    assert.equal(html.includes('href="/teams"'), false);
    assert.equal(html.includes('href="/users"'), false);
    assert.equal(html.includes('href="/roles"'), false);
    assert.equal(html.includes('href="/audit-logs"'), false);
  });

  // ---------------------------------------------------------------------------
  // C.15: Audit Logs Navigation Gating
  // ---------------------------------------------------------------------------
  it('SEC-08.C15: Audit Logs link in ConsoleLayout is hidden without audit.read and rendered when held', () => {
    // 1. Negative (unheld):
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(['roles.read'], ORG_A),
      selectedOrgId: ORG_A,
    });
    let html = renderLayout('/');
    assert.equal(
      html.includes('href="/audit-logs"'),
      false,
      'Audit Logs link must NOT be rendered without audit.read',
    );

    // 2. Negative (uncatalogued): uncatalogued audit_logs.read fails closed
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(['audit_logs.read'], ORG_A),
      selectedOrgId: ORG_A,
    });
    html = renderLayout('/');
    assert.equal(
      html.includes('href="/audit-logs"'),
      false,
      'Uncatalogued audit_logs.read must not bypass authorization (must use canonical audit.read)',
    );

    // 3. Positive (canonical audit.read):
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(['audit.read'], ORG_A),
      selectedOrgId: ORG_A,
    });
    html = renderLayout('/');
    assert.ok(
      html.includes('href="/audit-logs"'),
      'Audit Logs link MUST be rendered when holding canonical audit.read',
    );

    // 4. Isolation:
    assert.equal(html.includes('href="/workspaces"'), false);
    assert.equal(html.includes('href="/teams"'), false);
    assert.equal(html.includes('href="/users"'), false);
    assert.equal(html.includes('href="/roles"'), false);
    assert.equal(html.includes('href="/api-keys"'), false);
  });

  // ---------------------------------------------------------------------------
  // C.16: Navigation Permission Isolation Matrix
  // ---------------------------------------------------------------------------
  it('SEC-08.C16: navigation permissions operate strictly independently across all sections in ConsoleLayout', () => {
    // Actor holding exactly workspaces.read and roles.read
    useSession.getState().setSession({
      accessToken: 'token-org-a',
      user: createMockUser([ORG_A]),
      authorization: createMockAuthorization(['workspaces.read', 'roles.read'], ORG_A),
      selectedOrgId: ORG_A,
    });

    const html = renderLayout('/');

    // Held sections are rendered
    assert.ok(html.includes('href="/workspaces"'), 'Workspaces must be rendered');
    assert.ok(html.includes('href="/roles"'), 'Roles must be rendered');

    // Unheld sections are suppressed
    assert.equal(html.includes('href="/channels"'), false, 'Channels must be hidden');
    assert.equal(html.includes('href="/providers"'), false, 'Providers must be hidden');
    assert.equal(html.includes('href="/organizations"'), false, 'Organizations must be hidden');
    assert.equal(html.includes('href="/teams"'), false, 'Teams must be hidden');
    assert.equal(html.includes('href="/users"'), false, 'Users must be hidden');
    assert.equal(html.includes('href="/api-keys"'), false, 'API Keys must be hidden');
    assert.equal(html.includes('href="/audit-logs"'), false, 'Audit Logs must be hidden');
  });
});
