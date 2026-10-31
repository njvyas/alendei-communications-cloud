import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { OrgSelectionView } from './org-selection-view';
import { useSession } from '../lib/session-store';
import type { EffectiveAuthorization, UserIdentity } from '../lib/api-client';

(globalThis as unknown as { React: typeof React }).React = React;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

describe('OrgSelectionView Component Behavior & Formats (U1)', () => {
  const ORG_A = '01955b0a-7b3b-7411-9a4f-9e67d4f90001';
  const ORG_B = '01955b0a-7b3b-7411-9a4f-9e67d4f90002';
  const UNAUTHORIZED_ORG = '01955b0a-7b3b-7411-9a4f-9e67d4f99999';

  const setupSession = (authorizedOrgs = [ORG_A, ORG_B], isPlatformAdmin = true) => {
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
      selectedOrgId: null,
    });
  };

  const renderWithQueryClient = (client: QueryClient) => {
    return renderToStaticMarkup(
      React.createElement(QueryClientProvider, { client }, React.createElement(OrgSelectionView)),
    );
  };

  beforeEach(() => {
    setupSession();
  });

  afterEach(() => {
    useSession.getState().clearSession();
  });

  it('renders resolved organization names as "${name} (${slug})" with complete UUID in value and title', () => {
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

    const html = renderWithQueryClient(client);

    assert.ok(html.includes('Acme International (acme)'));
    assert.ok(html.includes('Beta Systems (beta)'));
    assert.ok(html.includes(`value="${ORG_A}"`));
    assert.ok(html.includes(`value="${ORG_B}"`));
    assert.ok(html.includes('title="Acme International (acme)"'));
    assert.ok(html.includes('title="Beta Systems (beta)"'));
    assert.ok(html.includes('Enter Console'));
    assert.ok(html.includes('Sign out'));
  });

  it('falls back to "Organization ${id.slice(0, 8)}…" and preserves full UUID in value and title when lookup returns empty', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(['organizations', 'lookup'], {
      data: [],
      page: { hasMore: false, nextCursor: null },
    });

    const html = renderWithQueryClient(client);

    const fallbackA = `Organization ${ORG_A.slice(0, 8)}…`;
    const fallbackB = `Organization ${ORG_B.slice(0, 8)}…`;
    assert.ok(html.includes(fallbackA));
    assert.ok(html.includes(fallbackB));
    assert.ok(html.includes(`value="${ORG_A}"`));
    assert.ok(html.includes(`value="${ORG_B}"`));
    assert.ok(html.includes(`title="Organization ID: ${ORG_A}"`));
    assert.ok(html.includes(`title="Organization ID: ${ORG_B}"`));
  });

  it('displays "resolving names…" with role="status" when lookup is in loading state', () => {
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

    const html = renderWithQueryClient(client);

    assert.ok(html.includes('resolving names…'));
    assert.ok(html.includes('role="status"'));
    // Fallback options must still be interactive and populated while loading
    assert.ok(html.includes(`value="${ORG_A}"`));
    assert.ok(html.includes(`Organization ${ORG_A.slice(0, 8)}…`));
  });

  it('fails gracefully and remains non-blocking on lookup error', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const query = client.getQueryCache().build(client, { queryKey: ['organizations', 'lookup'] });
    query.setState({
      status: 'error',
      fetchStatus: 'idle',
      data: undefined,
      error: new Error('Network timeout'),
      dataUpdatedAt: 0,
      errorUpdatedAt: Date.now(),
    });

    const html = renderWithQueryClient(client);

    // Form remains rendered and accessible with fallback labels
    assert.ok(html.includes(`Organization ${ORG_A.slice(0, 8)}…`));
    assert.ok(html.includes(`value="${ORG_A}"`));
    assert.ok(html.includes('Enter Console'));
  });

  it('enforces authorizedOrganizationIds and throws on unauthorized selection', () => {
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
});
