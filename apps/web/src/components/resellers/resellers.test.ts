import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClientProvider } from '@tanstack/react-query';

import { CreateResellerDialog } from './create-reseller-dialog';
import { EditResellerDialog } from './edit-reseller-dialog';
import { ResellerTransitionDialog } from './reseller-transition-dialog';
import { createAppQueryClient } from '../../lib/query-client';
import { resellersApi, type ResellerView } from '../../lib/api-client';

(globalThis as unknown as { React: typeof React }).React = React;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

function withQueryClient(node: React.ReactElement): string {
  return renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client: createAppQueryClient() }, node),
  );
}

const mockReseller: ResellerView = {
  id: '01955b0a-7b3b-7411-9a4f-000000000100',
  name: 'Apex Global Communications',
  slug: 'apex-global',
  domain: 'portal.apextelecom.com',
  defaultMarkupPct: '15.000',
  brandConfig: {
    brandName: 'Apex Portal',
    supportEmail: 'support@apextelecom.com',
    supportPhone: '+1-800-555-0199',
  },
  status: 'active',
  isPlatformDefault: false,
  customerCount: 4,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
};

describe('CreateResellerDialog', () => {
  it('renders dialog elements when isOpen is true', () => {
    const html = withQueryClient(
      React.createElement(CreateResellerDialog, {
        isOpen: true,
        onClose: () => {},
        onSuccess: () => {},
      }),
    );
    assert.match(html, /Create Reseller/);
    assert.match(html, /Reseller Name/);
    assert.match(html, /Slug/);
    assert.match(html, /White-label Portal Domain/);
    assert.match(html, /Default Markup Percentage/);
    assert.match(html, /Brand Display Name/);
  });

  it('renders null when isOpen is false', () => {
    const html = withQueryClient(
      React.createElement(CreateResellerDialog, {
        isOpen: false,
        onClose: () => {},
        onSuccess: () => {},
      }),
    );
    assert.equal(html, '');
  });
});

describe('EditResellerDialog', () => {
  it('renders pre-populated values for the reseller', () => {
    const html = withQueryClient(
      React.createElement(EditResellerDialog, {
        isOpen: true,
        reseller: mockReseller,
        onClose: () => {},
        onSuccess: () => {},
      }),
    );
    assert.match(html, /Edit Reseller: Apex Global Communications/);
    assert.match(html, /Apex Global Communications/);
    assert.match(html, /15\.000/);
    assert.match(html, /Apex Portal/);
  });

  it('renders null when closed', () => {
    const html = withQueryClient(
      React.createElement(EditResellerDialog, {
        isOpen: false,
        reseller: mockReseller,
        onClose: () => {},
        onSuccess: () => {},
      }),
    );
    assert.equal(html, '');
  });
});

describe('ResellerTransitionDialog', () => {
  it('renders warning banner and confirmation for suspension', () => {
    const html = withQueryClient(
      React.createElement(ResellerTransitionDialog, {
        isOpen: true,
        reseller: mockReseller,
        transition: 'suspend',
        onClose: () => {},
        onSuccess: () => {},
      }),
    );
    assert.match(html, /Suspend Reseller: Apex Global Communications/);
    assert.match(html, /Warning: Reseller Suspension/);
    assert.match(html, /Suspend Reseller/);
  });

  it('renders reactivation notice for reactivation', () => {
    const html = withQueryClient(
      React.createElement(ResellerTransitionDialog, {
        isOpen: true,
        reseller: { ...mockReseller, status: 'suspended' },
        transition: 'reactivate',
        onClose: () => {},
        onSuccess: () => {},
      }),
    );
    assert.match(html, /Reactivate Reseller: Apex Global Communications/);
    assert.match(html, /Reseller Reactivation/);
    assert.match(html, /Reactivate Reseller/);
  });
});

describe('Resellers API Client Invariants', () => {
  it('exposes all required lifecycle, administration, and hierarchy methods', () => {
    assert.equal(typeof resellersApi.list, 'function');
    assert.equal(typeof resellersApi.get, 'function');
    assert.equal(typeof resellersApi.create, 'function');
    assert.equal(typeof resellersApi.update, 'function');
    assert.equal(typeof resellersApi.suspend, 'function');
    assert.equal(typeof resellersApi.reactivate, 'function');
    assert.equal(typeof resellersApi.listOrganizations, 'function');
  });
});
