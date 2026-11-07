'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ApiError, channelsApi, contactsApi } from '@/lib/api-client';
import { useCanManageContacts, useCanReadContacts } from '@/lib/session-store';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ContactTagsCard } from '@/components/contacts/contact-tags-card';
import { ContactCustomFieldsCard } from '@/components/contacts/contact-custom-fields-card';
import { ContactIdentitiesCard } from '@/components/contacts/contact-identities-card';
import { ContactTimelineCard } from '@/components/contacts/contact-timeline-card';
import { ContactConsentDialog } from '@/components/contacts/contact-consent-dialog';
import { ContactEditDialog } from '@/components/contacts/contact-edit-dialog';
import { extractContactTags, extractCustomFields } from '@/lib/cdp';
import type { ContactIdentityResponse } from '@acc/contracts';

interface ContactProfileViewProps {
  readonly contactId: string;
  readonly onBack?: () => void;
  readonly canRead?: boolean;
  readonly canManage?: boolean;
}

export function ContactProfileView({
  contactId,
  onBack,
  canRead: propCanRead,
  canManage: propCanManage,
}: ContactProfileViewProps) {
  const hookCanRead = useCanReadContacts();
  const hookCanManage = useCanManageContacts();
  const canReadContacts = propCanRead ?? hookCanRead;
  const canManageContacts = propCanManage ?? hookCanManage;

  const [activeTab, setActiveTab] = useState('overview');
  const [isConsentOpen, setIsConsentOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Load contact record
  const {
    data: contactData,
    isLoading: isContactLoading,
    error: contactError,
  } = useQuery({
    queryKey: ['contacts', 'detail', contactId],
    queryFn: ({ signal }) => contactsApi.get(contactId, undefined, signal),
    enabled: Boolean(canReadContacts && contactId),
  });
  const contact = contactData?.data;

  // Load identities
  const { data: identitiesData } = useQuery({
    queryKey: ['contacts', 'identities', contactId],
    queryFn: ({ signal }) => contactsApi.listIdentities(contactId, signal),
    enabled: Boolean(canReadContacts && contactId),
  });
  const identities = identitiesData?.data ?? [];

  // Load channels
  const { data: channelsData } = useQuery({
    queryKey: ['channels', 'list', { limit: 50 }],
    queryFn: ({ signal }) => channelsApi.list({ limit: 50, tenantScoped: true }, signal),
  });
  const channels = channelsData?.data ?? [];

  if (!canReadContacts) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center shadow-xs">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">Access Forbidden</h2>
        <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
          You do not have permission to view contact profiles. Requires{' '}
          <code className="text-xs">contacts.read</code> permission.
        </p>
      </div>
    );
  }

  if (isContactLoading) {
    return (
      <div role="status" className="py-16 text-center text-sm text-[var(--color-ink-muted)]">
        Loading contact profile…
      </div>
    );
  }

  if (contactError || !contact) {
    return (
      <div className="space-y-4">
        <div
          role="alert"
          className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-6 text-center text-xs text-rose-400"
        >
          {contactError instanceof ApiError
            ? `Failed to load contact (${contactError.code}): ${contactError.message}`
            : 'Contact not found or failed to load.'}
        </div>
        <div className="text-center">
          <Link
            href="/contacts"
            className="text-xs text-indigo-400 hover:text-indigo-300 font-medium"
          >
            ← Return to Contacts Directory
          </Link>
        </div>
      </div>
    );
  }

  const fullName =
    contact.firstName || contact.lastName
      ? `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim()
      : 'Unnamed Contact';

  const initials =
    contact.firstName || contact.lastName
      ? `${contact.firstName?.[0] ?? ''}${contact.lastName?.[0] ?? ''}`.toUpperCase()
      : 'CT';

  const tags = extractContactTags(contact.metadata);
  const customFields = extractCustomFields(contact.metadata);

  const primaryIdentity =
    identities.find((i: ContactIdentityResponse) => i.isPrimary) || identities[0];
  const primaryChannel = primaryIdentity
    ? (channels.find((c) => c.id === primaryIdentity.channelId)?.code.toUpperCase() ?? 'GENERIC')
    : 'NONE';

  const handleCopyId = () => {
    void navigator.clipboard.writeText(contact.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6" data-testid="contact-profile-view">
      {/* Navigation Breadcrumb & Back */}
      <div className="flex items-center justify-between">
        <nav
          aria-label="Profile navigation"
          className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]"
        >
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              data-testid="profile-back-btn"
              className="hover:text-[var(--color-ink)] transition-colors flex items-center gap-1 font-medium"
            >
              ← Contacts
            </button>
          ) : (
            <Link
              href="/contacts"
              className="hover:text-[var(--color-ink)] transition-colors font-medium"
            >
              Contacts
            </Link>
          )}
          <span>/</span>
          <span className="font-semibold text-[var(--color-ink)] truncate max-w-xs">
            {fullName}
          </span>
        </nav>

        <div className="flex items-center gap-2">
          {canManageContacts && (
            <>
              <button
                type="button"
                onClick={() => setIsEditOpen(true)}
                data-testid="profile-edit-btn"
                className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] transition-colors shadow-xs"
              >
                Edit Contact
              </button>
              <button
                type="button"
                onClick={() => setIsConsentOpen(true)}
                data-testid="profile-consent-btn"
                className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors shadow-xs"
              >
                Record Consent
              </button>
            </>
          )}
        </div>
      </div>

      {/* Hero Contact Card */}
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-6 shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-indigo-600 font-mono text-lg font-bold text-white shadow-xs">
              {initials}
            </div>

            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1
                  className="text-xl font-bold tracking-tight text-[var(--color-ink)]"
                  data-testid="profile-contact-name"
                >
                  {fullName}
                </h1>
                <span className="rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2 py-0.5 font-mono text-[10px] uppercase font-bold tracking-wider">
                  CDP Profile
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--color-ink-muted)]">
                <div className="flex items-center gap-1.5 font-mono">
                  <span>ID:</span>
                  <span className="text-[var(--color-ink)]">{contact.id}</span>
                  <button
                    type="button"
                    onClick={handleCopyId}
                    data-testid="copy-contact-id-btn"
                    className="text-[11px] hover:text-[var(--color-ink)] transition-colors"
                    title="Copy full contact ID"
                  >
                    {copied ? '✓ Copied' : '📋'}
                  </button>
                </div>
                <span>•</span>
                <span>
                  Workspace:{' '}
                  <code className="font-mono text-[11px] text-[var(--color-ink)]">
                    {contact.workspaceId.slice(0, 8)}…
                  </code>
                </span>
                <span>•</span>
                <span>Registered: {new Date(contact.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Quick CDP Metric Bar */}
        <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3 border-t border-[var(--color-border-subtle)] pt-4">
          <div className="rounded-lg bg-[var(--color-surface-raised)] p-3">
            <span className="text-[11px] font-medium text-[var(--color-ink-muted)]">
              Identities
            </span>
            <p
              className="mt-1 text-base font-bold text-[var(--color-ink)]"
              data-testid="stat-identities-count"
            >
              {identities.length}
            </p>
          </div>
          <div className="rounded-lg bg-[var(--color-surface-raised)] p-3">
            <span className="text-[11px] font-medium text-[var(--color-ink-muted)]">
              Primary Channel
            </span>
            <p
              className="mt-1 text-base font-bold text-indigo-400 font-mono"
              data-testid="stat-primary-channel"
            >
              {primaryChannel}
            </p>
          </div>
          <div className="rounded-lg bg-[var(--color-surface-raised)] p-3">
            <span className="text-[11px] font-medium text-[var(--color-ink-muted)]">
              Active Tags
            </span>
            <p
              className="mt-1 text-base font-bold text-[var(--color-ink)]"
              data-testid="stat-tags-count"
            >
              {tags.length}
            </p>
          </div>
          <div className="rounded-lg bg-[var(--color-surface-raised)] p-3">
            <span className="text-[11px] font-medium text-[var(--color-ink-muted)]">
              Custom Fields
            </span>
            <p
              className="mt-1 text-base font-bold text-[var(--color-ink)]"
              data-testid="stat-fields-count"
            >
              {customFields.length}
            </p>
          </div>
        </div>
      </div>

      {/* Tabs Navigation */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList
          label="Contact Profile Navigation"
          className="border-[var(--color-border-subtle)]"
        >
          <TabsTrigger value="overview" className="text-xs">
            Overview
          </TabsTrigger>
          <TabsTrigger value="identities" className="text-xs">
            Identities & Channels ({identities.length})
          </TabsTrigger>
          <TabsTrigger value="tags" className="text-xs">
            Tags & Custom Fields
          </TabsTrigger>
          <TabsTrigger value="timeline" className="text-xs">
            Activity Timeline
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Overview */}
        <TabsContent value="overview">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-6">
              <ContactIdentitiesCard contact={contact} canManage={canManageContacts} />
              <ContactTagsCard contact={contact} canManage={canManageContacts} />
            </div>

            <div className="space-y-6">
              <ContactCustomFieldsCard contact={contact} canManage={canManageContacts} />
              <ContactTimelineCard contact={contact} identities={identities} />
            </div>
          </div>
        </TabsContent>

        {/* Tab 2: Identities */}
        <TabsContent value="identities">
          <ContactIdentitiesCard contact={contact} canManage={canManageContacts} />
        </TabsContent>

        {/* Tab 3: Tags & Custom Fields */}
        <TabsContent value="tags">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <ContactTagsCard contact={contact} canManage={canManageContacts} />
            <ContactCustomFieldsCard contact={contact} canManage={canManageContacts} />
          </div>
        </TabsContent>

        {/* Tab 4: Activity Timeline */}
        <TabsContent value="timeline">
          <ContactTimelineCard contact={contact} identities={identities} />
        </TabsContent>
      </Tabs>

      {/* Dialogs */}
      <ContactConsentDialog
        open={isConsentOpen}
        onOpenChange={setIsConsentOpen}
        contact={contact}
      />

      <ContactEditDialog open={isEditOpen} onOpenChange={setIsEditOpen} contact={contact} />
    </div>
  );
}
