'use client';

import { useSession } from '@/lib/session-store';
import { StatusDot } from '@/components/ui/status-dot';

/**
 * Shows whether the shell currently believes it has a session. It reflects
 * client state only — the server decides access on every request regardless of
 * what this displays.
 */
export function SessionBadge() {
  const status = useSession((state) => state.status);
  const principal = useSession((state) => state.principal);

  if (status === 'authenticated' && principal) {
    return <StatusDot tone="ok" label={principal.actorType} />;
  }

  return <StatusDot tone="unknown" label="Not signed in" />;
}
