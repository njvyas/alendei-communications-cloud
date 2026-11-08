'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { campaignsApi, workspacesApi } from '@/lib/api-client';
import { useCanManageCampaigns, useCanReadCampaigns, useSession } from '@/lib/session-store';
import {
  ALL_CAMPAIGN_CHANNELS,
  ALL_CAMPAIGN_STATUSES,
  BACKEND_CAMPAIGN_SUPPORT_STATUS,
  calculateCampaignKPIs,
  getCampaignStatusLabel,
  getChannelDisplayName,
  type CampaignRecord,
} from '@/lib/campaigns';
import { CampaignStatusBadge } from '@/components/campaigns/campaign-status-badge';
import { CampaignChannelBadge } from '@/components/campaigns/campaign-channel-badge';
import { CampaignCreateDialog } from '@/components/campaigns/campaign-create-dialog';
import { StatCard } from '@/components/ui/stat-card';

export default function CampaignsDirectoryPage() {
  const canReadCampaigns = useCanReadCampaigns();
  const canManageCampaigns = useCanManageCampaigns();
  const selectedOrganizationId = useSession((state) => state.selectedOrganizationId);

  // Workspaces of the active organization
  const { data: workspacesData } = useQuery({
    queryKey: ['workspaces', 'list', selectedOrganizationId, { limit: 50 }],
    queryFn: ({ signal }) => workspacesApi.list({ limit: 50 }, signal),
    enabled: Boolean(canReadCampaigns && selectedOrganizationId),
  });

  const workspaces = workspacesData?.data ?? [];

  // Filter and search states
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('all');
  const [selectedChannel, setSelectedChannel] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // Dialog state
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  // Campaigns list query
  const {
    data: campaignsData,
    isLoading: isCampaignsLoading,
    refetch: refetchCampaigns,
  } = useQuery({
    queryKey: [
      'campaigns',
      'list',
      selectedOrganizationId,
      selectedWorkspaceId,
      selectedChannel,
      selectedStatus,
      searchQuery,
    ],
    queryFn: ({ signal }) =>
      campaignsApi.list(
        selectedWorkspaceId === 'all' ? undefined : selectedWorkspaceId,
        {
          channel: selectedChannel === 'all' ? undefined : selectedChannel,
          status: selectedStatus === 'all' ? undefined : selectedStatus,
          query: searchQuery || undefined,
        },
        signal,
      ),
    enabled: Boolean(canReadCampaigns),
  });

  const campaigns: readonly CampaignRecord[] = campaignsData?.data ?? [];
  const kpis = calculateCampaignKPIs(campaigns);

  if (!canReadCampaigns) {
    return (
      <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-6 text-sm text-rose-300">
        <h2 className="font-semibold text-rose-200">Access Denied</h2>
        <p className="mt-1">You do not hold permissions to view campaigns in this organization.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">Campaigns</h1>
          <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
            Broadcast messaging orchestration, multi-channel campaigns, and audience delivery
            monitoring.
          </p>
        </div>

        {canManageCampaigns && (
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-acc-primary px-3.5 py-2 text-xs font-semibold text-white shadow-xs hover:opacity-90"
          >
            <span>+</span> Create Campaign
          </button>
        )}
      </div>

      {/* Backend Engine Blocker Banner */}
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-900 dark:text-amber-200">
        <div className="flex items-start gap-3">
          <span className="text-lg">⚠️</span>
          <div>
            <h2 className="font-semibold text-amber-950 dark:text-amber-300">
              Phase 8B Frontend Preview Mode
            </h2>
            <p className="mt-1 text-amber-900/90 dark:text-amber-200/90 leading-relaxed">
              {BACKEND_CAMPAIGN_SUPPORT_STATUS.notice} Missing endpoints:
              <span className="ml-1 font-mono text-[11px] text-amber-950 dark:text-amber-100">
                GET /workspaces/:id/campaigns, POST /workspaces/:id/campaigns
              </span>
              .
            </p>
            <p className="mt-1 text-amber-900/90 dark:text-amber-200/90 leading-relaxed">
              <strong>Phase 7 Billing Dependency:</strong> Bulk send dispatch depends on Phase 7
              billing (wallets and rating engine). Wallet checks and ledger deductions are
              unavailable in this preview.
            </p>
          </div>
        </div>
      </div>

      {/* Aggregate KPI Stat Cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard
          label="Total Campaigns"
          value={kpis.totalCampaigns}
          description="In active filter"
        />
        <StatCard
          label="Active Campaigns"
          value={kpis.activeCampaigns}
          description="Running & scheduled"
        />
        <StatCard
          label="Audience Reach"
          value={kpis.totalRecipientsTargeted.toLocaleString()}
          description="Target recipients"
        />
        <StatCard
          label="Delivered"
          value={kpis.totalDelivered.toLocaleString()}
          description="Confirmed delivered"
        />
        <StatCard
          label="Avg Delivery Rate"
          value={`${kpis.avgDeliveryRate}%`}
          description="Across completed/active"
        />
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-4">
        {/* Search Input */}
        <div className="min-w-[200px] flex-1">
          <label htmlFor="campaigns-search-input" className="sr-only">
            Search campaigns
          </label>
          <input
            id="campaigns-search-input"
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search campaigns by name, template, or tag..."
            className="w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:border-acc-primary focus:outline-none"
          />
        </div>

        {/* Workspace Filter */}
        {workspaces.length > 0 && (
          <div>
            <label htmlFor="campaigns-workspace-select" className="sr-only">
              Filter by Workspace
            </label>
            <select
              id="campaigns-workspace-select"
              value={selectedWorkspaceId}
              onChange={(e) => setSelectedWorkspaceId(e.target.value)}
              className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs text-[var(--color-ink)] focus:border-acc-primary focus:outline-none"
            >
              <option value="all">All Workspaces</option>
              {workspaces.map((ws) => (
                <option key={ws.id} value={ws.id}>
                  {ws.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Channel Filter */}
        <div>
          <label htmlFor="campaigns-channel-select" className="sr-only">
            Filter by Channel
          </label>
          <select
            id="campaigns-channel-select"
            value={selectedChannel}
            onChange={(e) => setSelectedChannel(e.target.value)}
            className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs text-[var(--color-ink)] focus:border-acc-primary focus:outline-none"
          >
            <option value="all">All Channels</option>
            {ALL_CAMPAIGN_CHANNELS.map((ch) => (
              <option key={ch} value={ch}>
                {getChannelDisplayName(ch)}
              </option>
            ))}
          </select>
        </div>

        {/* Status Filter */}
        <div>
          <label htmlFor="campaigns-status-select" className="sr-only">
            Filter by Status
          </label>
          <select
            id="campaigns-status-select"
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1.5 text-xs text-[var(--color-ink)] focus:border-acc-primary focus:outline-none"
          >
            <option value="all">All Statuses</option>
            {ALL_CAMPAIGN_STATUSES.map((st) => (
              <option key={st} value={st}>
                {getCampaignStatusLabel(st)}
              </option>
            ))}
          </select>
        </div>

        {/* Reset Filters button if any active */}
        {(selectedWorkspaceId !== 'all' ||
          selectedChannel !== 'all' ||
          selectedStatus !== 'all' ||
          searchQuery) && (
          <button
            type="button"
            onClick={() => {
              setSelectedWorkspaceId('all');
              setSelectedChannel('all');
              setSelectedStatus('all');
              setSearchQuery('');
            }}
            className="text-xs text-acc-primary hover:underline"
          >
            Reset Filters
          </button>
        )}
      </div>

      {/* Campaigns Directory Table */}
      <div className="overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs">
        {isCampaignsLoading ? (
          <div role="status" className="p-8 text-center text-xs text-[var(--color-ink-muted)]">
            Loading campaigns...
          </div>
        ) : campaigns.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm font-semibold text-[var(--color-ink)]">No campaigns found</p>
            <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
              {searchQuery || selectedChannel !== 'all' || selectedStatus !== 'all'
                ? 'Try adjusting your search query or filter criteria.'
                : 'Create your first broadcast messaging campaign to get started.'}
            </p>
            {canManageCampaigns && (
              <button
                type="button"
                onClick={() => setIsCreateOpen(true)}
                className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-acc-primary px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
              >
                + Create Campaign
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Campaign
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Channel
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Audience
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Delivery Progress
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Created / Timing
                  </th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)] text-[var(--color-ink)]">
                {campaigns.map((c) => {
                  const deliveryPct = c.metrics.deliveryRate;
                  return (
                    <tr
                      key={c.id}
                      className="hover:bg-[var(--color-surface-raised)]/50 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/campaigns/${c.id}`}
                            className="font-semibold text-acc-primary hover:underline"
                          >
                            {c.name}
                          </Link>
                          {c.isSimulatedPreview && (
                            <span className="inline-flex items-center rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                              Preview Fixture
                            </span>
                          )}
                        </div>
                        {c.description && (
                          <p className="mt-0.5 line-clamp-1 text-[11px] text-[var(--color-ink-muted)]">
                            {c.description}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <CampaignChannelBadge channel={c.channel} />
                      </td>
                      <td className="px-4 py-3">
                        <CampaignStatusBadge status={c.status} />
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium">
                          {c.recipientSource.segmentName || c.recipientSource.type}
                        </div>
                        <div className="text-[11px] text-[var(--color-ink-muted)]">
                          {c.recipientSource.contactCount != null ? (
                            <>
                              {c.recipientSource.contactCount.toLocaleString()} recipients
                              {c.isSimulatedPreview && (
                                <span className="ml-1 text-[10px] text-amber-600 dark:text-amber-400">
                                  (Preview Fixture)
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="text-amber-600 dark:text-amber-400">
                              Audience count unavailable — backend preview required
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {c.metrics.totalRecipients != null && c.metrics.totalRecipients > 0 ? (
                          <>
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{deliveryPct}%</span>
                              <span className="text-[11px] text-[var(--color-ink-muted)]">
                                ({c.metrics.delivered.toLocaleString()} /{' '}
                                {c.metrics.totalRecipients.toLocaleString()})
                              </span>
                            </div>
                            <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-[var(--color-surface-raised)]">
                              <div
                                className="h-full bg-acc-primary"
                                style={{ width: `${Math.min(deliveryPct, 100)}%` }}
                              />
                            </div>
                          </>
                        ) : (
                          <div className="text-[11px] text-[var(--color-ink-muted)]">
                            {c.metrics.sent > 0 ? `${c.metrics.sent.toLocaleString()} sent` : '—'}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-[var(--color-ink-muted)]">
                        <div>{new Date(c.createdAt).toLocaleDateString()}</div>
                        {c.scheduledAt && (
                          <div className="text-[10px] text-amber-400">
                            Sched: {new Date(c.scheduledAt).toLocaleDateString()}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/campaigns/${c.id}`}
                          className="font-medium text-acc-primary hover:underline"
                        >
                          View Details →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Campaign Creation Dialog */}
      <CampaignCreateDialog
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        workspaces={workspaces}
        defaultWorkspaceId={selectedWorkspaceId !== 'all' ? selectedWorkspaceId : undefined}
        onCreated={() => {
          refetchCampaigns();
        }}
      />
    </div>
  );
}
