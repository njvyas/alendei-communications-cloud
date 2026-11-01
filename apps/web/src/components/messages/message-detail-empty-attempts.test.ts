import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { emptyAttemptsGuidance } from '@/lib/failure-reasons';

import { emptyAttemptsMessage } from './message-detail-dialog';

describe('QAF-026: wording when a message has no provider attempts', () => {
  it('describes queued and routing messages as queued, and submitting as being dispatched', () => {
    assert.match(emptyAttemptsMessage('queued', null), /queued for dispatch/);
    assert.match(emptyAttemptsMessage('routing', null), /queued for dispatch/);
    const submitting = emptyAttemptsMessage('submitting', null);
    assert.match(submitting, /currently being dispatched/);
    assert.doesNotMatch(submitting, /queued/i);
  });

  it('never describes a terminal message as queued', () => {
    for (const status of ['failed', 'outcome_unknown', 'accepted']) {
      for (const reason of [null, 'NO_ELIGIBLE_PROVIDER', 'PROVIDER_ERROR: x']) {
        assert.doesNotMatch(emptyAttemptsMessage(status, reason), /queued/i, `${status}/${reason}`);
      }
    }
  });

  it('explains NO_ELIGIBLE_PROVIDER and gives a next step', () => {
    const text = emptyAttemptsMessage('failed', 'NO_ELIGIBLE_PROVIDER');
    assert.match(text, /No provider was attempted/);
    assert.match(text, /disabled, draining, or its circuit was open/);
    assert.match(
      emptyAttemptsGuidance('failed', 'NO_ELIGIBLE_PROVIDER').action ?? '',
      /provider assignments|send the message again later/,
    );
  });

  it('points other zero-attempt failures at the failure reason', () => {
    // A free-text reason (formatted) and a missing reason (fallback) both give a next step.
    for (const reason of ['Organization is closed', null]) {
      const guidance = emptyAttemptsGuidance('failed', reason);
      assert.match(guidance.message, /No provider was attempted before the message failed/);
      assert.ok(guidance.action, `a zero-attempt failure must give a next step (${reason})`);
    }
  });

  it('covers outcome_unknown and unexpected statuses without claiming a queue', () => {
    assert.match(emptyAttemptsMessage('outcome_unknown', null), /could not be determined/);
    assert.match(emptyAttemptsMessage('something-new', null), /No provider attempt was recorded/);
  });

  it('the dialog uses the shared guidance instead of the old hard-coded text', () => {
    const src = fs.readFileSync(path.join(__dirname, 'message-detail-dialog.tsx'), 'utf8');
    assert.doesNotMatch(src, /Message is currently queued\./);
    assert.match(src, /emptyAttemptsGuidance\(\s*message\.status,\s*message\.failureReason,?\s*\)/);
    // Both parts of the guidance are rendered, not only computed.
    assert.match(src, /\{\s*guidance\.message\s*\}/);
    assert.match(src, /\{\s*guidance\.action\s*\}/);
  });
});
