import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import PlatformDomainsPage from '../../app/(console)/domains/page';
import type { EffectiveAuthorization, UserIdentity } from '../../lib/api-client';
import {
  canAttemptVerification,
  platformDomainQuery,
  platformDomainsApi,
  relativeExpiry,
  type DomainDnsDiagnostics,
  type DomainHistoryEntry,
  type PlatformDomainSummary,
  type PlatformDomainView,
} from '../../lib/platform-domains';
import { useSession } from '../../lib/session-store';
import { DiagnosticsResult, DomainOversightDialog } from './domain-oversight-dialog';
import { DomainRegistry } from './domain-registry';

(globalThis as unknown as { React: typeof React }).React = React;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

const ORG = '01955b0a-7b3b-7411-9a4f-9e67d4f90011';
const TOKEN = 'acc-domain-verification=never-render-me';

function signIn(platformPermissions: string[], orgPermissions: string[] = []) {
  const user: UserIdentity = {
    userId: 'u133-user',
    actorType: 'user',
    authMethod: 'session',
    sessionId: 'sess-u133',
    authenticatedAt: new Date().toISOString(),
    tenant: { orgId: null, workspaceId: null, resellerId: null, isPlatformAdmin: false },
    authorizedOrganizationIds: [ORG],
    roles: [],
    permissions: [],
  };
  const grants: EffectiveAuthorization['grants'][number][] = [];
  if (platformPermissions.length > 0) {
    grants.push({
      roleId: 'role-platform',
      roleKey: 'alendei_support',
      scopeType: 'platform',
      scopeId: null,
      orgId: null,
      permissions: platformPermissions,
    });
  }
  if (orgPermissions.length > 0) {
    grants.push({
      roleId: 'role-org',
      roleKey: 'org_admin',
      scopeType: 'organization',
      scopeId: ORG,
      orgId: ORG,
      permissions: orgPermissions,
    });
  }
  const authorization: EffectiveAuthorization = {
    actorType: 'user',
    userId: 'u133-user',
    apiKeyId: null,
    organizationIds: [ORG],
    grants,
    isPlatformAdmin: false,
  };
  useSession
    .getState()
    .setSession({ accessToken: 'token', user, authorization, selectedOrgId: ORG });
}

const SUPPORT = ['platform.tenants.read', 'platform.audit.read'];
const SUPER = [...SUPPORT, 'platform.tenants.manage'];

function domain(overrides: Partial<PlatformDomainView> = {}): PlatformDomainView {
  return {
    id: '01955b0a-7b3b-7411-9a4f-9e67d4f90101',
    domain: 'console.brand.example',
    domainType: 'custom',
    status: 'pending_verification',
    verificationMethod: 'dns_txt',
    verificationStatus: 'pending',
    verifiedAt: null,
    isPrimary: false,
    createdAt: '2026-10-30T10:00:00.000Z',
    updatedAt: '2026-10-30T10:00:00.000Z',
    challenge: {
      state: 'expiring_soon',
      issuedAt: '2026-10-30T10:00:00.000Z',
      expiresAt: '2026-11-02T10:00:00.000Z',
    },
    organization: { id: ORG, name: 'Brand Org', slug: 'brand', status: 'active' },
    reseller: { id: 'r-1', name: 'Platform', isPlatformDefault: true },
    ...overrides,
  };
}

const summary: PlatformDomainSummary = {
  total: 1234,
  byStatus: { active: 1000, pending_verification: 200, suspended: 30, revoked: 4 },
  byChallengeState: {
    verified: 900,
    not_required: 100,
    pending: 150,
    expiring_soon: 20,
    expired: 40,
    failed: 24,
  },
  byType: { subdomain: 800, custom: 434 },
  needsAttention: 84,
};

function render(element: React.ReactElement, client = new QueryClient()) {
  return renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, element));
}

function seededClient(rows: PlatformDomainView[]) {
  const client = new QueryClient();
  client.setQueryData(['platform-domains', 'summary'], { data: summary });
  client.setQueryData(['platform-domains', 'list', { limit: 25 }], {
    data: rows,
    page: { nextCursor: null, hasMore: false, limit: 25 },
  });
  return client;
}

