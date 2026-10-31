import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { emptyAttemptsMessage } from './message-detail-dialog';

describe('QAF-026: wording when a message has no provider attempts', () => {
  it('describes queued and routing messages as queued for dispatch', () => {
    assert.match(emptyAttemptsMessage('queued', null), /queued for dispatch/);
    assert.match(emptyAttemptsMessage('routing', null), /queued for dispatch/);
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
    assert.match(text, /provider assignments|send the message again later/);
  });

  it('points other zero-attempt failures at the failure reason', () => {
    assert.match(
      emptyAttemptsMessage('failed', 'Organization is closed'),
      /No provider was attempted before the message failed/,
    );
  });

  it('covers outcome_unknown and unexpected statuses without claiming a queue', () => {
    assert.match(emptyAttemptsMessage('outcome_unknown', null), /could not be determined/);
    assert.match(emptyAttemptsMessage('something-new', null), /No provider attempt was recorded/);
  });

  it('the dialog uses the helper instead of the old hard-coded text', () => {
    const src = fs.readFileSync(path.join(__dirname, 'message-detail-dialog.tsx'), 'utf8');
    assert.doesNotMatch(src, /Message is currently queued\./);
    assert.match(src, /emptyAttemptsMessage\(message\.status, message\.failureReason\)/);
  });
});
