import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

import ConsoleLayout from '../../app/(console)/layout';
import PlatformSupportPage from '../../app/(console)/support/page';
import {
  platformSupportApi,
  type EffectiveAuthorization,
  type UserIdentity,
} from '../../lib/api-client';
import { useSession } from '../../lib/session-store';

(globalThis as unknown as { React: typeof React }).React = React;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

describe('U13.4 Platform Support & Operations Cockpit (Frontend Component & Security Tests)', () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  const mockRouter = {
    push: () => {},
    replace: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  };

  const renderWithProviders = (ui: React.ReactElement, pathname = '/support') =>
    renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          AppRouterContext.Provider,
          {
            value: mockRouter as unknown as React.ComponentProps<
              typeof AppRouterContext.Provider
            >['value'],
          },
          React.createElement(PathnameContext.Provider, { value: pathname }, ui),
        ),
      ),
    );

  beforeEach(() => {
    useSession.getState().clearSession();
  });

  it('renders Access Restricted when principal lacks platform.support.read', () => {
    const tenantUser: UserIdentity = {
      userId: '0192e200-0000-7000-8000-000000000001',
      actorType: 'user',
      authMethod: 'session',
      sessionId: 'session-1',
      authenticatedAt: new Date().toISOString(),
      tenant: {
        orgId: '0192e200-0000-7000-8000-000000000002',
        workspaceId: null,
        resellerId: null,
        isPlatformAdmin: false,
      },
      authorizedOrganizationIds: ['0192e200-0000-7000-8000-000000000002'],
      roles: [],
      permissions: ['organizations.read', 'users.read', 'messages.read'],
    };

    const tenantAuth: EffectiveAuthorization = {
      actorType: 'user',
      userId: tenantUser.userId,
      apiKeyId: null,
      organizationIds: ['0192e200-0000-7000-8000-000000000002'],
      isPlatformAdmin: false,
      grants: [
        {
          roleId: '0192e200-0000-7000-8000-000000000003',
          roleKey: 'org_admin',
          scopeType: 'organization',
          scopeId: '0192e200-0000-7000-8000-000000000002',
          orgId: '0192e200-0000-7000-8000-000000000002',
          permissions: ['organizations.read', 'users.read', 'messages.read'],
        },
      ],
    };

    useSession.getState().setSession({
      accessToken: 'test-token',
      user: tenantUser,
      authorization: tenantAuth,
      selectedOrgId: '0192e200-0000-7000-8000-000000000002',
    });

    // 1. Navigation link to /support should NOT appear in shell for tenant admin
    const layoutMarkup = renderWithProviders(
      React.createElement(ConsoleLayout, null, React.createElement('div', null, 'Content')),
      '/',
    );
    assert.strictEqual(
      layoutMarkup.includes('/support'),
      false,
      'Support navigation link must not be visible to tenant user',
    );

    // 2. Direct page access renders Access Restricted guard
    const pageMarkup = renderWithProviders(React.createElement(PlatformSupportPage));
    assert.ok(
      pageMarkup.includes('Access Restricted'),
      'Access Restricted message must be displayed',
    );
    assert.ok(
      pageMarkup.includes('platform.support.read'),
      'Permission requirement must be stated',
    );
  });

  it('renders Platform Support Cockpit when principal holds platform.support.read', () => {
    const supportUser: UserIdentity = {
      userId: '0192e200-0000-7000-8000-000000000004',
      actorType: 'user',
      authMethod: 'session',
      sessionId: 'session-2',
      authenticatedAt: new Date().toISOString(),
      tenant: {
        orgId: null,
        workspaceId: null,
        resellerId: null,
        isPlatformAdmin: false,
      },
      authorizedOrganizationIds: ['0192e200-0000-7000-8000-000000000002'],
      roles: [],
      permissions: ['platform.support.read'],
    };

    const supportAuth: EffectiveAuthorization = {
      actorType: 'user',
      userId: supportUser.userId,
      apiKeyId: null,
      organizationIds: ['0192e200-0000-7000-8000-000000000002'],
      isPlatformAdmin: false,
      grants: [
        {
          roleId: '0192e200-0000-7000-8000-000000000005',
          roleKey: 'alendei_support',
          scopeType: 'platform',
          scopeId: null,
          orgId: null,
          permissions: ['platform.support.read'],
        },
      ],
    };

    useSession.getState().setSession({
      accessToken: 'test-token',
      user: supportUser,
      authorization: supportAuth,
      selectedOrgId: '0192e200-0000-7000-8000-000000000002',
    });

    // 1. Navigation link to /support should appear in shell
    const layoutMarkup = renderWithProviders(
      React.createElement(ConsoleLayout, null, React.createElement('div', null, 'Content')),
      '/',
    );
    assert.ok(
      layoutMarkup.includes('/support'),
      'Support navigation link must be visible to platform support operator',
    );
    assert.ok(
      layoutMarkup.includes('Support &amp; Ops') || layoutMarkup.includes('Support & Ops'),
      'Section label must be rendered',
    );

    // 2. Cockpit page renders header, target input, and tabs
    const pageMarkup = renderWithProviders(React.createElement(PlatformSupportPage));
    assert.ok(pageMarkup.includes('Platform Support Cockpit'), 'Cockpit title must be present');
    assert.ok(pageMarkup.includes('platform.support.read'), 'Permission badge must be present');
    assert.ok(
      pageMarkup.includes('Overview &amp; Hierarchy') ||
        pageMarkup.includes('Overview & Hierarchy'),
    );
    assert.ok(
      pageMarkup.includes('Routing &amp; Providers') || pageMarkup.includes('Routing & Providers'),
    );
    assert.ok(
      pageMarkup.includes('Dispatch &amp; Failures') || pageMarkup.includes('Dispatch & Failures'),
    );
    assert.ok(pageMarkup.includes('Cross-Tenant Audit Search'));
  });

  it('admits support operator in zero_organizations status to /support', () => {
    const platformSupportUser: UserIdentity = {
      userId: '0192e200-0000-7000-8000-000000000006',
      actorType: 'user',
      authMethod: 'session',
      sessionId: 'session-3',
      authenticatedAt: new Date().toISOString(),
      tenant: {
        orgId: null,
        workspaceId: null,
        resellerId: null,
        isPlatformAdmin: false,
      },
      authorizedOrganizationIds: [], // Holds zero tenant organizations
      roles: [],
      permissions: ['platform.support.read'],
    };

    const platformSupportAuth: EffectiveAuthorization = {
      actorType: 'user',
      userId: platformSupportUser.userId,
      apiKeyId: null,
      organizationIds: [],
      isPlatformAdmin: false,
      grants: [
        {
          roleId: '0192e200-0000-7000-8000-000000000005',
          roleKey: 'alendei_support',
          scopeType: 'platform',
          scopeId: null,
          orgId: null,
          permissions: ['platform.support.read'],
        },
      ],
    };

    useSession.getState().setSession({
      accessToken: 'test-token',
      user: platformSupportUser,
      authorization: platformSupportAuth,
    });

    assert.strictEqual(useSession.getState().status, 'zero_organizations');

    // Shell should admit /support navigation and not display the ZeroOrgView blocker
    const layoutMarkup = renderWithProviders(
      React.createElement(ConsoleLayout, null, React.createElement(PlatformSupportPage)),
      '/support',
    );
    assert.ok(
      layoutMarkup.includes('Platform Support Cockpit'),
      'Cockpit must render for platform operator in zero_organizations status',
    );
    assert.strictEqual(
      layoutMarkup.includes('No organizations assigned'),
      false,
      'ZeroOrgView blocker must not trap platform support operator',
    );
  });

  it('verifies platformSupportApi client contract definitions and endpoints', () => {
    assert.strictEqual(typeof platformSupportApi.getOverview, 'function');
    assert.strictEqual(typeof platformSupportApi.getRouting, 'function');
    assert.strictEqual(typeof platformSupportApi.getDispatch, 'function');
    assert.strictEqual(typeof platformSupportApi.searchAudit, 'function');
  });

  // U13.4 review F-1, F-2, F-4: the support views have no recipient, message
  // content, failure text, actor email, IP address or user agent to render,
  // and must not grow one. Read as source so a field added later fails here.
  it('support views render no recipient, content, failure text or personal audit fields', () => {
    const dir = join(__dirname);
    for (const file of [
      'support-dispatch-tab.tsx',
      'support-audit-tab.tsx',
      'support-overview-tab.tsx',
      'support-routing-tab.tsx',
    ]) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const forbidden of [
        /maskedRecipient|recipientAddress/,
        /failureReason/,
        /\.payload\b/,
        /actorEmail/,
        /\.userAgent\b/,
        /\.ip\b/,
      ]) {
        assert.doesNotMatch(source, forbidden, `${file} references ${forbidden}`);
      }
    }
  });

  it('dispatch diagnostics send only parameters the API accepts', async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          data: {
            queue: { pendingCount: 0, delayedCount: 0, claimedCount: 0 },
            recentMessages: [],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      await platformSupportApi.getDispatch('org-1', {
        limit: 25,
        status: 'failed',
        channel: 'sms',
      });
    } catch {
      // Session plumbing may refuse outside the browser; the request URL is what matters.
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.ok(calls.length > 0, 'getDispatch issued no request');
    for (const call of calls) {
      const query = new URL(call, 'http://localhost').searchParams;
      for (const key of query.keys()) {
        assert.ok(['limit', 'status', 'channel'].includes(key), `unexpected parameter ${key}`);
      }
    }
  });
});
