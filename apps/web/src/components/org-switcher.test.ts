import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

import { OrgSwitcher } from './org-switcher';
import { useSession } from '../lib/session-store';
import type { EffectiveAuthorization, UserIdentity } from '../lib/api-client';

(globalThis as unknown as { React: typeof React }).React = React;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

describe('OrgSwitcher Component Behavior & Formats (U1)', () => {
  const ORG_A = '01955b0a-7b3b-7411-9a4f-9e67d4f90001';
  const ORG_B = '01955b0a-7b3b-7411-9a4f-9e67d4f90002';

  const mockRouter = {
    back: () => {},
    forward: () => {},
    refresh: () => {},
    push: () => {},
    replace: () => {},
    prefetch: () => {},
  };

  const setupSession = (
    selectedOrg: string | null = ORG_A,
    authorizedOrgs: string[] = [ORG_A, ORG_B],
    isPlatformAdmin = true,
  ) => {
    const user: UserIdentity = {
      userId: 'test-user-1',
      actorType: 'user',
      authMethod: 'session',
      sessionId: 'sess-1',
      authenticatedAt: new Date().toISOString(),
      tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin },
      authorizedOrganizationIds: authorizedOrgs,
      roles: [],
      permissions: [],
    };

    const authorization: EffectiveAuthorization = {
      actorType: 'user',
      userId: 'test-user-1',
      apiKeyId: null,
      organizationIds: authorizedOrgs,
      grants: [
        {
          roleId: 'role-org-admin',
          roleKey: 'org_admin',
          scopeType: 'organization',
          scopeId: ORG_A,
          orgId: ORG_A,
          permissions: ['organizations.read'],
        },
      ],
      isPlatformAdmin,
    };

    useSession.getState().setSession({
      accessToken: 'test-token',
      user,
      authorization,
      selectedOrgId: selectedOrg,
    });
  };

  const renderWithProviders = (client: QueryClient, pathname = '/workspaces') => {
    return renderToStaticMarkup(
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
            QueryClientProvider,
            { client },
            React.createElement(OrgSwitcher),
          ),
        ),
      ),
    );
  };

  beforeEach(() => {
    setupSession();
  });

  afterEach(() => {
    useSession.getState().clearSession();
  });

  describe('Single-Organization User', () => {
    beforeEach(() => {
      setupSession(ORG_A, [ORG_A]);
    });

    it('renders resolved name in single-org badge with title tooltip', () => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      client.setQueryData(['organizations', 'lookup'], {
        data: [{ id: ORG_A, name: 'Acme International', slug: 'acme' }],
        page: { hasMore: false, nextCursor: null },
      });

      const html = renderWithProviders(client);

      assert.ok(html.includes('Org:'));
      assert.ok(html.includes('Acme International (acme)'));
      assert.ok(html.includes('title="Acme International (acme)"'));
      assert.ok(!html.includes('<select'), 'Must render badge, not select for single org');
    });

    it('renders formatted fallback "Organization ${id.slice(0, 8)}…" with full UUID in tooltip when unresolved', () => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      client.setQueryData(['organizations', 'lookup'], {
        data: [],
        page: { hasMore: false, nextCursor: null },
      });

      const html = renderWithProviders(client);

      const fallback = `Organization ${ORG_A.slice(0, 8)}…`;
      assert.ok(html.includes(fallback));
      assert.ok(html.includes(`title="Organization ID: ${ORG_A}"`));
      assert.ok(!html.includes('<select'));
    });

    it('renders "resolving…" with role="status" when lookup is in loading state', () => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      const query = client.getQueryCache().build(client, { queryKey: ['organizations', 'lookup'] });
      query.setState({
        status: 'pending',
        fetchStatus: 'fetching',
        data: undefined,
        error: null,
        dataUpdatedAt: 0,
        errorUpdatedAt: 0,
      });

      const html = renderWithProviders(client);

      assert.ok(html.includes('resolving…'));
      assert.ok(html.includes('role="status"'));
      assert.ok(html.includes(`Organization ${ORG_A.slice(0, 8)}…`));
    });
  });

  describe('Multi-Organization User', () => {
    it('renders resolved names in select dropdown options with titles', () => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      client.setQueryData(['organizations', 'lookup'], {
        data: [
          { id: ORG_A, name: 'Acme International', slug: 'acme' },
          { id: ORG_B, name: 'Beta Systems', slug: 'beta' },
        ],
        page: { hasMore: false, nextCursor: null },
      });

      const html = renderWithProviders(client);

      assert.ok(html.includes('<select id="org-select"'));
      assert.ok(html.includes('Acme International (acme)'));
      assert.ok(html.includes('Beta Systems (beta)'));
      assert.ok(html.includes(`value="${ORG_A}"`));
      assert.ok(html.includes(`value="${ORG_B}"`));
      assert.ok(html.includes('title="Acme International (acme)"'));
      assert.ok(html.includes('title="Beta Systems (beta)"'));
    });

    it('falls back to "Organization ${id.slice(0, 8)}…" preserving full UUID in value and title when unresolved', () => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      client.setQueryData(['organizations', 'lookup'], {
        data: [],
        page: { hasMore: false, nextCursor: null },
      });

      const html = renderWithProviders(client);

      const fallbackA = `Organization ${ORG_A.slice(0, 8)}…`;
      const fallbackB = `Organization ${ORG_B.slice(0, 8)}…`;
      assert.ok(html.includes(fallbackA));
      assert.ok(html.includes(fallbackB));
      assert.ok(html.includes(`value="${ORG_A}"`));
      assert.ok(html.includes(`value="${ORG_B}"`));
      assert.ok(html.includes(`title="Organization ID: ${ORG_A}"`));
      assert.ok(html.includes(`title="Organization ID: ${ORG_B}"`));
    });

    it('renders "resolving…" with role="status" alongside select without disabling select', () => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      const query = client.getQueryCache().build(client, { queryKey: ['organizations', 'lookup'] });
      query.setState({
        status: 'pending',
        fetchStatus: 'fetching',
        data: undefined,
        error: null,
        dataUpdatedAt: 0,
        errorUpdatedAt: 0,
      });

      const html = renderWithProviders(client);

      assert.ok(html.includes('resolving…'));
      assert.ok(html.includes('role="status"'));
      assert.ok(html.includes('<select id="org-select"'));
      assert.ok(!html.includes('disabled'), 'Select must not be disabled during loading');
      assert.ok(html.includes(`value="${ORG_A}"`));
    });

    it('remains non-blocking on lookup error with fallback labels', () => {
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, staleTime: Infinity } },
      });
      const query = client.getQueryCache().build(client, { queryKey: ['organizations', 'lookup'] });
      query.setState({
        status: 'error',
        fetchStatus: 'idle',
        data: undefined,
        error: new Error('Network error'),
        dataUpdatedAt: 0,
        errorUpdatedAt: Date.now(),
      });

      const html = renderWithProviders(client);

      assert.ok(html.includes('<select id="org-select"'));
      assert.ok(html.includes(`Organization ${ORG_A.slice(0, 8)}…`));
      assert.ok(html.includes(`value="${ORG_A}"`));
    });
  });

  describe('Zero-Organization User', () => {
    it('renders null when authorizedOrganizationIds is empty', () => {
      setupSession(null, []);
      const client = new QueryClient();
      const html = renderWithProviders(client);
      assert.equal(html, '');
    });
  });
});
