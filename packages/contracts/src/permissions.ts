/**
 * Permission catalogue (`RBAC.md` §1: keys are `{domain}.{action}`).
 *
 * Phase 1 deliberately defines only the permissions its own endpoints enforce.
 * Later phases add their own domains (`campaigns.*`, `providers.*`, `billing.*`,
 * ...) alongside the features that need them — speculative permission rows are
 * not seeded ahead of the code that checks them.
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

  // --- Platform control plane (`RBAC.md` §3) -------------------------------
  /** Cross-tenant read of any organization's tenancy records. */
  PLATFORM_TENANTS_READ: 'platform.tenants.read',
  /** Create/attach organizations and resellers on the control plane. */
  PLATFORM_TENANTS_MANAGE: 'platform.tenants.manage',
  /** Assign platform-level roles. Guarded additionally by `RBAC.md` §7. */
  PLATFORM_ROLES_ASSIGN: 'platform.roles.assign',
  /** Read any tenant's audit log from the control plane. */
  PLATFORM_AUDIT_READ: 'platform.audit.read',
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
  PERMISSIONS.PLATFORM_AUDIT_READ,
]);

export function isPermissionKey(value: string): value is PermissionKey {
  return (ALL_PERMISSION_KEYS as readonly string[]).includes(value);
}

/** Splits `{domain}.{action}` into its parts for the seeded catalogue rows. */
export function splitPermissionKey(key: PermissionKey): { domain: string; action: string } {
  const lastDot = key.lastIndexOf('.');
  return { domain: key.slice(0, lastDot), action: key.slice(lastDot + 1) };
}
