'use client';

import { StatusDot, type StatusTone } from '@/components/ui/status-dot';
import { useHasPermission } from '@/lib/session-store';
import type { ApiKeyView } from '@/lib/api-client';

interface ApiKeyDetailDialogProps {
  readonly isOpen: boolean;
  readonly apiKey: ApiKeyView | null;
  readonly onClose: () => void;
  readonly onRevokeClick: (key: ApiKeyView) => void;
}

const STATUS_TONES: Record<string, StatusTone> = {
  active: 'ok',
  expired: 'warn',
  revoked: 'bad',
};

export function ApiKeyDetailDialog({ isOpen, apiKey, onClose, onRevokeClick }: ApiKeyDetailDialogProps) {
  const canRevoke = useHasPermission('api_keys.revoke');

  if (!isOpen || !apiKey) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="api-key-detail-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
    >
      <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl text-[var(--color-ink)]">
        <div className="flex items-start justify-between border-b border-[var(--color-border-subtle)] pb-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 id="api-key-detail-title" className="text-lg font-bold tracking-tight">
                {apiKey.name}
              </h2>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-0.5 text-[11px] font-medium capitalize">
                <StatusDot tone={STATUS_TONES[apiKey.status] ?? 'unknown'} label={apiKey.status} />
              </span>
            </div>
            <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
              Identifier Prefix: <code className="font-mono text-[var(--color-ink)]">{apiKey.prefix}…</code>
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
          {/* Metadata Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
            <div>
              <span className="text-[var(--color-ink-muted)] block">Key ID</span>
              <span className="font-mono text-[11px] text-[var(--color-ink)] select-all">{apiKey.id}</span>
            </div>
            <div>
              <span className="text-[var(--color-ink-muted)] block">Binding Scope</span>
              <span className="font-medium text-[var(--color-ink)] capitalize">
                {apiKey.scopeType} ({apiKey.scopeId.slice(0, 8)}…)
              </span>
            </div>
            <div>
              <span className="text-[var(--color-ink-muted)] block">Created At</span>
              <span className="text-[var(--color-ink)]">{new Date(apiKey.createdAt).toLocaleString()}</span>
            </div>
            <div>
              <span className="text-[var(--color-ink-muted)] block">Last Used</span>
              <span className="text-[var(--color-ink)]">
                {apiKey.lastUsedAt ? new Date(apiKey.lastUsedAt).toLocaleString() : 'Never'}
              </span>
            </div>
            <div>
              <span className="text-[var(--color-ink-muted)] block">Expires</span>
              <span className="text-[var(--color-ink)]">
                {apiKey.expiresAt ? new Date(apiKey.expiresAt).toLocaleString() : 'Never (No expiration)'}
              </span>
            </div>
            <div>
              <span className="text-[var(--color-ink-muted)] block">Created By</span>
              <span className="font-mono text-[11px] text-[var(--color-ink)]">
                {apiKey.createdBy ? `${apiKey.createdBy.slice(0, 8)}…` : 'Unknown'}
              </span>
            </div>
            {apiKey.revokedAt && (
              <div className="col-span-1 sm:col-span-2 border-t border-[var(--color-border-subtle)] pt-2 text-[var(--color-bad)]">
                <span className="font-semibold block">Revoked</span>
                <span>
                  {new Date(apiKey.revokedAt).toLocaleString()} ({apiKey.revokedReason ?? 'revoked_by_administrator'})
                </span>
              </div>
            )}
          </div>

          {/* Scopes */}
          <div>
            <h3 className="font-semibold text-[var(--color-ink)] mb-1.5">
              Granted Scopes ({apiKey.scopes.length})
            </h3>
            <div className="max-h-36 overflow-y-auto rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-2">
              {apiKey.scopes.length === 0 ? (
                <p className="text-xs text-[var(--color-ink-muted)] italic">No scopes granted to this key.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {apiKey.scopes.map((scope) => (
                    <span
                      key={scope}
                      className="rounded bg-[var(--color-surface)] border border-[var(--color-border-subtle)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-ink)]"
                    >
                      {scope}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-[var(--color-border-subtle)] pt-4">
          <div>
            {apiKey.status === 'active' && canRevoke && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onRevokeClick(apiKey);
                }}
                className="rounded-md border border-[var(--color-bad)]/40 px-3 py-1.5 text-xs font-medium text-[var(--color-bad)] hover:bg-[var(--color-bad)]/10"
              >
                Revoke Key…
              </button>
            )}
          </div>
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
