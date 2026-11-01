import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClientProvider } from '@tanstack/react-query';

import { OrganizationTransitionDialog } from './organization-transition-dialog';
import { OrganizationLifecycleHistoryCard } from './organization-lifecycle-history-card';
import { createAppQueryClient } from '../../lib/query-client';
import type { OrganizationView } from '../../lib/api-client';

(globalThis as unknown as { React: typeof React }).React = React;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

function withQueryClient(node: React.ReactElement): string {
  return renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client: createAppQueryClient() }, node),
  );
}

const mockOrg: OrganizationView = {
  id: '01900000-0000-7000-8000-000000000001',
  name: 'Acme Corp',
  slug: 'acme-corp',
  legalName: 'Acme Corporation Ltd',
  gstin: '29ABCDE1234F1Z5',
  resellerId: '01900000-0000-7000-8000-0000000000aa',
  status: 'active',
  statusChangedAt: null,
  billingMode: 'prepaid',
  billingPolicy: 'charge_per_logical_message',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

describe('OrganizationTransitionDialog (U13.2)', () => {
  it('renders suspend dialog with mandatory reason indicator and disabled submit when reason is empty', () => {
    const html = renderToStaticMarkup(
      React.createElement(OrganizationTransitionDialog, {
        isOpen: true,
        organization: mockOrg,
        action: 'suspend',
        onClose: () => {},
        onSuccess: () => {},
      }),
    );

    assert.match(html, /Suspend Organization/);
    assert.match(html, /Operational Suspension/);
    assert.match(html, /Operator Reason/);
    assert.match(html, /Required, max 500 characters/);
    assert.match(html, /disabled=""/); // Submit button is disabled because reason is empty
  });

  it('renders close dialog with terminal warning, slug confirmation and mandatory reason indicator', () => {
    const html = renderToStaticMarkup(
      React.createElement(OrganizationTransitionDialog, {
        isOpen: true,
        organization: mockOrg,
        action: 'close',
        onClose: () => {},
        onSuccess: () => {},
      }),
    );

    assert.match(html, /Close Organization \(Terminal\)/);
    assert.match(html, /Terminal Lifecycle Action/);
    assert.match(html, /Type organization slug/);
    assert.match(html, /acme-corp/);
    assert.match(html, /Required, max 500 characters/);
    assert.match(html, /disabled=""/); // Submit button is disabled because slug and reason are empty
  });

  it('renders reactivate dialog with optional reason label', () => {
    const html = renderToStaticMarkup(
      React.createElement(OrganizationTransitionDialog, {
        isOpen: true,
        organization: { ...mockOrg, status: 'suspended' },
        action: 'reactivate',
        onClose: () => {},
        onSuccess: () => {},
      }),
    );

    assert.match(html, /Reactivate Organization/);
    assert.match(html, /Optional, max 500 characters/);
  });

  it('returns null when isOpen is false', () => {
    const html = renderToStaticMarkup(
      React.createElement(OrganizationTransitionDialog, {
        isOpen: false,
        organization: mockOrg,
        action: 'suspend',
        onClose: () => {},
        onSuccess: () => {},
      }),
    );

    assert.equal(html, '');
  });
});

describe('OrganizationLifecycleHistoryCard (U13.2)', () => {
  it('renders card header, subtitle, refresh button, and accessible section', () => {
    const html = withQueryClient(
      React.createElement(OrganizationLifecycleHistoryCard, {
        organizationId: mockOrg.id,
      }),
    );

    assert.match(html, /Lifecycle &amp; Suspension History/);
    assert.match(html, /Audit trail of platform lifecycle transitions/);
    assert.match(html, /Refresh/);
    assert.match(html, /aria-labelledby="lifecycle-history-heading"/);
  });
});
