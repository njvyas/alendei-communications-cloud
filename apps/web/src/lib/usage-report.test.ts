import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { MessageUsageReportResponse } from '@acc/contracts';
import {
  csvField,
  formatRate,
  periodFor,
  presetPeriod,
  usageCsv,
  usageCsvFileName,
  zonedDay,
  zonedMidnight,
} from './usage-report';

const report: MessageUsageReportResponse = {
  orgId: '00000000-0000-4000-8000-000000000001',
  from: '2026-09-30T18:30:00.000Z',
  to: '2026-10-02T18:30:00.000Z',
  timeZone: 'Asia/Kolkata',
  workspaceId: null,
  channelCode: null,
  totals: { total: 5, accepted: 3, failed: 1, outcomeUnknown: 0, pending: 1 },
  acceptanceRate: 0.75,
  byChannel: [],
  byDay: [
    {
      day: '2026-10-01',
      channelCode: 'whatsapp',
      total: 4,
      accepted: 3,
      failed: 1,
      outcomeUnknown: 0,
      pending: 0,
    },
    {
      day: '2026-10-02',
      channelCode: 'sms',
      total: 1,
      accepted: 0,
      failed: 0,
      outcomeUnknown: 0,
      pending: 1,
    },
  ],
  topFailureReasons: [],
};

describe('usage report periods', () => {
  it('maps a calendar day to its midnight in the time zone', () => {
    assert.equal(zonedMidnight('2026-10-01', 'UTC').toISOString(), '2026-10-01T00:00:00.000Z');
    assert.equal(
      zonedMidnight('2026-10-01', 'Asia/Kolkata').toISOString(),
      '2026-09-30T18:30:00.000Z',
    );
    // Across a daylight-saving change (New York leaves DST on 01-Nov-2026).
    assert.equal(
      zonedMidnight('2026-11-02', 'America/New_York').toISOString(),
      '2026-11-02T05:00:00.000Z',
    );
  });

  it('finds the calendar day of an instant in the time zone', () => {
    const instant = new Date('2026-10-01T20:00:00Z');
    assert.equal(zonedDay(instant, 'UTC'), '2026-10-01');
    assert.equal(zonedDay(instant, 'Asia/Kolkata'), '2026-10-02');
  });

  it('builds an inclusive day range with an exclusive upper bound', () => {
    assert.deepEqual(periodFor('2026-10-01', '2026-10-02', 'Asia/Kolkata'), {
      from: '2026-09-30T18:30:00.000Z',
      to: '2026-10-02T18:30:00.000Z',
    });
    assert.deepEqual(periodFor('2026-10-05', '2026-10-05', 'UTC'), {
      from: '2026-10-05T00:00:00.000Z',
      to: '2026-10-06T00:00:00.000Z',
    });
  });

  it('refuses an empty, reversed or over-long range', () => {
    assert.ok('error' in periodFor('', '2026-10-01', 'UTC'));
    assert.ok('error' in periodFor('2026-10-02', '2026-10-01', 'UTC'));
    assert.ok('error' in periodFor('2025-01-01', '2026-01-02', 'UTC'));
    assert.ok(!('error' in periodFor('2025-01-01', '2025-12-31', 'UTC')));
  });

  it('presets cover the last N days including today', () => {
    const now = new Date('2026-10-31T20:00:00Z'); // 01-Nov in India
    assert.deepEqual(presetPeriod(7, 'UTC', now), { fromDay: '2026-10-25', toDay: '2026-10-31' });
    assert.deepEqual(presetPeriod(7, 'Asia/Kolkata', now), {
      fromDay: '2026-10-26',
      toDay: '2026-11-01',
    });
  });
});

describe('usage report formatting and export', () => {
  it('formats the acceptance rate', () => {
    assert.equal(formatRate(0.8125), '81.3 %');
    assert.equal(formatRate(1), '100.0 %');
    assert.equal(formatRate(null), '—');
  });

  it('exports the daily rows and a total as CSV', () => {
    assert.equal(
      usageCsv(report),
      'day,channel,total,accepted,failed,outcome_unknown,pending\r\n' +
        '2026-10-01,whatsapp,4,3,1,0,0\r\n' +
        '2026-10-02,sms,1,0,0,0,1\r\n' +
        'TOTAL,all,5,3,1,0,1\r\n',
    );
  });

  it('names the export after the period in the report time zone', () => {
    assert.equal(usageCsvFileName(report), 'acc-message-usage-2026-10-01-to-2026-10-02.csv');
    assert.equal(
      usageCsvFileName({ ...report, channelCode: 'sms' }),
      'acc-message-usage-sms-2026-10-01-to-2026-10-02.csv',
    );
  });

  it('neutralises spreadsheet formulas and quotes special characters (CSV injection)', () => {
    assert.equal(csvField('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvField('+1'), "'+1");
    assert.equal(csvField('-2'), "'-2");
    assert.equal(csvField('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(csvField('a,b'), '"a,b"');
    assert.equal(csvField('line\nbreak'), '"line\nbreak"');
    assert.equal(csvField(-3), '-3'); // numbers are data, not formulas
    assert.equal(csvField('whatsapp'), 'whatsapp');
  });
});
