import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  inet,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryId, timestamps, tstz } from './_shared';
import { organizations, workspaces } from './tenancy';

/**
 * IAM domain (`DATABASE.md` §2, `RBAC.md` §5).
 *
 * No table here ever stores credential material in plaintext: passwords, API key
 * secrets, refresh tokens and WebSocket tickets are all stored as hashes only
 * (`SECURITY.md` §1).
 */

export const userStatus = pgEnum('user_status', ['active', 'invited', 'disabled']);

export const users = pgTable(
  'users',
  {
    id: primaryId(),
    email: text('email').notNull(),
    phone: text('phone'),
    /** Argon2id hash. Null for SSO-only users, who have no password at all. */
    passwordHash: text('password_hash'),
    passwordUpdatedAt: tstz('password_updated_at'),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    /** Pointer into the secrets backend — never the TOTP seed (`SECURITY.md` §3). */
    mfaSecretRef: text('mfa_secret_ref'),
    status: userStatus('status').notNull().default('invited'),
    lastLoginAt: tstz('last_login_at'),
    ...timestamps(),
  },
  (table) => [
    // Case-insensitive uniqueness: nobody registers `A@x.com` beside `a@x.com`.
    uniqueIndex('users_email_key').on(sql`lower(${table.email})`),
    check(
      'users_email_format',
      sql`${table.email} ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$'`,
    ),
    check(
      'users_active_requires_credential',
      sql`${table.status} <> 'active' OR ${table.passwordHash} IS NOT NULL OR ${table.mfaSecretRef} IS NOT NULL`,
    ),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: primaryId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the opaque refresh token. The token itself is never stored. */
    refreshTokenHash: text('refresh_token_hash').notNull(),
    deviceInfo: jsonb('device_info')
      .notNull()
      .default(sql`'{}'::jsonb`),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    lastUsedAt: tstz('last_used_at'),
    revokedAt: tstz('revoked_at'),
    revokedReason: text('revoked_reason'),
    expiresAt: tstz('expires_at').notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('sessions_refresh_token_hash_key').on(table.refreshTokenHash),
    index('sessions_user_id_idx').on(table.userId),
    // The index the "active sessions for this user" lookup and the expiry
    // sweeper both scan.
    index('sessions_active_idx')
      .on(table.userId, table.expiresAt)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: primaryId(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /**
     * Public, non-secret identifier embedded in the presented key
     * (`ak_live_<prefix>.<secret>`). Looked up by this, then the secret half is
     * verified against `key_hash` — so verification never scans every row.
     */
    keyPrefix: text('key_prefix').notNull(),
    /** Argon2id hash of the secret half. Never reversible, never logged. */
    keyHash: text('key_hash').notNull(),
    /** Permission-key subset this key may exercise (`DATABASE.md` §2). */
    scopes: jsonb('scopes')
      .notNull()
      .default(sql`'[]'::jsonb`),
    lastUsedAt: tstz('last_used_at'),
    expiresAt: tstz('expires_at'),
    revokedAt: tstz('revoked_at'),
    revokedReason: text('revoked_reason'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('api_keys_key_prefix_key').on(table.keyPrefix),
    index('api_keys_org_id_idx').on(table.orgId),
    // Referenced by `audit_logs_actor_api_key_org_fk` so an API-key actor can
    // never be recorded against an organization the key does not belong to
    // (`TENANCY.md` §1a.3, ADR-002).
    unique('api_keys_id_org_id_key').on(table.id, table.orgId),
    check('api_keys_scopes_is_array', sql`jsonb_typeof(${table.scopes}) = 'array'`),
    check('api_keys_prefix_shape', sql`${table.keyPrefix} ~ '^ak_(live|test)_[A-Za-z0-9]{16}$'`),
  ],
);

/**
 * Single-use WebSocket connection tickets (`API.md` §9, `DATABASE.md` §2).
 *
 * The ticket presented by the client is a random opaque string; only its SHA-256
 * is stored, so a database read cannot yield a usable ticket. The connection's
 * tenant context comes from this row, never from anything the socket sends.
 */
export const wsTickets = pgTable(
  'ws_tickets',
  {
    id: primaryId(),
    ticketHash: text('ticket_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'restrict' }),
    /** Topics this ticket admits subscription to; never widened after issue. */
    scope: jsonb('scope')
      .notNull()
      .default(sql`'[]'::jsonb`),
    issuedAt: tstz('issued_at').notNull().defaultNow(),
    expiresAt: tstz('expires_at').notNull(),
    consumedAt: tstz('consumed_at'),
    consumedIp: inet('consumed_ip'),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('ws_tickets_ticket_hash_key').on(table.ticketHash),
    index('ws_tickets_org_id_idx').on(table.orgId),
    index('ws_tickets_expires_at_idx').on(table.expiresAt),
    check('ws_tickets_scope_is_array', sql`jsonb_typeof(${table.scope}) = 'array'`),
    check('ws_tickets_ttl_positive', sql`${table.expiresAt} > ${table.issuedAt}`),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type WsTicket = typeof wsTickets.$inferSelect;
export type NewWsTicket = typeof wsTickets.$inferInsert;
