/**
 * Usage reporting helpers (`GET /usage/messages`): the API call, period
 * arithmetic in a chosen time zone, and CSV export. Pure functions except
 * `usageApi.messages`, so they are unit-tested without a browser.
 */
import { MESSAGE_USAGE_MAX_DAYS, type MessageUsageReportResponse } from '@acc/contracts';

import { apiFetch } from './api-client';

export type { MessageUsageReportResponse } from '@acc/contracts';
export { MESSAGE_USAGE_MAX_DAYS };

/** Channels the report offers as filters (the messaging channels ACC sends on). */
export const USAGE_CHANNELS = ['whatsapp', 'sms', 'rcs'] as const;
export type UsageChannel = (typeof USAGE_CHANNELS)[number];

export interface MessageUsageParams {
  readonly from: string;
  readonly to: string;
  readonly timeZone?: string;
  readonly channelCode?: UsageChannel;
  readonly workspaceId?: string;
}

export const usageApi = {
  async messages(
    params: MessageUsageParams,
    signal?: AbortSignal,
  ): Promise<{ data: MessageUsageReportResponse }> {
    const query = new URLSearchParams({ from: params.from, to: params.to });
    if (params.timeZone) query.set('timeZone', params.timeZone);
    if (params.channelCode) query.set('channelCode', params.channelCode);
    if (params.workspaceId) query.set('workspaceId', params.workspaceId);
    return apiFetch<{ data: MessageUsageReportResponse }>(`/usage/messages?${query.toString()}`, {
      method: 'GET',
      signal,
    });
  },
};

const DAY_MS = 86_400_000;

/** Offset of `timeZone` from UTC at `instant`, in milliseconds (positive east of UTC). */
export function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Midnight at the start of `day` (`YYYY-MM-DD`) in `timeZone`, as a UTC instant. */
export function zonedMidnight(day: string, timeZone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new RangeError(`Invalid day: ${day}`);
  const guess = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // Two passes settle a daylight-saving transition between the guess and the answer.
  let instant = guess - zoneOffsetMs(guess, timeZone);
  instant = guess - zoneOffsetMs(instant, timeZone);
  return new Date(instant);
}

/** The calendar day of `instant` in `timeZone`, `YYYY-MM-DD`. */
export function zonedDay(instant: Date, timeZone: string): string {
  return new Date(instant.getTime() + zoneOffsetMs(instant.getTime(), timeZone))
    .toISOString()
    .slice(0, 10);
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The last `days` calendar days in `timeZone`, today included: `from` is the
 * first day's midnight and `to` (exclusive) is tomorrow's midnight.
 */
export function presetPeriod(
  days: number,
  timeZone: string,
  now: Date = new Date(),
): { fromDay: string; toDay: string } {
  const today = zonedDay(now, timeZone);
  return { fromDay: addDays(today, -(days - 1)), toDay: today };
}

/**
 * The API period for an inclusive range of calendar days in `timeZone`, or an
 * error message when the range is empty, reversed or too long.
 */
export function periodFor(
  fromDay: string,
  toDay: string,
  timeZone: string,
): { from: string; to: string } | { error: string } {
  if (!fromDay || !toDay) return { error: 'Choose both a start and an end date.' };
  if (toDay < fromDay) return { error: 'The end date must not be before the start date.' };
  const from = zonedMidnight(fromDay, timeZone);
  const to = zonedMidnight(addDays(toDay, 1), timeZone);
  if (to.getTime() - from.getTime() > MESSAGE_USAGE_MAX_DAYS * DAY_MS) {
    return { error: `Choose a period of at most ${MESSAGE_USAGE_MAX_DAYS} days.` };
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

/** `0.8125` → `81.3 %`; `null` (nothing settled) → `—`. */
export function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)} %`;
}

/**
 * One CSV field. Quotes when needed, and neutralises a leading `=`, `+`, `-`,
 * `@`, tab or carriage return so a spreadsheet never evaluates it as a formula.
 */
export function csvField(value: string | number): string {
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_COLUMNS = ['day', 'channel', 'total', 'accepted', 'failed', 'outcome_unknown', 'pending'];

/** The daily breakdown as CSV (RFC 4180, CRLF), followed by one `TOTAL` row. */
export function usageCsv(report: MessageUsageReportResponse): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of report.byDay) {
    lines.push(
      [
        row.day,
        row.channelCode,
        row.total,
        row.accepted,
        row.failed,
        row.outcomeUnknown,
        row.pending,
      ]
        .map(csvField)
        .join(','),
    );
  }
  const t = report.totals;
  lines.push(
    [
      'TOTAL',
      report.channelCode ?? 'all',
      t.total,
      t.accepted,
      t.failed,
      t.outcomeUnknown,
      t.pending,
    ]
      .map(csvField)
      .join(','),
  );
  return `${lines.join('\r\n')}\r\n`;
}

/** File name for an export: the period's first and last day in the report time zone. */
export function usageCsvFileName(report: MessageUsageReportResponse): string {
  const first = zonedDay(new Date(report.from), report.timeZone);
  const last = zonedDay(new Date(Date.parse(report.to) - 1), report.timeZone);
  const channel = report.channelCode ? `-${report.channelCode}` : '';
  return `acc-message-usage${channel}-${first}-to-${last}.csv`;
}
