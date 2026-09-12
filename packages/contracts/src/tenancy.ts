/**
 * Tenant and identity contracts shared by the API, workers and the console.
 *
 * Canonical definitions: `docs/TENANCY.md` §§1-2, `docs/API.md` §3.
 */

/**
 * Levels at which a role may be granted (`user_roles.scope_type`).
 *
 * `organization | workspace | team` are the tenant-configurable scopes named in
 * `RBAC.md` §1. `platform` and `reseller` exist because `RBAC.md` §3 defines
 * roles at those levels and `DATABASE.md` §2 explicitly permits a platform-level
 * role to use "a value the platform role's design permits".
 */
export const SCOPE_TYPES = ['platform', 'reseller', 'organization', 'workspace', 'team'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

/** Scope levels that live inside a single organization's tenancy tree. */
export const TENANT_SCOPE_TYPES = ['organization', 'workspace', 'team'] as const;
export type TenantScopeType = (typeof TENANT_SCOPE_TYPES)[number];

export const ACTOR_TYPES = ['user', 'api_key', 'oauth_client', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/**
 * Server-derived tenant context (`TENANCY.md` §2).
 *
 * This object is produced exclusively from validated authentication material.
 * A tenant identifier appearing in a URL, query string, body or header is
 * advisory only and is cross-checked against this context, never trusted.
 */
export interface TenantContext {
  readonly orgId: string | null;
  readonly workspaceId: string | null;
  readonly resellerId: string | null;
  /** True only for holders of a platform-scoped role (`RBAC.md` §3). */
  readonly isPlatformAdmin: boolean;
}

/** A single role grant held by the authenticated principal. */
export interface RoleGrant {
  readonly roleId: string;
  readonly roleKey: string;
  readonly scopeType: ScopeType;
  readonly scopeId: string | null;
  readonly orgId: string | null;
}

/**
 * The authenticated principal for a request. Exactly one identity type
 * (`API.md` §3); the identity types are never collapsed into one another.
 */
export interface AuthPrincipal {
  readonly actorType: ActorType;
  /** Set for `actorType === 'user'`. */
  readonly userId: string | null;
  /** Set for `actorType === 'api_key'`. */
  readonly apiKeyId: string | null;
  /** Set for `actorType === 'user'` sessions. */
  readonly sessionId: string | null;
  readonly tenant: TenantContext;
  readonly roles: readonly RoleGrant[];
  /** Effective permission keys, already flattened across all role grants. */
  readonly permissions: readonly string[];
}

/** Per-request identity plumbed through logs, traces, events and audit rows. */
export interface RequestContext {
  readonly correlationId: string;
  readonly requestId: string;
  readonly causationId: string | null;
  readonly principal: AuthPrincipal | null;
}
