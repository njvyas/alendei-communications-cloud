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
} from '@/lib/cdp';
import { ContactTagsCard } from './contact-tags-card';
import { ContactCustomFieldsCard } from './contact-custom-fields-card';
import { ContactTimelineCard } from './contact-timeline-card';
import { ContactProfileView } from './contact-profile-view';
import { useSession } from '@/lib/session-store';
import type {
  ConsentEventResponse,
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
  it('5. generateContactTimeline creates chronologically ordered events across all categories', () => {
    const timeline = generateContactTimeline(mockContact, mockIdentities, mockConsentEvents, {
      includeMockHistory: true,
    });

    assert.ok(timeline.length >= 4);

    // Verify ordering: newest first
    for (let i = 0; i < timeline.length - 1; i++) {
      const current = new Date(timeline[i]!.timestamp).getTime();
      const next = new Date(timeline[i + 1]!.timestamp).getTime();
      assert.ok(current >= next, `Event at ${i} should be newer or equal to ${i + 1}`);
    }

    // Verify presence of contact_created, identity_added, consent_granted
    const types = new Set(timeline.map((e) => e.type));
    assert.ok(types.has('contact_created'));
    assert.ok(types.has('identity_added'));
    assert.ok(types.has('consent_granted'));
    assert.ok(types.has('message_delivered'));
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
    const html = renderWithClient(
      React.createElement(ContactTimelineCard, {
        contact: mockContact,
        identities: mockIdentities,
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
});
