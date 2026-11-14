'use client';

import { StatusBadge, type BadgeVariant } from '@/components/ui/badge';
import {
  getJourneyStatusLabel,
  getJourneyVersionStatusLabel,
  getTriggerKindLabel,
  type JourneyExecutionStatus,
  type JourneyStatus,
  type JourneyTriggerRecord,
  type JourneyVersionStatus,
} from '@/lib/journeys';

export interface JourneyStatusBadgeProps {
  readonly status: JourneyStatus;
  readonly className?: string;
}

export function getJourneyStatusTone(status: JourneyStatus): BadgeVariant {
  switch (status) {
    case 'active':
      return 'success';
    case 'draft':
      return 'neutral';
    case 'paused':
      return 'warning';
    case 'archived':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/**
 * U15.1 compliant StatusBadge wrapper for Journey lifecycle statuses.
 */
export function JourneyStatusBadge({ status, className }: JourneyStatusBadgeProps) {
  const tone = getJourneyStatusTone(status);
  const label = getJourneyStatusLabel(status);

  return (
    <StatusBadge variant={tone} label={label} srPrefix="Journey Status" className={className} />
  );
}

export interface JourneyVersionStatusBadgeProps {
  readonly status: JourneyVersionStatus;
  readonly className?: string;
}

export function getJourneyVersionStatusTone(status: JourneyVersionStatus): BadgeVariant {
  switch (status) {
    case 'published':
      return 'success';
    case 'draft':
      return 'accent';
    case 'retired':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/**
 * U15.1 compliant StatusBadge wrapper for Journey Version statuses.
 */
export function JourneyVersionStatusBadge({ status, className }: JourneyVersionStatusBadgeProps) {
  const tone = getJourneyVersionStatusTone(status);
  const label = getJourneyVersionStatusLabel(status);

  return (
    <StatusBadge variant={tone} label={label} srPrefix="Version Status" className={className} />
  );
}

export interface JourneyExecutionStatusBadgeProps {
  readonly status: JourneyExecutionStatus;
  readonly className?: string;
}

export function getJourneyExecutionStatusTone(status: JourneyExecutionStatus): BadgeVariant {
  switch (status) {
    case 'running':
      return 'accent';
    case 'waiting':
      return 'warning';
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'cancelled':
    case 'exited':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function getJourneyExecutionStatusLabel(status: JourneyExecutionStatus): string {
  switch (status) {
    case 'running':
      return 'Running';
    case 'waiting':
      return 'Waiting';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'exited':
      return 'Exited';
    default:
      return status;
  }
}

/**
 * U15.1 compliant StatusBadge wrapper for Journey Execution statuses.
 */
export function JourneyExecutionStatusBadge({
  status,
  className,
}: JourneyExecutionStatusBadgeProps) {
  const tone = getJourneyExecutionStatusTone(status);
  const label = getJourneyExecutionStatusLabel(status);

  return (
    <StatusBadge variant={tone} label={label} srPrefix="Execution Status" className={className} />
  );
}

export interface JourneyTriggerBadgeProps {
  readonly trigger: JourneyTriggerRecord | null;
  readonly className?: string;
}

/**
 * Visual badge for Journey trigger registration and status.
 */
export function JourneyTriggerBadge({ trigger, className }: JourneyTriggerBadgeProps) {
  if (!trigger) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-full border border-acc-border bg-acc-surface px-2 py-0.5 text-[11px] text-acc-text-tertiary ${className || ''}`}
      >
        No trigger
      </span>
    );
  }

  const kindLabel = getTriggerKindLabel(trigger.kind);
  const statusTone =
    trigger.status === 'active'
      ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
      : 'text-acc-text-secondary bg-acc-surface-raised border-acc-border';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusTone} ${className || ''}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${trigger.status === 'active' ? 'bg-emerald-400' : 'bg-acc-text-tertiary'}`}
        aria-hidden="true"
      />
      {kindLabel}
    </span>
  );
}
