'use client';

import Link from 'next/link';
import { renderTemplate } from '@acc/contracts';
import { StatCard } from '@/components/ui/stat-card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { CampaignStatusBadge } from './campaign-status-badge';
import { CampaignChannelBadge } from './campaign-channel-badge';
import { type CampaignRecord } from '@/lib/campaigns';

export interface CampaignDetailViewProps {
  readonly campaign: CampaignRecord;
  readonly defaultTab?: string;
  readonly onRefresh?: () => void;
}

export function CampaignDetailView({ campaign, defaultTab = 'overview' }: CampaignDetailViewProps) {
  // Render template preview with variables if provided
  const { text: renderedMessageBody } = renderTemplate(
    campaign.templateBody,
    campaign.templateVariables ?? { '1': 'Customer Name', '2': 'SPECIALCODE' },
  );

  const deliveryPercent = campaign.metrics.deliveryRate;
  const dispatchProgress =
    campaign.metrics.totalRecipients > 0
      ? Math.round((campaign.metrics.sent / campaign.metrics.totalRecipients) * 100)
      : 0;

  return (
    <div className="space-y-6">
      {/* Back Navigation Bar */}
      <div>
        <Link
          href="/campaigns"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          <span>←</span> Back to Campaigns
        </Link>
      </div>

      {/* Header */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">
              {campaign.name}
            </h1>
            <CampaignChannelBadge channel={campaign.channel} />
            <CampaignStatusBadge status={campaign.status} />
          </div>
          {campaign.description && (
            <p className="mt-1 text-sm text-[var(--color-ink-muted)]">{campaign.description}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-[var(--color-ink-muted)]">
            <span>
              ID: <code className="font-mono text-acc-primary">{campaign.id}</code>
            </span>
            <span>Created: {new Date(campaign.createdAt).toLocaleDateString()}</span>
            {campaign.scheduledAt && (
              <span>Scheduled: {new Date(campaign.scheduledAt).toLocaleString()}</span>
            )}
            {campaign.completedAt && (
              <span>Completed: {new Date(campaign.completedAt).toLocaleString()}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            disabled
            title="Backend campaign dispatch engine arrives with Phase 8B backend"
            className="rounded-lg bg-acc-surface-raised px-3.5 py-2 text-xs font-semibold text-acc-text-secondary opacity-60 cursor-not-allowed"
          >
            Dispatch (Backend Pending)
          </button>
        </div>
      </div>

      {/* Backend Blocker Notice Banner */}
      <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-xs text-amber-900 dark:text-amber-200">
        <div className="flex items-start gap-3">
          <span className="text-lg">⚠️</span>
          <div>
            <h2 className="font-semibold text-amber-950 dark:text-amber-300">
              Phase 8B Backend Execution Engine Pending
            </h2>
            <p className="mt-1 text-amber-900/90 dark:text-amber-200/90 leading-relaxed">
              Real dispatch orchestration, live progress tracking, and recipient-level delivery
              settlement require the Phase 8B backend campaigns engine (
              <code className="font-mono text-amber-950 dark:text-amber-100">campaigns</code> and{' '}
              <code className="font-mono text-amber-950 dark:text-amber-100">
                campaign_recipients
              </code>{' '}
              database tables). The data presented below is rendered from isolated frontend preview
              fixtures.
            </p>
          </div>
        </div>
      </div>

      {/* KPI Metrics Row */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Total Target"
          value={campaign.metrics.totalRecipients.toLocaleString()}
          description="Audience pool"
        />
        <StatCard
          label="Dispatched"
          value={campaign.metrics.sent.toLocaleString()}
          description={`${dispatchProgress}% of total`}
        />
        <StatCard
          label="Delivered"
          value={campaign.metrics.delivered.toLocaleString()}
          description="Confirmed delivery"
        />
        <StatCard
          label="Delivery Rate"
          value={`${deliveryPercent}%`}
          description="Delivered / Sent"
        />
        <StatCard
          label="Failed"
          value={campaign.metrics.failed.toLocaleString()}
          description="Permanent or rejected"
        />
        <StatCard
          label="Read / Seen"
          value={campaign.metrics.read > 0 ? campaign.metrics.read.toLocaleString() : '—'}
          description="Read receipt confirmation"
        />
      </div>

      {/* Detail Tabs */}
      <Tabs defaultValue={defaultTab} className="space-y-4">
        <TabsList label="Campaign Detail Sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="template">Template & Content</TabsTrigger>
          <TabsTrigger value="audience">Audience & Compliance</TabsTrigger>
          <TabsTrigger value="history">Execution History</TabsTrigger>
        </TabsList>

        {/* Tab 1: Overview */}
        <TabsContent value="overview">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5">
              <h2 className="text-sm font-semibold text-[var(--color-ink)]">
                Campaign Configuration
              </h2>
              <dl className="mt-4 divide-y divide-[var(--color-border-subtle)] text-xs">
                <div className="flex justify-between py-2.5">
                  <dt className="text-[var(--color-ink-muted)]">Workspace</dt>
                  <dd className="font-mono font-medium text-[var(--color-ink)]">
                    {campaign.workspaceId}
                  </dd>
                </div>
                <div className="flex justify-between py-2.5">
                  <dt className="text-[var(--color-ink-muted)]">Channel</dt>
                  <dd className="font-medium capitalize text-[var(--color-ink)]">
                    {campaign.channel}
                  </dd>
                </div>
                <div className="flex justify-between py-2.5">
                  <dt className="text-[var(--color-ink-muted)]">Recipient Source</dt>
                  <dd className="font-medium text-[var(--color-ink)]">
                    {campaign.recipientSource.segmentName || campaign.recipientSource.type}
                  </dd>
                </div>
                <div className="flex justify-between py-2.5">
                  <dt className="text-[var(--color-ink-muted)]">Schedule Mode</dt>
                  <dd className="font-medium capitalize text-[var(--color-ink)]">
                    {campaign.scheduleMode}
                  </dd>
                </div>
                <div className="flex justify-between py-2.5">
                  <dt className="text-[var(--color-ink-muted)]">Throttling Rate</dt>
                  <dd className="font-medium text-[var(--color-ink)]">
                    {campaign.throttling.rateLimitPerSecond} msg/second
                  </dd>
                </div>
                <div className="flex justify-between py-2.5">
                  <dt className="text-[var(--color-ink-muted)]">Max Attempts / Recipient</dt>
                  <dd className="font-medium text-[var(--color-ink)]">
                    {campaign.throttling.maxAttemptsPerRecipient ?? 1}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5">
              <h2 className="text-sm font-semibold text-[var(--color-ink)]">Execution Progress</h2>
              <div className="mt-4 space-y-4">
                <div>
                  <div className="flex justify-between text-xs font-medium text-[var(--color-ink)]">
                    <span>Dispatch Completion</span>
                    <span>{dispatchProgress}%</span>
                  </div>
                  <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-raised)]">
                    <div
                      className="h-full bg-acc-primary transition-all duration-300"
                      style={{ width: `${dispatchProgress}%` }}
                    />
                  </div>
                </div>

                <div>
                  <div className="flex justify-between text-xs font-medium text-[var(--color-ink)]">
                    <span>Delivery Success Rate</span>
                    <span>{deliveryPercent}%</span>
                  </div>
                  <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-raised)]">
                    <div
                      className="h-full bg-emerald-500 transition-all duration-300"
                      style={{ width: `${deliveryPercent}%` }}
                    />
                  </div>
                </div>

                <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 text-xs text-[var(--color-ink-muted)]">
                  <p className="font-semibold text-[var(--color-ink)]">Status Summary:</p>
                  <p className="mt-1">
                    {campaign.status === 'completed'
                      ? 'Campaign dispatch and settlement completed. All recipient attempts have reached final terminal state.'
                      : campaign.status === 'running'
                        ? 'Campaign is currently actively dispatching through core Communication API orchestrator.'
                        : campaign.status === 'scheduled'
                          ? `Campaign is queued for scheduled dispatch at ${campaign.scheduledAt ? new Date(campaign.scheduledAt).toLocaleString() : 'designated time'}.`
                          : 'Campaign is currently paused or in draft state.'}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </TabsContent>

        {/* Tab 2: Template & Content */}
        <TabsContent value="template">
          <div className="space-y-6">
            <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-[var(--color-ink)]">
                    Template:{' '}
                    <span className="font-mono text-acc-primary">{campaign.templateName}</span>
                  </h2>
                  <p className="text-xs text-[var(--color-ink-muted)]">ID: {campaign.templateId}</p>
                </div>
                <CampaignChannelBadge channel={campaign.channel} />
              </div>

              <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
                <div>
                  <h3 className="text-xs font-semibold text-[var(--color-ink-muted)]">
                    Raw Template Body
                  </h3>
                  <div className="mt-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 font-mono text-xs text-[var(--color-ink)] whitespace-pre-wrap">
                    {campaign.templateBody}
                  </div>
                </div>

                <div>
                  <h3 className="text-xs font-semibold text-[var(--color-ink-muted)]">
                    Rendered Preview (With Sample Variables)
                  </h3>
                  <div className="mt-2 rounded-lg border border-acc-border bg-acc-card p-4 text-xs text-[var(--color-ink)] shadow-xs">
                    <div className="rounded-md bg-acc-surface-raised p-3 leading-relaxed whitespace-pre-wrap">
                      {renderedMessageBody}
                    </div>
                  </div>
                </div>
              </div>

              {campaign.templateVariables && Object.keys(campaign.templateVariables).length > 0 && (
                <div className="mt-4 border-t border-[var(--color-border-subtle)] pt-4">
                  <h3 className="text-xs font-semibold text-[var(--color-ink-muted)]">
                    Interpolated Variables
                  </h3>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {Object.entries(campaign.templateVariables).map(([k, v]) => (
                      <span
                        key={k}
                        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-xs"
                      >
                        <code className="font-mono text-acc-primary">{`{{${k}}}`}</code>
                        <span className="text-[var(--color-ink-muted)]">→</span>
                        <span className="font-medium text-[var(--color-ink)]">{v}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        {/* Tab 3: Audience & Compliance */}
        <TabsContent value="audience">
          <div className="space-y-6">
            <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5">
              <h2 className="text-sm font-semibold text-[var(--color-ink)]">Target Audience</h2>
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
                  <div className="text-xs text-[var(--color-ink-muted)]">Audience Segment</div>
                  <div className="mt-1 text-sm font-semibold text-[var(--color-ink)]">
                    {campaign.recipientSource.segmentName || campaign.recipientSource.type}
                  </div>
                </div>
                <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
                  <div className="text-xs text-[var(--color-ink-muted)]">Filter Tag</div>
                  <div className="mt-1 text-sm font-semibold text-[var(--color-ink)]">
                    {campaign.recipientSource.tag ? (
                      <span className="inline-block rounded bg-acc-primary/10 px-2 py-0.5 text-xs text-acc-primary">
                        {campaign.recipientSource.tag}
                      </span>
                    ) : (
                      'None (All Contacts)'
                    )}
                  </div>
                </div>
                <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
                  <div className="text-xs text-[var(--color-ink-muted)]">Audience Pool Size</div>
                  <div className="mt-1 text-sm font-semibold text-[var(--color-ink)]">
                    {campaign.recipientSource.contactCount.toLocaleString()} contacts
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5">
              <h2 className="text-sm font-semibold text-[var(--color-ink)]">
                Mandatory Compliance Invariants
              </h2>
              <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
                Per ACC Architecture (ARCHITECTURE.md §11, §12, §14), campaigns are callers of core
                communication APIs and must strictly satisfy all compliance gates:
              </p>
              <ul className="mt-3 space-y-2 text-xs text-[var(--color-ink)]">
                <li className="flex items-start gap-2">
                  <span className="text-emerald-500">✓</span>
                  <span>
                    <strong>Consent Verification Gate:</strong> Latest valid opt-in consent record
                    is verified per recipient before dispatch attempt.
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-emerald-500">✓</span>
                  <span>
                    <strong>Suppression List Filtering:</strong> Unsubscribed or suppressed phone
                    numbers/emails are filtered automatically.
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-emerald-500">✓</span>
                  <span>
                    <strong>Rate-Limiting & Throttling:</strong> Outbound dispatch adheres to
                    tenant-configured limits ({campaign.throttling.rateLimitPerSecond} msg/s).
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-emerald-500">✓</span>
                  <span>
                    <strong>DLT & Sender Registration:</strong> Channel pre-registration and
                    approved template binding enforced prior to dispatch.
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </TabsContent>

        {/* Tab 4: Execution History */}
        <TabsContent value="history">
          <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5">
            <h2 className="text-sm font-semibold text-[var(--color-ink)]">
              Campaign Execution Log
            </h2>
            <div className="mt-4 space-y-4">
              <div className="relative pl-6 before:absolute before:left-2 before:top-2 before:bottom-0 before:w-0.5 before:bg-[var(--color-border-subtle)]">
                <div className="relative mb-4">
                  <div className="absolute -left-6 top-1 size-2 rounded-full bg-acc-primary ring-4 ring-[var(--color-surface)]" />
                  <div className="text-xs font-semibold text-[var(--color-ink)]">
                    Campaign Created
                  </div>
                  <div className="text-[11px] text-[var(--color-ink-muted)]">
                    {new Date(campaign.createdAt).toLocaleString()} · Initial configuration
                    validated
                  </div>
                </div>

                {campaign.scheduledAt && (
                  <div className="relative mb-4">
                    <div className="absolute -left-6 top-1 size-2 rounded-full bg-amber-400 ring-4 ring-[var(--color-surface)]" />
                    <div className="text-xs font-semibold text-[var(--color-ink)]">
                      Scheduled Execution Arming
                    </div>
                    <div className="text-[11px] text-[var(--color-ink-muted)]">
                      {new Date(campaign.scheduledAt).toLocaleString()} · Waiting for scheduled
                      dispatch window
                    </div>
                  </div>
                )}

                {campaign.metrics.sent > 0 && (
                  <div className="relative mb-4">
                    <div className="absolute -left-6 top-1 size-2 rounded-full bg-blue-500 ring-4 ring-[var(--color-surface)]" />
                    <div className="text-xs font-semibold text-[var(--color-ink)]">
                      Dispatch Started
                    </div>
                    <div className="text-[11px] text-[var(--color-ink-muted)]">
                      {campaign.metrics.sent.toLocaleString()} messages dispatched via Communication
                      API orchestrator
                    </div>
                  </div>
                )}

                {campaign.completedAt && (
                  <div className="relative">
                    <div className="absolute -left-6 top-1 size-2 rounded-full bg-emerald-500 ring-4 ring-[var(--color-surface)]" />
                    <div className="text-xs font-semibold text-[var(--color-ink)]">
                      Execution Completed
                    </div>
                    <div className="text-[11px] text-[var(--color-ink-muted)]">
                      {new Date(campaign.completedAt).toLocaleString()} ·{' '}
                      {campaign.metrics.delivered.toLocaleString()} delivered ({deliveryPercent}%)
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
