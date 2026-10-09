import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps } from './_shared';
import { users } from './iam';
import { organizations } from './tenancy';

/**
 * RBAC domain (`RBAC.md` §1, `DATABASE.md` §2):
 *
 *   users --< user_roles >-- roles --< role_permissions >-- permissions
 */

/**
 * Scope levels for a role grant.
 *
 * `RBAC.md` §1 names `organization | workspace | team`; `RBAC.md` §3 additionally
 * defines roles at platform and reseller level, and `DATABASE.md` §2's
 * scope-integrity rule explicitly allows a platform-level role to use "a value
 * the platform role's design permits". Both are therefore included here.
 */
export const roleScopeType = pgEnum('role_scope_type', [
  'platform',
  'reseller',
  'organization',
  'workspace',
  'team',
]);

export const roles = pgTable(
  'roles',
  {
    id: primaryId(),
    /** NULL marks a platform-level role (`DATABASE.md` §2). */
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isSystemRole: boolean('is_system_role').notNull().default(false),
    /**
     * The scope levels at which this role may legitimately be granted
     * (`RBAC.md` §7), mirroring `RoleDefinition.allowedScopeTypes`.
     *
     * Added in migration `0004` so a role carries the levels it was designed
     * for. **Grant-time enforcement is Phase 1B.5.5's**, in the service layer;
     * migration `0004` deliberately leaves `fn_validate_user_role_scope`
     * untouched. Until then this column is authoritative data that nothing
     * consults at grant time, which is why 1B.5.5 owns §6n case 28.
     */
    allowedScopeTypes: roleScopeType('allowed_scope_types').array().notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('roles_org_key_key')
      .on(table.orgId, table.key)
      .where(sql`${table.orgId} IS NOT NULL`),
    uniqueIndex('roles_platform_key_key')
      .on(table.key)
      .where(sql`${table.orgId} IS NULL`),
    index('roles_org_id_idx').on(table.orgId),
    // Keyset pagination for `GET /roles` (migration `0006`): the tenant
    // discriminator, the sort column, then the tie-breaker, so the planner walks
    // the index and stops at LIMIT instead of sorting the whole predicate.
    index('roles_org_key_id_idx').on(table.orgId, table.key, table.id),
    index('roles_org_created_at_id_idx').on(table.orgId, table.createdAt, table.id),
    check('roles_key_format', sql`${table.key} ~ '^[a-z][a-z0-9_]{2,63}$'`),
    // A role admitting no scope could never be granted anywhere — silently
    // broken rather than restrictive — and an empty set would satisfy the
    // R-5 eligibility rule (role scopes ⊆ permission scopes) vacuously.
    // `cardinality`, not `array_length`: the latter is NULL for an empty
    // array, and a CHECK passes on NULL (migration `0029`).
    check('roles_allowed_scope_types_non_empty', sql`cardinality(${table.allowedScopeTypes}) >= 1`),
    // A platform role is designed for platform/reseller scope and nothing
    // below; a tenant role for organization/workspace/team and nothing above.
    check(
      'roles_allowed_scope_types_level',
      sql`CASE WHEN ${table.orgId} IS NULL
            THEN ${table.allowedScopeTypes} <@ ARRAY['platform','reseller']::role_scope_type[]
            ELSE ${table.allowedScopeTypes} <@ ARRAY['organization','workspace','team']::role_scope_type[]
          END`,
    ),
  ],
);

/** Global, system-defined catalogue. Not tenant data (`API.md` §2: read-only). */
export const permissions = pgTable(
  'permissions',
  {
    id: primaryId(),
    key: text('key').notNull(),
    domain: text('domain').notNull(),
    action: text('action').notNull(),
    description: text('description'),
    /**
     * `PERMISSION_CLASS[key]` (ADR-015 R-5, migration `0026`): `platform`,
     * `platform_catalogue`, `tenancy_administration` or `tenant_content`. No
     * default — a row must be classified explicitly, by the migration that adds
     * it and by `seed.ts`, both from `packages/contracts`.
     */
    classification: text('classification').notNull(),
    /**
     * `PERMISSION_ALLOWED_SCOPES[key]` (ADR-015 R-5, migration `0026`): the
     * scope types at which a grant may confer this permission.
     * `fn_validate_role_permission` refuses a role whose `allowed_scope_types`
     * is not a subset of it. No default.
     */
    allowedScopeTypes: roleScopeType('allowed_scope_types').array().notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('permissions_key_key').on(table.key),
    index('permissions_domain_idx').on(table.domain),
    check('permissions_key_format', sql`${table.key} ~ '^[a-z][a-z0-9_.]*\\.[a-z][a-z0-9_]*$'`),
    // The four classes of ADR-015 R-5, and no other.
    check(
      'permissions_classification_valid',
      sql`${table.classification} IN ('platform', 'platform_catalogue', 'tenancy_administration', 'tenant_content')`,
    ),
    // `platform` is exactly the `platform.` domain, in both directions.
    check(
      'permissions_classification_platform_domain',
      sql`(${table.classification} = 'platform') = (${table.key} LIKE 'platform.%')`,
    ),
    // `cardinality`, not `array_length`: the latter is NULL for an empty
    // array, and a CHECK passes on NULL.
    check(
      'permissions_allowed_scope_types_non_empty',
      sql`cardinality(${table.allowedScopeTypes}) >= 1`,
    ),
    // A platform permission is conferred at platform scope only.
    check(
      'permissions_platform_scope_only',
      sql`${table.classification} <> 'platform' OR ${table.allowedScopeTypes} = ARRAY['platform']::role_scope_type[]`,
    ),
    // Tenant content is never conferred at platform or reseller scope (ADR-014 §6).
    check(
      'permissions_tenant_content_scopes',
      sql`${table.classification} <> 'tenant_content' OR NOT (${table.allowedScopeTypes} && ARRAY['platform','reseller']::role_scope_type[])`,
    ),
  ],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
    /**
     * Denormalized from `roles.org_id` (NULL for platform roles) so this table
     * can be RLS-filtered without a join. A BEFORE trigger derives it from the
     * role, so it can never be set to another tenant's value by the writer.
     */
    orgId: uuid('org_id'),
    createdAt: timestamps().createdAt,
  },
  (table) => [
    primaryKey({ name: 'role_permissions_pkey', columns: [table.roleId, table.permissionId] }),
    index('role_permissions_permission_id_idx').on(table.permissionId),
    index('role_permissions_org_id_idx').on(table.orgId),
  ],
);

