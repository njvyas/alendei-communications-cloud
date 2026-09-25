'use client';

import { useState } from 'react';
import { StatusDot, type StatusTone } from '@/components/ui/status-dot';
import type { AuditLogView } from '@/lib/api-client';

interface AuditLogDetailDialogProps {
  readonly isOpen: boolean;
  readonly log: AuditLogView | null;
  readonly onClose: () => void;
  readonly onFilterByCorrelation?: (correlationId: string) => void;
}

const OUTCOME_TONES: Record<string, StatusTone> = {
  success: 'ok',
  failure: 'bad',
  denied: 'warn',
};

export function AuditLogDetailDialog({
  isOpen,
  log,
  onClose,
  onFilterByCorrelation,
}: AuditLogDetailDialogProps) {
  const [copiedCorrelation, setCopiedCorrelation] = useState(false);

  if (!isOpen || !log) return null;

  const handleCopyCorrelation = async () => {
    try {
      await navigator.clipboard.writeText(log.correlationId);
      setCopiedCorrelation(true);
      setTimeout(() => setCopiedCorrelation(false), 2000);
    } catch {
      // Fallback
    }
  };

  /**
   * Safe inert JSON payload rendering.
   * Treats all audit payloads as untrusted data:
   * Formatted strictly as React text nodes inside preformatted code blocks.
   * Zero dangerouslySetInnerHTML, zero HTML parsing, zero script execution.
   */
  const renderSafeJson = (data: Record<string, unknown> | null, emptyLabel: string) => {
    if (!data || Object.keys(data).length === 0) {
      return <p className="text-xs text-[var(--color-ink-muted)] italic">{emptyLabel}</p>;
    }
    return (
      <pre className="max-h-48 overflow-auto rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 font-mono text-[11px] text-[var(--color-ink)] select-all whitespace-pre-wrap break-all">
        {JSON.stringify(data, null, 2)}
      </pre>
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="audit-log-detail-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
    >
      <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl text-[var(--color-ink)]">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-[var(--color-border-subtle)] pb-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 id="audit-log-detail-title" className="text-base font-bold tracking-tight font-mono">
                {log.action}
              </h2>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-0.5 text-[11px] font-medium capitalize">
                <StatusDot tone={OUTCOME_TONES[log.outcome] ?? 'unknown'} label={log.outcome} />
              </span>
            </div>
            <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
              Occurred: <span className="text-[var(--color-ink)]">{new Date(log.occurredAt).toLocaleString()}</span>{' '}
              ({log.occurredAt})
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 space-y-4 text-xs">
          {/* Top Attributes Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
            <div>
              <span className="text-[var(--color-ink-muted)] block">Record ID</span>
              <span className="font-mono text-[11px] text-[var(--color-ink)] select-all">{log.id}</span>
            </div>
            <div>
              <span className="text-[var(--color-ink-muted)] block">Actor</span>
              <span className="font-medium text-[var(--color-ink)] capitalize">
                {log.actorType}
                {log.actorLabel ? ` (${log.actorLabel})` : ''}
              </span>
              {log.actorUserId && (
                <span className="block font-mono text-[10px] text-[var(--color-ink-muted)] select-all">
                  User: {log.actorUserId}
                </span>
              )}
              {log.actorApiKeyId && (
                <span className="block font-mono text-[10px] text-[var(--color-ink-muted)] select-all">
                  Key: {log.actorApiKeyId}
                </span>
              )}
            </div>
            <div>
              <span className="text-[var(--color-ink-muted)] block">Resource</span>
              <span className="font-medium text-[var(--color-ink)]">{log.resourceType}</span>
              {log.resourceId && (
                <span className="block font-mono text-[10px] text-[var(--color-ink-muted)] select-all">
                  {log.resourceId}
                </span>
              )}
            </div>
            <div>
              <span className="text-[var(--color-ink-muted)] block">Scope</span>
              <span className="font-medium text-[var(--color-ink)] capitalize">
                {log.scopeType} {log.scopeId ? `(${log.scopeId.slice(0, 8)}…)` : ''}
              </span>
            </div>
            <div>
              <span className="text-[var(--color-ink-muted)] block">Client Origin IP</span>
              <span className="font-mono text-[11px] text-[var(--color-ink)]">{log.ip ?? 'None'}</span>
            </div>
            <div>
              <span className="text-[var(--color-ink-muted)] block">User Agent</span>
              <span className="text-[11px] text-[var(--color-ink)] truncate block" title={log.userAgent ?? undefined}>
                {log.userAgent ?? 'None'}
              </span>
            </div>
          </div>

          {/* Trace & Causality Banner */}
          <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <span className="text-[var(--color-ink-muted)] block">Correlation ID (Causal Trace)</span>
                <span className="font-mono text-[11px] text-[var(--color-ink)] select-all break-all">
                  {log.correlationId}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopyCorrelation}
                  className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                >
                  {copiedCorrelation ? 'Copied!' : 'Copy Trace ID'}
                </button>
                {onFilterByCorrelation && (
                  <button
                    type="button"
                    onClick={() => {
                      onFilterByCorrelation(log.correlationId);
                      onClose();
                    }}
                    className="rounded bg-[var(--color-accent)] px-2 py-1 text-[11px] font-medium text-white hover:opacity-90"
                  >
                    Filter by this Trace
                  </button>
                )}
              </div>
            </div>
            {log.causationId && (
              <div className="mt-2 border-t border-[var(--color-border-subtle)] pt-2">
                <span className="text-[var(--color-ink-muted)] block">Causation ID (Direct Parent Event)</span>
                <span className="font-mono text-[11px] text-[var(--color-ink)] select-all break-all">
                  {log.causationId}
                </span>
              </div>
            )}
          </div>

          {/* Scope Ancestry */}
          <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
            <h3 className="font-semibold text-[var(--color-ink)] mb-2">Scope Ancestry</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-[11px]">
              <div>
                <span className="text-[var(--color-ink-muted)] block text-[10px]">Organization</span>
                <span>{log.orgId ? `${log.orgId.slice(0, 8)}…` : '—'}</span>
              </div>
              <div>
                <span className="text-[var(--color-ink-muted)] block text-[10px]">Workspace</span>
                <span>{log.workspaceId ? `${log.workspaceId.slice(0, 8)}…` : '—'}</span>
              </div>
              <div>
                <span className="text-[var(--color-ink-muted)] block text-[10px]">Team</span>
                <span>{log.teamId ? `${log.teamId.slice(0, 8)}…` : '—'}</span>
              </div>
              <div>
                <span className="text-[var(--color-ink-muted)] block text-[10px]">Reseller</span>
                <span>{log.resellerId ? `${log.resellerId.slice(0, 8)}…` : '—'}</span>
              </div>
            </div>
          </div>

          {/* Payloads: before, after, metadata */}
          <div className="space-y-3">
            <div>
              <h3 className="font-semibold text-[var(--color-ink)] mb-1">State Before Change</h3>
              {renderSafeJson(log.before, 'No prior state recorded (creation or unmutated resource).')}
            </div>

            <div>
              <h3 className="font-semibold text-[var(--color-ink)] mb-1">State After Change</h3>
              {renderSafeJson(log.after, 'No subsequent state recorded (deletion or query).')}
            </div>

            <div>
              <h3 className="font-semibold text-[var(--color-ink)] mb-1">Event Metadata</h3>
              {renderSafeJson(log.metadata, 'No additional metadata recorded.')}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-6 flex justify-end border-t border-[var(--color-border-subtle)] pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-[var(--color-border-subtle)] px-4 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
