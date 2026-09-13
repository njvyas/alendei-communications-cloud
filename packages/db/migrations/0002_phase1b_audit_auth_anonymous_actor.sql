-- =============================================================================
-- Phase 1B — the anonymous login-failure audit actor (ADR-003 R4)
--
-- A login attempt for an address matching no user has no identity to name. It
-- must still be audited: omitting it would leave credential-stuffing invisible,
-- and inventing an `actor_user_id` would put a fictitious identity into an
-- append-only record that can never be corrected in place.
--
-- `audit_logs_actor_shape` already accepts the row (a `system` actor carries
-- neither id column and may carry a label), so no table constraint changes here.
-- The only thing refusing it is the acc_auth INSERT policy, which this migration
-- replaces.
--
-- The exception is deliberately as narrow as it can be expressed: `system` is
-- admitted ONLY together with exactly `auth.login.failed` and exactly the
-- label `anonymous_login_attempt`. It is not a general system-actor bypass — a
-- role able to write any `system` row could fabricate a record of automated
-- action that never occurred (SECURITY.md §4, DATABASE.md §2a).
--
-- Everything already permitted stays permitted, unchanged: platform scope, the
-- `app_is_auth_audit_action()` vocabulary, and `user`/`api_key` actors.
-- =============================================================================

DROP POLICY audit_logs_auth_insert ON audit_logs;
--> statement-breakpoint

CREATE POLICY audit_logs_auth_insert ON audit_logs FOR INSERT TO acc_auth
  WITH CHECK (
    -- Unchanged from 0001: acc_auth writes pre-tenant events only, and only
    -- from the authentication vocabulary. Both terms still gate every branch
    -- below, so no scope other than platform is reachable by this role.
    scope_type = 'platform'
    AND app_is_auth_audit_action(action)
    AND (
      actor_type IN ('user', 'api_key')
      OR (
        actor_type = 'system'
        AND action = 'auth.login.failed'
        AND actor_label = 'anonymous_login_attempt'
      )
    )
  );
