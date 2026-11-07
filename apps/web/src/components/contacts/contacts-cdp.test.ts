import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  extractContactTags,
  setContactTags,
  extractCustomFields,
  setCustomField,
  removeCustomField,
  generateContactTimeline,
  type ContactMessageActivityRecord,
} from '@/lib/cdp';
import { ContactTagsCard } from './contact-tags-card';
import { ContactCustomFieldsCard } from './contact-custom-fields-card';
import { ContactTimelineCard } from './contact-timeline-card';
import { ContactProfileView } from './contact-profile-view';
import { contactsApi } from '@/lib/api-client';
import { useSession } from '@/lib/session-store';
import type {
  ConsentEventResponse,
  ContactActivityResponse,
  ContactIdentityResponse,
  ContactResponse,
} from '@acc/contracts';

(globalThis as unknown as { React: typeof React }).React = React;

function setupSession() {
  useSession.getState().setSession({
    accessToken: 'test-token',
    user: {
      userId: 'usr-1',
      email: 'admin@alendei.test',
      actorType: 'user',
      authMethod: 'session',
      sessionId: 'sess-1',
      authenticatedAt: new Date().toISOString(),
      tenant: { orgId: 'org-1', workspaceId: null, resellerId: null, isPlatformAdmin: false },
      authorizedOrganizationIds: ['org-1'],
      roles: [],
      permissions: [],
    },
    authorization: {
      actorType: 'user',
      userId: 'usr-1',
      apiKeyId: null,
      isPlatformAdmin: false,
      organizationIds: ['org-1'],
      grants: [
        {
          roleId: 'role-1',
          roleKey: 'org_admin',
          scopeType: 'organization',
          scopeId: 'org-1',
          orgId: 'org-1',
          permissions: ['contacts.read', 'contacts.manage'],
        },
      ],
    },
  });
}

function renderWithClient(ui: React.ReactElement): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client: queryClient }, ui),
  );
}

