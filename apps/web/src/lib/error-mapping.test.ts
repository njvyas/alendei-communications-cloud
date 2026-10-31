import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from './api-client';
import { humanizeApiError } from './error-mapping';

describe('humanizeApiError (U5)', () => {
  it('humanizes NO_ELIGIBLE_PROVIDER into actionable guidance', () => {
    const err = new ApiError(422, 'NO_ELIGIBLE_PROVIDER', 'All providers refused', 'corr-1', false);
    const humanized = humanizeApiError(err);
    assert.equal(humanized.title, 'No Available Provider');
    assert.match(humanized.message, /provider assignments|circuit breaker/i);
    assert.equal(humanized.code, 'NO_ELIGIBLE_PROVIDER');
  });

  it('humanizes regulatory SMS DLT metadata errors', () => {
    const err = new ApiError(422, 'SMS_DLT_METADATA_REQUIRED', 'Metadata missing', 'corr-2', false);
    const humanized = humanizeApiError(err);
    assert.equal(humanized.title, 'DLT Metadata Required');
    assert.match(humanized.message, /Distributed Ledger Technology/i);
  });

  it('humanizes RCS unsafe action URL errors', () => {
    const err = new ApiError(422, 'RCS_UNSAFE_ACTION_URL', 'Insecure protocol', 'corr-3', false);
    const humanized = humanizeApiError(err);
    assert.equal(humanized.title, 'Unsafe Action URL');
    assert.match(humanized.message, /HTTPS/i);
  });

  it('humanizes channel not supported errors', () => {
    const err = new ApiError(422, 'CHANNEL_NOT_SUPPORTED', 'Voice not supported', 'corr-4', false);
    const humanized = humanizeApiError(err);
    assert.equal(humanized.title, 'Channel Not Supported');
    assert.match(humanized.message, /does not support/i);
  });

  it('falls back gracefully on unknown errors while keeping message', () => {
    const err = new Error('Network offline');
    const humanized = humanizeApiError(err);
    assert.equal(humanized.title, 'Operation Failed');
    assert.equal(humanized.message, 'Network offline');
  });
});
