-- =============================================================================
-- Phase 1C.2 — session audit actions in the acc_auth vocabulary (ADR-012 F-10,
-- F-11; Gate C review, 1C.2 Option A)
--
-- Corrects a Phase 1B defect. `DELETE /auth/sessions/:id` (Phase 1B.3) revokes
-- the caller's own session as acc_auth and records `session.revoked` in the same
-- transaction, but `app_is_auth_audit_action()` never admitted that action, so
-- `audit_logs_auth_insert` refused the row and the whole revocation rolled back
-- with a 500. The same routing is required by F-11 (each eviction writes
-- `session.revoked` inside the login transaction) and F-10 (self revoke-all
-- writes `session.revoked_all`), both of which run before any tenant context
-- exists.
--
-- Exactly two actions are added. Nothing else changes:
--   - `audit_logs_auth_insert` is untouched, so acc_auth is still confined to
--     `scope_type = 'platform'`, to user/api_key actors (plus the anonymous
--     login-failure shape), and to this explicit allowlist;
--   - no grant changes; acc_auth still has INSERT only, and cannot read or
--     alter audit rows;
--   - acc_app's policies are untouched.
-- Atomicity is enforced by the application (AuditWriter refuses to write these
-- two actions without the caller's transaction) and proven by the 1C.2 suite.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_is_auth_audit_action(target_action text) RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
  SELECT target_action IN (
    'auth.login.succeeded',
    'auth.login.failed',
    'auth.logout',
    'auth.token.refreshed',
    'api_key.authenticated',
    'session.revoked',
    'session.revoked_all'
  );
$$;
