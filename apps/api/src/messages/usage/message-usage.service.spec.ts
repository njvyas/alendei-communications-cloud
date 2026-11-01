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
});
