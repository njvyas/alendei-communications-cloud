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
  /**
   * The authenticated API key, for API-key principals only (ADR-015 R-7,
   * ADR-014 §17.1). Read solely by `app_content_context_valid()` (migration
   * `0027`), which honours it only while it names an unrevoked, unexpired key
   * of the organization in context. Empty for every other principal.
   */
  API_KEY_ID: 'app.current_api_key_id',
} as const;

/** The seeded reseller that organizations without an external reseller belong to. */
export const PLATFORM_DEFAULT_RESELLER_SLUG = 'alendei-direct';

/**
 * The advisory-lock key serialising every mutation that could remove the last
 * active platform administrator (ADR-005 D-7, migration `0005`).
 *
 * The value is arbitrary; that it is a **single shared constant** is not. The
 * invariant is "at least one row exists", which no per-row constraint can
 * express and which an application count cannot hold under `READ COMMITTED` —
 * two transactions each counting two admins, each removing a different one, and
 * both committing is textbook write skew. `pg_advisory_xact_lock` serialises
 * exactly the three mutators of this invariant and releases on commit *and*
 * rollback, the same property that makes `SET LOCAL` safe.
 *
 * A second key would silently disable the guarantee, which is why this is
 * exported rather than written at each call site: `fn_assert_platform_admin_remains`
 * and `RoleAssignmentService` must take the same one.
 */
export const PLATFORM_ADMIN_LOCK_KEY = 4_820_193_077n;

/**
 * The advisory-lock class serialising every mutation that could remove the
 * last active administrator of one organization (ADR-015 R-11, D-MEDIUM-3b,
 * migration `0028`).
 *
 * Used in PostgreSQL's two-`int4` form,
 * `pg_advisory_xact_lock(ORG_ADMIN_LOCK_CLASS, hashtext(org_id::text))`: one
 * lock per organization, so administration of different organizations never
 * contends, in a keyspace PostgreSQL keeps apart from every one-`bigint` lock
 * (`pg_locks.objsubid` 2 versus 1) — it cannot collide with
 * `PLATFORM_ADMIN_LOCK_KEY`. As for that key, a second value would silently
 * disable the guarantee: `fn_assert_org_admin_remains` and the services must
 * take the same one, and the suite asserts they do.
 */
export const ORG_ADMIN_LOCK_CLASS = 482_019_308;

/**
 * The advisory-lock class serialising every mutation that could remove the
 * last active administrator of one reseller (ADR-015 follow-up item 4,
 * migration `0030`).
 *
 * Used exactly as `ORG_ADMIN_LOCK_CLASS` is — the two-`int4` form,
 * `pg_advisory_xact_lock(RESELLER_ADMIN_LOCK_CLASS, hashtext(reseller_id::text))`,
 * one lock per reseller — with a class of its own, so a reseller's lock never
 * contends with an organization's even when the two hash alike, and it cannot
 * collide with the one-`bigint` `PLATFORM_ADMIN_LOCK_KEY`.
 * `fn_assert_reseller_admin_remains` and the services must take the same one,
 * and the suite asserts they do.
 */
export const RESELLER_ADMIN_LOCK_CLASS = 482_019_309;
