'use client';

import { AccessibleDialog } from '@/components/ui/dialog';
import type { SuppressionResponse, ChannelView } from '@/lib/api-client';
import { SuppressionStatusBadge } from './suppression-status-badge';

export interface SuppressionDetailDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly suppression: SuppressionResponse | null;
  readonly channels?: readonly ChannelView[];
}

export function SuppressionDetailDialog({
  isOpen,
  onClose,
  suppression,
  channels = [],
}: SuppressionDetailDialogProps) {
  if (!suppression) return null;

  const resolvedChannel = suppression.channelId
    ? (channels.find((c) => c.id === suppression.channelId)?.displayName ??
      channels.find((c) => c.id === suppression.channelId)?.code ??
      suppression.channelId)
    : 'All Channels (Organization-wide)';

  return (
    <AccessibleDialog
      isOpen={isOpen}
      onClose={onClose}
      titleId="suppression-detail-title"
      descriptionId="suppression-detail-desc"
      maxWidth="max-w-lg"
    >
      <div className="space-y-4">
        <div className="border-b border-[var(--color-border-subtle)] pb-3">
          <h2
            id="suppression-detail-title"
            className="text-base font-semibold text-[var(--color-ink)]"
          >
            Suppression Record Details
          </h2>
          <p id="suppression-detail-desc" className="text-xs text-[var(--color-ink-muted)]">
            Immutable recipient suppression metadata and audit state.
          </p>
        </div>

        <dl className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
          <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-2.5">
            <dt className="text-[var(--color-ink-muted)]">Status</dt>
            <dd className="mt-1">
              <SuppressionStatusBadge status={suppression.status} />
            </dd>
          </div>

          <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-2.5">
            <dt className="text-[var(--color-ink-muted)]">Channel Scope</dt>
            <dd className="mt-1 font-medium text-[var(--color-ink)]">{resolvedChannel}</dd>
          </div>

          <div className="col-span-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-2.5">
            <dt className="text-[var(--color-ink-muted)]">Recipient Address (Raw)</dt>
            <dd className="mt-1 font-mono text-sm font-semibold text-[var(--color-ink)] break-all">
              {suppression.rawAddress}
            </dd>
          </div>

          <div className="col-span-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-2.5">
            <dt className="text-[var(--color-ink-muted)]">Normalized Address</dt>
            <dd className="mt-1 font-mono text-sm text-[var(--color-ink-muted)] break-all">
              {suppression.normalizedAddress}
            </dd>
          </div>

          <div className="col-span-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-2.5">
            <dt className="text-[var(--color-ink-muted)]">Suppression Reason</dt>
            <dd className="mt-1 text-[var(--color-ink)] whitespace-pre-wrap break-words">
              {suppression.reason}
            </dd>
          </div>

          <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-2.5">
            <dt className="text-[var(--color-ink-muted)]">Created At</dt>
            <dd className="mt-1 font-mono text-[var(--color-ink)]">
              {new Date(suppression.createdAt).toLocaleString()}
            </dd>
          </div>

          <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-2.5">
            <dt className="text-[var(--color-ink-muted)]">Updated At</dt>
            <dd className="mt-1 font-mono text-[var(--color-ink)]">
              {new Date(suppression.updatedAt).toLocaleString()}
            </dd>
          </div>

          {suppression.status === 'cleared' && (
            <>
              <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-2.5">
                <dt className="text-[var(--color-ink-muted)]">Cleared At</dt>
                <dd className="mt-1 font-mono text-[var(--color-ink)]">
                  {suppression.clearedAt ? new Date(suppression.clearedAt).toLocaleString() : '—'}
                </dd>
              </div>

              <div className="col-span-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-2.5">
                <dt className="text-[var(--color-ink-muted)]">Cleared Reason</dt>
                <dd className="mt-1 text-[var(--color-ink)] whitespace-pre-wrap break-words">
                  {suppression.clearedReason ?? '—'}
                </dd>
              </div>
            </>
          )}

          <div className="col-span-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-2.5">
            <dt className="text-[var(--color-ink-muted)]">Record ID</dt>
            <dd className="mt-1 font-mono text-[11px] text-[var(--color-ink-muted)] break-all">
              {suppression.id}
            </dd>
          </div>
        </dl>

        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
          >
            Close
          </button>
        </div>
      </div>
    </AccessibleDialog>
  );
}
