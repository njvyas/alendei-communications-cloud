'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { domainsApi, type DomainView } from '@/lib/api-client';
import { DomainStatusBadge, DomainTypeBadge } from './domain-status-badge';
import { DomainCreateDialog } from './domain-create-dialog';
import { DomainVerificationDialog } from './domain-verification-dialog';
import { toast } from '@/lib/toast';

interface DomainListCardProps {
  readonly orgId: string;
  readonly isPlatformAdmin?: boolean;
  readonly canManage?: boolean;
}

export function DomainListCard({
  orgId,
  isPlatformAdmin = false,
  canManage = true,
}: DomainListCardProps) {
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [verificationDomain, setVerificationDomain] = useState<DomainView | null>(null);
  const [actionInProgressId, setActionInProgressId] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['organizations', orgId, 'domains'],
    queryFn: ({ signal }) => domainsApi.list(orgId, signal),
    enabled: !!orgId,
  });

  const domains = data?.data ?? [];

  const handleSetPrimary = async (domain: DomainView) => {
    setActionInProgressId(domain.id);
    try {
      await domainsApi.setPrimary(orgId, domain.id);
      toast.success(`${domain.domain} set as primary domain`);
      void refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to set primary domain');
    } finally {
      setActionInProgressId(null);
    }
  };

  const handleToggleSuspend = async (domain: DomainView) => {
    setActionInProgressId(domain.id);
    try {
      if (domain.status === 'suspended') {
        await domainsApi.activate(orgId, domain.id);
        toast.success(`Domain ${domain.domain} activated`);
      } else {
        await domainsApi.suspend(orgId, domain.id, { reason: 'Administrative suspension' });
        toast.success(`Domain ${domain.domain} suspended`);
      }
      void refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update domain status');
    } finally {
      setActionInProgressId(null);
    }
  };

  const handleRemove = async (domain: DomainView) => {
    if (
      !window.confirm(
        `Are you sure you want to remove ${domain.domain}? Hostname routing will cease immediately.`,
      )
    ) {
      return;
    }
    setActionInProgressId(domain.id);
    try {
      await domainsApi.remove(orgId, domain.id);
      toast.success(`Domain ${domain.domain} removed`);
      void refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove domain');
    } finally {
      setActionInProgressId(null);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-[var(--color-ink)]">Domains & Hostnames</h2>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Manage platform subdomains (*.alendei.io) and custom white-label hostnames.
          </p>
        </div>

        {canManage && (
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            + Add Domain
          </button>
        )}
      </div>

      {isLoading ? (
        <div role="status" className="flex items-center justify-center py-8">
          <div className="size-4 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
          <span className="ml-2 text-xs text-[var(--color-ink-muted)]">
            Loading organization domains…
          </span>
        </div>
      ) : error ? (
        <div
          role="alert"
          className="mt-4 rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]"
        >
          Failed to load domains: {error instanceof Error ? error.message : 'Unknown error'}
        </div>
      ) : domains.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-[var(--color-border-subtle)] p-6 text-center text-xs text-[var(--color-ink-muted)]">
          <p>No domains mapped to this organization yet.</p>
          <p className="mt-1 text-[11px]">
            Direct and reseller customers can map a platform subdomain or bring custom hostnames.
          </p>
        </div>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--color-border-subtle)] text-[11px] font-medium text-[var(--color-ink-muted)]">
                <th scope="col" className="pb-2 font-normal">
                  Domain
                </th>
                <th scope="col" className="pb-2 font-normal">
                  Type
                </th>
                <th scope="col" className="pb-2 font-normal">
                  Status
                </th>
                <th scope="col" className="pb-2 font-normal">
                  Verified
                </th>
                <th scope="col" className="pb-2 text-right font-normal">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-subtle)]">
              {domains.map((d) => (
                <tr key={d.id} className="hover:bg-[var(--color-surface-raised)]/50">
                  <td className="py-2.5 font-mono font-medium text-[var(--color-ink)]">
                    {d.domain}
                  </td>
                  <td className="py-2.5">
                    <DomainTypeBadge type={d.domainType} />
                  </td>
                  <td className="py-2.5">
                    <DomainStatusBadge status={d.status} isPrimary={d.isPrimary} />
                  </td>
                  <td className="py-2.5 text-[11px] text-[var(--color-ink-muted)]">
                    {d.verifiedAt ? (
                      new Date(d.verifiedAt).toLocaleDateString()
                    ) : (
                      <span className="italic">—</span>
                    )}
                  </td>
                  <td className="py-2.5 text-right">
                    <div className="inline-flex items-center gap-2">
                      {d.status === 'pending_verification' && canManage && (
                        <button
                          type="button"
                          onClick={() => setVerificationDomain(d)}
                          className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-400 hover:bg-amber-500/20"
                        >
                          DNS Setup & Verify
                        </button>
                      )}

                      {d.status === 'active' && !d.isPrimary && canManage && (
                        <button
                          type="button"
                          onClick={() => handleSetPrimary(d)}
                          disabled={actionInProgressId === d.id}
                          className="rounded border border-[var(--color-border-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
                        >
                          Make Primary
                        </button>
                      )}

                      {isPlatformAdmin && (
                        <button
                          type="button"
                          onClick={() => handleToggleSuspend(d)}
                          disabled={actionInProgressId === d.id}
                          className="rounded border border-[var(--color-border-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] disabled:opacity-50"
                        >
                          {d.status === 'suspended' ? 'Activate' : 'Suspend'}
                        </button>
                      )}

                      {canManage && (
                        <button
                          type="button"
                          onClick={() => handleRemove(d)}
                          disabled={actionInProgressId === d.id}
                          className="rounded border border-red-500/20 px-2 py-0.5 text-[11px] font-medium text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Register Domain Modal */}
      <DomainCreateDialog
        isOpen={isCreateOpen}
        orgId={orgId}
        onClose={() => setIsCreateOpen(false)}
        onSuccess={() => {
          void refetch();
        }}
      />

      {/* DNS Verification Modal */}
      <DomainVerificationDialog
        isOpen={!!verificationDomain}
        orgId={orgId}
        domain={verificationDomain}
        onClose={() => setVerificationDomain(null)}
        onSuccess={() => {
          void refetch();
        }}
      />
    </div>
  );
}
