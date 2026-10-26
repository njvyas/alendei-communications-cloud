'use client';

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, contactsApi, workspacesApi, type ListContactsParams } from '@/lib/api-client';
import { useCanManageContacts, useCanReadContacts, useSession } from '@/lib/session-store';
import { ContactCreateDialog } from '@/components/contacts/contact-create-dialog';
import { ContactConsentDialog } from '@/components/contacts/contact-consent-dialog';
import {
  ContactCreatedNotice,
  shouldShowCreatedContactNotice,
  type CreatedContactRecord,
} from '@/components/contacts/contact-created-notice';
import type { ContactResponse } from '@acc/contracts';

export default function ContactsPage() {
  const canReadContacts = useCanReadContacts();
  const canManageContacts = useCanManageContacts();
  const selectedOrganizationId = useSession((state) => state.selectedOrganizationId);

  // Workspaces list query
  const { data: workspacesData, isLoading: isWorkspacesLoading } = useQuery({
    queryKey: ['workspaces', 'list', { limit: 50 }],
    queryFn: ({ signal }) => workspacesApi.list({ limit: 50 }, signal),
    enabled: canReadContacts,
  });

  const workspaces = workspacesData?.data ?? [];
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('');

  // Automatically select first active workspace when loaded
  useEffect(() => {
    if (!selectedWorkspaceId && workspaces.length > 0) {
      setSelectedWorkspaceId(workspaces[0]!.id);
    }
  }, [selectedWorkspaceId, workspaces]);

  // Keyset cursor pagination history stack
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const currentCursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : undefined;

  // Dialog states
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [consentTargetContact, setConsentTargetContact] = useState<ContactResponse | null>(null);
  const [createdRecord, setCreatedRecord] = useState<CreatedContactRecord | null>(null);

  const handleWorkspaceChange = (newWsId: string) => {
    setSelectedWorkspaceId(newWsId);
    setCursorStack([]);
    setCreatedRecord(null);
  };

  const queryParams: ListContactsParams = {
    cursor: currentCursor,
    limit: 25,
  };

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['contacts', 'list', selectedWorkspaceId, queryParams],
    queryFn: ({ signal }) => contactsApi.list(selectedWorkspaceId, queryParams, signal),
    enabled: Boolean(canReadContacts && selectedWorkspaceId),
  });

  const handleNextPage = () => {
    if (data?.page.nextCursor) {
      setCursorStack((prev) => [...prev, data.page.nextCursor!]);
    }
  };

  const handlePrevPage = () => {
    setCursorStack((prev) => prev.slice(0, -1));
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

  const contacts = data?.data ?? [];
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

        {canManageContacts && selectedWorkspaceId && (
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
          <label
            htmlFor="select-workspace"
            className="text-xs font-medium text-[var(--color-ink-muted)]"
          >
            Target Workspace:
          </label>
          <select
            id="select-workspace"
            value={selectedWorkspaceId}
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

        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching || !selectedWorkspaceId}
          className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]"
        >
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Created-contact notice (QAF-019) */}
      {shouldShowCreatedContactNotice(
        createdRecord,
        selectedOrganizationId,
        selectedWorkspaceId,
      ) && (
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

      {/* No workspaces warning */}
      {!isWorkspacesLoading && workspaces.length === 0 && (
        <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center shadow-xs">
          <p className="text-xs text-[var(--color-ink-muted)]">
            No workspaces exist in this organization. Contacts are workspace-scoped under Model B.
            Please create a workspace before managing contacts.
          </p>
        </div>
      )}

      {/* Contacts Table */}
      {selectedWorkspaceId && (
        <div className="overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs" data-testid="contacts-table">
              <thead>
                <tr className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]">
                  <th className="px-4 py-3 font-medium">Contact Name</th>
                  <th className="px-4 py-3 font-medium">Contact ID</th>
                  <th className="px-4 py-3 font-medium">Created Date</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-subtle)]">
                {isLoading ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-[var(--color-ink-muted)]">
                      Loading contacts…
                    </td>
                  </tr>
                ) : contacts.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-[var(--color-ink-muted)]">
                      No contacts found in this workspace.
                    </td>
                  </tr>
                ) : (
                  contacts.map((c) => {
                    const fullName =
                      c.firstName || c.lastName
                        ? `${c.firstName ?? ''} ${c.lastName ?? ''}`.trim()
                        : 'Unnamed Contact';
                    return (
                      <tr
                        key={c.id}
                        data-testid={`contact-row-${c.id}`}
                        className="hover:bg-[var(--color-surface-raised)]"
                      >
                        <td className="px-4 py-3 font-medium text-[var(--color-ink)]">
                          {fullName}
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] text-[var(--color-ink-muted)]">
                          {c.id}
                        </td>
                        <td className="px-4 py-3 text-[var(--color-ink-muted)]">
                          {new Date(c.createdAt).toLocaleDateString()}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {canManageContacts && (
                            <button
                              type="button"
                              onClick={() => setConsentTargetContact(c)}
                              data-testid={`manage-consent-btn-${c.id}`}
                              className="rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                            >
                              Manage Consent
                            </button>
                          )}
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
            <div className="flex items-center justify-between border-t border-[var(--color-border-subtle)] px-4 py-3 text-xs text-[var(--color-ink-muted)]">
              <span>
                Page limit: {pageInfo.limit}
                {cursorStack.length > 0 && ` • Page offset ${cursorStack.length + 1}`}
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
        open={isCreateOpen}
        onOpenChange={setIsCreateOpen}
        workspaceId={selectedWorkspaceId}
        onCreated={(contact) =>
          setCreatedRecord({ contact, organizationId: selectedOrganizationId })
        }
      />

      <ContactConsentDialog
        open={Boolean(consentTargetContact)}
        onOpenChange={(open) => !open && setConsentTargetContact(null)}
        contact={consentTargetContact}
      />
    </div>
  );
}
