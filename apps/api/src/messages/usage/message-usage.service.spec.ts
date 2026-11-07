import { summarizeUsage, type UsageCountRow } from './message-usage.service';

describe('summarizeUsage', () => {
  const rows: UsageCountRow[] = [
    { day: '2026-10-01', channelCode: 'whatsapp', status: 'accepted', count: 5 },
    { day: '2026-10-01', channelCode: 'whatsapp', status: 'failed', count: 2 },
    { day: '2026-10-01', channelCode: 'sms', status: 'accepted', count: 1 },
    { day: '2026-10-02', channelCode: 'whatsapp', status: 'outcome_unknown', count: 1 },
    { day: '2026-10-02', channelCode: 'whatsapp', status: 'queued', count: 3 },
    { day: '2026-10-02', channelCode: 'rcs', status: 'submitting', count: 2 },
  ];

  it('totals every status, counting unsettled statuses as pending', () => {
    expect(summarizeUsage(rows).totals).toEqual({
      total: 14,
      accepted: 6,
      failed: 2,
      outcomeUnknown: 1,
      pending: 5,
    });
  });

  it('computes the acceptance rate over settled messages only, rounded to 4 places', () => {
    expect(summarizeUsage(rows).acceptanceRate).toBe(0.6667);
    expect(summarizeUsage([]).acceptanceRate).toBeNull();
    expect(
      summarizeUsage([{ day: '2026-10-01', channelCode: 'sms', status: 'queued', count: 4 }])
        .acceptanceRate,
    ).toBeNull();
  });

  it('breaks down by channel, largest first', () => {
    expect(summarizeUsage(rows).byChannel.map((c) => [c.channelCode, c.total])).toEqual([
      ['whatsapp', 11],
      ['rcs', 2],
      ['sms', 1],
    ]);
  });

  it('breaks down by day and channel in calendar order', () => {
    const byDay = summarizeUsage(rows).byDay;
    expect(byDay.map((d) => `${d.day}/${d.channelCode}`)).toEqual([
      '2026-10-01/sms',
      '2026-10-01/whatsapp',
      '2026-10-02/rcs',
      '2026-10-02/whatsapp',
    ]);
    expect(byDay[1]).toEqual({
      day: '2026-10-01',
      channelCode: 'whatsapp',
      total: 7,
      accepted: 5,
      failed: 2,
      outcomeUnknown: 0,
      pending: 0,
    });
  });

  it('per-channel and per-day sums equal the totals', () => {
    const s = summarizeUsage(rows);
    const sum = (xs: readonly { total: number }[]) => xs.reduce((n, x) => n + x.total, 0);
    expect(sum(s.byChannel)).toBe(s.totals.total);
    expect(sum(s.byDay)).toBe(s.totals.total);
  });

  describe('Phase 5.0 delivery block (AC-API-2)', () => {
    // The same messages as `rows`, now also split by delivery status.
    const split: UsageCountRow[] = [
      {
        day: '2026-10-01',
        channelCode: 'whatsapp',
        status: 'accepted',
        deliveryStatus: 'delivered',
        count: 3,
      },
      {
        day: '2026-10-01',
        channelCode: 'whatsapp',
        status: 'accepted',
        deliveryStatus: 'pending',
        count: 1,
      },
      {
        day: '2026-10-01',
        channelCode: 'whatsapp',
        status: 'accepted',
        deliveryStatus: null,
        count: 1,
      },
      {
        day: '2026-10-01',
        channelCode: 'whatsapp',
        status: 'failed',
        deliveryStatus: 'delivered',
        count: 1,
      },
      {
        day: '2026-10-01',
        channelCode: 'whatsapp',
        status: 'failed',
        deliveryStatus: null,
        count: 1,
      },
      {
        day: '2026-10-01',
        channelCode: 'sms',
        status: 'accepted',
        deliveryStatus: 'not_supported',
        count: 1,
      },
      {
        day: '2026-10-02',
        channelCode: 'whatsapp',
        status: 'outcome_unknown',
        deliveryStatus: 'undelivered',
        count: 1,
      },
      {
        day: '2026-10-02',
        channelCode: 'whatsapp',
        status: 'queued',
        deliveryStatus: null,
        count: 3,
      },
      {
        day: '2026-10-02',
        channelCode: 'rcs',
        status: 'submitting',
        deliveryStatus: null,
        count: 2,
      },
    ];

    it('leaves every existing field identical when rows are also split by delivery status', () => {
      const before = summarizeUsage(rows);
      const after = summarizeUsage(split);
      expect(after.totals).toEqual(before.totals);
      expect(after.acceptanceRate).toBe(before.acceptanceRate);
      expect(after.byChannel).toEqual(before.byChannel);
      expect(after.byDay).toEqual(before.byDay);
    });

    it('partitions the total into the five delivery buckets; the rate is over final outcomes', () => {
      const { delivery, totals } = summarizeUsage(split);
      expect(delivery).toEqual({
        delivered: 4,
        undelivered: 1,
        pending: 1,
        notSupported: 1,
        notTracked: 7,
        deliveryRate: 0.8,
      });
      expect(
        delivery.delivered +
          delivery.undelivered +
          delivery.pending +
          delivery.notSupported +
          delivery.notTracked,
      ).toBe(totals.total);
    });

    it('a delivery outcome never moves a submission count (a failed message delivered stays failed)', () => {
      const one = summarizeUsage([
        {
          day: '2026-10-01',
          channelCode: 'sms',
          status: 'failed',
          deliveryStatus: 'delivered',
          count: 1,
        },
      ]);
      expect(one.totals).toEqual({
        total: 1,
        accepted: 0,
        failed: 1,
        outcomeUnknown: 0,
        pending: 0,
      });
      expect(one.delivery.delivered).toBe(1);
    });

    it('rows without a delivery status, or with an unrecognised one, count as not tracked; rate null', () => {
      const { delivery } = summarizeUsage([
        ...rows,
        {
          day: '2026-10-03',
          channelCode: 'sms',
          status: 'accepted',
          deliveryStatus: 'expired',
          count: 2,
        },
      ]);
      expect(delivery).toEqual({
        delivered: 0,
        undelivered: 0,
        pending: 0,
        notSupported: 0,
        notTracked: 16,
        deliveryRate: null,
      });
      expect(summarizeUsage([]).delivery.deliveryRate).toBeNull();
    });
  });
});
