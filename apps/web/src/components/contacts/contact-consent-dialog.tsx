'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, channelsApi, contactsApi } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import type { ContactResponse, ConsentEventType } from '@acc/contracts';
import { ConsentStatusBadge } from './consent-status-badge';
import { useModalDialog } from '@/components/ui/dialog';

interface ContactConsentDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly contact: ContactResponse | null;
}

export function ContactConsentDialog({ open, onOpenChange, contact }: ContactConsentDialogProps) {
  const queryClient = useQueryClient();

  const [selectedChannelId, setSelectedChannelId] = useState<string>('');
  const [consentType, setConsentType] = useState<string>('transactional');
  const [event, setEvent] = useState<ConsentEventType>('grant');
  const [source, setSource] = useState('console_admin_override');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Fetch channels to populate channel selector
  const { data: channelsData } = useQuery({
    queryKey: ['channels', 'list', { limit: 50 }],
    queryFn: ({ signal }) => channelsApi.list({ limit: 50, tenantScoped: true }, signal),
    enabled: open,
  });

  const channels = channelsData?.data ?? [];
  const whatsappChannel = channels.find((c) => c.code === 'whatsapp');

  // Resolve effective channel: selected or default to WhatsApp or first available
  const activeChannelId = selectedChannelId || whatsappChannel?.id || channels[0]?.id || '';

  // Fetch current effective consent for chosen channel & consent type
  const { data: consentData, isLoading: isConsentLoading } = useQuery({
    queryKey: ['contacts', 'consent', contact?.id, activeChannelId, consentType],
    queryFn: ({ signal }) =>
      contactsApi.getEffectiveConsent(
        contact!.id,
        { channelId: activeChannelId, consentType },
        signal,
      ),
    enabled: Boolean(open && contact && activeChannelId),
  });

  const modal = useModalDialog(open && Boolean(contact));

  if (!open || !contact) return null;

  const handleClose = () => {
    setErrorMessage(null);
    onOpenChange(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!activeChannelId) {
      setErrorMessage('A communication channel is required to record consent.');
      return;
    }

    setIsSubmitting(true);
    try {
      await contactsApi.createConsentEvent(contact.id, {
        channelId: activeChannelId,
        consentType,
        event,
        occurredAt: new Date().toISOString(),
        source: source.trim() || 'console_admin_override',
      });

      await queryClient.invalidateQueries({ queryKey: ['contacts', 'consent', contact.id] });
      await queryClient.invalidateQueries({ queryKey: ['contacts', 'list'] });

      const channelObj = channels.find((c) => c.id === activeChannelId);
      const channelLabel = channelObj ? channelObj.displayName : 'Channel';
      toast.success(
        'Consent Recorded',
        `Recorded ${event.toUpperCase()} event for ${channelLabel} (${consentType}).`,
      );
      handleClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(
          err.code
            ? `${err.code}: ${err.message}`
            : err.message || 'Failed to record consent event.',
        );
      } else {
        setErrorMessage('An unexpected error occurred while recording consent.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const effectiveState = consentData?.data?.effectiveState ?? 'unknown';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs focus:outline-none"
      {...modal.overlayProps(handleClose, !isSubmitting)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="consent-dialog-title"
    >
      <div
        ref={modal.panelRef}
        tabIndex={-1}
        className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
          <h2 id="consent-dialog-title" className="text-base font-semibold text-[var(--color-ink)]">
            Record Consent Event
          </h2>
          <button
            type="button"
            onClick={handleClose}
            className="rounded p-1 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]"
            aria-label="Close dialog"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          {errorMessage && (
            <div
              className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-400"
              role="alert"
            >
              {errorMessage}
            </div>
          )}

          <div className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold text-[var(--color-ink)]">
                  {contact.firstName || contact.lastName
                    ? `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim()
                    : 'Unnamed Contact'}
                </p>
                <p className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                  ID: {contact.id.slice(0, 8)}…
                </p>
              </div>
              <div>
                {isConsentLoading ? (
                  <span role="status" className="text-[10px] text-[var(--color-ink-muted)]">
                    Evaluating…
                  </span>
                ) : (
                  <ConsentStatusBadge status={effectiveState} />
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="consent-channel"
                className="block text-xs font-medium text-[var(--color-ink-muted)]"
              >
                Channel
              </label>
              <select
                id="consent-channel"
                value={activeChannelId}
                onChange={(e) => setSelectedChannelId(e.target.value)}
                disabled={isSubmitting || channels.length === 0}
                className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)]"
              >
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName || c.code.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="consent-type"
                className="block text-xs font-medium text-[var(--color-ink-muted)]"
              >
                Consent Type
              </label>
              <select
                id="consent-type"
                value={consentType}
                onChange={(e) => setConsentType(e.target.value)}
                disabled={isSubmitting}
                className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)]"
              >
                <option value="transactional">Transactional</option>
                <option value="marketing">Marketing</option>
              </select>
            </div>
          </div>

          <div>
            <label
              htmlFor="consent-action"
              className="block text-xs font-medium text-[var(--color-ink-muted)]"
            >
              Consent Event Action
            </label>
            <select
              id="consent-action"
              value={event}
              onChange={(e) => setEvent(e.target.value as ConsentEventType)}
              disabled={isSubmitting}
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-ink)]"
            >
              <option value="grant">GRANT — Opt In (consent granted)</option>
              <option value="revoke">REVOKE — Opt Out (consent withdrawn)</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="consent-source"
              className="block text-xs font-medium text-[var(--color-ink-muted)]"
            >
              Audit / Source Reference
            </label>
            <input
              id="consent-source"
              type="text"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              disabled={isSubmitting}
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-ink)]"
              required
            />
          </div>

          <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-2.5 text-[11px] text-[var(--color-ink-muted)]">
            <span className="font-semibold text-amber-500">Immutable Ledger:</span> Consent events
            are recorded in an append-only ledger in PostgreSQL. The latest business timestamp
            governs effective opt-in/opt-out status for eligibility preflight.
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={handleClose}
              disabled={isSubmitting}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {isSubmitting ? 'Recording…' : 'Record Consent'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
