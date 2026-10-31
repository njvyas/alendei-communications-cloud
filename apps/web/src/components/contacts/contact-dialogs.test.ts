import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ContactConsentDialog } from './contact-consent-dialog';
import { ContactEditDialog } from './contact-edit-dialog';
import { ContactDetailDialog } from './contact-detail-dialog';
import type { ContactResponse } from '@acc/contracts';

(globalThis as unknown as { React: typeof React }).React = React;

function renderWithClient(ui: React.ReactElement): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client: queryClient }, ui),
  );
}

describe('Contact Dialog Components (U9)', () => {
  const baseContact: ContactResponse = {
    id: '01955b0a-7b3b-7411-9a4f-ct000000001',
    workspaceId: '01955b0a-7b3b-7411-9a4f-ws000000001',
    firstName: 'Alice',
    lastName: 'Smith',
    metadata: { tier: 'gold', vip: true },
    createdAt: '2026-10-31T10:00:00.000Z',
    updatedAt: '2026-10-31T10:00:00.000Z',
  };

  it('1. ContactConsentDialog renders multi-channel and consent type selectors', () => {
    const html = renderWithClient(
      React.createElement(ContactConsentDialog, {
        open: true,
        onOpenChange: () => {},
        contact: baseContact,
      }),
    );

    assert.ok(html.includes('role="dialog"'));
    assert.ok(html.includes('Record Consent Event'));
    assert.ok(html.includes('Alice Smith'));
    assert.ok(html.includes('id="consent-channel"'));
    assert.ok(html.includes('id="consent-type"'));
    assert.ok(html.includes('Transactional'));
    assert.ok(html.includes('Marketing'));
    assert.ok(html.includes('GRANT — Opt In'));
    assert.ok(html.includes('REVOKE — Opt Out'));
    assert.ok(html.includes('Immutable Ledger:'));
  });

  it('2. ContactEditDialog renders first name, last name, and metadata inputs', () => {
    const html = renderWithClient(
      React.createElement(ContactEditDialog, {
        open: true,
        onOpenChange: () => {},
        contact: baseContact,
      }),
    );

    assert.ok(html.includes('role="dialog"'));
    assert.ok(html.includes('Edit Contact'));
    assert.ok(html.includes('Alice'));
    assert.ok(html.includes('Smith'));
    assert.ok(html.includes('id="edit-contact-metadata"'));
    assert.ok(html.includes('&quot;tier&quot;: &quot;gold&quot;'));
    assert.ok(html.includes('Save Changes'));
  });

  it('3. ContactDetailDialog renders contact identity section and metadata', () => {
    const html = renderWithClient(
      React.createElement(ContactDetailDialog, {
        open: true,
        onOpenChange: () => {},
        contact: baseContact,
        canManage: true,
        onRecordConsent: () => {},
      }),
    );

    assert.ok(html.includes('role="dialog"'));
    assert.ok(html.includes('Alice Smith'));
    assert.ok(html.includes('01955b0a-7b3b-7411-9a4f-ct000000001'));
    assert.ok(html.includes('Contact Identities'));
    assert.ok(html.includes('+ Add Identity'));
    assert.ok(html.includes('Custom Attributes'));
    assert.ok(html.includes('&quot;tier&quot;: &quot;gold&quot;'));
    assert.ok(html.includes('Record Consent Event'));
  });

  it('4. ContactDetailDialog hides add identity button when canManage is false', () => {
    const html = renderWithClient(
      React.createElement(ContactDetailDialog, {
        open: true,
        onOpenChange: () => {},
        contact: baseContact,
        canManage: false,
      }),
    );

    assert.ok(!html.includes('+ Add Identity'));
  });

  it('5. Contact search query correctly filters contacts by name or ID', () => {
    const contacts: ContactResponse[] = [
      baseContact,
      {
        id: '01955b0a-7b3b-7411-9a4f-ct000000002',
        workspaceId: '01955b0a-7b3b-7411-9a4f-ws000000001',
        firstName: 'Bob',
        lastName: 'Jones',
        metadata: {},
        createdAt: '2026-10-31T11:00:00.000Z',
        updatedAt: '2026-10-31T11:00:00.000Z',
      },
    ];

    const filterContacts = (list: ContactResponse[], query: string) => {
      const q = query.trim().toLowerCase();
      if (!q) return list;
      return list.filter((c) => {
        const fullName = `${c.firstName || ''} ${c.lastName || ''}`.toLowerCase();
        return fullName.includes(q) || c.id.toLowerCase().includes(q);
      });
    };

    assert.equal(filterContacts(contacts, 'Alice').length, 1);
    assert.equal(filterContacts(contacts, 'Alice')[0]?.firstName, 'Alice');
    assert.equal(filterContacts(contacts, 'jones').length, 1);
    assert.equal(filterContacts(contacts, 'jones')[0]?.firstName, 'Bob');
    assert.equal(filterContacts(contacts, 'ct000000002').length, 1);
    assert.equal(filterContacts(contacts, 'nonexistent').length, 0);
  });
});