/**
 * A role grant to a user at a scope.
 *
 * Cross-tenant integrity is guarded twice and neither guard is sufficient alone
 * (`RBAC.md` §6): the application re-derives the ownership chain from the actor's
 * own tenant context before writing, and `fn_validate_user_role_scope` — a
 * BEFORE INSERT/UPDATE trigger installed with this table's migration — refuses
 * the row regardless of which code path attempted it.
 */
export const userRoles = pgTable(
  'user_roles',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * `RESTRICT`, not `CASCADE` (migration `0004`, ADR-005 D-8). Deleting a role
     * must not silently revoke every grant of it: that would be a mass privilege
     * revocation the database performed with no audit row for any individual
     * revocation. Each revocation is an explicit, audited act first.
     */
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    /**
     * The organization this grant lives in; NULL only for platform/reseller
     * scope. Derived and verified by the trigger, never trusted from the writer.
     */
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    scopeType: roleScopeType('scope_type').notNull(),
    /** Polymorphic: an organizations/workspaces/teams/resellers id. */
    scopeId: uuid('scope_id'),
    grantedBy: uuid('granted_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (table) => [
    // Split in two rather than relying on NULLS NOT DISTINCT: a platform grant
    // has no scope_id, and two such grants of the same role to the same user
    // must still collide.
    uniqueIndex('user_roles_unique_scoped_grant')
      .on(table.userId, table.roleId, table.scopeType, table.scopeId)
      .where(sql`${table.scopeId} IS NOT NULL`),
    uniqueIndex('user_roles_unique_platform_grant')
      .on(table.userId, table.roleId, table.scopeType)
      .where(sql`${table.scopeId} IS NULL`),
    index('user_roles_user_id_idx').on(table.userId),
    index('user_roles_role_id_idx').on(table.roleId),
    index('user_roles_org_id_idx').on(table.orgId),
    index('user_roles_scope_idx').on(table.scopeType, table.scopeId),
    /**
     * The organization-membership probe behind `GET /users` (migration `0008`).
     *
     * `users` carries no tenant column, so "the users of this organization" is
     * expressed as `EXISTS (SELECT 1 FROM user_roles WHERE user_id = users.id
     * AND org_id = ?)`. This index makes that an index-only semi-join instead
     * of a scan of every grant in the organization per candidate row.
     */
    index('user_roles_org_user_id_idx').on(table.orgId, table.userId),
    // Keyset pagination for `GET /role-assignments` (migration `0006`).
    index('user_roles_org_created_at_id_idx').on(table.orgId, table.createdAt, table.id),
    index('user_roles_org_scope_type_id_idx').on(table.orgId, table.scopeType, table.id),
    // Platform scope has no scope_id and no org; every other scope has both.
    check(
      'user_roles_scope_shape',
      sql`(${table.scopeType} = 'platform' AND ${table.scopeId} IS NULL AND ${table.orgId} IS NULL)
       OR (${table.scopeType} = 'reseller' AND ${table.scopeId} IS NOT NULL AND ${table.orgId} IS NULL)
       OR (${table.scopeType} IN ('organization','workspace','team') AND ${table.scopeId} IS NOT NULL AND ${table.orgId} IS NOT NULL)`,
    ),
  ],
);

export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type Permission = typeof permissions.$inferSelect;
export type NewPermission = typeof permissions.$inferInsert;
export type RolePermission = typeof rolePermissions.$inferSelect;
export type NewRolePermission = typeof rolePermissions.$inferInsert;
export type UserRole = typeof userRoles.$inferSelect;
export type NewUserRole = typeof userRoles.$inferInsert;
