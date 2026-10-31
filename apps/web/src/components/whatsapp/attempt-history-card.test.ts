import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AttemptHistoryCard } from './attempt-history-card';
import type { MessageDetailWithAttempts } from '../../lib/api-client';

(globalThis as unknown as { React: typeof React }).React = React;

describe('AttemptHistoryCard Component (U5)', () => {
  const baseMessage: MessageDetailWithAttempts = {
    id: '01955b0a-7b3b-7411-9a4f-msg000000001',
    orgId: '01955b0a-7b3b-7411-9a4f-org000000001',
    workspaceId: '01955b0a-7b3b-7411-9a4f-ws000000001',
    contactId: '01955b0a-7b3b-7411-9a4f-ct000000001',
    channelId: '01955b0a-7b3b-7411-9a4f-ch000000001',
    templateId: null,
    status: 'failed',
    recipientAddress: '+12025550199',
    payload: { text: 'Hello' },
    failureReason: 'NO_ELIGIBLE_PROVIDER',
    createdAt: '2026-10-31T10:00:00.000Z',
    completedAt: '2026-10-31T10:00:01.000Z',
    attempts: [],
  };

  it('1. renders FailureReasonAlert with title and guidance when failureReason is present', () => {
    const html = renderToStaticMarkup(
      React.createElement(AttemptHistoryCard, { message: baseMessage, isPolling: false }),
    );
    assert.ok(html.includes('role="alert"'));
    assert.ok(html.includes('No Available Provider'));
    assert.ok(html.includes('NO_ELIGIBLE_PROVIDER'));
    assert.ok(html.includes('What to do next:'));
    assert.ok(html.includes('Check provider assignments in Organization Settings'));
  });

  it('2. renders accurate empty attempts message when message failed before dispatch (0 attempts)', () => {
    const html = renderToStaticMarkup(
      React.createElement(AttemptHistoryCard, { message: baseMessage, isPolling: false }),
    );
    // Should NOT say "Message is currently claimed or waiting in dispatch queue"
    assert.ok(!html.includes('waiting in dispatch queue'));
    assert.ok(
      html.includes(
        'No provider was attempted: every assigned provider was unavailable (disabled, draining, or its circuit was open).',
      ),
    );
    assert.ok(
      html.includes(
        'Check the organization’s provider assignments, or send the message again later.',
      ),
    );
  });

  it('3. renders in-flight empty attempts message when message is queued/pending', () => {
    const queuedMessage: MessageDetailWithAttempts = {
      ...baseMessage,
      status: 'queued',
      failureReason: null,
      completedAt: null,
      attempts: [],
    };
    const html = renderToStaticMarkup(
      React.createElement(AttemptHistoryCard, { message: queuedMessage, isPolling: true }),
    );
    assert.ok(
      html.includes('No dispatch attempts recorded yet. The message is queued for dispatch.'),
    );
    assert.ok(html.includes('Live Polling (1s)'));
  });

  it('4. renders formatted failure reason in attempts table for failed attempts', () => {
    const messageWithAttempts: MessageDetailWithAttempts = {
      ...baseMessage,
      status: 'failed',
      failureReason: 'ALL_PROVIDERS_FAILED',
      attempts: [
        {
          id: '01955b0a-7b3b-7411-9a4f-att000000001',
          attemptNumber: 1,
          providerId: 'provider-sim-1',
          status: 'failed',
          failureReason: 'PROVIDER_TIMEOUT',
          latencyMs: 3000,
          completedAt: '2026-10-31T10:00:03.000Z',
        },
        {
          id: '01955b0a-7b3b-7411-9a4f-att000000002',
          attemptNumber: 2,
          providerId: 'provider-sim-2',
          status: 'failed',
          failureReason: 'PROVIDER_ERROR',
          latencyMs: 120,
          completedAt: '2026-10-31T10:00:04.000Z',
        },
      ],
    };

    const html = renderToStaticMarkup(
      React.createElement(AttemptHistoryCard, { message: messageWithAttempts, isPolling: false }),
    );
    assert.ok(html.includes('#1'));
    assert.ok(html.includes('provider-sim-1'));
    assert.ok(html.includes('Provider Timeout'));
    assert.ok(html.includes('(PROVIDER_TIMEOUT)'));
    assert.ok(html.includes('3000 ms'));

    assert.ok(html.includes('#2'));
    assert.ok(html.includes('provider-sim-2'));
    assert.ok(html.includes('Provider Delivery Error'));
    assert.ok(html.includes('(PROVIDER_ERROR)'));
  });
});
