'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { ApiError } from '@/lib/api-client';
import { formatFailureReason } from '@/lib/failure-reasons';
import {
  USAGE_CHANNELS,
  formatRate,
  periodFor,
  presetPeriod,
  usageApi,
  usageCsv,
  usageCsvFileName,
  type MessageUsageReportResponse,
  type UsageChannel,
} from '@/lib/usage-report';

const PRESETS = [7, 30, 90] as const;
const CHANNEL_LABELS: Record<string, string> = { whatsapp: 'WhatsApp', sms: 'SMS', rcs: 'RCS' };
const channelLabel = (code: string) => CHANNEL_LABELS[code] ?? code.toUpperCase();

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const number = new Intl.NumberFormat('en-IN');

function downloadCsv(report: MessageUsageReportResponse) {
  const blob = new Blob([usageCsv(report)], { type: 'text/csv;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = usageCsvFileName(report);
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}

const card =
  'rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4 shadow-xs';
const th = 'px-3 py-2 text-left font-medium';
const td = 'px-3 py-2 tabular-nums';

export interface MessageUsageReportProps {
  readonly orgId: string;
}

/** Organization message usage: totals, channel and daily breakdown, failure reasons, CSV export. */
export function MessageUsageReport({ orgId }: MessageUsageReportProps) {
  const zones = useMemo(() => Array.from(new Set(['Asia/Kolkata', 'UTC', browserTimeZone()])), []);
  const [timeZone, setTimeZone] = useState('Asia/Kolkata');
  const [preset, setPreset] = useState<number | null>(30);
  const initial = presetPeriod(30, 'Asia/Kolkata');
  const [fromDay, setFromDay] = useState(initial.fromDay);
  const [toDay, setToDay] = useState(initial.toDay);
  const [channel, setChannel] = useState<UsageChannel | 'all'>('all');

  const choosePreset = (days: number, zone = timeZone) => {
    const p = presetPeriod(days, zone);
    setPreset(days);
    setFromDay(p.fromDay);
    setToDay(p.toDay);
  };

  const period = periodFor(fromDay, toDay, timeZone);
  const params =
    'error' in period
      ? null
      : {
          ...period,
          timeZone,
          channelCode: channel === 'all' ? undefined : channel,
        };

  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ['usage', 'messages', orgId, params],
    queryFn: ({ signal }) => usageApi.messages(params!, signal),
    enabled: params !== null,
    retry: false,
  });
  const report = data?.data;

  return (
    <div className="space-y-4">
      <section className={card} aria-labelledby="usage-filters-heading">
        <h2 id="usage-filters-heading" className="sr-only">
          Report period and filters
        </h2>
        <div className="flex flex-wrap items-end gap-3 text-xs">
          <div role="group" aria-label="Quick period" className="flex gap-1">
            {PRESETS.map((days) => (
              <button
                key={days}
                type="button"
                aria-pressed={preset === days}
                onClick={() => choosePreset(days)}
                className={`rounded-md border px-2.5 py-1.5 font-medium transition-colors ${
                  preset === days
                    ? 'border-emerald-600 bg-emerald-600 text-white'
                    : 'border-[var(--color-border-subtle)] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]'
                }`}
                data-testid={`usage-preset-${days}`}
              >
                Last {days} days
              </button>
            ))}
          </div>
          <label className="flex flex-col gap-1 text-[var(--color-ink-muted)]">
            From
            <input
              type="date"
              value={fromDay}
              onChange={(e) => {
                setPreset(null);
                setFromDay(e.target.value);
              }}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-[var(--color-ink)]"
              data-testid="usage-from"
            />
          </label>
          <label className="flex flex-col gap-1 text-[var(--color-ink-muted)]">
            To
            <input
              type="date"
              value={toDay}
              onChange={(e) => {
                setPreset(null);
                setToDay(e.target.value);
              }}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-[var(--color-ink)]"
              data-testid="usage-to"
            />
          </label>
          <label className="flex flex-col gap-1 text-[var(--color-ink-muted)]">
            Channel
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value as UsageChannel | 'all')}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-[var(--color-ink)]"
              data-testid="usage-channel"
            >
              <option value="all">All channels</option>
              {USAGE_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {channelLabel(c)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[var(--color-ink-muted)]">
            Time zone
            <select
              value={timeZone}
              onChange={(e) => {
                setTimeZone(e.target.value);
                if (preset !== null) choosePreset(preset, e.target.value);
              }}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-[var(--color-ink)]"
              data-testid="usage-timezone"
            >
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={!report}
            onClick={() => report && downloadCsv(report)}
            className="ml-auto rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
            data-testid="usage-export"
          >
            Export CSV
          </button>
        </div>
        {'error' in period && (
          <p role="alert" className="mt-2 text-xs text-rose-400">
            {period.error}
          </p>
        )}
      </section>

      <div aria-live="polite" className="sr-only">
        {isFetching ? 'Loading usage report' : report ? 'Usage report updated' : ''}
      </div>

      {error && (
        <div role="alert" className={`${card} text-xs text-rose-400`} data-testid="usage-error">
          {error instanceof ApiError && error.status === 403
            ? 'You do not have permission to view message usage for this organization.'
            : 'The usage report could not be loaded. Try again, or choose a shorter period.'}
        </div>
      )}

      {isLoading && params && (
        <div className={`${card} text-xs text-[var(--color-ink-muted)]`} role="status">
          Loading usage report…
        </div>
      )}

      {report && <ReportBody report={report} />}
    </div>
  );
}

