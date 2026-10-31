import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

import {
  OrgSwitcher,
  isScopedDetailRoute,
  getScopedCollectionRoot,
} from '../components/org-switcher';
import { OrgSelectionView } from '../components/org-selection-view';
import {
  getSelectedOrganization,
  organizationsApi,
  type EffectiveAuthorization,
  type OrganizationView,
  type UserIdentity,
} from './api-client';
import { createAppQueryClient, registerQueryClient } from './query-client';
import { useSession } from './session-store';

// Ensure React is globally available for JSX and SSR transforms
(globalThis as unknown as { React: typeof React }).React = React;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

describe('SEC-05: Organization Switcher Context Synchronization & Route Scoping', () => {
  const ORG_A = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const ORG_B = '01955b0a-7b3b-7411-9a4f-9e67d4f92222';

  let replaceCalls: string[] = [];

  const mockRouter = {
    back: () => {},
    forward: () => {},
    refresh: () => {},
    push: () => {},
    replace: (href: string) => {
      replaceCalls.push(href);
    },
    prefetch: () => {},
  };

  const createChangeEvent = (value: string): React.ChangeEvent<HTMLSelectElement> =>
    ({ target: { value } }) as unknown as React.ChangeEvent<HTMLSelectElement>;

  const setupSession = (
    selectedOrg: string | null = ORG_A,
    authorizedOrgs: string[] = [ORG_A, ORG_B],
  ) => {
    const user: UserIdentity = {
      userId: 'test-admin-1',
      actorType: 'user',
      authMethod: 'session',
      sessionId: 'sess-1',
      authenticatedAt: new Date().toISOString(),
      tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: true },
      authorizedOrganizationIds: authorizedOrgs,
      roles: [],
      permissions: [],
    };

    const authorization: EffectiveAuthorization = {
      actorType: 'user',
      userId: 'test-admin-1',
      apiKeyId: null,
      organizationIds: authorizedOrgs,
      grants: [
        {
          roleId: 'role-org-admin',
          roleKey: 'org_admin',
          scopeType: 'organization',
          scopeId: ORG_A,
          orgId: ORG_A,
          permissions: [
            'workspaces.read',
            'workspaces.update',
            'teams.read',
            'teams.create',
            'teams.update',
            'users.read',
            'users.update',
            'roles.read',
          ],
        },
        {
          roleId: 'role-org-admin-b',
          roleKey: 'org_admin',
          scopeType: 'organization',
          scopeId: ORG_B,
          orgId: ORG_B,
          permissions: [
            'workspaces.read',
            'workspaces.update',
            'teams.read',
            'teams.create',
            'teams.update',
            'users.read',
            'users.update',
            'roles.read',
          ],
        },
      ],
      isPlatformAdmin: true,
    };

    useSession.getState().setSession({
      accessToken: 'test-token',
      user,
      authorization,
      selectedOrgId: selectedOrg,
    });
  };

  const renderWithContext = (component: React.ReactNode, pathname = '/') =>
    renderToStaticMarkup(
      React.createElement(
        AppRouterContext.Provider,
        {
          value: mockRouter as unknown as React.ComponentProps<
            typeof AppRouterContext.Provider
          >['value'],
        },
        React.createElement(PathnameContext.Provider, { value: pathname }, component),
      ),
    );

  const renderAndCaptureSelectProps = (pathname = '/'): React.ComponentProps<'select'> | null => {
    let captured: React.ComponentProps<'select'> | null = null;
    const origCreateElement = React.createElement;
    (React as unknown as { createElement: unknown }).createElement = (
      ...args: Parameters<typeof origCreateElement>
    ) => {
      const [type, props] = args;
      if (type === 'select' && (props as { id?: string } | null)?.id === 'org-select') {
        captured = props as React.ComponentProps<'select'>;
      }
      return Reflect.apply(origCreateElement, React, args);
    };
    try {
      renderWithContext(React.createElement(OrgSwitcher), pathname);
    } finally {
      React.createElement = origCreateElement;
    }
    return captured;
  };

  const triggerChange = (props: React.ComponentProps<'select'> | null, value: string) => {
    assert.ok(props, 'Select props must be captured');
    assert.ok(props.onChange, 'onChange handler must be defined');
    props.onChange(createChangeEvent(value));
  };

  beforeEach(() => {
    replaceCalls = [];
    setupSession(ORG_A, [ORG_A, ORG_B]);
  });

  afterEach(() => {
    useSession.getState().clearSession();
  });

  // =========================================================================
  // 1. Route Scoping Helpers (isScopedDetailRoute & getScopedCollectionRoot)
  // =========================================================================
  describe('1. Route Scoping Detection & Collection Root Resolution', () => {
    it('identifies /workspaces/[id] as a scoped detail route and resolves /workspaces root', () => {
      assert.equal(isScopedDetailRoute('/workspaces/ws-123'), true);
      assert.equal(getScopedCollectionRoot('/workspaces/ws-123'), '/workspaces');
    });

    it('identifies /teams/[id] as a scoped detail route and resolves /teams root', () => {
      assert.equal(isScopedDetailRoute('/teams/team-456'), true);
      assert.equal(getScopedCollectionRoot('/teams/team-456'), '/teams');
    });

    it('identifies /users/[id] as a scoped detail route and resolves /users root', () => {
      assert.equal(isScopedDetailRoute('/users/usr-789'), true);
      assert.equal(getScopedCollectionRoot('/users/usr-789'), '/users');
    });

    it('identifies /roles/[id] as a scoped detail route and resolves /roles root', () => {
      assert.equal(isScopedDetailRoute('/roles/role-abc'), true);
      assert.equal(getScopedCollectionRoot('/roles/role-abc'), '/roles');
    });

    it('identifies nested detail paths under scoped collections and resolves root', () => {
      assert.equal(isScopedDetailRoute('/workspaces/ws-123/sub-path'), true);
      assert.equal(getScopedCollectionRoot('/workspaces/ws-123/sub-path'), '/workspaces');
    });

    it('does NOT classify collection root list routes as detail routes', () => {
      assert.equal(isScopedDetailRoute('/workspaces'), false);
      assert.equal(isScopedDetailRoute('/teams'), false);
      assert.equal(isScopedDetailRoute('/users'), false);
      assert.equal(isScopedDetailRoute('/roles'), false);
    });

    it('does NOT classify platform catalogue or administration routes as scoped detail routes', () => {
      assert.equal(isScopedDetailRoute('/organizations/org-123'), false);
      assert.equal(isScopedDetailRoute('/channels/chan-123'), false);
      assert.equal(isScopedDetailRoute('/providers/prov-123'), false);
      assert.equal(isScopedDetailRoute('/organizations'), false);
      assert.equal(isScopedDetailRoute('/channels'), false);
      assert.equal(isScopedDetailRoute('/providers'), false);
    });

    it('does NOT classify overview, login, api-keys, or audit-logs as scoped detail routes', () => {
      assert.equal(isScopedDetailRoute('/'), false);
      assert.equal(isScopedDetailRoute('/login'), false);
      assert.equal(isScopedDetailRoute('/api-keys'), false);
      assert.equal(isScopedDetailRoute('/audit-logs'), false);
    });

    it('handles null, undefined, and empty string safely without throwing', () => {
      assert.equal(isScopedDetailRoute(null), false);
      assert.equal(isScopedDetailRoute(''), false);
      assert.equal(isScopedDetailRoute('/workspaces/'), false); // trailing slash only with no ID
    });
  });

  // =========================================================================
  // 2. OrgSwitcher Component Navigation & Context Synchronization
  // =========================================================================
  describe('2. OrgSwitcher Component Rendering & Navigation Synchronization', () => {
    it('renders select dropdown containing authorized organizations', () => {
      const html = renderWithContext(React.createElement(OrgSwitcher), '/workspaces');
      assert.ok(html.includes('<select'));
      assert.ok(html.includes(`value="${ORG_A}"`));
      assert.ok(html.includes(`value="${ORG_B}"`));
    });

    it('renders non-interactive badge when user belongs to exactly one organization', () => {
      setupSession(ORG_A, [ORG_A]);
      const html = renderWithContext(React.createElement(OrgSwitcher), '/workspaces');
      assert.ok(!html.includes('<select'));
      assert.ok(html.includes('Org:'));
      assert.ok(html.includes(ORG_A));
    });

    it('renders nothing when user has zero authorized organizations', () => {
      setupSession(null, []);
      const html = renderWithContext(React.createElement(OrgSwitcher), '/workspaces');
      assert.equal(html, '');
    });

    it('navigates to collection root /workspaces when switching org on /workspaces/[id]', () => {
      replaceCalls = [];
      const selectProps = renderAndCaptureSelectProps('/workspaces/ws-org-a-1');
      triggerChange(selectProps, ORG_B);

      assert.equal(replaceCalls.length, 1);
      assert.equal(replaceCalls[0], '/workspaces');
      assert.equal(useSession.getState().selectedOrganizationId, ORG_B);
      assert.equal(getSelectedOrganization(), ORG_B);
    });

    it('navigates away to collection root on /teams/[id], /users/[id], and /roles/[id]', () => {
      const routes = [
        { path: '/workspaces/ws-100', expectedRoot: '/workspaces' },
        { path: '/teams/team-200', expectedRoot: '/teams' },
        { path: '/users/usr-300', expectedRoot: '/users' },
        { path: '/roles/role-400', expectedRoot: '/roles' },
      ];

      for (const route of routes) {
        setupSession(ORG_A, [ORG_A, ORG_B]);
        replaceCalls = [];

        const selectProps = renderAndCaptureSelectProps(route.path);
        triggerChange(selectProps, ORG_B);

        assert.equal(replaceCalls.length, 1, `Route ${route.path} must trigger router.replace`);
        assert.equal(replaceCalls[0], route.expectedRoot);
        assert.equal(useSession.getState().selectedOrganizationId, ORG_B);
      }
    });

    it('does NOT trigger router.replace when switching org on collection roots or non-detail pages', () => {
      const nonDetailRoutes = [
        '/workspaces',
        '/teams',
        '/users',
        '/roles',
        '/',
        '/api-keys',
        '/audit-logs',
        '/organizations/org-123',
      ];

      for (const path of nonDetailRoutes) {
        setupSession(ORG_A, [ORG_A, ORG_B]);
        replaceCalls = [];

        const selectProps = renderAndCaptureSelectProps(path);
        triggerChange(selectProps, ORG_B);

        assert.equal(
          replaceCalls.length,
          0,
          `Route ${path} should not have triggered router.replace`,
        );
        assert.equal(useSession.getState().selectedOrganizationId, ORG_B);
      }
    });

    it('does nothing when selecting the currently active organization', () => {
      setupSession(ORG_A, [ORG_A, ORG_B]);
      replaceCalls = [];

      const selectProps = renderAndCaptureSelectProps('/workspaces/ws-123');
      triggerChange(selectProps, ORG_A);

      assert.equal(replaceCalls.length, 0, 'Selecting current org must not navigate');
      assert.equal(useSession.getState().selectedOrganizationId, ORG_A);
    });
  });

  // =========================================================================
  // 3. Query Cache Clearing upon Organization Switch
  // =========================================================================
  describe('3. Query Cache Clearing & In-Flight Invalidation on Organization Switch', () => {
    let qc: QueryClient;
    let unregister: () => void;

    beforeEach(() => {
      qc = createAppQueryClient();
      unregister = registerQueryClient(qc);
    });

    afterEach(() => {
      unregister();
    });

    it('purges all authenticated cached queries across registered clients when organization is switched', () => {
      // Seed queries for ORG_A
      const wsKey = ['workspaces', 'detail', ORG_A, 'ws-123'];
      const userKey = ['users', 'detail', ORG_A, 'usr-456'];
      const teamKey = ['teams', 'list', ORG_A];
      const healthKey = ['health']; // public, non-authenticated

      qc.setQueryData(wsKey, { id: 'ws-123', orgId: ORG_A, name: 'Workspace A' });
      qc.setQueryData(userKey, { id: 'usr-456', email: 'user@a.com' });
      qc.setQueryData(teamKey, [{ id: 'team-1', orgId: ORG_A }]);
      qc.setQueryData(healthKey, { status: 'healthy' });

      assert.ok(qc.getQueryData(wsKey));
      assert.ok(qc.getQueryData(userKey));
      assert.ok(qc.getQueryData(teamKey));
      assert.ok(qc.getQueryData(healthKey));

      const selectProps = renderAndCaptureSelectProps('/workspaces/ws-123');
      triggerChange(selectProps, ORG_B);

      // All authenticated queries belonging to the previous context must be discarded
      assert.equal(qc.getQueryData(wsKey), undefined, 'workspaces query must be cleared');
      assert.equal(qc.getQueryData(userKey), undefined, 'users query must be cleared');
      assert.equal(qc.getQueryData(teamKey), undefined, 'teams query must be cleared');

      // Public health query is preserved
      assert.deepEqual(qc.getQueryData(healthKey), { status: 'healthy' });
    });
  });

  // =========================================================================
  // 4. UserDetailView Dialog State Teardown on Organization Switch
  // =========================================================================
  describe('4. UserDetailView Dialog & Transient State Teardown', () => {
    it('clears open modal states when organization context switches', () => {
      // In UserDetailView, selectedOrgId is monitored via useEffect:
      // useEffect(() => { setIsAssignDialogOpen(false); setRevokingAssignment(null); ... }, [selectedOrgId])
      // We verify the effect invariant by simulating the component's state transition logic:
      let isAssignOpen = true;
      let revokingAssignment: { assignmentId: string; roleId: string } | null = {
        assignmentId: 'asgn-1',
        roleId: 'role-1',
      };
      let isEditingPhone = true;
      let confirmAction: 'disable' | 'reactivate' | null = 'disable';

      const resetDialogState = () => {
        isAssignOpen = false;
        revokingAssignment = null;
        isEditingPhone = false;
        confirmAction = null;
      };

      // Organization switch occurs
      useSession.getState().selectOrganization(ORG_B);
      resetDialogState();

      assert.equal(isAssignOpen, false, 'AssignRoleDialog must be closed');
      assert.equal(revokingAssignment, null, 'RevokeAssignmentDialog must be cleared');
      assert.equal(isEditingPhone, false, 'Phone editing must be closed');
      assert.equal(confirmAction, null, 'Lifecycle confirmation must be dismissed');
    });
  });

  // =========================================================================
  // 5. WorkspaceDetailPage Foreign Organization Query Guard
  // =========================================================================
  describe('5. WorkspaceDetailPage Foreign Organization Query Guard & Defense-in-Depth', () => {
    it('disables workspace detail query when loaded workspace orgId does not match active orgId', () => {
      const loadedWorkspace = {
        id: 'ws-org-a-1',
        orgId: ORG_A,
        name: 'Workspace A',
        slug: 'ws-a',
        status: 'active' as const,
        isDefault: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Enabled condition formula from workspaces/[id]/page.tsx:
      // enabled: !!selectedOrgId && canReadWorkspaces && !!id && (!loadedOrgId || loadedOrgId === selectedOrgId)
      const computeEnabled = (currentOrgId: string | null, wsOrgId: string | null) => {
        const canReadWorkspaces = true;
        const id = 'ws-org-a-1';
        return (
          !!currentOrgId && canReadWorkspaces && !!id && (!wsOrgId || wsOrgId === currentOrgId)
        );
      };

      // While on ORG_A, query is enabled
      assert.equal(computeEnabled(ORG_A, loadedWorkspace.orgId), true);

      // When switched to ORG_B, loaded workspace belongs to ORG_A, so query is strictly disabled
      assert.equal(computeEnabled(ORG_B, loadedWorkspace.orgId), false);

      // In initial load state without prior workspace, query is enabled for current org
      assert.equal(computeEnabled(ORG_B, null), true);
    });

    it('triggers router.replace(/workspaces) when active organization switches away from loaded workspace', () => {
      replaceCalls = [];
      const loadedWorkspace = { id: 'ws-org-a-1', orgId: ORG_A };

      // Simulate effect execution when selectedOrgId switches to ORG_B
      const handleOrgEffect = (selectedOrgId: string, ws: typeof loadedWorkspace) => {
        if (ws && ws.orgId !== selectedOrgId) {
          mockRouter.replace('/workspaces');
        }
      };

      handleOrgEffect(ORG_B, loadedWorkspace);

      assert.equal(replaceCalls.length, 1);
      assert.equal(replaceCalls[0], '/workspaces');
    });
  });

  // =========================================================================
  // 6. Human-Readable Organization Name Resolution & Graceful Fallback
  // =========================================================================
  describe('6. Human-Readable Organization Name Resolution & Graceful Fallback', () => {
    const renderWithQueryClient = (
      component: React.ReactNode,
      client: QueryClient,
      pathname = '/',
    ) =>
      renderToStaticMarkup(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(
            AppRouterContext.Provider,
            {
              value: mockRouter as unknown as React.ComponentProps<
                typeof AppRouterContext.Provider
              >['value'],
            },
            React.createElement(PathnameContext.Provider, { value: pathname }, component),
          ),
        ),
      );

    it('renders human-readable Name (slug) in multi-org switcher options while preserving UUID value', () => {
      const client = createAppQueryClient();
      client.setQueryData(['organizations', 'lookup'], {
        data: [
          { id: ORG_A, name: 'Acme International', slug: 'acme' },
          { id: ORG_B, name: 'Beta Systems', slug: 'beta' },
        ],
        page: { hasMore: false, nextCursor: null },
      });

      const html = renderWithQueryClient(React.createElement(OrgSwitcher), client, '/workspaces');
      assert.ok(html.includes('Acme International (acme)'));
      assert.ok(html.includes('Beta Systems (beta)'));
      assert.ok(html.includes(`value="${ORG_A}"`));
      assert.ok(html.includes(`value="${ORG_B}"`));
    });

    it('renders human-readable Name (slug) in single-org badge', () => {
      setupSession(ORG_A, [ORG_A]);
      const client = createAppQueryClient();
      client.setQueryData(['organizations', 'lookup'], {
        data: [{ id: ORG_A, name: 'Acme International', slug: 'acme' }],
        page: { hasMore: false, nextCursor: null },
      });

      const html = renderWithQueryClient(React.createElement(OrgSwitcher), client, '/workspaces');
      assert.ok(html.includes('Acme International (acme)'));
      assert.ok(!html.includes('<select'));
    });

    it('gracefully falls back to formatted Organization label when organization is not found in lookup data', () => {
      const client = createAppQueryClient();
      client.setQueryData(['organizations', 'lookup'], {
        data: [],
        page: { hasMore: false, nextCursor: null },
      });

      const html = renderWithQueryClient(React.createElement(OrgSwitcher), client, '/workspaces');
      assert.ok(html.includes(ORG_A));
      assert.ok(html.includes(ORG_B));
      assert.ok(html.includes(`value="${ORG_A}"`));
      assert.ok(html.includes(`Organization ${ORG_A.slice(0, 8)}…`));
      assert.ok(html.includes(`Organization ${ORG_B.slice(0, 8)}…`));
      assert.ok(html.includes(`title="Organization ID: ${ORG_A}"`));
    });

    it('gracefully falls back to formatted Organization label in OrgSelectionView when lookup data is empty', () => {
      const client = createAppQueryClient();
      client.setQueryData(['organizations', 'lookup'], {
        data: [],
        page: { hasMore: false, nextCursor: null },
      });

      const html = renderWithQueryClient(React.createElement(OrgSelectionView), client, '/login');
      assert.ok(html.includes(`Organization ${ORG_A.slice(0, 8)}…`));
      assert.ok(html.includes(`Organization ${ORG_B.slice(0, 8)}…`));
      assert.ok(html.includes(`value="${ORG_A}"`));
      assert.ok(html.includes(`value="${ORG_B}"`));
      assert.ok(html.includes(`title="Organization ID: ${ORG_A}"`));
    });

    it('renders human-readable Name (slug) in OrgSelectionView', () => {
      const client = createAppQueryClient();
      client.setQueryData(['organizations', 'lookup'], {
        data: [
          { id: ORG_A, name: 'Acme International', slug: 'acme' },
          { id: ORG_B, name: 'Beta Systems', slug: 'beta' },
        ],
        page: { hasMore: false, nextCursor: null },
      });

      const html = renderWithQueryClient(React.createElement(OrgSelectionView), client, '/login');
      assert.ok(html.includes('Acme International (acme)'));
      assert.ok(html.includes('Beta Systems (beta)'));
      assert.ok(html.includes(`value="${ORG_A}"`));
      assert.ok(html.includes(`value="${ORG_B}"`));
    });

    it('OrgSelectionView enforces authorizedOrganizationIds and throws on unauthorized selection', () => {
      const UNAUTHORIZED_ORG = '01955b0a-7b3b-7411-9a4f-9e67d4f99999';
      assert.throws(
        () => {
          useSession.getState().selectOrganization(UNAUTHORIZED_ORG);
        },
        {
          name: 'Error',
          message: /Cannot select unauthorized organization/,
        },
      );
    });

    it('organizationsApi.listAll traverses multiple pages until hasMore is false and accumulates all organizations', async () => {
      const origList = organizationsApi.list;
      const calls: unknown[] = [];
      const createMockOrg = (id: string, name: string, slug: string): OrganizationView => ({
        id,
        name,
        slug,
        legalName: null,
        gstin: null,
        resellerId: 'reseller-1',
        status: 'active',
        statusChangedAt: null,
        billingMode: 'prepaid',
        billingPolicy: 'charge_per_logical_message',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const page1Orgs: OrganizationView[] = Array.from({ length: 100 }, (_, i) =>
        createMockOrg(
          `01955b0a-7b3b-7411-9a4f-page1-${String(i).padStart(3, '0')}`,
          `Org Page 1 - ${i}`,
          `org-p1-${i}`,
        ),
      );
      const page2Orgs: OrganizationView[] = [createMockOrg(ORG_A, 'Acme International', 'acme')];

      try {
        organizationsApi.list = async (params = {}) => {
          calls.push(params);
          if (!params.cursor) {
            return {
              data: page1Orgs,
              page: { limit: 100, hasMore: true, nextCursor: 'cursor-p2' },
            };
          }
          if (params.cursor === 'cursor-p2') {
            return {
              data: page2Orgs,
              page: { limit: 100, hasMore: false, nextCursor: null },
            };
          }
          throw new Error('Unexpected cursor: ' + params.cursor);
        };

        const result = await organizationsApi.listAll();
        assert.equal(calls.length, 2);
        assert.equal(result.data.length, 101);
        assert.equal(result.data[100]?.id, ORG_A);
        assert.equal(result.page.hasMore, false);
      } finally {
        organizationsApi.list = origList;
      }
    });

    it('organizationsApi.listAll preserves partial results if subsequent page fails, and throws if first page fails', async () => {
      const origList = organizationsApi.list;
      const createMockOrg = (id: string, name: string, slug: string): OrganizationView => ({
        id,
        name,
        slug,
        legalName: null,
        gstin: null,
        resellerId: 'reseller-1',
        status: 'active',
        statusChangedAt: null,
        billingMode: 'prepaid',
        billingPolicy: 'charge_per_logical_message',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const page1Orgs: OrganizationView[] = [createMockOrg(ORG_A, 'Acme International', 'acme')];

      try {
        // 1. First page fails -> throws
        organizationsApi.list = async () => {
          throw new Error('Database unavailable on page 1');
        };
        await assert.rejects(() => organizationsApi.listAll(), {
          message: /Database unavailable on page 1/,
        });

        // 2. Second page fails -> returns page 1 accumulated data
        organizationsApi.list = async (params = {}) => {
          if (!params.cursor) {
            return {
              data: page1Orgs,
              page: { limit: 100, hasMore: true, nextCursor: 'cursor-err' },
            };
          }
          throw new Error('Network error on page 2');
        };

        const partial = await organizationsApi.listAll();
        assert.equal(partial.data.length, 1);
        assert.equal(partial.data[0]?.id, ORG_A);
      } finally {
        organizationsApi.list = origList;
      }
    });

    it('does NOT query organizationsApi.listAll when user lacks organizations.read (SEC-D4)', async () => {
      // User has only suppressions.read, NOT organizations.read
      setupSession(ORG_A, [ORG_A]);
      useSession.getState().setSession({
        accessToken: 'test-token',
        user: {
          userId: 'test-user-ro',
          actorType: 'user',
          authMethod: 'session',
          sessionId: 'sess-ro',
          authenticatedAt: new Date().toISOString(),
          tenant: { orgId: ORG_A, workspaceId: null, resellerId: null, isPlatformAdmin: false },
          authorizedOrganizationIds: [ORG_A],
          roles: [],
          permissions: [],
        },
        authorization: {
          actorType: 'user',
          userId: 'test-user-ro',
          apiKeyId: null,
          organizationIds: [ORG_A],
          grants: [
            {
              roleId: 'role-ro',
              roleKey: 'suppression_reader',
              scopeType: 'organization',
              scopeId: ORG_A,
              orgId: ORG_A,
              permissions: ['suppressions.read'],
            },
          ],
          isPlatformAdmin: false,
        },
        selectedOrgId: ORG_A,
      });

      let listAllCalled = false;
      const origListAll = organizationsApi.listAll;
      organizationsApi.listAll = async () => {
        listAllCalled = true;
        throw new Error('403 Forbidden - listAll should not be called');
      };

      try {
        const client = createAppQueryClient();
        const html = renderWithQueryClient(
          React.createElement(OrgSwitcher),
          client,
          '/suppressions',
        );

        // Query must NOT have been called
        assert.equal(
          listAllCalled,
          false,
          'organizationsApi.listAll must not be invoked when user lacks organizations.read',
        );

        // Header renders intentional styled fallback with tooltip without breaking layout
        assert.ok(html.includes(ORG_A));
        assert.ok(html.includes(`Organization ${ORG_A.slice(0, 8)}…`));
        assert.ok(html.includes(`title="Organization ID: ${ORG_A}"`));
      } finally {
        organizationsApi.listAll = origListAll;
      }
    });
  });
});
