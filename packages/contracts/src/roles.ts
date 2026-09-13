/**
 * System role definitions (`RBAC.md` §§3-4).
 *
 * Platform roles are fixed and not tenant-configurable. Tenant roles are seeded
 * per organization as editable defaults; organizations may compose additional
 * custom roles from the same permission catalogue.
 */
import { PERMISSIONS, type PermissionKey } from './permissions';
import type { ScopeType } from './tenancy';

export const PLATFORM_ROLE_KEYS = {
  ALENDEI_SUPER_ADMIN: 'alendei_super_admin',
  ALENDEI_SUPPORT: 'alendei_support',
  RESELLER_ADMIN: 'reseller_admin',
} as const;

export type PlatformRoleKey = (typeof PLATFORM_ROLE_KEYS)[keyof typeof PLATFORM_ROLE_KEYS];

export const TENANT_ROLE_KEYS = {
  ORG_ADMIN: 'org_admin',
  WORKSPACE_MANAGER: 'workspace_manager',
  CAMPAIGN_EDITOR: 'campaign_editor',
  AGENT: 'agent',
  READ_ONLY: 'read_only',
} as const;

export type TenantRoleKey = (typeof TENANT_ROLE_KEYS)[keyof typeof TENANT_ROLE_KEYS];

export interface RoleDefinition {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** Scope levels at which this role may legitimately be granted. */
  readonly allowedScopeTypes: readonly ScopeType[];
  readonly permissions: readonly PermissionKey[];
}

const P = PERMISSIONS;

const TENANT_READ_PERMISSIONS: readonly PermissionKey[] = [
  P.ORGANIZATIONS_READ,
  P.WORKSPACES_READ,
  P.TEAMS_READ,
  P.USERS_READ,
  P.ROLES_READ,
  P.ROLE_ASSIGNMENTS_READ,
  P.PERMISSIONS_READ,
];

/**
 * Platform-level roles. `roles.org_id IS NULL` for every one of these
 * (`DATABASE.md` §2) and they may only be assigned by an existing platform
 * admin (`RBAC.md` §7).
 */
export const PLATFORM_ROLE_DEFINITIONS: readonly RoleDefinition[] = Object.freeze([
  {
    key: PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN,
    name: 'Alendei Super Admin',
    description: 'Full control-plane access across every tenant.',
    allowedScopeTypes: ['platform'],
    permissions: Object.values(P),
  },
  {
    key: PLATFORM_ROLE_KEYS.ALENDEI_SUPPORT,
    name: 'Alendei Support',
    description: 'Cross-tenant read access for support, plus audit visibility.',
    allowedScopeTypes: ['platform'],
    permissions: [
      ...TENANT_READ_PERMISSIONS,
      P.API_KEYS_READ,
      P.SESSIONS_READ,
      P.AUDIT_READ,
      P.RESELLERS_READ,
      P.PLATFORM_TENANTS_READ,
      P.PLATFORM_AUDIT_READ,
    ],
  },
  {
    key: PLATFORM_ROLE_KEYS.RESELLER_ADMIN,
    name: 'Reseller Admin',
    description: 'Manage the organizations beneath one reseller.',
    allowedScopeTypes: ['reseller'],
    permissions: [
      ...TENANT_READ_PERMISSIONS,
      P.ORGANIZATIONS_CREATE,
      P.ORGANIZATIONS_UPDATE,
      P.WORKSPACES_CREATE,
      P.WORKSPACES_UPDATE,
      P.USERS_INVITE,
      P.USERS_UPDATE,
      P.ROLE_ASSIGNMENTS_GRANT,
      P.ROLE_ASSIGNMENTS_REVOKE,
      P.RESELLERS_READ,
      P.RESELLERS_UPDATE,
      P.AUDIT_READ,
    ],
  },
]);

/**
 * Tenant-configurable seeded roles. `campaign_editor` and `agent` intentionally
 * carry only the Phase 1 permissions that exist today; the campaign/inbox grants
 * described in `RBAC.md` §4 are added by the phases that introduce those domains.
 */
