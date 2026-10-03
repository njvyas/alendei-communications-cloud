-- =============================================================================
-- Phase 2.2 — provider test-send audit (ADR-013 F-4, ROADMAP §5b 2.2)
--
-- `POST /providers/:id/test-send` records `provider.test_sent` at platform scope.
-- It is admitted under exactly the eligibility model migration `0019` set for
-- every catalogue write and its audit record — an active user holding a
-- platform-scope grant whose role carries the permission — with the permission
-- that route requires, `providers.test_send`. No role is named; no new function
-- is added (`app_has_platform_permission` from `0019` is reused).
--
-- `audit_logs_provider_insert` (`0019`) is not widened: test-send is a different
-- permission, so it gets its own exact-shape policy. Nothing else changes.
-- =============================================================================

CREATE POLICY audit_logs_provider_test_send_insert ON audit_logs FOR INSERT TO acc_app
  WITH CHECK (
    scope_type = 'platform'
    AND scope_id IS NULL
    AND actor_type = 'user'
    AND actor_user_id = app_current_user_id()
    AND outcome = 'success'
    AND resource_type = 'Provider'
    AND action = 'provider.test_sent'
    AND app_has_platform_permission('providers.test_send')
  );
