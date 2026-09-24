import type { ApiDataResponse, ApiErrorResponse, ApiPagedResponse } from '@acc/contracts';

/**
 * Browser-side API client for Alendei Communications Cloud.
 *
 * Security Invariants:
 * 1. Access tokens and application-managed credentials are never persisted by JavaScript.
 *    The refresh token remains exclusively in the backend-issued httpOnly cookie.
 * 2. Access tokens are held strictly in memory; never in localStorage, sessionStorage,
 *    cookies, IndexedDB, or URL strings.
 * 3. The non-simple header `X-Acc-Refresh` is sent on `/auth/refresh` and `/auth/logout`.
 * 4. `X-Acc-Organization` is injected strictly from validated in-memory selected organization
 *    state. Callers cannot provide an arbitrary header to override or bypass tenant boundaries.
 * 5. Concurrent 401s deduplicate into a single refresh request and retry once.
 * 6. Logout invalidates in-flight refresh requests to prevent race conditions.
 * 7. Never logs credentials or secrets.
 */
let configuredBaseUrl: string | null = null;

export function getBaseUrl(): string {
  if (configuredBaseUrl !== null) {
    return configuredBaseUrl;
  }
  return process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/api/v1';
}

export function setBaseUrl(url: string | null): void {
  configuredBaseUrl = url;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly correlationId: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  /** Whether to attach Authorization header. Defaults to true. */
  readonly auth?: boolean;
  /** Whether to omit X-Acc-Organization. Defaults to false. */
  readonly skipTenant?: boolean;
  /** Internal guard to prevent infinite refresh retry loops. */
  readonly _retried?: boolean;
}

// -----------------------------------------------------------------------------
// In-Memory Security State (Never persisted by JavaScript)
// -----------------------------------------------------------------------------
let inMemoryAccessToken: string | null = null;
let inMemorySelectedOrgId: string | null = null;

/** Session epoch counter to invalidate stale in-flight refresh requests on logout */
let authSessionEpoch = 0;

export function invalidateSessionEpoch(): void {
  authSessionEpoch++;
}

export function getSessionEpoch(): number {
  return authSessionEpoch;
}

export function getAccessToken(): string | null {
  return inMemoryAccessToken;
}

export function setAccessToken(token: string | null): void {
  inMemoryAccessToken = token;
}

export function getSelectedOrganization(): string | null {
  return inMemorySelectedOrgId;
}

// -----------------------------------------------------------------------------
// Organization Context Validation
// -----------------------------------------------------------------------------
type OrgValidator = (orgId: string) => boolean;
let orgValidator: OrgValidator | null = null;

export function registerOrgValidator(validator: OrgValidator | null): void {
  orgValidator = validator;
}

export function setSelectedOrganization(orgId: string | null): void {
  if (orgId !== null && orgValidator && !orgValidator(orgId)) {
    inMemorySelectedOrgId = null;
    throw new Error(`Cannot set unauthorized organization: ${orgId}`);
  }
  inMemorySelectedOrgId = orgId;
}

// -----------------------------------------------------------------------------
// Auth Failure Event Listeners
// -----------------------------------------------------------------------------
type AuthFailureListener = () => void;
const authFailureListeners = new Set<AuthFailureListener>();

export function onAuthFailure(listener: AuthFailureListener): () => void {
  authFailureListeners.add(listener);
  return () => {
    authFailureListeners.delete(listener);
  };
}

function notifyAuthFailure(): void {
  for (const listener of authFailureListeners) {
    try {
      listener();
    } catch {
      // Ignore errors inside listeners
    }
  }
}

// -----------------------------------------------------------------------------
// Deduplicated Refresh Mechanism with Race Prevention
// -----------------------------------------------------------------------------
let refreshPromise: Promise<string | null> | null = null;

/**
 * Executes a single controlled refresh request.
 * If multiple requests trigger a refresh concurrently, all await the single in-flight promise.
 * If logout occurs during an in-flight refresh, the resulting token is discarded.
 */
