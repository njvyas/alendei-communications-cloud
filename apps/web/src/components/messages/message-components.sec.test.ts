import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';

import { MessageStatusBadge } from '@/components/whatsapp/message-status-badge';
import { MessageDetailDialog } from './message-detail-dialog';
import { MessageListCard } from './message-list-card';
import { createAppQueryClient } from '../../lib/query-client';
import { useSession } from '../../lib/session-store';
import type { ChannelView, EffectiveAuthorization, UserIdentity } from '../../lib/api-client';

// Ensure React is globally available for JSX and SSR transforms
(globalThis as unknown as { React: typeof React }).React = React;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

describe('SEC-MSG: Message Components Integration & Accessibility Tests', () => {
  const ORG_A = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const MSG_ID = '01955b0a-7b3b-7411-9a4f-msg000000001';
  const CHANNEL_ID = '01955b0a-7b3b-7411-9a4f-ch000000001';

  const mockChannel: ChannelView = {
    id: CHANNEL_ID,
    code: 'whatsapp',
    displayName: 'WhatsApp Business',
    status: 'active',
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-15T10:00:00.000Z',
  };

  const setupSessionWithGrants = (permissions: string[] = ['messages.read']) => {
    const user: UserIdentity = {
      userId: 'test-user-msg',
      actorType: 'user',
      authMethod: 'session',
      sessionId: 'sess-msg-1',
      authenticatedAt: new Date().toISOString(),
      tenant: { orgId: ORG_A, workspaceId: null, resellerId: null, isPlatformAdmin: false },
      authorizedOrganizationIds: [ORG_A],
      roles: [],
      permissions: [],
    };

    const authorization: EffectiveAuthorization = {
      actorType: 'user',
      userId: 'test-user-msg',
      apiKeyId: null,
      isPlatformAdmin: false,
      organizationIds: [ORG_A],
      grants: [
        {
          roleId: 'role-org-admin',
          roleKey: 'org_admin',
          scopeType: 'organization',
          scopeId: ORG_A,
          orgId: ORG_A,
          permissions,
        },
      ],
    };

    useSession.setState({
      status: 'ready',
      user,
      authorization,
      selectedOrganizationId: ORG_A,
      authorizedOrganizationIds: [ORG_A],
    });
  };

  afterEach(() => {
    useSession.setState({
      status: 'unauthenticated',
      user: null,
      authorization: null,
      selectedOrganizationId: null,
      authorizedOrganizationIds: [],
    });
  });

  // ---------------------------------------------------------------------------
  // 1. MessageStatusBadge Tests
  // ---------------------------------------------------------------------------
  it('1. MessageStatusBadge renders semantic labels across all valid message statuses', () => {
    const queuedHtml = renderToStaticMarkup(
      React.createElement(MessageStatusBadge, { status: 'queued' }),
    );
    assert.ok(queuedHtml.includes('QUEUED'));
    assert.ok(queuedHtml.includes('data-testid="message-status-badge"'));

    const acceptedHtml = renderToStaticMarkup(
      React.createElement(MessageStatusBadge, { status: 'accepted' }),
    );
    assert.ok(acceptedHtml.includes('PROVIDER_ACCEPTED'));

    const failedHtml = renderToStaticMarkup(
      React.createElement(MessageStatusBadge, { status: 'failed' }),
    );
    assert.ok(failedHtml.includes('FAILED'));

    const outcomeHtml = renderToStaticMarkup(
      React.createElement(MessageStatusBadge, { status: 'outcome_unknown' }),
    );
    assert.ok(outcomeHtml.includes('OUTCOME_UNKNOWN'));
  });

  // ---------------------------------------------------------------------------
  // 2. MessageDetailDialog Accessibility Tests
  // ---------------------------------------------------------------------------
  it('2. MessageDetailDialog renders accessible dialog attributes role="dialog" and aria-modal', () => {
    const queryClient: QueryClient = createAppQueryClient();

    const html = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(MessageDetailDialog, {
          messageId: MSG_ID,
          onClose: () => {},
          channels: [mockChannel],
        }),
      ),
    );

    assert.ok(html.includes('role="dialog"'));
    assert.ok(html.includes('aria-modal="true"'));
    assert.ok(html.includes('aria-labelledby="message-detail-title"'));
    assert.ok(html.includes('aria-describedby="message-detail-desc"'));
    assert.ok(html.includes('Message Details'));
  });

  // ---------------------------------------------------------------------------
  // 3. MessageListCard Masking by Default & Filters
  // ---------------------------------------------------------------------------
  it('3. MessageListCard renders filter controls, table headers, and refresh action', () => {
    setupSessionWithGrants(['messages.read']);
    const queryClient: QueryClient = createAppQueryClient();

    const html = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(MessageListCard, {
          orgId: ORG_A,
          channels: [mockChannel],
        }),
      ),
    );

    // Filter controls present
    assert.ok(html.includes('id="filter-status"'));
    assert.ok(html.includes('id="filter-channel"'));
    assert.ok(html.includes('All Statuses'));
    assert.ok(html.includes('All Channels'));
    assert.ok(html.includes('Refresh'));

    // Table headers present
    assert.ok(html.includes('Dispatched'));
    assert.ok(html.includes('Channel'));
    assert.ok(html.includes('Recipient Address'));
    assert.ok(html.includes('Status'));
    assert.ok(html.includes('Attempts'));
    assert.ok(html.includes('Failure Reason'));
  });
});
