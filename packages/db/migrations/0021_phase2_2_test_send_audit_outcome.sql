-- =============================================================================
-- Phase 2.2 Gate D.2 remediation — a test-send's audit outcome tells the truth
--
-- `provider.test_sent` is written with the audit trail's established outcome
-- semantics: `success` when the provider accepted the submission, `failure`
-- when it rejected it (5xx, 429, timeout, credential or request rejection, or an
-- adapter error) — the operation was authorized and attempted but did not
-- achieve its purpose, exactly as `auth.login.failed` is `failure`. `denied`
-- remains reserved for authorization refusals, written by `AuthorizationService`.
--
-- `audit_logs_provider_test_send_insert` (migration `0020`, not edited) admitted
-- `success` only. It is replaced by the same policy admitting `success` or
-- `failure`, and nothing else; every other predicate is unchanged.
-- =============================================================================

ALTER POLICY audit_logs_provider_test_send_insert ON audit_logs
  WITH CHECK (
    scope_type = 'platform'
    AND scope_id IS NULL
    AND actor_type = 'user'
    AND actor_user_id = app_current_user_id()
    AND outcome IN ('success', 'failure')
    AND resource_type = 'Provider'
    AND action = 'provider.test_sent'
    AND app_has_platform_permission('providers.test_send')
  );