export const TENANT_ROLE_DEFINITIONS: readonly RoleDefinition[] = Object.freeze([
  {
    key: TENANT_ROLE_KEYS.ORG_ADMIN,
    name: 'Organization Admin',
    description: 'Full control within the organization: users, workspaces, roles, API keys.',
    allowedScopeTypes: ['organization'],
    permissions: [
      ...TENANT_READ_PERMISSIONS,
      P.ORGANIZATIONS_UPDATE,
      P.WORKSPACES_CREATE,
      P.WORKSPACES_UPDATE,
      P.TEAMS_CREATE,
      P.TEAMS_UPDATE,
      P.USERS_INVITE,
      P.USERS_UPDATE,
      P.USERS_DISABLE,
      P.ROLES_CREATE,
      P.ROLES_UPDATE,
      P.ROLES_DELETE,
      P.ROLE_ASSIGNMENTS_GRANT,
      P.ROLE_ASSIGNMENTS_REVOKE,
      P.API_KEYS_READ,
      P.API_KEYS_CREATE,
      P.API_KEYS_REVOKE,
      P.SESSIONS_READ,
      P.SESSIONS_REVOKE,
      P.AUDIT_READ,
    ],
  },
  {
    key: TENANT_ROLE_KEYS.WORKSPACE_MANAGER,
    name: 'Workspace Manager',
    description: "Manage a workspace's teams and members.",
    allowedScopeTypes: ['organization', 'workspace'],
    permissions: [
      ...TENANT_READ_PERMISSIONS,
      P.WORKSPACES_UPDATE,
      P.TEAMS_CREATE,
      P.TEAMS_UPDATE,
      P.USERS_INVITE,
      P.ROLE_ASSIGNMENTS_GRANT,
      P.ROLE_ASSIGNMENTS_REVOKE,
    ],
  },
  {
    key: TENANT_ROLE_KEYS.CAMPAIGN_EDITOR,
    name: 'Campaign Editor',
    description:
      'Create and edit campaigns and journeys. Campaign permissions arrive with Phase 8B.',
    allowedScopeTypes: ['organization', 'workspace', 'team'],
    permissions: TENANT_READ_PERMISSIONS,
  },
  {
    key: TENANT_ROLE_KEYS.AGENT,
    name: 'Agent',
    description: 'Unified inbox access. Conversation permissions arrive with Phase 8D.',
    allowedScopeTypes: ['organization', 'workspace', 'team'],
    permissions: [P.WORKSPACES_READ, P.TEAMS_READ, P.USERS_READ],
  },
  {
    key: TENANT_ROLE_KEYS.READ_ONLY,
    name: 'Read Only',
    description: 'Reporting and audit view only.',
    allowedScopeTypes: ['organization', 'workspace', 'team'],
    permissions: [...TENANT_READ_PERMISSIONS, P.AUDIT_READ],
  },
]);

export const ALL_ROLE_DEFINITIONS: readonly RoleDefinition[] = Object.freeze([
  ...PLATFORM_ROLE_DEFINITIONS,
  ...TENANT_ROLE_DEFINITIONS,
]);

export function isPlatformRoleKey(key: string): key is PlatformRoleKey {
  return PLATFORM_ROLE_DEFINITIONS.some((role) => role.key === key);
}

/**
 * Scope levels beneath (or equal to) a grant scope. An organization-level grant
 * cascades to every workspace and team under it (`RBAC.md` §2).
 */
export const SCOPE_DEPTH: Readonly<Record<ScopeType, number>> = Object.freeze({
  platform: 0,
  reseller: 1,
  organization: 2,
  workspace: 3,
  team: 4,
});

/** One level of the canonical hierarchy, as a concrete target. */
export interface ScopeRef {
  readonly scopeType: ScopeType;
  /** `null` only for `platform`, which has no row. */
  readonly scopeId: string | null;
}

/**
 * The ancestry of a target, as resolved from the database. Supplied separately
 * because coverage cannot be decided from ids alone — knowing a grant is at
 * workspace W and a target at team T says nothing until you know T's parent.
 */
export interface ScopeChain {
  readonly resellerId?: string | null;
  readonly orgId?: string | null;
  readonly workspaceId?: string | null;
  readonly teamId?: string | null;
}

/**
 * Does a grant at `grant` cover an action at `target`?
 *
 * This is `TENANCY.md` §1a.4's downward-only inheritance expressed once, as a
 * pure function, so every call site decides coverage the same way:
 *
 *     platform     -> everything
 *     reseller     -> its organizations, and their workspaces and teams
 *     organization -> its workspaces and their teams
 *     workspace    -> its teams
 *     team         -> itself
 *
 * Nothing ever covers upward or sideways. Holding a permission somewhere is
 * never authority over *this* resource (`API.md` §3a).
 */
export function scopeCovers(grant: ScopeRef, target: ScopeRef, chain: ScopeChain): boolean {
  if (grant.scopeType === 'platform') return true;
  if (!grant.scopeId) return false;

  // A grant can never reach a level above its own.
  if (SCOPE_DEPTH[grant.scopeType] > SCOPE_DEPTH[target.scopeType]) return false;

  switch (grant.scopeType) {
    case 'reseller':
      return chain.resellerId === grant.scopeId;
    case 'organization':
      return chain.orgId === grant.scopeId;
    case 'workspace':
      return chain.workspaceId === grant.scopeId;
    case 'team':
      return chain.teamId === grant.scopeId;
    default:
      return false;
  }
}