describe('U13.3 platform domain console', () => {
  afterEach(() => useSession.getState().clearSession());

  it('refuses the page to a tenant administrator and never renders the registry', () => {
    signIn([], ['organizations.read', 'organizations.update']);
    const html = render(React.createElement(PlatformDomainsPage));
    assert.match(html, /Access Forbidden/);
    assert.doesNotMatch(html, /domain-registry/);
  });

  it('renders the registry for support: health tiles, accessible table, no challenge value', () => {
    signIn(SUPPORT);
    const html = render(React.createElement(DomainRegistry), seededClient([domain()]));
    assert.match(html, /data-testid="summary-total">1,234</);
    assert.match(html, /data-testid="summary-attention">84</);
    assert.match(html, /aria-pressed="false"[^>]*data-testid="summary-tile-expired"/);
    assert.match(html, /<caption class="sr-only">Organization domains across all tenants/);
    assert.match(html, /<th scope="row"[^>]*><span[^>]*>console\.brand\.example<\/span>/);
    assert.match(html, /Direct \(platform\)/);
    assert.match(html, /Expiring soon/);
    assert.doesNotMatch(html, /acc-domain-verification|verificationValue/);
  });

  it('shows the empty state when no domain matches', () => {
    signIn(SUPPORT);
    const html = render(React.createElement(DomainRegistry), seededClient([]));
    assert.match(html, /data-testid="domain-table-empty"/);
  });

  it('support sees history but no lifecycle actions in the oversight dialog', () => {
    signIn(SUPPORT);
    const d = domain({ status: 'active', verificationStatus: 'verified' });
    const client = new QueryClient();
    const history: DomainHistoryEntry[] = [
      {
        id: 'h1',
        occurredAt: '2026-10-31T09:00:00.000Z',
        action: 'domain.suspended',
        outcome: 'success',
        actorType: 'user',
        actorUserId: null,
        fromStatus: 'active',
        toStatus: 'suspended',
        fromVerificationStatus: null,
        toVerificationStatus: null,
        reason: 'Abuse report',
      },
    ];
    client.setQueryData(['platform-domains', 'history', d.id], { data: history });
    const html = render(
      React.createElement(DomainOversightDialog, { domain: d, onClose: () => {} }),
      client,
    );
    assert.match(html, /role="dialog"/);
    assert.match(html, /aria-labelledby="domain-oversight-title"/);
    assert.match(html, /data-testid="history-list"/);
    assert.match(html, /Suspended/);
    assert.match(html, /Abuse report/);
    assert.doesNotMatch(html, /domain-actions-heading/);
    assert.doesNotMatch(html, /action-suspend|action-verify|action-activate/);
    assert.match(html, /does not provision ingress\s+routing or TLS certificates/);
  });

  it('a platform manager is offered only the actions valid for the domain’s state', () => {
    signIn(SUPER);
    const actionsFor = (d: PlatformDomainView) =>
      render(React.createElement(DomainOversightDialog, { domain: d, onClose: () => {} }));

    const pending = actionsFor(domain());
    assert.match(pending, /data-testid="action-verify"/);
    assert.doesNotMatch(pending, /action-suspend|action-activate/);

    const active = actionsFor(domain({ status: 'active', verificationStatus: 'verified' }));
    assert.match(active, /data-testid="action-suspend"/);
    assert.doesNotMatch(active, /action-verify|action-activate/);

    const suspended = actionsFor(domain({ status: 'suspended', verificationStatus: 'verified' }));
    assert.match(suspended, /data-testid="action-activate"/);
    assert.doesNotMatch(suspended, /action-verify|action-suspend/);

    const expired = actionsFor(
      domain({ challenge: { state: 'expired', issuedAt: null, expiresAt: null } }),
    );
    assert.doesNotMatch(expired, /action-verify/);
    assert.match(expired, /regenerates\s+the challenge/);
  });

  it('diagnostics show outcomes and counts per resolver, never DNS values', () => {
    const diag: DomainDnsDiagnostics = {
      domainId: 'd1',
      domain: 'console.brand.example',
      challengeHost: '_alendei-challenge.console.brand.example',
      checkedAt: '2026-11-01T10:00:00.000Z',
      propagation: 'partial',
      results: [
        {
          resolver: 'Cloudflare (1.1.1.1)',
          outcome: 'match',
          recordCount: 1,
          errorCode: null,
          durationMs: 12,
        },
        {
          resolver: 'Google (8.8.8.8)',
          outcome: 'not_found',
          recordCount: 0,
          errorCode: 'ENOTFOUND',
          durationMs: 30,
        },
      ],
      guidance: 'Some resolvers return the expected record and some do not yet.',
      challenge: { state: 'pending', issuedAt: null, expiresAt: null },
    };
    const html = render(React.createElement(DiagnosticsResult, { diag }));
    assert.match(html, /Partially propagated/);
    assert.match(
      html,
      /<th scope="row"[^>]*>Cloudflare \(1\.1\.1\.1\)<\/th><td[^>]*>Expected value found/,
    );
    assert.match(html, /No record/);
    assert.match(html, /Read-only: nothing\s+about the domain changed/);
    assert.doesNotMatch(html, new RegExp(TOKEN));
  });

  it('the console layout lists Domains only for platform readers, including with no organization', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'app', '(console)', 'layout.tsx'),
      'utf8',
    );
    assert.match(src, /\{ href: '\/domains', label: 'Domains' \}/);
    assert.equal(src.match(/case '\/domains':\s+return canReadPlatformDomains;/g)?.length, 2);
    assert.match(src, /\(isNavigatingDomains && canReadPlatformDomains\)/);
  });
});

