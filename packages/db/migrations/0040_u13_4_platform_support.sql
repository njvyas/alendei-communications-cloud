-- =============================================================================
-- Migration: 0040_u13_4_platform_support
-- Issue: Phase 4 U13.4 Platform Operational Support & Troubleshooting
--
-- 1. Catalogue: permission `platform.support.read` (platform class, platform
--    scope only), granted to `alendei_super_admin` and `alendei_support`.
--
-- 2. audit_logs: a cross-tenant SELECT policy for `platform.support.read`
--    holders with no organization selected, and an INSERT policy admitting
--    exactly their own `platform.support.diagnostic_read` success rows.
--
-- 3. app_platform_support_dispatch_diagnostics(): dispatch troubleshooting
--    metadata for one organization.
--
-- --- The Model B boundary (ADR-015 R-7, R-8) is NOT amended -----------------
-- Support has no path to tenant content: `app_content_context_valid()` still
-- has no platform or support arm, and no content-table policy is added or
-- changed. The dispatch function is SECURITY DEFINER (it reads `messages`,
-- `message_attempts` and `message_dispatch_queue` as their owner), so its
-- result shape IS the boundary, enforced here in the database and not by the
-- application. It returns operational metadata only:
--   - identifiers, channel codes, statuses, attempt numbers, latencies and
--     timestamps;
--   - a failure CODE from a fixed allowlist (app_support_failure_code), never
--     the stored failure text: provider error strings are free text
--     (ProviderFailure.message) and may echo recipients, payload fragments or
--     credential errors, so no part of them leaves the function;
--   - never `recipient_address`, `payload`, a template, contact or any other
--     message-derived value.
-- =============================================================================

INSERT INTO permissions (key, domain, action, description, classification, allowed_scope_types)
VALUES (
  'platform.support.read',
  'platform.support',
  'read',
  'Cross-tenant read access for platform support: configuration inspection, routing diagnostics, dispatch metadata and audit search',
  'platform',
  '{platform}'
)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

-- The system-role guard (0004) refuses changes to a system role's permissions
-- outside a provisioning or platform-admin transaction, for every writer
-- including the owner; attached exactly as 0018 and 0026 attach theirs.
SELECT set_config('app.provisioning', 'on', true);
--> statement-breakpoint

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.org_id IS NULL
  AND r.key IN ('alendei_super_admin', 'alendei_support')
  AND p.key = 'platform.support.read'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- --- audit_logs: cross-tenant read for platform support ------------------------
