'use client';

import { useQuery } from '@tanstack/react-query';
import { use } from 'react';
import { useRouter } from 'next/navigation';

import { rolesApi, ApiError } from '@/lib/api-client';
import { useHasPermission, useSession } from '@/lib/session-store';
import { RoleDetailView } from '@/components/roles/role-detail-view';

interface RoleDetailPageProps {
  readonly params: Promise<{ readonly id: string }>;
}

export default function RoleDetailPage({ params }: RoleDetailPageProps) {
  const router = useRouter();
  const { id } = use(params);
  const selectedOrgId = useSession((state) => state.selectedOrganizationId);
  const canReadRoles = useHasPermission('roles.read');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['roles', 'detail', selectedOrgId, id],
    queryFn: ({ signal }) => rolesApi.get(id, signal),
    enabled: !!selectedOrgId && !!id && canReadRoles,
  });

  if (!canReadRoles) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center shadow-xs">
        <p className="text-sm font-semibold text-[var(--color-bad)]">Access Restricted</p>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
          Viewing role details requires the <code className="font-mono">roles.read</code> permission.
        </p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-12 text-center shadow-xs">
        <p className="text-xs text-[var(--color-ink-muted)]">Loading role details...</p>
      </div>
    );
  }

  if (error || !data?.data) {
    const isNotFound = error instanceof ApiError && error.status === 404;

    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-8 text-center shadow-xs space-y-4">
        <div>
          <p className="text-sm font-semibold text-[var(--color-bad)]">
            {isNotFound ? 'Role Not Found' : 'Error Loading Role'}
          </p>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            {isNotFound
              ? 'This role does not exist or is outside your current organization context.'
              : error instanceof ApiError
                ? error.message
                : 'An unexpected error occurred.'}
          </p>
        </div>

        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => router.push('/roles')}
            className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
          >
            ← Back to Roles
          </button>
          {!isNotFound && (
            <button
              type="button"
              onClick={() => void refetch()}
              className="rounded-md bg-[var(--color-brand)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <RoleDetailView
      role={data.data}
      onBack={() => router.push('/roles')}
      onRoleUpdated={() => void refetch()}
      onRoleDeleted={() => router.push('/roles')}
    />
  );
}
