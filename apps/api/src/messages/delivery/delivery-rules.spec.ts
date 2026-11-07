import type { DeliveryReceiptType, MessageDeliveryStatus } from '@acc/contracts';

import {
  aggregateMessageDelivery,
  decideAttemptDelivery,
  initialDeliveryStatus,
  type AttemptDeliveryState,
} from './delivery-rules';

const ALL = new Set<DeliveryReceiptType>(['delivered', 'undelivered', 'read']);
const NO_READ = new Set<DeliveryReceiptType>(['delivered', 'undelivered']);
const NONE = new Set<DeliveryReceiptType>();
const NOW = new Date('2026-11-07T12:00:00.000Z');
const T1 = new Date('2026-11-07T11:00:00.000Z');
const T2 = new Date('2026-11-07T11:30:00.000Z');

const attempt = (
  deliveryStatus: MessageDeliveryStatus | null,
  over: Partial<AttemptDeliveryState> = {},
): AttemptDeliveryState => ({
  status: 'accepted',
  deliveryStatus,
  deliveredAt: deliveryStatus === 'delivered' ? T1 : null,
  readAt: null,
  ...over,
});

describe('initial delivery status at settlement (§B.3 row 1, OD-3)', () => {
  it('pending when the provider reports outcomes, not_supported otherwise', () => {
    expect(initialDeliveryStatus(ALL)).toBe('pending');
    expect(initialDeliveryStatus(new Set(['undelivered']))).toBe('pending');
    expect(initialDeliveryStatus(NONE)).toBe('not_supported');
    expect(initialDeliveryStatus(new Set(['read']))).toBe('not_supported');
  });
});

describe('decideAttemptDelivery — the §B.3 transition table', () => {
  it('pending → delivered / undelivered; the provider timestamp sets delivered_at', () => {
    expect(
      decideAttemptDelivery(attempt('pending'), { kind: 'delivered', occurredAt: T2 }, ALL, NOW),
    ).toEqual({
      outcome: 'applied',
      change: { deliveryStatus: 'delivered', deliveredAt: T2, readAt: null },
      emit: ['delivered'],
      flags: [],
    });
    expect(
      decideAttemptDelivery(attempt('pending'), { kind: 'undelivered', occurredAt: T2 }, ALL, NOW),
    ).toEqual({
      outcome: 'applied',
      change: { deliveryStatus: 'undelivered', deliveredAt: null, readAt: null },
      emit: ['undelivered'],
      flags: [],
    });
  });

  it('undelivered → delivered: positive evidence wins and a conflict is recorded', () => {
    const d = decideAttemptDelivery(
      attempt('undelivered'),
      { kind: 'delivered', occurredAt: T2 },
      ALL,
      NOW,
    );
    expect(d.outcome).toBe('applied');
    expect(d.change?.deliveryStatus).toBe('delivered');
    expect(d.emit).toEqual(['delivered', 'delivery_conflict']);
  });

  it('delivered is terminal for the axis: undelivered is a conflict with no change; delivered again is no_change', () => {
    expect(
      decideAttemptDelivery(
        attempt('delivered'),
        { kind: 'undelivered', occurredAt: T2 },
        ALL,
        NOW,
      ),
    ).toEqual({
      outcome: 'conflict',
      emit: ['delivery_conflict'],
      flags: [],
    });
    expect(
      decideAttemptDelivery(attempt('delivered'), { kind: 'delivered', occurredAt: T2 }, ALL, NOW),
    ).toEqual({
      outcome: 'no_change',
      emit: [],
      flags: [],
    });
    expect(
      decideAttemptDelivery(
        attempt('undelivered'),
        { kind: 'undelivered', occurredAt: T2 },
        ALL,
        NOW,
      ).outcome,
    ).toBe('no_change');
  });

  it('not_supported → delivered/undelivered only as unsolicited', () => {
    const d = decideAttemptDelivery(
      attempt('not_supported'),
      { kind: 'delivered', occurredAt: null },
      NONE,
      NOW,
    );
    expect(d.change?.deliveryStatus).toBe('delivered');
    expect(d.change?.deliveredAt).toBe(NOW);
    expect(d.flags).toEqual(['unsolicited']);
  });

  it('NULL on a failed attempt → delivered/undelivered on the anomaly path, flagged', () => {
    const d = decideAttemptDelivery(
      attempt(null, { status: 'failed' }),
      { kind: 'undelivered', occurredAt: T1 },
      ALL,
      NOW,
    );
    expect(d.change?.deliveryStatus).toBe('undelivered');
    expect(d.flags).toEqual(['after_submission_failure']);
  });

  it('read before delivered sets delivered (inferred_from_read) and read_at; a second read is no_change (write-once)', () => {
    const d = decideAttemptDelivery(attempt('pending'), { kind: 'read', occurredAt: T2 }, ALL, NOW);
    expect(d).toEqual({
      outcome: 'applied',
      change: { deliveryStatus: 'delivered', deliveredAt: T2, readAt: T2 },
      emit: ['delivered', 'read'],
      flags: ['inferred_from_read'],
    });
    const after = attempt('delivered', { readAt: T2 });
    expect(decideAttemptDelivery(after, { kind: 'read', occurredAt: T1 }, ALL, NOW).outcome).toBe(
      'no_change',
    );
  });

  it('read on a delivered attempt keeps delivered_at and sets read_at only', () => {
    const d = decideAttemptDelivery(
      attempt('delivered'),
      { kind: 'read', occurredAt: T2 },
      ALL,
      NOW,
    );
    expect(d.change).toEqual({ deliveryStatus: 'delivered', deliveredAt: T1, readAt: T2 });
    expect(d.emit).toEqual(['read']);
  });

  it('read from a provider that does not declare read is informational, never applied (AC-ST-5)', () => {
    expect(
      decideAttemptDelivery(attempt('pending'), { kind: 'read', occurredAt: T2 }, NO_READ, NOW),
    ).toEqual({
      outcome: 'informational',
      emit: [],
      flags: ['read_not_declared'],
    });
  });

  it('informational events change nothing; a still-submitting attempt defers', () => {
    expect(
      decideAttemptDelivery(attempt('pending'), { kind: 'informational', occurredAt: T2 }, ALL, NOW)
        .outcome,
    ).toBe('informational');
    expect(
      decideAttemptDelivery(
        attempt(null, { status: 'submitting' }),
        { kind: 'delivered', occurredAt: T2 },
        ALL,
        NOW,
      ).outcome,
    ).toBe('deferred');
  });

  it('a future provider timestamp is clamped to the receive time', () => {
    const d = decideAttemptDelivery(
      attempt('pending'),
      { kind: 'delivered', occurredAt: new Date('2027-01-01T00:00:00Z') },
      ALL,
      NOW,
    );
    expect(d.change?.deliveredAt).toBe(NOW);
    expect(d.flags).toContain('clamped_future_timestamp');
  });

  it('never moves the submission status: decisions carry delivery fields only', () => {
    const d = decideAttemptDelivery(
      attempt('pending', { status: 'outcome_unknown' }),
      { kind: 'delivered', occurredAt: T1 },
      ALL,
      NOW,
    );
    expect(Object.keys(d.change ?? {}).sort()).toEqual(['deliveredAt', 'deliveryStatus', 'readAt']);
  });
});

