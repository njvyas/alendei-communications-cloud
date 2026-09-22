'use client';

import { useState } from 'react';

import { authApi } from '@/lib/api-client';
import { useSession } from '@/lib/session-store';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';

export function OrgSelectionView() {
  const authorizedOrganizationIds = useSession((state) => state.authorizedOrganizationIds);
  const selectOrganization = useSession((state) => state.selectOrganization);
  const clearSession = useSession((state) => state.clearSession);

  const [selected, setSelected] = useState<string>(authorizedOrganizationIds[0] ?? '');
  const [error, setError] = useState<string | null>(null);

  const handleSelect = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) {
      setError('Please select an organization');
      return;
    }

    try {
      selectOrganization(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to select organization');
    }
  };

  const handleSignOut = async () => {
    try {
      await authApi.logout();
    } finally {
      clearSession();
    }
  };

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md items-center px-4">
      <Card className="w-full">
        <CardTitle>Select Organization</CardTitle>
        <CardDescription>
          Your account has access to multiple organizations. Choose an organization context to continue.
        </CardDescription>

        {error && (
          <div className="mt-4 rounded-md border border-[var(--color-bad)]/20 bg-[var(--color-bad)]/10 p-3 text-xs text-[var(--color-bad)]">
            {error}
          </div>
        )}

        <form onSubmit={handleSelect} className="mt-5 space-y-4">
          <div>
            <label htmlFor="organization-select" className="block text-xs font-medium text-[var(--color-ink-muted)]">
              Authorized Organizations
            </label>
            <select
              id="organization-select"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="mt-1.5 block w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-surface)] px-3 py-2 text-sm font-mono text-[var(--color-ink)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
            >
              {authorizedOrganizationIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-between gap-3 pt-2">
            <button
              type="button"
              onClick={handleSignOut}
              className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]"
            >
              Sign out
            </button>
            <button
              type="submit"
              className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-xs font-medium text-white hover:opacity-90"
            >
              Enter Console
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
