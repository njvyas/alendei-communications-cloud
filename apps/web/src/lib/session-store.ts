'use client';

import { create } from 'zustand';

import {
  grantConfers,
  scopeCovers,
  SCOPE_TYPES,
  SUPER_ADMIN_PERMISSIONS,
  type ScopeChain,
  type ScopeRef,
  type ScopeType,
} from '@acc/contracts';

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
        status:
          authorizedOrganizationIds.length > 0 ? 'selecting_organization' : 'zero_organizations',
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
      status:
        authorizedOrganizationIds.length > 0 ? 'selecting_organization' : 'zero_organizations',
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

const EXPLICIT_PLATFORM_CATALOGUE_PERMISSIONS = new Set<string>([
  'providers.read',
  'providers.manage',
  'providers.test_send',
]);

const SUPER_ADMIN_PERMISSIONS_SET = new Set<string>(SUPER_ADMIN_PERMISSIONS);

function isScopeType(val: string): val is ScopeType {
  return (SCOPE_TYPES as readonly string[]).includes(val);
}

interface EvaluatePermissionParams {
  authorization: EffectiveAuthorization | null;
  selectedOrganizationId: string | null;
  userResellerId: string | null;
  permission: string;
}

function evaluatePermission({
  authorization,
  selectedOrganizationId,
  userResellerId,
  permission,
}: EvaluatePermissionParams): boolean {
  if (!authorization) return false;

  // Platform admin handling:
  // 1. Conferred only for canonical SUPER_ADMIN_PERMISSIONS (ADR-015 R-5 / roles.ts §2).
  // 2. Tenant-content permissions are excluded by construction from SUPER_ADMIN_PERMISSIONS.
  // 3. MUST NOT bypass explicit platform catalogue permissions (providers.*).
  // 4. Unknown, malformed, or deprecated permission strings fail closed.
  if (
    authorization.isPlatformAdmin &&
    SUPER_ADMIN_PERMISSIONS_SET.has(permission) &&
    !EXPLICIT_PLATFORM_CATALOGUE_PERMISSIONS.has(permission)
  ) {
    return true;
  }

  // Active organization context (or platform when no organization is selected).
  // Callers cannot supply arbitrary target scopes or synthetic ancestry chains.
  const target: ScopeRef = selectedOrganizationId
    ? { scopeType: 'organization', scopeId: selectedOrganizationId }
    : { scopeType: 'platform', scopeId: null };

  const chain: ScopeChain = {
    resellerId: userResellerId ?? null,
    orgId: selectedOrganizationId,
  };

  // Grant evaluation: downward-only scope inheritance & admitted scope checks
  return authorization.grants.some((grant) => {
    const scopeType = grant.scopeType as ScopeType;
    if (!isScopeType(scopeType)) return false;

    // Grant must confer the permission (role carries permission AND scope is admitted)
    if (!grantConfers({ scopeType, permissions: grant.permissions }, permission)) {
      return false;
    }

    // Grant must cover the active organization scope within the validated session chain
    const grantScope: ScopeRef = {
      scopeType,
      scopeId: grant.scopeId ?? (scopeType === 'organization' ? grant.orgId : null),
    };

    return scopeCovers(grantScope, target, chain);
  });
}

function resolveHeldOrganizationPermissions(
  authorization: EffectiveAuthorization | null,
  selectedOrganizationId: string | null,
  userResellerId: string | null,
): Set<string> {
  if (!authorization) return new Set();
  const held = new Set<string>();

  if (authorization.isPlatformAdmin) {
    for (const p of SUPER_ADMIN_PERMISSIONS) {
      if (!EXPLICIT_PLATFORM_CATALOGUE_PERMISSIONS.has(p)) {
        held.add(p);
      }
    }
  }

  if (!selectedOrganizationId) {
    for (const grant of authorization.grants) {
      const scopeType = grant.scopeType as ScopeType;
      if (scopeType === 'platform') {
        for (const p of grant.permissions) {
          if (grantConfers({ scopeType: 'platform', permissions: grant.permissions }, p)) {
            held.add(p);
          }
        }
      }
    }
    return held;
  }

  const target: ScopeRef = { scopeType: 'organization', scopeId: selectedOrganizationId };
  const chain: ScopeChain = {
    resellerId: userResellerId ?? null,
    orgId: selectedOrganizationId,
  };

  for (const grant of authorization.grants) {
    const scopeType = grant.scopeType as ScopeType;
    if (!isScopeType(scopeType)) continue;
    const grantScope: ScopeRef = {
      scopeType,
      scopeId: grant.scopeId ?? (scopeType === 'organization' ? grant.orgId : null),
    };
    if (!scopeCovers(grantScope, target, chain)) continue;

    for (const p of grant.permissions) {
      if (grantConfers({ scopeType, permissions: grant.permissions }, p)) {
        held.add(p);
      }
    }
  }

  return held;
}

/**
 * Resolves authoritative grants effective for the currently selected organization.
 * Filters out grants belonging to other organizations while preserving platform grants
 * and valid reseller grants covering the active organization.
 */
