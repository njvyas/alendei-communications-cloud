'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, channelsApi, templatesApi, type ListTemplatesParams } from '@/lib/api-client';
import { useCanManageTemplates, useCanReadTemplates, useSession } from '@/lib/session-store';
import { TemplateStatusBadge } from '@/components/templates/template-status-badge';
import { TemplateCreateDialog } from '@/components/templates/template-create-dialog';
import { TemplateApprovalDialog } from '@/components/templates/template-approval-dialog';
import { TemplateEditDialog } from '@/components/templates/template-edit-dialog';
import { TemplateDeleteDialog } from '@/components/templates/template-delete-dialog';
import type { TemplateApprovalStatus, TemplateResponse } from '@acc/contracts';

export default function TemplatesPage() {
  const canReadTemplates = useCanReadTemplates();
  const canManageTemplates = useCanManageTemplates();
  const selectedOrganizationId = useSession((state) => state.selectedOrganizationId);

  // Filters
  const [selectedStatus, setSelectedStatus] = useState<string>('all');

  // Keyset cursor pagination history stack
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const currentCursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : undefined;

  // Dialog states
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [approvalTargetTemplate, setApprovalTargetTemplate] = useState<TemplateResponse | null>(
    null,
  );
  const [editTargetTemplate, setEditTargetTemplate] = useState<TemplateResponse | null>(null);
  const [deleteTargetTemplate, setDeleteTargetTemplate] = useState<TemplateResponse | null>(null);

  // Query channels to display channel names
  const { data: channelsData } = useQuery({
    queryKey: ['channels', 'list', selectedOrganizationId],
    queryFn: ({ signal }) => channelsApi.list({ limit: 50, tenantScoped: true }, signal),
    enabled: Boolean(canReadTemplates && selectedOrganizationId),
  });

  const channels = channelsData?.data ?? [];

  const queryParams: ListTemplatesParams = {
    approvalStatus:
      selectedStatus === 'all' ? undefined : (selectedStatus as TemplateApprovalStatus),
    cursor: currentCursor,
    limit: 25,
  };

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['templates', 'list', queryParams],
    queryFn: ({ signal }) => templatesApi.list(queryParams, signal),
    enabled: canReadTemplates,
  });

  const handleStatusFilterChange = (val: string) => {
    setSelectedStatus(val);
    setCursorStack([]);
  };

  const handleNextPage = () => {
    if (data?.page.nextCursor) {
      setCursorStack((prev) => [...prev, data.page.nextCursor!]);
    }
  };

  const handlePrevPage = () => {
    setCursorStack((prev) => prev.slice(0, -1));
  };

  if (!canReadTemplates) {
    return (
      <div className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-8 text-center shadow-xs">
        <h2 className="text-base font-semibold text-[var(--color-ink)]">Access Forbidden</h2>
        <p className="mt-2 text-xs text-[var(--color-ink-muted)]">
          You do not have permission to view message templates. This section requires the{' '}
          <code className="text-xs">templates.read</code> permission for the active organization.
        </p>
      </div>
    );
  }

  const templates = data?.data ?? [];
  const pageInfo = data?.page;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--color-ink)]">
            Message Templates
          </h1>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Organization message templates, placeholder parameters, and simulated approval workflows
          </p>
        </div>

        {canManageTemplates && (
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            data-testid="create-template-btn"
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 shadow-xs"
          >
            Create Template
          </button>
        )}
      </div>

      {/* Filter and controls bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-surface)] p-3 shadow-xs">
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="filter-status" className="text-xs text-[var(--color-ink-muted)]">
            Approval Status:
          </label>
          <select
            id="filter-status"
            value={selectedStatus}
            onChange={(e) => handleStatusFilterChange(e.target.value)}
            className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] px-2.5 py-1 text-xs text-[var(--color-ink)]"
          >
            <option value="all">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="pending">Pending (Simulated)</option>
            <option value="approved">Approved (Simulated)</option>
            <option value="rejected">Rejected (Simulated)</option>
          </select>
        </div>

        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="rounded-md border border-[var(--color-border-subtle)] px-2.5 py-1 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-raised)]"
        >
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Error state */}
      {error && (
        <div
          className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-xs text-rose-400"
          role="alert"
        >
          {error instanceof ApiError
            ? `Failed to load templates (${error.code}): ${error.message}`
            : 'An unexpected error occurred while loading message templates.'}
        </div>
      )}

      {/* Templates Table */}
      <div className="overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-surface)] shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs" data-testid="templates-table">
            <thead>
              <tr className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]">
                <th scope="col" className="px-4 py-3 font-medium">
                  Template Name
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Channel
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Approval Status
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Variables
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Body Preview
                </th>
                <th scope="col" className="px-4 py-3 font-medium text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-subtle)]">
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-[var(--color-ink-muted)]">
                    <span role="status">Loading templates…</span>
                  </td>
                </tr>
              ) : templates.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-[var(--color-ink-muted)]">
                    No message templates found for the selected criteria.
                  </td>
                </tr>
              ) : (
                templates.map((tpl) => {
                  const channel = channels.find((c) => c.id === tpl.channelId);
                  const channelName = channel ? channel.code.toUpperCase() : 'UNKNOWN';

                  return (
                    <tr
                      key={tpl.id}
                      data-testid={`template-row-${tpl.id}`}
                      className="hover:bg-[var(--color-surface-raised)]"
                    >
                      <td className="px-4 py-3 font-medium text-[var(--color-ink)]">
                        <div>{tpl.name}</div>
                        <div className="font-mono text-[10px] text-[var(--color-ink-muted)]">
                          {tpl.id.slice(0, 8)}…
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="rounded bg-[var(--color-surface-raised)] border border-[var(--color-border-subtle)] px-1.5 py-0.5 font-mono text-[10px] font-medium text-[var(--color-ink)]">
                          {channelName}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <TemplateStatusBadge status={tpl.approvalStatus} />
                      </td>
                      <td className="px-4 py-3 text-[var(--color-ink-muted)]">
                        {tpl.variables && tpl.variables.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {tpl.variables.map((v) => (
                              <span
                                key={v}
                                className="rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-ink)] border border-[var(--color-border-subtle)]"
                              >
                                {`{{${v}}}`}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-[10px] italic">None</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-[var(--color-ink-muted)] max-w-xs truncate font-mono text-[11px]">
                        {tpl.body}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {canManageTemplates && (
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => setEditTargetTemplate(tpl)}
                              data-testid={`edit-template-btn-${tpl.id}`}
                              className="rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => setApprovalTargetTemplate(tpl)}
                              data-testid={`simulate-approval-btn-${tpl.id}`}
                              className="rounded-md border border-[var(--color-border-subtle)] px-2 py-1 text-[11px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
                            >
                              Approval
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleteTargetTemplate(tpl)}
                              data-testid={`delete-template-btn-${tpl.id}`}
                              className="rounded-md border border-rose-500/30 px-2 py-1 text-[11px] text-rose-400 hover:bg-rose-500/10"
                            >
                              Delete
                            </button>
                          </div>
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

      {/* Dialogs */}
      <TemplateCreateDialog open={isCreateOpen} onOpenChange={setIsCreateOpen} />

      <TemplateApprovalDialog
        open={Boolean(approvalTargetTemplate)}
        onOpenChange={(open) => !open && setApprovalTargetTemplate(null)}
        template={approvalTargetTemplate}
      />

      <TemplateEditDialog
        open={Boolean(editTargetTemplate)}
        onOpenChange={(open) => !open && setEditTargetTemplate(null)}
        template={editTargetTemplate}
      />

      <TemplateDeleteDialog
        open={Boolean(deleteTargetTemplate)}
        onOpenChange={(open) => !open && setDeleteTargetTemplate(null)}
        template={deleteTargetTemplate}
      />
    </div>
  );
}
