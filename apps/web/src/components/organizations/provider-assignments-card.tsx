'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  channelsApi,
  providersApi,
  providerAssignmentsApi,
  type OrganizationProviderAssignment,
  type OrganizationStatus,
} from '@/lib/api-client';
import { useCanManageProviders, useCanReadProviders } from '@/lib/session-store';
import { StatusDot } from '@/components/ui/status-dot';
import { ActionFeedback, type ActionFeedbackMessage } from '@/components/ui/action-feedback';
import {
  AssignProviderDialog,
  UpdatePriorityDialog,
  ToggleAssignmentDialog,
} from './provider-assignment-dialogs';

export interface ProviderAssignmentsCardProps {
  readonly orgId: string;
  readonly orgStatus: OrganizationStatus;
}

export function ProviderAssignmentsCard({ orgId, orgStatus }: ProviderAssignmentsCardProps) {
  const canReadProviders = useCanReadProviders();
  const canManageProviders = useCanManageProviders();
  const allowMutations = canManageProviders && orgStatus !== 'closed';

  const [isAssignOpen, setIsAssignOpen] = useState(false);
  const [editingAssignment, setEditingAssignment] = useState<OrganizationProviderAssignment | null>(
    null,
  );
  const [togglingAssignment, setTogglingAssignment] = useState<{
    readonly assignment: OrganizationProviderAssignment;
    readonly action: 'enable' | 'disable';
  } | null>(null);
  const [feedback, setFeedback] = useState<ActionFeedbackMessage | null>(null);

  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);

  // 1. Fetch Assignments for this organization
  const queryKey = cursor
    ? ['organizations', orgId, 'provider-assignments', cursor]
    : ['organizations', orgId, 'provider-assignments'];

  const {
    data: assignmentsData,
    isLoading: isAssignmentsLoading,
    error: assignmentsError,
    refetch: refetchAssignments,
  } = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      providerAssignmentsApi.list(orgId, { limit: 50, ...(cursor ? { cursor } : {}) }, signal),
    enabled: canReadProviders && Boolean(orgId),
  });

  // 2. Fetch Platform Providers catalogue
  const {
    data: providersData,
    isLoading: isProvidersLoading,
    error: providersError,
  } = useQuery({
    queryKey: ['providers', 'list'],
    queryFn: ({ signal }) => providersApi.list({ limit: 100 }, signal),
    enabled: canReadProviders,
  });

  // 3. Fetch Platform Channels
  const {
    data: channelsData,
    isLoading: isChannelsLoading,
    error: channelsError,
  } = useQuery({
    queryKey: ['channels', 'list'],
    queryFn: ({ signal }) => channelsApi.list({ limit: 50 }, signal),
    enabled: canReadProviders,
  });

  // Fail-closed permission gate: if actor cannot read platform providers, suppress the card
  if (!canReadProviders) {
    return null;
  }

  const isLoading = isAssignmentsLoading || isProvidersLoading || isChannelsLoading;
  const loadError = assignmentsError || providersError || channelsError;

  const assignments = assignmentsData?.data ?? [];
  const providers = providersData?.data ?? [];
  const channels = channelsData?.data ?? [];

  const channelMap = new Map(channels.map((c) => [c.id, c]));
  const providerMap = new Map(providers.map((p) => [p.id, p]));

  // Sort assignments: group by channel display name, then by priority ascending
  const sortedAssignments = [...assignments].sort((a, b) => {
    const channelA = channelMap.get(a.channelId)?.displayName ?? a.channelId;
    const channelB = channelMap.get(b.channelId)?.displayName ?? b.channelId;
    if (channelA !== channelB) return channelA.localeCompare(channelB);
    return a.priority - b.priority;
  });

  // Helper to find editing assignment provider/channel names
  const editingProvider = editingAssignment
    ? providerMap.get(editingAssignment.providerId)
    : undefined;
  const editingChannel = editingAssignment
    ? channelMap.get(editingAssignment.channelId)
    : undefined;
  const editingOtherPriorities = editingAssignment
    ? assignments
        .filter((a) => a.channelId === editingAssignment.channelId && a.id !== editingAssignment.id)
        .map((a) => a.priority)
    : [];

  // Helper for toggling assignment
  const togglingProvider = togglingAssignment
    ? providerMap.get(togglingAssignment.assignment.providerId)
    : undefined;
  const togglingChannel = togglingAssignment
    ? channelMap.get(togglingAssignment.assignment.channelId)
    : undefined;

  const handleNextPage = () => {
    const nextCursor = assignmentsData?.page.nextCursor;
    if (nextCursor) {
      setCursorHistory((prev) => [...prev.slice(0, pageIndex + 1), nextCursor]);
      setCursor(nextCursor);
      setPageIndex((prev) => prev + 1);
    }
  };

  const handlePreviousPage = () => {
    if (pageIndex > 0) {
      const prevIndex = pageIndex - 1;
      const prevCursor = cursorHistory[prevIndex] ?? null;
      setCursor(prevCursor);
      setPageIndex(prevIndex);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-5">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-[var(--color-border-subtle)]">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-[var(--color-ink)]">
              Provider Assignments
            </h2>
            <span className="rounded-full bg-[var(--color-surface-raised)] border border-[var(--color-border-subtle)] px-2 py-0.5 text-[11px] font-mono text-[var(--color-ink-muted)]">
              {assignments.length}
            </span>
          </div>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            Priority-ordered routing candidates for outbound message dispatch across communication
            channels.
          </p>
        </div>

        {allowMutations && (
          <button
            type="button"
            onClick={() => {
              setFeedback(null);
              setIsAssignOpen(true);
            }}
            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            + Assign Provider
          </button>
        )}
      </div>

      {/* Card Banner Feedback */}
      {feedback && (
        <div className="mt-4">
          <ActionFeedback feedback={feedback} onDismiss={() => setFeedback(null)} />
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div role="status" className="flex items-center justify-center p-8">
          <div className="flex items-center gap-3">
            <div className="size-4 animate-spin rounded-full border-2 border-[var(--color-accent)] border-t-transparent" />
            <p className="text-xs text-[var(--color-ink-muted)]">Loading provider assignments…</p>
          </div>
        </div>
      )}

      {/* Error state */}
      {!isLoading && loadError && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-4 text-center"
        >
          <p className="text-xs font-medium text-[var(--color-bad)]">
            Failed to load provider assignments
          </p>
          <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
            {loadError instanceof Error
              ? loadError.message
              : 'An error occurred while fetching assignments.'}
          </p>
          <button
            type="button"
            onClick={() => refetchAssignments()}
            className="mt-3 rounded-md bg-[var(--color-surface)] border border-[var(--color-border-subtle)] px-3 py-1 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
          >
            Retry
          </button>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !loadError && sortedAssignments.length === 0 && (
        <div className="p-8 text-center">
          <p className="text-xs font-medium text-[var(--color-ink-muted)]">
            No provider assignments configured
          </p>
          <p className="mt-1 text-[11px] text-[var(--color-ink-muted)]">
            Outbound messages for this tenant cannot be dispatched until at least one provider is
            assigned per channel.
          </p>
          {allowMutations && (
            <button
              type="button"
              onClick={() => setIsAssignOpen(true)}
              className="mt-4 inline-block rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
            >
              Assign First Provider
            </button>
          )}
        </div>
      )}

      {/* Assignments Table */}
      {!isLoading && !loadError && sortedAssignments.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--color-border-subtle)] text-[11px] font-medium text-[var(--color-ink-muted)]">
                <th scope="col" className="pb-2.5 font-medium">
                  Channel
                </th>
                <th scope="col" className="pb-2.5 font-medium">
                  Provider
                </th>
                <th scope="col" className="pb-2.5 font-medium">
                  Adapter
                </th>
                <th scope="col" className="pb-2.5 font-medium text-center">
                  Priority
                </th>
                <th scope="col" className="pb-2.5 font-medium">
                  Status
                </th>
                {allowMutations && (
                  <th scope="col" className="pb-2.5 font-medium text-right">
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-subtle)]">
              {sortedAssignments.map((assignment) => {
                const provider = providerMap.get(assignment.providerId);
                const channel = channelMap.get(assignment.channelId);
                const channelDisplayName = channel?.displayName ?? assignment.channelId;
                const providerDisplayName = provider?.name ?? assignment.providerId;
                const adapterKey = provider?.adapterKey ?? '—';
                const isActive = assignment.status === 'active';

                return (
                  <tr key={assignment.id} className="hover:bg-[var(--color-surface-raised)]/50">
                    <td className="py-3 font-medium text-[var(--color-ink)]">
                      {channelDisplayName}
                    </td>
                    <td className="py-3 text-[var(--color-ink)]">{providerDisplayName}</td>
                    <td className="py-3 font-mono text-[11px] text-[var(--color-ink-muted)]">
                      {adapterKey}
                    </td>
                    <td className="py-3 text-center">
                      <span className="inline-block rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2 py-0.5 font-mono text-[11px] font-semibold text-[var(--color-ink)]">
                        #{assignment.priority}
                      </span>
                    </td>
                    <td className="py-3">
                      <StatusDot
                        tone={isActive ? 'ok' : 'unknown'}
                        label={isActive ? 'Active' : 'Disabled'}
                      />
                    </td>
                    {allowMutations && (
                      <td className="py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setFeedback(null);
                              setEditingAssignment(assignment);
                            }}
                            className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                          >
                            Edit Priority
                          </button>
                          {isActive ? (
                            <button
                              type="button"
                              onClick={() => {
                                setFeedback(null);
                                setTogglingAssignment({ assignment, action: 'disable' });
                              }}
                              className="rounded border border-[var(--color-bad)]/40 px-2.5 py-1 text-[11px] font-medium text-[var(--color-bad)] hover:bg-[var(--color-bad)]/10"
                            >
                              Disable
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                setFeedback(null);
                                setTogglingAssignment({ assignment, action: 'enable' });
                              }}
                              className="rounded border border-[var(--color-accent)]/40 px-2.5 py-1 text-[11px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10"
                            >
                              Enable
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination Controls */}
      {!isLoading && !loadError && (Boolean(assignmentsData?.page.hasMore) || pageIndex > 0) && (
        <div className="mt-4 flex items-center justify-between border-t border-[var(--color-border-subtle)] pt-3 text-xs">
          <span className="text-[var(--color-ink-muted)]">Page {pageIndex + 1}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pageIndex === 0}
              onClick={handlePreviousPage}
              className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-40 disabled:pointer-events-none"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={!assignmentsData?.page.hasMore || !assignmentsData?.page.nextCursor}
              onClick={handleNextPage}
              className="rounded border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)] disabled:opacity-40 disabled:pointer-events-none"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Assign Provider Dialog */}
      <AssignProviderDialog
        isOpen={isAssignOpen}
        orgId={orgId}
        providers={providers}
        channels={channels}
        existingAssignments={assignments}
        onClose={() => setIsAssignOpen(false)}
        onSuccess={() => {
          setCursor(null);
          setPageIndex(0);
          void refetchAssignments();
          setFeedback({
            type: 'success',
            title: 'Provider Assigned',
            message: 'New provider assignment was added to the organization routing list.',
          });
        }}
      />

      {/* Update Priority Dialog */}
      <UpdatePriorityDialog
        isOpen={editingAssignment !== null}
        orgId={orgId}
        assignment={editingAssignment}
        providerName={editingProvider?.name ?? editingAssignment?.providerId ?? ''}
        channelName={editingChannel?.displayName ?? editingAssignment?.channelId ?? ''}
        otherPrioritiesForChannel={editingOtherPriorities}
        onClose={() => setEditingAssignment(null)}
        onSuccess={() => {
          void refetchAssignments();
          setFeedback({
            type: 'success',
            title: 'Priority Updated',
            message: 'Assignment routing priority was updated successfully.',
          });
        }}
      />

      {/* Toggle Status Dialog */}
      <ToggleAssignmentDialog
        isOpen={togglingAssignment !== null}
        orgId={orgId}
        assignment={togglingAssignment?.assignment ?? null}
        providerName={togglingProvider?.name ?? togglingAssignment?.assignment.providerId ?? ''}
        channelName={togglingChannel?.displayName ?? togglingAssignment?.assignment.channelId ?? ''}
        action={togglingAssignment?.action ?? 'disable'}
        onClose={() => setTogglingAssignment(null)}
        onSuccess={(updated) => {
          void refetchAssignments();
          setFeedback({
            type: 'success',
            title: updated.status === 'active' ? 'Provider Enabled' : 'Provider Disabled',
            message:
              updated.status === 'active'
                ? 'Provider assignment reinstated for active candidate routing.'
                : 'Provider assignment disabled and removed from active candidate routing.',
          });
        }}
      />
    </div>
  );
}
