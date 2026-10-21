'use client';

import { useState, useEffect, type FormEvent } from 'react';
import {
  providerAssignmentsApi,
  type ChannelView,
  type OrganizationProviderAssignment,
  type ProviderView,
  type AssignmentStatus,
} from '@/lib/api-client';
import { humanizeApiError } from '@/lib/error-mapping';
import { AccessibleDialog } from '@/components/ui/dialog';
import { ActionFeedback, type ActionFeedbackMessage } from '@/components/ui/action-feedback';

// -----------------------------------------------------------------------------
// 1. Assign Provider Dialog
// -----------------------------------------------------------------------------

export interface AssignProviderDialogProps {
  readonly isOpen: boolean;
  readonly orgId: string;
  readonly providers: readonly ProviderView[];
  readonly channels: readonly ChannelView[];
  readonly existingAssignments: readonly OrganizationProviderAssignment[];
  readonly onClose: () => void;
  readonly onSuccess: (created: OrganizationProviderAssignment) => void;
}

export function AssignProviderDialog({
  isOpen,
  orgId,
  providers,
  channels,
  existingAssignments,
  onClose,
  onSuccess,
}: AssignProviderDialogProps) {
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [priority, setPriority] = useState<number | ''>(1);
  const [status, setStatus] = useState<AssignmentStatus>('active');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<ActionFeedbackMessage | null>(null);

  // Filter out providers already assigned to this organization
  const assignedProviderIds = new Set(existingAssignments.map((a) => a.providerId));
  const availableProviders = providers.filter((p) => !assignedProviderIds.has(p.id));

  // Channels lookup map
  const channelMap = new Map(channels.map((c) => [c.id, c.displayName]));

  // Selected provider details
  const selectedProvider = providers.find((p) => p.id === selectedProviderId);
  const selectedChannelId = selectedProvider?.channelId;

  // Existing priorities for the selected channel
  const channelPriorities = selectedChannelId
    ? existingAssignments
        .filter((a) => a.channelId === selectedChannelId)
        .map((a) => a.priority)
        .sort((a, b) => a - b)
    : [];

  useEffect(() => {
    if (isOpen) {
      const firstAvailable = availableProviders[0]?.id ?? '';
      setSelectedProviderId(firstAvailable);
      setStatus('active');
      setFeedback(null);
      setIsSubmitting(false);

      // Determine initial suggested priority
      if (firstAvailable) {
        const prov = providers.find((p) => p.id === firstAvailable);
        if (prov) {
          const used = existingAssignments
            .filter((a) => a.channelId === prov.channelId)
            .map((a) => a.priority);
          let nextP = 1;
          while (used.includes(nextP)) nextP++;
          setPriority(nextP);
        } else {
          setPriority(1);
        }
      } else {
        setPriority(1);
      }
    }
  }, [isOpen]);

  const handleProviderChange = (newProviderId: string) => {
    setSelectedProviderId(newProviderId);
    setFeedback(null);
    const prov = providers.find((p) => p.id === newProviderId);
    if (prov) {
      const used = existingAssignments
        .filter((a) => a.channelId === prov.channelId)
        .map((a) => a.priority);
      let nextP = 1;
      while (used.includes(nextP)) nextP++;
      setPriority(nextP);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFeedback(null);

    if (!selectedProviderId) {
      setFeedback({
        type: 'error',
        title: 'Provider Required',
        message: 'Please select a platform provider to assign.',
      });
      return;
    }

    const numPriority = Number(priority);
    if (!Number.isInteger(numPriority) || numPriority < 1) {
      setFeedback({
        type: 'error',
        title: 'Invalid Priority',
        message: 'Priority must be an integer of 1 or greater.',
      });
      return;
    }

    if (channelPriorities.includes(numPriority)) {
      setFeedback({
        type: 'error',
        title: 'Priority Collision',
        message: `Priority ${numPriority} is already assigned to another provider for this channel. Choose a different priority number.`,
      });
      return;
    }

    try {
      setIsSubmitting(true);
      const res = await providerAssignmentsApi.create(orgId, {
        providerId: selectedProviderId,
        priority: numPriority,
        status,
      });
      onSuccess(res.data);
      onClose();
    } catch (err) {
      const humanized = humanizeApiError(err, 'Failed to assign provider');
      setFeedback({
        type: 'error',
        title: humanized.title,
        message: humanized.message,
        code: humanized.code,
        correlationId: humanized.correlationId,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AccessibleDialog
      isOpen={isOpen}
      onClose={onClose}
      titleId="assign-provider-title"
      descriptionId="assign-provider-desc"
    >
      <div className="space-y-4">
        <div>
          <h2
            id="assign-provider-title"
            className="text-base font-semibold tracking-tight text-[var(--color-ink)]"
          >
            Assign Provider
          </h2>
          <p id="assign-provider-desc" className="mt-1 text-xs text-[var(--color-ink-muted)]">
            Add a platform provider to this organization&apos;s candidate routing list for outbound
            messages.
          </p>
        </div>

        <ActionFeedback feedback={feedback} onDismiss={() => setFeedback(null)} />

        {availableProviders.length === 0 ? (
          <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-4 text-center">
            <p className="text-xs text-[var(--color-ink-muted)]">
              All active platform providers are already assigned to this organization.
            </p>
            <div className="mt-4">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="assign-provider-select"
                className="block text-xs font-medium text-[var(--color-ink)]"
              >
                Platform Provider <span className="text-[var(--color-bad)]">*</span>
              </label>
              <select
                id="assign-provider-select"
                value={selectedProviderId}
                onChange={(e) => handleProviderChange(e.target.value)}
                disabled={isSubmitting}
                className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
              >
                {availableProviders.map((p) => {
                  const channelName = channelMap.get(p.channelId) ?? p.channelCode;
                  return (
                    <option key={p.id} value={p.id}>
                      {p.name} ({channelName} · {p.adapterKey})
                    </option>
                  );
                })}
              </select>
            </div>

            <div>
              <label
                htmlFor="assign-priority-input"
                className="block text-xs font-medium text-[var(--color-ink)]"
              >
                Candidate Priority <span className="text-[var(--color-bad)]">*</span>
              </label>
              <input
                id="assign-priority-input"
                type="number"
                min={1}
                step={1}
                value={priority}
                onChange={(e) =>
                  setPriority(e.target.value === '' ? '' : parseInt(e.target.value, 10))
                }
                disabled={isSubmitting}
                className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs font-mono text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
              />
              <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
                {channelPriorities.length > 0
                  ? `Priorities currently used for this channel: ${channelPriorities.join(', ')}. Lower values are dispatched first.`
                  : 'Lower values are dispatched first. Priority 1 is evaluated before Priority 2.'}
              </p>
            </div>

            <div>
              <label
                htmlFor="assign-status-select"
                className="block text-xs font-medium text-[var(--color-ink)]"
              >
                Initial Status
              </label>
              <select
                id="assign-status-select"
                value={status}
                onChange={(e) => setStatus(e.target.value as AssignmentStatus)}
                disabled={isSubmitting}
                className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
              >
                <option value="active">Active (available for immediate routing)</option>
                <option value="disabled">Disabled (held in reserve, not routed)</option>
              </select>
            </div>

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-[var(--color-border-subtle)]">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || !selectedProviderId}
                className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {isSubmitting ? 'Assigning…' : 'Assign Provider'}
              </button>
            </div>
          </form>
        )}
      </div>
    </AccessibleDialog>
  );
}

// -----------------------------------------------------------------------------
// 2. Update Priority Dialog
// -----------------------------------------------------------------------------

export interface UpdatePriorityDialogProps {
  readonly isOpen: boolean;
  readonly orgId: string;
  readonly assignment: OrganizationProviderAssignment | null;
  readonly providerName: string;
  readonly channelName: string;
  readonly otherPrioritiesForChannel: readonly number[];
  readonly onClose: () => void;
  readonly onSuccess: (updated: OrganizationProviderAssignment) => void;
}

export function UpdatePriorityDialog({
  isOpen,
  orgId,
  assignment,
  providerName,
  channelName,
  otherPrioritiesForChannel,
  onClose,
  onSuccess,
}: UpdatePriorityDialogProps) {
  const [priority, setPriority] = useState<number | ''>(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<ActionFeedbackMessage | null>(null);

  useEffect(() => {
    if (isOpen && assignment) {
      setPriority(assignment.priority);
      setFeedback(null);
      setIsSubmitting(false);
    }
  }, [isOpen, assignment]);

  if (!assignment) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFeedback(null);

    const numPriority = Number(priority);
    if (!Number.isInteger(numPriority) || numPriority < 1) {
      setFeedback({
        type: 'error',
        title: 'Invalid Priority',
        message: 'Priority must be an integer of 1 or greater.',
      });
      return;
    }

    if (numPriority === assignment.priority) {
      onClose();
      return;
    }

    if (otherPrioritiesForChannel.includes(numPriority)) {
      setFeedback({
        type: 'error',
        title: 'Priority Collision',
        message: `Priority ${numPriority} is already assigned to another provider for ${channelName}. Choose an unused priority number.`,
      });
      return;
    }

    try {
      setIsSubmitting(true);
      const res = await providerAssignmentsApi.update(orgId, assignment.id, {
        priority: numPriority,
      });
      onSuccess(res.data);
      onClose();
    } catch (err) {
      const humanized = humanizeApiError(err, 'Failed to update priority');
      setFeedback({
        type: 'error',
        title: humanized.title,
        message: humanized.message,
        code: humanized.code,
        correlationId: humanized.correlationId,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AccessibleDialog
      isOpen={isOpen}
      onClose={onClose}
      titleId="update-priority-title"
      descriptionId="update-priority-desc"
    >
      <div className="space-y-4">
        <div>
          <h2
            id="update-priority-title"
            className="text-base font-semibold tracking-tight text-[var(--color-ink)]"
          >
            Change Routing Priority
          </h2>
          <p id="update-priority-desc" className="mt-1 text-xs text-[var(--color-ink-muted)]">
            Update evaluation precedence for {providerName} on the {channelName} channel.
          </p>
        </div>

        <ActionFeedback feedback={feedback} onDismiss={() => setFeedback(null)} />

        <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 text-xs">
          <div className="flex justify-between py-1">
            <span className="text-[var(--color-ink-muted)]">Provider</span>
            <span className="font-semibold text-[var(--color-ink)]">{providerName}</span>
          </div>
          <div className="flex justify-between py-1 border-t border-[var(--color-border-subtle)]">
            <span className="text-[var(--color-ink-muted)]">Channel</span>
            <span className="text-[var(--color-ink)]">{channelName}</span>
          </div>
          <div className="flex justify-between py-1 border-t border-[var(--color-border-subtle)]">
            <span className="text-[var(--color-ink-muted)]">Current Priority</span>
            <span className="font-mono text-[var(--color-ink)]">#{assignment.priority}</span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="update-priority-input"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              New Priority <span className="text-[var(--color-bad)]">*</span>
            </label>
            <input
              id="update-priority-input"
              type="number"
              min={1}
              step={1}
              value={priority}
              onChange={(e) =>
                setPriority(e.target.value === '' ? '' : parseInt(e.target.value, 10))
              }
              disabled={isSubmitting}
              className="mt-1 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs font-mono text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] disabled:opacity-50"
            />
            <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
              {otherPrioritiesForChannel.length > 0
                ? `Other in-use priorities for this channel: ${otherPrioritiesForChannel.join(', ')}. Lower values are evaluated first.`
                : 'Lower values are evaluated first. Priority 1 is evaluated before Priority 2.'}
            </p>
          </div>

          <div className="flex items-center justify-end gap-3 pt-3 border-t border-[var(--color-border-subtle)]">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || priority === ''}
              className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? 'Saving…' : 'Save Priority'}
            </button>
          </div>
        </form>
      </div>
    </AccessibleDialog>
  );
}

// -----------------------------------------------------------------------------
// 3. Toggle Status Confirmation Dialog (Enable / Disable)
// -----------------------------------------------------------------------------

export interface ToggleAssignmentDialogProps {
  readonly isOpen: boolean;
  readonly orgId: string;
  readonly assignment: OrganizationProviderAssignment | null;
  readonly providerName: string;
  readonly channelName: string;
  readonly action: 'enable' | 'disable';
  readonly onClose: () => void;
  readonly onSuccess: (updated: OrganizationProviderAssignment) => void;
}

export function ToggleAssignmentDialog({
  isOpen,
  orgId,
  assignment,
  providerName,
  channelName,
  action,
  onClose,
  onSuccess,
}: ToggleAssignmentDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<ActionFeedbackMessage | null>(null);

  useEffect(() => {
    if (isOpen) {
      setFeedback(null);
      setIsSubmitting(false);
    }
  }, [isOpen]);

  if (!assignment) return null;

  const isDisable = action === 'disable';

  const handleConfirm = async () => {
    setFeedback(null);
    try {
      setIsSubmitting(true);
      const res = isDisable
        ? await providerAssignmentsApi.disable(orgId, assignment.id)
        : await providerAssignmentsApi.enable(orgId, assignment.id);
      onSuccess(res.data);
      onClose();
    } catch (err) {
      const humanized = humanizeApiError(
        err,
        isDisable ? 'Failed to disable assignment' : 'Failed to enable assignment',
      );
      setFeedback({
        type: 'error',
        title: humanized.title,
        message: humanized.message,
        code: humanized.code,
        correlationId: humanized.correlationId,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AccessibleDialog
      isOpen={isOpen}
      onClose={onClose}
      titleId="toggle-assignment-title"
      descriptionId="toggle-assignment-desc"
    >
      <div className="space-y-4">
        <div>
          <h2
            id="toggle-assignment-title"
            className="text-base font-semibold tracking-tight text-[var(--color-ink)]"
          >
            {isDisable ? 'Disable Provider Assignment' : 'Enable Provider Assignment'}
          </h2>
          <p id="toggle-assignment-desc" className="mt-1 text-xs text-[var(--color-ink-muted)]">
            {isDisable
              ? `Disabling this provider will remove it from the active candidate routing set for ${channelName}.`
              : `Enabling this provider will restore it to the active candidate routing set for ${channelName}.`}
          </p>
        </div>

        <ActionFeedback feedback={feedback} onDismiss={() => setFeedback(null)} />

        <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 text-xs">
          <div className="flex justify-between py-1">
            <span className="text-[var(--color-ink-muted)]">Provider</span>
            <span className="font-semibold text-[var(--color-ink)]">{providerName}</span>
          </div>
          <div className="flex justify-between py-1 border-t border-[var(--color-border-subtle)]">
            <span className="text-[var(--color-ink-muted)]">Channel</span>
            <span className="text-[var(--color-ink)]">{channelName}</span>
          </div>
          <div className="flex justify-between py-1 border-t border-[var(--color-border-subtle)]">
            <span className="text-[var(--color-ink-muted)]">Priority</span>
            <span className="font-mono text-[var(--color-ink)]">#{assignment.priority}</span>
          </div>
        </div>

        {isDisable ? (
          <div className="rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]">
            <p className="font-semibold">Routing Impact Warning</p>
            <p className="mt-0.5 leading-relaxed">
              Outbound messages for this organization will no longer attempt dispatch through{' '}
              {providerName}. If this is the only active provider for {channelName}, outbound
              messages will fail dispatch.
            </p>
          </div>
        ) : (
          <div className="rounded-md border border-[var(--color-accent)]/20 bg-[var(--color-accent)]/10 p-3 text-xs text-[var(--color-ink)]">
            <p className="font-semibold">Reinstating Provider</p>
            <p className="mt-0.5 leading-relaxed">
              {providerName} will become an active routing candidate for {channelName} with priority
              #{assignment.priority}.
            </p>
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-3 border-t border-[var(--color-border-subtle)]">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isSubmitting}
            className={`rounded-md px-4 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50 ${
              isDisable ? 'bg-[var(--color-bad)]' : 'bg-[var(--color-accent)]'
            }`}
          >
            {isSubmitting
              ? isDisable
                ? 'Disabling…'
                : 'Enabling…'
              : isDisable
                ? 'Disable Assignment'
                : 'Enable Assignment'}
          </button>
        </div>
      </div>
    </AccessibleDialog>
  );
}
