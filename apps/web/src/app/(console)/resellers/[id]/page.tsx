'use client';

import { useState } from 'react';

import Link from 'next/link';
import type { Route } from 'next';
import { useParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  ApiError,
  resellersApi,
  type OrganizationStatus,
  type ResellerStatus,
} from '@/lib/api-client';
import {
  useCanManagePlatformTenants,
  useCanManageResellers,
  useCanReadResellers,
} from '@/lib/session-store';
import { StatusDot, type StatusTone } from '@/components/ui/status-dot';
import { EditResellerDialog } from '@/components/resellers/edit-reseller-dialog';
import { ResellerTransitionDialog } from '@/components/resellers/reseller-transition-dialog';
import { CustomerOnboardingDialog } from '@/components/onboarding/customer-onboarding-dialog';

const RESELLER_STATUS_TONES: Record<ResellerStatus, StatusTone> = {
  active: 'ok',
  suspended: 'warn',
  closed: 'bad',
};

const ORG_STATUS_TONES: Record<OrganizationStatus, StatusTone> = {
  active: 'ok',
  suspended: 'warn',
  closed: 'bad',
};

export default function ResellerDetailPage() {
  const params = useParams();
  const id = typeof params?.id === 'string' ? params.id : '';

  const canReadResellers = useCanReadResellers();
  const canManageResellers = useCanManageResellers();
  const canManagePlatformTenants = useCanManagePlatformTenants();

  // Modals
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [transitionState, setTransitionState] = useState<'suspend' | 'reactivate' | null>(null);
  const [isOnboardOpen, setIsOnboardOpen] = useState(false);

  // Pagination for customer orgs
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const currentCursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : undefined;

  // Query reseller details
  const {
    data: resellerData,
    isLoading: isResellerLoading,
    error: resellerError,
    refetch: refetchReseller,
  } = useQuery({
    queryKey: ['resellers', 'detail', id],
    queryFn: ({ signal }) => resellersApi.get(id, signal),
    enabled: canReadResellers && Boolean(id),
  });

  // Query customer organizations under this reseller
  const {
    data: orgsData,
    isLoading: isOrgsLoading,
    error: orgsError,
    refetch: refetchOrgs,
    isFetching: isOrgsFetching,
  } = useQuery({
    queryKey: ['resellers', id, 'organizations', currentCursor],
    queryFn: ({ signal }) =>
      resellersApi.listOrganizations(id, { cursor: currentCursor, limit: 20 }, signal),
    enabled: canReadResellers && Boolean(id),
  });

  const handleNextPage = () => {
    if (orgsData?.page.nextCursor) {
      setCursorStack((prev) => [...prev, orgsData.page.nextCursor!]);
    }
  };

  const handlePrevPage = () => {
    setCursorStack((prev) => prev.slice(0, -1));
  };

  const reseller = resellerData?.data;
  const customerOrgs = orgsData?.data ?? [];
  const orgsPageInfo = orgsData?.page;

  if (!canReadResellers) {
    return (
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center">
        <h2 className="text-lg font-semibold text-[var(--color-ink)]">Access Restricted</h2>
        <p className="mt-2 text-sm text-[var(--color-ink-muted)]">
          You do not have permission to view reseller details.
        </p>
      </div>
    );
  }

  if (isResellerLoading) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)]">
        <p className="text-xs text-[var(--color-ink-muted)]">Loading reseller details…</p>
      </div>
    );
  }

  if (resellerError || !reseller) {
    const isNotFound = resellerError instanceof ApiError && resellerError.status === 404;
    return (
      <div className="rounded-lg border border-[var(--color-bad)] bg-[var(--color-bad-subtle,#fee2e2)] p-6 text-center">
        <h2 className="text-sm font-semibold text-[var(--color-bad)]">
          {isNotFound ? 'Reseller Not Found' : 'Failed to load reseller'}
        </h2>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          {isNotFound
            ? 'The requested reseller does not exist or is out of your administrative reach.'
            : resellerError instanceof ApiError
              ? resellerError.message
              : 'An unexpected error occurred'}
        </p>
        <div className="mt-4 flex justify-center gap-3">
          <Link
            href={'/resellers' as Route}
            className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
          >
            ← Back to Resellers
          </Link>
          {!isNotFound && (
            <button
              type="button"
              onClick={() => void refetchReseller()}
              className="rounded-md border border-[var(--color-bad)] px-3 py-1.5 text-xs font-medium text-[var(--color-bad)] hover:bg-[var(--color-surface)]"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb Navigation */}
      <nav aria-label="Breadcrumb" className="text-xs text-[var(--color-ink-muted)]">
        <ol className="flex items-center gap-1.5">
          <li>
            <Link
              href={'/resellers' as Route}
              className="hover:text-[var(--color-ink)] hover:underline"
            >
              Resellers
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page" className="font-semibold text-[var(--color-ink)]">
            {reseller.name}
          </li>
        </ol>
      </nav>

      {/* Reseller Header Card */}
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xs">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">
              {reseller.name}
            </h1>
            <StatusDot tone={RESELLER_STATUS_TONES[reseller.status]} label={reseller.status} />
            {reseller.isPlatformDefault && (
              <span className="rounded bg-[var(--color-surface-raised)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-ink-muted)]">
                Platform Default
              </span>
            )}
          </div>
          <p className="mt-1 font-mono text-xs text-[var(--color-ink-muted)]">ID: {reseller.id}</p>
          <p className="mt-0.5 font-mono text-xs text-[var(--color-ink-muted)]">
            Slug: {reseller.slug}
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          {canManageResellers && (
            <button
              type="button"
              onClick={() => setIsEditOpen(true)}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] shadow-xs hover:bg-[var(--color-surface-raised)]"
            >
              Edit Details
            </button>
          )}

          {canManagePlatformTenants && !reseller.isPlatformDefault && (
            <>
              {reseller.status === 'active' ? (
                <button
                  type="button"
                  onClick={() => setTransitionState('suspend')}
                  className="rounded-md border border-[var(--color-bad)] px-3 py-1.5 text-xs font-medium text-[var(--color-bad)] shadow-xs hover:bg-[var(--color-bad-subtle,#fee2e2)]"
                >
                  Suspend Reseller
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setTransitionState('reactivate')}
                  className="rounded-md bg-[var(--color-primary,#2563eb)] px-3 py-1.5 text-xs font-medium text-white shadow-xs hover:opacity-90"
                >
                  Reactivate Reseller
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Grid: Overview & Commercial Settings */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        {/* Commercial & Technical Configuration */}
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5 shadow-xs">
          <h2 className="text-sm font-semibold text-[var(--color-ink)] border-b border-[var(--color-border-subtle)] pb-2 mb-3">
            Commercial & Domain Settings
          </h2>
          <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-[var(--color-ink-muted)]">Default Rate Markup</dt>
              <dd className="mt-0.5 font-mono text-sm font-semibold text-[var(--color-ink)]">
                {reseller.defaultMarkupPct}%
              </dd>
            </div>
            <div>
              <dt className="text-[var(--color-ink-muted)]">Customer Organizations</dt>
              <dd className="mt-0.5 font-mono text-sm font-semibold text-[var(--color-ink)]">
                {reseller.customerCount}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-[var(--color-ink-muted)]">White-label Domain</dt>
              <dd className="mt-0.5 font-mono text-xs text-[var(--color-ink)]">
                {reseller.domain ? (
                  <span className="text-[var(--color-primary)]">{reseller.domain}</span>
                ) : (
                  <span className="text-[var(--color-ink-muted)]">(Platform default domain)</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--color-ink-muted)]">Created Date</dt>
              <dd className="mt-0.5 text-[var(--color-ink)]">
                {new Date(reseller.createdAt).toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--color-ink-muted)]">Last Updated</dt>
              <dd className="mt-0.5 text-[var(--color-ink)]">
                {new Date(reseller.updatedAt).toLocaleString()}
              </dd>
            </div>
          </dl>
        </div>

        {/* Branding Configuration */}
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5 shadow-xs">
          <h2 className="text-sm font-semibold text-[var(--color-ink)] border-b border-[var(--color-border-subtle)] pb-2 mb-3">
            Portal Branding Configuration
          </h2>
          {reseller.brandConfig && Object.keys(reseller.brandConfig).length > 0 ? (
            <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
              <div>
                <dt className="text-[var(--color-ink-muted)]">Brand Name</dt>
                <dd className="mt-0.5 font-medium text-[var(--color-ink)]">
                  {reseller.brandConfig.brandName ?? '—'}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--color-ink-muted)]">Support Phone</dt>
                <dd className="mt-0.5 font-medium text-[var(--color-ink)]">
                  {reseller.brandConfig.supportPhone ?? '—'}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-[var(--color-ink-muted)]">Support Email</dt>
                <dd className="mt-0.5 font-mono text-[var(--color-ink)]">
                  {reseller.brandConfig.supportEmail ?? '—'}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-xs text-[var(--color-ink-muted)] italic">
              No custom branding configured. The default Alendei Communications Cloud branding is
              presented.
            </p>
          )}
        </div>
      </div>

      {/* Customer Organizations Hierarchy Section */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-bold tracking-tight text-[var(--color-ink)]">
              Customer Organizations ({reseller.customerCount})
            </h2>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Tenanted customer accounts belonging to this reseller hierarchy.
            </p>
          </div>

          <button
            type="button"
            onClick={() => setIsOnboardOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-primary,#2563eb)] px-3 py-1.5 text-xs font-medium text-white shadow-xs hover:opacity-90"
          >
            + Onboard Customer
          </button>
        </div>

        {isOrgsLoading ? (
          <div
            role="status"
            className="flex h-32 items-center justify-center rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)]"
          >
            <p className="text-xs text-[var(--color-ink-muted)]">Loading customer organizations…</p>
          </div>
        ) : orgsError ? (
          <div
            role="alert"
            className="rounded-lg border border-[var(--color-bad)] bg-[var(--color-bad-subtle,#fee2e2)] p-4 text-center"
          >
            <p className="text-xs font-medium text-[var(--color-bad)]">
              Failed to load customer organizations
            </p>
            <button
              type="button"
              onClick={() => void refetchOrgs()}
              className="mt-2 text-xs underline text-[var(--color-bad)]"
            >
              Retry
            </button>
          </div>
        ) : customerOrgs.length === 0 ? (
          <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center">
            <p className="text-sm font-medium text-[var(--color-ink)]">
              No customer organizations yet
            </p>
            <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
              Onboard a direct or white-label customer under this reseller partner.
            </p>
            <button
              type="button"
              onClick={() => setIsOnboardOpen(true)}
              className="mt-3 inline-flex items-center rounded-md bg-[var(--color-primary,#2563eb)] px-3 py-1.5 text-xs font-medium text-white shadow-xs hover:opacity-90"
            >
              + Onboard First Customer
            </button>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Customer Name & Slug
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Status
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Customer ID
                    </th>
                    <th scope="col" className="px-4 py-3 font-medium">
                      Onboarded
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border-subtle)]">
                  {customerOrgs.map((org) => (
                    <tr
                      key={org.id}
                      className="hover:bg-[var(--color-surface-raised)]/50 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <div className="flex flex-col">
                          <span className="font-semibold text-[var(--color-ink)]">{org.name}</span>
                          <span className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                            {org.slug}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <StatusDot
                          tone={
                            (ORG_STATUS_TONES as Record<string, StatusTone>)[org.status] ??
                            'unknown'
                          }
                          label={org.status}
                        />
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-[var(--color-ink-muted)]">
                        {org.id}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-[var(--color-ink-muted)]">
                        {new Date(org.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            {orgsPageInfo &&
              (cursorStack.length > 0 || (orgsPageInfo.hasMore && orgsPageInfo.nextCursor)) && (
                <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] px-4 py-3 text-xs">
                  <span className="text-[var(--color-ink-muted)]">
                    Showing {customerOrgs.length} organization{customerOrgs.length === 1 ? '' : 's'}
                    {isOrgsFetching && ' (refreshing…)'}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={handlePrevPage}
                      disabled={cursorStack.length === 0 || isOrgsFetching}
                      className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      onClick={handleNextPage}
                      disabled={!orgsPageInfo.hasMore || !orgsPageInfo.nextCursor || isOrgsFetching}
                      className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
          </div>
        )}
      </div>

      {/* Edit Details Dialog */}
      <EditResellerDialog
        isOpen={isEditOpen}
        reseller={reseller}
        onClose={() => setIsEditOpen(false)}
        onSuccess={() => {
          void refetchReseller();
        }}
      />

      {/* Lifecycle Transition Dialog */}
      {transitionState && (
        <ResellerTransitionDialog
          isOpen={true}
          reseller={reseller}
          transition={transitionState}
          onClose={() => setTransitionState(null)}
          onSuccess={() => {
            void refetchReseller();
          }}
        />
      )}

      {/* Customer Onboarding Dialog */}
      <CustomerOnboardingDialog
        isOpen={isOnboardOpen}
        onClose={() => setIsOnboardOpen(false)}
        onSuccess={() => {
          void refetchReseller();
          void refetchOrgs();
        }}
      />
    </div>
  );
}
