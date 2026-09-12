import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  inet,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, tstz } from './_shared';
import { apiKeys, users } from './iam';
import { roleScopeType } from './rbac';
import { organizations, resellers, teams, workspaces } from './tenancy';

/**
 * Immutable audit log (`DATABASE.md` §12, `SECURITY.md` §4, ADR-002).
 *
 * Append-only: no principal holds UPDATE or DELETE, and `fn_audit_logs_append_only`
 * refuses UPDATE, DELETE and TRUNCATE for every principal. A correction is a new
 * row, never an edit. The one capability that remains is the table owner's
 * ability to drop or disable that trigger — a deliberately acknowledged limit,
 * not a claim of absolute tamper-proofing (`SECURITY.md` §4a).
 *
 * Security-sensitive actions are written synchronously — the triggering request
 * fails if its audit row cannot be written — so a role grant can never succeed
 * without leaving a record.
 */
export const auditActorType = pgEnum('audit_actor_type', [
  'user',
  'api_key',
  'oauth_client',
  'system',
]);

export const auditOutcome = pgEnum('audit_outcome', ['success', 'failure', 'denied']);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: primaryId(),

    /**
     * The scope at which the action occurred, on the canonical five-level
     * hierarchy (`TENANCY.md` §1a, ADR-002). This is the same enum
     * `user_roles.scope_type` uses, deliberately: the scope an action happened
     * at and the scope a grant applies at are the same axis.
     */
    scopeType: roleScopeType('scope_type').notNull(),
    /**
     * The row named by `scope_type`. NULL only for `platform`, which has no row.
     * Supplied by the writer; every denormalized column below is DERIVED from it
     * by `fn_validate_audit_scope`, never trusted from the writer.
     */
    scopeId: uuid('scope_id'),

    /** Derived. Populated only for `scope_type='reseller'`. */
    resellerId: uuid('reseller_id').references(() => resellers.id, { onDelete: 'restrict' }),
    /**
     * Derived. NULL for `platform` and `reseller` scope; the owning organization
     * for `organization`, `workspace` and `team` scope. This is the column every
     * RLS policy resolves tenancy through (`TENANCY.md` §3a).
     */
    orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'restrict' }),
    /** Derived. Populated for `workspace` and `team` scope. */
    workspaceId: uuid('workspace_id'),
    /** Derived. Populated for `team` scope only. */
    teamId: uuid('team_id'),

    actorType: auditActorType('actor_type').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    actorApiKeyId: uuid('actor_api_key_id'),
    /**
     * Human-readable actor label. Required for `oauth_client`, which has no id
     * column until OAuth2 ships (`DECISIONS.md` D6), and useful everywhere else
     * as a record of how the actor presented at the time.
     */
    actorLabel: text('actor_label'),

    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id'),
    /**
     * `denied` is recorded as deliberately as `success`: a refused privilege
     * escalation is exactly the event worth having a record of (`RBAC.md` §7).
     */
    outcome: auditOutcome('outcome').notNull(),

    before: jsonb('before'),
    after: jsonb('after'),
    /** Never carries credential material (`SECURITY.md` §2). */
    metadata: jsonb('metadata')
      .notNull()
      .default(sql`'{}'::jsonb`),

    /**
     * The end-to-end trace identifier shared by every log line, event, ledger
     * entry and audit row produced by one originating request or job
     * (`OBSERVABILITY.md` §2, `TESTING.md` §6). Constant along a causal chain.
     */
    correlationId: uuid('correlation_id').notNull(),
    /**
     * The immediate cause of this action — the id of the request or event that
     * triggered it (`EVENTS.md` §2). Unlike `correlation_id` it changes at every
     * hop, which is what lets a chain be ordered rather than merely grouped.
     * NULL when this action originated the chain.
     */
    causationId: uuid('causation_id'),

    ip: inet('ip'),
    userAgent: text('user_agent'),

    occurredAt: tstz('occurred_at').notNull().defaultNow(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (table) => [
    // Parent-child integrity, mirroring `teams_workspace_org_fk`: a workspace or
    // team whose organization disagrees with `org_id` is unrepresentable, not
    // merely rejected by application code (`TENANCY.md` §1a.3).
    foreignKey({
      name: 'audit_logs_workspace_org_fk',
      columns: [table.workspaceId, table.orgId],
      foreignColumns: [workspaces.id, workspaces.orgId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'audit_logs_team_org_fk',
      columns: [table.teamId, table.orgId],
      foreignColumns: [teams.id, teams.orgId],
    }).onDelete('restrict'),
    // An API-key actor recorded against an organization must actually belong to
    // it. MATCH SIMPLE means this is inert when `org_id` is NULL (a platform-scope
    // row, e.g. `api_key.authenticated` before tenant context exists), where the
    // single-column reference below still proves the key exists.
    foreignKey({
      name: 'audit_logs_actor_api_key_org_fk',
      columns: [table.actorApiKeyId, table.orgId],
      foreignColumns: [apiKeys.id, apiKeys.orgId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'audit_logs_actor_api_key_id_fk',
      columns: [table.actorApiKeyId],
      foreignColumns: [apiKeys.id],
    }).onDelete('restrict'),

    /**
     * The shape of each scope level, mirroring `user_roles_scope_shape`. The
     * trigger derives these columns, so this constraint is the invariant that
     * holds even if the trigger is ever changed incorrectly.
     */
    check(
      'audit_logs_scope_shape',
      sql`(${table.scopeType} = 'platform' AND ${table.scopeId} IS NULL AND ${table.resellerId} IS NULL AND ${table.orgId} IS NULL AND ${table.workspaceId} IS NULL AND ${table.teamId} IS NULL)
       OR (${table.scopeType} = 'reseller' AND ${table.scopeId} IS NOT NULL AND ${table.resellerId} = ${table.scopeId} AND ${table.orgId} IS NULL AND ${table.workspaceId} IS NULL AND ${table.teamId} IS NULL)
       OR (${table.scopeType} = 'organization' AND ${table.scopeId} IS NOT NULL AND ${table.resellerId} IS NULL AND ${table.orgId} = ${table.scopeId} AND ${table.workspaceId} IS NULL AND ${table.teamId} IS NULL)
       OR (${table.scopeType} = 'workspace' AND ${table.scopeId} IS NOT NULL AND ${table.resellerId} IS NULL AND ${table.orgId} IS NOT NULL AND ${table.workspaceId} = ${table.scopeId} AND ${table.teamId} IS NULL)
       OR (${table.scopeType} = 'team' AND ${table.scopeId} IS NOT NULL AND ${table.resellerId} IS NULL AND ${table.orgId} IS NOT NULL AND ${table.workspaceId} IS NOT NULL AND ${table.teamId} = ${table.scopeId})`,
    ),
    /**
     * An actor identifier that contradicts `actor_type` is unrepresentable: a
     * `user` row cannot carry an API-key id, and a `system` row cannot claim
     * either. `oauth_client` has no id column yet (`DECISIONS.md` D6), so it must
     * at least name itself.
     */
    check(
      'audit_logs_actor_shape',
      sql`(${table.actorType} = 'user' AND ${table.actorUserId} IS NOT NULL AND ${table.actorApiKeyId} IS NULL)
       OR (${table.actorType} = 'api_key' AND ${table.actorApiKeyId} IS NOT NULL AND ${table.actorUserId} IS NULL)
       OR (${table.actorType} = 'oauth_client' AND ${table.actorUserId} IS NULL AND ${table.actorApiKeyId} IS NULL AND ${table.actorLabel} IS NOT NULL)
       OR (${table.actorType} = 'system' AND ${table.actorUserId} IS NULL AND ${table.actorApiKeyId} IS NULL)`,
    ),

    index('audit_logs_org_occurred_idx').on(table.orgId, table.occurredAt.desc()),
    index('audit_logs_scope_idx').on(table.scopeType, table.scopeId, table.occurredAt.desc()),
    index('audit_logs_correlation_idx').on(table.correlationId),
    index('audit_logs_causation_idx')
      .on(table.causationId)
      .where(sql`${table.causationId} IS NOT NULL`),
    index('audit_logs_actor_idx').on(table.actorUserId, table.occurredAt.desc()),
    index('audit_logs_action_idx').on(table.action, table.occurredAt.desc()),
    index('audit_logs_resource_idx').on(table.resourceType, table.resourceId),
    index('audit_logs_reseller_idx')
      .on(table.resellerId, table.occurredAt.desc())
      .where(sql`${table.resellerId} IS NOT NULL`),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
