'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ContactResponse } from '@acc/contracts';
import { ApiError, channelsApi, contactsApi } from '@/lib/api-client';

interface ContactCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** Called with the created contact after every step succeeded (QAF-019). */
  onCreated?: (contact: ContactResponse) => void;
}

export interface CreateContactInput {
  readonly workspaceId: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly phone?: string;
  readonly whatsappChannelId?: string;
  readonly initialConsent: boolean;
  readonly idempotencyKey: string;
}

/**
 * Creates the contact, then its WhatsApp identity and initial consent when a
 * phone number is given, and returns the created contact.
 */
export async function createContactWithIdentity(
  input: CreateContactInput,
): Promise<ContactResponse> {
  // 1. Create the base contact record
  const contactRes = await contactsApi.create(
    input.workspaceId,
    { firstName: input.firstName, lastName: input.lastName },
    input.idempotencyKey,
  );
  const contactId = contactRes.data.id;

  // 2. Attach WhatsApp phone identity if provided
  if (input.phone && input.whatsappChannelId) {
    await contactsApi.createIdentity(contactId, {
      channelId: input.whatsappChannelId,
      rawAddress: input.phone,
      isPrimary: true,
    });

    // 3. Record initial consent if opted in
    if (input.initialConsent) {
      await contactsApi.createConsentEvent(contactId, {
        channelId: input.whatsappChannelId,
        consentType: 'transactional',
        event: 'grant',
        occurredAt: new Date().toISOString(),
        source: 'console_user_creation',
      });
    }
  }

  return contactRes.data;
}

export function ContactCreateDialog({
  open,
  onOpenChange,
  workspaceId,
  onCreated,
}: ContactCreateDialogProps) {
  const queryClient = useQueryClient();

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [initialConsent, setInitialConsent] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => crypto.randomUUID());

  // Fetch channels to discover WhatsApp channelId
  const { data: channelsData } = useQuery({
    queryKey: ['channels', 'list', { limit: 50 }],
    queryFn: ({ signal }) => channelsApi.list({ limit: 50 }, signal),
    enabled: open,
  });

  const channels = channelsData?.data ?? [];
  const whatsappChannel = channels.find((c) => c.code === 'whatsapp');

  if (!open) return null;

  const handleClose = () => {
    setFirstName('');
    setLastName('');
    setPhoneNumber('');
    setInitialConsent(true);
    setErrorMessage(null);
    setIdempotencyKey(crypto.randomUUID());
    onOpenChange(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const trimmedFirst = firstName.trim();
    const trimmedLast = lastName.trim();
    const trimmedPhone = phoneNumber.trim();

    if (!trimmedFirst && !trimmedLast && !trimmedPhone) {
      setErrorMessage('Please specify a contact name or phone number.');
      return;
    }

    if (trimmedPhone && !/^\+[1-9]\d{1,14}$/.test(trimmedPhone)) {
      setErrorMessage(
        'Phone number must be formatted in valid international E.164 format (e.g. +12025550199).',
      );
      return;
    }

    setIsSubmitting(true);
    try {
      const created = await createContactWithIdentity({
        workspaceId,
        firstName: trimmedFirst || undefined,
        lastName: trimmedLast || undefined,
        phone: trimmedPhone || undefined,
        whatsappChannelId: whatsappChannel?.id,
        initialConsent,
        idempotencyKey,
      });

      await queryClient.invalidateQueries({ queryKey: ['contacts', 'list', workspaceId] });
      onCreated?.(created);
      handleClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorMessage(
          err.code ? `${err.code}: ${err.message}` : err.message || 'Failed to create contact.',
        );
      } else {
        setErrorMessage('An unexpected error occurred while creating the contact.');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="contact-create-title"
    >
      <div className="w-full max-w-lg rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] pb-3">
          <h2 id="contact-create-title" className="text-base font-semibold text-[var(--color-ink)]">
            Create Workspace Contact
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
                htmlFor="contact-first-name"
                className="block text-xs font-medium text-[var(--color-ink-muted)]"
              >
                First Name
              </label>
              <input
                id="contact-first-name"
                type="text"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                disabled={isSubmitting}
                placeholder="Jane"
                maxLength={100}
                className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-ink)]"
              />
            </div>

            <div>
              <label
                htmlFor="contact-last-name"
                className="block text-xs font-medium text-[var(--color-ink-muted)]"
              >
                Last Name
              </label>
              <input
                id="contact-last-name"
                type="text"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                disabled={isSubmitting}
                placeholder="Doe"
                maxLength={100}
                className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-ink)]"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="contact-phone"
              className="block text-xs font-medium text-[var(--color-ink-muted)]"
            >
              WhatsApp Phone Number (E.164 international format)
            </label>
            <input
              id="contact-phone"
              type="tel"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              disabled={isSubmitting}
              placeholder="+12025550199"
              className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-3 py-2 text-xs text-[var(--color-ink)] font-mono"
            />
            <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
              Must include leading '+' and country code (e.g. +1 for US/CA, +44 for UK, +91 for
              India).
            </p>
          </div>

          <div className="flex items-start gap-2 pt-1">
            <input
              id="contact-consent-optin"
              type="checkbox"
              checked={initialConsent}
              onChange={(e) => setInitialConsent(e.target.checked)}
              disabled={isSubmitting}
              className="mt-0.5 rounded border-[var(--color-border-subtle)] text-emerald-600 focus:ring-emerald-500"
            />
            <label htmlFor="contact-consent-optin" className="text-xs text-[var(--color-ink)]">
              Record transactional WhatsApp consent (
              <span className="font-medium text-emerald-500">Opted In</span>)
            </label>
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
              {isSubmitting ? 'Creating…' : 'Create Contact'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
