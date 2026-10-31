'use client';

import { useContext, useState } from 'react';
import { QueryClientContext, useQuery } from '@tanstack/react-query';

import { authApi, organizationsApi, type OrganizationView } from '../lib/api-client';
import { formatOrgOptionLabel, formatOrgTooltip } from '../lib/org-formatters';
import { useCanReadOrganizations, useSession } from '../lib/session-store';
import { Card, CardDescription, CardTitle } from './ui/card';

export function OrgSelectionView() {
  const queryClient = useContext(QueryClientContext);
  if (!queryClient) {
    return <OrgSelectionForm />;
  }
  return <OrgSelectionViewWithQuery />;
}

function OrgSelectionViewWithQuery() {
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

  return <OrgSelectionForm orgMap={orgMap} isLoading={isLoading} />;
}

function OrgSelectionForm({
  orgMap,
  isLoading,
}: {
  orgMap?: Map<string, OrganizationView>;
  isLoading?: boolean;
}) {
  const authorizedOrganizationIds = useSession((state) => state.authorizedOrganizationIds);
  const selectOrganization = useSession((state) => state.selectOrganization);
  const clearSession = useSession((state) => state.clearSession);

  const [selected, setSelected] = useState<string>(authorizedOrganizationIds[0] ?? '');
  const [error, setError] = useState<string | null>(null);

  const handleSelect = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) {
      setError('Please select an organization');
      return;
    }

    try {
      selectOrganization(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select organization');
    }
  };

  const handleSignOut = async () => {
    try {
      await authApi.logout();
    } finally {
      clearSession();
    }
  };

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md items-center px-4">
      <Card className="w-full">
        <CardTitle>Select Organization</CardTitle>
        <CardDescription>
          Your account has access to multiple organizations. Choose an organization context to
          continue.
        </CardDescription>

        {error && (
          <div
            role="alert"
            className="mt-4 rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSelect} className="mt-5 space-y-4">
          <div>
            <div className="flex items-center justify-between">
              <label
                htmlFor="organization-select"
                className="block text-xs font-medium text-[var(--color-ink-muted)]"
              >
                Authorized Organizations
              </label>
              {isLoading && (
                <span role="status" className="text-[11px] font-mono text-[var(--color-ink-muted)]">
                  resolving names…
                </span>
              )}
            </div>
            <select
              id="organization-select"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="mt-1.5 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 text-sm font-mono text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
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
          </div>

          <div className="flex items-center justify-between gap-3 pt-2">
            <button
              type="button"
              onClick={handleSignOut}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]"
            >
              Sign out
            </button>
            <button
              type="submit"
              className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              Enter Console
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
