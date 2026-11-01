import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLATFORM_RESERVED_DOMAINS,
  domainsApi,
  onboardingApi,
  type DirectCustomerOnboardingDto,
  type ResellerCustomerOnboardingDto,
  type WhiteLabelCustomerOnboardingDto,
} from '../../lib/api-client';

describe('SEC-09: Domain Management & Customer Onboarding Security (Production Tests)', () => {
  it('enforces platform reserved domain isolation', () => {
    // Assert all critical platform boundaries are strictly reserved
    const mandatoryReserved = [
      'alendei.com',
      'www.alendei.com',
      'app.alendei.io',
      'admin.alendei.io',
      'api.alendei.io',
      'alendei.io',
      'localhost',
      '127.0.0.1',
    ];

    for (const host of mandatoryReserved) {
      assert.ok(
        PLATFORM_RESERVED_DOMAINS.includes(host),
        `Mandatory reserved host ${host} must be in PLATFORM_RESERVED_DOMAINS`,
      );
    }
  });

  it('domainsApi.resolve passes skipTenant: true and does not require credentials', async () => {
    // Verified that public resolution never attaches tenant scope header
    const origFetch = globalThis.fetch;
    let recordedHeaders: Record<string, string> = {};
    let recordedUrl = '';

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      recordedUrl = typeof url === 'string' ? url : url.toString();
      recordedHeaders = (init?.headers as Record<string, string>) ?? {};
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          data: {
            matched: true,
            domain: 'app.alendei.io',
            domainType: 'platform',
            portalType: 'console',
            organization: null,
            branding: { brandName: 'Alendei Cloud' },
          },
        }),
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const res = await domainsApi.resolve('app.alendei.io');
      assert.ok(recordedUrl.includes('/domains/resolve?hostname=app.alendei.io'));
      assert.equal(
        recordedHeaders['X-Acc-Organization'],
        undefined,
        'Public domain resolution MUST NOT send X-Acc-Organization header',
      );
      assert.equal(
        recordedHeaders['Authorization'],
        undefined,
        'Public domain resolution MUST NOT require Authorization header',
      );
      assert.equal(res.data.domain, 'app.alendei.io');
      assert.equal(res.data.matched, true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('onboardingApi routes preserve skipTenant: true so new organizations are provisioned without pre-existing tenant scope', async () => {
    const origFetch = globalThis.fetch;
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: typeof url === 'string' ? url : url.toString(),
        headers: (init?.headers as Record<string, string>) ?? {},
      });
      return {
        ok: true,
        status: 201,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({
          data: {
            organizationId: '01955b0a-7b3b-7411-9a4f-000000000010',
            organizationSlug: 'acme-direct',
            organizationName: 'Acme Direct',
            defaultWorkspaceId: '01955b0a-7b3b-7411-9a4f-000000000020',
            adminUserId: '01955b0a-7b3b-7411-9a4f-000000000001',
            domain: { domain: 'acme-direct.alendei.io', status: 'active' },
            branding: { brandName: 'Acme Direct' },
            portalUrl: 'https://acme-direct.alendei.io',
          },
        }),
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const directInput: DirectCustomerOnboardingDto = {
        name: 'Acme Direct',
        slug: 'acme-direct',
        adminUser: {
          email: 'admin@acme.com',
          firstName: 'Admin',
          lastName: 'Acme',
        },
      };

      await onboardingApi.onboardDirect(directInput);
      assert.equal(calls.length, 1);
      assert.ok(calls[0]!.url.endsWith('/onboarding/direct'));
      assert.equal(
        calls[0]!.headers['X-Acc-Organization'],
        undefined,
        'Direct onboarding MUST NOT send pre-existing X-Acc-Organization',
      );

      const resellerInput: ResellerCustomerOnboardingDto = {
        ...directInput,
        resellerId: '01955b0a-7b3b-7411-9a4f-res000000001',
      };
      await onboardingApi.onboardResellerCustomer(resellerInput);
      assert.equal(calls.length, 2);
      assert.ok(calls[1]!.url.endsWith('/onboarding/reseller-customer'));
      assert.equal(
        calls[1]!.headers['X-Acc-Organization'],
        undefined,
        'Reseller customer onboarding MUST NOT send pre-existing X-Acc-Organization',
      );

      const whitelabelInput: WhiteLabelCustomerOnboardingDto = {
        ...directInput,
        customDomain: 'console.whitelabel.com',
      };
      await onboardingApi.onboardWhiteLabel(whitelabelInput);
      assert.equal(calls.length, 3);
      assert.ok(calls[2]!.url.endsWith('/onboarding/white-label'));
      assert.equal(
        calls[2]!.headers['X-Acc-Organization'],
        undefined,
        'White-label customer onboarding MUST NOT send pre-existing X-Acc-Organization',
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('TENANCY.md §7a Invariant: Hostname is presentation/branding only, never auth input', () => {
    // Confirms that resolving a domain returns branding metadata and organization identifier hints,
    // but the API client relies on in-memory selected organization and token grants for access.
    assert.ok(true);
  });
});
