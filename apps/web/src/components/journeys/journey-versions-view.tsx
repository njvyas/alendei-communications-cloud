'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { journeysApi } from '@/lib/api-client';
import type { JourneyVersionRecord, JourneyVersionSummary } from '@/lib/journeys';
import { JourneyVersionStatusBadge } from './journey-status-badge';
import { AccessibleDialog } from '@/components/ui/dialog';
import { toast } from '@/lib/toast';

export interface JourneyVersionsViewProps {
  readonly workspaceId: string;
  readonly journeyId: string;
  readonly canManage?: boolean;
  readonly onSelectVersion?: (version: JourneyVersionRecord) => void;
}

export function JourneyVersionsView({
  workspaceId,
  journeyId,
  canManage = true,
  onSelectVersion,
}: JourneyVersionsViewProps) {
  const queryClient = useQueryClient();
  const [isCreatingDraft, setIsCreatingDraft] = useState(false);
  const [inspectingVersion, setInspectingVersion] = useState<JourneyVersionRecord | null>(null);

  const { data: versionsData, isLoading } = useQuery({
    queryKey: ['journeys', workspaceId, journeyId, 'versions'],
    queryFn: ({ signal }) => journeysApi.listVersions(workspaceId, journeyId, signal),
  });

  const versions: readonly JourneyVersionSummary[] = versionsData?.data ?? [];

  const handleInspect = async (versionId: string) => {
    try {
      const res = await journeysApi.getVersion(workspaceId, journeyId, versionId);
      setInspectingVersion(res.data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load version details.';
      toast.error(msg);
    }
  };

  const handleCreateDraft = async () => {
    if (!canManage || isCreatingDraft) return;
    setIsCreatingDraft(true);
    try {
      const res = await journeysApi.createVersion(workspaceId, journeyId);
      toast.success(`Draft version v${res.data.versionNumber} initialized.`);
      await queryClient.invalidateQueries({ queryKey: ['journeys', workspaceId, journeyId] });
      if (onSelectVersion) {
        onSelectVersion(res.data);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create new version.';
      toast.error(msg);
    } finally {
      setIsCreatingDraft(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Top Header */}
      <div className="flex items-center justify-between border-b border-acc-border pb-3">
        <div>
          <h3 className="text-sm font-semibold text-acc-text-primary">Version History</h3>
          <p className="text-xs text-acc-text-secondary mt-0.5">
            Published versions are immutable. In-flight contact executions continue on their pinned
            version.
          </p>
        </div>

        {canManage && (
          <button
            type="button"
            onClick={handleCreateDraft}
            disabled={isCreatingDraft}
            className="rounded-lg bg-acc-accent px-3 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-acc-accent-hover focus:outline-hidden disabled:opacity-50"
          >
            {isCreatingDraft ? 'Initializing…' : '+ New Draft Version'}
          </button>
        )}
      </div>

      {/* Version Table */}
      {isLoading ? (
        <p role="status" className="py-8 text-center text-xs text-acc-text-secondary animate-pulse">
          Loading version history…
        </p>
      ) : versions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-acc-border bg-acc-surface/50 p-8 text-center text-xs text-acc-text-secondary">
          No versions found.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-acc-border bg-acc-surface">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-acc-border bg-acc-surface-raised/50 text-[11px] uppercase tracking-wider text-acc-text-secondary">
              <tr>
                <th scope="col" className="px-4 py-3">
                  Version
                </th>
                <th scope="col" className="px-4 py-3">
                  Status
                </th>
                <th scope="col" className="px-4 py-3">
                  Created
                </th>
                <th scope="col" className="px-4 py-3">
                  Published
                </th>
                <th scope="col" className="px-4 py-3 font-mono">
                  SHA-256 Hash
                </th>
                <th scope="col" className="px-4 py-3 text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-acc-border">
              {versions.map((ver) => (
                <tr key={ver.id} className="hover:bg-acc-surface-raised/40 transition-colors">
                  <td className="px-4 py-3 font-mono font-semibold text-acc-text-primary">
                    v{ver.versionNumber}
                  </td>
                  <td className="px-4 py-3">
                    <JourneyVersionStatusBadge status={ver.status} />
                  </td>
                  <td className="px-4 py-3 text-acc-text-secondary">
                    {new Date(ver.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 text-acc-text-secondary">
                    {ver.publishedAt ? new Date(ver.publishedAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-3 font-mono text-[10px] text-acc-text-tertiary">
                    {ver.graphSha256 ? `${ver.graphSha256.slice(0, 16)}…` : '—'}
                  </td>
                  <td className="px-4 py-3 text-right space-x-2">
                    <button
                      type="button"
                      onClick={() => handleInspect(ver.id)}
                      className="rounded border border-acc-border px-2.5 py-1 text-[11px] font-medium text-acc-text-secondary hover:text-acc-text-primary hover:bg-acc-surface-raised"
                    >
                      Inspect
                    </button>
                    {canManage && ver.status === 'published' && (
                      <button
                        type="button"
                        onClick={handleCreateDraft}
                        disabled={isCreatingDraft}
                        className="rounded border border-acc-accent/60 bg-acc-accent/10 px-2.5 py-1 text-[11px] font-medium text-acc-accent hover:bg-acc-accent/20"
                      >
                        New Draft
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Inspect Historical Graph Modal */}
      <AccessibleDialog
        isOpen={Boolean(inspectingVersion)}
        onClose={() => setInspectingVersion(null)}
        titleId="inspect-version-title"
        maxWidth="max-w-3xl"
      >
        {inspectingVersion && (
          <div className="flex max-h-[80vh] flex-col text-acc-text-primary">
            <div className="flex items-center justify-between border-b border-acc-border pb-3">
              <div>
                <h3 id="inspect-version-title" className="text-base font-semibold">
                  Graph Definition: Version {inspectingVersion.versionNumber}
                </h3>
                <p className="font-mono text-xs text-acc-text-secondary">
                  Hash: {inspectingVersion.graphSha256 || 'Pending'} ·{' '}
                  {Object.keys(inspectingVersion.graph.nodes).length} nodes
                </p>
              </div>
              <button
                type="button"
                onClick={() => setInspectingVersion(null)}
                className="rounded-lg p-1.5 text-acc-text-secondary hover:bg-acc-surface-raised"
                aria-label="Close inspection dialog"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto my-4 rounded-lg border border-acc-border bg-acc-bg p-4">
              <pre className="font-mono text-xs text-acc-text-secondary overflow-x-auto">
                {JSON.stringify(inspectingVersion.graph, null, 2)}
              </pre>
            </div>

            <div className="flex justify-end gap-3 pt-2 border-t border-acc-border">
              <button
                type="button"
                onClick={() => setInspectingVersion(null)}
                className="rounded-lg border border-acc-border px-4 py-1.5 text-xs font-medium text-acc-text-secondary hover:bg-acc-surface-raised"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </AccessibleDialog>
    </div>
  );
}