export async function refreshAccessToken(): Promise<string | null> {
  if (refreshPromise) {
    return refreshPromise;
  }

  const currentEpoch = authSessionEpoch;

  refreshPromise = (async () => {
    try {
      const root = getBaseUrl();
      const response = await fetch(`${root}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'X-Acc-Refresh': '1',
        },
      });

      // Race condition check: If logout occurred while refresh was in-flight, discard response
      if (authSessionEpoch !== currentEpoch) {
        setAccessToken(null);
        return null;
      }

      if (!response.ok) {
        setAccessToken(null);
        notifyAuthFailure();
        return null;
      }

      const payload = (await response.json().catch(() => null)) as {
        data?: { accessToken?: string };
      } | null;

      const newToken = payload?.data?.accessToken ?? null;
      if (newToken && authSessionEpoch === currentEpoch) {
        setAccessToken(newToken);
        return newToken;
      }

      setAccessToken(null);
      notifyAuthFailure();
      return null;
    } catch {
      setAccessToken(null);
      notifyAuthFailure();
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// -----------------------------------------------------------------------------
// Core apiFetch
// -----------------------------------------------------------------------------
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, auth = true, skipTenant = false, _retried = false, ...rest } = options;
  const baseUrl = getBaseUrl();

  const reqHeaders: Record<string, string> = {
    Accept: 'application/json',
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
  };

  // Merge caller-provided headers, SANITIZING to prevent forging X-Acc-Organization
  if (headers) {
    if (headers instanceof Headers) {
      headers.forEach((val, key) => {
        if (key.toLowerCase() !== 'x-acc-organization') {
          reqHeaders[key] = val;
        }
      });
    } else if (Array.isArray(headers)) {
      for (const [key, val] of headers) {
        if (key.toLowerCase() !== 'x-acc-organization') {
          reqHeaders[key] = val;
        }
      }
    } else {
      for (const [key, val] of Object.entries(headers)) {
        if (key.toLowerCase() !== 'x-acc-organization' && typeof val === 'string') {
          reqHeaders[key] = val;
        }
      }
    }
  }

  // 1. Authorization header: Attach in-memory access token if available and requested
  if (auth && inMemoryAccessToken) {
    reqHeaders['Authorization'] = `Bearer ${inMemoryAccessToken}`;
  }

  // 2. Tenant header: Validate and attach X-Acc-Organization for tenant-scoped endpoints
  const isAuthPath = path.startsWith('/auth/');
  const isPublicProbe = path === '/health' || path.startsWith('/health/') || path === '/metrics';

  if (!skipTenant && !isAuthPath && !isPublicProbe) {
    // If selected org is invalid against current validator, clear it
    if (inMemorySelectedOrgId && orgValidator && !orgValidator(inMemorySelectedOrgId)) {
      inMemorySelectedOrgId = null;
      notifyAuthFailure();
    }

    if (inMemorySelectedOrgId) {
      reqHeaders['X-Acc-Organization'] = inMemorySelectedOrgId;
    }
  }

  // 3. CSRF header: Required on cookie-dependent auth endpoints
  if (path === '/auth/refresh' || path === '/auth/logout') {
    reqHeaders['X-Acc-Refresh'] = '1';
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...rest,
    credentials: 'include',
    headers: reqHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload: unknown = await response.json().catch(() => null);

  // 4. Handle 401 Unauthorized with controlled refresh deduplication
  if (response.status === 401) {
    const isRefreshEligible =
      auth &&
      !_retried &&
      path !== '/auth/login' &&
      path !== '/auth/refresh' &&
      path !== '/auth/logout';

    if (isRefreshEligible) {
      const newToken = await refreshAccessToken();
      if (newToken) {
        // Retry the original request once with the new access token
        return apiFetch<T>(path, {
          ...options,
          _retried: true,
        });
      }
    }

    if (path === '/auth/refresh') {
      setAccessToken(null);
      notifyAuthFailure();
    }

    throw toApiError(response, payload);
  }

  if (!response.ok) {
    throw toApiError(response, payload);
  }

  return payload as T;
}

function toApiError(response: Response, payload: unknown): ApiError {
  const envelope = payload as ApiErrorResponse | null;
  const error = envelope?.error;
  return new ApiError(
    response.status,
    error?.code ?? (response.status === 401 ? 'AUTH_CREDENTIAL_REQUIRED' : 'INTERNAL_ERROR'),
    error?.message ?? `Request failed with status ${response.status}`,
    error?.correlationId ?? response.headers.get('x-correlation-id') ?? 'unknown',
    error?.retryable ?? false,
    error?.details,
  );
}

/** Health is served outside the versioned prefix (`API.md` §2). */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const root = getBaseUrl().replace(/\/api\/v\d+$/, '');
  const response = await fetch(`${root}/health/ready`, { signal, cache: 'no-store' });
  const payload = (await response.json()) as HealthResponse;
  return payload;
}

export interface HealthResponse {
  readonly status: string;
  readonly info?: Record<string, { status: string } & Record<string, unknown>>;
  readonly error?: Record<string, { status: string } & Record<string, unknown>>;
}

// -----------------------------------------------------------------------------
// Typed Auth Models
// -----------------------------------------------------------------------------
export interface AuthTokens {
  readonly accessToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
}

export interface UserIdentity {
  readonly userId: string;
  readonly actorType: 'user' | string;
  readonly authMethod: 'session' | string;
  readonly sessionId: string;
  readonly authenticatedAt: string;
  readonly tenant: {
    readonly orgId: string | null;
    readonly workspaceId: string | null;
    readonly resellerId: string | null;
    readonly isPlatformAdmin: boolean;
  };
  readonly authorizedOrganizationIds: readonly string[];
  readonly roles: readonly {
    readonly roleKey: string;
    readonly scopeType: string;
    readonly scopeId: string | null;
    readonly orgId: string | null;
  }[];
  readonly permissions: readonly string[];
}

export interface EffectiveGrant {
  readonly roleId: string;
  readonly roleKey: string;
  readonly scopeType: 'platform' | 'reseller' | 'organization' | 'workspace' | 'team' | string;
  readonly scopeId: string | null;
  readonly orgId: string | null;
  readonly permissions: readonly string[];
}

export interface EffectiveAuthorization {
  readonly actorType: 'user' | 'api_key' | string;
  readonly userId: string | null;
  readonly apiKeyId: string | null;
  readonly grants: readonly EffectiveGrant[];
  readonly organizationIds: readonly string[];
  readonly isPlatformAdmin: boolean;
}

export interface SessionItem {
  readonly id: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly expiresIn?: number;
  readonly expiresAt: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly current: boolean;
}

// -----------------------------------------------------------------------------
// Auth API Endpoints
// -----------------------------------------------------------------------------
export const authApi = {
  async login(credentials: { email: string; password: string }): Promise<ApiDataResponse<AuthTokens>> {
    const res = await apiFetch<ApiDataResponse<AuthTokens>>('/auth/login', {
      method: 'POST',
      body: credentials,
      auth: false,
    });
    if (res.data?.accessToken) {
      setAccessToken(res.data.accessToken);
    }
    return res;
  },

  async refresh(): Promise<ApiDataResponse<AuthTokens>> {
    const res = await apiFetch<ApiDataResponse<AuthTokens>>('/auth/refresh', {
      method: 'POST',
      auth: false,
    });
    if (res.data?.accessToken) {
      setAccessToken(res.data.accessToken);
    }
    return res;
  },

  async logout(): Promise<void> {
    invalidateSessionEpoch();
    try {
      await apiFetch<void>('/auth/logout', {
        method: 'POST',
      });
    } catch {
      // If the session is already expired or server returns 401, local teardown still completes cleanly
    } finally {
      setAccessToken(null);
      setSelectedOrganization(null);
      notifyAuthFailure();
    }
  },

  async me(): Promise<ApiDataResponse<UserIdentity>> {
    return apiFetch<ApiDataResponse<UserIdentity>>('/auth/me', {
      method: 'GET',
      skipTenant: true,
    });
  },

  async authorization(): Promise<ApiDataResponse<EffectiveAuthorization>> {
    return apiFetch<ApiDataResponse<EffectiveAuthorization>>('/auth/me/authorization', {
      method: 'GET',
      skipTenant: true,
    });
  },

  async sessions(): Promise<ApiDataResponse<readonly SessionItem[]>> {
    return apiFetch<ApiDataResponse<readonly SessionItem[]>>('/auth/sessions', {
      method: 'GET',
      skipTenant: true,
    });
  },

  async revokeSession(sessionId: string): Promise<void> {
    return apiFetch<void>(`/auth/sessions/${sessionId}`, {
      method: 'DELETE',
      skipTenant: true,
    });
  },
};

// -----------------------------------------------------------------------------
// Typed Users, Roles, Workspaces, and Role Assignments Models
// -----------------------------------------------------------------------------
export type UserStatus = 'invited' | 'active' | 'disabled';

export interface UserView {
  readonly id: string;
  readonly email: string;
  readonly phone: string | null;
  readonly status: UserStatus;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListUsersParams {
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: string;
  readonly status?: UserStatus;
  readonly email?: string;
}

export interface CreateUserInput {
  readonly email: string;
  readonly phone?: string | null;
  readonly initialRole: {
    readonly roleId: string;
    readonly scopeType: 'organization' | 'workspace' | 'team';
    readonly scopeId: string;
  };
}

export interface UpdateUserInput {
  readonly phone?: string | null;
}

export type ScopeLevel = 'platform' | 'reseller' | 'organization' | 'workspace' | 'team';
export type TenantCreatableScopeType = 'organization' | 'workspace' | 'team';

export interface RoleView {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly description: string | null;
  readonly orgId: string | null;
  readonly isSystemRole: boolean;
  readonly allowedScopeTypes: readonly ScopeLevel[];
  readonly permissions: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type RoleItem = RoleView;

export interface ListRolesParams {
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: string;
  readonly isSystemRole?: boolean;
  readonly key?: string;
}

export interface CreateRoleInput {
  readonly key: string;
  readonly name: string;
  readonly description?: string | null;
  readonly allowedScopeTypes: readonly TenantCreatableScopeType[];
  readonly permissions: readonly string[];
}

export interface UpdateRoleInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly allowedScopeTypes?: readonly TenantCreatableScopeType[];
  readonly permissions?: readonly string[];
}

export interface PermissionView {
  readonly key: string;
  readonly domain: string;
  readonly action: string;
  readonly description: string | null;
}

export interface ListPermissionsParams {
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: string;
  readonly domain?: string;
}

export interface WorkspaceItem {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly createdAt: string;
}

export type GrantableScopeType = 'reseller' | 'organization' | 'workspace' | 'team';

export interface RoleAssignmentView {
  readonly id: string;
  readonly userId: string;
  readonly roleId: string;
  readonly roleKey: string;
  readonly orgId: string | null;
  readonly scopeType: ScopeLevel;
  readonly scopeId: string | null;
  readonly grantedBy: string | null;
  readonly createdAt: string;
}

export type RoleAssignmentItem = RoleAssignmentView;

export interface ListRoleAssignmentsParams {
  readonly userId?: string;
  readonly scopeType?: ScopeLevel;
  readonly scopeId?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: string;
}

export interface CreateRoleAssignmentInput {
  readonly userId: string;
  readonly roleId: string;
  readonly scopeType: ScopeLevel;
  readonly scopeId: string;
}

// -----------------------------------------------------------------------------
// Users Administration API
// -----------------------------------------------------------------------------
export const usersApi = {
  async list(params: ListUsersParams = {}, signal?: AbortSignal): Promise<ApiPagedResponse<UserView>> {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.sort) query.set('sort', params.sort);
    if (params.status) query.set('status', params.status);
    if (params.email) query.set('email', params.email);

    const queryString = query.toString();
    const endpoint = queryString ? `/users?${queryString}` : '/users';

    return apiFetch<ApiPagedResponse<UserView>>(endpoint, {
      method: 'GET',
      signal,
    });
  },

  async get(id: string, signal?: AbortSignal): Promise<ApiDataResponse<UserView>> {
    return apiFetch<ApiDataResponse<UserView>>(`/users/${encodeURIComponent(id)}`, {
      method: 'GET',
      signal,
    });
  },

  async create(input: CreateUserInput, idempotencyKey?: string): Promise<ApiDataResponse<UserView>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    return apiFetch<ApiDataResponse<UserView>>('/users', {
      method: 'POST',
      body: input,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    });
  },

  async update(id: string, input: UpdateUserInput): Promise<ApiDataResponse<UserView>> {
    return apiFetch<ApiDataResponse<UserView>>(`/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: input,
    });
  },

  async disable(id: string): Promise<ApiDataResponse<UserView>> {
    return apiFetch<ApiDataResponse<UserView>>(`/users/${encodeURIComponent(id)}/disable`, {
      method: 'POST',
    });
  },

  async reactivate(id: string): Promise<ApiDataResponse<UserView>> {
    return apiFetch<ApiDataResponse<UserView>>(`/users/${encodeURIComponent(id)}/reactivate`, {
      method: 'POST',
    });
  },
};

// -----------------------------------------------------------------------------
// Roles API (Administration & Selection)
// -----------------------------------------------------------------------------
export const rolesApi = {
  async list(
    paramsOrSignal?: ListRolesParams | AbortSignal,
    signal?: AbortSignal,
  ): Promise<ApiPagedResponse<RoleView>> {
    let params: ListRolesParams = {};
    let abortSignal = signal;

    if (paramsOrSignal instanceof AbortSignal) {
      abortSignal = paramsOrSignal;
    } else if (paramsOrSignal) {
      params = paramsOrSignal;
    }

    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.sort) query.set('sort', params.sort);
    if (params.isSystemRole !== undefined) query.set('isSystemRole', String(params.isSystemRole));
    if (params.key) query.set('key', params.key);

    const queryString = query.toString();
    const endpoint = queryString ? `/roles?${queryString}` : '/roles';

    return apiFetch<ApiPagedResponse<RoleView>>(endpoint, {
      method: 'GET',
      signal: abortSignal,
    });
  },

  async get(id: string, signal?: AbortSignal): Promise<ApiDataResponse<RoleView>> {
    return apiFetch<ApiDataResponse<RoleView>>(`/roles/${encodeURIComponent(id)}`, {
      method: 'GET',
      signal,
    });
  },

  async create(input: CreateRoleInput, idempotencyKey?: string): Promise<ApiDataResponse<RoleView>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    return apiFetch<ApiDataResponse<RoleView>>('/roles', {
      method: 'POST',
      body: input,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    });
  },

  async update(id: string, input: UpdateRoleInput): Promise<ApiDataResponse<RoleView>> {
    return apiFetch<ApiDataResponse<RoleView>>(`/roles/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: input,
    });
  },

  async delete(id: string): Promise<void> {
    return apiFetch<void>(`/roles/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },
};

