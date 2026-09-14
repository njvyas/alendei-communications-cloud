/**
 * Tenant and identity contracts shared by the API, workers and the console.
 *
 * Canonical definitions: `docs/TENANCY.md` §§1-2, `docs/API.md` §3.
 */

/**
 * Levels at which a role may be granted (`user_roles.scope_type`).
 *
 * The canonical five-level authorization hierarchy, defined normatively in
 * `TENANCY.md` §1a and resolved in ADR-001 (`DECISIONS.md` §1a):
 *
 *     platform -> reseller -> organization -> workspace -> team
 *
 * Two other columns are also named `scope_type` — on `routing_policies` and
 * `provider_credentials` — and are deliberately *different* enums carrying
 * configuration scopes that confer no access. `TENANCY.md` §1a.2 tabulates all
 * three; they must never be conflated.
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

/**
 * A single role grant held by the authenticated principal.
 *
 * A grant is the unit an authorization decision is made against: it carries
 * both the permissions its role confers **and** the scope they are conferred
 * at, so the two can never be read from different grants (ADR-005 D-1).
 */
export interface RoleGrant {
  readonly roleId: string;
  readonly roleKey: string;
  readonly scopeType: ScopeType;
  readonly scopeId: string | null;
  readonly orgId: string | null;
  /**
   * The permissions this grant's role carries — and the only permission set an
   * authorization decision about this grant may consult.
   *
   * Required rather than optional on purpose: a grant with no permission set is
   * not a grant that permits everything, and making the field optional would
   * let one be constructed by omission. The compiler refusing an incomplete
   * grant is what keeps permission provenance intact at every construction
   * site.
   */
  readonly permissions: readonly string[];
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
  /**
   * Every permission key the principal holds through *some* grant, flattened.
   *
   * **Not authoritative for an authorization decision** (ADR-005 D-3). It says
   * what the principal can do *somewhere*, never what it can do *here*, and
   * testing it against a separately-resolved scope authorizes the cross-product
   * of the two — combinations no single grant confers. `PermissionEvaluator`
   * therefore reads `RoleGrant.permissions` instead.
   *
   * Retained for the two uses that legitimately want the union: the API-key
   * creator intersection (`RBAC.md` §5c), and capability hints a console uses
   * to decide what to render.
   */
  readonly permissions: readonly string[];
}

/** Per-request identity plumbed through logs, traces, events and audit rows. */
export interface RequestContext {
  readonly correlationId: string;
  readonly requestId: string;
  readonly causationId: string | null;
  readonly principal: AuthPrincipal | null;
}
