'use client';

import { create } from 'zustand';

import {
  authApi,
  invalidateSessionEpoch,
  onAuthFailure,
  registerOrgValidator,
  setAccessToken,
  setSelectedOrganization,
  type EffectiveAuthorization,
  type EffectiveGrant,
  type UserIdentity,
} from './api-client';
import { clearAuthenticatedQueryCache } from './query-client';

/**
 * Authentication and organization-context state.
 *
 * Security Invariants:
 * 1. IN-MEMORY ONLY: No persistence (no localStorage, sessionStorage, or cookies).
 *    Access tokens and application-managed credentials are never persisted by JavaScript.
 *    The refresh token remains exclusively in the backend-issued httpOnly cookie.
 * 2. TENANT INTEGRITY: Active organization must always belong to `authorizedOrganizationIds`.
 * 3. NO LEAKS: Tokens, passwords, and credentials are never stored in browser persistence or logged.
 */
export type AuthStatus =
  | 'idle'
  | 'authenticating'
  | 'unauthenticated'
  | 'ready'
  | 'selecting_organization'
  | 'zero_organizations'
  | 'error';

export interface SessionState {
  status: AuthStatus;
  accessToken: string | null;
  user: UserIdentity | null;
  authorization: EffectiveAuthorization | null;
  authorizedOrganizationIds: readonly string[];
  selectedOrganizationId: string | null;
  errorMessage: string | null;

  setSession(params: {
    accessToken: string;
    user: UserIdentity;
    authorization: EffectiveAuthorization;
    selectedOrgId?: string | null;
  }): void;

  selectOrganization(orgId: string): void;
  clearOrganization(): void;
  clearSession(): void;
  setStatus(status: AuthStatus, errorMessage?: string | null): void;
}

export const useSession = create<SessionState>((set, get) => ({
  status: 'idle',
  accessToken: null,
  user: null,
  authorization: null,
  authorizedOrganizationIds: [],
  selectedOrganizationId: null,
  errorMessage: null,

  setSession: ({ accessToken, user, authorization, selectedOrgId = null }) => {
    // A different identity must never render the previous one's cached data,
    // even if its session was not explicitly cleared first. A refresh of the
    // same identity keeps its cache.
    if (get().user?.userId !== user.userId) clearAuthenticatedQueryCache();

    setAccessToken(accessToken);

    const authorizedOrgs = user.authorizedOrganizationIds ?? [];
    let nextStatus: AuthStatus;
    let nextSelectedOrgId: string | null = null;

    if (authorizedOrgs.length === 0) {
      nextStatus = 'zero_organizations';
      nextSelectedOrgId = null;
    } else if (authorizedOrgs.length === 1) {
      nextStatus = 'ready';
      nextSelectedOrgId = authorizedOrgs[0]!;
    } else {
      // Multiple authorized organizations: require explicit selection unless a valid one is supplied
      if (selectedOrgId && authorizedOrgs.includes(selectedOrgId)) {
        nextStatus = 'ready';
        nextSelectedOrgId = selectedOrgId;
      } else {
        nextStatus = 'selecting_organization';
        nextSelectedOrgId = null;
      }
    }

    // Update store state FIRST so orgValidator can see authorizedOrgs
    set({
      status: nextStatus,
      accessToken,
      user,
      authorization,
      authorizedOrganizationIds: authorizedOrgs,
      selectedOrganizationId: nextSelectedOrgId,
      errorMessage: null,
    });

    // Then update in-memory API client
    setSelectedOrganization(nextSelectedOrgId);
  },

  selectOrganization: (orgId: string) => {
    const { authorizedOrganizationIds } = get();

    if (!authorizedOrganizationIds.includes(orgId)) {
      setSelectedOrganization(null);
      set({
        selectedOrganizationId: null,
        status: authorizedOrganizationIds.length > 0 ? 'selecting_organization' : 'zero_organizations',
        errorMessage: `Cannot select unauthorized organization: ${orgId}`,
      });
      throw new Error(`Cannot select unauthorized organization: ${orgId}`);
    }

    setSelectedOrganization(orgId);
    set({
      selectedOrganizationId: orgId,
      status: 'ready',
      errorMessage: null,
    });

    // Re-verify authorization in background so UI reflects latest grants for the newly selected context
    void authApi
      .authorization()
      .then((res) => {
        if (get().selectedOrganizationId === orgId) {
          set({ authorization: res.data });
        }
      })
      .catch(() => {
        // Keep current authorization if probe fails
      });
  },

  clearOrganization: () => {
    const { authorizedOrganizationIds } = get();
    setSelectedOrganization(null);
    set({
      selectedOrganizationId: null,
      status: authorizedOrganizationIds.length > 0 ? 'selecting_organization' : 'zero_organizations',
    });
  },

  clearSession: () => {
    invalidateSessionEpoch();
    setAccessToken(null);
    setSelectedOrganization(null);
    // Gate C M-2: the next identity must not render this one's tenant data.
    clearAuthenticatedQueryCache();
    set({
      status: 'unauthenticated',
      accessToken: null,
      user: null,
      authorization: null,
      authorizedOrganizationIds: [],
      selectedOrganizationId: null,
      errorMessage: null,
    });
  },

  setStatus: (status: AuthStatus, errorMessage: string | null = null) => {
    set({ status, errorMessage });
  },
}));

// Register validator with api-client so raw API calls cannot bypass authorizedOrganizationIds
registerOrgValidator((orgId: string) => {
  const { authorizedOrganizationIds } = useSession.getState();
  return authorizedOrganizationIds.includes(orgId);
});

