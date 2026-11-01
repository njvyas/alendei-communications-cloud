'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { DomainStatusBadge, DomainTypeBadge } from '@/components/domains/domain-status-badge';
import { ApiError } from '@/lib/api-client';
import {
  CHALLENGE_STATE_LABELS,
  DOMAIN_SEARCH_PATTERN,
  DOMAIN_STATUS_LABELS,
  platformDomainsApi,
  relativeExpiry,
  type DomainChallengeState,
  type PlatformDomainFilter,
  type PlatformDomainView,
} from '@/lib/platform-domains';
import { ChallengeBadge } from './challenge-badge';
import { DomainOversightDialog } from './domain-oversight-dialog';

const PAGE_SIZE = 25;

/** Quick filters shown as summary tiles; each narrows the table to one state. */
const ATTENTION_TILES: ReadonlyArray<{
  readonly state: DomainChallengeState;
  readonly label: string;
  readonly hint: string;
}> = [
  { state: 'expired', label: 'Expired challenges', hint: 'Organization must regenerate' },
  { state: 'expiring_soon', label: 'Expiring within 24 h', hint: 'DNS record not yet verified' },
  { state: 'failed', label: 'Failed checks', hint: 'Record missing or wrong' },
  { state: 'pending', label: 'Awaiting DNS record', hint: 'Within the 72-hour window' },
];

const selectClass =
  'rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1.5 text-xs text-[var(--color-ink)]';

