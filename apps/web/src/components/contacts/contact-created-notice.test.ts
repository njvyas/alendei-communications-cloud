import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ContactResponse } from '@acc/contracts';

import {
  ContactCreatedNotice,
  createdContactName,
  shouldShowCreatedContactNotice,
  type CreatedContactRecord,
} from './contact-created-notice';
import { createContactWithIdentity } from './contact-create-dialog';
import { useSession } from '../../lib/session-store';

(globalThis as unknown as { React: typeof React }).React = React;

// QAF-019 (#30): after "Create Contact" the console must surface the created
// contact; the list is oldest first, so it is usually not on the first page.
describe('QAF-019: created contact is surfaced after creation', () => {
  const ORG_A = '01955b0a-7b3b-7411-9a4f-9e67d4f91111';
  const ORG_B = '01955b0a-7b3b-7411-9a4f-9e67d4f9bbbb';
  const WORKSPACE_1 = '01955b0a-7b3b-7411-9a4f-9e67d4f92222';
  const WORKSPACE_2 = '01955b0a-7b3b-7411-9a4f-9e67d4f92223';
  const CONTACT_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f94444';
  const CHANNEL_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f96666';

  const contact: ContactResponse = {
    id: CONTACT_ID,
    workspaceId: WORKSPACE_1,
    firstName: 'QA',
    lastName: 'Contact',
    metadata: {},
    createdAt: '2026-10-26T09:00:00.000Z',
    updatedAt: '2026-10-26T09:00:00.000Z',
  };
  const record: CreatedContactRecord = { contact, organizationId: ORG_A };

  const originalFetch = globalThis.fetch;
  let fetchCalls: { url: string; method: string; body: unknown }[] = [];

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  beforeEach(() => {
    fetchCalls = [];
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      fetchCalls.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith(`/workspaces/${WORKSPACE_1}/contacts`) && method === 'POST') {
        return json(201, { data: contact });
      }
      if (url.endsWith(`/contacts/${CONTACT_ID}/identities`) && method === 'POST') {
        return json(201, { data: { id: 'identity-1' } });
      }
      if (url.endsWith(`/contacts/${CONTACT_ID}/consent-events`) && method === 'POST') {
        return json(201, { data: { id: 'consent-1' } });
      }
      return json(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    };
    useSession.getState().setSession({
      accessToken: 'test-token',
      user: {
        userId: 'user-1',
        actorType: 'user',
        authMethod: 'session',
        sessionId: 'sess-1',
        authenticatedAt: new Date().toISOString(),
        tenant: {
          orgId: ORG_A,
          workspaceId: WORKSPACE_1,
          resellerId: null,
          isPlatformAdmin: false,
        },
        authorizedOrganizationIds: [ORG_A],
        roles: [],
        permissions: [],
      },
      authorization: {
        actorType: 'user',
        userId: 'user-1',
        apiKeyId: null,
        grants: [],
        organizationIds: [ORG_A],
        isPlatformAdmin: false,
      },
      selectedOrgId: ORG_A,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    useSession.getState().clearSession();
  });

  it('1. createContactWithIdentity returns the created contact after identity and consent', async () => {
    const created = await createContactWithIdentity({
      workspaceId: WORKSPACE_1,
      firstName: 'QA',
      lastName: 'Contact',
      phone: '+12025550190',
      whatsappChannelId: CHANNEL_ID,
      initialConsent: true,
      idempotencyKey: 'idem-qaf019-1',
    });

    assert.equal(created.id, CONTACT_ID);
    assert.deepEqual(
      fetchCalls.map((c) => [c.method, new URL(c.url).pathname.split('/').slice(-1)[0]]),
      [
        ['POST', 'contacts'],
        ['POST', 'identities'],
        ['POST', 'consent-events'],
      ],
    );
  });

  it('2. without a phone number only the contact is created, and it is still returned', async () => {
    const created = await createContactWithIdentity({
      workspaceId: WORKSPACE_1,
      firstName: 'QA',
      whatsappChannelId: CHANNEL_ID,
      initialConsent: true,
      idempotencyKey: 'idem-qaf019-2',
    });

    assert.equal(created.id, CONTACT_ID);
    assert.equal(fetchCalls.length, 1);
  });

  it('3. a failed step rejects, so no created contact is reported', async () => {
    await assert.rejects(
      createContactWithIdentity({
        workspaceId: WORKSPACE_2,
        firstName: 'QA',
        initialConsent: false,
        idempotencyKey: 'idem-qaf019-3',
      }),
    );
  });

  it('4. the notice is shown only in the organization and workspace it was created in', () => {
    assert.equal(shouldShowCreatedContactNotice(record, ORG_A, WORKSPACE_1), true);
    assert.equal(shouldShowCreatedContactNotice(record, ORG_B, WORKSPACE_1), false);
    assert.equal(shouldShowCreatedContactNotice(record, ORG_A, WORKSPACE_2), false);
    assert.equal(shouldShowCreatedContactNotice(null, ORG_A, WORKSPACE_1), false);
  });

  it('5. the notice names the contact, shows its ID and offers Manage Consent to managers', () => {
    const html = renderToStaticMarkup(
      React.createElement(ContactCreatedNotice, {
        contact,
        canManageContacts: true,
        onManageConsent: () => {},
        onDismiss: () => {},
      }),
    );

    assert.ok(html.includes('role="status"'));
    assert.ok(html.includes('QA Contact'));
    assert.ok(html.includes(CONTACT_ID));
    assert.ok(html.includes('data-testid="created-contact-manage-consent-btn"'));
    assert.ok(html.includes('Dismiss'));
  });

  it('6. without contacts.manage the notice offers no Manage Consent action', () => {
    const html = renderToStaticMarkup(
      React.createElement(ContactCreatedNotice, {
        contact,
        canManageContacts: false,
        onManageConsent: () => {},
        onDismiss: () => {},
      }),
    );

    assert.ok(!html.includes('created-contact-manage-consent-btn'));
  });

  it('7. an unnamed contact is labelled like the list does', () => {
    assert.equal(
      createdContactName({ ...contact, firstName: null, lastName: null }),
      'Unnamed Contact',
    );
  });
});
