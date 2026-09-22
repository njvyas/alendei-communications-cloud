'use client';

import { useSession } from '@/lib/session-store';

/**
 * Organization switcher component displayed in the console header.
 *
 * Enforces security invariant: Users may ONLY switch between organization IDs
 * present in `authorizedOrganizationIds`.
 */
export function OrgSwitcher() {
  const authorizedOrganizationIds = useSession((state) => state.authorizedOrganizationIds);
  const selectedOrganizationId = useSession((state) => state.selectedOrganizationId);
  const selectOrganization = useSession((state) => state.selectOrganization);

  if (authorizedOrganizationIds.length === 0) {
    return null;
  }

  if (authorizedOrganizationIds.length === 1) {
    const orgId = authorizedOrganizationIds[0];
    return (
      <div className="flex items-center gap-1.5 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-mono text-[var(--color-ink-muted)]">
        <span className="font-sans text-[var(--color-ink)]">Org:</span>
        <span className="truncate max-w-[120px] sm:max-w-none">{orgId}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="org-select" className="text-xs font-medium text-[var(--color-ink-muted)]">
        Org:
      </label>
      <select
        id="org-select"
        value={selectedOrganizationId ?? ''}
        onChange={(e) => {
          const val = e.target.value;
          if (val) {
            selectOrganization(val);
          }
        }}
        className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-mono text-[var(--color-ink)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
      >
        {authorizedOrganizationIds.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    </div>
  );
}