// -----------------------------------------------------------------------------
// Permissions API (System-defined Catalogue)
// -----------------------------------------------------------------------------
export const permissionsApi = {
  async list(
    params: ListPermissionsParams = {},
    signal?: AbortSignal,
  ): Promise<ApiPagedResponse<PermissionView>> {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.sort) query.set('sort', params.sort);
    if (params.domain) query.set('domain', params.domain);

    const queryString = query.toString();
    const endpoint = queryString ? `/permissions?${queryString}` : '/permissions';

    return apiFetch<ApiPagedResponse<PermissionView>>(endpoint, {
      method: 'GET',
      signal,
    });
  },
};

// -----------------------------------------------------------------------------
// Workspaces API (For Workspace Selection during User Creation)
// -----------------------------------------------------------------------------
export const workspacesApi = {
  async list(signal?: AbortSignal): Promise<ApiPagedResponse<WorkspaceItem>> {
    return apiFetch<ApiPagedResponse<WorkspaceItem>>('/tenants/workspaces', {
      method: 'GET',
      signal,
    });
  },
};

// -----------------------------------------------------------------------------
// Role Assignments API (Administration & Inspection)
// -----------------------------------------------------------------------------
export const roleAssignmentsApi = {
  async list(
    paramsOrUserId?: ListRoleAssignmentsParams | string,
    signal?: AbortSignal,
  ): Promise<ApiPagedResponse<RoleAssignmentView>> {
    let params: ListRoleAssignmentsParams = {};
    if (typeof paramsOrUserId === 'string') {
      params = { userId: paramsOrUserId };
    } else if (paramsOrUserId) {
      params = paramsOrUserId;
    }

    const query = new URLSearchParams();
    if (params.userId) query.set('userId', params.userId);
    if (params.scopeType) query.set('scopeType', params.scopeType);
    if (params.scopeId) query.set('scopeId', params.scopeId);
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.sort) query.set('sort', params.sort);

    const queryString = query.toString();
    const endpoint = queryString ? `/role-assignments?${queryString}` : '/role-assignments';

    return apiFetch<ApiPagedResponse<RoleAssignmentView>>(endpoint, {
      method: 'GET',
      signal,
    });
  },

  async listForUser(userId: string, signal?: AbortSignal): Promise<ApiPagedResponse<RoleAssignmentView>> {
    return this.list({ userId }, signal);
  },

  async get(id: string, signal?: AbortSignal): Promise<ApiDataResponse<RoleAssignmentView>> {
    return apiFetch<ApiDataResponse<RoleAssignmentView>>(`/role-assignments/${encodeURIComponent(id)}`, {
      method: 'GET',
      signal,
    });
  },

  async create(
    input: CreateRoleAssignmentInput,
    idempotencyKey?: string,
  ): Promise<ApiDataResponse<RoleAssignmentView>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    return apiFetch<ApiDataResponse<RoleAssignmentView>>('/role-assignments', {
      method: 'POST',
      body: input,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    });
  },

  async delete(id: string): Promise<void> {
    return apiFetch<void>(`/role-assignments/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  },
};

// -----------------------------------------------------------------------------
// API Keys Administration Models & API (Phase 1B.6.2)
// -----------------------------------------------------------------------------
export type ApiKeyStatus = 'active' | 'expired' | 'revoked';
export type ApiKeyScopeType = 'organization' | 'workspace';

export interface ApiKeyView {
  readonly id: string;
  readonly name: string;
  /** Public half of the credential. Identifies the key; verifies nothing. */
  readonly prefix: string;
  /** Derived lifecycle state: active, expired, or revoked. */
  readonly status: ApiKeyStatus;
  readonly scopeType: ApiKeyScopeType;
  readonly scopeId: string;
  readonly orgId: string;
  /** Requested permission subset. */
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatedApiKeyView extends ApiKeyView {
  /**
   * Plaintext secret.
   * Returned ONLY on initial successful creation response (`POST /api/v1/api-keys`).
   * On an idempotent replay, this field is present but `null` (ADR-008).
   * It is never retrievable again and must never be persisted in browser storage.
   */
  readonly secret: string | null;
}

export interface ListApiKeysParams {
  readonly status?: ApiKeyStatus;
  readonly scopeType?: ApiKeyScopeType;
  readonly scopeId?: string;
  readonly name?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: string;
}

export interface CreateApiKeyInput {
  readonly name: string;
  readonly scopeType: ApiKeyScopeType;
  readonly scopeId: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: string | null;
}

export const apiKeysApi = {
  async list(
    params: ListApiKeysParams = {},
    signal?: AbortSignal,
  ): Promise<ApiPagedResponse<ApiKeyView>> {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.sort) query.set('sort', params.sort);
    if (params.status) query.set('status', params.status);
    if (params.scopeType) query.set('scopeType', params.scopeType);
    if (params.scopeId) query.set('scopeId', params.scopeId);
    if (params.name) query.set('name', params.name);

    const queryString = query.toString();
    const endpoint = queryString ? `/api-keys?${queryString}` : '/api-keys';

    return apiFetch<ApiPagedResponse<ApiKeyView>>(endpoint, {
      method: 'GET',
      signal,
    });
  },

  async get(id: string, signal?: AbortSignal): Promise<ApiDataResponse<ApiKeyView>> {
    return apiFetch<ApiDataResponse<ApiKeyView>>(`/api-keys/${encodeURIComponent(id)}`, {
      method: 'GET',
      signal,
    });
  },

  async create(
    input: CreateApiKeyInput,
    idempotencyKey?: string,
  ): Promise<ApiDataResponse<CreatedApiKeyView>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    return apiFetch<ApiDataResponse<CreatedApiKeyView>>('/api-keys', {
      method: 'POST',
      body: input,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    });
  },

  async revoke(id: string): Promise<ApiDataResponse<ApiKeyView>> {
    return apiFetch<ApiDataResponse<ApiKeyView>>(`/api-keys/${encodeURIComponent(id)}/revoke`, {
      method: 'POST',
    });
  },
};

