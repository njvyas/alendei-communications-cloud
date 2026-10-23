import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';

import { MessageStatusBadge } from '@/components/whatsapp/message-status-badge';
import { MessageDetailDialog } from './message-detail-dialog';
import { MessageListCard, type MessageListCardTestHandle } from './message-list-card';
import { createAppQueryClient } from '../../lib/query-client';
import { useSession } from '../../lib/session-store';
import {
  ApiError,
  messagesApi,
  workspacesApi,
  type ChannelView,
  type EffectiveAuthorization,
  type ListMessagesParams,
  type MessageDetailWithAttempts,
  type MessageSummaryResponse,
  type UserIdentity,
} from '../../lib/api-client';

// Ensure React is globally available for JSX and SSR transforms
(globalThis as unknown as { React: typeof React }).React = React;
const originalUseSyncExternalStore = React.useSyncExternalStore;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

interface MockNode {
  nodeType: number;
  nodeName: string;
  tagName: string;
  style: Record<string, string>;
  childNodes: MockNode[];
  options: unknown[];
  selectedIndex: number;
  innerHTML: string;
  textContent: string;
  nodeValue?: string;
  attributes: Record<string, string>;
  addEventListener: () => void;
  removeEventListener: () => void;
  appendChild: (child: MockNode) => MockNode;
  removeChild: (child: MockNode) => MockNode;
  insertBefore: (child: MockNode) => MockNode;
  setAttribute: (k: string, v: string) => void;
  removeAttribute: (k: string) => void;
  getAttribute: (k: string) => string | undefined;
  ownerDocument?: unknown;
}

function renderNodeToString(node: MockNode): string {
  if (node.nodeType === 3) {
    return node.textContent || node.nodeValue || '';
  }
  const attrs = Object.entries(node.attributes || {})
    .map(([k, v]) => ` ${k}="${v}"`)
    .join('');
  const children = (node.childNodes || []).map(renderNodeToString).join('');
  return `<${node.tagName.toLowerCase()}${attrs}>${children}</${node.tagName.toLowerCase()}>`;
}

