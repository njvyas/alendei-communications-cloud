import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import UsagePage from '../../app/(console)/usage/page';
import { MessageUsageReport } from './message-usage-report';
import { useSession } from '../../lib/session-store';
import { periodFor, presetPeriod, type MessageUsageReportResponse } from '../../lib/usage-report';
import type { EffectiveAuthorization, UserIdentity } from '../../lib/api-client';

(globalThis as unknown as { React: typeof React }).React = React;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

const ORG = '01955b0a-7b3b-7411-9a4f-9e67d4f90001';

function signIn(permissions: string[]) {
  const user: UserIdentity = {
    userId: 'usage-user',
    actorType: 'user',
    authMethod: 'session',
    sessionId: 'sess-usage',
    authenticatedAt: new Date().toISOString(),
    tenant: { orgId: ORG, workspaceId: null, resellerId: null, isPlatformAdmin: false },
    authorizedOrganizationIds: [ORG],
    roles: [],
    permissions: [],
  };
  const authorization: EffectiveAuthorization = {
    actorType: 'user',
    userId: 'usage-user',
    apiKeyId: null,
    organizationIds: [ORG],
    grants: [
      {
        roleId: 'role-usage',
        roleKey: 'usage_role',
        scopeType: 'organization',
        scopeId: ORG,
        orgId: ORG,
        permissions,
      },
    ],
    isPlatformAdmin: false,
  };
  useSession
    .getState()
    .setSession({ accessToken: 'token', user, authorization, selectedOrgId: ORG });
}

/** The query the report issues on first render (last 30 days, Asia/Kolkata, all channels). */
function initialQueryKey() {
  const p = presetPeriod(30, 'Asia/Kolkata');
  const period = periodFor(p.fromDay, p.toDay, 'Asia/Kolkata');
  assert.ok(!('error' in period));
  return [
    'usage',
    'messages',
    ORG,
    { ...period, timeZone: 'Asia/Kolkata', channelCode: undefined },
  ];
}

const report: MessageUsageReportResponse = {
  orgId: ORG,
  from: '2026-10-01T18:30:00.000Z',
  to: '2026-10-31T18:30:00.000Z',
  timeZone: 'Asia/Kolkata',
  workspaceId: null,
  channelCode: null,
  totals: { total: 1250, accepted: 1000, failed: 200, outcomeUnknown: 0, pending: 50 },
  acceptanceRate: 0.8333,
  byChannel: [
    {
      channelCode: 'whatsapp',
      total: 1250,
      accepted: 1000,
      failed: 200,
      outcomeUnknown: 0,
      pending: 50,
    },
  ],
  byDay: [
    {
      day: '2026-10-05',
      channelCode: 'whatsapp',
      total: 1250,
      accepted: 1000,
      failed: 200,
      outcomeUnknown: 0,
      pending: 50,
    },
  ],
  topFailureReasons: [
    { reason: 'NO_ELIGIBLE_PROVIDER', count: 150 },
    { reason: 'OTHER', count: 50 },
  ],
};

function render(element: React.ReactElement, client = new QueryClient()) {
  return renderToStaticMarkup(React.createElement(QueryClientProvider, { client }, element));
}

describe('Message usage console (usage reporting)', () => {
  afterEach(() => useSession.getState().clearSession());

  it('refuses the page without messages.read and never renders the report', () => {
    signIn(['contacts.read']);
    const html = render(React.createElement(UsagePage));
    assert.match(html, /Access Forbidden/);
    assert.doesNotMatch(html, /usage-report/);
  });

  it('renders the report for a reader: totals, rate, channel and day tables, reasons', () => {
    signIn(['messages.read']);
    const client = new QueryClient();
    client.setQueryData(initialQueryKey(), { data: report });
    const html = render(React.createElement(MessageUsageReport, { orgId: ORG }), client);
    assert.match(html, /data-testid="usage-report"/);
    assert.match(html, /1,250/);
    assert.match(html, /83\.3 %/);
    assert.match(html, /<caption class="sr-only">Messages by channel<\/caption>/);
    assert.match(html, /<th scope="row"[^>]*>2026-10-05<\/th>/);
    assert.match(html, /Other \(unclassified reason\)/);
    assert.match(html, /not a handset receipt/);
    // Quick-period buttons expose their state to assistive technology.
    assert.match(html, /aria-pressed="true"[^>]*data-testid="usage-preset-30"/);
  });

  it('shows an empty state, not tables, for a period with no messages', () => {
    signIn(['messages.read']);
    const client = new QueryClient();
    client.setQueryData(initialQueryKey(), {
      data: {
        ...report,
        totals: { total: 0, accepted: 0, failed: 0, outcomeUnknown: 0, pending: 0 },
        acceptanceRate: null,
        byChannel: [],
        byDay: [],
        topFailureReasons: [],
      },
    });
    const html = render(React.createElement(MessageUsageReport, { orgId: ORG }), client);
    assert.match(html, /No messages were created in this period/);
    assert.doesNotMatch(html, /Messages by channel/);
  });

  it('keys cached results by organization, so another organization never sees them', () => {
    signIn(['messages.read']);
    const client = new QueryClient();
    client.setQueryData(initialQueryKey(), { data: report });
    const other = render(
      React.createElement(MessageUsageReport, { orgId: '01955b0a-7b3b-7411-9a4f-9e67d4f99999' }),
      client,
    );
    assert.doesNotMatch(other, /1,250/);
  });
});
