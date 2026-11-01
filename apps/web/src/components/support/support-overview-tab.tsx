'use client';

import { useQuery } from '@tanstack/react-query';
import { platformSupportApi, type PlatformSupportOrgOverview } from '@/lib/api-client';
import { StatusDot, type StatusTone } from '@/components/ui/status-dot';

function getStatusTone(status: string): StatusTone {
  switch (status.toLowerCase()) {
    case 'active':
    case 'verified':
      return 'ok';
    case 'suspended':
    case 'pending':
      return 'warn';
    case 'closed':
    case 'failed':
      return 'bad';
    default:
      return 'unknown';
  }
}

export function SupportOverviewTab({ orgId }: { orgId: string }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['platform-support', 'overview', orgId],
    queryFn: ({ signal }) => platformSupportApi.getOverview(orgId, signal),
    enabled: Boolean(orgId),
  });

  if (isLoading) {
    return (
      <div
        role="status"
        className="py-12 text-center text-sm text-[var(--color-ink-muted)]"
        data-testid="support-overview-loading"
      >
        Loading organization overview diagnostics…
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-[var(--color-bad)]/30 bg-[var(--color-bad)]/10 p-4 text-sm text-[var(--color-ink)]"
        data-testid="support-overview-error"
      >
        <p className="font-semibold text-[var(--color-bad)]">
          Failed to load organization overview
        </p>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">{(error as Error).message}</p>
        <button
          type="button"
          onClick={() => void refetch()}
          className="mt-3 rounded-md bg-[var(--color-surface-raised)] px-3 py-1 text-xs font-medium border border-[var(--color-border-subtle)]"
        >
          Retry
        </button>
      </div>
    );
  }

  const overview: PlatformSupportOrgOverview | undefined = data?.data;
  if (!overview) {
    return null;
  }

  const { organization, parentReseller, customerOrganizations, workspaces, teams, metrics } =
    overview;

  return (
    <div className="space-y-6" data-testid="support-overview-tab">
      {/* Metrics Row */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
          <p className="text-xs text-[var(--color-ink-muted)]">Total Users</p>
          <p className="mt-1 text-xl font-semibold">{metrics.totalUsers}</p>
          <p className="mt-0.5 text-2xs text-[var(--color-ink-muted)]">
            {metrics.activeUsers} active / {metrics.disabledUsers} disabled
          </p>
        </div>
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
          <p className="text-xs text-[var(--color-ink-muted)]">Active Sessions</p>
          <p className="mt-1 text-xl font-semibold">{metrics.activeSessions}</p>
        </div>
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
          <p className="text-xs text-[var(--color-ink-muted)]">Active API Keys</p>
          <p className="mt-1 text-xl font-semibold">{metrics.activeApiKeys}</p>
        </div>
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
          <p className="text-xs text-[var(--color-ink-muted)]">Verified Domains</p>
          <p className="mt-1 text-xl font-semibold">{metrics.verifiedDomains}</p>
        </div>
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
          <p className="text-xs text-[var(--color-ink-muted)]">Workspaces</p>
          <p className="mt-1 text-xl font-semibold">{workspaces.length}</p>
        </div>
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
          <p className="text-xs text-[var(--color-ink-muted)]">Teams</p>
          <p className="mt-1 text-xl font-semibold">{teams.length}</p>
        </div>
      </div>

      {/* Organization Details */}
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
        <h3 className="text-sm font-semibold tracking-tight">Organization Profile</h3>
        <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
          <div>
            <dt className="text-[var(--color-ink-muted)]">Organization ID</dt>
            <dd className="mt-0.5 font-mono select-all text-xs">{organization.id}</dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-muted)]">Name & Slug</dt>
            <dd className="mt-0.5 font-medium">
              {organization.name}{' '}
              <span className="text-[var(--color-ink-muted)] font-normal">
                ({organization.slug})
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-muted)]">Tenancy Type</dt>
            <dd className="mt-0.5 capitalize">{organization.type}</dd>
          </div>
          <div>
            <dt className="text-[var(--color-ink-muted)]">Status</dt>
            <dd className="mt-0.5">
              <StatusDot tone={getStatusTone(organization.status)} label={organization.status} />
            </dd>
          </div>
        </dl>
      </div>

      {/* Reseller Hierarchy Details if applicable */}
      {parentReseller && (
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
          <h3 className="text-sm font-semibold tracking-tight">Parent Reseller</h3>
          <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-3 text-xs">
            <div>
              <dt className="text-[var(--color-ink-muted)]">Reseller ID</dt>
              <dd className="mt-0.5 font-mono select-all">{parentReseller.id}</dd>
            </div>
            <div>
              <dt className="text-[var(--color-ink-muted)]">Name</dt>
              <dd className="mt-0.5 font-medium">{parentReseller.name}</dd>
            </div>
            <div>
              <dt className="text-[var(--color-ink-muted)]">Slug</dt>
              <dd className="mt-0.5">{parentReseller.slug}</dd>
            </div>
          </dl>
        </div>
      )}

      {customerOrganizations.length > 0 && (
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
          <h3 className="text-sm font-semibold tracking-tight">
            Child Customer Organizations ({customerOrganizations.length})
          </h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--color-border-subtle)] text-[var(--color-ink-muted)]">
                <tr>
                  <th scope="col" className="pb-2 font-medium">
                    Name
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Slug
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Status
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    Org ID
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)]">
                {customerOrganizations.map((cust) => (
                  <tr key={cust.id}>
                    <td className="py-2 font-medium">{cust.name}</td>
                    <td className="py-2 text-[var(--color-ink-muted)]">{cust.slug}</td>
                    <td className="py-2">
                      <StatusDot tone={getStatusTone(cust.status)} label={cust.status} />
                    </td>
                    <td className="py-2 font-mono select-all">{cust.id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Workspaces & Teams Breakdown */}
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
        <h3 className="text-sm font-semibold tracking-tight">
          Workspaces & Teams ({workspaces.length} workspaces, {teams.length} teams)
        </h3>
        {workspaces.length === 0 ? (
          <p className="mt-3 text-xs text-[var(--color-ink-muted)]">
            No workspaces configured for this organization.
          </p>
        ) : (
          <div className="mt-3 divide-y divide-[var(--color-border-subtle)]">
            {workspaces.map((ws) => {
              const wsTeams = teams.filter((t) => t.workspaceId === ws.id);
              return (
                <div key={ws.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs font-semibold">{ws.name}</span>
                      <span className="ml-2 font-mono text-2xs text-[var(--color-ink-muted)]">
                        ({ws.slug})
                      </span>
                      <span className="ml-2">
                        <StatusDot tone={getStatusTone(ws.status)} label={ws.status} />
                      </span>
                    </div>
                    <span className="text-2xs text-[var(--color-ink-muted)] font-mono">
                      {ws.id}
                    </span>
                  </div>

                  {wsTeams.length > 0 ? (
                    <div className="mt-2 pl-4 border-l-2 border-[var(--color-border-subtle)] space-y-1">
                      {wsTeams.map((team) => (
                        <div key={team.id} className="flex items-center justify-between text-2xs">
                          <span className="font-medium text-[var(--color-ink)]">{team.name}</span>
                          <span className="font-mono text-[var(--color-ink-muted)]">{team.id}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-1.5 pl-4 text-2xs text-[var(--color-ink-muted)] italic">
                      No teams in this workspace
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
