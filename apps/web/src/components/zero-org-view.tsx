'use client';

import Link from 'next/link';
import { authApi } from '@/lib/api-client';
import { useCanCreateOrganizations, useCanReadProviders, useSession } from '@/lib/session-store';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';

export function ZeroOrgView() {
  const clearSession = useSession((state) => state.clearSession);
  const canCreateOrganizations = useCanCreateOrganizations();
  const canReadProviders = useCanReadProviders();

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
        <CardTitle>
          {canCreateOrganizations ? 'No Organizations' : 'No Organization Access'}
        </CardTitle>
        <CardDescription>
          {canCreateOrganizations
            ? 'No organizations exist yet. Create the first organization to continue.'
            : 'Your account is successfully authenticated, but you do not hold active grants in any organization. Tenant-scoped operations are not available.'}
        </CardDescription>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {canCreateOrganizations && (
              <Link
                href="/organizations"
                className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
              >
                Manage Organizations
              </Link>
            )}
            {canReadProviders && (
              <Link
                href="/providers"
                className="rounded-md bg-[var(--color-surface-raised)] border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
              >
                View Providers
              </Link>
            )}
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            className="rounded-md border border-[var(--color-border-subtle)] px-3 py-1.5 text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface)]"
          >
            Sign out
          </button>
        </div>
      </Card>
    </div>
  );
}
