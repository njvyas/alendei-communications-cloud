'use client';

import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, contactsApi } from '@/lib/api-client';
import { toast } from '@/lib/toast';
import { useModalDialog } from '@/components/ui/dialog';
import type { ContactResponse } from '@acc/contracts';

interface ContactEditDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly contact: ContactResponse | null;
}

export function ContactEditDialog({ open, onOpenChange, contact }: ContactEditDialogProps) {
  const queryClient = useQueryClient();

  const [firstName, setFirstName] = useState(contact?.firstName ?? '');
  const [lastName, setLastName] = useState(contact?.lastName ?? '');
  const [metadataJson, setMetadataJson] = useState(
    contact?.metadata && Object.keys(contact.metadata).length > 0
      ? JSON.stringify(contact.metadata, null, 2)
      : '{}',
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (contact && open) {
      setFirstName(contact.firstName ?? '');
      setLastName(contact.lastName ?? '');
      setMetadataJson(
        contact.metadata && Object.keys(contact.metadata).length > 0
          ? JSON.stringify(contact.metadata, null, 2)
          : '{}',
      );
      setErrorMessage(null);
    }
  }, [contact, open]);

  const modal = useModalDialog(open && Boolean(contact));

  if (!open || !contact) return null;

  const handleClose = () => {
    setErrorMessage(null);
    onOpenChange(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    let parsedMetadata: Record<string, unknown> | undefined;
    const trimmedJson = metadataJson.trim();
    if (trimmedJson) {
      try {
        const parsed = JSON.parse(trimmedJson);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          setErrorMessage('Metadata must be a valid JSON object.');
          return;
        }
        parsedMetadata = parsed as Record<string, unknown>;
      } catch {
        setErrorMessage('Metadata contains invalid JSON syntax.');
        return;
      }
    }

    setIsSubmitting(true);
    try {
      const res = await contactsApi.update(contact.id, {
        firstName: firstName.trim() || null,
        lastName: lastName.trim() || null,
        metadata: parsedMetadata,
      });

      await queryClient.invalidateQueries({ queryKey: ['contacts', 'list'] });
      await queryClient.invalidateQueries({ queryKey: ['contacts', 'detail', contact.id] });

      const displayName = [res.data.firstName, res.data.lastName].filter(Boolean).join(' ');
      toast.success(
        'Contact Updated',
        `Contact ${displayName ? `"${displayName}"` : contact.id.slice(0, 8)} updated successfully.`,
      );
      handleClose();
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        setErrorMessage(
          err.code ? `${err.code}: ${err.message}` : err.message || 'Failed to update contact.',
        );
      } else {
        setErrorMessage('An unexpected error occurred while updating the contact.');
      }
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
      aria-labelledby="contact-edit-title"
    >
      <div
        ref={modal.panelRef}
        tabIndex={-1}
        className="w-full max-w-md rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
          <h2 id="contact-edit-title" className="text-base font-semibold text-[var(--color-ink)]">
            Edit Contact
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

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="edit-contact-first-name"
                className="block text-xs font-medium text-[var(--color-ink)]"
              >
                First Name
              </label>
              <input
                id="edit-contact-first-name"
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                disabled={isSubmitting}
                className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] focus:border-emerald-500 focus:outline-none"
                placeholder="Jane"
              />
            </div>
            <div>
              <label
                htmlFor="edit-contact-last-name"
                className="block text-xs font-medium text-[var(--color-ink)]"
              >
                Last Name
              </label>
              <input
                id="edit-contact-last-name"
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                disabled={isSubmitting}
                className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 text-xs text-[var(--color-ink)] focus:border-emerald-500 focus:outline-none"
                placeholder="Doe"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="edit-contact-metadata"
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Custom Metadata (JSON)
            </label>
            <textarea
              id="edit-contact-metadata"
              rows={4}
              value={metadataJson}
              onChange={(e) => setMetadataJson(e.target.value)}
              disabled={isSubmitting}
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-1.5 font-mono text-xs text-[var(--color-ink)] focus:border-emerald-500 focus:outline-none"
              placeholder="{}"
            />
            <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
              Optional key-value attributes stored with the contact.
            </p>
          </div>

          <div className="flex justify-end gap-2 border-t border-[var(--color-border-subtle)] pt-4">
            <button
              type="button"
              onClick={handleClose}
              disabled={isSubmitting}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {isSubmitting ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
