'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TemplateResponse } from '@acc/contracts';
import { campaignsApi, contactsApi, templatesApi } from '@/lib/api-client';
import {
  ALL_CAMPAIGN_CHANNELS,
  BACKEND_CAMPAIGN_SUPPORT_STATUS,
  getChannelDisplayName,
  type CampaignChannel,
  type CampaignRecord,
  type CampaignRecipientSourceType,
  type CampaignScheduleMode,
} from '@/lib/campaigns';
import { RECOMMENDED_CDP_TAGS } from '@/lib/cdp';
import { useModalDialog } from '@/components/ui/dialog';
import { toast } from '@/lib/toast';

export interface CampaignCreateDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly workspaces: readonly { readonly id: string; readonly name: string }[];
  readonly defaultWorkspaceId?: string;
  readonly onCreated?: (campaign: CampaignRecord) => void;
}

export function CampaignCreateDialog({
  open,
  onOpenChange,
  workspaces,
  defaultWorkspaceId = '',
  onCreated,
}: CampaignCreateDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId || workspaces[0]?.id || '');
  const [channel, setChannel] = useState<CampaignChannel>('whatsapp');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [recipientSourceType, setRecipientSourceType] =
    useState<CampaignRecipientSourceType>('all_contacts');
  const [selectedTag, setSelectedTag] = useState<string>(RECOMMENDED_CDP_TAGS[0] ?? 'VIP');
  const [customTag, setCustomTag] = useState('');
  const [scheduleMode, setScheduleMode] = useState<CampaignScheduleMode>('immediate');
  const [scheduledAt, setScheduledAt] = useState<string>('');
  const [rateLimitPerSecond, setRateLimitPerSecond] = useState<number>(25);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const effectiveWorkspaceId = workspaceId || workspaces[0]?.id || '';

  // Query contacts in the selected workspace to evaluate defensible audience count
  const { data: contactsData, isLoading: isContactsLoading } = useQuery({
    queryKey: ['contacts', 'list', effectiveWorkspaceId, { limit: 100 }],
    queryFn: ({ signal }) => contactsApi.list(effectiveWorkspaceId, { limit: 100 }, signal),
    enabled: open && Boolean(effectiveWorkspaceId),
  });

  // Fetch real templates available in the tenant
  const { data: templatesData, isLoading: isTemplatesLoading } = useQuery({
    queryKey: ['templates', 'list', { limit: 50 }],
    queryFn: ({ signal }) => templatesApi.list({ limit: 50 }, signal),
    enabled: open,
  });

  const templates: readonly TemplateResponse[] = templatesData?.data ?? [];
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);

  const modal = useModalDialog(open);

  if (!open) return null;

  const handleClose = () => {
    setName('');
    setDescription('');
    setSelectedTemplateId('');
    setRecipientSourceType('all_contacts');
    setCustomTag('');
    setScheduleMode('immediate');
    setScheduledAt('');
    setErrorMessage(null);
    onOpenChange(false);
  };

  const effectiveTag = selectedTag === 'custom' ? customTag.trim() : selectedTag;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setErrorMessage('Please enter a campaign name.');
      return;
    }

    const effectiveWorkspaceId = workspaceId || workspaces[0]?.id;
    if (!effectiveWorkspaceId) {
      setErrorMessage('Please select a workspace for this campaign.');
      return;
    }

    if (!selectedTemplateId && templates.length > 0) {
      setErrorMessage('Please select a message template.');
      return;
    }

    if (scheduleMode === 'scheduled' && !scheduledAt) {
      setErrorMessage('Please specify the scheduled date and time.');
      return;
    }

    try {
      setIsSubmitting(true);

      const templateName = selectedTemplate?.name ?? `${channel}_campaign_template`;
      const templateBody =
        selectedTemplate?.body ??
        `Special campaign update for our valued customers. Reply STOP to opt out.`;

      // Defensible contact count: only established if all_contacts is chosen and contactsApi enumerated all without truncation
      const defensibleCount =
        recipientSourceType === 'all_contacts' && contactsData?.page?.nextCursor === null
          ? contactsData.data.length
          : null;

      const recipientSource = {
        type: recipientSourceType,
        tag: recipientSourceType === 'tag_segment' ? effectiveTag : undefined,
        contactCount: defensibleCount,
        segmentName:
          recipientSourceType === 'all_contacts'
            ? 'All Workspace Contacts'
            : recipientSourceType === 'tag_segment'
              ? `Segment: ${effectiveTag}`
              : 'Custom Target List',
      };

      const res = await campaignsApi.create({
        workspaceId: effectiveWorkspaceId,
        name: trimmedName,
        description: description.trim() || undefined,
        channel,
        templateId: selectedTemplateId || 'tmpl-preview-custom',
        templateName,
        templateBody,
        recipientSource,
        scheduleMode,
        scheduledAt: scheduleMode === 'scheduled' ? new Date(scheduledAt).toISOString() : null,
        throttling: {
          rateLimitPerSecond,
          maxAttemptsPerRecipient: 1,
        },
      });

      toast.success(
        'Campaign Created (Preview)',
        `Campaign "${res.data.name}" was created in local preview mode.`,
      );

      onCreated?.(res.data);
      handleClose();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to create campaign');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs focus:outline-none"
      {...modal.overlayProps(handleClose, !isSubmitting)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="campaign-create-title"
    >
      <div
        ref={modal.panelRef}
        tabIndex={-1}
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
          <div>
            <h2
              id="campaign-create-title"
              className="text-base font-semibold text-[var(--color-ink)]"
            >
              Create Campaign
            </h2>
            <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
              Configure broadcast parameters, template, audience targeting, and schedule.
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded p-1 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        {/* Missing backend support notice banner */}
        <div className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
          <p className="font-semibold text-amber-950 dark:text-amber-300">
            ⚠️ Phase 8B Frontend Preview
          </p>
          <p className="mt-1 text-amber-900/90 dark:text-amber-200/90">
            {BACKEND_CAMPAIGN_SUPPORT_STATUS.notice}
          </p>
          <p className="mt-1.5 text-amber-900/80 dark:text-amber-200/80">
            <strong>Phase 7 Billing Dependency:</strong> Wallet reservation and per-message debit
            enforcement are pending Phase 7 backend implementation and are unavailable in this
            preview.
          </p>
        </div>

        {errorMessage && (
          <div
            className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-400"
            role="alert"
          >
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {/* Campaign Name */}
          <div>
            <label
              htmlFor="campaign-name"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Campaign Name <span className="text-rose-500">*</span>
            </label>
            <input
              id="campaign-name"
              type="text"
              required
              aria-required="true"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Diwali Flash Sale 2026"
              className="mt-1.5 w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:border-acc-primary focus:outline-none"
            />
          </div>

          {/* Description */}
          <div>
            <label
              htmlFor="campaign-description"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Description (Optional)
            </label>
            <textarea
              id="campaign-description"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Promotional offer broadcast to active loyalty members."
              className="mt-1.5 w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm text-[var(--color-ink)] placeholder-[var(--color-ink-muted)] focus:border-acc-primary focus:outline-none"
            />
          </div>

          {/* Workspace and Channel Grid */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="campaign-workspace"
                className="block text-xs font-medium text-[var(--color-ink)]"
              >
                Workspace <span className="text-rose-500">*</span>
              </label>
              <select
                id="campaign-workspace"
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm text-[var(--color-ink)] focus:border-acc-primary focus:outline-none"
              >
                {workspaces.map((ws) => (
                  <option key={ws.id} value={ws.id}>
                    {ws.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="campaign-channel"
                className="block text-xs font-medium text-[var(--color-ink)]"
              >
                Channel <span className="text-rose-500">*</span>
              </label>
              <select
                id="campaign-channel"
                value={channel}
                onChange={(e) => setChannel(e.target.value as CampaignChannel)}
                className="mt-1.5 w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm text-[var(--color-ink)] focus:border-acc-primary focus:outline-none"
              >
                {ALL_CAMPAIGN_CHANNELS.map((ch) => (
                  <option key={ch} value={ch}>
                    {getChannelDisplayName(ch)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Template Selection */}
          <div>
            <label
              htmlFor="campaign-template"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Message Template <span className="text-rose-500">*</span>
            </label>
            {isTemplatesLoading ? (
              <div role="status" className="mt-1.5 text-xs text-[var(--color-ink-muted)]">
                Loading templates...
              </div>
            ) : templates.length > 0 ? (
              <select
                id="campaign-template"
                value={selectedTemplateId}
                onChange={(e) => setSelectedTemplateId(e.target.value)}
                className="mt-1.5 w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm text-[var(--color-ink)] focus:border-acc-primary focus:outline-none"
              >
                <option value="">Select a registered template...</option>
                {templates.map((tmpl) => (
                  <option key={tmpl.id} value={tmpl.id}>
                    {tmpl.name} ({tmpl.approvalStatus})
                  </option>
                ))}
              </select>
            ) : (
              <div className="mt-1.5 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 text-xs text-[var(--color-ink-muted)]">
                No templates found in active organization. A default preview template will be
                generated.
              </div>
            )}

            {selectedTemplate && (
              <div className="mt-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
                <p className="text-xs font-semibold text-[var(--color-ink-muted)]">
                  Template Preview:
                </p>
                <p className="mt-1 font-mono text-xs text-[var(--color-ink)]">
                  {selectedTemplate.body}
                </p>
                {selectedTemplate.variables.length > 0 && (
                  <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
                    Variables:{' '}
                    {selectedTemplate.variables.map((v: string) => `{{${v}}}`).join(', ')}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Target Audience / Recipient Source */}
          <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4">
            <label className="block text-xs font-medium text-[var(--color-ink)]">
              Target Audience Selection
            </label>
            <div className="mt-2 space-y-3 text-xs">
              <label className="flex items-start gap-2 text-[var(--color-ink)] cursor-pointer">
                <input
                  type="radio"
                  name="recipientSource"
                  checked={recipientSourceType === 'all_contacts'}
                  onChange={() => setRecipientSourceType('all_contacts')}
                  className="mt-0.5 text-acc-primary"
                />
                <div>
                  <span className="font-medium">All Contacts in Workspace</span>
                  {isContactsLoading ? (
                    <div role="status" className="text-[11px] text-[var(--color-ink-muted)]">
                      Checking contact pool...
                    </div>
                  ) : contactsData?.page?.nextCursor === null ? (
                    <div className="text-[11px] text-emerald-600 dark:text-emerald-400">
                      {contactsData.data.length} contacts available in workspace
                    </div>
                  ) : (
                    <div className="text-[11px] text-amber-600 dark:text-amber-400">
                      Audience count unavailable — backend preview required
                    </div>
                  )}
                </div>
              </label>

              <label className="flex items-start gap-2 text-[var(--color-ink)] cursor-pointer">
                <input
                  type="radio"
                  name="recipientSource"
                  checked={recipientSourceType === 'tag_segment'}
                  onChange={() => setRecipientSourceType('tag_segment')}
                  className="mt-0.5 text-acc-primary"
                />
                <div>
                  <span className="font-medium">Segment by Contact Tag (CDP Tag)</span>
                  <div className="text-[11px] text-amber-600 dark:text-amber-400">
                    Audience count unavailable — backend preview required
                  </div>
                </div>
              </label>

              <label className="flex items-start gap-2 text-[var(--color-ink)] cursor-pointer">
                <input
                  type="radio"
                  name="recipientSource"
                  checked={recipientSourceType === 'custom_list'}
                  onChange={() => setRecipientSourceType('custom_list')}
                  className="mt-0.5 text-acc-primary"
                />
                <div>
                  <span className="font-medium">Custom Target List</span>
                  <div className="text-[11px] text-amber-600 dark:text-amber-400">
                    Audience count unavailable — backend preview required
                  </div>
                </div>
              </label>
            </div>

            {recipientSourceType === 'tag_segment' && (
              <div className="mt-3 border-t border-[var(--color-border-subtle)] pt-3">
                <label
                  htmlFor="campaign-tag-select"
                  className="block text-xs font-medium text-[var(--color-ink)]"
                >
                  Select CDP Tag
                </label>
                <select
                  id="campaign-tag-select"
                  value={selectedTag}
                  onChange={(e) => setSelectedTag(e.target.value)}
                  className="mt-1 w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-[var(--color-ink)] focus:border-acc-primary focus:outline-none"
                >
                  {RECOMMENDED_CDP_TAGS.map((t) => (
                    <option key={t} value={t}>
                      Tag: {t}
                    </option>
                  ))}
                  <option value="custom">Custom Tag...</option>
                </select>

                {selectedTag === 'custom' && (
                  <input
                    type="text"
                    aria-label="Custom tag name"
                    value={customTag}
                    onChange={(e) => setCustomTag(e.target.value)}
                    placeholder="Enter custom tag..."
                    className="mt-2 w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-[var(--color-ink)] focus:border-acc-primary focus:outline-none"
                  />
                )}
              </div>
            )}

            {recipientSourceType === 'custom_list' && (
              <div className="mt-3 border-t border-[var(--color-border-subtle)] pt-3">
                <p className="text-xs text-[var(--color-ink-muted)]">
                  Custom recipient lists and CSV imports will be processed by the Phase 8B backend
                  audience manifest engine.
                </p>
                <div className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                  Audience count unavailable — backend preview required
                </div>
              </div>
            )}
          </div>

          {/* Schedule & Throttling */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="campaign-schedule-mode"
                className="block text-xs font-medium text-[var(--color-ink)]"
              >
                Dispatch Schedule
              </label>
              <select
                id="campaign-schedule-mode"
                value={scheduleMode}
                onChange={(e) => setScheduleMode(e.target.value as CampaignScheduleMode)}
                className="mt-1.5 w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm text-[var(--color-ink)] focus:border-acc-primary focus:outline-none"
              >
                <option value="immediate">Immediate Dispatch</option>
                <option value="scheduled">Schedule for Future Time</option>
              </select>

              {scheduleMode === 'scheduled' && (
                <input
                  type="datetime-local"
                  aria-label="Scheduled dispatch time"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm text-[var(--color-ink)] focus:border-acc-primary focus:outline-none"
                />
              )}
            </div>

            <div>
              <label
                htmlFor="campaign-throttle-rate"
                className="block text-xs font-medium text-[var(--color-ink)]"
              >
                Send Throttle Rate ({rateLimitPerSecond} msg/sec)
              </label>
              <input
                id="campaign-throttle-rate"
                type="range"
                min={5}
                max={200}
                step={5}
                value={rateLimitPerSecond}
                onChange={(e) => setRateLimitPerSecond(Number(e.target.value))}
                className="mt-3 w-full accent-acc-primary"
              />
              <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
                Regulates outbound dispatch concurrency to preserve provider health.
              </p>
            </div>
          </div>

          {/* Compliance & Consent Invariant Notice */}
          <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 text-xs text-[var(--color-ink-muted)]">
            <span className="font-semibold text-[var(--color-ink)]">Compliance Invariant:</span>{' '}
            Every recipient is verified against tenant consent records and suppression lists at
            execution time (ARCHITECTURE.md §11, §12).
          </div>

          {/* Form Actions */}
          <div className="flex items-center justify-end gap-3 border-t border-[var(--color-border-subtle)] pt-4">
            <button
              type="button"
              onClick={handleClose}
              disabled={isSubmitting}
              className="rounded-lg border border-[var(--color-border-subtle)] px-4 py-2 text-sm font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-lg bg-acc-primary px-4 py-2 text-sm font-semibold text-white shadow-xs hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? 'Creating...' : 'Create Campaign (Preview)'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
