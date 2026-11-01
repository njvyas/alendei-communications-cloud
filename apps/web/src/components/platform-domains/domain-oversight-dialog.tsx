'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { DomainStatusBadge, DomainTypeBadge } from '@/components/domains/domain-status-badge';
import { useModalDialog } from '@/components/ui/dialog';
import { StatusDot } from '@/components/ui/status-dot';
import { ApiError, domainsApi } from '@/lib/api-client';
import {
  HISTORY_ACTION_LABELS,
  PROPAGATION_LABELS,
  PROPAGATION_TONES,
  canAttemptVerification,
  platformDomainsApi,
  relativeExpiry,
  useCanManagePlatformDomains,
  useCanReadPlatformDomainHistory,
  type DomainDnsDiagnostics,
  type PlatformDomainView,
} from '@/lib/platform-domains';
import { toast } from '@/lib/toast';
import { ChallengeBadge, TONE_TO_STATUS } from './challenge-badge';

type PendingAction = 'suspend' | 'activate' | 'verify' | null;

const ACTION_COPY: Record<Exclude<PendingAction, null>, { title: string; body: string }> = {
  suspend: {
    title: 'Suspend this domain?',
    body: 'The hostname stops resolving to the organization’s console immediately. The organization keeps its other domains.',
  },
  activate: {
    title: 'Activate this domain?',
    body: 'The hostname resolves to the organization’s console again once its ownership is verified.',
  },
  verify: {
    title: 'Run ownership verification now?',
    body: 'This runs the same DNS check as the organization’s own Verify button. If the record is not found, the failure is recorded on the domain. Run the DNS diagnostics first if unsure.',
  },
};

function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : 'The request failed. Try again.';
}