describe('Phase 8A Contacts / CDP Core & UI Components', () => {
  const mockContact: ContactResponse = {
    id: '01955b0a-7b3b-7411-9a4f-ct000000001',
    workspaceId: '01955b0a-7b3b-7411-9a4f-ws000000001',
    firstName: 'Sarah',
    lastName: 'Connor',
    metadata: {
      tags: ['VIP', 'Customer', 'Beta-Tester'],
      company: 'Cyberdyne Systems',
      accountTier: 'Enterprise',
      lifetimeValue: 45000,
      activeContract: true,
    },
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-02T12:00:00.000Z',
  };

  const mockIdentities: ContactIdentityResponse[] = [
    {
      id: '01955b0a-7b3b-7411-9a4f-idnt0000001',
      workspaceId: '01955b0a-7b3b-7411-9a4f-ws000000001',
      contactId: mockContact.id,
      channelId: '01955b0a-7b3b-7411-9a4f-ch000000001',
      rawAddress: '+12025550199',
      normalizedAddress: '+12025550199',
      isPrimary: true,
      status: 'active',
      createdAt: '2026-11-01T10:05:00.000Z',
      updatedAt: '2026-11-01T10:05:00.000Z',
    },
    {
      id: '01955b0a-7b3b-7411-9a4f-idnt0000002',
      workspaceId: '01955b0a-7b3b-7411-9a4f-ws000000001',
      contactId: mockContact.id,
      channelId: '01955b0a-7b3b-7411-9a4f-ch000000002',
      rawAddress: 'sarah.connor@example.com',
      normalizedAddress: 'sarah.connor@example.com',
      isPrimary: false,
      status: 'active',
      createdAt: '2026-11-01T10:10:00.000Z',
      updatedAt: '2026-11-01T10:10:00.000Z',
    },
  ];

  const mockConsentEvents: ConsentEventResponse[] = [
    {
      id: '01955b0a-7b3b-7411-9a4f-cns00000001',
      workspaceId: '01955b0a-7b3b-7411-9a4f-ws000000001',
      contactId: mockContact.id,
      channelId: '01955b0a-7b3b-7411-9a4f-ch000000001',
      consentType: 'marketing',
      event: 'grant',
      occurredAt: '2026-11-01T10:15:00.000Z',
      source: 'web_form',
      createdAt: '2026-11-01T10:15:00.000Z',
    },
  ];

  // ---------------------------------------------------------------------------
  // 1. CDP Tag Utilities
  // ---------------------------------------------------------------------------
  it('1. extractContactTags parses array, comma-separated, and handles missing tags', () => {
    assert.deepEqual(extractContactTags(mockContact.metadata), ['VIP', 'Customer', 'Beta-Tester']);
    assert.deepEqual(extractContactTags({ tags: 'Lead, Wholesale, High-Priority ' }), [
      'Lead',
      'Wholesale',
      'High-Priority',
    ]);
    assert.deepEqual(extractContactTags({ tag_list: ['Partner'] }), ['Partner']);
    assert.deepEqual(extractContactTags({}), []);
    assert.deepEqual(extractContactTags(null), []);
  });

  it('2. setContactTags deduplicates case-insensitively and updates metadata', () => {
    const updated = setContactTags(mockContact.metadata, ['VIP', 'vip', 'Partner', '  Lead  ']);
    assert.deepEqual(updated.tags, ['VIP', 'Partner', 'Lead']);
    assert.equal(updated.company, 'Cyberdyne Systems'); // preserves existing fields
  });

  // ---------------------------------------------------------------------------
  // 2. Custom Fields Utilities
  // ---------------------------------------------------------------------------
  it('3. extractCustomFields correctly classifies types and excludes reserved tag keys', () => {
    const fields = extractCustomFields(mockContact.metadata);
    const map = new Map(fields.map((f) => [f.key, f]));

    assert.ok(!map.has('tags')); // tags excluded
    assert.equal(map.get('company')?.type, 'string');
    assert.equal(map.get('company')?.value, 'Cyberdyne Systems');
    assert.equal(map.get('lifetimeValue')?.type, 'number');
    assert.equal(map.get('lifetimeValue')?.value, 45000);
    assert.equal(map.get('activeContract')?.type, 'boolean');
    assert.equal(map.get('activeContract')?.value, true);
  });

  it('4. setCustomField and removeCustomField update metadata immutably', () => {
    const withNew = setCustomField(mockContact.metadata, 'region', 'EMEA');
    assert.equal(withNew.region, 'EMEA');
    assert.equal(withNew.company, 'Cyberdyne Systems');

    const withoutCompany = removeCustomField(withNew, 'company');
    assert.equal(withoutCompany.company, undefined);
    assert.equal(withoutCompany.region, 'EMEA');
  });

  // ---------------------------------------------------------------------------
  // 3. Activity Timeline Synthesis
  // ---------------------------------------------------------------------------
  it('5. generateContactTimeline creates chronologically ordered events from authentic records without mock messages', () => {
    const timeline = generateContactTimeline(mockContact, mockIdentities, mockConsentEvents);

    assert.ok(timeline.length >= 4);

    // Verify ordering: newest first
    for (let i = 0; i < timeline.length - 1; i++) {
      const current = new Date(timeline[i]!.timestamp).getTime();
      const next = new Date(timeline[i + 1]!.timestamp).getTime();
      assert.ok(current >= next, `Event at ${i} should be newer or equal to ${i + 1}`);
    }

    // Verify presence of authentic contact_created, identity_added, consent_granted
    const types = new Set(timeline.map((e) => e.type));
    assert.ok(types.has('contact_created'));
    assert.ok(types.has('identity_added'));
    assert.ok(types.has('consent_granted'));

    // Invariant: no inferred profile updates from contact.updatedAt
    assert.equal(types.has('field_updated'), false);
    assert.equal(timeline.find((e) => e.title === 'Contact Record Updated'), undefined);

    // Verify absence of mock message events when no message records are supplied
    assert.equal(timeline.filter((e) => e.category === 'message').length, 0);
    assert.equal(types.has('message_delivered'), false);
    assert.equal(types.has('message_sent'), false);
    assert.equal(types.has('message_read'), false);
  });

  // ---------------------------------------------------------------------------
  // 4. ContactTagsCard Component
  // ---------------------------------------------------------------------------
  it('6. ContactTagsCard renders active tags, count, and management controls', () => {
    const html = renderWithClient(
      React.createElement(ContactTagsCard, {
        contact: mockContact,
        canManage: true,
      }),
    );

    assert.ok(html.includes('Tags &amp; Segmentation') || html.includes('Tags & Segmentation'));
    assert.ok(html.includes('3 tags'));
    assert.ok(html.includes('data-testid="contact-tag-vip"'));
    assert.ok(html.includes('data-testid="contact-tag-customer"'));
    assert.ok(html.includes('data-testid="add-tag-input"'));
    assert.ok(html.includes('data-testid="add-tag-btn"'));
  });

  it('7. ContactTagsCard hides add tag input when canManage is false', () => {
    const html = renderWithClient(
      React.createElement(ContactTagsCard, {
        contact: mockContact,
        canManage: false,
      }),
    );

    assert.ok(!html.includes('data-testid="add-tag-input"'));
    assert.ok(!html.includes('data-testid="add-tag-btn"'));
  });

  // ---------------------------------------------------------------------------
  // 5. ContactCustomFieldsCard Component
  // ---------------------------------------------------------------------------
  it('8. ContactCustomFieldsCard renders attributes table with types and values', () => {
    const html = renderWithClient(
      React.createElement(ContactCustomFieldsCard, {
        contact: mockContact,
        canManage: true,
      }),
    );

    assert.ok(
      html.includes('Custom Fields &amp; CDP Attributes') ||
        html.includes('Custom Fields & CDP Attributes'),
    );
    assert.ok(html.includes('Cyberdyne Systems'));
    assert.ok(html.includes('Enterprise'));
    assert.ok(html.includes('45000'));
    assert.ok(html.includes('data-testid="add-custom-field-btn"'));
    assert.ok(html.includes('data-testid="delete-field-btn-company"'));
  });

  // ---------------------------------------------------------------------------
  // 6. ContactTimelineCard Component
  // ---------------------------------------------------------------------------
  it('9. ContactTimelineCard renders category filters and timeline item nodes', () => {
    const initialActivities: ContactActivityResponse[] = [
      {
        id: 'act-001-created',
        contactId: mockContact.id,
        workspaceId: mockContact.workspaceId,
        type: 'contact_created',
        category: 'profile',
        title: 'Contact Created',
        description: 'Contact record registered in workspace',
        timestamp: mockContact.createdAt,
        statusTone: 'neutral',
      },
    ];

    const html = renderWithClient(
      React.createElement(ContactTimelineCard, {
        contact: mockContact,
        initialActivities,
      }),
    );

    assert.ok(
      html.includes('Activity &amp; Engagement Timeline') ||
        html.includes('Activity & Engagement Timeline'),
    );
    assert.ok(html.includes('data-testid="filter-timeline-all"'));
    assert.ok(html.includes('data-testid="filter-timeline-message"'));
    assert.ok(html.includes('data-testid="filter-timeline-consent"'));
    assert.ok(html.includes('data-testid="activity-timeline"'));
    assert.ok(html.includes('Contact Created'));
  });

  // ---------------------------------------------------------------------------
  // 7. ContactProfileView Full Profile Page
  // ---------------------------------------------------------------------------
  it('10. ContactProfileView renders hero, metric bar, tabs, and action buttons', () => {
    setupSession();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['contacts', 'detail', mockContact.id], { data: mockContact });
    queryClient.setQueryData(['contacts', 'identities', mockContact.id], { data: mockIdentities });
    queryClient.setQueryData(['channels', 'list', { limit: 50 }], { data: [] });

    const html = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(ContactProfileView, {
          contactId: mockContact.id,
          canRead: true,
          canManage: true,
        }),
      ),
    );

    assert.ok(html.includes('data-testid="contact-profile-view"'));
    assert.ok(html.includes('Sarah Connor'));
    assert.ok(html.includes('CDP Profile'));
    assert.ok(html.includes('data-testid="stat-identities-count"'));
    assert.ok(html.includes('data-testid="stat-tags-count"'));
    assert.ok(html.includes('data-testid="stat-fields-count"'));
    assert.ok(html.includes('Overview'));
    assert.ok(html.includes('Identities &amp; Channels') || html.includes('Identities & Channels'));
    assert.ok(html.includes('Tags &amp; Custom Fields') || html.includes('Tags & Custom Fields'));
    assert.ok(html.includes('Activity Timeline'));
  });

  it('11. ContactProfileView renders Access Forbidden when canRead is false', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const html = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(ContactProfileView, {
          contactId: mockContact.id,
          canRead: false,
        }),
      ),
    );

    assert.ok(html.includes('Access Forbidden'));
    assert.ok(html.includes('contacts.read'));
  });

  // ---------------------------------------------------------------------------
  // 8. Regression Tests for Zero Mock Message Generation (Safety & Integrity)
  // ---------------------------------------------------------------------------
  it('12. REGRESSION: Contact with WhatsApp and SMS identities but no message records produces 0 message activities and no synthetic provider artifacts', () => {
    const contactWithIdentities: ContactResponse = {
      id: '01955b0a-7b3b-7411-9a4f-ct-regression',
      workspaceId: '01955b0a-7b3b-7411-9a4f-ws000000001',
      firstName: 'Alice',
      lastName: 'Smith',
      metadata: { tags: ['VIP'] },
      createdAt: '2026-11-05T08:00:00.000Z',
      updatedAt: '2026-11-05T08:00:00.000Z',
    };

    const waAndSmsIdentities: ContactIdentityResponse[] = [
      {
        id: 'idnt-wa-01',
        workspaceId: '01955b0a-7b3b-7411-9a4f-ws000000001',
        contactId: contactWithIdentities.id,
        channelId: 'ch-wa-01',
        rawAddress: '+12025550177',
        normalizedAddress: '+12025550177',
        isPrimary: true,
        status: 'active',
        createdAt: '2026-11-05T08:05:00.000Z',
        updatedAt: '2026-11-05T08:05:00.000Z',
      },
      {
        id: 'idnt-sms-01',
        workspaceId: '01955b0a-7b3b-7411-9a4f-ws000000001',
        contactId: contactWithIdentities.id,
        channelId: 'ch-sms-01',
        rawAddress: '+12025550178',
        normalizedAddress: '+12025550178',
        isPrimary: false,
        status: 'active',
        createdAt: '2026-11-05T08:06:00.000Z',
        updatedAt: '2026-11-05T08:06:00.000Z',
      },
    ];

    // Generate timeline with NO message records
    const timeline = generateContactTimeline(contactWithIdentities, waAndSmsIdentities, []);

    // 1. Total events should ONLY be contact_created (1) and identity_added (2) = 3
    assert.equal(timeline.length, 3);

    // 2. ZERO message category events
    const messageEvents = timeline.filter((e) => e.category === 'message');
    assert.equal(messageEvents.length, 0);

    // 3. No synthetic message types
    const types = new Set(timeline.map((e) => e.type));
    assert.equal(types.has('message_sent'), false);
    assert.equal(types.has('message_delivered'), false);
    assert.equal(types.has('message_read'), false);
    assert.equal(types.has('message_failed'), false);

    // 4. Verify no fabricated provider strings exist anywhere in output
    const serialized = JSON.stringify(timeline);
    assert.equal(serialized.includes('wamid'), false);
    assert.equal(serialized.includes('Meta Cloud API'), false);
    assert.equal(serialized.includes('delivery receipt'), false);
    assert.equal(serialized.includes('Carrier confirmed'), false);
    assert.equal(serialized.includes('WhatsApp Business Gateway'), false);
    assert.equal(serialized.includes('Security authentication code'), false);

    // 5. Render ContactTimelineCard and verify message count shows (0)
    const html = renderWithClient(
      React.createElement(ContactTimelineCard, {
        contact: contactWithIdentities,
        identities: waAndSmsIdentities,
      }),
    );
    assert.ok(html.includes('data-testid="filter-timeline-message"'));
    assert.ok(html.includes('(0)'));
  });

  it('13. generateContactTimeline correctly maps authentic message records into timeline events', () => {
    const authenticMessages: ContactMessageActivityRecord[] = [
      {
        id: 'msg-real-001',
        channelCode: 'whatsapp',
        recipientAddress: '+12025550199',
        status: 'submitted',
        deliveryStatus: 'delivered',
        createdAt: '2026-11-01T11:00:00.000Z',
        deliveredAt: '2026-11-01T11:00:04.000Z',
        readAt: '2026-11-01T11:05:00.000Z',
        templateName: 'order_receipt',
      },
      {
        id: 'msg-real-002',
        channelCode: 'sms',
        recipientAddress: '+12025550198',
        status: 'failed',
        deliveryStatus: 'undelivered',
        createdAt: '2026-11-01T12:00:00.000Z',
        failureReason: 'Carrier network timeout',
      },
    ];

    const timeline = generateContactTimeline(
      mockContact,
      mockIdentities,
      mockConsentEvents,
      authenticMessages,
    );

    // Authentic message events are present
    const messageEvents = timeline.filter((e) => e.category === 'message');
    assert.equal(messageEvents.length, 4); // msg-001: read, delivered, sent; msg-002: failed (no sent!)

    const msgTypes = new Set(messageEvents.map((e) => e.type));
    assert.ok(msgTypes.has('message_read'));
    assert.ok(msgTypes.has('message_delivered'));
    assert.ok(msgTypes.has('message_sent'));
    assert.ok(msgTypes.has('message_failed'));

    // Check authentic metadata mapping and address masking
    const readEvent = messageEvents.find((e) => e.type === 'message_read');
    assert.equal(readEvent?.metadata?.messageId, 'msg-real-001');
    assert.equal(readEvent?.metadata?.templateName, 'order_receipt');
    assert.equal(readEvent?.metadata?.recipientAddress, '+1 •••• 0199');

    const failEvent = messageEvents.find((e) => e.type === 'message_failed');
    assert.equal(failEvent?.metadata?.messageId, 'msg-real-002');
    assert.equal(failEvent?.metadata?.failureReason, 'Carrier network timeout');
    assert.equal(failEvent?.metadata?.recipientAddress, '+1 •••• 0198');
  });

  // ---------------------------------------------------------------------------
  // 9. Contact Activity Backend API Client & Timeline Card Integration
  // ---------------------------------------------------------------------------
  it('14. contactsApi.listActivities constructs correct endpoint path and query parameters', async () => {
    setupSession();
    let capturedUrl = '';
    let capturedHeaders: HeadersInit | undefined;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = init?.headers;
      return new Response(
        JSON.stringify({
          data: [],
          page: { hasMore: false, nextCursor: null, limit: 25 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      await contactsApi.listActivities('ct-123', {
        category: 'message',
        cursor: 'test-cursor-token',
        limit: 15,
      });

      assert.ok(capturedUrl.includes('/contacts/ct-123/activities'));
      assert.ok(capturedUrl.includes('category=message'));
      assert.ok(capturedUrl.includes('cursor=test-cursor-token'));
      assert.ok(capturedUrl.includes('limit=15'));
      const headers = capturedHeaders as Record<string, string>;
      assert.equal(headers['X-Acc-Organization'], 'org-1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('15. ContactTimelineCard renders genuine backend activity items, channel badges, and empty states', () => {
    const genuineActivities: ContactActivityResponse[] = [
      {
        id: 'act-msg-01-deliv',
        contactId: mockContact.id,
        workspaceId: mockContact.workspaceId,
        type: 'message_delivered',
        category: 'message',
        title: 'WHATSAPP Delivered',
        description: 'Confirmed delivered to recipient endpoint',
        timestamp: '2026-11-01T11:00:04.000Z',
        channelId: 'ch-wa-01',
        channelCode: 'whatsapp',
        statusTone: 'success',
        metadata: { messageId: 'msg-real-001', recipientAddress: '+1 •••• 0199' },
      },
      {
        id: 'act-cns-01',
        contactId: mockContact.id,
        workspaceId: mockContact.workspaceId,
        type: 'consent_granted',
        category: 'consent',
        title: 'Consent Granted',
        description: 'MARKETING consent granted (Source: web_form)',
        timestamp: '2026-11-01T10:05:00.000Z',
        channelId: 'ch-wa-01',
        channelCode: 'whatsapp',
        statusTone: 'success',
      },
      {
        id: 'act-created',
        contactId: mockContact.id,
        workspaceId: mockContact.workspaceId,
        type: 'contact_created',
        category: 'profile',
        title: 'Contact Created',
        description: 'Contact record registered in workspace',
        timestamp: '2026-11-01T10:00:00.000Z',
        statusTone: 'neutral',
      },
    ];

    const html = renderWithClient(
      React.createElement(ContactTimelineCard, {
        contact: mockContact,
        initialActivities: genuineActivities,
      }),
    );

    // Verify presence of genuine items in rendered markup
    assert.ok(html.includes('WHATSAPP Delivered'));
    assert.ok(html.includes('whatsapp'));
    assert.ok(html.includes('Consent Granted'));
    assert.ok(html.includes('Contact Created'));
    assert.ok(html.includes('data-testid="timeline-filters"'));
    assert.ok(html.includes('data-testid="filter-timeline-all"'));
    assert.ok(html.includes('data-testid="filter-timeline-message"'));
    assert.ok(html.includes('data-testid="filter-timeline-consent"'));
    assert.ok(html.includes('data-testid="activity-timeline"'));
  });

  it('16. ContactTimelineCard renders error state and never renders synthetic fallback events on API failure', () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          retryOnMount: false,
        },
      },
    });
    // Set query state to error via queryCache
    const queryKey = ['contacts', 'activities', mockContact.id, 'all'];
    const query = queryClient.getQueryCache().build(queryClient, { queryKey });
    query.setState({
      status: 'error',
      error: new Error('Network failure: 500 Internal Server Error'),
      errorUpdatedAt: Date.now(),
      fetchStatus: 'idle',
    });

    const html = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(ContactTimelineCard, {
          contact: mockContact,
          identities: mockIdentities,
        }),
      ),
    );

    // Verify error banner is present with retry action
    assert.ok(html.includes('data-testid="timeline-error"'));
    assert.ok(html.includes('Unable to load contact activity from server'));
    assert.ok(html.includes('Retry'));

    // Verify NO synthetic timeline nodes or items are rendered
    assert.equal(html.includes('data-testid="activity-timeline"'), false);
    assert.equal(html.includes('Contact Created'), false);
    assert.equal(html.includes('Identity Added'), false);
  });

  it('17. generateContactTimeline never infers profile updates from contact.updatedAt', () => {
    const contactWithUpdate: ContactResponse = {
      ...mockContact,
      updatedAt: '2026-11-06T15:30:00.000Z',
      createdAt: '2026-11-01T10:00:00.000Z',
      metadata: { tags: ['VIP', 'Customer'], segment: 'enterprise' },
    };

    const timeline = generateContactTimeline(contactWithUpdate, [], []);
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0]!.type, 'contact_created');

    // Verify no field_updated or Contact Record Updated event is generated
    const updateEvents = timeline.filter(
      (e) => e.type === ('field_updated' as never) || e.title.includes('Contact Record Updated'),
    );
    assert.equal(updateEvents.length, 0);
  });

  it('18. Identity addresses and recipient addresses are strictly masked without leaking raw values', () => {
    const rawNumber = '+12025550199';
    const rawEmail = 'customer@acme-corp.com';
    const testIdentities: ContactIdentityResponse[] = [
      {
        id: 'idnt-1',
        workspaceId: mockContact.workspaceId,
        contactId: mockContact.id,
        channelId: 'ch-wa-1',
        rawAddress: rawNumber,
        normalizedAddress: rawNumber,
        isPrimary: true,
        status: 'active',
        createdAt: '2026-11-01T10:00:00.000Z',
        updatedAt: '2026-11-01T10:00:00.000Z',
      },
      {
        id: 'idnt-2',
        workspaceId: mockContact.workspaceId,
        contactId: mockContact.id,
        channelId: 'ch-email-1',
        rawAddress: rawEmail,
        normalizedAddress: rawEmail,
        isPrimary: false,
        status: 'active',
        createdAt: '2026-11-01T10:00:00.000Z',
        updatedAt: '2026-11-01T10:00:00.000Z',
      },
    ];

    const timeline = generateContactTimeline(mockContact, testIdentities, []);
    const identEvents = timeline.filter((e) => e.category === 'identity');
    assert.equal(identEvents.length, 2);

    const serialized = JSON.stringify(identEvents);
    // Unmasked raw addresses must NOT appear
    assert.equal(serialized.includes(rawNumber), false);
    assert.equal(serialized.includes(rawEmail), false);

    // Masked versions must appear
    assert.ok(serialized.includes('+1 •••• 0199'));
    assert.ok(serialized.includes('c••••r@acme-corp.com'));

    for (const event of identEvents) {
      assert.equal(event.metadata?.rawAddress, undefined);
      assert.equal(event.metadata?.normalizedAddress, undefined);
      assert.ok(typeof event.metadata?.maskedAddress === 'string');
    }
  });

  it('19. Message status semantics: pending messages emit message_pending, failed messages never emit message_sent', () => {
    const messages: ContactMessageActivityRecord[] = [
      {
        id: 'msg-pending',
        channelCode: 'whatsapp',
        recipientAddress: '+12025550111',
        status: 'pending',
        createdAt: '2026-11-03T10:00:00.000Z',
      },
      {
        id: 'msg-submitted',
        channelCode: 'whatsapp',
        recipientAddress: '+12025550222',
        status: 'submitted',
        createdAt: '2026-11-03T10:05:00.000Z',
      },
      {
        id: 'msg-failed',
        channelCode: 'whatsapp',
        recipientAddress: '+12025550333',
        status: 'failed',
        failureReason: 'Rate limit exceeded',
        createdAt: '2026-11-03T10:10:00.000Z',
      },
    ];

    const timeline = generateContactTimeline(mockContact, [], [], messages);
    const msgEvents = timeline.filter((e) => e.category === 'message');

    // Verify msg-pending generated message_pending
    const pendingEvent = msgEvents.find((e) => e.id === 'event-msg-pending-msg-pending');
    assert.ok(pendingEvent);
    assert.equal(pendingEvent?.type, 'message_pending');
    assert.ok(pendingEvent?.title.includes('Pending Dispatch'));

    // Verify msg-submitted generated message_sent
    const sentEvent = msgEvents.find((e) => e.id === 'event-msg-sent-msg-submitted');
    assert.ok(sentEvent);
    assert.equal(sentEvent?.type, 'message_sent');
    assert.ok(sentEvent?.title.includes('Dispatched'));

    // Verify msg-failed generated message_failed and did NOT generate message_sent
    const failedEvent = msgEvents.find((e) => e.id === 'event-msg-fail-msg-failed');
    assert.ok(failedEvent);
    assert.equal(failedEvent?.type, 'message_failed');
    assert.equal(msgEvents.find((e) => e.id === 'event-msg-sent-msg-failed'), undefined);
  });
});
