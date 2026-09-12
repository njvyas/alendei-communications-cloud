'use client';

import { create } from 'zustand';

import type { AuthPrincipal } from '@acc/contracts';

/**
 * Client-side view of the authenticated session.
 *
 * This is presentation state only — it decides what the shell renders, never
 * what the caller is allowed to do. Every authorization decision is made
 * server-side against the resolved principal (`RBAC.md` §2); anything here is
 * trivially editable by the user and is treated accordingly.
 */
interface SessionState {
  status: 'unknown' | 'authenticated' | 'anonymous';
  principal: AuthPrincipal | null;
  setPrincipal(principal: AuthPrincipal | null): void;
  clear(): void;
}

export const useSession = create<SessionState>((set) => ({
  status: 'unknown',
  principal: null,
  setPrincipal: (principal) =>
    set({ principal, status: principal ? 'authenticated' : 'anonymous' }),
  clear: () => set({ principal: null, status: 'anonymous' }),
}));
