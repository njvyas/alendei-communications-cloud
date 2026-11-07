import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AUDIT_ACTIONS } from '../src/audit';
import {
  ALL_MESSAGE_EVENT_TYPES,
  MESSAGE_DELIVERY_STATUSES,
  MESSAGE_STATUSES,
  MESSAGE_TERMINAL_STATUSES,
  deliveryRank,
  isDeliveryFinal,
  isTerminalMessageStatus,
} from '../src/messages';
import {
  DELIVERY_RECEIPTS_CAPABILITY,
  SIMULATOR_DELIVERY_CAPABILITY,
  WEBHOOK_MAX_EVENTS_PER_REQUEST,
  validateDeliveryReceiptsCapability,
  validateSimulatorDeliveryCapability,
} from '../src/provider-adapter';

describe('Phase 5.0 — delivery contracts', () => {
  it('leaves the submission lifecycle byte-identical (AC-ST-1)', () => {
    assert.deepEqual(MESSAGE_STATUSES, [
      'queued',
      'routing',
      'submitting',
      'accepted',
      'failed',
      'outcome_unknown',
    ]);
    assert.deepEqual(MESSAGE_TERMINAL_STATUSES, ['accepted', 'failed', 'outcome_unknown']);
    assert.equal(isTerminalMessageStatus('accepted'), true);
    assert.equal(isTerminalMessageStatus('submitting'), false);
  });

  it('defines the delivery axis without a read status', () => {
    assert.deepEqual(MESSAGE_DELIVERY_STATUSES, [
      'pending',
      'delivered',
      'undelivered',
      'not_supported',
    ]);
    assert.equal((MESSAGE_DELIVERY_STATUSES as readonly string[]).includes('read'), false);
  });

  it('ranks delivery like the database guard: rank-0 < undelivered < delivered', () => {
    assert.equal(deliveryRank(null), 0);
    assert.equal(deliveryRank('pending'), 0);
    assert.equal(deliveryRank('not_supported'), 0);
    assert.equal(deliveryRank('undelivered'), 1);
    assert.equal(deliveryRank('delivered'), 2);
    assert.equal(isDeliveryFinal('delivered'), true);
    assert.equal(isDeliveryFinal('undelivered'), true);
    assert.equal(isDeliveryFinal('pending'), false);
    assert.equal(isDeliveryFinal(null), false);
  });

  it('adds the delivery event types and keeps every earlier one', () => {
    for (const t of [
      'message.queued',
      'message.accepted',
      'message.failed',
      'message.outcome_unknown',
      'message.delivered',
      'message.undelivered',
      'message.read',
      'message.delivery_conflict',
      'message.delivery_duplicate',
      'message.delivered_after_escalation',
    ]) {
      assert.ok((ALL_MESSAGE_EVENT_TYPES as readonly string[]).includes(t), t);
    }
  });

  it('names the webhook ingress audit actions the 0044 audit policy admits', () => {
    assert.equal(
      AUDIT_ACTIONS.PROVIDER_WEBHOOK_INGRESS_KEY_ROTATED,
      'provider.webhook_ingress_key_rotated',
    );
    assert.equal(
      AUDIT_ACTIONS.PROVIDER_WEBHOOK_INGRESS_ENABLED,
      'provider.webhook_ingress_enabled',
    );
    assert.equal(
      AUDIT_ACTIONS.PROVIDER_WEBHOOK_INGRESS_DISABLED,
      'provider.webhook_ingress_disabled',
    );
  });

  it('caps a webhook request at 100 events', () => {
    assert.equal(WEBHOOK_MAX_EVENTS_PER_REQUEST, 100);
  });
});

describe(`Phase 5.0 — ${DELIVERY_RECEIPTS_CAPABILITY} capability`, () => {
  it('accepts distinct receipt types', () => {
    assert.deepEqual(validateDeliveryReceiptsCapability(['delivered', 'undelivered'], 'sms'), {
      valid: true,
      errors: [],
    });
    assert.equal(validateDeliveryReceiptsCapability(['delivered', 'read'], 'whatsapp').valid, true);
    assert.equal(
      validateDeliveryReceiptsCapability(['delivered', 'undelivered', 'read'], 'rcs').valid,
      true,
    );
  });

  it('refuses non-arrays, empty arrays, unknown and repeated entries', () => {
    assert.equal(validateDeliveryReceiptsCapability('delivered', 'sms').valid, false);
    assert.equal(validateDeliveryReceiptsCapability([], 'sms').valid, false);
    assert.equal(validateDeliveryReceiptsCapability(['delivered', 'seen'], 'sms').valid, false);
    assert.equal(
      validateDeliveryReceiptsCapability(['delivered', 'delivered'], 'sms').valid,
      false,
    );
    assert.equal(validateDeliveryReceiptsCapability([1], 'sms').valid, false);
  });

  it('refuses read on SMS and read without delivered (OD-3)', () => {
    const sms = validateDeliveryReceiptsCapability(['delivered', 'read'], 'sms');
    assert.equal(sms.valid, false);
    assert.match(sms.errors.join(';'), /read is not available on the sms channel/);
    const noDelivered = validateDeliveryReceiptsCapability(['read'], 'whatsapp');
    assert.equal(noDelivered.valid, false);
    assert.match(noDelivered.errors.join(';'), /read must also include delivered/);
  });
});

describe(`Phase 5.0 — ${SIMULATOR_DELIVERY_CAPABILITY} capability`, () => {
  it('accepts the full scenario vocabulary', () => {
    assert.equal(validateSimulatorDeliveryCapability({ outcome: 'NONE' }).valid, true);
    assert.equal(
      validateSimulatorDeliveryCapability({
        outcome: 'DELIVERED',
        read: true,
        delayMs: 600000,
        duplicates: 3,
        order: 'REVERSED',
        signature: 'REPLAY',
        clientReferenceOnly: true,
        batch: true,
        withEventIds: false,
      }).valid,
      true,
    );
  });

  it('refuses unknown keys, wrong types and out-of-range values', () => {
    const cases: unknown[] = [
      null,
      [],
      'DELIVERED',
      {},
      { outcome: 'SENT' },
      { outcome: 'DELIVERED', extra: 1 },
      { outcome: 'DELIVERED', delayMs: -1 },
      { outcome: 'DELIVERED', delayMs: 600001 },
      { outcome: 'DELIVERED', duplicates: 4 },
      { outcome: 'DELIVERED', duplicates: 1.5 },
      { outcome: 'DELIVERED', order: 'RANDOM' },
      { outcome: 'DELIVERED', signature: 'NONE' },
      { outcome: 'DELIVERED', batch: 'yes' },
      { outcome: 'UNDELIVERED', read: true },
    ];
    for (const value of cases) {
      assert.equal(validateSimulatorDeliveryCapability(value).valid, false, JSON.stringify(value));
    }
  });
});
