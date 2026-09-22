'use client';

import { useSession } from '@/lib/session-store';
import { StatusDot } from '@/components/ui/status-dot';

/**
 * Visual indicator of client-side authentication status.
 *
 * This is presentation state only — the server makes authoritative authorization
 * decisions on every single request.
 */
export function SessionBadge() {
  const status = useSession((state) => state.status);
  const user = useSession((state) => state.user);

  if (status === 'ready' && user) {
    return <StatusDot tone="ok" label={user.actorType ?? 'authenticated'} />;
  }

  if (status === 'selecting_organization') {
    return <StatusDot tone="warn" label="Select Org" />;
  }

  if (status === 'zero_organizations') {
    return <StatusDot tone="bad" label="No Orgs" />;
  }

  if (status === 'authenticating') {
    return <StatusDot tone="unknown" label="Authenticating…" />;
  }

  return <StatusDot tone="unknown" label="Not signed in" />;
}
