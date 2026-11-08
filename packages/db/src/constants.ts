/** Database principals created by the Phase 1 migration. */
export const DB_ROLES = {
  /** Tenant-scoped business access; every statement is RLS-filtered. */
  APP: 'acc_app',
  /** Identity resolution only — runs before any tenant context exists. */
  AUTH: 'acc_auth',
  /** Transactional-outbox publisher; cross-tenant by necessity. */
  RELAY: 'acc_relay',
  /** Dedicated message dispatcher principal (Phase 3.2, ADR-014 §9.2). */
  DISPATCH: 'acc_dispatch',
  /** Delivery-receipt ingestion principal (Phase 5.0, migration 0044; design spec Rev 2 §C.2a). */
  DELIVERY: 'acc_delivery',
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

/**
 * Transaction-local session variables carrying dispatch context (Phase 3.2, ADR-014 §9.1–§9.2).
 */
export const DISPATCH_SESSION_VARS = {
  /** The message currently claimed by the dispatcher (Phase 3.2, ADR-014 §9.1). */
  MESSAGE_ID: 'app.dispatch_message_id',
  /** The claim token for the claimed message (Phase 3.2, ADR-014 §9.1). */
  CLAIM_TOKEN: 'app.dispatch_claim_token',
} as const;

/**
 * Phase 5.0: transaction-local context of the delivery-receipt principal
 * (`acc_delivery`, migration 0044). The provider comes from the resolved ingress
 * key, the message from the resolved attempt — never from the request payload.
 */
export const DELIVERY_SESSION_VARS = {
  PROVIDER_ID: 'app.delivery_provider_id',
  MESSAGE_ID: 'app.delivery_message_id',
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

/**
 * The advisory-lock class serialising organization lifecycle status changes
 * against dispatch worker claims (ADR-014 §12, D29, Phase 3.3).
 *
 * Used in the two-int4 form:
 * `pg_advisory_xact_lock(ORG_LIFECYCLE_LOCK_CLASS, hashtext(org_id::text))` (exclusive on status change)
 * `pg_advisory_xact_lock_shared(ORG_LIFECYCLE_LOCK_CLASS, hashtext(org_id::text))` (shared during dispatch claim)
 */
export const ORG_LIFECYCLE_LOCK_CLASS = 482_019_310;

/**
 * The advisory-lock class serialising creation of `usage_ledger` partitions
 * (Phase 7 PR 7-1, migration `0050`, `DECISIONS.md` §1zi OD-7-3).
 *
 * Taken by `app_ledger_ensure_partitions` in the two-int4 form
 * `pg_advisory_xact_lock(LEDGER_PARTITION_LOCK_CLASS, 0)`: one lock for the whole
 * ledger, so concurrent callers (migrate, API startup, the operator command)
 * create each month exactly once. The migration hard-codes the same value.
 */
export const LEDGER_PARTITION_LOCK_CLASS = 482_019_311;

/**
 * The session-level advisory-lock key serialising every schema migration and
 * every out-of-transaction schema maintenance step (U14.1a, ADR-015-adjacent
 * decision record "U14.1a").
 *
 * Unlike the keys above it is taken with `pg_try_advisory_lock` (session scope),
 * not `pg_advisory_xact_lock`: `db:migrate` must hold it across several
 * transactions *and* across `CREATE INDEX CONCURRENTLY`, which cannot run in a
 * transaction at all. It is held by one pinned connection for the whole run and
 * released explicitly, or by the server when that session ends. `db:migrate` and
 * the concurrent-index runner take the same key, so neither can overlap the other.
 */
export const MIGRATION_LOCK_KEY = 4_820_193_142n;