-- Only with no organization selected (an organization-scoped search is governed
-- by audit_logs_select, exactly like a member's). Each check is a scalar
-- sub-select, evaluated once per statement as an InitPlan, never per row (0027).
CREATE POLICY audit_logs_platform_support_read ON audit_logs FOR SELECT TO acc_app
  USING (
    (SELECT app_current_user_id()) IS NOT NULL
    AND (SELECT app_current_org_id()) IS NULL
    AND (SELECT app_has_platform_permission('platform.support.read'))
  );
--> statement-breakpoint

-- --- audit_logs: the diagnostic-read record ------------------------------------
-- Admits exactly the current user's own success row for the one support action,
-- at platform or organization scope. Every other row is still governed by the
-- existing insert policies.
CREATE POLICY audit_logs_platform_support_insert ON audit_logs FOR INSERT TO acc_app
  WITH CHECK (
    actor_type = 'user'
    AND actor_user_id = (SELECT app_current_user_id())
    AND outcome = 'success'
    AND resource_type = 'platform_support'
    AND action = 'platform.support.diagnostic_read'
    AND scope_type IN ('platform', 'organization')
    AND (SELECT app_has_platform_permission('platform.support.read'))
  );
--> statement-breakpoint

-- --- Fixed failure codes --------------------------------------------------------
-- Maps a stored failure reason to a code from a closed list, or 'OTHER'. The
-- leading token is read with the established convention (message usage report:
-- `^[A-Z][A-Z0-9_]{2,63}` followed by end, ':' or whitespace) and admitted only
-- if it is in the allowlist below; the exact platform-authored sentences the
-- dispatcher writes are mapped to codes; anything else — any provider text — is
-- 'OTHER'. The list mirrors PLATFORM_SUPPORT_FAILURE_CODES in @acc/contracts
-- (platform-support.ts); the database tests hold the two together.
CREATE FUNCTION app_support_failure_code(p_reason text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN p_reason IS NULL THEN NULL
    WHEN p_reason = 'Organization is closed' THEN 'ORGANIZATION_CLOSED'
    WHEN p_reason = 'Organization was suspended before provider submission' THEN 'ORGANIZATION_SUSPENDED'
    WHEN p_reason = 'No active provider assignment for channel' THEN 'NO_PROVIDER_ASSIGNMENT'
    WHEN p_reason = 'Dispatch lease expired during external submission (outcome_unknown)' THEN 'DISPATCH_LEASE_EXPIRED'
    WHEN substring(p_reason from '^([A-Z][A-Z0-9_]{2,63})(?:$|[:[:space:]])') = ANY (ARRAY[
      -- ProviderFailureCategory (@acc/contracts provider-adapter.ts)
      'TIMEOUT', 'PROVIDER_ERROR', 'RATE_LIMITED', 'AUTH_ERROR', 'INVALID_REQUEST',
      'INVALID_RECIPIENT', 'UNSUPPORTED_CONTENT', 'CONFIGURATION_ERROR', 'UNKNOWN',
      -- dispatcher codes (dispatcher.service.ts, submission-mapping.ts, 0037)
      'NO_ELIGIBLE_PROVIDER', 'CHANNEL_UNSUPPORTED', 'SMS_PAYLOAD_INVALID',
      'RCS_PAYLOAD_INVALID', 'RECIPIENT_SUPPRESSED', 'CONSENT_REVOKED'
    ]) THEN substring(p_reason from '^([A-Z][A-Z0-9_]{2,63})(?:$|[:[:space:]])')
    ELSE 'OTHER'
  END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_support_failure_code(text) FROM PUBLIC;
--> statement-breakpoint

-- --- Dispatch diagnostics -------------------------------------------------------
-- Refuses unless the transaction's user is an active holder of
-- `platform.support.read` at platform scope (app_has_platform_permission:
-- re-read live; a forged app.is_platform_admin or a missing user is refused).
-- p_limit is clamped to 1..50 here, independently of the API's validation.
--
-- Queue counts come from message_dispatch_queue — content-free (R-10) and
-- holding only in-flight messages — not from a count over all of the
-- organization's messages:
--   pendingCount  ready to claim (available, not under a live claim)
--   delayedCount  waiting for a retry/backoff time (available_at in the future)
--   claimedCount  under a live dispatcher claim
CREATE FUNCTION app_platform_support_dispatch_diagnostics(
  p_org_id uuid,
  p_channel text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_limit integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_queue jsonb;
  v_recent jsonb;
BEGIN
  IF app_current_user_id() IS NULL
     OR NOT app_has_platform_permission('platform.support.read') THEN
    RAISE EXCEPTION 'insufficient privilege for platform support diagnostics'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT jsonb_build_object(
    'pendingCount', count(*) FILTER (
      WHERE q.available_at <= now() AND (q.claimed_until IS NULL OR q.claimed_until <= now())),
    'delayedCount', count(*) FILTER (
      WHERE q.available_at > now() AND (q.claimed_until IS NULL OR q.claimed_until <= now())),
    'claimedCount', count(*) FILTER (WHERE q.claimed_until > now())
  )
  INTO v_queue
  FROM message_dispatch_queue q
  WHERE q.org_id = p_org_id;

  SELECT coalesce(jsonb_agg(item ORDER BY created_at DESC, message_id DESC), '[]'::jsonb)
  INTO v_recent
  FROM (
    SELECT
      m.id AS message_id,
      m.created_at,
      jsonb_build_object(
        'messageId', m.id,
        'channel', c.code::text,
        'status', m.status::text,
        'failureCode', app_support_failure_code(m.failure_reason),
        'createdAt', m.created_at,
        'updatedAt', m.updated_at,
        'completedAt', m.completed_at,
        'attempts', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
                   'attemptNumber', a.attempt_number,
                   'providerId', a.provider_id,
                   'adapterKey', p.adapter_key,
                   'status', a.status::text,
                   'failureCode', app_support_failure_code(a.failure_reason),
                   'latencyMs', a.latency_ms,
                   'attemptedAt', a.created_at
                 ) ORDER BY a.attempt_number)
          FROM message_attempts a
          JOIN providers p ON p.id = a.provider_id
          WHERE a.message_id = m.id
        ), '[]'::jsonb)
      ) AS item
    FROM messages m
    JOIN channels c ON c.id = m.channel_id
    WHERE m.org_id = p_org_id
      AND (p_channel IS NULL OR c.code::text = p_channel)
      AND (
        (p_status IS NOT NULL AND m.status::text = p_status)
        OR (p_status IS NULL
            AND m.status::text IN ('failed', 'queued', 'routing', 'submitting', 'outcome_unknown'))
      )
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT v_limit
  ) recent;

  RETURN jsonb_build_object('queue', v_queue, 'recentMessages', v_recent);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_platform_support_dispatch_diagnostics(uuid, text, text, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_platform_support_dispatch_diagnostics(uuid, text, text, integer) TO acc_app;
