import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClientProvider } from '@tanstack/react-query';

import { DomainStatusBadge, DomainTypeBadge } from './domain-status-badge';
import { DomainCreateDialog } from './domain-create-dialog';
import { DomainVerificationDialog } from './domain-verification-dialog';
import { BrandingSettingsCard } from './branding-settings-card';
import { CustomerOnboardingDialog } from '../onboarding/customer-onboarding-dialog';
import { createAppQueryClient } from '../../lib/query-client';
import {
  PLATFORM_RESERVED_DOMAINS,
  type DomainStatus,
  type DomainType,
  type DomainView,
} from '../../lib/api-client';

(globalThis as unknown as { React: typeof React }).React = React;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

function withQueryClient(node: React.ReactElement): string {
  return renderToStaticMarkup(
    React.createElement(QueryClientProvider, { client: createAppQueryClient() }, node),
  );
}

describe('DomainStatusBadge', () => {
  const statuses: Array<[DomainStatus, RegExp]> = [
    ['active', /Active/],
    ['pending_verification', /Pending DNS Verification/],
    ['suspended', /Suspended/],
    ['revoked', /Revoked/],
  ];

  for (const [status, label] of statuses) {
    it(`renders label for status "${status}"`, () => {
      const html = renderToStaticMarkup(React.createElement(DomainStatusBadge, { status }));
      assert.match(html, label);
    });
  }

  it('renders primary indicator when isPrimary is true', () => {
    const html = renderToStaticMarkup(
      React.createElement(DomainStatusBadge, { status: 'active', isPrimary: true }),
    );
    assert.match(html, /Primary/);
  });

  it('omits primary indicator when isPrimary is false or omitted', () => {
    const html = renderToStaticMarkup(React.createElement(DomainStatusBadge, { status: 'active' }));
    assert.doesNotMatch(html, /Primary/);
  });
});

describe('DomainTypeBadge', () => {
  const types: Array<[DomainType, RegExp]> = [
    ['subdomain', /Subdomain/],
    ['custom', /Custom/],
  ];

  for (const [type, label] of types) {
    it(`renders label for type "${type}"`, () => {
      const html = renderToStaticMarkup(React.createElement(DomainTypeBadge, { type }));
      assert.match(html, label);
    });
  }
});

describe('Domain Dialogs and Cards Rendering', () => {
  const ORG_ID = '01955b0a-7b3b-7411-9a4f-000000000010';

  it('DomainCreateDialog renders accessible modal with form controls', () => {
    const html = withQueryClient(
      React.createElement(DomainCreateDialog, {
        isOpen: true,
        orgId: ORG_ID,
        onClose: () => {},
        onSuccess: () => {},
      }),
    );

    assert.match(html, /role="dialog"/);
    assert.match(html, /aria-modal="true"/);
    assert.match(html, /aria-labelledby="register-domain-title"/);
    assert.match(html, /Register Domain/);
    assert.match(html, /id="subdomain-prefix-input"/);
    assert.match(html, /id="set-primary-checkbox"/);
  });

  it('DomainVerificationDialog renders DNS TXT challenge info', () => {
    const mockDomain: DomainView = {
      id: '01955b0a-7b3b-7411-9a4f-dom000000001',
      orgId: ORG_ID,
      domain: 'console.customerbrand.com',
      domainType: 'custom',
      status: 'pending_verification',
      verificationMethod: 'dns_txt',
      verificationValue: 'alendei-verify=abc123xyz789',
      verificationStatus: 'pending',
      verifiedAt: null,
      isPrimary: true,
      createdAt: '2026-10-31T00:00:00.000Z',
      updatedAt: '2026-10-31T00:00:00.000Z',
    };

    const html = withQueryClient(
      React.createElement(DomainVerificationDialog, {
        isOpen: true,
        orgId: ORG_ID,
        domain: mockDomain,
        onClose: () => {},
        onSuccess: () => {},
      }),
    );

    assert.match(html, /role="dialog"/);
    assert.match(html, /aria-modal="true"/);
    assert.match(html, /aria-labelledby="domain-verification-title"/);
    assert.match(html, /console\.customerbrand\.com/);
  });

  it('BrandingSettingsCard renders configuration inputs', () => {
    const queryClient = createAppQueryClient();
    queryClient.setQueryData(['organizations', ORG_ID, 'branding'], {
      data: {
        brandName: 'Acme Communications',
        primaryColor: '#0ea5e9',
        accentColor: '#38bdf8',
        supportEmail: 'support@acme.com',
      },
    });

    const html = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(BrandingSettingsCard, {
          orgId: ORG_ID,
          canManage: true,
        }),
      ),
    );

    assert.match(html, /Organization Branding &amp; Customization/);
    assert.match(html, /id="brand-name-input"/);
    assert.match(html, /id="logo-url-input"/);
    assert.match(html, /id="favicon-url-input"/);
    assert.match(html, /id="primary-color-input"/);
    assert.match(html, /id="accent-color-input"/);
    assert.match(html, /id="support-email-input"/);
  });

  it('CustomerOnboardingDialog renders tabs for Direct, Reseller, and White-Label', () => {
    const html = withQueryClient(
      React.createElement(CustomerOnboardingDialog, {
        isOpen: true,
        onClose: () => {},
        onSuccess: () => {},
      }),
    );

    assert.match(html, /role="dialog"/);
    assert.match(html, /aria-modal="true"/);
    assert.match(html, /aria-labelledby="customer-onboarding-title"/);
    assert.match(html, /Direct Customer/);
    assert.match(html, /Reseller-Managed/);
    assert.match(html, /White-Label/);
    assert.match(html, /id="onboarding-org-name"/);
    assert.match(html, /id="onboarding-admin-email"/);
  });

  it('Platform reserved domains includes mandatory platform hosts', () => {
    assert.ok(PLATFORM_RESERVED_DOMAINS.includes('alendei.com'));
    assert.ok(PLATFORM_RESERVED_DOMAINS.includes('app.alendei.io'));
    assert.ok(PLATFORM_RESERVED_DOMAINS.includes('admin.alendei.io'));
    assert.ok(PLATFORM_RESERVED_DOMAINS.includes('api.alendei.io'));
  });
});
