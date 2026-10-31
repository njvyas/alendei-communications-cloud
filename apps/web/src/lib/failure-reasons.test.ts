import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatFailureReason, emptyAttemptsGuidance } from './failure-reasons';

describe('formatFailureReason (U5)', () => {
  it('returns null for null, undefined, or empty string', () => {
    assert.equal(formatFailureReason(null), null);
    assert.equal(formatFailureReason(undefined), null);
    assert.equal(formatFailureReason(''), null);
    assert.equal(formatFailureReason('   '), null);
  });

  it('formats NO_ELIGIBLE_PROVIDER with explanation and next steps', () => {
    const formatted = formatFailureReason('NO_ELIGIBLE_PROVIDER');
    assert.ok(formatted);
    assert.equal(formatted.title, 'No Available Provider');
    assert.match(formatted.description, /circuit breaker was open|unavailable/i);
    assert.match(formatted.action, /provider assignments|cooldown/i);
    assert.equal(formatted.severity, 'warning');
    assert.equal(formatted.code, 'NO_ELIGIBLE_PROVIDER');
  });

  it('formats RECIPIENT_SUPPRESSED with actionable advice', () => {
    const formatted = formatFailureReason('RECIPIENT_SUPPRESSED');
    assert.ok(formatted);
    assert.equal(formatted.title, 'Recipient Suppressed');
    assert.match(formatted.description, /suppression list/i);
    assert.match(formatted.action, /Suppressions/i);
    assert.equal(formatted.severity, 'warning');
  });

  it('formats CONSENT_REVOKED with actionable advice', () => {
    const formatted = formatFailureReason('CONSENT_REVOKED');
    assert.ok(formatted);
    assert.equal(formatted.title, 'Consent Revoked');
    assert.match(formatted.action, /fresh recipient consent/i);
  });

  it('formats CHANNEL_NOT_SUPPORTED and CHANNEL_UNSUPPORTED prefix', () => {
    const direct = formatFailureReason('CHANNEL_NOT_SUPPORTED');
    assert.ok(direct);
    assert.equal(direct.title, 'Channel Not Supported');

    const prefixed = formatFailureReason('CHANNEL_UNSUPPORTED: voice');
    assert.ok(prefixed);
    assert.equal(prefixed.title, "Channel 'voice' Not Supported");
    assert.match(prefixed.description, /voice.*unsupported/i);
  });

  it('formats regulatory and template failure codes', () => {
    const dlt = formatFailureReason('SMS_DLT_METADATA_REQUIRED');
    assert.ok(dlt);
    assert.equal(dlt.title, 'DLT Metadata Required');

    const rcs = formatFailureReason('RCS_UNSAFE_ACTION_URL');
    assert.ok(rcs);
    assert.equal(rcs.title, 'Unsafe Action URL');

    const tmpl = formatFailureReason('TEMPLATE_NOT_APPROVED');
    assert.ok(tmpl);
    assert.equal(tmpl.title, 'Template Not Approved');
  });

  it('formats provider errors with extracted error message', () => {
    const provErr = formatFailureReason(
      'PROVIDER_ERROR: Simulated provider server error (HTTP 500)',
    );
    assert.ok(provErr);
    assert.equal(provErr.title, 'Provider Delivery Error');
    assert.match(provErr.description, /Simulated provider server error/);
    assert.equal(provErr.code, 'PROVIDER_ERROR');

    const provTimeout = formatFailureReason('PROVIDER_TIMEOUT: Gateway timeout 3000ms');
    assert.ok(provTimeout);
    assert.equal(provTimeout.title, 'Provider Timeout');
  });

  it('formats expired dispatch leases and outcome_unknown', () => {
    const lease = formatFailureReason(
      'Dispatch lease expired during external submission (outcome_unknown)',
    );
    assert.ok(lease);
    assert.equal(lease.title, 'Outcome Unknown (Lease Expired)');
    assert.match(lease.action, /duplicate delivery/i);
  });

  it('gracefully handles unknown failure codes', () => {
    const custom = formatFailureReason('CUSTOM_NETWORK_GLITCH: Port unreachable');
    assert.ok(custom);
    assert.equal(custom.title, 'Message Dispatch Failed');
    assert.equal(custom.description, 'CUSTOM_NETWORK_GLITCH: Port unreachable');
    assert.equal(custom.code, 'CUSTOM_NETWORK_GLITCH');
  });
});

describe('emptyAttemptsGuidance (U5 & QAF-026)', () => {
  it('describes queued and routing as queued for dispatch', () => {
    const queued = emptyAttemptsGuidance('queued', null);
    assert.match(queued.message, /queued for dispatch/i);

    const routing = emptyAttemptsGuidance('routing', null);
    assert.match(routing.message, /queued for dispatch/i);
  });

  it('never describes a terminal failed message as queued', () => {
    for (const reason of [
      'NO_ELIGIBLE_PROVIDER',
      'RECIPIENT_SUPPRESSED',
      'PROVIDER_ERROR: 500',
      null,
    ]) {
      const guidance = emptyAttemptsGuidance('failed', reason);
      assert.doesNotMatch(guidance.message, /queued/i);
    }
  });

  it('provides explanation and next steps for NO_ELIGIBLE_PROVIDER terminal failure', () => {
    const guidance = emptyAttemptsGuidance('failed', 'NO_ELIGIBLE_PROVIDER');
    assert.match(guidance.message, /unavailable/i);
    assert.match(guidance.action!, /provider assignments|later/i);
  });

  it('provides tailored next steps for other terminal failures', () => {
    const guidance = emptyAttemptsGuidance('failed', 'RECIPIENT_SUPPRESSED');
    assert.match(guidance.message, /Recipient Suppressed/i);
    assert.match(guidance.action!, /Suppressions/i);
  });

  it('describes outcome_unknown without claiming a queue', () => {
    const guidance = emptyAttemptsGuidance('outcome_unknown', null);
    assert.match(guidance.message, /could not be determined/i);
    assert.doesNotMatch(guidance.message, /queued/i);
  });
});