export function DomainOversightDialog({
  domain,
  onClose,
}: {
  readonly domain: PlatformDomainView | null;
  readonly onClose: () => void;
}) {
  const open = domain !== null;
  const modal = useModalDialog(open);
  const queryClient = useQueryClient();
  const canManage = useCanManagePlatformDomains();
  const canReadHistory = useCanReadPlatformDomainHistory();
  const [pending, setPending] = useState<PendingAction>(null);
  const [reason, setReason] = useState('');
  const [runDiagnostics, setRunDiagnostics] = useState(0);

  const domainId = domain?.id ?? '';
  const current = useQuery({
    queryKey: ['platform-domains', 'detail', domainId],
    queryFn: ({ signal }) => platformDomainsApi.get(domainId, signal),
    enabled: open,
    initialData: domain ? { data: domain } : undefined,
  });
  const diagnostics = useQuery({
    queryKey: ['platform-domains', 'diagnostics', domainId, runDiagnostics],
    queryFn: ({ signal }) => platformDomainsApi.diagnostics(domainId, signal),
    enabled: open && runDiagnostics > 0,
    staleTime: Infinity,
  });
  const history = useQuery({
    queryKey: ['platform-domains', 'history', domainId],
    queryFn: ({ signal }) => platformDomainsApi.history(domainId, signal),
    enabled: open && canReadHistory,
  });

  const action = useMutation({
    mutationFn: async (kind: Exclude<PendingAction, null>) => {
      const d = current.data?.data ?? domain!;
      if (kind === 'suspend') return domainsApi.suspend(d.organization.id, d.id, { reason });
      if (kind === 'activate') return domainsApi.activate(d.organization.id, d.id);
      return domainsApi.verify(d.organization.id, d.id);
    },
    onSuccess: (_result, kind) => {
      toast.success(
        kind === 'suspend'
          ? 'Domain suspended'
          : kind === 'activate'
            ? 'Domain activated'
            : 'Ownership verified',
      );
      setPending(null);
      setReason('');
    },
    onError: (error) => toast.error('Action not completed', errorText(error)),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['platform-domains'] });
    },
  });

  if (!open || !domain) return null;
  const d = current.data?.data ?? domain;
  const close = () => {
    setPending(null);
    setReason('');
    setRunDiagnostics(0);
    onClose();
  };
  const diag = diagnostics.data?.data;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="domain-oversight-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs focus:outline-none"
      {...modal.overlayProps(close, !action.isPending)}
    >
      <div
        ref={modal.panelRef}
        tabIndex={-1}
        className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 text-[var(--color-ink)] shadow-xl space-y-5"
        data-testid="domain-oversight-dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--color-border-subtle)] pb-4">
          <div className="space-y-1">
            <h2 id="domain-oversight-title" className="font-mono text-base font-bold">
              {d.domain}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <DomainTypeBadge type={d.domainType} />
              <DomainStatusBadge status={d.status} isPrimary={d.isPrimary} />
              <ChallengeBadge state={d.challenge.state} />
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            disabled={action.isPending}
            className="rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-xs"
          >
            Close
          </button>
        </div>

        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-[var(--color-ink-muted)]">Organization</dt>
            <dd>
              {d.organization.name}{' '}
              <span className="text-[var(--color-ink-muted)]">({d.organization.status})</span>
            </dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-muted)]">Reseller</dt>
            <dd>
              {d.reseller
                ? d.reseller.isPlatformDefault
                  ? 'Direct (platform)'
                  : d.reseller.name
                : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-muted)]">Verification method</dt>
            <dd>
              {d.verificationMethod === 'platform_subdomain'
                ? 'Platform subdomain (by convention)'
                : `DNS TXT at _alendei-challenge.${d.domain}`}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-muted)]">Verified</dt>
            <dd>{d.verifiedAt ? new Date(d.verifiedAt).toLocaleString('en-IN') : 'Not yet'}</dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-muted)]">Challenge expiry</dt>
            <dd>
              {d.challenge.expiresAt
                ? `${new Date(d.challenge.expiresAt).toLocaleString('en-IN')} (${relativeExpiry(d.challenge.expiresAt)})`
                : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-muted)]">Registered</dt>
            <dd>{new Date(d.createdAt).toLocaleString('en-IN')}</dd>
          </div>
        </dl>

        <p className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 text-[11px] text-[var(--color-ink-muted)]">
          The challenge value is not shown here. The organization reads it in its own domain
          settings. Status reflects ownership verification only: ACC does not provision ingress
          routing or TLS certificates for custom domains.
        </p>

        {d.challenge.state === 'expired' && (
          <p
            role="note"
            className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300"
          >
            This challenge has expired. Verification is refused until the organization regenerates
            the challenge in its domain settings and sets the new TXT value in DNS.
          </p>
        )}

        <section aria-labelledby="dns-diagnostics-heading" className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 id="dns-diagnostics-heading" className="text-sm font-semibold">
              DNS propagation
            </h3>
            <button
              type="button"
              onClick={() => setRunDiagnostics((n) => n + 1)}
              disabled={diagnostics.isFetching}
              className="rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] font-medium hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
              data-testid="run-diagnostics"
            >
              {diagnostics.isFetching
                ? 'Checking…'
                : runDiagnostics > 0
                  ? 'Check again'
                  : 'Check DNS'}
            </button>
          </div>
          <div aria-live="polite" data-testid="diagnostics-result">
            {diagnostics.error && (
              <p role="alert" className="text-xs text-rose-400">
                {errorText(diagnostics.error)}
              </p>
            )}
            {diag && <DiagnosticsResult diag={diag} />}
          </div>
        </section>

        {canManage && (
          <section aria-labelledby="domain-actions-heading" className="space-y-2">
            <h3 id="domain-actions-heading" className="text-sm font-semibold">
              Actions
            </h3>
            {pending === null ? (
              <div className="flex flex-wrap gap-2">
                {canAttemptVerification(d) && (
                  <button
                    type="button"
                    onClick={() => setPending('verify')}
                    className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface-raised)]"
                    data-testid="action-verify"
                  >
                    Run verification
                  </button>
                )}
                {d.status === 'active' && (
                  <button
                    type="button"
                    onClick={() => setPending('suspend')}
                    className="rounded-md border border-rose-500/30 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/10"
                    data-testid="action-suspend"
                  >
                    Suspend
                  </button>
                )}
                {d.status === 'suspended' && (
                  <button
                    type="button"
                    onClick={() => setPending('activate')}
                    className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-surface-raised)]"
                    data-testid="action-activate"
                  >
                    Activate
                  </button>
                )}
              </div>
            ) : (
              <div
                className="space-y-2 rounded-md border border-[var(--color-border-subtle)] p-3"
                data-testid="action-confirm"
              >
                <p className="text-xs font-semibold">{ACTION_COPY[pending].title}</p>
                <p className="text-xs text-[var(--color-ink-muted)]">{ACTION_COPY[pending].body}</p>
                {pending === 'suspend' && (
                  <label
                    htmlFor="suspend-reason"
                    className="flex flex-col gap-1 text-[11px] text-[var(--color-ink-muted)]"
                  >
                    Reason (recorded in the audit log)
                    <input
                      id="suspend-reason"
                      value={reason}
                      maxLength={500}
                      onChange={(e) => setReason(e.target.value)}
                      className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1.5 text-xs text-[var(--color-ink)]"
                      data-testid="suspend-reason"
                    />
                  </label>
                )}
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => action.mutate(pending)}
                    disabled={action.isPending || (pending === 'suspend' && !reason.trim())}
                    className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                    data-testid="action-confirm-btn"
                  >
                    {action.isPending ? 'Working…' : 'Confirm'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPending(null)}
                    disabled={action.isPending}
                    className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </section>
        )}

        {canReadHistory && (
          <section aria-labelledby="domain-history-heading" className="space-y-2">
            <h3 id="domain-history-heading" className="text-sm font-semibold">
              Lifecycle history
            </h3>
            {history.isLoading && (
              <p className="text-xs text-[var(--color-ink-muted)]">Loading history…</p>
            )}
            {history.error && (
              <p role="alert" className="text-xs text-rose-400">
                {errorText(history.error)}
              </p>
            )}
            {history.data && history.data.data.length === 0 && (
              <p className="text-xs text-[var(--color-ink-muted)]" data-testid="history-empty">
                No lifecycle events recorded for this domain.
              </p>
            )}
            {history.data && history.data.data.length > 0 && (
              <ol className="space-y-1 text-xs" data-testid="history-list">
                {history.data.data.map((e) => (
                  <li key={e.id} className="flex flex-wrap gap-x-2">
                    <time dateTime={e.occurredAt} className="text-[var(--color-ink-muted)]">
                      {new Date(e.occurredAt).toLocaleString('en-IN')}
                    </time>
                    <span className="font-medium">
                      {HISTORY_ACTION_LABELS[e.action] ?? e.action}
                    </span>
                    {e.fromStatus !== e.toStatus && (e.fromStatus || e.toStatus) && (
                      <span className="text-[var(--color-ink-muted)]">
                        {e.fromStatus ?? '—'} → {e.toStatus ?? '—'}
                      </span>
                    )}
                    {e.outcome !== 'success' && (
                      <span className="text-amber-400">({e.outcome})</span>
                    )}
                    {e.reason && (
                      <span className="text-[var(--color-ink-muted)]">“{e.reason}”</span>
                    )}
                    <span className="text-[var(--color-ink-muted)]">by {e.actorType}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

/** The outcome of one diagnostics run. Values found in DNS are never shown. */
export function DiagnosticsResult({ diag }: { readonly diag: DomainDnsDiagnostics }) {
  return (
    <div className="space-y-2">
      <p className="text-xs">
        <StatusDot
          tone={TONE_TO_STATUS[PROPAGATION_TONES[diag.propagation]]}
          label={PROPAGATION_LABELS[diag.propagation]}
        />
      </p>
      <p className="text-xs text-[var(--color-ink-muted)]">{diag.guidance}</p>
      {diag.results.length > 0 && (
        <table className="w-full text-left text-xs">
          <caption className="sr-only">TXT lookup of {diag.challengeHost} by resolver</caption>
          <thead className="text-[11px] text-[var(--color-ink-muted)]">
            <tr>
              <th scope="col" className="py-1 font-medium">
                Resolver
              </th>
              <th scope="col" className="py-1 font-medium">
                Result
              </th>
              <th scope="col" className="py-1 font-medium">
                TXT records
              </th>
              <th scope="col" className="py-1 font-medium">
                Time
              </th>
            </tr>
          </thead>
          <tbody>
            {diag.results.map((r) => (
              <tr key={r.resolver} className="border-t border-[var(--color-border-subtle)]">
                <th scope="row" className="py-1 font-normal">
                  {r.resolver}
                </th>
                <td className="py-1">
                  {r.outcome === 'match'
                    ? 'Expected value found'
                    : r.outcome === 'mismatch'
                      ? 'Different value'
                      : r.outcome === 'not_found'
                        ? 'No record'
                        : r.outcome === 'timeout'
                          ? 'Timed out'
                          : `Error${r.errorCode ? ` (${r.errorCode})` : ''}`}
                </td>
                <td className="py-1">{r.recordCount}</td>
                <td className="py-1">{r.durationMs} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-[11px] text-[var(--color-ink-muted)]">
        Checked {new Date(diag.checkedAt).toLocaleString('en-IN')}. Read-only: nothing about the
        domain changed.
      </p>
    </div>
  );
}
