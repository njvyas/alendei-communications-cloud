'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, channelsApi, contactsApi } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useModalDialog } from '@/components/ui/dialog';
import type { ContactResponse } from '@acc/contracts';

interface ContactDetailDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly contact: ContactResponse | null;
  readonly onRecordConsent?: (contact: ContactResponse) => void;
  readonly canManage?: boolean;
}

export function ContactDetailDialog({
  open,
  onOpenChange,
  contact,
  onRecordConsent,
  canManage = false,
}: ContactDetailDialogProps) {
  const queryClient = useQueryClient();

  const [isAddingIdentity, setIsAddingIdentity] = useState(false);
  const [identityChannelId, setIdentityChannelId] = useState('');
  const [rawAddress, setRawAddress] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [isSubmittingIdentity, setIsSubmittingIdentity] = useState(false);
  const [identityError, setIdentityError] = useState<string | null>(null);

  // Load channels for mapping channel names
  const { data: channelsData } = useQuery({
    queryKey: ['channels', 'list', { limit: 50 }],
    queryFn: ({ signal }) => channelsApi.list({ limit: 50, tenantScoped: true }, signal),
    enabled: open,
  });

  const channels = channelsData?.data ?? [];

  // Load identities for this contact
  const {
    data: identitiesData,
    isLoading: isIdentitiesLoading,
    error: identitiesError,
  } = useQuery({
    queryKey: ['contacts', 'identities', contact?.id],
    queryFn: ({ signal }) => contactsApi.listIdentities(contact!.id, signal),
    enabled: Boolean(open && contact),
  });

  const identities = identitiesData?.data ?? [];

  const modal = useModalDialog(open && Boolean(contact));

  if (!open || !contact) return null;

  const handleClose = () => {
    setIsAddingIdentity(false);
    setRawAddress('');
    setIdentityError(null);
    onOpenChange(false);
  };

  const handleAddIdentity = async (e: React.FormEvent) => {
    e.preventDefault();
    setIdentityError(null);

    const effectiveChannelId = identityChannelId || channels[0]?.id;
    if (!effectiveChannelId) {
      setIdentityError('Please select a communication channel.');
      return;
    }

    const trimmedAddress = rawAddress.trim();
    if (!trimmedAddress) {
      setIdentityError('Address/phone number is required.');
      return;
    }

    setIsSubmittingIdentity(true);
    try {
      await contactsApi.createIdentity(contact.id, {
        channelId: effectiveChannelId,
        rawAddress: trimmedAddress,
        isPrimary,
      });

      await queryClient.invalidateQueries({ queryKey: ['contacts', 'identities', contact.id] });
      toast.success('Identity Added', `Address ${trimmedAddress} added to contact.`);
      setRawAddress('');
      setIsAddingIdentity(false);
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setIdentityError(
          err.code ? `${err.code}: ${err.message}` : err.message || 'Failed to add identity.',
        );
      } else {
        setIdentityError('An unexpected error occurred while adding the identity.');
      }
    } finally {
      setIsSubmittingIdentity(false);
    }
  };

  const contactName =
    contact.firstName || contact.lastName
      ? `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim()
      : 'Unnamed Contact';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs focus:outline-none"
      {...modal.overlayProps(handleClose, !isSubmittingIdentity)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="contact-detail-title"
    >
      <div
        ref={modal.panelRef}
        tabIndex={-1}
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl space-y-5"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
          <div>
            <h2
              id="contact-detail-title"
              className="text-base font-semibold text-[var(--color-ink)]"
            >
              {contactName}
            </h2>
            <p className="font-mono text-[10px] text-[var(--color-ink-muted)]">
              Contact ID: {contact.id}
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

        {/* Basic metadata */}
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 text-xs space-y-1.5">
          <div className="flex justify-between">
            <span className="text-[var(--color-ink-muted)]">Workspace:</span>
            <code className="font-mono text-[11px] text-[var(--color-ink)]">
              {contact.workspaceId.slice(0, 8)}…
            </code>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-ink-muted)]">Created:</span>
            <span className="text-[var(--color-ink)]">
              {new Date(contact.createdAt).toLocaleString()}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-[var(--color-ink-muted)]">Updated:</span>
            <span className="text-[var(--color-ink)]">
              {new Date(contact.updatedAt).toLocaleString()}
            </span>
          </div>
        </div>

        {/* Identities Section */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">
              Contact Identities
            </h3>
            {canManage && !isAddingIdentity && (
              <button
                type="button"
                onClick={() => setIsAddingIdentity(true)}
                className="rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
              >
                + Add Identity
              </button>
            )}
          </div>

          {isAddingIdentity && (
            <form
              onSubmit={handleAddIdentity}
              className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs space-y-3"
            >
              <h4 className="font-medium text-emerald-400">Add New Identity</h4>
              {identityError && (
                <div className="text-[11px] text-rose-400" role="alert">
                  {identityError}
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label
                    htmlFor="identity-channel-select"
                    className="text-[11px] text-[var(--color-ink-muted)]"
                  >
                    Channel
                  </label>
                  <select
                    id="identity-channel-select"
                    value={identityChannelId || channels[0]?.id || ''}
                    onChange={(e) => setIdentityChannelId(e.target.value)}
                    disabled={isSubmittingIdentity}
                    className="mt-0.5 w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-ink)]"
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
                    htmlFor="identity-address-input"
                    className="text-[11px] text-[var(--color-ink-muted)]"
                  >
                    Address / Phone
                  </label>
                  <input
                    id="identity-address-input"
                    type="text"
                    value={rawAddress}
                    onChange={(e) => setRawAddress(e.target.value)}
                    disabled={isSubmittingIdentity}
                    placeholder="+1234567890"
                    className="mt-0.5 w-full rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2 py-1 text-xs text-[var(--color-ink)]"
                  />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="identity-is-primary"
                  type="checkbox"
                  checked={isPrimary}
                  onChange={(e) => setIsPrimary(e.target.checked)}
                  disabled={isSubmittingIdentity}
                  className="rounded border-[var(--color-border-subtle)]"
                />
                <label
                  htmlFor="identity-is-primary"
                  className="text-[11px] text-[var(--color-ink)]"
                >
                  Primary identifier for channel
                </label>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setIsAddingIdentity(false)}
                  disabled={isSubmittingIdentity}
                  className="rounded px-2.5 py-1 text-[11px] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingIdentity}
                  className="rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  {isSubmittingIdentity ? 'Adding…' : 'Add'}
                </button>
              </div>
            </form>
          )}

          {isIdentitiesLoading ? (
            <div role="status" className="text-center py-4 text-xs text-[var(--color-ink-muted)]">
              Loading identities…
            </div>
          ) : identitiesError ? (
            <div
              role="alert"
              className="rounded-lg border border-red-500/20 bg-red-500/10 p-4 text-center text-xs text-red-400"
            >
              Failed to load identities.
            </div>
          ) : identities.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--color-border-subtle)] p-4 text-center text-xs text-[var(--color-ink-muted)]">
              No registered identities attached to this contact.
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-border-subtle)] rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)]">
              {identities.map((idnt) => {
                const channel = channels.find((c) => c.id === idnt.channelId);
                const channelDisplay = channel ? channel.code.toUpperCase() : 'UNKNOWN';

                return (
                  <div key={idnt.id} className="flex items-center justify-between p-3 text-xs">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-[var(--color-ink)]">
                          {idnt.normalizedAddress || idnt.rawAddress}
                        </span>
                        {idnt.isPrimary && (
                          <span className="rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-1.5 py-0.2 font-mono text-[9px] uppercase font-semibold">
                            Primary
                          </span>
                        )}
                      </div>
                      <span className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                        Channel: {channelDisplay} • Status: {idnt.status}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Metadata Section */}
        {contact.metadata && Object.keys(contact.metadata).length > 0 && (
          <div className="space-y-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-ink-muted)]">
              Custom Attributes
            </h3>
            <pre className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] p-3 font-mono text-[11px] text-[var(--color-ink)] overflow-x-auto">
              {JSON.stringify(contact.metadata, null, 2)}
            </pre>
          </div>
        )}

        {/* Actions footer */}
        <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] pt-4">
          {onRecordConsent ? (
            <button
              type="button"
              onClick={() => {
                handleClose();
                onRecordConsent(contact);
              }}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
            >
              Record Consent Event
            </button>
          ) : (
            <span />
          )}

          <button
            type="button"
            onClick={handleClose}
            className="rounded-md bg-[var(--color-surface-raised)] border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
