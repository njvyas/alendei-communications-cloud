'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { ApiError, contactsApi, workspacesApi, type ListContactsParams } from '@/lib/api-client';
import { useCanManageContacts, useCanReadContacts, useSession } from '@/lib/session-store';
import { ContactCreateDialog } from '@/components/contacts/contact-create-dialog';
import { ContactConsentDialog } from '@/components/contacts/contact-consent-dialog';
import { ContactDetailDialog } from '@/components/contacts/contact-detail-dialog';
import { ContactEditDialog } from '@/components/contacts/contact-edit-dialog';
import {
  ContactCreatedNotice,
  shouldShowCreatedContactNotice,
  type CreatedContactRecord,
} from '@/components/contacts/contact-created-notice';
import {
  EMPTY_PAGER,
  contactsListParams,
  cursorStackFor,
  resolveActiveWorkspaceId,
  type ContactsPager,
} from '@/components/contacts/workspace-selection';
import { extractContactTags } from '@/lib/cdp';
import type { ContactResponse } from '@acc/contracts';

export default function ContactsPage() {
  const canReadContacts = useCanReadContacts();
  const canManageContacts = useCanManageContacts();
  const selectedOrganizationId = useSession((state) => state.selectedOrganizationId);

  // Workspaces of the active organization only (keyed by it, like MessageListCard)
  const {
    data: workspacesData,
    isLoading: isWorkspacesLoading,
    isSuccess: areWorkspacesLoaded,
    error: workspacesError,
  } = useQuery({
    queryKey: ['workspaces', 'list', selectedOrganizationId, { limit: 50 }],
    queryFn: ({ signal }) => workspacesApi.list({ limit: 50 }, signal),
    enabled: Boolean(canReadContacts && selectedOrganizationId),
  });

  const workspaces = workspacesData?.data ?? [];
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('');

  // Keyset cursor pagination history, bound to the workspace it was built for
  const [pager, setPager] = useState<ContactsPager>(EMPTY_PAGER);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedTagFilter, setSelectedTagFilter] = useState<string>('');

  // Dialog states
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [consentTargetContact, setConsentTargetContact] = useState<ContactResponse | null>(null);
  const [detailTargetContact, setDetailTargetContact] = useState<ContactResponse | null>(null);
  const [editTargetContact, setEditTargetContact] = useState<ContactResponse | null>(null);
  const [createdRecord, setCreatedRecord] = useState<CreatedContactRecord | null>(null);

  // State adjustment during render when the organization changes (React recommended
  // pattern, as in MessageListCard): no render under the new organization may use the
  // previous organization's workspace, page or created-contact notice.
  const [prevOrganizationId, setPrevOrganizationId] = useState(selectedOrganizationId);
  const organizationChanged = selectedOrganizationId !== prevOrganizationId;
  if (organizationChanged) {
    setPrevOrganizationId(selectedOrganizationId);
    setSelectedWorkspaceId('');
    setPager(EMPTY_PAGER);
    setSearchQuery('');
    setSelectedTagFilter('');
    setCreatedRecord(null);
    setConsentTargetContact(null);
    setDetailTargetContact(null);
    setEditTargetContact(null);
    // The create form belongs to the previous organization's workspace: close it
    // (the dialog is also remounted per organization below, clearing its fields).
    setIsCreateOpen(false);
  }

  // Only a workspace fetched for the active organization is ever used ('' = none).
  const activeWorkspaceId = resolveActiveWorkspaceId(
    organizationChanged ? '' : selectedWorkspaceId,
    workspaces,
  );
  const cursorStack = cursorStackFor(pager, activeWorkspaceId);
  const currentCursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : undefined;

  const handleWorkspaceChange = (newWsId: string) => {
    setSelectedWorkspaceId(newWsId);
    setPager(EMPTY_PAGER);
    setSearchQuery('');
    setSelectedTagFilter('');
    setCreatedRecord(null);
  };

  // Newest first, so a contact just created is at the top of the first page (#30).
  const queryParams: ListContactsParams = contactsListParams(currentCursor);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    // Workspace stays the third key element: creation invalidates ['contacts', 'list', workspaceId].
    queryKey: ['contacts', 'list', activeWorkspaceId, selectedOrganizationId, queryParams],
    queryFn: ({ signal }) => contactsApi.list(activeWorkspaceId, queryParams, signal),
    enabled: Boolean(canReadContacts && selectedOrganizationId && activeWorkspaceId),
  });

  const rawContacts = data?.data ?? [];

  // Collect unique tags on the current page for quick filtering
  const availableTags = Array.from(
    new Set(rawContacts.flatMap((c) => extractContactTags(c.metadata))),
  ).sort();

  const contacts = rawContacts.filter((c) => {
    // 1. Tag filter
    if (selectedTagFilter) {
      const cTags = extractContactTags(c.metadata);
      if (!cTags.some((t) => t.toLowerCase() === selectedTagFilter.toLowerCase())) {
        return false;
      }
    }

    // 2. Search query filter
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;

    const fullName = `${c.firstName || ''} ${c.lastName || ''}`.toLowerCase();
    const nameMatch = fullName.includes(q);
    const idMatch = c.id.toLowerCase().includes(q);
    const tagMatch = extractContactTags(c.metadata).some((t) => t.toLowerCase().includes(q));
    const metaMatch = JSON.stringify(c.metadata).toLowerCase().includes(q);

    return nameMatch || idMatch || tagMatch || metaMatch;
  });

  const handleNextPage = () => {
    if (data?.page.nextCursor) {
      setPager({
        workspaceId: activeWorkspaceId,
        cursorStack: [...cursorStack, data.page.nextCursor],
      });
    }
  };

  const handlePrevPage = () => {
    setPager({ workspaceId: activeWorkspaceId, cursorStack: cursorStack.slice(0, -1) });
  };

  if (!canReadContacts) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center shadow-xs">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">Access Forbidden</h2>
        <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
          You do not have permission to view contacts. This section requires the{' '}
          <code className="text-xs">contacts.read</code> permission for the active organization or
          workspace.
        </p>
      </div>
    );
  }

  const pageInfo = data?.page;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">
            Contacts & Consent
          </h1>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Workspace contacts directory, communication identities, and opt-in/opt-out consent
            management
          </p>
        </div>

        {canManageContacts && activeWorkspaceId && (
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            data-testid="create-contact-btn"
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 shadow-xs"
          >
            Create Contact
          </button>
        )}
      </div>

      {/* Workspace selector bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3 shadow-xs">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <label
              htmlFor="select-workspace"
              className="text-xs font-medium text-[var(--color-ink-muted)]"
            >
              Target Workspace:
            </label>
            <select
              id="select-workspace"
              value={activeWorkspaceId}
              onChange={(e) => handleWorkspaceChange(e.target.value)}
              disabled={isWorkspacesLoading || workspaces.length === 0}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-xs text-[var(--color-ink)]"
            >
              {workspaces.length === 0 ? (
                <option value="">No workspaces available</option>
              ) : (
                workspaces.map((ws) => (
                  <option key={ws.id} value={ws.id}>
                    {ws.name} ({ws.id.slice(0, 8)}…)
                  </option>
                ))
              )}
            </select>
          </div>

          {activeWorkspaceId && (
            <>
              <div className="flex items-center gap-2">
                <label
                  htmlFor="search-contacts"
                  className="text-xs font-medium text-[var(--color-ink-muted)]"
                >
                  Search:
                </label>
                <div className="relative">
                  <input
                    id="search-contacts"
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter name, tag or ID…"
                    className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-xs text-[var(--color-ink)] w-36 sm:w-48 pr-6"
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={() => setSearchQuery('')}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
                      aria-label="Clear contact search"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>

              {availableTags.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <label
                    htmlFor="filter-tag"
                    className="text-xs font-medium text-[var(--color-ink-muted)]"
                  >
                    Tag:
                  </label>
                  <select
                    id="filter-tag"
                    value={selectedTagFilter}
                    onChange={(e) => setSelectedTagFilter(e.target.value)}
                    data-testid="filter-contact-tag"
                    className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-1 text-xs text-[var(--color-ink)]"
                  >
                    <option value="">All Tags ({availableTags.length})</option>
                    {availableTags.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </>
          )}
        </div>

        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching || !activeWorkspaceId}
          className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]"
        >
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Created-contact notice (QAF-019) */}
      {shouldShowCreatedContactNotice(createdRecord, selectedOrganizationId, activeWorkspaceId) && (
        <ContactCreatedNotice
          contact={createdRecord.contact}
          canManageContacts={canManageContacts}
          onManageConsent={setConsentTargetContact}
          onDismiss={() => setCreatedRecord(null)}
        />
      )}

      {/* Error state */}
      {error && (
        <div
          className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-400"
          role="alert"
        >
          {error instanceof ApiError
            ? `Failed to load contacts (${error.code}): ${error.message}`
            : 'An unexpected error occurred while loading contacts.'}
        </div>
      )}

      {/* Workspaces failed to load: distinct from an organization with no workspaces */}
      {workspacesError && (
        <div
          className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-400"
          role="alert"
          data-testid="workspaces-load-error"
        >
          {workspacesError instanceof ApiError
            ? `Failed to load workspaces (${workspacesError.code}): ${workspacesError.message}`
            : 'Failed to load workspaces. Check your connection and reload the page to try again.'}
        </div>
      )}

      {/* No workspaces warning */}
      {areWorkspacesLoaded && workspaces.length === 0 && (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center shadow-xs">
          <p className="text-xs text-[var(--color-ink-muted)]">
            No workspaces exist in this organization. Contacts are workspace-scoped under Model B.
            Please create a workspace before managing contacts.
          </p>
        </div>
      )}

      {/* Contacts Table */}
      {activeWorkspaceId && (
        <div className="overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs" data-testid="contacts-table">
              <thead>
                <tr className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]">
                  <th scope="col" className="px-4 py-3 font-medium">
                    Contact Name
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Contact ID
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    CDP Tags
                  </th>
                  <th
                    scope="col"
                    className="px-4 py-3 font-medium"
                    aria-sort="descending"
                    data-testid="contacts-created-header"
                  >
                    Created Date <span className="font-normal">(newest first)</span>
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium text-right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)]">
                {isLoading ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-[var(--color-ink-muted)]">
                      Loading contacts…
                    </td>
                  </tr>
                ) : contacts.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-[var(--color-ink-muted)]">
                      {searchQuery.trim() || selectedTagFilter
                        ? `No contacts matching current filter criteria.`
                        : 'No contacts found in this workspace.'}
                    </td>
                  </tr>
                ) : (
                  contacts.map((c) => {
                    const fullName =
                      c.firstName || c.lastName
                        ? `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim()
                        : 'Unnamed Contact';
                    const cTags = extractContactTags(c.metadata);

                    return (
                      <tr
                        key={c.id}
                        data-testid={`contact-row-${c.id}`}
                        className="hover:bg-[var(--color-surface-raised)]"
                      >
                        <td className="px-4 py-3 font-medium text-[var(--color-ink)]">
                          <Link
                            href={`/contacts/${c.id}`}
                            data-testid={`contact-link-${c.id}`}
                            className="hover:text-indigo-400 transition-colors inline-flex items-center gap-2"
                          >
                            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-indigo-600/10 text-indigo-400 font-mono text-[10px] font-bold">
                              {c.firstName?.[0] || c.lastName?.[0] || 'C'}
                            </span>
                            <span>{fullName}</span>
                          </Link>
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] text-[var(--color-ink-muted)]">
                          {c.id}
                        </td>
                        <td className="px-4 py-3">
                          {cTags.length === 0 ? (
                            <span className="text-[var(--color-ink-muted)] text-[11px]">—</span>
                          ) : (
                            <div className="flex flex-wrap items-center gap-1">
                              {cTags.slice(0, 2).map((t) => (
                                <span
                                  key={t}
                                  className="rounded-full bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2 py-0.2 font-mono text-[9px] uppercase font-semibold"
                                >
                                  {t}
                                </span>
                              ))}
                              {cTags.length > 2 && (
                                <span className="text-[10px] text-[var(--color-ink-muted)] font-mono">
                                  +{cTags.length - 2}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-[var(--color-ink-muted)]">
                          {new Date(c.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <Link
                              href={`/contacts/${c.id}`}
                              data-testid={`profile-contact-btn-${c.id}`}
                              className="rounded-md bg-indigo-600/10 text-indigo-400 border border-indigo-500/20 px-2 py-1 text-[11px] font-medium hover:bg-indigo-600 hover:text-white transition-colors"
                            >
                              Profile
                            </Link>
                            <button
                              type="button"
                              onClick={() => setDetailTargetContact(c)}
                              data-testid={`view-contact-btn-${c.id}`}
                              className="rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                            >
                              Details
                            </button>
                            {canManageContacts && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => setEditTargetContact(c)}
                                  data-testid={`edit-contact-btn-${c.id}`}
                                  className="rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setConsentTargetContact(c)}
                                  data-testid={`manage-consent-btn-${c.id}`}
                                  className="rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                                >
                                  Consent
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Keyset pagination footer */}
          {pageInfo && (
            <div
              role="status"
              className="flex items-center justify-between border-t border-[var(--color-border-subtle)] px-4 py-3 text-xs text-[var(--color-ink-muted)]"
            >
              <span>
                Page limit: {pageInfo.limit}
                {cursorStack.length > 0 && ` • Page offset ${cursorStack.length + 1}`}
                {searchQuery && ` • ${contacts.length} filtered on page`}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handlePrevPage}
                  disabled={cursorStack.length === 0}
                  className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 hover:bg-[var(--color-surface-raised)] disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={handleNextPage}
                  disabled={!pageInfo.hasMore}
                  className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 hover:bg-[var(--color-surface-raised)] disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Dialogs */}
      <ContactCreateDialog
        key={selectedOrganizationId ?? 'no-organization'}
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        workspaceId={activeWorkspaceId}
        onCreated={(contact) => {
          setCreatedRecord({ contact, organizationId: selectedOrganizationId });
          // Back to the first page, where the newest contact is listed (#30).
          setPager(EMPTY_PAGER);
        }}
      />

      <ContactConsentDialog
        open={Boolean(consentTargetContact)}
        onOpenChange={(open) => !open && setConsentTargetContact(null)}
        contact={consentTargetContact}
      />

      <ContactDetailDialog
        open={Boolean(detailTargetContact)}
        onOpenChange={(open) => !open && setDetailTargetContact(null)}
        contact={detailTargetContact}
        canManage={canManageContacts}
        onRecordConsent={(contact) => setConsentTargetContact(contact)}
      />

      <ContactEditDialog
        open={Boolean(editTargetContact)}
        onOpenChange={(open) => !open && setEditTargetContact(null)}
        contact={editTargetContact}
      />
    </div>
  );
}