/**
 * Resolves authoritative grants effective for the currently selected organization.
 * Filters out grants belonging to other organizations while preserving platform grants.
 */
export function getActiveOrganizationGrants(): readonly EffectiveGrant[] {
  const { authorization, selectedOrganizationId } = useSession.getState();
  if (!authorization) return [];
  if (!selectedOrganizationId) {
    return authorization.grants.filter((g) => g.scopeType === 'platform');
  }
  return authorization.grants.filter(
    (g) => g.scopeType === 'platform' || g.orgId === selectedOrganizationId,
  );
}

/**
 * Evaluates whether the current session holds a specific permission in the active organization.
 * Checks for a single grant containing the permission within the active scope, or platform admin.
 */
export function hasPermission(permission: string): boolean {
  const { authorization } = useSession.getState();
  if (!authorization) return false;
  if (authorization.isPlatformAdmin) return true;
  return getActiveOrganizationGrants().some((grant) => grant.permissions.includes(permission));
}

/**
 * React hook to evaluate permission holding reactively within active organization context.
 */
export function useHasPermission(permission: string): boolean {
  return useSession((state) => {
    if (!state.authorization) return false;
    if (state.authorization.isPlatformAdmin) return true;
    const grants = state.selectedOrganizationId
      ? state.authorization.grants.filter(
          (g) => g.scopeType === 'platform' || g.orgId === state.selectedOrganizationId,
        )
      : state.authorization.grants.filter((g) => g.scopeType === 'platform');
    return grants.some((g) => g.permissions.includes(permission));
  });
}

/**
 * Resolves permissions the current actor holds that cover the active organization scope.
 * Implements downward-only inheritance (TENANCY.md §1a.4, RBAC.md §7):
 * - Platform grant covers all scopes.
 * - Organization grant covers this organization.
 * - Workspace and team grants DO NOT cover organization scope.
 */
export function getHeldOrganizationPermissions(): Set<string> {
  const { authorization, selectedOrganizationId } = useSession.getState();
  if (!authorization) return new Set();
  const held = new Set<string>();

  for (const grant of authorization.grants) {
    if (grant.scopeType === 'platform') {
      for (const p of grant.permissions) held.add(p);
    } else if (
      grant.scopeType === 'organization' &&
      selectedOrganizationId &&
      (grant.scopeId === selectedOrganizationId || grant.orgId === selectedOrganizationId)
    ) {
      for (const p of grant.permissions) held.add(p);
    }
  }

  return held;
}

/**
 * React hook returning permissions held by the actor that cover the active organization scope.
 */
export function useHeldOrganizationPermissions(): Set<string> {
  return useSession((state) => {
    if (!state.authorization) return new Set<string>();
    const held = new Set<string>();

    for (const grant of state.authorization.grants) {
      if (grant.scopeType === 'platform') {
        for (const p of grant.permissions) held.add(p);
      } else if (
        grant.scopeType === 'organization' &&
        state.selectedOrganizationId &&
        (grant.scopeId === state.selectedOrganizationId || grant.orgId === state.selectedOrganizationId)
      ) {
        for (const p of grant.permissions) held.add(p);
      }
    }

    return held;
  });
}

/**
 * React hook evaluating whether the actor can access the Organizations administration section.
 * Covered if platform admin, or holding `organizations.read` across any grant (platform, reseller, or org).
 */
export function useCanReadOrganizations(): boolean {
  return useSession((state) => {
    if (!state.authorization) return false;
    if (state.authorization.isPlatformAdmin) return true;
    return state.authorization.grants.some((g) => g.permissions.includes('organizations.read'));
  });
}

/**
 * React hook evaluating whether the actor can provision new organizations.
 * Covered if platform admin, or holding `platform.tenants.manage` at platform scope,
 * or holding `organizations.create` at reseller scope.
 */
export function useCanCreateOrganizations(): boolean {
  return useSession((state) => {
    if (!state.authorization) return false;
    if (state.authorization.isPlatformAdmin) return true;
    return state.authorization.grants.some(
      (g) =>
        (g.scopeType === 'platform' && g.permissions.includes('platform.tenants.manage')) ||
        (g.scopeType === 'reseller' && g.permissions.includes('organizations.create')),
    );
  });
}

/**
 * React hook evaluating whether the actor has platform authority to manage tenant lifecycle
 * (suspend, reactivate, close, or configure billing).
 */
export function useCanManagePlatformTenants(): boolean {
  return useSession((state) => {
    if (!state.authorization) return false;
    if (state.authorization.isPlatformAdmin) return true;
    return state.authorization.grants.some(
      (g) => g.scopeType === 'platform' && g.permissions.includes('platform.tenants.manage'),
    );
  });
}

/**
 * Initializes the session on application startup via silent refresh.
 * Transitions to 'unauthenticated' if no active session exists.
 */
export async function bootstrapSession(): Promise<AuthStatus> {
  const store = useSession.getState();
  if (store.status === 'authenticating' || store.status === 'ready') {
    return store.status;
  }

  store.setStatus('authenticating');

  try {
    const refreshRes = await authApi.refresh();
    const token = refreshRes.data?.accessToken;
    if (!token) {
      store.clearSession();
      return 'unauthenticated';
    }

    const [meRes, authRes] = await Promise.all([authApi.me(), authApi.authorization()]);

    store.setSession({
      accessToken: token,
      user: meRes.data,
      authorization: authRes.data,
    });

    return useSession.getState().status;
  } catch {
    store.clearSession();
    return 'unauthenticated';
  }
}

// Automatically clear the session when the API client determines authentication has terminated
onAuthFailure(() => {
  useSession.getState().clearSession();
});
