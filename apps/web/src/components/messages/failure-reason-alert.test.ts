import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { FailureReasonAlert } from './failure-reason-alert';

(globalThis as unknown as { React: typeof React }).React = React;

describe('FailureReasonAlert Component (U5)', () => {
  it('1. renders alert with role="alert" and aria-label', () => {
    const html = renderToStaticMarkup(
      React.createElement(FailureReasonAlert, { failureReason: 'NO_ELIGIBLE_PROVIDER' }),
    );
    assert.ok(html.includes('role="alert"'));
    assert.ok(html.includes('aria-label="Dispatch failure: No Available Provider"'));
  });

  it('2. renders structured title, code badge, description, and guidance for NO_ELIGIBLE_PROVIDER', () => {
    const html = renderToStaticMarkup(
      React.createElement(FailureReasonAlert, { failureReason: 'NO_ELIGIBLE_PROVIDER' }),
    );
    assert.ok(html.includes('No Available Provider'));
    assert.ok(html.includes('NO_ELIGIBLE_PROVIDER'));
    assert.ok(
      html.includes(
        'Every provider assigned to this channel was unavailable because it was disabled, draining, or its circuit breaker was open',
      ),
    );
    assert.ok(html.includes('What to do next:'));
    assert.ok(html.includes('Check provider assignments in Organization Settings'));
  });

  it('3. renders structured guidance for RECIPIENT_SUPPRESSED', () => {
    const html = renderToStaticMarkup(
      React.createElement(FailureReasonAlert, { failureReason: 'RECIPIENT_SUPPRESSED' }),
    );
    assert.ok(html.includes('Recipient Suppressed'));
    assert.ok(html.includes('RECIPIENT_SUPPRESSED'));
    assert.ok(html.includes('The recipient address is on the organization suppression list'));
    assert.ok(html.includes('Suppressions'));
  });

  it('4. renders structured guidance for SMS DLT metadata requirements', () => {
    const html = renderToStaticMarkup(
      React.createElement(FailureReasonAlert, { failureReason: 'SMS_DLT_METADATA_REQUIRED' }),
    );
    assert.ok(html.includes('DLT Metadata Required'));
    assert.ok(html.includes('(DLT) Entity ID'));
    assert.ok(html.includes('Template ID'));
  });

  it('5. gracefully renders unknown failure reason codes with fallback description and guidance', () => {
    const html = renderToStaticMarkup(
      React.createElement(FailureReasonAlert, { failureReason: 'CUSTOM_UNEXPECTED_FAILURE_XYZ' }),
    );
    assert.ok(html.includes('CUSTOM_UNEXPECTED_FAILURE_XYZ'));
    assert.ok(html.includes('Message Dispatch Failed'));
    assert.ok(
      html.includes(
        'Inspect the attempt records below or check channel and provider configuration.',
      ),
    );
  });

  it('6. applies custom className when provided', () => {
    const html = renderToStaticMarkup(
      React.createElement(FailureReasonAlert, {
        failureReason: 'PROVIDER_ERROR',
        className: 'my-custom-test-class',
      }),
    );
    assert.ok(html.includes('my-custom-test-class'));
  });
});
