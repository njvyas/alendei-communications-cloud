import type {
  ApiDataResponse,
  ApiErrorResponse,
  ApiPagedResponse,
  AssignmentStatus,
  ChannelCode,
  ChannelStatus,
  ConsentEventResponse,
  ConsentEventType,
  ContactIdentityResponse,
  ContactResponse,
  CreateOrganizationProviderAssignmentInput,
  EffectiveConsentResponse,
  EffectiveConsentState,
  ProviderCircuitPolicy,
  MessageAttemptResponse,
  MessageAttemptStatus,
  MessageDetailResponse,
  MessageStatus,
  MessageSummaryResponse,
  OrganizationProviderAssignment,
  PageInfo,
  ProviderCircuitState,
  ProviderFailureCategory,
  ProviderHealthClassification,
  ProviderHealthSampleKind,
  ProviderHealthSource,
  ProviderHealthState,
  ProviderProbeOutcome,
  ProviderStatus,
  QueuedMessageResponse,
  SimulatorBehavior,
  SimulatorHealthBehavior,
  SuppressionResponse,
  SuppressionStatus,
  TemplateApprovalStatus,
  TemplateResponse,
  UpdateOrganizationProviderAssignmentInput,
  BrandConfig,
  DirectCustomerOnboardingDto,
  DomainDnsRecord,
  DomainStatus,
  DomainType,
  DomainVerificationDetails,
  DomainVerificationMethod,
  DomainVerificationStatus,
  DomainView,
  OnboardingResult,
  ResellerCustomerOnboardingDto,
  ResolvedDomainView,
  WhiteLabelCustomerOnboardingDto,
} from '@acc/contracts';
import {
  ASSIGNMENT_STATUS,
  DOMAIN_STATUSES,
  DOMAIN_TYPES,
  DOMAIN_VERIFICATION_METHODS,
  DOMAIN_VERIFICATION_STATUSES,
  MESSAGE_ATTEMPT_STATUSES,
  MESSAGE_STATUSES,
  PLATFORM_RESERVED_DOMAINS,
  SUPPRESSION_STATUSES,
} from '@acc/contracts';
import { maskRecipientAddress } from './address-masking';

export type {
  AssignmentStatus,
  BrandConfig,
  ChannelCode,
  CreateOrganizationProviderAssignmentInput,
  DirectCustomerOnboardingDto,
  DomainDnsRecord,
  DomainStatus,
  DomainType,
  DomainVerificationDetails,
  DomainVerificationMethod,
  DomainVerificationStatus,
  DomainView,
  EffectiveConsentState,
  MessageAttemptResponse,
  MessageAttemptStatus,
  MessageDetailResponse,
  MessageStatus,
  MessageSummaryResponse,
  OnboardingResult,
  OrganizationProviderAssignment,
  PageInfo,
  ResellerCustomerOnboardingDto,
  ResolvedDomainView,
  SuppressionResponse,
  SuppressionStatus,
  UpdateOrganizationProviderAssignmentInput,
  WhiteLabelCustomerOnboardingDto,
};
export {
  ASSIGNMENT_STATUS,
  DOMAIN_STATUSES,
  DOMAIN_TYPES,
  DOMAIN_VERIFICATION_METHODS,
  DOMAIN_VERIFICATION_STATUSES,
  MESSAGE_ATTEMPT_STATUSES,
  MESSAGE_STATUSES,
  PLATFORM_RESERVED_DOMAINS,
  SUPPRESSION_STATUSES,
  maskRecipientAddress,
};

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
let lastNotifiedEpoch = -1;

export function invalidateSessionEpoch(): void {
  authSessionEpoch++;
  lastNotifiedEpoch = -1;
}

export function getSessionEpoch(): number {
  return authSessionEpoch;
}

export function getAccessToken(): string | null {
  return inMemoryAccessToken;
}

