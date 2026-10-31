'use client';

import { useContext } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { QueryClientContext, useQuery } from '@tanstack/react-query';

import { organizationsApi, type OrganizationView } from '../lib/api-client';
import { formatOrgOptionLabel, formatOrgTooltip } from '../lib/org-formatters';
import { clearAuthenticatedQueryCache } from '../lib/query-client';
import { useCanReadOrganizations, useSession } from '../lib/session-store';

/**
 * Scoped collection routes where viewing a specific resource ID
 * is strictly bound to the active organization context.
 */
const SCOPED_COLLECTION_PREFIXES = ['/workspaces/', '/teams/', '/users/', '/roles/'] as const;

export function isScopedDetailRoute(pathname: string | null): boolean {
  if (!pathname) return false;
  return SCOPED_COLLECTION_PREFIXES.some(
    (prefix) => pathname.startsWith(prefix) && pathname.length > prefix.length,
  );
}

export function getScopedCollectionRoot(
  pathname: string,
): '/workspaces' | '/teams' | '/users' | '/roles' | '/' {
  if (pathname.startsWith('/workspaces/')) return '/workspaces';
  if (pathname.startsWith('/teams/')) return '/teams';
  if (pathname.startsWith('/users/')) return '/users';
  if (pathname.startsWith('/roles/')) return '/roles';
  return '/';
}

/**
 * Organization switcher component displayed in the console header.
 *
 * Enforces security invariants:
 * 1. Users may ONLY switch between organization IDs present in `authorizedOrganizationIds`.
 * 2. SEC-05: When switching organizations on a scoped detail route (e.g. /workspaces/[id],
 *    /teams/[id], /users/[id], /roles/[id]), the console navigates to the collection root
 *    and clears the authenticated query cache to prevent cross-tenant parameter leakage,
 *    404s, and context desynchronization.
 */
export function OrgSwitcher() {
  const queryClient = useContext(QueryClientContext);
  if (!queryClient) {
    return <OrgSwitcherBase />;
  }
  return <OrgSwitcherWithQuery />;
}

function OrgSwitcherWithQuery() {
  const canReadOrganizations = useCanReadOrganizations();
  const { data, isLoading } = useQuery({
    queryKey: ['organizations', 'lookup'],
    queryFn: ({ signal }) => organizationsApi.listAll({}, signal),
    staleTime: 60_000,
    retry: false,
    enabled: canReadOrganizations,
  });

  const orgMap = new Map<string, OrganizationView>();
  if (data?.data) {
    for (const org of data.data) {
      orgMap.set(org.id, org);
    }
  }

  return <OrgSwitcherBase orgMap={orgMap} isLoading={isLoading} />;
}

function OrgSwitcherBase({
  orgMap,
  isLoading,
}: {
  orgMap?: Map<string, OrganizationView>;
  isLoading?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const authorizedOrganizationIds = useSession((state) => state.authorizedOrganizationIds);
  const selectedOrganizationId = useSession((state) => state.selectedOrganizationId);
  const selectOrganization = useSession((state) => state.selectOrganization);

  if (authorizedOrganizationIds.length === 0) {
    return null;
  }

  if (authorizedOrganizationIds.length === 1) {
    const orgId = authorizedOrganizationIds[0];
    if (!orgId) {
      return null;
    }
    const org = orgMap?.get(orgId);
    const label = formatOrgOptionLabel(orgId, org);
    const tooltip = formatOrgTooltip(orgId, org);
    return (
      <div className="flex items-center gap-1.5">
        <div
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-mono text-[var(--color-ink-muted)]"
          title={tooltip}
        >
          <span className="font-sans text-[var(--color-ink)]">Org:</span>
          <span className="truncate max-w-[160px] sm:max-w-none">{label}</span>
        </div>
        {isLoading && (
          <span
            role="status"
            className="text-[11px] font-mono text-[var(--color-ink-muted)]"
            title="Resolving organization names…"
          >
            resolving…
          </span>
        )}
      </div>
    );
  }

  const handleOrgChange = (newOrgId: string) => {
    if (!newOrgId || newOrgId === selectedOrganizationId) {
      return;
    }

    if (pathname && isScopedDetailRoute(pathname)) {
      const root = getScopedCollectionRoot(pathname);
      router.replace(root);
    }

    clearAuthenticatedQueryCache();
    selectOrganization(newOrgId);
  };

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="org-select" className="text-xs font-medium text-[var(--color-ink-muted)]">
        Org:
      </label>
      <select
        id="org-select"
        value={selectedOrganizationId ?? ''}
        onChange={(e) => {
          handleOrgChange(e.target.value);
        }}
        className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-mono text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
      >
        {authorizedOrganizationIds.map((id) => {
          const org = orgMap?.get(id);
          const label = formatOrgOptionLabel(id, org);
          const tooltip = formatOrgTooltip(id, org);
          return (
            <option key={id} value={id} title={tooltip}>
              {label}
            </option>
          );
        })}
      </select>
      {isLoading && (
        <span
          role="status"
          className="text-[11px] font-mono text-[var(--color-ink-muted)]"
          title="Resolving organization names…"
        >
          resolving…
        </span>
      )}
    </div>
  );
}
