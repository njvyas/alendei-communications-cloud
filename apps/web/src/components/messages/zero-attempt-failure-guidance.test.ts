import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { emptyAttemptsGuidance, formatFailureReason } from '../../lib/failure-reasons';
import { useSession } from '../../lib/session-store';
import type {
  EffectiveAuthorization,
  MessageDetailWithAttempts,
  UserIdentity,
} from '../../lib/api-client';
import { AttemptHistoryCard } from '../whatsapp/attempt-history-card';
import { FailureReasonAlert } from './failure-reason-alert';
import { MessageDetailDialog } from './message-detail-dialog';

(globalThis as unknown as { React: typeof React }).React = React;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();

/**
 * Follow-up to QAF-026: when a message fails before any provider attempt, no
 * guidance may send the user to attempt records, because none exist.
 */
const POINTS_AT_ATTEMPTS = /attempt (records|error details) below|records below/i;

/** Every catalogue code, each prefix branch, and the generic fallback. */
const REASONS = [
  'NO_ELIGIBLE_PROVIDER',
  'RECIPIENT_SUPPRESSED',
  'CONSENT_REVOKED',
  'CHANNEL_NOT_SUPPORTED',
  'TEMPLATE_NOT_APPROVED',
  'TEMPLATE_NOT_FOUND',
  'TEMPLATE_CHANNEL_MISMATCH',
  'SMS_DLT_METADATA_REQUIRED',
  'SMS_PAYLOAD_INVALID',
  'SMS_TEMPLATE_VARIABLE_INVALID',
  'RCS_UNSAFE_ACTION_URL',
  'RCS_PAYLOAD_INVALID',
  'ALL_PROVIDERS_FAILED',
  'ORGANIZATION_SUSPENDED',
  'ORGANIZATION_CLOSED',
  'PROVIDER_ERROR: upstream 500',
  'PROVIDER_TIMEOUT: 3000ms',
  'CHANNEL_UNSUPPORTED: voice',
  'lease expired before submission',
  'Organization is closed',
  'CUSTOM_UNEXPECTED_FAILURE_XYZ',
];

const ORG = '01955b0a-7b3b-7411-9a4f-9e67d4f90001';
const MSG_ID = '01955b0a-7b3b-7411-9a4f-9e67d4f90002';

function zeroAttemptMessage(failureReason: string): MessageDetailWithAttempts {
  return {
    id: MSG_ID,
    orgId: ORG,
    workspaceId: '01955b0a-7b3b-7411-9a4f-9e67d4f90003',
    contactId: '01955b0a-7b3b-7411-9a4f-9e67d4f90004',
    channelId: '01955b0a-7b3b-7411-9a4f-9e67d4f90005',
    templateId: null,
    status: 'failed',
    recipientAddress: '+12025550199',
    payload: { text: 'Hello' },
    failureReason,
    createdAt: '2026-10-31T10:00:00.000Z',
    completedAt: '2026-10-31T10:00:01.000Z',
    attempts: [],
  };
}

function signIn() {
  const user: UserIdentity = {
    userId: 'zero-attempt-user',
    actorType: 'user',
    authMethod: 'session',
    sessionId: 'sess-zero-attempt',
    authenticatedAt: new Date().toISOString(),
    tenant: { orgId: ORG, workspaceId: null, resellerId: null, isPlatformAdmin: false },
    authorizedOrganizationIds: [ORG],
    roles: [],
    permissions: [],
  };
  const authorization: EffectiveAuthorization = {
    actorType: 'user',
    userId: 'zero-attempt-user',
    apiKeyId: null,
    organizationIds: [ORG],
    grants: [
      {
        roleId: 'role-zero-attempt',
        roleKey: 'reader',
        scopeType: 'organization',
        scopeId: ORG,
        orgId: ORG,
        permissions: ['messages.read'],
      },
    ],
    isPlatformAdmin: false,
  };
  useSession
    .getState()
    .setSession({ accessToken: 'token', user, authorization, selectedOrgId: ORG });
}

describe('failure guidance when no provider attempt exists (QAF-026 follow-up)', () => {
  afterEach(() => useSession.getState().clearSession());

  it('never points at attempt records when the attempt count is zero', () => {
    for (const reason of REASONS) {
      const formatted = formatFailureReason(reason, { attemptCount: 0 });
      assert.ok(formatted, reason);
      assert.ok(formatted.action.trim(), `${reason}: a next step is still given`);
      assert.doesNotMatch(formatted.action, POINTS_AT_ATTEMPTS, reason);
    }
  });

  it('keeps the attempt-record guidance when attempts exist or the count is unknown', () => {
    for (const context of [{ attemptCount: 2 }, {}]) {
      assert.match(
        formatFailureReason('CUSTOM_UNEXPECTED_FAILURE_XYZ', context)!.action,
        /Inspect the attempt records below/,
      );
      assert.match(
        formatFailureReason('ALL_PROVIDERS_FAILED', context)!.action,
        /attempt error details below/,
      );
    }
  });

  it('explains that there are no records for an unrecognised reason', () => {
    const { action } = formatFailureReason('Organization is closed', { attemptCount: 0 })!;
    assert.match(action, /no attempt records to inspect/);
    assert.match(action, /channel and provider configuration/);
  });

  it('the empty-attempts guidance for a failed message never points at attempt records', () => {
    for (const reason of [...REASONS, null]) {
      const guidance = emptyAttemptsGuidance('failed', reason);
      assert.ok(guidance.action, `${reason}: a next step is still given`);
      assert.doesNotMatch(guidance.action, POINTS_AT_ATTEMPTS, String(reason));
    }
  });

  it('the failure alert uses the zero-attempt wording only when told there are no attempts', () => {
    const none = renderToStaticMarkup(
      React.createElement(FailureReasonAlert, {
        failureReason: 'CUSTOM_UNEXPECTED_FAILURE_XYZ',
        attemptCount: 0,
      }),
    );
    assert.match(none, /no attempt records to inspect/);
    assert.doesNotMatch(none, POINTS_AT_ATTEMPTS);

    const some = renderToStaticMarkup(
      React.createElement(FailureReasonAlert, {
        failureReason: 'CUSTOM_UNEXPECTED_FAILURE_XYZ',
        attemptCount: 1,
      }),
    );
    assert.match(some, /Inspect the attempt records below/);
  });

  it('the attempt history card shows no attempt-record guidance for a zero-attempt failure', () => {
    for (const reason of ['Organization is closed', 'ALL_PROVIDERS_FAILED']) {
      const html = renderToStaticMarkup(
        React.createElement(AttemptHistoryCard, {
          message: zeroAttemptMessage(reason),
          isPolling: false,
        }),
      );
      assert.match(html, /data-testid="failure-reason-alert"/, reason);
      assert.doesNotMatch(html, POINTS_AT_ATTEMPTS, reason);
    }
  });

  it('the message detail dialog shows no attempt-record guidance for a zero-attempt failure', () => {
    signIn();
    for (const reason of ['Organization is closed', 'ALL_PROVIDERS_FAILED']) {
      const client = new QueryClient();
      client.setQueryData(['messages', 'detail', MSG_ID], { data: zeroAttemptMessage(reason) });
      const html = renderToStaticMarkup(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(MessageDetailDialog, { messageId: MSG_ID, onClose: () => {} }),
        ),
      );
      assert.match(html, /data-testid="failure-reason-alert"/, reason);
      assert.match(html, /data-testid="attempts-empty"/, reason);
      assert.doesNotMatch(html, POINTS_AT_ATTEMPTS, reason);
    }
  });
});
