'use client';

import type { ContactResponse } from '@acc/contracts';

/** The contact created in this session, bound to the organization it was created in. */
export interface CreatedContactRecord {
  readonly contact: ContactResponse;
  readonly organizationId: string | null;
}

/**
 * The notice belongs to one organization and workspace: it must never be shown
 * after the user switches either (the stale-banner class of defect fixed for
 * suppressions, QA D3).
 */
export function shouldShowCreatedContactNotice(
  record: CreatedContactRecord | null,
  organizationId: string | null,
  workspaceId: string,
): record is CreatedContactRecord {
  return (
    record !== null &&
    record.organizationId === organizationId &&
    record.contact.workspaceId === workspaceId
  );
}

export function createdContactName(contact: ContactResponse): string {
  return contact.firstName || contact.lastName
    ? `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim()
    : 'Unnamed Contact';
}

interface ContactCreatedNoticeProps {
  contact: ContactResponse;
  canManageContacts: boolean;
  onManageConsent: (contact: ContactResponse) => void;
  onDismiss: () => void;
}

/**
 * Shown after a successful "Create Contact" (QAF-019). The list is newest
 * first and the page returns to page 1 after creation (#30), so the contact is
 * at the top of the list; the notice also names it and keeps it actionable.
 */
export function ContactCreatedNotice({
  contact,
  canManageContacts,
  onManageConsent,
  onDismiss,
}: ContactCreatedNoticeProps) {
  return (
    <div
      role="status"
      data-testid="contact-created-notice"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-300"
    >
      <div className="space-y-1">
        <p>
          Contact created:{' '}
          <span className="font-semibold text-[var(--color-ink)]">
            {createdContactName(contact)}
          </span>{' '}
          <code className="font-mono text-[11px] text-[var(--color-ink-muted)]">{contact.id}</code>
        </p>
        <p className="text-[var(--color-ink-muted)]">
          Contacts are listed newest first; the new contact is at the top of the first page.
        </p>
      </div>
      <div className="flex gap-2">
        {canManageContacts && (
          <button
            type="button"
            onClick={() => onManageConsent(contact)}
            data-testid="created-contact-manage-consent-btn"
            className="rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
          >
            Manage Consent
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss contact created notice"
          className="rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