export function DomainRegistry() {
  const [status, setStatus] = useState('');
  const [domainType, setDomainType] = useState('');
  const [challengeState, setChallengeState] = useState('');
  const [search, setSearch] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<PlatformDomainView | null>(null);

  const searchValid = DOMAIN_SEARCH_PATTERN.test(search);
  const filter: PlatformDomainFilter = {
    status: (status || undefined) as PlatformDomainFilter['status'],
    domainType: (domainType || undefined) as PlatformDomainFilter['domainType'],
    challengeState: (challengeState || undefined) as PlatformDomainFilter['challengeState'],
    q: searchValid && search.trim() ? search.trim() : undefined,
    cursor: cursors.at(-1),
    limit: PAGE_SIZE,
  };

  const summary = useQuery({
    queryKey: ['platform-domains', 'summary'],
    queryFn: ({ signal }) => platformDomainsApi.summary(signal),
    refetchInterval: 60_000,
  });
  const list = useQuery({
    queryKey: ['platform-domains', 'list', filter],
    queryFn: ({ signal }) => platformDomainsApi.list(filter, signal),
    enabled: searchValid,
  });

  const resetPaging = () => setCursors([]);
  const s = summary.data?.data;
  const rows = list.data?.data ?? [];
  const page = list.data?.page;
  const listError = list.error instanceof ApiError ? list.error.message : null;

  return (
    <div className="space-y-6" data-testid="domain-registry">
      <section aria-labelledby="domain-health-heading" className="space-y-3">
        <h2 id="domain-health-heading" className="text-sm font-semibold text-[var(--color-ink)]">
          Registry health
        </h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3">
            <p className="text-[11px] text-[var(--color-ink-muted)]">Domains</p>
            <p
              className="text-lg font-semibold text-[var(--color-ink)]"
              data-testid="summary-total"
            >
              {s ? s.total.toLocaleString('en-IN') : '—'}
            </p>
            <p className="text-[11px] text-[var(--color-ink-muted)]">
              {s ? `${s.byStatus.active} active · ${s.byStatus.suspended} suspended` : ' '}
            </p>
          </div>
          <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3">
            <p className="text-[11px] text-[var(--color-ink-muted)]">Needs attention</p>
            <p
              className="text-lg font-semibold text-[var(--color-ink)]"
              data-testid="summary-attention"
            >
              {s ? s.needsAttention.toLocaleString('en-IN') : '—'}
            </p>
            <p className="text-[11px] text-[var(--color-ink-muted)]">Expired, expiring or failed</p>
          </div>
          {ATTENTION_TILES.map((tile) => {
            const active = challengeState === tile.state;
            return (
              <button
                key={tile.state}
                type="button"
                aria-pressed={active}
                data-testid={`summary-tile-${tile.state}`}
                onClick={() => {
                  setChallengeState(active ? '' : tile.state);
                  resetPaging();
                }}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  active
                    ? 'border-[var(--color-accent)] bg-[var(--color-surface-raised)]'
                    : 'border-[var(--color-border-subtle)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-raised)]'
                }`}
              >
                <span className="block text-[11px] text-[var(--color-ink-muted)]">
                  {tile.label}
                </span>
                <span className="block text-lg font-semibold text-[var(--color-ink)]">
                  {s ? s.byChallengeState[tile.state].toLocaleString('en-IN') : '—'}
                </span>
                <span className="block text-[11px] text-[var(--color-ink-muted)]">{tile.hint}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="domain-list-heading" className="space-y-3">
        <h2 id="domain-list-heading" className="text-sm font-semibold text-[var(--color-ink)]">
          All domains
        </h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-[11px] text-[var(--color-ink-muted)]">
            Hostname contains
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                resetPaging();
              }}
              aria-invalid={!searchValid}
              aria-describedby={searchValid ? undefined : 'domain-search-error'}
              placeholder="example.com"
              className={selectClass}
              data-testid="domain-search"
            />
            {!searchValid && (
              <span id="domain-search-error" role="alert" className="text-[11px] text-rose-400">
                Use letters, digits, dots and hyphens only.
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-[var(--color-ink-muted)]">
            Status
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                resetPaging();
              }}
              className={selectClass}
              data-testid="filter-status"
            >
              <option value="">All statuses</option>
              {Object.entries(DOMAIN_STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-[var(--color-ink-muted)]">
            Type
            <select
              value={domainType}
              onChange={(e) => {
                setDomainType(e.target.value);
                resetPaging();
              }}
              className={selectClass}
              data-testid="filter-type"
            >
              <option value="">All types</option>
              <option value="custom">Custom (white-label)</option>
              <option value="subdomain">Platform subdomain</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[11px] text-[var(--color-ink-muted)]">
            Challenge
            <select
              value={challengeState}
              onChange={(e) => {
                setChallengeState(e.target.value);
                resetPaging();
              }}
              className={selectClass}
              data-testid="filter-challenge"
            >
              <option value="">All challenge states</option>
              {Object.entries(CHALLENGE_STATE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => {
              void list.refetch();
              void summary.refetch();
            }}
            disabled={list.isFetching}
            className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
          >
            {list.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {listError && (
          <p role="alert" className="text-xs text-rose-400" data-testid="registry-error">
            {listError}
          </p>
        )}

        <div className="overflow-x-auto rounded-lg border border-[var(--color-border-subtle)]">
          <table className="w-full text-left text-xs" data-testid="domain-table">
            <caption className="sr-only">
              Organization domains across all tenants, with lifecycle and challenge status
            </caption>
            <thead className="bg-[var(--color-surface-raised)] text-[11px] text-[var(--color-ink-muted)]">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Domain
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Organization
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Reseller
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Challenge
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Challenge expiry
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.isLoading && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-[var(--color-ink-muted)]">
                    Loading domains…
                  </td>
                </tr>
              )}
              {!list.isLoading && rows.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    className="px-3 py-6 text-center text-[var(--color-ink-muted)]"
                    data-testid="domain-table-empty"
                  >
                    No domains match these filters.
                  </td>
                </tr>
              )}
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-t border-[var(--color-border-subtle)]"
                  data-testid="domain-row"
                >
                  <th
                    scope="row"
                    className="px-3 py-2 font-mono font-normal text-[var(--color-ink)]"
                  >
                    <span className="mr-2">{row.domain}</span>
                    <DomainTypeBadge type={row.domainType} />
                  </th>
                  <td className="px-3 py-2 text-[var(--color-ink)]">
                    {row.organization.name}
                    {row.organization.status !== 'active' && (
                      <span className="ml-1 text-[11px] text-amber-400">
                        ({row.organization.status})
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-[var(--color-ink-muted)]">
                    {row.reseller
                      ? row.reseller.isPlatformDefault
                        ? 'Direct (platform)'
                        : row.reseller.name
                      : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <DomainStatusBadge status={row.status} isPrimary={row.isPrimary} />
                  </td>
                  <td className="px-3 py-2">
                    <ChallengeBadge state={row.challenge.state} />
                  </td>
                  <td className="px-3 py-2 text-[var(--color-ink-muted)]">
                    {row.challenge.expiresAt ? (
                      <time dateTime={row.challenge.expiresAt}>
                        {relativeExpiry(row.challenge.expiresAt)}
                      </time>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => setSelected(row)}
                      className="rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                      aria-label={`Open oversight for ${row.domain}`}
                    >
                      Details
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={cursors.length === 0}
            onClick={() => setCursors((c) => c.slice(0, -1))}
            className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1 text-xs disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            disabled={!page?.nextCursor}
            onClick={() => page?.nextCursor && setCursors((c) => [...c, page.nextCursor!])}
            className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1 text-xs disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </section>

      <DomainOversightDialog domain={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
