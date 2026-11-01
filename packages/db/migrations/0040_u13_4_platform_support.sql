-- =============================================================================
-- Migration: 0040_u13_4_platform_support
-- Issue: Phase 4 U13.4 Platform Operational Support & Troubleshooting
--
-- 1. Inserts permission `platform.support.read` into permissions:
--    - domain: 'platform.support'
--    - action: 'read'
--    - classification: 'platform'
--    - allowed_scope_types: '{platform}'
--
-- 2. Grants `platform.support.read` to `alendei_super_admin` and `alendei_support`.
--
-- 3. Adds RLS policy on `audit_logs` for SELECT to acc_app:
--    - Admits cross-tenant audit search when app_current_org_id() IS NULL
--      for active users holding `platform.support.read` or `platform.audit.read`
--      through a platform-scope role.
--
-- 4. Adds RLS policy on `audit_logs` for INSERT to acc_app:
--    - Admits recording `platform.support.diagnostic_read` audit entries.
--
-- 5. Adds SECURITY DEFINER function `app_platform_support_dispatch_diagnostics`:
--    - Safely returns message queue stats and recent failure diagnostic metadata
--      for a specific organization, without exposing message content or weakening
--      registered content-table RLS (ADR-015).
-- =============================================================================

INSERT INTO permissions (key, domain, action, description, classification, allowed_scope_types)
VALUES (
  'platform.support.read',
  'platform.support',
  'read',
  'Cross-tenant read access for platform support, routing diagnostics, configuration inspection, and dispatch troubleshooting',
  'platform',
  '{platform}'
)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
SELECT set_config('app.provisioning', 'on', true);
--> statement-breakpoint

-- Grant to alendei_super_admin
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.org_id IS NULL
  AND r.key = 'alendei_super_admin'
  AND p.key = 'platform.support.read'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Grant to alendei_support
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.org_id IS NULL
  AND r.key = 'alendei_support'
  AND p.key = 'platform.support.read'
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Audit logs cross-tenant support read policy (active only when not scoped to a specific tenant)
DROP POLICY IF EXISTS "audit_logs_platform_support_read" ON "audit_logs";--> statement-breakpoint
CREATE POLICY "audit_logs_platform_support_read" ON "audit_logs" FOR SELECT TO acc_app
  USING (
    app_current_user_id() IS NOT NULL
    AND app_current_org_id() IS NULL
    AND (
      app_has_platform_permission('platform.support.read')
      OR app_has_platform_permission('platform.audit.read')
    )
  );
--> statement-breakpoint

-- Audit logs support diagnostic activity insert policy
DROP POLICY IF EXISTS "audit_logs_platform_support_insert" ON "audit_logs";--> statement-breakpoint
CREATE POLICY "audit_logs_platform_support_insert" ON "audit_logs" FOR INSERT TO acc_app
  WITH CHECK (
    actor_type = 'user'
    AND actor_user_id = app_current_user_id()
    AND outcome = 'success'
    AND resource_type = 'platform_support'
    AND action = 'platform.support.diagnostic_read'
    AND app_has_platform_permission('platform.support.read')
  );
--> statement-breakpoint

-- Clean up any residual content table policies to preserve pure Model B RLS (ADR-015)
DROP POLICY IF EXISTS "messages_platform_support_read" ON "messages";--> statement-breakpoint
DROP POLICY IF EXISTS "message_attempts_platform_support_read" ON "message_attempts";--> statement-breakpoint

-- Dedicated SECURITY DEFINER function for tenant dispatch troubleshooting
CREATE OR REPLACE FUNCTION app_platform_support_dispatch_diagnostics(
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
  v_user_id uuid;
  v_queue_stats jsonb;
  v_recent_failures jsonb;
BEGIN
  v_user_id := nullif(current_setting('app.current_user_id', true), '')::uuid;
  IF v_user_id IS NULL OR NOT (
    app_has_platform_permission('platform.support.read') OR app_is_platform_admin()
  ) THEN
    RAISE EXCEPTION 'insufficient privilege for platform support diagnostics'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 1. Live Queue Statistics
  SELECT jsonb_build_object(
    'pendingCount', coalesce(count(*) filter (where status::text = 'queued'), 0),
    'claimedCount', coalesce(count(*) filter (where status::text in ('routing', 'submitting')), 0),
    'delayedCount', 0
  )
  INTO v_queue_stats
  FROM messages
  WHERE org_id = p_org_id;

  -- 2. Recent Failures and in-flight messages with attempt details
  WITH target_messages AS (
    SELECT
      m.id AS message_id,
      c.code::text AS channel,
      m.status::text AS status,
      m.failure_reason,
      (CASE
        WHEN m.failure_reason ILIKE '%timeout%' THEN 'timeout'
        WHEN m.failure_reason ILIKE '%circuit%' THEN 'circuit_breaker'
        WHEN m.failure_reason ILIKE '%rate%' THEN 'rate_limit'
        WHEN m.failure_reason IS NOT NULL THEN 'provider_error'
        ELSE NULL END) AS failure_category,
      m.recipient_address,
      m.created_at,
      m.updated_at,
      (SELECT max(a.created_at) FROM message_attempts a WHERE a.message_id = m.id) AS last_attempt_at
    FROM messages m
    JOIN channels c ON c.id = m.channel_id
    WHERE m.org_id = p_org_id
      AND (p_channel IS NULL OR c.code::text = p_channel)
      AND (
        (p_status IS NOT NULL AND m.status::text = p_status)
        OR (p_status IS NULL AND m.status::text IN ('failed', 'queued', 'routing', 'submitting', 'outcome_unknown'))
      )
    ORDER BY m.created_at DESC
    LIMIT coalesce(p_limit, 20)
  ),
  message_with_attempts AS (
    SELECT
      tm.message_id,
      tm.channel,
      tm.status,
      tm.failure_reason,
      tm.failure_category,
      tm.recipient_address,
      tm.created_at,
      tm.updated_at,
      tm.last_attempt_at,
      coalesce(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'attemptNumber', ma.attempt_number,
              'providerId', ma.provider_id,
              'providerType', p.adapter_key,
              'errorType', (CASE WHEN ma.failure_reason IS NOT NULL THEN 'provider_error' ELSE NULL END),
              'httpStatus', NULL::integer,
              'latencyMs', ma.latency_ms,
              'attemptedAt', ma.created_at
            )
            ORDER BY ma.attempt_number ASC
          )
          FROM message_attempts ma
          JOIN providers p ON p.id = ma.provider_id
          WHERE ma.message_id = tm.message_id
        ),
        '[]'::jsonb
      ) AS attempts
    FROM target_messages tm
  )
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'messageId', message_id,
        'channel', channel,
        'status', status,
        'failureReason', failure_reason,
        'failureCategory', failure_category,
        'recipientAddress', recipient_address,
        'createdAt', created_at,
        'updatedAt', updated_at,
        'lastAttemptAt', last_attempt_at,
        'providerAttempts', attempts
      )
      ORDER BY created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_recent_failures
  FROM message_with_attempts;

  RETURN jsonb_build_object(
    'queue', v_queue_stats,
    'recentFailures', v_recent_failures
  );
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_platform_support_dispatch_diagnostics(uuid, text, text, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_platform_support_dispatch_diagnostics(uuid, text, text, integer) TO acc_app;