function setupDom() {
  function createNode(tag = 'DIV'): MockNode {
    const node: MockNode = {
      nodeType: 1,
      nodeName: tag,
      tagName: tag,
      style: {},
      childNodes: [],
      options: [],
      selectedIndex: 0,
      innerHTML: '',
      textContent: '',
      attributes: {},
      addEventListener: () => {},
      removeEventListener: () => {},
      appendChild: (child: MockNode) => {
        node.childNodes.push(child);
        return child;
      },
      removeChild: (child: MockNode) => {
        const idx = node.childNodes.indexOf(child);
        if (idx !== -1) node.childNodes.splice(idx, 1);
        return child;
      },
      insertBefore: (child: MockNode) => {
        node.childNodes.push(child);
        return child;
      },
      setAttribute: (k: string, v: string) => {
        node.attributes[k] = String(v);
      },
      removeAttribute: (k: string) => {
        delete node.attributes[k];
      },
      getAttribute: (k: string) => node.attributes[k],
    };
    return node;
  }

  const target = createNode();
  const doc = {
    nodeType: 9,
    nodeName: '#document',
    documentElement: createNode('HTML'),
    createElement: (tag: string) => createNode(tag),
    createElementNS: (_: string, tag: string) => createNode(tag),
    createTextNode: (text: string) => {
      const textNode = createNode('#TEXT');
      textNode.nodeType = 3;
      textNode.textContent = text;
      textNode.nodeValue = text;
      return textNode;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    activeElement: null,
    defaultView: undefined as unknown,
  };
  target.ownerDocument = doc;
  class ElementMock {}
  class HTMLIFrameElementMock extends ElementMock {}
  doc.defaultView = {
    Element: ElementMock,
    HTMLIFrameElement: HTMLIFrameElementMock,
    getComputedStyle: () => ({}),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as unknown as Record<string, unknown>).window = doc.defaultView;
  (globalThis as unknown as Record<string, unknown>).document = doc;
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  let caughtError: Error | null = null;
  const root = ReactDOM.createRoot(target as unknown as Element, {
    onUncaughtError: (err) => {
      caughtError = err instanceof Error ? err : new Error(String(err));
    },
    onCaughtError: (err) => {
      caughtError = err instanceof Error ? err : new Error(String(err));
    },
  });

  return {
    target,
    root,
    getError: () => caughtError,
    unmount: () => {
      try {
        root.unmount();
      } catch {
        // ignore unmount errors in test environment
      }
    },
    getHtml: () => renderNodeToString(target),
  };
}

describe('SEC-MSG: Message Components Integration, Privacy & Behavior Tests', () => {
  const ORG_A = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const ORG_B = '01955b0a-7b3b-7411-9a4f-9e67d4f92222';
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

  const mockSummary: MessageSummaryResponse = {
    id: MSG_ID,
    orgId: ORG_A,
    workspaceId: WORKSPACE_ID,
    contactId: '01955b0a-7b3b-7411-9a4f-ct000000001',
    channelId: CHANNEL_ID,
    channelCode: 'whatsapp',
    templateId: null,
    status: 'accepted',
    recipientAddress: '+12025550199',
    failureReason: null,
    attemptCount: 1,
    createdAt: '2026-10-21T12:00:00.000Z',
    completedAt: '2026-10-21T12:00:02.000Z',
  };

  const mockDetail: MessageDetailWithAttempts = {
    id: MSG_ID,
    orgId: ORG_A,
    workspaceId: WORKSPACE_ID,
    contactId: '01955b0a-7b3b-7411-9a4f-ct000000001',
    channelId: CHANNEL_ID,
    templateId: null,
    status: 'accepted',
    recipientAddress: '+12025550199',
    payload: { text: 'Order #1234 has been confirmed.' },
    failureReason: null,
    createdAt: '2026-10-21T12:00:00.000Z',
    completedAt: '2026-10-21T12:00:02.000Z',
    attempts: [
      {
        id: '01955b0a-7b3b-7411-9a4f-att000000001',
        attemptNumber: 1,
        providerId: 'prv-meta-wa-01',
        status: 'accepted',
        failureReason: null,
        latencyMs: 142,
        completedAt: '2026-10-21T12:00:02.000Z',
      },
    ],
  };

  const setupSessionWithGrants = (
    orgId: string = ORG_A,
    permissions: string[] = ['messages.read'],
  ) => {
    const user: UserIdentity = {
      userId: 'test-user-msg',
      actorType: 'user',
      authMethod: 'session',
      sessionId: 'sess-msg-1',
      authenticatedAt: new Date().toISOString(),
      tenant: { orgId, workspaceId: null, resellerId: null, isPlatformAdmin: false },
      authorizedOrganizationIds: [orgId],
      roles: [],
      permissions: [],
    };

    const authorization: EffectiveAuthorization = {
      actorType: 'user',
      userId: 'test-user-msg',
      apiKeyId: null,
      isPlatformAdmin: false,
      organizationIds: [orgId],
      grants: [
        {
          roleId: 'role-org-admin',
          roleKey: 'org_admin',
          scopeType: 'organization',
          scopeId: orgId,
          orgId,
          permissions,
        },
      ],
    };

    useSession.setState({
      status: 'ready',
      user,
      authorization,
      selectedOrganizationId: orgId,
      authorizedOrganizationIds: [orgId],
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

  // ---------------------------------------------------------------------------
  // 1. MessageStatusBadge Tests
  // ---------------------------------------------------------------------------
  it('1. MessageStatusBadge renders semantic labels across all valid message statuses', () => {
    const queuedHtml = renderToStaticMarkup(
      React.createElement(MessageStatusBadge, { status: 'queued' }),
    );
    assert.ok(queuedHtml.includes('QUEUED'));
    assert.ok(queuedHtml.includes('data-testid="message-status-badge"'));

    const routingHtml = renderToStaticMarkup(
      React.createElement(MessageStatusBadge, { status: 'routing' }),
    );
    assert.ok(routingHtml.includes('ROUTING'));

    const submittingHtml = renderToStaticMarkup(
      React.createElement(MessageStatusBadge, { status: 'submitting' }),
    );
    assert.ok(submittingHtml.includes('SUBMITTING'));

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
  // 2. MessageDetailDialog Privacy & Accessibility Tests
  // ---------------------------------------------------------------------------
  it('2. MessageDetailDialog renders accessible dialog attributes role="dialog" and aria-modal', () => {
    const queryClient: QueryClient = createAppQueryClient();

    const html = renderWithQueryClient(
      React.createElement(MessageDetailDialog, {
        messageId: MSG_ID,
        onClose: () => {},
        channels: [mockChannel],
      }),
      queryClient,
    );

    assert.ok(html.includes('role="dialog"'));
    assert.ok(html.includes('aria-modal="true"'));
    assert.ok(html.includes('aria-labelledby="message-detail-title"'));
    assert.ok(html.includes('aria-describedby="message-detail-desc"'));
    assert.ok(html.includes('Message Details'));
  });

  it('3. MessageDetailDialog renders recipient address permanently masked and STRICTLY omits reveal controls', () => {
    const queryClient: QueryClient = createAppQueryClient();
    queryClient.setQueryData(['messages', 'detail', MSG_ID], {
      data: mockDetail,
    });

    const html = renderWithQueryClient(
      React.createElement(MessageDetailDialog, {
        messageId: MSG_ID,
        onClose: () => {},
        channels: [mockChannel],
      }),
      queryClient,
    );

    // Metadata is rendered
    assert.ok(html.includes('Recipient Address'));
    assert.ok(html.includes('+1 •••• 0199'));

    // Privacy Invariant: Raw phone number +12025550199 MUST NOT be present in recipient display
    assert.ok(html.includes('data-testid="detail-masked-recipient"'));

    // Privacy Invariant: NO reveal toggle buttons/links are rendered
    assert.ok(!html.includes('Reveal'));
    assert.ok(!html.includes('Show'));
    assert.ok(!html.includes('Toggle recipient address visibility'));

    // Attempt history is present
    assert.ok(html.includes('Dispatch Attempts'));
    assert.ok(html.includes('prv-meta…'));
    assert.ok(html.includes('142 ms'));

    // Collapsible payload section is present
    assert.ok(html.includes('Message Payload'));
  });

  // ---------------------------------------------------------------------------
  // 3. MessageListCard Masking, Behavior & State Tests
  // ---------------------------------------------------------------------------
  it('4. MessageListCard renders filter controls, table headers, and refresh action', () => {
    setupSessionWithGrants(ORG_A, ['messages.read']);
    const queryClient: QueryClient = createAppQueryClient();

    queryClient.setQueryData(['workspaces', 'list', ORG_A], {
      data: [{ id: WORKSPACE_ID, name: 'Default Workspace' }],
    });

    const html = renderWithQueryClient(
      React.createElement(MessageListCard, {
        orgId: ORG_A,
        channels: [mockChannel],
      }),
      queryClient,
    );

    // Filter controls present
    assert.ok(html.includes('id="filter-status"'));
    assert.ok(html.includes('id="filter-channel"'));
    assert.ok(html.includes('id="filter-workspace"'));
    assert.ok(html.includes('All Statuses'));
    assert.ok(html.includes('All Channels'));
    assert.ok(html.includes('All Workspaces'));
    assert.ok(html.includes('Refresh'));

    // Table headers present
    assert.ok(html.includes('Dispatched'));
    assert.ok(html.includes('Channel'));
    assert.ok(html.includes('Recipient Address'));
    assert.ok(html.includes('Status'));
    assert.ok(html.includes('Attempts'));
    assert.ok(html.includes('Failure Reason'));
    assert.ok(html.includes('Actions'));
  });

  it('5. MessageListCard renders recipient addresses masked and STRICTLY omits reveal controls', () => {
    setupSessionWithGrants(ORG_A, ['messages.read']);
    const queryClient: QueryClient = createAppQueryClient();

    queryClient.setQueryData(
      [
        'messages',
        'list',
        ORG_A,
        {
          status: undefined,
          channelCode: undefined,
          workspaceId: undefined,
          cursor: undefined,
          limit: 25,
        },
      ],
      {
        data: [mockSummary],
        page: { hasMore: false, nextCursor: null, limit: 25 },
      },
    );

    const html = renderWithQueryClient(
      React.createElement(MessageListCard, {
        orgId: ORG_A,
        channels: [mockChannel],
      }),
      queryClient,
    );

    // Message row is rendered
    assert.ok(html.includes(`data-testid="message-row-${MSG_ID}"`));
    assert.ok(html.includes('WhatsApp Business'));
    assert.ok(html.includes('1 attempt'));
    assert.ok(html.includes('Inspect'));

    // Recipient address is masked
    assert.ok(html.includes('+1 •••• 0199'));
    assert.ok(!html.includes('+12025550199'));

    // Privacy Invariant: NO reveal toggle controls are present
    assert.ok(!html.includes('aria-label="Toggle address visibility'));
    assert.ok(!html.includes('Reveal'));
    assert.ok(!html.includes('>Show<'));
    assert.ok(!html.includes('>Hide<'));
  });

  it('6. MessageListCard displays empty state when no messages exist', () => {
    setupSessionWithGrants(ORG_A, ['messages.read']);
    const queryClient: QueryClient = createAppQueryClient();

    queryClient.setQueryData(
      [
        'messages',
        'list',
        ORG_A,
        {
          status: undefined,
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

    const html = renderWithQueryClient(
      React.createElement(MessageListCard, {
        orgId: ORG_A,
        channels: [mockChannel],
      }),
      queryClient,
    );

    assert.ok(html.includes('No messages found'));
    assert.ok(html.includes('Outbound messages dispatched by this organization will appear here.'));
  });

  it('7. MessageListCard displays loading spinner when query is in-flight', () => {
    setupSessionWithGrants(ORG_A, ['messages.read']);
    const queryClient: QueryClient = createAppQueryClient();

    // Query unseeded -> isLoading is true
    const html = renderWithQueryClient(
      React.createElement(MessageListCard, {
        orgId: ORG_A,
        channels: [mockChannel],
      }),
      queryClient,
    );

    assert.ok(html.includes('Loading messages…'));
  });

  it('8. MessageListCard displays error banner and retry action on query failure', () => {
    setupSessionWithGrants(ORG_A, ['messages.read']);
    const queryClient: QueryClient = createAppQueryClient();

    const queryKey = [
      'messages',
      'list',
      ORG_A,
      {
        status: undefined,
        channelCode: undefined,
        workspaceId: undefined,
        cursor: undefined,
        limit: 25,
      },
    ];

    queryClient.setQueryDefaults(queryKey, {
      retry: false,
      retryOnMount: false,
      refetchOnMount: false,
    });
    // Seed an error state in the query cache
    const query = queryClient.getQueryCache().build(queryClient, { queryKey });
    query.setState({
      status: 'error',
      error: new ApiError(
        500,
        'DISPATCH_BROKER_TIMEOUT',
        'Network timeout reaching message broker',
        'corr-msg-err-1',
        true,
      ),
      fetchStatus: 'idle',
      errorUpdatedAt: Date.now(),
    });

    const html = renderWithQueryClient(
      React.createElement(MessageListCard, {
        orgId: ORG_A,
        channels: [mockChannel],
      }),
      queryClient,
    );

    assert.ok(html.includes('Failed to load messages (DISPATCH_BROKER_TIMEOUT)'));
    assert.ok(html.includes('Retry'));
  });

  it('9. MessageListCard renders pagination controls with proper disabled states', () => {
    setupSessionWithGrants(ORG_A, ['messages.read']);
    const queryClient: QueryClient = createAppQueryClient();

    queryClient.setQueryData(
      [
        'messages',
        'list',
        ORG_A,
        {
          status: undefined,
          channelCode: undefined,
          workspaceId: undefined,
          cursor: undefined,
          limit: 25,
        },
      ],
      {
        data: [mockSummary],
        page: { hasMore: true, nextCursor: 'cur-page-2', limit: 25 },
      },
    );

    const html = renderWithQueryClient(
      React.createElement(MessageListCard, {
        orgId: ORG_A,
        channels: [mockChannel],
      }),
      queryClient,
    );

    assert.ok(html.includes('Limit: 25'));
    assert.ok(html.includes('Previous'));
    assert.ok(html.includes('Next'));
  });

  it('10. MessageListCard isolates query cache between different organizations', () => {
    setupSessionWithGrants(ORG_A, ['messages.read']);
    const queryClient: QueryClient = createAppQueryClient();

    // Populate Org A only
    queryClient.setQueryData(
      [
        'messages',
        'list',
        ORG_A,
        {
          status: undefined,
          channelCode: undefined,
          workspaceId: undefined,
          cursor: undefined,
          limit: 25,
        },
      ],
      {
        data: [mockSummary],
        page: { hasMore: false, nextCursor: null, limit: 25 },
      },
    );

    // Switch to Org B
    setupSessionWithGrants(ORG_B, ['messages.read']);

    const htmlOrgB = renderWithQueryClient(
      React.createElement(MessageListCard, {
        orgId: ORG_B,
        channels: [mockChannel],
      }),
      queryClient,
    );

    // Org B must NOT render Org A's message
    assert.ok(!htmlOrgB.includes(`data-testid="message-row-${MSG_ID}"`));
    // Org B query is not seeded, so it renders loading state
    assert.ok(htmlOrgB.includes('Loading messages…'));
  });

  it('11. MessageListCard resets cursor stack, filters, and renders Org B page 1 on same mounted component while on page 2 (F1)', async () => {
    setupSessionWithGrants(ORG_A, ['messages.read']);
    const queryClient: QueryClient = createAppQueryClient();

    const mockSummaryPage2: MessageSummaryResponse = {
      id: '01955b0a-7b3b-7411-9a4f-msg000000002',
      orgId: ORG_A,
      workspaceId: WORKSPACE_ID,
      contactId: '01955b0a-7b3b-7411-9a4f-ct000000001',
      channelId: CHANNEL_ID,
      channelCode: 'whatsapp',
      templateId: null,
      status: 'failed',
      recipientAddress: '+12025550199',
      failureReason: 'Rate limit exceeded',
      attemptCount: 1,
      createdAt: '2026-10-21T12:05:00.000Z',
      completedAt: '2026-10-21T12:05:02.000Z',
    };

    const mockSummaryOrgB: MessageSummaryResponse = {
      id: '01955b0a-7b3b-7411-9a4f-msg000000003',
      orgId: ORG_B,
      workspaceId: WORKSPACE_ID,
      contactId: '01955b0a-7b3b-7411-9a4f-ct000000002',
      channelId: CHANNEL_ID,
      channelCode: 'whatsapp',
      templateId: null,
      status: 'accepted',
      recipientAddress: '+14155550188',
      failureReason: null,
      attemptCount: 1,
      createdAt: '2026-10-21T12:30:00.000Z',
      completedAt: '2026-10-21T12:30:02.000Z',
    };

    const originalList = messagesApi.list;
    const originalWorkspacesList = workspacesApi.list;
    workspacesApi.list = async () => ({
      data: [
        {
          id: WORKSPACE_ID,
          orgId: ORG_A,
          name: 'Default Workspace',
          slug: 'default',
          status: 'active',
          isDefault: true,
          createdAt: '2026-10-15T10:00:00.000Z',
          updatedAt: '2026-10-15T10:00:00.000Z',
        },
      ],
      page: { hasMore: false, nextCursor: null, limit: 50 },
    });

    const listRequests: Array<{ orgId: string; params: ListMessagesParams }> = [];
    messagesApi.list = async (params = {}, _signal) => {
      const currentOrg = useSession.getState().selectedOrganizationId || '';
      listRequests.push({ orgId: currentOrg, params: { ...params } });

      if (currentOrg === ORG_A) {
        if (params?.cursor === 'cur-a-page-2') {
          return {
            data: [mockSummaryPage2],
            page: { hasMore: false, nextCursor: null, limit: 25 },
          };
        }
        return {
          data: [mockSummary],
          page: { hasMore: true, nextCursor: 'cur-a-page-2', limit: 25 },
        };
      } else if (currentOrg === ORG_B) {
        return {
          data: [mockSummaryOrgB],
          page: { hasMore: false, nextCursor: null, limit: 25 },
        };
      }
      return { data: [], page: { hasMore: false, nextCursor: null, limit: 25 } };
    };

    const domHandle = setupDom();
    const testHandle = { current: null as MessageListCardTestHandle | null };

    // Restore real useSyncExternalStore for DOM mount so react-query and zustand listeners function
    React.useSyncExternalStore = originalUseSyncExternalStore;

    try {
      // 1. Mount MessageListCard under ORG_A on page 1
      await React.act(async () => {
        domHandle.root.render(
          React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(MessageListCard, {
              orgId: ORG_A,
              channels: [mockChannel],
              testHandleRef: testHandle,
            }),
          ),
        );
      });
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

      // 2. Advance to page 2 and apply a status filter while on ORG_A
      await React.act(async () => {
        testHandle.current?.setSelectedStatus('failed');
        testHandle.current?.setCursorStack(['cur-a-page-2']);
      });
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });

      assert.deepEqual(testHandle.current?.getCursorStack(), ['cur-a-page-2']);
      assert.equal(testHandle.current?.getSelectedStatus(), 'failed');

      // 3. Switch active organization to ORG_B in session AND re-render the SAME mounted component
      // (WITHOUT a changing key prop, updating the mounted instance with new props)
      await React.act(async () => {
        setupSessionWithGrants(ORG_B, ['messages.read']);
      });
      await React.act(async () => {
        domHandle.root.render(
          React.createElement(
            QueryClientProvider,
            { client: queryClient },
            React.createElement(MessageListCard, {
              orgId: ORG_B,
              channels: [mockChannel],
              testHandleRef: testHandle,
            }),
          ),
        );
      });
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      // 4. Assert: requests dispatched for ORG_B
      const orgBRequests = listRequests.filter((r) => r.orgId === ORG_B);
      assert.ok(orgBRequests.length > 0, 'At least one request must be dispatched for Org B');

      // Crucial F1 regression invariant: The very first request for the new organization
      // MUST NOT contain Org A's cursor
      const firstOrgBRequest = orgBRequests[0];
      assert.ok(firstOrgBRequest, 'First Org B request must exist');
      assert.equal(
        firstOrgBRequest.params.cursor,
        undefined,
        'First request for Org B must not carry Org A cursor',
      );

      // In fact, all initial page requests for Org B must have cursor === undefined
      for (const req of orgBRequests) {
        assert.equal(
          req.params.cursor,
          undefined,
          'Initial requests for Org B must not carry any cursor',
        );
      }

      // Crucial F1 regression invariant: Filters must be reset to 'all' / undefined
      assert.equal(
        firstOrgBRequest.params.status,
        undefined,
        'Status filter must be reset to undefined on org switch (not retained as failed)',
      );
      assert.equal(testHandle.current?.getSelectedStatus(), 'all');
      assert.deepEqual(testHandle.current?.getCursorStack(), []);

      // 5. Assert: rendered output never displays old tenant data and displays Org B data
      const html = domHandle.getHtml();
      assert.ok(
        html.includes(`data-testid="message-row-${mockSummaryOrgB.id}"`),
        'Org B message row must be displayed',
      );
      assert.ok(
        !html.includes(`data-testid="message-row-${MSG_ID}"`),
        'Org A page 1 message row must NOT be displayed after switching to Org B',
      );
      assert.ok(
        !html.includes(`data-testid="message-row-${mockSummaryPage2.id}"`),
        'Org A page 2 message row must NOT be displayed after switching to Org B',
      );
    } finally {
      messagesApi.list = originalList;
      workspacesApi.list = originalWorkspacesList;
      domHandle.unmount();
      React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();
    }
  });
});
