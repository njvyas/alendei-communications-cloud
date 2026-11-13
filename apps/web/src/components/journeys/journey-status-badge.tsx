'use client';

import { StatusBadge, type BadgeVariant } from '@/components/ui/badge';
import {
  getJourneyStatusLabel,
  getJourneyVersionStatusLabel,
  type JourneyExecutionStatus,
  type JourneyStatus,
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
