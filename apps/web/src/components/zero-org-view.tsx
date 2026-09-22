'use client';

import { authApi } from '@/lib/api-client';
import { useSession } from '@/lib/session-store';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';

export function ZeroOrgView() {
  const clearSession = useSession((state) => state.clearSession);

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
        <CardTitle>No Organization Access</CardTitle>
        <CardDescription>
          Your account is successfully authenticated, but you do not hold active grants in any organization.
          Tenant-scoped operations are not available.
        </CardDescription>
        <div className="mt-6 flex justify-end">
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
