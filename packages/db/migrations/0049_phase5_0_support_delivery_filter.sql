-- =============================================================================
-- Migration: 0049_phase5_0_support_delivery_filter   (Phase 5.0, PR-D)
--
-- Owner decision 07-Nov-2026: the platform-support dispatch diagnostics gain an
-- optional delivery-status filter, inside the existing content boundary.
--
-- app_platform_support_dispatch_diagnostics (0040) gains a fifth parameter,
-- p_delivery_status text DEFAULT NULL. A parameter cannot be added in place, so
-- the function is dropped and recreated in this one transaction. Everything else
-- is carried over unchanged:
--   - SECURITY DEFINER, STABLE, fixed search_path (public, pg_temp);
--   - the caller check (an active platform.support.read holder, else 42501),
--     evaluated first, before any argument is looked at;
--   - the result shape — identifiers, channel codes, statuses, attempt numbers,
--     latencies, timestamps and allowlisted failure codes only (the Model B
--     boundary, ADR-015 R-7/R-8, is NOT amended). The filter only narrows which
--     of the organization's messages are listed; nothing new is returned (no
--     delivery field, no provider message reference: OD-9 keeps that off tenant
--     responses and this function does not return it either);
--   - the limit clamp (1..50) and the ordering;
--   - grants: EXECUTE revoked from PUBLIC, granted to acc_app only.
--
-- p_delivery_status:
--   - NULL (omitted): behaviour is exactly 0040's, including the default status
--     set (failed, queued, routing, submitting, outcome_unknown) when p_status is
--     also NULL. An existing four-argument call resolves to this function through
--     the default, so an application still on 0040 keeps working.
--   - a value of message_delivery_status (pending, delivered, undelivered,
--     not_supported): only messages with exactly that delivery status. Messages
--     with no delivery status (not tracked) never match. When p_status is NULL the
--     default troubleshooting status set is NOT applied, because delivery statuses
--     are set on settled (mostly accepted) messages that the default set excludes;
--     p_status still narrows when supplied.
--   - anything else: refused with 22023 (invalid_parameter_value), after the
--     caller check. The API validates the same closed list first.
--
-- Metadata only; no table is touched.
-- =============================================================================
DROP FUNCTION app_platform_support_dispatch_diagnostics(uuid, text, text, integer);--> statement-breakpoint
CREATE FUNCTION app_platform_support_dispatch_diagnostics(
  p_org_id uuid,
  p_channel text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_delivery_status text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_delivery message_delivery_status;
  v_queue jsonb;
  v_recent jsonb;
BEGIN
  IF app_current_user_id() IS NULL
     OR NOT app_has_platform_permission('platform.support.read') THEN
    RAISE EXCEPTION 'insufficient privilege for platform support diagnostics'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_delivery_status IS NOT NULL THEN
    IF NOT (p_delivery_status = ANY (enum_range(NULL::message_delivery_status)::text[])) THEN
      RAISE EXCEPTION 'invalid delivery status filter'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_delivery := p_delivery_status::message_delivery_status;
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
      AND (v_delivery IS NULL OR m.delivery_status = v_delivery)
      AND (
        (p_status IS NOT NULL AND m.status::text = p_status)
        OR (p_status IS NULL AND v_delivery IS NOT NULL)
        OR (p_status IS NULL AND v_delivery IS NULL
            AND m.status::text IN ('failed', 'queued', 'routing', 'submitting', 'outcome_unknown'))
      )
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT v_limit
  ) recent;

  RETURN jsonb_build_object('queue', v_queue, 'recentMessages', v_recent);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_platform_support_dispatch_diagnostics(uuid, text, text, integer, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_platform_support_dispatch_diagnostics(uuid, text, text, integer, text) TO acc_app;