function ReportBody({ report }: { readonly report: MessageUsageReportResponse }) {
  const t = report.totals;
  const tiles = [
    { label: 'Messages', value: number.format(t.total) },
    { label: 'Accepted by provider', value: number.format(t.accepted) },
    { label: 'Failed', value: number.format(t.failed) },
    { label: 'Outcome unknown', value: number.format(t.outcomeUnknown) },
    { label: 'In progress', value: number.format(t.pending) },
    { label: 'Acceptance rate', value: formatRate(report.acceptanceRate) },
  ];
  const peak = Math.max(1, ...report.byDay.map((d) => d.total));

  return (
    <div className="space-y-4" data-testid="usage-report">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {tiles.map((tile) => (
          <div key={tile.label} className={card}>
            <dt className="text-[11px] text-[var(--color-ink-muted)]">{tile.label}</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums text-[var(--color-ink)]">
              {tile.value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-[11px] text-[var(--color-ink-muted)]">
        &ldquo;Accepted by provider&rdquo; means a provider accepted the message for sending; it is
        not a handset receipt. The acceptance rate excludes messages still in progress.
      </p>

      {t.total === 0 ? (
        <div className={`${card} text-center text-xs text-[var(--color-ink-muted)]`}>
          No messages were created in this period.
        </div>
      ) : (
        <>
          <section className={card} aria-labelledby="usage-channel-heading">
            <h2 id="usage-channel-heading" className="mb-2 text-sm font-semibold">
              By channel
            </h2>
            <UsageTable
              caption="Messages by channel"
              firstColumn="Channel"
              rows={report.byChannel.map((r) => ({
                key: r.channelCode,
                label: channelLabel(r.channelCode),
                ...r,
              }))}
            />
          </section>

          <section className={card} aria-labelledby="usage-day-heading">
            <h2 id="usage-day-heading" className="mb-2 text-sm font-semibold">
              By day ({report.timeZone})
            </h2>
            <UsageTable
              caption="Messages by day and channel"
              firstColumn="Day"
              secondColumn="Channel"
              rows={report.byDay.map((r) => ({
                key: `${r.day}-${r.channelCode}`,
                label: r.day,
                second: channelLabel(r.channelCode),
                bar: r.total / peak,
                ...r,
              }))}
            />
          </section>

          <section className={card} aria-labelledby="usage-failure-heading">
            <h2 id="usage-failure-heading" className="mb-2 text-sm font-semibold">
              Top failure reasons
            </h2>
            {report.topFailureReasons.length === 0 ? (
              <p className="text-xs text-[var(--color-ink-muted)]">No failed messages.</p>
            ) : (
              <ul className="space-y-1 text-xs" data-testid="usage-failure-reasons">
                {report.topFailureReasons.map((r) => (
                  <li key={r.reason} className="flex justify-between gap-4">
                    <span title={r.reason}>
                      {r.reason === 'OTHER'
                        ? 'Other (unclassified reason)'
                        : (formatFailureReason(r.reason)?.title ?? r.reason)}
                    </span>
                    <span className="tabular-nums">{number.format(r.count)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

interface UsageTableRow {
  readonly key: string;
  readonly label: string;
  readonly second?: string;
  readonly bar?: number;
  readonly total: number;
  readonly accepted: number;
  readonly failed: number;
  readonly outcomeUnknown: number;
  readonly pending: number;
}

function UsageTable({
  caption,
  firstColumn,
  secondColumn,
  rows,
}: {
  readonly caption: string;
  readonly firstColumn: string;
  readonly secondColumn?: string;
  readonly rows: readonly UsageTableRow[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-[var(--color-border-subtle)] text-[var(--color-ink-muted)]">
          <tr>
            <th scope="col" className={th}>
              {firstColumn}
            </th>
            {secondColumn && (
              <th scope="col" className={th}>
                {secondColumn}
              </th>
            )}
            <th scope="col" className={`${th} text-right`}>
              Total
            </th>
            <th scope="col" className={`${th} text-right`}>
              Accepted
            </th>
            <th scope="col" className={`${th} text-right`}>
              Failed
            </th>
            <th scope="col" className={`${th} text-right`}>
              Unknown
            </th>
            <th scope="col" className={`${th} text-right`}>
              In progress
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-[var(--color-border-subtle)] last:border-0">
              <th scope="row" className={`${th} text-[var(--color-ink)]`}>
                {r.label}
              </th>
              {secondColumn && <td className={td}>{r.second}</td>}
              <td className={`${td} text-right`}>
                <span className="inline-flex items-center justify-end gap-2">
                  {r.bar !== undefined && (
                    <span
                      aria-hidden="true"
                      className="inline-block h-1.5 rounded-full bg-emerald-500/60"
                      style={{ width: `${Math.max(2, Math.round(r.bar * 64))}px` }}
                    />
                  )}
                  {number.format(r.total)}
                </span>
              </td>
              <td className={`${td} text-right`}>{number.format(r.accepted)}</td>
              <td className={`${td} text-right`}>{number.format(r.failed)}</td>
              <td className={`${td} text-right`}>{number.format(r.outcomeUnknown)}</td>
              <td className={`${td} text-right`}>{number.format(r.pending)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
