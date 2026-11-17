import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createAppQueryClient } from '../../lib/query-client';
import { useSession } from '../../lib/session-store';
import { MessageListCard } from './message-list-card';
import { MessageDetailDialog } from './message-detail-dialog';
import { AttemptHistoryCard } from '../whatsapp/attempt-history-card';
import type {
  ChannelView,
  MessageDetailWithAttempts,
  MessageSummaryResponse,
  UserIdentity,
  EffectiveAuthorization,
} from '../../lib/api-client';

(globalThis as unknown as { React: typeof React }).React = React;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

describe('ACC Phase 5.0: Two-Axis Delivery Outcomes Integration & Component Tests', () => {
  const ORG_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const MSG_ID = '01955b0a-7b3b-7411-9a4f-msg000000001';
  const CHANNEL_ID = '01955b0a-7b3b-7411-9a4f-ch000000001';
  const WORKSPACE_ID = '01955b0a-7b3b-7411-9a4f-ws000000001';

  const mockChannel: ChannelView = {
    id: CHANNEL_ID,
    code: 'whatsapp',
    displayName: 'WhatsApp Business',
    status: 'active',
    createdAt: '2026-10-15T10:00:00.000Z',
    updatedAt: '2026-10-15T10:00:00.000Z',
  };

  const setupSession = () => {
    const user: UserIdentity = {
      userId: 'test-user-p50',
      actorType: 'user',
      authMethod: 'session',
      sessionId: 'sess-p50-1',
      authenticatedAt: new Date().toISOString(),
      tenant: { orgId: ORG_ID, workspaceId: null, resellerId: null, isPlatformAdmin: false },
      authorizedOrganizationIds: [ORG_ID],
      roles: [],
      permissions: [],
    };

    const authorization: EffectiveAuthorization = {
      actorType: 'user',
      userId: 'test-user-p50',
      apiKeyId: null,
      isPlatformAdmin: false,
      organizationIds: [ORG_ID],
      grants: [
        {
          roleId: 'role-org-admin',
          roleKey: 'org_admin',
          scopeType: 'organization',
          scopeId: ORG_ID,
          orgId: ORG_ID,
          permissions: ['messages.read'],
        },
      ],
    };

    useSession.setState({
      status: 'ready',
      user,
      authorization,
      selectedOrganizationId: ORG_ID,
      authorizedOrganizationIds: [ORG_ID],
    });
  };

  const renderWithQueryClient = (component: React.ReactNode, client: QueryClient) =>
    renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, component));

  afterEach(() => {
    useSession.setState({
      status: 'unauthenticated',
      user: null,
      authorization: null,
      selectedOrganizationId: null,
      authorizedOrganizationIds: [],
    });
  });

  it('1. MessageListCard renders Delivery column and DeliveryStatusBadge alongside Submission status', () => {
    setupSession();
    const queryClient: QueryClient = createAppQueryClient();

    const deliveredMessage: MessageSummaryResponse = {
      id: MSG_ID,
      orgId: ORG_ID,
      workspaceId: WORKSPACE_ID,
      contactId: 'ct-1',
      channelId: CHANNEL_ID,
      channelCode: 'whatsapp',
      templateId: null,
      status: 'accepted',
      recipientAddress: '+12025550199',
      failureReason: null,
      attemptCount: 1,
      createdAt: '2026-11-07T10:00:00.000Z',
      completedAt: '2026-11-07T10:00:02.000Z',
      deliveryStatus: 'delivered',
      deliveredAt: '2026-11-07T10:00:05.000Z',
      readAt: '2026-11-07T10:01:00.000Z',
    };

    queryClient.setQueryData(
      [
        'messages',
        'list',
        ORG_ID,
        {
          status: undefined,
          deliveryStatus: undefined,
          channelCode: undefined,
          workspaceId: undefined,
          cursor: undefined,
          limit: 25,
        },
      ],
      {
        data: [deliveredMessage],
        page: { hasMore: false, nextCursor: null, limit: 25 },
      },
    );

    const html = renderWithQueryClient(
      React.createElement(MessageListCard, { orgId: ORG_ID, channels: [mockChannel] }),
      queryClient,
    );

    // Verify Column Headers include both Submission Status and Delivery
    assert.ok(html.includes('>Status<'));
    assert.ok(html.includes('>Delivery<'));

    // Verify Submission Axis: PROVIDER_ACCEPTED
    assert.ok(html.includes('PROVIDER_ACCEPTED'));

    // Verify Delivery Axis: DELIVERED
    assert.ok(html.includes('data-delivery-status="delivered"'));
    assert.ok(html.includes('DELIVERED'));

    // Verify Read Receipt is displayed separately as an attribute
    assert.ok(html.includes('data-testid="read-receipt-badge"'));
    assert.ok(html.includes('READ'));

    // Verify Delivery Status Filter dropdown is rendered
    assert.ok(html.includes('data-testid="filter-delivery-status"'));
    assert.ok(html.includes('All Delivery States'));
    assert.ok(html.includes('Pending'));
    assert.ok(html.includes('Delivered'));
    assert.ok(html.includes('Undelivered'));
    assert.ok(html.includes('Receipts N/A'));
  });

  it('2. MessageListCard handles legacy records with NULL deliveryStatus (NOT TRACKED)', () => {
    setupSession();
    const queryClient: QueryClient = createAppQueryClient();

    const legacyMessage: MessageSummaryResponse = {
      id: 'legacy-msg-1',
      orgId: ORG_ID,
      workspaceId: WORKSPACE_ID,
      contactId: 'ct-1',
      channelId: CHANNEL_ID,
      channelCode: 'whatsapp',
      templateId: null,
      status: 'accepted',
      recipientAddress: '+12025550199',
      failureReason: null,
      attemptCount: 1,
      createdAt: '2026-10-01T10:00:00.000Z',
      completedAt: '2026-10-01T10:00:02.000Z',
      deliveryStatus: null, // Legacy pre-Phase 5.0 record
      deliveredAt: null,
      readAt: null,
    };

    queryClient.setQueryData(
      [
        'messages',
        'list',
        ORG_ID,
        {
          status: undefined,
          deliveryStatus: undefined,
          channelCode: undefined,
          workspaceId: undefined,
          cursor: undefined,
          limit: 25,
        },
      ],
      {
        data: [legacyMessage],
        page: { hasMore: false, nextCursor: null, limit: 25 },
      },
    );

    const html = renderWithQueryClient(
      React.createElement(MessageListCard, { orgId: ORG_ID, channels: [mockChannel] }),
      queryClient,
    );

    assert.ok(html.includes('PROVIDER_ACCEPTED'));
    assert.ok(html.includes('data-delivery-status="not_tracked"'));
    assert.ok(html.includes('NOT TRACKED'));
    assert.ok(!html.includes('data-testid="read-receipt-badge"'));
  });

  it('3. MessageListCard preserves two-axis honesty: late delivery does not rewrite submission status', () => {
    setupSession();
    const queryClient: QueryClient = createAppQueryClient();

    // A message whose submission failed but a superseded attempt later delivered per §B.5 rule 4
    const lateDeliveryMessage: MessageSummaryResponse = {
      id: 'late-dlr-msg',
      orgId: ORG_ID,
      workspaceId: WORKSPACE_ID,
      contactId: 'ct-1',
      channelId: CHANNEL_ID,
      channelCode: 'whatsapp',
      templateId: null,
      status: 'failed',
      recipientAddress: '+12025550199',
      failureReason: 'PROVIDER_TIMEOUT',
      attemptCount: 2,
      createdAt: '2026-11-07T10:00:00.000Z',
      completedAt: '2026-11-07T10:00:05.000Z',
      deliveryStatus: 'delivered', // Delivery axis reflects positive evidence
      deliveredAt: '2026-11-07T10:00:10.000Z',
      readAt: null,
    };

    queryClient.setQueryData(
      [
        'messages',
        'list',
        ORG_ID,
        {
          status: undefined,
          deliveryStatus: undefined,
          channelCode: undefined,
          workspaceId: undefined,
          cursor: undefined,
          limit: 25,
        },
      ],
      {
        data: [lateDeliveryMessage],
        page: { hasMore: false, nextCursor: null, limit: 25 },
      },
    );

    const html = renderWithQueryClient(
      React.createElement(MessageListCard, { orgId: ORG_ID, channels: [mockChannel] }),
      queryClient,
    );

    // Both statuses are honestly displayed side by side
    assert.ok(html.includes('FAILED'));
    assert.ok(html.includes('DELIVERED'));
    assert.ok(html.includes('data-delivery-status="delivered"'));
  });

  it('4. MessageDetailDialog renders delivery metadata and attempt-level delivery outcomes without provider message references (OD-9)', () => {
    const queryClient: QueryClient = createAppQueryClient();

    const detailWithDelivery: MessageDetailWithAttempts = {
      id: MSG_ID,
      orgId: ORG_ID,
      workspaceId: WORKSPACE_ID,
      contactId: 'ct-1',
      channelId: CHANNEL_ID,
      templateId: null,
      status: 'accepted',
      recipientAddress: '+12025550199',
      payload: { text: 'Test Phase 5.0 delivery' },
      failureReason: null,
      createdAt: '2026-11-07T10:00:00.000Z',
      completedAt: '2026-11-07T10:00:02.000Z',
      deliveryStatus: 'delivered',
      deliveredAt: '2026-11-07T10:00:06.000Z',
      readAt: '2026-11-07T10:01:15.000Z',
      attempts: [
        {
          id: 'att-1',
          attemptNumber: 1,
          providerId: 'prv-meta-wa-01',
          status: 'accepted',
          failureReason: null,
          latencyMs: 120,
          completedAt: '2026-11-07T10:00:02.000Z',
          deliveryStatus: 'delivered',
          deliveredAt: '2026-11-07T10:00:06.000Z',
          readAt: '2026-11-07T10:01:15.000Z',
        },
      ],
    };

    queryClient.setQueryData(['messages', 'detail', MSG_ID], {
      data: detailWithDelivery,
    });

    const html = renderWithQueryClient(
      React.createElement(MessageDetailDialog, {
        messageId: MSG_ID,
        onClose: () => {},
        channels: [mockChannel],
      }),
      queryClient,
    );

    // Header displays both Submission and Delivery status
    assert.ok(html.includes('data-testid="detail-header-badges"'));
    assert.ok(html.includes('PROVIDER_ACCEPTED'));
    assert.ok(html.includes('DELIVERED'));

    // Metadata Grid displays Delivery Status, Delivered At, Read Receipt
    assert.ok(html.includes('data-testid="detail-delivery-status"'));
    assert.ok(html.includes('data-testid="detail-delivered-at"'));
    assert.ok(html.includes('data-testid="detail-read-receipt"'));
    assert.ok(html.includes('Read Receipt'));

    // Attempts table has a Delivery column and no provider message reference column (OD-9)
    assert.ok(html.includes('Delivery'));
    assert.ok(!html.includes('Provider Msg ID'));
    assert.ok(!html.includes('attempt-provider-msg-id-'));

    // Attempt row displays the delivery outcome
    assert.ok(html.includes('data-testid="attempt-delivery-1"'));
  });

  it('5. AttemptHistoryCard (WhatsApp Settlement Monitor) displays two-axis model and attempt outcomes', () => {
    const settlementMessage: MessageDetailWithAttempts = {
      id: 'wa-msg-1',
      orgId: ORG_ID,
      workspaceId: WORKSPACE_ID,
      contactId: 'ct-1',
      channelId: CHANNEL_ID,
      templateId: null,
      status: 'accepted',
      recipientAddress: '+12025550199',
      payload: {},
      failureReason: null,
      createdAt: '2026-11-07T10:00:00.000Z',
      completedAt: '2026-11-07T10:00:02.000Z',
      deliveryStatus: 'delivered',
      deliveredAt: '2026-11-07T10:00:05.000Z',
      readAt: '2026-11-07T10:00:15.000Z',
      attempts: [
        {
          id: 'att-wa-1',
          attemptNumber: 1,
          providerId: 'prv-meta-wa-01',
          status: 'accepted',
          failureReason: null,
          latencyMs: 145,
          completedAt: '2026-11-07T10:00:02.000Z',
          deliveryStatus: 'delivered',
          deliveredAt: '2026-11-07T10:00:05.000Z',
          readAt: '2026-11-07T10:00:15.000Z',
        },
      ],
    };

    const html = renderToStaticMarkup(
      React.createElement(AttemptHistoryCard, {
        message: settlementMessage,
        isPolling: false,
      }),
    );

    // Two-Axis Model boundary text
    assert.ok(html.includes('Two-Axis Delivery Model'));
    assert.ok(html.includes('data-testid="settlement-header-badges"'));
    assert.ok(html.includes('PROVIDER_ACCEPTED'));
    assert.ok(html.includes('DELIVERED'));
    assert.ok(html.includes('READ'));

    // Attempts table has the Delivery outcome and no provider message reference column (OD-9)
    assert.ok(!html.includes('Provider Msg ID'));
    assert.ok(!html.includes('attempt-provider-msg-id-'));
    assert.ok(html.includes('data-testid="attempt-delivery-1"'));
  });

  it('6. MessageListCard table spans 8 columns for loading and empty states', () => {
    setupSession();
    const queryClient: QueryClient = createAppQueryClient();

    // 1. Loading state (no data seeded)
    const loadingHtml = renderWithQueryClient(
      React.createElement(MessageListCard, { orgId: ORG_ID, channels: [mockChannel] }),
      queryClient,
    );
    assert.ok(loadingHtml.includes('colSpan="8"'));
    assert.ok(loadingHtml.includes('Loading messages…'));

    // 2. Empty state
    queryClient.setQueryData(
      [
        'messages',
        'list',
        ORG_ID,
        {
          status: undefined,
          deliveryStatus: undefined,
          channelCode: undefined,
          workspaceId: undefined,
          cursor: undefined,
          limit: 25,
        },
      ],
      {
        data: [],
        page: { hasMore: false, nextCursor: null, limit: 25 },
      },
    );

    const emptyHtml = renderWithQueryClient(
      React.createElement(MessageListCard, { orgId: ORG_ID, channels: [mockChannel] }),
      queryClient,
    );
    assert.ok(emptyHtml.includes('colSpan="8"'));
    assert.ok(emptyHtml.includes('No messages found'));
  });

  it('7. MessageDetailDialog correctly separates aggregate message status from heterogeneous attempt outcomes', () => {
    const queryClient: QueryClient = createAppQueryClient();

    // Multi-attempt scenario: Attempt 1 had outcome_unknown and later delivered;
    // Attempt 2 had circuit open failure; aggregate message is failed + delivered.
    const multiAttemptDetail: MessageDetailWithAttempts = {
      id: 'multi-att-msg',
      orgId: ORG_ID,
      workspaceId: WORKSPACE_ID,
      contactId: 'ct-1',
      channelId: CHANNEL_ID,
      templateId: null,
      status: 'failed',
      recipientAddress: '+12025550155',
      payload: { text: 'Alert message' },
      failureReason: 'PROVIDER_TIMEOUT',
      createdAt: '2026-11-07T10:04:00.000Z',
      completedAt: '2026-11-07T10:04:06.000Z',
      deliveryStatus: 'delivered',
      deliveredAt: '2026-11-07T10:04:12.000Z',
      readAt: null,
      attempts: [
        {
          id: 'att-multi-1',
          attemptNumber: 1,
          providerId: 'prv-meta-wa-01',
          status: 'outcome_unknown',
          failureReason: 'GATEWAY_TIMEOUT',
          latencyMs: 3000,
          completedAt: '2026-11-07T10:04:03.000Z',
          deliveryStatus: 'delivered',
          deliveredAt: '2026-11-07T10:04:12.000Z',
          readAt: null,
        },
        {
          id: 'att-multi-2',
          attemptNumber: 2,
          providerId: 'prv-meta-wa-02',
          status: 'failed',
          failureReason: 'CIRCUIT_OPEN',
          latencyMs: 12,
          completedAt: '2026-11-07T10:04:06.000Z',
          deliveryStatus: 'pending',
          deliveredAt: null,
          readAt: null,
        },
      ],
    };

    queryClient.setQueryData(['messages', 'detail', 'multi-att-msg'], {
      data: multiAttemptDetail,
    });

    const html = renderWithQueryClient(
      React.createElement(MessageDetailDialog, {
        messageId: 'multi-att-msg',
        onClose: () => {},
        channels: [mockChannel],
      }),
      queryClient,
    );

    // Aggregate badges: FAILED (submission) and DELIVERED (delivery)
    assert.ok(html.includes('data-testid="detail-header-badges"'));
    assert.ok(html.includes('FAILED'));
    assert.ok(html.includes('DELIVERED'));

    // Attempt 1 specifics
    assert.ok(html.includes('data-testid="attempt-delivery-1"'));
    assert.ok(html.includes('OUTCOME_UNKNOWN'));

    // Attempt 2 specifics: pending delivery, circuit open failure
    assert.ok(html.includes('data-testid="attempt-delivery-2"'));
    assert.ok(html.includes('CIRCUIT_OPEN'));

    // Verifies attempts count in header
    assert.ok(html.includes('2 attempts'));
  });

  it('8. All 4 delivery statuses and legacy NULL fallback render distinct badges and semantic accessibility', () => {
    setupSession();
    const queryClient: QueryClient = createAppQueryClient();

    const sampleMessages: MessageSummaryResponse[] = [
      {
        id: 'msg-dlv-pending',
        orgId: ORG_ID,
        workspaceId: WORKSPACE_ID,
        contactId: 'ct-1',
        channelId: CHANNEL_ID,
        channelCode: 'whatsapp',
        templateId: null,
        status: 'accepted',
        recipientAddress: '+12025550101',
        failureReason: null,
        attemptCount: 1,
        createdAt: '2026-11-07T10:00:00.000Z',
        completedAt: '2026-11-07T10:00:01.000Z',
        deliveryStatus: 'pending',
        deliveredAt: null,
        readAt: null,
      },
      {
        id: 'msg-dlv-delivered',
        orgId: ORG_ID,
        workspaceId: WORKSPACE_ID,
        contactId: 'ct-2',
        channelId: CHANNEL_ID,
        channelCode: 'whatsapp',
        templateId: null,
        status: 'accepted',
        recipientAddress: '+12025550102',
        failureReason: null,
        attemptCount: 1,
        createdAt: '2026-11-07T10:00:00.000Z',
        completedAt: '2026-11-07T10:00:01.000Z',
        deliveryStatus: 'delivered',
        deliveredAt: '2026-11-07T10:00:05.000Z',
        readAt: '2026-11-07T10:01:00.000Z',
      },
      {
        id: 'msg-dlv-undelivered',
        orgId: ORG_ID,
        workspaceId: WORKSPACE_ID,
        contactId: 'ct-3',
        channelId: CHANNEL_ID,
        channelCode: 'whatsapp',
        templateId: null,
        status: 'accepted',
        recipientAddress: '+12025550103',
        failureReason: null,
        attemptCount: 1,
        createdAt: '2026-11-07T10:00:00.000Z',
        completedAt: '2026-11-07T10:00:01.000Z',
        deliveryStatus: 'undelivered',
        deliveredAt: null,
        readAt: null,
      },
      {
        id: 'msg-dlv-notsupported',
        orgId: ORG_ID,
        workspaceId: WORKSPACE_ID,
        contactId: 'ct-4',
        channelId: CHANNEL_ID,
        channelCode: 'whatsapp',
        templateId: null,
        status: 'accepted',
        recipientAddress: '+12025550104',
        failureReason: null,
        attemptCount: 1,
        createdAt: '2026-11-07T10:00:00.000Z',
        completedAt: '2026-11-07T10:00:01.000Z',
        deliveryStatus: 'not_supported',
        deliveredAt: null,
        readAt: null,
      },
      {
        id: 'msg-dlv-null-legacy',
        orgId: ORG_ID,
        workspaceId: WORKSPACE_ID,
        contactId: 'ct-5',
        channelId: CHANNEL_ID,
        channelCode: 'whatsapp',
        templateId: null,
        status: 'accepted',
        recipientAddress: '+12025550105',
        failureReason: null,
        attemptCount: 1,
        createdAt: '2026-10-15T10:00:00.000Z',
        completedAt: '2026-10-15T10:00:01.000Z',
        deliveryStatus: null,
        deliveredAt: null,
        readAt: null,
      },
    ];

    queryClient.setQueryData(
      [
        'messages',
        'list',
        ORG_ID,
        {
          status: undefined,
          deliveryStatus: undefined,
          channelCode: undefined,
          workspaceId: undefined,
          cursor: undefined,
          limit: 25,
        },
      ],
      {
        data: sampleMessages,
        page: { hasMore: false, nextCursor: null, limit: 25 },
      },
    );

    const html = renderWithQueryClient(
      React.createElement(MessageListCard, { orgId: ORG_ID, channels: [mockChannel] }),
      queryClient,
    );

    // Verify presence of all delivery badge data attributes
    assert.ok(html.includes('data-delivery-status="pending"'));
    assert.ok(html.includes('data-delivery-status="delivered"'));
    assert.ok(html.includes('data-delivery-status="undelivered"'));
    assert.ok(html.includes('data-delivery-status="not_supported"'));
    assert.ok(html.includes('data-delivery-status="not_tracked"'));

    // Verify presence of semantic accessibility labels
    assert.ok(html.includes('aria-label="Delivery status: Pending delivery"'));
    assert.ok(html.includes('aria-label="Delivery status: Delivered"'));
    assert.ok(html.includes('aria-label="Delivery status: Undelivered"'));
    assert.ok(html.includes('aria-label="Delivery status: Receipts not supported"'));
    assert.ok(html.includes('aria-label="Delivery status: Not tracked"'));
  });

  it('OD-9: provider message references are never rendered, even if a response carried them', () => {
    // The tenant-facing contract has no providerMessageId or deliveredAttemptId. This
    // simulates an unexpected server response carrying them anyway (cast past the type).
    const leaked = {
      id: 'od9-msg',
      orgId: ORG_ID,
      workspaceId: WORKSPACE_ID,
      contactId: 'ct-1',
      channelId: CHANNEL_ID,
      templateId: null,
      status: 'accepted',
      recipientAddress: '+12025550101',
      payload: {},
      failureReason: null,
      createdAt: '2026-11-07T10:00:00.000Z',
      completedAt: '2026-11-07T10:00:02.000Z',
      deliveryStatus: 'delivered',
      deliveredAt: '2026-11-07T10:00:05.000Z',
      readAt: null,
      deliveredAttemptId: 'att-od9-1',
      attempts: [
        {
          id: 'att-od9-1',
          attemptNumber: 1,
          providerId: 'prv-sim-01',
          status: 'accepted',
          failureReason: null,
          latencyMs: 10,
          completedAt: '2026-11-07T10:00:02.000Z',
          deliveryStatus: 'delivered',
          deliveredAt: '2026-11-07T10:00:05.000Z',
          readAt: null,
          providerMessageId: 'od9-provider-ref-must-not-render',
        },
      ],
    } as unknown as MessageDetailWithAttempts;

    const queryClient: QueryClient = createAppQueryClient();
    queryClient.setQueryData(['messages', 'detail', 'od9-msg'], { data: leaked });
    const dialogHtml = renderWithQueryClient(
      React.createElement(MessageDetailDialog, {
        messageId: 'od9-msg',
        onClose: () => {},
        channels: [mockChannel],
      }),
      queryClient,
    );
    const cardHtml = renderToStaticMarkup(
      React.createElement(AttemptHistoryCard, { message: leaked, isPolling: false }),
    );

    for (const html of [dialogHtml, cardHtml]) {
      assert.ok(html.includes('data-testid="attempt-delivery-1"'));
      assert.ok(!html.includes('od9-provider-ref-must-not-render'));
      assert.ok(!html.includes('Provider Msg ID'));
    }
  });
});
