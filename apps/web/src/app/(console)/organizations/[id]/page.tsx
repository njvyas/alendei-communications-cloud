'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ApiError, organizationsApi, type OrganizationStatus } from '@/lib/api-client';
import { useCanManagePlatformTenants, useCanReadOrganizations, useSession } from '@/lib/session-store';
import { StatusDot, type StatusTone } from '@/components/ui/status-dot';
import { OrganizationEditDialog } from '@/components/organizations/organization-edit-dialog';
import { OrganizationTransitionDialog, type OrganizationLifecycleAction } from '@/components/organizations/organization-transition-dialog';

const STATUS_TONES: Record<OrganizationStatus, StatusTone> = {
  active: 'ok',
  suspended: 'warn',
  closed: 'bad',
};

export default function OrganizationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const canReadOrganizations = useCanReadOrganizations();
  const canManagePlatformTenants = useCanManagePlatformTenants();
  const isPlatformAdmin = useSession((state) => state.authorization?.isPlatformAdmin ?? false);

  const [isEditOpen, setIsEditOpen] = useState(false);
  const [transitionAction, setTransitionAction] = useState<OrganizationLifecycleAction | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['organizations', 'detail', id],
    queryFn: ({ signal }) => organizationsApi.get(id, signal),
    enabled: canReadOrganizations && !!id,
  });

  const org = data?.data;

  // Permission evaluation for update:
  // Allowed if platform admin or holding organizations.update
  const userGrants = useSession((state) => state.authorization?.grants ?? []);
  const canUpdate =
    isPlatformAdmin ||
    userGrants.some(
      (g) =>
        (g.scopeType === 'platform' && g.permissions.includes('organizations.update')) ||
        (g.scopeType === 'organization' &&
          (g.scopeId === id || g.orgId === id) &&
          g.permissions.includes('organizations.update')),
    );

  const canTransition = isPlatformAdmin || canManagePlatformTenants;

  if (!canReadOrganizations) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center">
        <p className="text-base font-semibold text-[var(--color-bad)]">Access Forbidden</p>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          You do not hold permission to view this organization.
        </p>
        <Link
          href="/organizations"
          className="mt-4 inline-block rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
        >
          ← Back to Organizations
        </Link>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-12">
        <div className="flex items-center gap-3">
          <div className="size-4 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
          <p className="text-sm text-[var(--color-ink-muted)]">Loading organization details…</p>
        </div>
      </div>
    );
  }

  if (error) {
    const isNotFound = error instanceof ApiError && error.status === 404;
    const isForbidden = error instanceof ApiError && error.status === 403;

    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center">
        <p className="text-base font-semibold text-[var(--color-bad)]">
          {isNotFound ? 'Organization Not Found' : isForbidden ? 'Access Forbidden' : 'Failed to Load Organization'}
        </p>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          {isNotFound
            ? 'The requested organization does not exist or is outside your administrative reach.'
            : isForbidden
            ? 'You do not have permission to access this organization.'
            : error instanceof ApiError
            ? error.message
            : 'An unexpected error occurred.'}
        </p>
        <div className="mt-4 flex justify-center gap-3">
          <Link
            href="/organizations"
            className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
          >
            ← Back to Organizations
          </Link>
          {!isNotFound && !isForbidden && (
            <button
              type="button"
              onClick={() => refetch()}
              className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!org) return null;

  return (
    <div className="space-y-6">
      {/* Breadcrumb Navigation */}
      <div className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
        <Link href="/organizations" className="hover:underline">
          Organizations
        </Link>
        <span>/</span>
        <span className="font-mono text-[var(--color-ink)]">{org.slug}</span>
      </div>

      {/* Header and Actions */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border-subtle)] pb-6">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-[var(--color-ink)]">{org.name}</h1>
            <StatusDot tone={STATUS_TONES[org.status]} label={org.status} />
          </div>
          <p className="mt-1 font-mono text-xs text-[var(--color-ink-muted)]">ID: {org.id}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canUpdate && org.status === 'active' && (
            <button
              type="button"
              onClick={() => setIsEditOpen(true)}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
            >
              Edit Details
            </button>
          )}

          {canTransition && org.status === 'active' && (
            <>
              <button
                type="button"
                onClick={() => setTransitionAction('suspend')}
                className="rounded-md border border-[var(--color-warn)]/40 px-3 py-1.5 text-xs font-medium text-[var(--color-warn)] hover:bg-[var(--color-warn)]/10"
              >
                Suspend
              </button>
              <button
                type="button"
                onClick={() => setTransitionAction('close')}
                className="rounded-md border border-[var(--color-bad)]/40 px-3 py-1.5 text-xs font-medium text-[var(--color-bad)] hover:bg-[var(--color-bad)]/10"
              >
                Close
              </button>
            </>
          )}

          {canTransition && org.status === 'suspended' && (
            <>
              <button
                type="button"
                onClick={() => setTransitionAction('reactivate')}
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
              >
                Reactivate
              </button>
              <button
                type="button"
                onClick={() => setTransitionAction('close')}
                className="rounded-md border border-[var(--color-bad)]/40 px-3 py-1.5 text-xs font-medium text-[var(--color-bad)] hover:bg-[var(--color-bad)]/10"
              >
                Close
              </button>
            </>
          )}

          {org.status === 'closed' && (
            <span className="rounded-md border border-[var(--color-bad)]/30 bg-[var(--color-bad)]/10 px-3 py-1.5 text-xs font-medium text-[var(--color-bad)]">
              Closed (Terminal)
            </span>
          )}
        </div>
      </div>

      {/* Organization Lifecycle Alerts */}
      {org.status === 'closed' && (
        <div className="rounded-xl border border-[var(--color-bad)]/30 bg-[var(--color-bad)]/10 p-4 text-xs text-[var(--color-bad)]">
          <p className="font-semibold">Terminal Lifecycle State</p>
          <p className="mt-1 leading-relaxed">
            This organization is closed. Data is preserved for audit retention, but no further mutations or active operations can be executed.
          </p>
        </div>
      )}

      {org.status === 'suspended' && (
        <div className="rounded-xl border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10 p-4 text-xs text-[var(--color-warn)]">
          <p className="font-semibold">Suspended State</p>
          <p className="mt-1 leading-relaxed">
            This organization is suspended. Non-platform members cannot select this organization, and API keys are blocked from operation.
          </p>
        </div>
      )}

      {/* Details Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5">
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">Tenant Metadata</h2>
          <dl className="mt-4 divide-y divide-[var(--color-border-subtle)] text-xs">
            <div className="flex justify-between py-2.5">
              <dt className="text-[var(--color-ink-muted)]">Slug</dt>
              <dd className="font-mono text-[var(--color-ink)]">{org.slug}</dd>
            </div>
            <div className="flex justify-between py-2.5">
              <dt className="text-[var(--color-ink-muted)]">Legal Name</dt>
              <dd className="text-[var(--color-ink)]">{org.legalName ?? <span className="italic text-[var(--color-ink-muted)]">—</span>}</dd>
            </div>
            <div className="flex justify-between py-2.5">
              <dt className="text-[var(--color-ink-muted)]">GSTIN</dt>
              <dd className="font-mono text-[var(--color-ink)]">{org.gstin ?? <span className="italic text-[var(--color-ink-muted)]">—</span>}</dd>
            </div>
            <div className="flex justify-between py-2.5">
              <dt className="text-[var(--color-ink-muted)]">Reseller ID</dt>
              <dd className="font-mono text-[var(--color-ink)]">{org.resellerId}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5">
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">Billing & Lifecycle</h2>
          <dl className="mt-4 divide-y divide-[var(--color-border-subtle)] text-xs">
            <div className="flex justify-between py-2.5">
              <dt className="text-[var(--color-ink-muted)]">Billing Mode</dt>
              <dd className="capitalize text-[var(--color-ink)]">{org.billingMode}</dd>
            </div>
            <div className="flex justify-between py-2.5">
              <dt className="text-[var(--color-ink-muted)]">Billing Policy</dt>
              <dd className="text-[var(--color-ink)] font-mono text-[11px]">{org.billingPolicy}</dd>
            </div>
            <div className="flex justify-between py-2.5">
              <dt className="text-[var(--color-ink-muted)]">Status Changed At</dt>
              <dd className="text-[var(--color-ink)]">
                {org.statusChangedAt ? new Date(org.statusChangedAt).toLocaleString() : <span className="italic text-[var(--color-ink-muted)]">—</span>}
              </dd>
            </div>
            <div className="flex justify-between py-2.5">
              <dt className="text-[var(--color-ink-muted)]">Created At</dt>
              <dd className="text-[var(--color-ink)]">{new Date(org.createdAt).toLocaleString()}</dd>
            </div>
            <div className="flex justify-between py-2.5">
              <dt className="text-[var(--color-ink-muted)]">Updated At</dt>
              <dd className="text-[var(--color-ink)]">{new Date(org.updatedAt).toLocaleString()}</dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Edit Dialog */}
      <OrganizationEditDialog
        isOpen={isEditOpen}
        organization={org}
        onClose={() => setIsEditOpen(false)}
        onSuccess={() => {
          void refetch();
        }}
      />

      {/* Lifecycle Transition Dialog */}
      {transitionAction && (
        <OrganizationTransitionDialog
          isOpen={true}
          organization={org}
          action={transitionAction}
          onClose={() => setTransitionAction(null)}
          onSuccess={() => {
            void refetch();
          }}
        />
      )}
    </div>
  );
}
