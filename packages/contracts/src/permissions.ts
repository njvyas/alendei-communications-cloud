import type { ScopeType } from './tenancy';

/**
 * Permission catalogue (`RBAC.md` §1: keys are `{domain}.{action}`).
 *
 * Phase 1 deliberately defines only the permissions its own endpoints enforce.
 * Later phases add their own domains (`campaigns.*`, `providers.*`, `billing.*`,
 * ...) alongside the features that need them — speculative permission rows are
 * not seeded ahead of the code that checks them.
 *
 * One deliberate exception (ADR-015 follow-up decision 6, 07-Oct-2026): the
 * eight ADR-014 §6 tenant-content keys are present as **inert** catalogue
 * entries, so their classification and allowed-scope sets are enforced before
 * Phase 3.1 introduces the content they guard. Nothing checks, grants, accepts
 * or lists them yet.
 */

export const PERMISSIONS = {
  // --- Organizations -------------------------------------------------------
  ORGANIZATIONS_READ: 'organizations.read',
  ORGANIZATIONS_CREATE: 'organizations.create',
  ORGANIZATIONS_UPDATE: 'organizations.update',

  // --- Workspaces ----------------------------------------------------------
  WORKSPACES_READ: 'workspaces.read',
  WORKSPACES_CREATE: 'workspaces.create',
  WORKSPACES_UPDATE: 'workspaces.update',

  // --- Teams ---------------------------------------------------------------
  TEAMS_READ: 'teams.read',
  TEAMS_CREATE: 'teams.create',
  TEAMS_UPDATE: 'teams.update',

  // --- Users ---------------------------------------------------------------
  USERS_READ: 'users.read',
  USERS_INVITE: 'users.invite',
  USERS_UPDATE: 'users.update',
  USERS_DISABLE: 'users.disable',
  /**
   * Restore a disabled user (Phase 1B.6.1).
   *
   * Separate from `users.disable` rather than folded into it. Disabling removes
   * access and reactivating restores it, and only the second one can hand
   * someone back the authority they held — including an administrator's. A
   * permission named "disable" that also re-enabled would misdescribe what it
   * confers, and every holder of it would silently acquire the other half.
   */
  USERS_REACTIVATE: 'users.reactivate',

  // --- Roles & grants ------------------------------------------------------
  ROLES_READ: 'roles.read',
  ROLES_CREATE: 'roles.create',
  ROLES_UPDATE: 'roles.update',
  ROLES_DELETE: 'roles.delete',
  ROLE_ASSIGNMENTS_READ: 'role_assignments.read',
  ROLE_ASSIGNMENTS_GRANT: 'role_assignments.grant',
  ROLE_ASSIGNMENTS_REVOKE: 'role_assignments.revoke',
  PERMISSIONS_READ: 'permissions.read',

  // --- Credentials ---------------------------------------------------------
  API_KEYS_READ: 'api_keys.read',
  API_KEYS_CREATE: 'api_keys.create',
  API_KEYS_REVOKE: 'api_keys.revoke',
  SESSIONS_READ: 'sessions.read',
  SESSIONS_REVOKE: 'sessions.revoke',

  // --- Audit ---------------------------------------------------------------
  AUDIT_READ: 'audit.read',

  // --- Reseller ------------------------------------------------------------
  RESELLERS_READ: 'resellers.read',
  RESELLERS_UPDATE: 'resellers.update',

  // --- Provider and channel catalogue (Phase 2.1, ADR-013 PD-5) -------------
  // Platform-scope catalogue permissions. They are enforced by
  // `AuthorizationService` at `{ scopeType: 'platform' }`; the catalogue's RLS
  // admits only platform-scope principals and names no role (ADR-013 F-3).
  /** Read the channel and provider catalogue. */
  PROVIDERS_READ: 'providers.read',
  /** Create, update and change the status of providers. */
  PROVIDERS_MANAGE: 'providers.manage',
  /**
   * Send a synthetic test message to one provider (Phase 2.2). Defined in 2.1
   * so the catalogue is complete; no route checks it until 2.2.
   */
  PROVIDERS_TEST_SEND: 'providers.test_send',

  // --- Platform control plane (`RBAC.md` §3) -------------------------------
  /** Cross-tenant read of any organization's tenancy records. */
  PLATFORM_TENANTS_READ: 'platform.tenants.read',
  /** Create/attach organizations and resellers on the control plane. */
  PLATFORM_TENANTS_MANAGE: 'platform.tenants.manage',
  /** Assign platform-level roles. Guarded additionally by `RBAC.md` §7. */
  PLATFORM_ROLES_ASSIGN: 'platform.roles.assign',
  /**
   * Appoint a predefined tenant-system role (`DELEGABLE_TENANT_SYSTEM_ROLES`)
   * that carries tenant-content permissions the actor does not itself hold
   * (ADR-015 R-6, `RBAC.md` §7b). Platform scope only; its sole purpose is that
   * narrow, audited exception to "no conferring a permission you do not hold".
   * Neither `platform.tenants.manage` nor `platform.roles.assign` gates it.
   */
  PLATFORM_ROLES_DELEGATE_TENANT: 'platform.roles.delegate_tenant',
  /** Read any tenant's audit log from the control plane. */
  PLATFORM_AUDIT_READ: 'platform.audit.read',

  // --- Tenant content (ADR-014 §6, D09; ADR-015 R-5) -------------------------
  // INERT CATALOGUE ENTRIES (ADR-015 follow-up decision 6, 07-Oct-2026): they
  // exist so the classification and the scope rules are in force before any
  // content exists. No route checks them, no seeded role carries them, the API
  // neither accepts nor lists them (`API_SURFACE_PERMISSION_KEYS`), and no
  // content table exists. Phase 3.1 activates them.
  CONTACTS_READ: 'contacts.read',
  CONTACTS_MANAGE: 'contacts.manage',
  TEMPLATES_READ: 'templates.read',
  TEMPLATES_MANAGE: 'templates.manage',
  SUPPRESSIONS_READ: 'suppressions.read',
  SUPPRESSIONS_MANAGE: 'suppressions.manage',
  MESSAGES_READ: 'messages.read',
  MESSAGES_SEND: 'messages.send',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSION_KEYS: readonly PermissionKey[] = Object.freeze(
  Object.values(PERMISSIONS),
) as readonly PermissionKey[];

/** Permissions that may only ever be held at platform scope. */
export const PLATFORM_ONLY_PERMISSIONS: readonly PermissionKey[] = Object.freeze([
  PERMISSIONS.PLATFORM_TENANTS_READ,
  PERMISSIONS.PLATFORM_TENANTS_MANAGE,
  PERMISSIONS.PLATFORM_ROLES_ASSIGN,
  PERMISSIONS.PLATFORM_ROLES_DELEGATE_TENANT,
  PERMISSIONS.PLATFORM_AUDIT_READ,
]);

// --- Classification and allowed scopes (ADR-015 R-5, D-HIGH-4b) --------------

/**
 * What kind of authority a permission is. These four and no other
 * (ADR-015 R-5: "no new classification beyond those currently defined").
 *
 *   platform               the `platform.` domain: the control plane itself
 *   platform_catalogue     the provider and channel catalogue (`providers.*`),
 *                          decided at platform scope (ADR-013 F-3)
 *   tenancy_administration tenancy records: organizations, workspaces, teams,
 *                          users, roles, grants, credentials, audit, resellers
 *   tenant_content         end-customer content (ADR-014 §6) — never conferred
 *                          by a platform or reseller grant
 *
 * Projected into `permissions.classification` (migration `0026`); the database
 * additionally pins `platform` ⇔ the `platform.` key prefix.
 */
export const PERMISSION_CLASSES = [
  'platform',
  'platform_catalogue',
  'tenancy_administration',
  'tenant_content',
] as const;
export type PermissionClass = (typeof PERMISSION_CLASSES)[number];

const P = PERMISSIONS;

/**
 * Every key's classification. `satisfies Record<PermissionKey, …>` makes an
 * unclassified key a compile error, not a runtime default.
 */
export const PERMISSION_CLASS: Readonly<Record<PermissionKey, PermissionClass>> = Object.freeze({
  [P.ORGANIZATIONS_READ]: 'tenancy_administration',
  [P.ORGANIZATIONS_CREATE]: 'tenancy_administration',
  [P.ORGANIZATIONS_UPDATE]: 'tenancy_administration',
  [P.WORKSPACES_READ]: 'tenancy_administration',
  [P.WORKSPACES_CREATE]: 'tenancy_administration',
  [P.WORKSPACES_UPDATE]: 'tenancy_administration',
  [P.TEAMS_READ]: 'tenancy_administration',
  [P.TEAMS_CREATE]: 'tenancy_administration',
  [P.TEAMS_UPDATE]: 'tenancy_administration',
  [P.USERS_READ]: 'tenancy_administration',
  [P.USERS_INVITE]: 'tenancy_administration',
  [P.USERS_UPDATE]: 'tenancy_administration',
  [P.USERS_DISABLE]: 'tenancy_administration',
  [P.USERS_REACTIVATE]: 'tenancy_administration',
  [P.ROLES_READ]: 'tenancy_administration',
  [P.ROLES_CREATE]: 'tenancy_administration',
  [P.ROLES_UPDATE]: 'tenancy_administration',
  [P.ROLES_DELETE]: 'tenancy_administration',
  [P.ROLE_ASSIGNMENTS_READ]: 'tenancy_administration',
  [P.ROLE_ASSIGNMENTS_GRANT]: 'tenancy_administration',
  [P.ROLE_ASSIGNMENTS_REVOKE]: 'tenancy_administration',
  [P.PERMISSIONS_READ]: 'tenancy_administration',
  [P.API_KEYS_READ]: 'tenancy_administration',
  [P.API_KEYS_CREATE]: 'tenancy_administration',
  [P.API_KEYS_REVOKE]: 'tenancy_administration',
  [P.SESSIONS_READ]: 'tenancy_administration',
  [P.SESSIONS_REVOKE]: 'tenancy_administration',
  [P.AUDIT_READ]: 'tenancy_administration',
  [P.RESELLERS_READ]: 'tenancy_administration',
  [P.RESELLERS_UPDATE]: 'tenancy_administration',
  [P.PROVIDERS_READ]: 'platform_catalogue',
  [P.PROVIDERS_MANAGE]: 'platform_catalogue',
  [P.PROVIDERS_TEST_SEND]: 'platform_catalogue',
  [P.PLATFORM_TENANTS_READ]: 'platform',
  [P.PLATFORM_TENANTS_MANAGE]: 'platform',
  [P.PLATFORM_ROLES_ASSIGN]: 'platform',
  [P.PLATFORM_ROLES_DELEGATE_TENANT]: 'platform',
  [P.PLATFORM_AUDIT_READ]: 'platform',
  [P.CONTACTS_READ]: 'tenant_content',
  [P.CONTACTS_MANAGE]: 'tenant_content',
  [P.TEMPLATES_READ]: 'tenant_content',
  [P.TEMPLATES_MANAGE]: 'tenant_content',
  [P.SUPPRESSIONS_READ]: 'tenant_content',
  [P.SUPPRESSIONS_MANAGE]: 'tenant_content',
  [P.MESSAGES_READ]: 'tenant_content',
  [P.MESSAGES_SEND]: 'tenant_content',
} satisfies Record<PermissionKey, PermissionClass>);

/** Every scope level; the allowed-scope set of a permission no rule narrows. */
const EVERY_SCOPE: readonly ScopeType[] = Object.freeze([
  'platform',
  'reseller',
  'organization',
  'workspace',
  'team',
]);
const PLATFORM_ONLY_SCOPE: readonly ScopeType[] = Object.freeze(['platform']);

/**
 * The scope types at which a grant may confer each permission (ADR-015 R-5,
 * D-HIGH-4b). A grant at a scope type outside the set confers nothing for that
 * permission, whatever its role carries — the evaluator, the API-key path and
 * `fn_validate_role_permission` all apply this one table.
 *
 * - every `platform.*` key: `platform` only;
 * - every other key that existed before ADR-015: all five scopes — none of them
 *   was narrowed (R-6 mechanism, "Existing scope sets");
 * - the eight tenant-content keys: exactly the ADR-014 §6 table — never
 *   `platform`, `reseller` or `team`.
 *
 * Listed in canonical hierarchy order, which is also the order the database
 * stores (`permissions.allowed_scope_types`).
 */
export const PERMISSION_ALLOWED_SCOPES: Readonly<Record<PermissionKey, readonly ScopeType[]>> =
  Object.freeze({
    [P.ORGANIZATIONS_READ]: EVERY_SCOPE,
    [P.ORGANIZATIONS_CREATE]: EVERY_SCOPE,
    [P.ORGANIZATIONS_UPDATE]: EVERY_SCOPE,
    [P.WORKSPACES_READ]: EVERY_SCOPE,
    [P.WORKSPACES_CREATE]: EVERY_SCOPE,
    [P.WORKSPACES_UPDATE]: EVERY_SCOPE,
    [P.TEAMS_READ]: EVERY_SCOPE,
    [P.TEAMS_CREATE]: EVERY_SCOPE,
    [P.TEAMS_UPDATE]: EVERY_SCOPE,
    [P.USERS_READ]: EVERY_SCOPE,
    [P.USERS_INVITE]: EVERY_SCOPE,
    [P.USERS_UPDATE]: EVERY_SCOPE,
    [P.USERS_DISABLE]: EVERY_SCOPE,
    [P.USERS_REACTIVATE]: EVERY_SCOPE,
    [P.ROLES_READ]: EVERY_SCOPE,
    [P.ROLES_CREATE]: EVERY_SCOPE,
    [P.ROLES_UPDATE]: EVERY_SCOPE,
    [P.ROLES_DELETE]: EVERY_SCOPE,
    [P.ROLE_ASSIGNMENTS_READ]: EVERY_SCOPE,
    [P.ROLE_ASSIGNMENTS_GRANT]: EVERY_SCOPE,
    [P.ROLE_ASSIGNMENTS_REVOKE]: EVERY_SCOPE,
    [P.PERMISSIONS_READ]: EVERY_SCOPE,
    [P.API_KEYS_READ]: EVERY_SCOPE,
    [P.API_KEYS_CREATE]: EVERY_SCOPE,
    [P.API_KEYS_REVOKE]: EVERY_SCOPE,
    [P.SESSIONS_READ]: EVERY_SCOPE,
    [P.SESSIONS_REVOKE]: EVERY_SCOPE,
    [P.AUDIT_READ]: EVERY_SCOPE,
    [P.RESELLERS_READ]: EVERY_SCOPE,
    [P.RESELLERS_UPDATE]: EVERY_SCOPE,
    [P.PROVIDERS_READ]: EVERY_SCOPE,
    [P.PROVIDERS_MANAGE]: EVERY_SCOPE,
    [P.PROVIDERS_TEST_SEND]: EVERY_SCOPE,
    [P.PLATFORM_TENANTS_READ]: PLATFORM_ONLY_SCOPE,
    [P.PLATFORM_TENANTS_MANAGE]: PLATFORM_ONLY_SCOPE,
    [P.PLATFORM_ROLES_ASSIGN]: PLATFORM_ONLY_SCOPE,
    [P.PLATFORM_ROLES_DELEGATE_TENANT]: PLATFORM_ONLY_SCOPE,
    [P.PLATFORM_AUDIT_READ]: PLATFORM_ONLY_SCOPE,
    [P.CONTACTS_READ]: Object.freeze(['organization', 'workspace']),
    [P.CONTACTS_MANAGE]: Object.freeze(['organization', 'workspace']),
    [P.TEMPLATES_READ]: Object.freeze(['organization']),
    [P.TEMPLATES_MANAGE]: Object.freeze(['organization']),
    [P.SUPPRESSIONS_READ]: Object.freeze(['organization']),
    [P.SUPPRESSIONS_MANAGE]: Object.freeze(['organization']),
    [P.MESSAGES_READ]: Object.freeze(['organization', 'workspace']),
    [P.MESSAGES_SEND]: Object.freeze(['organization', 'workspace']),
  } satisfies Record<PermissionKey, readonly ScopeType[]>);

/** The tenant-content keys (ADR-014 §6), derived from the classification. */
export const TENANT_CONTENT_PERMISSIONS: readonly PermissionKey[] = Object.freeze(
  ALL_PERMISSION_KEYS.filter((key) => PERMISSION_CLASS[key] === 'tenant_content'),
);

export function isTenantContentPermission(permission: string): boolean {
  return isPermissionKey(permission) && PERMISSION_CLASS[permission] === 'tenant_content';
}

/**
 * May a grant at `scopeType` confer `permission`? A key outside the catalogue
 * is never conferred (fail closed).
 */
export function permissionAllowedAt(permission: string, scopeType: ScopeType): boolean {
  if (!isPermissionKey(permission)) return false;
  return PERMISSION_ALLOWED_SCOPES[permission].includes(scopeType);
}

/**
 * **The** predicate for "does this one grant confer `permission`?" (ADR-015
 * R-5): its role carries the permission **and** the grant's scope type is in
 * the permission's allowed-scope set. Coverage of a target is a separate,
 * second question (`scopeCovers`). Every place that reads authority off a grant
 * — `PermissionEvaluator`, the API-key creator intersection, the organization
 * read reach — asks it through this function, so a platform or reseller grant
 * whose role somehow carried a tenant-content key still confers nothing.
 */
export function grantConfers(
  grant: { readonly scopeType: ScopeType; readonly permissions: readonly string[] },
  permission: string,
): boolean {
  return grant.permissions.includes(permission) && permissionAllowedAt(permission, grant.scopeType);
}

/**
 * The permission keys the HTTP API accepts and lists today: every key except
 * the tenant-content keys, which are inert catalogue entries with no API
 * behaviour (ADR-015 follow-up decision 6). `CreateRoleDto`, `UpdateRoleDto`,
 * `CreateApiKeyDto` and `GET /permissions` use this list. **Phase 3.1 changes
 * it** when it activates the content keys — together with the routes that
 * check them.
 */
export const API_SURFACE_PERMISSION_KEYS: readonly PermissionKey[] = Object.freeze(
  ALL_PERMISSION_KEYS.filter((key) => PERMISSION_CLASS[key] !== 'tenant_content'),
);

export function isPermissionKey(value: string): value is PermissionKey {
  return (ALL_PERMISSION_KEYS as readonly string[]).includes(value);
}

/** Splits `{domain}.{action}` into its parts for the seeded catalogue rows. */
export function splitPermissionKey(key: PermissionKey): { domain: string; action: string } {
  const lastDot = key.lastIndexOf('.');
  return { domain: key.slice(0, lastDot), action: key.slice(lastDot + 1) };
}
