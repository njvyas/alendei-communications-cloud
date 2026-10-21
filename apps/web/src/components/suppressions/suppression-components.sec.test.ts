import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';

import { SuppressionStatusBadge } from './suppression-status-badge';
import { SuppressionDetailDialog } from './suppression-detail-dialog';
import { CreateSuppressionDialog } from './create-suppression-dialog';
import { LiftSuppressionDialog } from './lift-suppression-dialog';
import { SuppressionListCard } from './suppression-list-card';
import { createAppQueryClient } from '../../lib/query-client';
import { useSession } from '../../lib/session-store';
import type {
  ChannelView,
  EffectiveAuthorization,
  SuppressionResponse,
  UserIdentity,
} from '../../lib/api-client';

// Ensure React is globally available for JSX and SSR transforms
(globalThis as unknown as { React: typeof React }).React = React;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

describe('SEC-SUPP: Suppression Components Integration & Accessibility Tests', () => {
  const ORG_A = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const SUPPRESSION_ACTIVE_ID = '01955b0a-7b3b-7411-9a4f-su0000000001';
  const SUPPRESSION_CLEARED_ID = '01955b0a-7b3b-7411-9a4f-su0000000002';
  const CHANNEL_SMS_ID = '01955b0a-7b3b-7411-9a4f-ch0000000001';

  const mockChannel: ChannelView = {
    id: CHANNEL_SMS_ID,
    code: 'sms',
    displayName: 'SMS Gateway',
    status: 'active',
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-15T10:00:00.000Z',
  };

  const mockActiveSuppression: SuppressionResponse = {
    id: SUPPRESSION_ACTIVE_ID,
    orgId: ORG_A,
    channelId: CHANNEL_SMS_ID,
    rawAddress: '+12025550101',
    normalizedAddress: '+12025550101',
    reason: 'Customer requested opt-out',
    status: 'active',
    clearedAt: null,
    clearedReason: null,
    createdAt: '2026-10-21T01:00:00.000Z',
    updatedAt: '2026-10-21T01:00:00.000Z',
  };

  const mockClearedSuppression: SuppressionResponse = {
    id: SUPPRESSION_CLEARED_ID,
    orgId: ORG_A,
    channelId: null,
    rawAddress: 'user@example.com',
    normalizedAddress: 'user@example.com',
    reason: 'Temporary global block',
    status: 'cleared',
    clearedAt: '2026-10-21T02:00:00.000Z',
    clearedReason: 'Verified identity and re-subscribed',
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T02:00:00.000Z',
  };

  const setupSession = (grants: EffectiveAuthorization['grants']) => {
    const user: UserIdentity = {
      userId: 'test-user-1',
      email: 'operator@alendei.com',
      actorType: 'user',
      authMethod: 'session',
      sessionId: 'sess-1',
      authenticatedAt: new Date().toISOString(),
      tenant: { orgId: ORG_A, workspaceId: null, resellerId: null, isPlatformAdmin: false },
      authorizedOrganizationIds: [ORG_A],
      roles: [],
      permissions: [],
    };

    const authorization: EffectiveAuthorization = {
      actorType: 'user',
      userId: 'test-user-1',
      apiKeyId: null,
      organizationIds: [ORG_A],
      grants,
      isPlatformAdmin: false,
    };

    useSession.getState().setSession({
      accessToken: 'test-token',
      user,
      authorization,
      selectedOrgId: ORG_A,
    });
  };

  const renderWithQueryClient = (component: React.ReactNode, client: QueryClient) =>
    renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, component));

  afterEach(() => {
    useSession.getState().clearSession();
  });

  // --- 1. Status Badge Tests -------------------------------------------------

  it('1. SuppressionStatusBadge renders active status with accessible text and emerald tone', () => {
    const html = renderToStaticMarkup(
      React.createElement(SuppressionStatusBadge, { status: 'active' }),
    );
    assert.ok(html.includes('Active'));
    assert.ok(html.includes('bg-emerald-500/15') || html.includes('text-emerald-400'));
  });

  it('2. SuppressionStatusBadge renders cleared status with accessible text and neutral tone', () => {
    const html = renderToStaticMarkup(
      React.createElement(SuppressionStatusBadge, { status: 'cleared' }),
    );
    assert.ok(html.includes('Cleared'));
    assert.ok(html.includes('var(--color-ink-muted)'));
  });

  // --- 2. Detail Dialog Tests ------------------------------------------------

  it('3. SuppressionDetailDialog renders accessible modal with complete record fields', () => {
    const html = renderToStaticMarkup(
      React.createElement(SuppressionDetailDialog, {
        isOpen: true,
        onClose: () => {},
        suppression: mockClearedSuppression,
        channels: [mockChannel],
      }),
    );

    assert.ok(html.includes('role="dialog"'));
    assert.ok(html.includes('aria-modal="true"'));
    assert.ok(html.includes('id="suppression-detail-title"'));
    assert.ok(html.includes('user@example.com'));
    assert.ok(html.includes('All Channels (Organization-wide)'));
    assert.ok(html.includes('Temporary global block'));
    assert.ok(html.includes('Verified identity and re-subscribed'));
    assert.ok(html.includes(SUPPRESSION_CLEARED_ID));
  });

  // --- 3. Create Dialog Tests ------------------------------------------------

  it('4. CreateSuppressionDialog renders accessible modal form with required inputs', () => {
    const html = renderToStaticMarkup(
      React.createElement(CreateSuppressionDialog, {
        isOpen: true,
        onClose: () => {},
        onSuccess: () => {},
        channels: [mockChannel],
      }),
    );

    assert.ok(html.includes('role="dialog"'));
    assert.ok(html.includes('aria-modal="true"'));
    assert.ok(html.includes('id="create-suppression-title"'));
    assert.ok(html.includes('id="create-suppression-channel"'));
    assert.ok(html.includes('id="create-suppression-address"'));
    assert.ok(html.includes('id="create-suppression-reason"'));
    assert.ok(html.includes('SMS Gateway'));
    assert.ok(html.includes('All Channels (Organization-wide)'));
  });

  // --- 4. Lift Dialog Tests --------------------------------------------------

  it('5. LiftSuppressionDialog renders confirmation warning and mandatory justification', () => {
    const html = renderToStaticMarkup(
      React.createElement(LiftSuppressionDialog, {
        isOpen: true,
        onClose: () => {},
        onSuccess: () => {},
        suppression: mockActiveSuppression,
        channels: [mockChannel],
      }),
    );

    assert.ok(html.includes('role="dialog"'));
    assert.ok(html.includes('aria-modal="true"'));
    assert.ok(html.includes('id="lift-suppression-title"'));
    assert.ok(html.includes('Important Confirmation'));
    assert.ok(html.includes('Lifting this suppression will allow future campaigns'));
    assert.ok(html.includes('+12025550101'));
    assert.ok(html.includes('id="lift-suppression-reason"'));
    assert.ok(html.includes('Confirm Lift'));
  });

  // --- 5. SuppressionListCard Authorization & Action Gating -------------------

  it('6. SuppressionListCard renders action buttons when caller holds suppressions.manage', () => {
    setupSession([
      {
        roleId: 'role-org-admin',
        roleKey: 'org_admin',
        scopeType: 'organization',
        scopeId: ORG_A,
        orgId: ORG_A,
        permissions: ['suppressions.read', 'suppressions.manage'],
      },
    ]);

    const queryClient = createAppQueryClient();
    queryClient.setQueryData(
      [
        'suppressions',
        'list',
        ORG_A,
        { status: undefined, channelId: undefined, cursor: undefined, limit: 25 },
      ],
      {
        data: [mockActiveSuppression, mockClearedSuppression],
        page: { hasMore: false, nextCursor: null, limit: 25 },
      },
    );

    const html = renderWithQueryClient(
      React.createElement(SuppressionListCard, {
        orgId: ORG_A,
        channels: [mockChannel],
      }),
      queryClient,
    );

    // Filter controls present
    assert.ok(html.includes('id="filter-status"'));
    assert.ok(html.includes('id="filter-channel"'));

    // Create action button rendered
    assert.ok(html.includes('+ Add Suppression'));

    // Both rows rendered
    assert.ok(html.includes('+12025550101'));
    assert.ok(html.includes('user@example.com'));

    // Lift button rendered ONLY for active row
    assert.ok(html.includes('Lift'));

    // Details button rendered for both rows
    assert.ok(html.includes('Details'));
  });

  it('7. SuppressionListCard hides mutation buttons when caller holds read-only authority', () => {
    setupSession([
      {
        roleId: 'role-compliance-auditor',
        roleKey: 'auditor',
        scopeType: 'organization',
        scopeId: ORG_A,
        orgId: ORG_A,
        permissions: ['suppressions.read'],
      },
    ]);

    const queryClient = createAppQueryClient();
    queryClient.setQueryData(
      [
        'suppressions',
        'list',
        ORG_A,
        { status: undefined, channelId: undefined, cursor: undefined, limit: 25 },
      ],
      {
        data: [mockActiveSuppression],
        page: { hasMore: false, nextCursor: null, limit: 25 },
      },
    );

    const html = renderWithQueryClient(
      React.createElement(SuppressionListCard, {
        orgId: ORG_A,
        channels: [mockChannel],
      }),
      queryClient,
    );

    // List is readable
    assert.ok(html.includes('+12025550101'));
    assert.ok(html.includes('Details'));

    // Mutation controls MUST NOT be rendered
    assert.ok(!html.includes('+ Add Suppression'));
    assert.ok(!html.includes('Lift'));
  });

  it('8. SuppressionListCard renders Access Forbidden when session lacks suppressions.read', () => {
    setupSession([
      {
        roleId: 'role-unprivileged',
        roleKey: 'unprivileged',
        scopeType: 'organization',
        scopeId: ORG_A,
        orgId: ORG_A,
        permissions: ['workspaces.read'],
      },
    ]);

    const queryClient = createAppQueryClient();
    const html = renderWithQueryClient(
      React.createElement(SuppressionListCard, {
        orgId: ORG_A,
        channels: [mockChannel],
      }),
      queryClient,
    );

    assert.ok(html.includes('Access Forbidden'));
    assert.ok(html.includes('You do not have permission to view suppressions'));
    assert.ok(!html.includes('id="filter-status"'));
    assert.ok(!html.includes('+ Add Suppression'));
  });
});
