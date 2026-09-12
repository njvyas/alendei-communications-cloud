/** Database principals created by the Phase 1 migration. */
export const DB_ROLES = {
  /** Tenant-scoped business access; every statement is RLS-filtered. */
  APP: 'acc_app',
  /** Identity resolution only — runs before any tenant context exists. */
  AUTH: 'acc_auth',
  /** Transactional-outbox publisher; cross-tenant by necessity. */
  RELAY: 'acc_relay',
} as const;

/**
 * Transaction-local session variables carrying tenant context
 * (`TENANCY.md` §§3, 5; `DATABASE.md` §14a).
 *
 * These are always set with `set_config(..., is_local => true)`, which resets at
 * transaction end. Connection-level `SET` is never used for any of them.
 */
export const SESSION_VARS = {
  ORG_ID: 'app.current_org_id',
  WORKSPACE_ID: 'app.current_workspace_id',
  RESELLER_ID: 'app.current_reseller_id',
  USER_ID: 'app.current_user_id',
  IS_PLATFORM_ADMIN: 'app.is_platform_admin',
  PROVISIONING: 'app.provisioning',
} as const;

/** The seeded reseller that organizations without an external reseller belong to. */
export const PLATFORM_DEFAULT_RESELLER_SLUG = 'alendei-direct';