export function setAccessToken(token: string | null): void {
  inMemoryAccessToken = token;
  if (token !== null) {
    lastNotifiedEpoch = -1;
  }
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

/**
 * Executes terminal authentication teardown: clears in-memory access token and
 * notifies listeners once per session epoch to prevent notification storms.
 */
function handleTerminalAuthFailure(): void {
  setAccessToken(null);
  if (lastNotifiedEpoch !== authSessionEpoch) {
    lastNotifiedEpoch = authSessionEpoch;
    notifyAuthFailure();
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

      // Race condition check: If logout or new session occurred while refresh was in-flight, discard response
      if (authSessionEpoch !== currentEpoch) {
        return null;
      }

      if (!response.ok) {
        if (authSessionEpoch === currentEpoch) {
          handleTerminalAuthFailure();
        }
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

      if (authSessionEpoch === currentEpoch) {
        handleTerminalAuthFailure();
      }
      return null;
    } catch {
      if (authSessionEpoch === currentEpoch) {
        handleTerminalAuthFailure();
      }
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
  const requestEpoch = authSessionEpoch;

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
    // 4.1 Ordinary login credential failure: do not clear session or notify auth failure
    if (path === '/auth/login') {
      throw toApiError(response, payload);
    }

    // 4.2 Stale request from previous session epoch: discard without affecting newer session
    if (requestEpoch !== authSessionEpoch) {
      throw toApiError(response, payload);
    }

    // 4.3 Terminal refresh failure on direct /auth/refresh call
    if (path === '/auth/refresh') {
      handleTerminalAuthFailure();
      throw toApiError(response, payload);
    }

    // 4.4 Unauthenticated request: do not clear unrelated session state or notify auth failure
    if (!auth) {
      throw toApiError(response, payload);
    }

    // 4.5 Authenticated request: refresh once if eligible
    const isRefreshEligible = !_retried && path !== '/auth/logout';
    if (isRefreshEligible) {
      const newToken = await refreshAccessToken();
      if (newToken) {
        // Retry the original request once with the new access token
        return apiFetch<T>(path, {
          ...options,
          _retried: true,
        });
      }
      // If refresh failed, handleTerminalAuthFailure() was already invoked by refreshAccessToken()
      throw toApiError(response, payload);
    }

    // 4.6 Terminal authentication failure for authenticated requests (e.g. retried request failed with 401,
    // or non-refreshable authenticated request).
    handleTerminalAuthFailure();

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

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new ApiError(
      response.status,
      'INVALID_HEALTH_RESPONSE',
      `Health endpoint returned unexpected content-type: ${contentType || 'none'} (status ${response.status})`,
      response.headers.get('x-correlation-id') ?? 'unknown',
      false,
    );
  }

  if (!response.ok && response.status !== 503) {
    throw new ApiError(
      response.status,
      'HEALTH_CHECK_FAILED',
      `Health check failed with status ${response.status}`,
      response.headers.get('x-correlation-id') ?? 'unknown',
      false,
    );
  }

  try {
    const payload = (await response.json()) as HealthResponse;
    return payload;
  } catch (err) {
    throw new ApiError(
      response.status,
      'INVALID_HEALTH_RESPONSE',
      err instanceof Error ? err.message : 'Failed to parse health response as JSON',
      response.headers.get('x-correlation-id') ?? 'unknown',
      false,
    );
  }
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
  readonly email?: string;
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
  async login(credentials: {
    email: string;
    password: string;
  }): Promise<ApiDataResponse<AuthTokens>> {
    const res = await apiFetch<ApiDataResponse<AuthTokens>>('/auth/login', {
      method: 'POST',
      body: credentials,
      auth: false,
    });
    if (res.data?.accessToken) {
      invalidateSessionEpoch();
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
    const targetToken = inMemoryAccessToken;
    const targetOrgId = inMemorySelectedOrgId;
    const logoutEpoch = authSessionEpoch;
    invalidateSessionEpoch();

    try {
      await apiFetch<void>('/auth/logout', {
        method: 'POST',
      });
    } catch {
      // If the session is already expired or server returns 401, local teardown still completes cleanly
    } finally {
      const isCurrentLogout = authSessionEpoch === logoutEpoch + 1;
      if (
        isCurrentLogout &&
        (inMemoryAccessToken === targetToken || inMemoryAccessToken === null)
      ) {
        handleTerminalAuthFailure();
      }
      if (isCurrentLogout && inMemorySelectedOrgId === targetOrgId) {
        setSelectedOrganization(null);
      }
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

// -----------------------------------------------------------------------------
// Phase 1C: Organizations, Workspaces, and Teams Models
// -----------------------------------------------------------------------------
export type OrganizationStatus = 'active' | 'suspended' | 'closed';
export type BillingMode = 'prepaid' | 'postpaid';
export type BillingPolicy = 'charge_per_logical_message' | 'charge_per_attempt';

export interface OrganizationView {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly legalName: string | null;
  readonly gstin: string | null;
  readonly resellerId: string;
  readonly status: OrganizationStatus;
  readonly statusChangedAt: string | null;
  readonly billingMode: BillingMode;
  readonly billingPolicy: BillingPolicy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListOrganizationsParams {
  readonly status?: OrganizationStatus;
  readonly resellerId?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: 'name' | 'createdAt' | '-createdAt' | string;
}

export interface CreateOrganizationParams {
  readonly name: string;
  readonly slug: string;
  readonly legalName?: string | null;
  readonly gstin?: string | null;
  readonly resellerId?: string;
  readonly billingMode?: BillingMode;
  readonly billingPolicy?: BillingPolicy;
}

export interface UpdateOrganizationParams {
  readonly name?: string;
  readonly legalName?: string | null;
  readonly gstin?: string | null;
  readonly billingMode?: BillingMode;
  readonly billingPolicy?: BillingPolicy;
}

export type ScopeStatus = 'active' | 'archived';

export interface WorkspaceView {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly slug: string;
  readonly status: ScopeStatus;
  readonly isDefault: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type WorkspaceItem = WorkspaceView;

export interface ListWorkspacesParams {
  readonly status?: ScopeStatus;
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: 'name' | 'createdAt' | '-createdAt' | string;
  readonly orgId?: string;
}

export interface CreateWorkspaceParams {
  readonly name: string;
  readonly slug: string;
  readonly orgId?: string;
}

export interface UpdateWorkspaceParams {
  readonly name?: string;
}

export interface TeamView {
  readonly id: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly status: ScopeStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListTeamsParams {
  readonly workspaceId?: string;
  readonly status?: ScopeStatus;
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: 'name' | 'createdAt' | '-createdAt' | string;
}

export interface CreateTeamParams {
  readonly workspaceId: string;
  readonly name: string;
}

export interface UpdateTeamParams {
  readonly name?: string;
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
  async list(
    params: ListUsersParams = {},
    signal?: AbortSignal,
  ): Promise<ApiPagedResponse<UserView>> {
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

  async create(
    input: CreateUserInput,
    idempotencyKey?: string,
  ): Promise<ApiDataResponse<UserView>> {
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

  async create(
    input: CreateRoleInput,
    idempotencyKey?: string,
  ): Promise<ApiDataResponse<RoleView>> {
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
// Organizations API (Phase 1C.1a)
// All routes act via path or caller reach; skipTenant is true.
// -----------------------------------------------------------------------------
export const organizationsApi = {
  async list(
    params: ListOrganizationsParams = {},
    signal?: AbortSignal,
  ): Promise<ApiPagedResponse<OrganizationView>> {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.sort) query.set('sort', params.sort);
    if (params.status) query.set('status', params.status);
    if (params.resellerId) query.set('resellerId', params.resellerId);

    const queryString = query.toString();
    const endpoint = queryString ? `/organizations?${queryString}` : '/organizations';

    return apiFetch<ApiPagedResponse<OrganizationView>>(endpoint, {
      method: 'GET',
      signal,
      skipTenant: true,
    });
  },

  /**
   * Fetches all accessible organizations across pages up to maxPages (safety bound, default 10).
   * Follows page.nextCursor until hasMore is false or the bound is reached.
   * If any page request fails, preserves loading/error states and UUID fallback behavior.
   */
  async listAll(
    params: Omit<ListOrganizationsParams, 'cursor'> = {},
    signal?: AbortSignal,
    maxPages = 10,
  ): Promise<ApiPagedResponse<OrganizationView>> {
    let cursor: string | null = null;
    const allOrgs: OrganizationView[] = [];
    let pageCount = 0;
    let lastHasMore = false;
    let lastNextCursor: string | null = null;
    let lastLimit = params.limit ?? 100;

    while (pageCount < maxPages) {
      pageCount++;
      try {
        const res = await this.list(
          { ...params, limit: 100, ...(cursor ? { cursor } : {}) },
          signal,
        );
        allOrgs.push(...res.data);
        lastHasMore = res.page.hasMore;
        lastNextCursor = res.page.nextCursor;
        lastLimit = res.page.limit;

        if (!res.page.hasMore || !res.page.nextCursor) {
          break;
        }
        cursor = res.page.nextCursor;
      } catch (err) {
        if (signal?.aborted) {
          throw err;
        }
        // If the very first page failed, rethrow so callers know lookup failed and fallback to UUIDs
        if (pageCount === 1) {
          throw err;
        }
        // If a subsequent page failed, return partial results already collected; remaining will fall back to UUIDs
        break;
      }
    }

    return {
      data: allOrgs,
      page: {
        limit: lastLimit,
        hasMore: lastHasMore,
        nextCursor: lastNextCursor,
      },
    };
  },

  async get(id: string, signal?: AbortSignal): Promise<ApiDataResponse<OrganizationView>> {
    return apiFetch<ApiDataResponse<OrganizationView>>(`/organizations/${encodeURIComponent(id)}`, {
      method: 'GET',
      signal,
      skipTenant: true,
    });
  },

  async create(
    params: CreateOrganizationParams,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<OrganizationView>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    return apiFetch<ApiDataResponse<OrganizationView>>('/organizations', {
      method: 'POST',
      headers,
      body: params,
      signal,
      skipTenant: true,
    });
  },

  async update(
    id: string,
    params: UpdateOrganizationParams,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<OrganizationView>> {
    return apiFetch<ApiDataResponse<OrganizationView>>(`/organizations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: params,
      signal,
      skipTenant: true,
    });
  },

  async suspend(
    id: string,
    reason?: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<OrganizationView>> {
    return apiFetch<ApiDataResponse<OrganizationView>>(
      `/organizations/${encodeURIComponent(id)}/suspend`,
      {
        method: 'POST',
        body: reason ? { reason } : {},
        signal,
        skipTenant: true,
      },
    );
  },

  async reactivate(
    id: string,
    reason?: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<OrganizationView>> {
    return apiFetch<ApiDataResponse<OrganizationView>>(
      `/organizations/${encodeURIComponent(id)}/reactivate`,
      {
        method: 'POST',
        body: reason ? { reason } : {},
        signal,
        skipTenant: true,
      },
    );
  },

  async close(
    id: string,
    reason?: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<OrganizationView>> {
    return apiFetch<ApiDataResponse<OrganizationView>>(
      `/organizations/${encodeURIComponent(id)}/close`,
      {
        method: 'POST',
        body: reason ? { reason } : {},
        signal,
        skipTenant: true,
      },
    );
  },
};

// -----------------------------------------------------------------------------
// Workspaces API (Phase 1C.1b)
// Canonical routes act in selected organization context.
// -----------------------------------------------------------------------------
export const workspacesApi = {
  async list(
    paramsOrSignal?: ListWorkspacesParams | AbortSignal,
    signal?: AbortSignal,
  ): Promise<ApiPagedResponse<WorkspaceView>> {
    let params: ListWorkspacesParams = {};
    let sig = signal;

    if (paramsOrSignal instanceof AbortSignal) {
      sig = paramsOrSignal;
    } else if (paramsOrSignal) {
      params = paramsOrSignal;
    }

    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.sort) query.set('sort', params.sort);
    if (params.status) query.set('status', params.status);
    if (params.orgId) query.set('orgId', params.orgId);

    const queryString = query.toString();
    const endpoint = queryString ? `/workspaces?${queryString}` : '/workspaces';

    return apiFetch<ApiPagedResponse<WorkspaceView>>(endpoint, {
      method: 'GET',
      signal: sig,
    });
  },

  async get(id: string, signal?: AbortSignal): Promise<ApiDataResponse<WorkspaceView>> {
    return apiFetch<ApiDataResponse<WorkspaceView>>(`/workspaces/${encodeURIComponent(id)}`, {
      method: 'GET',
      signal,
    });
  },

  async create(
    params: CreateWorkspaceParams,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<WorkspaceView>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    return apiFetch<ApiDataResponse<WorkspaceView>>('/workspaces', {
      method: 'POST',
      headers,
      body: params,
      signal,
    });
  },

  async update(
    id: string,
    params: UpdateWorkspaceParams,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<WorkspaceView>> {
    const safeBody = { name: params.name };
    return apiFetch<ApiDataResponse<WorkspaceView>>(`/workspaces/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: safeBody,
      signal,
    });
  },

  async archive(id: string, signal?: AbortSignal): Promise<ApiDataResponse<WorkspaceView>> {
    return apiFetch<ApiDataResponse<WorkspaceView>>(
      `/workspaces/${encodeURIComponent(id)}/archive`,
      {
        method: 'POST',
        signal,
      },
    );
  },

  async restore(id: string, signal?: AbortSignal): Promise<ApiDataResponse<WorkspaceView>> {
    return apiFetch<ApiDataResponse<WorkspaceView>>(
      `/workspaces/${encodeURIComponent(id)}/restore`,
      {
        method: 'POST',
        signal,
      },
    );
  },
};

// -----------------------------------------------------------------------------
// Teams API (Phase 1C.1b)
// Canonical routes act in selected organization context.
// Invariant: NEVER send orgId (causes 400 VALIDATION_FAILED).
// -----------------------------------------------------------------------------
export const teamsApi = {
  async list(
    params: ListTeamsParams = {},
    signal?: AbortSignal,
  ): Promise<ApiPagedResponse<TeamView>> {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.sort) query.set('sort', params.sort);
    if (params.status) query.set('status', params.status);
    if (params.workspaceId) query.set('workspaceId', params.workspaceId);
    // Explicitly omit orgId

    const queryString = query.toString();
    const endpoint = queryString ? `/teams?${queryString}` : '/teams';

    return apiFetch<ApiPagedResponse<TeamView>>(endpoint, {
      method: 'GET',
      signal,
    });
  },

  async get(id: string, signal?: AbortSignal): Promise<ApiDataResponse<TeamView>> {
    return apiFetch<ApiDataResponse<TeamView>>(`/teams/${encodeURIComponent(id)}`, {
      method: 'GET',
      signal,
    });
  },

  async create(
    params: CreateTeamParams,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<TeamView>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    const safeBody = {
      workspaceId: params.workspaceId,
      name: params.name,
    };

    return apiFetch<ApiDataResponse<TeamView>>('/teams', {
      method: 'POST',
      headers,
      body: safeBody,
      signal,
    });
  },

  async update(
    id: string,
    params: UpdateTeamParams,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<TeamView>> {
    const safeBody = {
      name: params.name,
    };

    return apiFetch<ApiDataResponse<TeamView>>(`/teams/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: safeBody,
      signal,
    });
  },

  async archive(id: string, signal?: AbortSignal): Promise<ApiDataResponse<TeamView>> {
    return apiFetch<ApiDataResponse<TeamView>>(`/teams/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
      signal,
    });
  },

  async restore(id: string, signal?: AbortSignal): Promise<ApiDataResponse<TeamView>> {
    return apiFetch<ApiDataResponse<TeamView>>(`/teams/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
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

  async listForUser(
    userId: string,
    signal?: AbortSignal,
  ): Promise<ApiPagedResponse<RoleAssignmentView>> {
    return this.list({ userId }, signal);
  },

  async get(id: string, signal?: AbortSignal): Promise<ApiDataResponse<RoleAssignmentView>> {
    return apiFetch<ApiDataResponse<RoleAssignmentView>>(
      `/role-assignments/${encodeURIComponent(id)}`,
      {
        method: 'GET',
        signal,
      },
    );
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

// -----------------------------------------------------------------------------
// Audit Logs Models & API (Phase 1B.6.3, API.md §3f)
// -----------------------------------------------------------------------------
export type AuditActorType = 'user' | 'api_key' | 'oauth_client' | 'system';
export type AuditOutcome = 'success' | 'failure' | 'denied';

export interface AuditLogView {
  readonly id: string;
  readonly occurredAt: string;
  readonly action: string;
  readonly outcome: AuditOutcome;

  readonly actorType: AuditActorType;
  readonly actorUserId: string | null;
  readonly actorApiKeyId: string | null;
  readonly actorLabel: string | null;

  readonly resourceType: string;
  readonly resourceId: string | null;

  /** Where the action happened, and the derived ancestry of that scope. */
  readonly scopeType: ScopeLevel;
  readonly scopeId: string | null;
  readonly resellerId: string | null;
  readonly orgId: string | null;
  readonly workspaceId: string | null;
  readonly teamId: string | null;

  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly metadata: Record<string, unknown>;

  readonly correlationId: string;
  readonly causationId: string | null;

  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface ListAuditLogsParams {
  readonly action?: string;
  readonly actorType?: AuditActorType;
  readonly actorUserId?: string;
  readonly outcome?: AuditOutcome;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly scopeType?: ScopeLevel;
  readonly scopeId?: string;
  readonly correlationId?: string;
  readonly occurredFrom?: string;
  readonly occurredTo?: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: string;
}

export const auditLogsApi = {
  async list(
    params: ListAuditLogsParams = {},
    signal?: AbortSignal,
  ): Promise<ApiPagedResponse<AuditLogView>> {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.sort) query.set('sort', params.sort);
    if (params.action) query.set('action', params.action);
    if (params.actorType) query.set('actorType', params.actorType);
    if (params.actorUserId) query.set('actorUserId', params.actorUserId);
    if (params.outcome) query.set('outcome', params.outcome);
    if (params.resourceType) query.set('resourceType', params.resourceType);
    if (params.resourceId) query.set('resourceId', params.resourceId);
    if (params.scopeType) query.set('scopeType', params.scopeType);
    if (params.scopeId) query.set('scopeId', params.scopeId);
    if (params.correlationId) query.set('correlationId', params.correlationId);
    if (params.occurredFrom) query.set('occurredFrom', params.occurredFrom);
    if (params.occurredTo) query.set('occurredTo', params.occurredTo);

    const queryString = query.toString();
    const endpoint = queryString ? `/audit-logs?${queryString}` : '/audit-logs';

    return apiFetch<ApiPagedResponse<AuditLogView>>(endpoint, {
      method: 'GET',
      signal,
    });
  },

  async get(id: string, signal?: AbortSignal): Promise<ApiDataResponse<AuditLogView>> {
    return apiFetch<ApiDataResponse<AuditLogView>>(`/audit-logs/${encodeURIComponent(id)}`, {
      method: 'GET',
      signal,
    });
  },
};

// =============================================================================
// Channels & Providers Catalogue API (Phase 2.1 - 2.3)
// Platform scope by default (skipTenant: true); channelsApi.list supports
// tenantScoped: true to attach X-Acc-Organization for tenant operators.
// =============================================================================

export interface ChannelView {
  readonly id: string;
  readonly code: ChannelCode;
  readonly displayName: string;
  readonly status: ChannelStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ListChannelsParams {
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: string;
  readonly tenantScoped?: boolean;
}

export const channelsApi = {
  async list(
    params: ListChannelsParams = {},
    signal?: AbortSignal,
  ): Promise<ApiPagedResponse<ChannelView>> {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.sort) query.set('sort', params.sort);

    const queryString = query.toString();
    const endpoint = queryString ? `/channels?${queryString}` : '/channels';

    return apiFetch<ApiPagedResponse<ChannelView>>(endpoint, {
      method: 'GET',
      signal,
      skipTenant: !params.tenantScoped,
    });
  },

  async get(id: string, signal?: AbortSignal): Promise<ApiDataResponse<ChannelView>> {
    return apiFetch<ApiDataResponse<ChannelView>>(`/channels/${encodeURIComponent(id)}`, {
      method: 'GET',
      signal,
      skipTenant: true,
    });
  },
};

export interface ProviderCapabilityView {
  readonly key: string;
  readonly value: unknown;
}

export interface ProviderView {
  readonly id: string;
  readonly channelId: string;
  readonly channelCode: ChannelCode;
  readonly name: string;
  readonly adapterKey: string;
  readonly status: ProviderStatus;
  readonly healthState: ProviderHealthState;
  readonly healthOverride: ProviderHealthState | null;
  readonly healthChangedAt: string | null;
  readonly circuitState: ProviderCircuitState;
  readonly circuitChangedAt: string | null;
  readonly circuitCooldownUntil: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProviderDetailView extends ProviderView {
  readonly capabilities: readonly ProviderCapabilityView[];
}

export interface ListProvidersParams {
  readonly channelId?: string;
  readonly status?: ProviderStatus;
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: string;
}

export interface CreateProviderParams {
  readonly channelId: string;
  readonly name: string;
  readonly adapterKey: string;
}

export interface UpdateProviderParams {
  readonly name?: string;
}

export interface ReplaceProviderCapabilitiesParams {
  readonly capabilities: Array<{ key: string; value: unknown }>;
}

export interface ProviderTestSendParams {
  readonly behavior: SimulatorBehavior;
}

export interface ProviderTestSendResult {
  readonly providerId: string;
  readonly adapterKey: string;
  readonly channelCode: ChannelCode;
  readonly behavior: SimulatorBehavior;
  readonly submissionId: string;
  readonly correlationId: string;
  readonly outcome: 'accepted' | 'rejected';
  readonly providerMessageId: string | null;
  readonly failure: {
    readonly category: ProviderFailureCategory;
    readonly retryable: boolean;
    readonly providerCode: string | null;
    readonly message: string;
  } | null;
  readonly latencyMs: number;
  readonly circuitProbe: boolean;
  readonly healthState: ProviderHealthState;
  readonly circuitState: ProviderCircuitState;
}

export interface ProviderHealthCheckParams {
  readonly behavior: SimulatorHealthBehavior;
}

export interface ProviderHealthCheckResult {
  readonly providerId: string;
  readonly adapterKey: string;
  readonly channelCode: ChannelCode;
  readonly behavior: SimulatorHealthBehavior;
  readonly outcome: ProviderProbeOutcome;
  readonly latencyMs: number;
  readonly correlationId: string;
  readonly healthState: ProviderHealthState;
  readonly circuitState: ProviderCircuitState;
}

export interface ProviderHealthOverrideParams {
  readonly override: ProviderHealthState | null;
  readonly reason?: string;
}

export interface ProviderHealthSampleView {
  readonly id: string;
  readonly providerId: string;
  readonly kind: ProviderHealthSampleKind;
  readonly outcome: string;
  readonly classification: ProviderHealthClassification;
  readonly latencyMs: number | null;
  readonly healthState: ProviderHealthState;
  readonly circuitState: ProviderCircuitState;
  readonly circuitGeneration: number;
  readonly source: ProviderHealthSource;
  readonly observedAt: string;
  readonly createdAt: string;
}

export interface ListProviderHealthParams {
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: string;
}

export const providersApi = {
  async list(
    params: ListProvidersParams = {},
    signal?: AbortSignal,
  ): Promise<ApiPagedResponse<ProviderView>> {
    const query = new URLSearchParams();
    if (params.channelId) query.set('channelId', params.channelId);
    if (params.status) query.set('status', params.status);
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.sort) query.set('sort', params.sort);

    const queryString = query.toString();
    const endpoint = queryString ? `/providers?${queryString}` : '/providers';

    return apiFetch<ApiPagedResponse<ProviderView>>(endpoint, {
      method: 'GET',
      signal,
      skipTenant: true,
    });
  },

  async get(id: string, signal?: AbortSignal): Promise<ApiDataResponse<ProviderDetailView>> {
    return apiFetch<ApiDataResponse<ProviderDetailView>>(`/providers/${encodeURIComponent(id)}`, {
      method: 'GET',
      signal,
      skipTenant: true,
    });
  },

  async create(
    params: CreateProviderParams,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<ProviderDetailView>> {
    return apiFetch<ApiDataResponse<ProviderDetailView>>('/providers', {
      method: 'POST',
      body: params,
      signal,
      skipTenant: true,
    });
  },

  async update(
    id: string,
    params: UpdateProviderParams,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<ProviderDetailView>> {
    return apiFetch<ApiDataResponse<ProviderDetailView>>(`/providers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: params,
      signal,
      skipTenant: true,
    });
  },

  async replaceCapabilities(
    id: string,
    params: ReplaceProviderCapabilitiesParams,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<ProviderDetailView>> {
    return apiFetch<ApiDataResponse<ProviderDetailView>>(
      `/providers/${encodeURIComponent(id)}/capabilities`,
      {
        method: 'PUT',
        body: params,
        signal,
        skipTenant: true,
      },
    );
  },

  async enable(id: string, signal?: AbortSignal): Promise<ApiDataResponse<ProviderDetailView>> {
    return apiFetch<ApiDataResponse<ProviderDetailView>>(
      `/providers/${encodeURIComponent(id)}/enable`,
      {
        method: 'POST',
        signal,
        skipTenant: true,
      },
    );
  },

  async disable(id: string, signal?: AbortSignal): Promise<ApiDataResponse<ProviderDetailView>> {
    return apiFetch<ApiDataResponse<ProviderDetailView>>(
      `/providers/${encodeURIComponent(id)}/disable`,
      {
        method: 'POST',
        signal,
        skipTenant: true,
      },
    );
  },

  async drain(id: string, signal?: AbortSignal): Promise<ApiDataResponse<ProviderDetailView>> {
    return apiFetch<ApiDataResponse<ProviderDetailView>>(
      `/providers/${encodeURIComponent(id)}/drain`,
      {
        method: 'POST',
        signal,
        skipTenant: true,
      },
    );
  },

  async testSend(
    id: string,
    params: ProviderTestSendParams,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<ProviderTestSendResult>> {
    return apiFetch<ApiDataResponse<ProviderTestSendResult>>(
      `/providers/${encodeURIComponent(id)}/test-send`,
      {
        method: 'POST',
        body: params,
        signal,
        skipTenant: true,
      },
    );
  },

  async healthCheck(
    id: string,
    params: ProviderHealthCheckParams,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<ProviderHealthCheckResult>> {
    return apiFetch<ApiDataResponse<ProviderHealthCheckResult>>(
      `/providers/${encodeURIComponent(id)}/health-check`,
      {
        method: 'POST',
        body: params,
        signal,
        skipTenant: true,
      },
    );
  },

  async overrideHealth(
    id: string,
    params: ProviderHealthOverrideParams,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<ProviderDetailView>> {
    return apiFetch<ApiDataResponse<ProviderDetailView>>(
      `/providers/${encodeURIComponent(id)}/health`,
      {
        method: 'POST',
        body: params,
        signal,
        skipTenant: true,
      },
    );
  },

  async listHealth(
    id: string,
    params: ListProviderHealthParams = {},
    signal?: AbortSignal,
  ): Promise<ApiPagedResponse<ProviderHealthSampleView>> {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.sort) query.set('sort', params.sort);

    const queryString = query.toString();
    const endpoint = queryString
      ? `/providers/${encodeURIComponent(id)}/health?${queryString}`
      : `/providers/${encodeURIComponent(id)}/health`;

    return apiFetch<ApiPagedResponse<ProviderHealthSampleView>>(endpoint, {
      method: 'GET',
      signal,
      skipTenant: true,
    });
  },
};

export interface CircuitPolicyView extends ProviderCircuitPolicy {
  readonly version: number;
  readonly updatedAt: string;
}

export interface UpdateCircuitPolicyParams {
  readonly windowMs: number;
  readonly windowMaxSamples: number;
  readonly minSamples: number;
  readonly failurePercent: number;
  readonly cooldownMs: number;
  readonly halfOpenMaxProbes: number;
  readonly probeLeaseMs: number;
  readonly halfOpenSuccessesToClose: number;
  readonly expectedVersion: number;
}

export const providerCircuitPolicyApi = {
  async get(signal?: AbortSignal): Promise<ApiDataResponse<CircuitPolicyView>> {
    return apiFetch<ApiDataResponse<CircuitPolicyView>>('/provider-circuit-policy', {
      method: 'GET',
      signal,
      skipTenant: true,
    });
  },

  async update(
    params: UpdateCircuitPolicyParams,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<CircuitPolicyView>> {
    return apiFetch<ApiDataResponse<CircuitPolicyView>>('/provider-circuit-policy', {
      method: 'PUT',
      body: params,
      signal,
      skipTenant: true,
    });
  },
};

// -----------------------------------------------------------------------------
// Organization Provider Assignments API (Phase 3.2, ADR-014 §4)
// -----------------------------------------------------------------------------

export interface ListProviderAssignmentsParams {
  readonly channelId?: string;
  readonly status?: AssignmentStatus;
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: string;
}

export const providerAssignmentsApi = {
  async list(
    orgId: string,
    params: ListProviderAssignmentsParams = {},
    signal?: AbortSignal,
  ): Promise<ApiPagedResponse<OrganizationProviderAssignment>> {
    const query = new URLSearchParams();
    if (params.channelId) query.set('channelId', params.channelId);
    if (params.status) query.set('status', params.status);
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.sort) query.set('sort', params.sort);

    const queryString = query.toString();
    const endpoint = `/organizations/${encodeURIComponent(orgId)}/provider-assignments${queryString ? `?${queryString}` : ''}`;

    return apiFetch<ApiPagedResponse<OrganizationProviderAssignment>>(endpoint, {
      method: 'GET',
      signal,
      skipTenant: true,
    });
  },

  async get(
    orgId: string,
    assignmentId: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<OrganizationProviderAssignment>> {
    return apiFetch<ApiDataResponse<OrganizationProviderAssignment>>(
      `/organizations/${encodeURIComponent(orgId)}/provider-assignments/${encodeURIComponent(assignmentId)}`,
      {
        method: 'GET',
        signal,
        skipTenant: true,
      },
    );
  },

  async create(
    orgId: string,
    input: CreateOrganizationProviderAssignmentInput,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<OrganizationProviderAssignment>> {
    return apiFetch<ApiDataResponse<OrganizationProviderAssignment>>(
      `/organizations/${encodeURIComponent(orgId)}/provider-assignments`,
      {
        method: 'POST',
        body: input,
        signal,
        skipTenant: true,
      },
    );
  },

  async update(
    orgId: string,
    assignmentId: string,
    input: UpdateOrganizationProviderAssignmentInput,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<OrganizationProviderAssignment>> {
    return apiFetch<ApiDataResponse<OrganizationProviderAssignment>>(
      `/organizations/${encodeURIComponent(orgId)}/provider-assignments/${encodeURIComponent(assignmentId)}`,
      {
        method: 'PATCH',
        body: input,
        signal,
        skipTenant: true,
      },
    );
  },

  async enable(
    orgId: string,
    assignmentId: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<OrganizationProviderAssignment>> {
    return apiFetch<ApiDataResponse<OrganizationProviderAssignment>>(
      `/organizations/${encodeURIComponent(orgId)}/provider-assignments/${encodeURIComponent(assignmentId)}/enable`,
      {
        method: 'POST',
        signal,
        skipTenant: true,
      },
    );
  },

  async disable(
    orgId: string,
    assignmentId: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<OrganizationProviderAssignment>> {
    return apiFetch<ApiDataResponse<OrganizationProviderAssignment>>(
      `/organizations/${encodeURIComponent(orgId)}/provider-assignments/${encodeURIComponent(assignmentId)}/disable`,
      {
        method: 'POST',
        signal,
        skipTenant: true,
      },
    );
  },
};

// -----------------------------------------------------------------------------
// Templates API
// -----------------------------------------------------------------------------

export interface ListTemplatesParams {
  readonly cursor?: string;
  readonly limit?: number;
  readonly channelId?: string;
  readonly approvalStatus?: TemplateApprovalStatus;
  readonly sort?: string;
}

export interface SmsDltMetadataParams {
  readonly entityId: string;
  readonly templateId: string;
  readonly headerId?: string;
}

export interface CreateTemplateParams {
  readonly channelId: string;
  readonly name: string;
  readonly body: string;
  readonly variables?: readonly string[];
  readonly dlt?: SmsDltMetadataParams;
}

export interface UpdateTemplateParams {
  readonly name?: string;
  readonly body?: string;
  readonly variables?: readonly string[];
  readonly dlt?: SmsDltMetadataParams;
}

export type TargetApprovalStatus = 'pending' | 'approved' | 'rejected';

export const templatesApi = {
  async list(
    params: ListTemplatesParams = {},
    signal?: AbortSignal,
  ): Promise<ApiPagedResponse<TemplateResponse>> {
    const search = new URLSearchParams();
    if (params.cursor) search.set('cursor', params.cursor);
    if (params.limit) search.set('limit', String(params.limit));
    if (params.channelId) search.set('channelId', params.channelId);
    if (params.approvalStatus) search.set('approvalStatus', params.approvalStatus);
    if (params.sort) search.set('sort', params.sort);

    const query = search.toString();
    const path = query ? `/templates?${query}` : '/templates';
    return apiFetch<ApiPagedResponse<TemplateResponse>>(path, {
      method: 'GET',
      signal,
    });
  },

  async create(
    params: CreateTemplateParams,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<TemplateResponse>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    return apiFetch<ApiDataResponse<TemplateResponse>>('/templates', {
      method: 'POST',
      body: params,
      headers,
      signal,
    });
  },

  async get(templateId: string, signal?: AbortSignal): Promise<ApiDataResponse<TemplateResponse>> {
    return apiFetch<ApiDataResponse<TemplateResponse>>(
      `/templates/${encodeURIComponent(templateId)}`,
      {
        method: 'GET',
        signal,
      },
    );
  },

  async update(
    templateId: string,
    params: UpdateTemplateParams,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<TemplateResponse>> {
    return apiFetch<ApiDataResponse<TemplateResponse>>(
      `/templates/${encodeURIComponent(templateId)}`,
      {
        method: 'PATCH',
        body: params,
        signal,
      },
    );
  },

  async simulateApproval(
    templateId: string,
    targetStatus: TargetApprovalStatus,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<TemplateResponse>> {
    return apiFetch<ApiDataResponse<TemplateResponse>>(
      `/templates/${encodeURIComponent(templateId)}/simulate-approval`,
      {
        method: 'POST',
        body: { targetStatus },
        signal,
      },
    );
  },

  async delete(templateId: string, signal?: AbortSignal): Promise<void> {
    return apiFetch<void>(`/templates/${encodeURIComponent(templateId)}`, {
      method: 'DELETE',
      signal,
    });
  },
};

// -----------------------------------------------------------------------------
// Contacts API
// -----------------------------------------------------------------------------

export interface ListContactsParams {
  readonly cursor?: string;
  readonly limit?: number;
  readonly sort?: string;
}

export interface CreateContactParams {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface UpdateContactParams {
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly metadata?: Record<string, unknown>;
}

export interface CreateContactIdentityParams {
  readonly channelId: string;
  readonly rawAddress: string;
  readonly isPrimary?: boolean;
}

export interface CreateConsentEventParams {
  readonly channelId: string;
  readonly consentType: string;
  readonly event: ConsentEventType;
  readonly occurredAt: string;
  readonly source: string;
}

export interface GetEffectiveConsentParams {
  readonly channelId: string;
  readonly consentType: string;
}

export const contactsApi = {
  async list(
    workspaceId: string,
    params: ListContactsParams = {},
    signal?: AbortSignal,
  ): Promise<ApiPagedResponse<ContactResponse>> {
    const search = new URLSearchParams();
    if (params.cursor) search.set('cursor', params.cursor);
    if (params.limit) search.set('limit', String(params.limit));
    if (params.sort) search.set('sort', params.sort);

    const query = search.toString();
    const path = `/workspaces/${encodeURIComponent(workspaceId)}/contacts${query ? `?${query}` : ''}`;
    return apiFetch<ApiPagedResponse<ContactResponse>>(path, {
      method: 'GET',
      signal,
    });
  },

  async create(
    workspaceId: string,
    params: CreateContactParams,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<ContactResponse>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    return apiFetch<ApiDataResponse<ContactResponse>>(
      `/workspaces/${encodeURIComponent(workspaceId)}/contacts`,
      {
        method: 'POST',
        body: params,
        headers,
        signal,
      },
    );
  },

  async get(
    contactId: string,
    workspaceId?: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<ContactResponse>> {
    const path = workspaceId
      ? `/workspaces/${encodeURIComponent(workspaceId)}/contacts/${encodeURIComponent(contactId)}`
      : `/contacts/${encodeURIComponent(contactId)}`;
    return apiFetch<ApiDataResponse<ContactResponse>>(path, {
      method: 'GET',
      signal,
    });
  },

  async update(
    contactId: string,
    params: UpdateContactParams,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<ContactResponse>> {
    return apiFetch<ApiDataResponse<ContactResponse>>(
      `/contacts/${encodeURIComponent(contactId)}`,
      {
        method: 'PATCH',
        body: params,
        signal,
      },
    );
  },

  async createIdentity(
    contactId: string,
    params: CreateContactIdentityParams,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<ContactIdentityResponse>> {
    return apiFetch<ApiDataResponse<ContactIdentityResponse>>(
      `/contacts/${encodeURIComponent(contactId)}/identities`,
      {
        method: 'POST',
        body: params,
        signal,
      },
    );
  },

  async listIdentities(
    contactId: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<readonly ContactIdentityResponse[]>> {
    return apiFetch<ApiDataResponse<readonly ContactIdentityResponse[]>>(
      `/contacts/${encodeURIComponent(contactId)}/identities`,
      {
        method: 'GET',
        signal,
      },
    );
  },

  async createConsentEvent(
    contactId: string,
    params: CreateConsentEventParams,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<ConsentEventResponse>> {
    return apiFetch<ApiDataResponse<ConsentEventResponse>>(
      `/contacts/${encodeURIComponent(contactId)}/consent-events`,
      {
        method: 'POST',
        body: params,
        signal,
      },
    );
  },

  async getEffectiveConsent(
    contactId: string,
    params: GetEffectiveConsentParams,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<EffectiveConsentResponse>> {
    const search = new URLSearchParams();
    search.set('channelId', params.channelId);
    search.set('consentType', params.consentType);
    return apiFetch<ApiDataResponse<EffectiveConsentResponse>>(
      `/contacts/${encodeURIComponent(contactId)}/consent-effective?${search.toString()}`,
      {
        method: 'GET',
        signal,
      },
    );
  },
};

// -----------------------------------------------------------------------------
// Messages API
// -----------------------------------------------------------------------------

export interface SendMessageParams {
  readonly channelCode: string;
  readonly recipient: string;
  readonly templateId?: string;
  readonly workspaceId?: string;
  readonly payload: Record<string, unknown>;
}

export interface MessageAttemptDetail {
  readonly id: string;
  readonly attemptNumber: number;
  readonly providerId: string;
  readonly status: string;
  readonly failureReason: string | null;
  readonly latencyMs: number | null;
  readonly completedAt: string | null;
}

export interface MessageDetailWithAttempts {
  readonly id: string;
  readonly orgId: string;
  readonly workspaceId: string | null;
  readonly contactId: string | null;
  readonly channelId: string;
  readonly templateId: string | null;
  readonly status: MessageStatus;
  readonly recipientAddress: string;
  readonly payload: Record<string, unknown>;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly attempts: readonly MessageAttemptDetail[];
}

export interface ListMessagesParams {
  readonly status?: MessageStatus;
  readonly channelCode?: ChannelCode;
  readonly workspaceId?: string;
  readonly templateId?: string;
  readonly providerId?: string;
  readonly createdFrom?: string;
  readonly createdTo?: string;
  readonly limit?: number;
  readonly cursor?: string;
  readonly sort?: string;
}

export const messagesApi = {
  async list(
    params: ListMessagesParams = {},
    signal?: AbortSignal,
  ): Promise<ApiPagedResponse<MessageSummaryResponse>> {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.channelCode) query.set('channelCode', params.channelCode);
    if (params.workspaceId) query.set('workspaceId', params.workspaceId);
    if (params.templateId) query.set('templateId', params.templateId);
    if (params.providerId) query.set('providerId', params.providerId);
    if (params.createdFrom) query.set('createdFrom', params.createdFrom);
    if (params.createdTo) query.set('createdTo', params.createdTo);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.sort) query.set('sort', params.sort);

    const queryString = query.toString();
    const endpoint = queryString ? `/messages?${queryString}` : '/messages';

    return apiFetch<ApiPagedResponse<MessageSummaryResponse>>(endpoint, {
      method: 'GET',
      signal,
    });
  },

  async send(
    params: SendMessageParams,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<QueuedMessageResponse>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    return apiFetch<ApiDataResponse<QueuedMessageResponse>>('/messages', {
      method: 'POST',
      body: params,
      headers,
      signal,
    });
  },

  async get(
    messageId: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<MessageDetailWithAttempts>> {
    return apiFetch<ApiDataResponse<MessageDetailWithAttempts>>(
      `/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'GET',
        signal,
      },
    );
  },
};

// --- Suppressions (Organization) ---------------------------------------------

export interface ListSuppressionsParams {
  readonly channelId?: string;
  readonly status?: SuppressionStatus;
  readonly limit?: number;
  readonly cursor?: string;
  readonly sort?: 'createdAt' | '-createdAt';
}

export interface CreateSuppressionInput {
  readonly channelId?: string | null;
  readonly rawAddress: string;
  readonly reason: string;
}

export interface LiftSuppressionInput {
  readonly reason: string;
}

export const suppressionsApi = {
  async list(
    params: ListSuppressionsParams = {},
    signal?: AbortSignal,
  ): Promise<ApiPagedResponse<SuppressionResponse>> {
    const query = new URLSearchParams();
    if (params.channelId) query.set('channelId', params.channelId);
    if (params.status) query.set('status', params.status);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.sort) query.set('sort', params.sort);

    const queryString = query.toString();
    const endpoint = queryString ? `/suppressions?${queryString}` : '/suppressions';

    return apiFetch<ApiPagedResponse<SuppressionResponse>>(endpoint, {
      method: 'GET',
      signal,
    });
  },

  async get(id: string, signal?: AbortSignal): Promise<ApiDataResponse<SuppressionResponse>> {
    return apiFetch<ApiDataResponse<SuppressionResponse>>(
      `/suppressions/${encodeURIComponent(id)}`,
      {
        method: 'GET',
        signal,
      },
    );
  },

  async create(
    input: CreateSuppressionInput,
    idempotencyKey?: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<SuppressionResponse>> {
    const headers: Record<string, string> = {};
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }

    return apiFetch<ApiDataResponse<SuppressionResponse>>('/suppressions', {
      method: 'POST',
      headers,
      body: input,
      signal,
    });
  },

  async lift(
    id: string,
    input: LiftSuppressionInput,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<SuppressionResponse>> {
    return apiFetch<ApiDataResponse<SuppressionResponse>>(
      `/suppressions/${encodeURIComponent(id)}/lift`,
      {
        method: 'POST',
        body: input,
        signal,
      },
    );
  },
};

// -----------------------------------------------------------------------------
// Domains & Branding API Endpoints (Phase 4, U12)
// -----------------------------------------------------------------------------
export interface RegisterDomainInput {
  readonly domain: string;
  readonly isPrimary?: boolean;
}

export interface SuspendDomainInput {
  readonly reason?: string;
}

export interface UpdateBrandingInput {
  readonly brandName?: string;
  readonly logoUrl?: string;
  readonly faviconUrl?: string;
  readonly primaryColor?: string;
  readonly accentColor?: string;
  readonly supportEmail?: string;
  readonly supportPhone?: string;
  readonly customCss?: string;
  readonly privacyPolicyUrl?: string;
  readonly termsOfServiceUrl?: string;
}

export const domainsApi = {
  /**
   * Resolves public branding and portal routing for a given hostname.
   * Normative invariant: Hostname NEVER selects tenancy or authorization.
   */
  async resolve(
    hostname: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<ResolvedDomainView>> {
    const query = new URLSearchParams({ hostname });
    return apiFetch<ApiDataResponse<ResolvedDomainView>>(`/domains/resolve?${query.toString()}`, {
      method: 'GET',
      auth: false,
      skipTenant: true,
      signal,
    });
  },

  /**
   * Lists domains registered to the organization.
   */
  async list(orgId: string, signal?: AbortSignal): Promise<ApiDataResponse<readonly DomainView[]>> {
    return apiFetch<ApiDataResponse<readonly DomainView[]>>(
      `/organizations/${encodeURIComponent(orgId)}/domains`,
      {
        method: 'GET',
        signal,
      },
    );
  },

  /**
   * Registers a subdomain (.alendei.io) or custom domain for the organization.
   */
  async register(
    orgId: string,
    input: RegisterDomainInput,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<DomainView>> {
    return apiFetch<ApiDataResponse<DomainView>>(
      `/organizations/${encodeURIComponent(orgId)}/domains`,
      {
        method: 'POST',
        body: input,
        signal,
      },
    );
  },

  /**
   * Retrieves DNS verification instructions and challenge record for a domain.
   */
  async getVerification(
    orgId: string,
    domainId: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<DomainVerificationDetails>> {
    return apiFetch<ApiDataResponse<DomainVerificationDetails>>(
      `/organizations/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}/verification`,
      {
        method: 'GET',
        signal,
      },
    );
  },

  /**
   * Triggers DNS verification for a pending custom domain.
   */
  async verify(
    orgId: string,
    domainId: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<DomainView>> {
    return apiFetch<ApiDataResponse<DomainView>>(
      `/organizations/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}/verify`,
      {
        method: 'POST',
        signal,
      },
    );
  },

  /**
   * Sets a verified/active domain as the primary domain for the organization.
   */
  async setPrimary(
    orgId: string,
    domainId: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<DomainView>> {
    return apiFetch<ApiDataResponse<DomainView>>(
      `/organizations/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}/primary`,
      {
        method: 'PATCH',
        signal,
      },
    );
  },

  /**
   * Removes a domain mapping.
   */
  async remove(
    orgId: string,
    domainId: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<{ success: boolean }>> {
    return apiFetch<ApiDataResponse<{ success: boolean }>>(
      `/organizations/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}`,
      {
        method: 'DELETE',
        signal,
      },
    );
  },

  /**
   * Suspends a domain (platform-admin only).
   */
  async suspend(
    orgId: string,
    domainId: string,
    input: SuspendDomainInput = {},
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<DomainView>> {
    return apiFetch<ApiDataResponse<DomainView>>(
      `/organizations/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}/suspend`,
      {
        method: 'POST',
        body: input,
        signal,
      },
    );
  },

  /**
   * Activates a suspended domain (platform-admin only).
   */
  async activate(
    orgId: string,
    domainId: string,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<DomainView>> {
    return apiFetch<ApiDataResponse<DomainView>>(
      `/organizations/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}/activate`,
      {
        method: 'POST',
        signal,
      },
    );
  },

  /**
   * Retrieves branding configuration for an organization.
   */
  async getBranding(orgId: string, signal?: AbortSignal): Promise<ApiDataResponse<BrandConfig>> {
    return apiFetch<ApiDataResponse<BrandConfig>>(
      `/organizations/${encodeURIComponent(orgId)}/branding`,
      {
        method: 'GET',
        signal,
      },
    );
  },

  /**
   * Updates organization branding configuration.
   */
  async updateBranding(
    orgId: string,
    input: UpdateBrandingInput,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<BrandConfig>> {
    return apiFetch<ApiDataResponse<BrandConfig>>(
      `/organizations/${encodeURIComponent(orgId)}/branding`,
      {
        method: 'PATCH',
        body: input,
        signal,
      },
    );
  },
};

// -----------------------------------------------------------------------------
// Onboarding API Endpoints (Phase 4, U12)
// -----------------------------------------------------------------------------
export const onboardingApi = {
  /**
   * Onboards a direct customer organization with platform subdomain and admin user.
   */
  async onboardDirect(
    input: DirectCustomerOnboardingDto,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<OnboardingResult>> {
    return apiFetch<ApiDataResponse<OnboardingResult>>('/onboarding/direct', {
      method: 'POST',
      body: input,
      skipTenant: true,
      signal,
    });
  },

  /**
   * Onboards a reseller-managed customer organization.
   */
  async onboardResellerCustomer(
    input: ResellerCustomerOnboardingDto,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<OnboardingResult>> {
    return apiFetch<ApiDataResponse<OnboardingResult>>('/onboarding/reseller-customer', {
      method: 'POST',
      body: input,
      skipTenant: true,
      signal,
    });
  },

  /**
   * Onboards a white-label customer with custom domain challenge.
   */
  async onboardWhiteLabel(
    input: WhiteLabelCustomerOnboardingDto,
    signal?: AbortSignal,
  ): Promise<ApiDataResponse<OnboardingResult>> {
    return apiFetch<ApiDataResponse<OnboardingResult>>('/onboarding/white-label', {
      method: 'POST',
      body: input,
      skipTenant: true,
      signal,
    });
  },
};