export function getActiveOrganizationGrants(): readonly EffectiveGrant[] {
  const { authorization, selectedOrganizationId, user } = useSession.getState();
  if (!authorization) return [];
  if (!selectedOrganizationId) {
    return authorization.grants.filter((g) => g.scopeType === 'platform');
  }

  const target: ScopeRef = { scopeType: 'organization', scopeId: selectedOrganizationId };
  const chain: ScopeChain = {
    resellerId: user?.tenant?.resellerId ?? null,
    orgId: selectedOrganizationId,
  };

  return authorization.grants.filter((grant) => {
    const scopeType = grant.scopeType as ScopeType;
    if (!isScopeType(scopeType)) return false;
    const grantScope: ScopeRef = {
      scopeType,
      scopeId: grant.scopeId ?? (scopeType === 'organization' ? grant.orgId : null),
    };
    return scopeCovers(grantScope, target, chain);
  });
}

/**
 * Evaluates whether the current session holds a specific permission in the active organization context.
 *
 * Implements canonical RBAC rules:
 * 1. Downward-only scope inheritance: platform -> reseller -> organization -> workspace -> team.
 * 2. Team and workspace grants DO NOT confer organization-level authority.
 * 3. Valid reseller grants are recognized for organizations owned by that reseller.
 * 4. Platform administrators do NOT bypass tenant-content permissions or platform catalogue grants.
 * 5. Unknown, malformed, or unauthenticated authorization requests fail closed.
 * 6. Evaluated strictly against the active organization context derived from session state;
 *    no caller-supplied target scopes or unverified ancestry chains are accepted.
 */
export function hasPermission(permission: string): boolean {
  const { authorization, selectedOrganizationId, user } = useSession.getState();
  return evaluatePermission({
    authorization,
    selectedOrganizationId,
    userResellerId: user?.tenant?.resellerId ?? null,
    permission,
  });
}

/**
 * React hook to evaluate permission holding reactively within the active organization context.
 */
export function useHasPermission(permission: string): boolean {
  return useSession((state) =>
    evaluatePermission({
      authorization: state.authorization,
      selectedOrganizationId: state.selectedOrganizationId,
      userResellerId: state.user?.tenant?.resellerId ?? null,
      permission,
    }),
  );
}

/**
 * Resolves permissions the current actor holds that cover the active organization scope.
 * Implements downward-only inheritance (TENANCY.md §1a.4, RBAC.md §7):
 * - Platform grant covers all scopes (subject to admitted scopes).
 * - Reseller grant covers organizations beneath that reseller (subject to admitted scopes).
 * - Organization grant covers this organization.
 * - Workspace and team grants DO NOT cover organization scope.
 */
export function getHeldOrganizationPermissions(): Set<string> {
  const { authorization, selectedOrganizationId, user } = useSession.getState();
  return resolveHeldOrganizationPermissions(
    authorization,
    selectedOrganizationId,
    user?.tenant?.resellerId ?? null,
  );
}

/**
 * React hook returning permissions held by the actor that cover the active organization scope.
 */
export function useHeldOrganizationPermissions(): Set<string> {
  return useSession((state) =>
    resolveHeldOrganizationPermissions(
      state.authorization,
      state.selectedOrganizationId,
      state.user?.tenant?.resellerId ?? null,
    ),
  );
}

/**
 * React hook evaluating whether the actor can access the Organizations administration section.
 * Covered if platform admin, or holding `organizations.read` across any grant covering organizations.
 */
export function useCanReadOrganizations(): boolean {
  return useSession((state) => {
    if (!state.authorization) return false;
    if (state.authorization.isPlatformAdmin) return true;
    return state.authorization.grants.some(
      (g) =>
        (g.scopeType === 'platform' ||
          g.scopeType === 'reseller' ||
          g.scopeType === 'organization') &&
        grantConfers(
          { scopeType: g.scopeType as ScopeType, permissions: g.permissions },
          'organizations.read',
        ),
    );
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
 * Evaluates whether the actor can view the provider/channel catalogue.
 * Requires platform admin or holding `providers.read` at platform scope.
 */
export function canReadProviders(): boolean {
  const { authorization } = useSession.getState();
  if (!authorization) return false;
  return authorization.grants.some(
    (g) => g.scopeType === 'platform' && g.permissions.includes('providers.read'),
  );
}

export function useCanReadProviders(): boolean {
  return useSession((state) => {
    if (!state.authorization) return false;
    return state.authorization.grants.some(
      (g) => g.scopeType === 'platform' && g.permissions.includes('providers.read'),
    );
  });
}

/**
 * Evaluates whether the actor can administer providers or the circuit policy.
 * Requires holding `providers.manage` at platform scope.
 * Platform admin flag alone does NOT substitute for the explicit platform grant.
 */
export function canManageProviders(): boolean {
  const { authorization } = useSession.getState();
  if (!authorization) return false;
  return authorization.grants.some(
    (g) => g.scopeType === 'platform' && g.permissions.includes('providers.manage'),
  );
}

export function useCanManageProviders(): boolean {
  return useSession((state) => {
    if (!state.authorization) return false;
    return state.authorization.grants.some(
      (g) => g.scopeType === 'platform' && g.permissions.includes('providers.manage'),
    );
  });
}

/**
 * Evaluates whether the actor can execute simulator test-sends.
 * Requires holding `providers.test_send` at platform scope.
 * Platform admin flag alone does NOT substitute for the explicit platform grant.
 */
export function canTestSendProviders(): boolean {
  const { authorization } = useSession.getState();
  if (!authorization) return false;
  return authorization.grants.some(
    (g) => g.scopeType === 'platform' && g.permissions.includes('providers.test_send'),
  );
}

export function useCanTestSendProviders(): boolean {
  return useSession((state) => {
    if (!state.authorization) return false;
    return state.authorization.grants.some(
      (g) => g.scopeType === 'platform' && g.permissions.includes('providers.test_send'),
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