describe('U13.3 platform domain helpers', () => {
  afterEach(() => useSession.getState().clearSession());

  it('builds the registry query from set filters only', () => {
    assert.equal(platformDomainQuery({}), '');
    assert.equal(
      platformDomainQuery({ status: 'active', challengeState: 'expired', q: 'brand', limit: 25 }),
      '?status=active&challengeState=expired&q=brand&limit=25',
    );
  });

  it('describes challenge expiry relative to now', () => {
    const now = new Date('2026-11-01T00:00:00.000Z');
    assert.equal(relativeExpiry(null, now), '—');
    assert.equal(relativeExpiry('2026-11-01T05:30:00.000Z', now), 'in 5 h');
    assert.equal(relativeExpiry('2026-11-03T03:00:00.000Z', now), 'in 2 d 3 h');
    assert.equal(relativeExpiry('2026-10-31T21:00:00.000Z', now), '3 h ago');
    assert.equal(relativeExpiry('2026-11-01T00:10:00.000Z', now), 'in < 1 h');
  });

  it('offers verification only where U12 would attempt it', () => {
    assert.equal(canAttemptVerification(domain()), true);
    assert.equal(
      canAttemptVerification(domain({ verificationMethod: 'platform_subdomain' })),
      false,
    );
    assert.equal(canAttemptVerification(domain({ verificationStatus: 'verified' })), false);
    assert.equal(canAttemptVerification(domain({ status: 'suspended' })), false);
    assert.equal(
      canAttemptVerification(
        domain({ challenge: { state: 'expired', issuedAt: null, expiresAt: null } }),
      ),
      false,
    );
  });

  it('calls the platform routes without an organization header', async () => {
    signIn(SUPPORT);
    const original = globalThis.fetch;
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: typeof url === 'string' ? url : url.toString(),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
      });
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      await platformDomainsApi.list({ q: 'brand' });
      await platformDomainsApi.diagnostics('d/1');
      await platformDomainsApi.history('d1');
    } finally {
      globalThis.fetch = original;
    }
    assert.match(seen[0]!.url, /\/platform\/domains\?q=brand$/);
    assert.match(seen[1]!.url, /\/platform\/domains\/d%2F1\/dns-diagnostics$/);
    assert.match(seen[2]!.url, /\/platform\/domains\/d1\/history$/);
    for (const call of seen) assert.equal(call.headers['x-acc-organization'], undefined);
  });
});
