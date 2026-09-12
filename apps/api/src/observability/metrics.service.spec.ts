import { assertBoundedLabels, FORBIDDEN_LABELS } from './metrics.service';

/**
 * `OBSERVABILITY.md` §3 states the cardinality rule as mandatory, not stylistic.
 * These tests make it a runtime guarantee: a metric declaring a tenant-, message-
 * or campaign-level label cannot be constructed at all.
 */
describe('Prometheus label cardinality boundary', () => {
  it('accepts the documented bounded label set', () => {
    expect(() =>
      assertBoundedLabels('acc_test_total', [
        'environment',
        'service',
        'operation',
        'channel',
        'provider',
        'status',
        'route',
        'method',
      ]),
    ).not.toThrow();
  });

  it.each(FORBIDDEN_LABELS)('refuses "%s" as a metric label', (label) => {
    expect(() => assertBoundedLabels('acc_test_total', [label])).toThrow(
      /not in the bounded label set/,
    );
  });

  it('names the offending metric and label so the failure is actionable', () => {
    expect(() => assertBoundedLabels('acc_messages_total', ['message_id'])).toThrow(
      /acc_messages_total.*message_id/s,
    );
  });
});