describe('aggregateMessageDelivery — §B.5', () => {
  const msg = (deliveryStatus: MessageDeliveryStatus | null, over = {}) => ({
    currentAttemptId: 'a2',
    deliveryStatus,
    deliveredAt: null,
    readAt: null,
    deliveredAttemptId: null,
    ...over,
  });
  const a = (
    id: string,
    n: number,
    deliveryStatus: MessageDeliveryStatus | null,
    deliveredAt: Date | null = null,
    readAt: Date | null = null,
  ) => ({
    id,
    attemptNumber: n,
    deliveryStatus,
    deliveredAt,
    readAt,
  });

  it('rule 2: without a delivered attempt the message mirrors the current attempt', () => {
    expect(
      aggregateMessageDelivery(msg(null), [a('a1', 1, 'undelivered'), a('a2', 2, 'pending')]),
    ).toEqual({
      deliveryStatus: 'pending',
      deliveredAttemptId: null,
      deliveredAt: null,
      readAt: null,
    });
  });

  it('rule 1: any delivered attempt — even a superseded one — makes the message delivered (§B.6a rule 2)', () => {
    expect(
      aggregateMessageDelivery(msg('pending'), [
        a('a1', 1, 'delivered', T2),
        a('a2', 2, 'pending'),
      ]),
    ).toEqual({
      deliveryStatus: 'delivered',
      deliveredAttemptId: 'a1',
      deliveredAt: T2,
      readAt: null,
    });
  });

  it('the first attempt to deliver, the earliest delivered_at and the earliest read_at', () => {
    expect(
      aggregateMessageDelivery(msg('pending'), [
        a('a1', 1, 'delivered', T2, T2),
        a('a2', 2, 'delivered', T1, null),
      ]),
    ).toEqual({
      deliveryStatus: 'delivered',
      deliveredAttemptId: 'a2',
      deliveredAt: T1,
      readAt: T2,
    });
  });

  it('write-once and monotonic: an existing delivered message keeps its attempt and timestamps', () => {
    const current = msg('delivered', { deliveredAttemptId: 'a1', deliveredAt: T2 });
    expect(
      aggregateMessageDelivery(current, [a('a1', 1, 'delivered', T2), a('a2', 2, 'delivered', T1)]),
    ).toBeNull();
  });

  it('never lowers the rank, swaps two rank-0 values or clears a set value', () => {
    expect(aggregateMessageDelivery(msg('undelivered'), [a('a2', 2, 'pending')])).toBeNull();
    expect(aggregateMessageDelivery(msg('pending'), [a('a2', 2, 'not_supported')])).toBeNull();
    expect(
      aggregateMessageDelivery(msg('pending', { currentAttemptId: null }), [a('a1', 1, null)]),
    ).toBeNull();
  });

  it('returns null when nothing changes', () => {
    expect(aggregateMessageDelivery(msg('pending'), [a('a2', 2, 'pending')])).toBeNull();
  });
});
