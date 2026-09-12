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
    check('roles_key_format', sql`${table.key} ~ '^[a-z][a-z0-9_]{2,63}$'`),
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
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('permissions_key_key').on(table.key),
    index('permissions_domain_idx').on(table.domain),
    check('permissions_key_format', sql`${table.key} ~ '^[a-z][a-z0-9_.]*\\.[a-z][a-z0-9_]*$'`),
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
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
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
