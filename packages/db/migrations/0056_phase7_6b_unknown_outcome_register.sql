-- =============================================================================
-- Phase 7 PR 7-6b — the unknown-outcome register (DECISIONS.md §1zi.9 D-76-5;
-- docs/PHASE-7-6-BILLING-APIS-HANDOVER.md Rev 2 §5; baseline §6.5 Policy U).
--
-- Expand-only. Two read-only SECURITY DEFINER functions, executable by acc_app
-- only, each refusing (42501) any caller that is not a signed-in user holding
-- billing.manage at platform scope — the 0049 caller-check pattern. No policy
-- or privilege is added to any financial table: the functions are the only way
-- the platform reads this data (no platform-wide RLS policy, owner instruction).
-- No 7.1–7.6a object is altered; nothing is written.
--
-- A register item is a message submitted under billing enforcement whose status
-- is outcome_unknown. For each item:
--   * the unknown attempt (the latest attempt in outcome_unknown, if any);
--   * ESTIMATED exposure, report-only and never a ledger fact (Policy U):
--       customer — E_m (message evaluation) under charge_per_logical_message, or
--                  the unknown attempt's E_a under charge_per_attempt;
--       provider cost — the unknown attempt's evaluation, when there is one;
--   * age (now − completed_at);
--   * evidence — `evidenced` when a provider receipt reached the unknown attempt
--     (delivery status delivered or undelivered, or a read time), else
--     `unevidenced`. Receipts never change billing (OD-7-4);
--   * status, derived from the ledger, never stored:
--       charged               a customer_charge exists on the automatic anchor and
--                             a provider_cost on the unknown attempt;
--       charged_without_cost  a customer_charge exists without that provider cost;
--       open                  neither.
--     pending_approval and written_off come with operator resolution (7-6c); until
--     then no item can be in either, and filtering by them returns nothing.
-- No SECURITY DEFINER function here runs dynamic SQL, alters anything or sets a
-- variable (tenant-context-trust invariant D).
-- =============================================================================

CREATE OR REPLACE FUNCTION app_billing_unknown_register(
  p_org_id uuid,
  p_channel_code text,
  p_evidence text,
  p_status text,
  p_min_age_seconds integer,
  p_after_completed_at timestamptz,
  p_after_message_id uuid,
  p_limit integer
)
RETURNS TABLE (
  message_id uuid,
  org_id uuid,
  channel_code text,
  billing_policy billing_policy,
  completed_at timestamptz,
  age_seconds bigint,
  attempt_id uuid,
  provider_id uuid,
  estimated_customer_paise bigint,
  estimated_provider_cost_paise bigint,
  evidence text,
  status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 201);
BEGIN
  IF app_current_user_id() IS NULL OR NOT app_has_platform_permission('billing.manage') THEN
    RAISE EXCEPTION 'insufficient privilege for the unknown-outcome register'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_evidence IS NOT NULL AND p_evidence NOT IN ('evidenced', 'unevidenced') THEN
    RAISE EXCEPTION 'invalid evidence filter' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_status IS NOT NULL
     AND p_status NOT IN ('open', 'charged', 'charged_without_cost', 'pending_approval', 'written_off') THEN
    RAISE EXCEPTION 'invalid status filter' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (p_after_completed_at IS NULL) <> (p_after_message_id IS NULL) THEN
    RAISE EXCEPTION 'the cursor needs both its time and its message' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH items AS (
    SELECT m.id AS message_id,
           m.org_id,
           app_channel_code(m.channel_id) AS channel_code,
           m.billing_policy_snapshot AS billing_policy,
           m.completed_at,
           a.id AS attempt_id,
           a.provider_id,
           (a.delivery_status IN ('delivered', 'undelivered') OR a.read_at IS NOT NULL) AS evidenced,
           CASE WHEN m.billing_policy_snapshot = 'charge_per_attempt' THEN a.id ELSE m.id END AS charge_anchor
      FROM messages m
      LEFT JOIN LATERAL (
        SELECT x.id, x.provider_id, x.delivery_status, x.read_at
          FROM message_attempts x
         WHERE x.message_id = m.id AND x.status = 'outcome_unknown'
         ORDER BY x.attempt_number DESC
         LIMIT 1
      ) a ON true
     WHERE m.billing_enforced
       AND m.status = 'outcome_unknown'
       AND (p_org_id IS NULL OR m.org_id = p_org_id)
       AND (p_channel_code IS NULL OR app_channel_code(m.channel_id) = p_channel_code)
       AND (p_min_age_seconds IS NULL
            OR m.completed_at <= now() - make_interval(secs => p_min_age_seconds))
  ),
  assessed AS (
    SELECT i.*,
           (SELECT e.total_customer_price_paise FROM pricing_evaluations e
             WHERE (i.billing_policy = 'charge_per_attempt' AND e.subject = 'attempt'
                    AND e.message_attempt_id = i.attempt_id)
                OR (i.billing_policy = 'charge_per_logical_message' AND e.subject = 'message'
                    AND e.message_id = i.message_id)
             LIMIT 1) AS customer_exposure,
           (SELECT e.total_provider_cost_paise FROM pricing_evaluations e
             WHERE e.subject = 'attempt' AND e.message_attempt_id = i.attempt_id) AS cost_exposure,
           (i.charge_anchor IS NOT NULL AND EXISTS (
              SELECT 1 FROM usage_ledger l
               WHERE l.anchor_month = app_uuidv7_month(i.charge_anchor)
                 AND l.anchor_id = i.charge_anchor
                 AND l.fact_kind = 'customer_charge'
                 AND l.message_id = i.message_id)) AS charged,
           (i.attempt_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM usage_ledger l
               WHERE l.anchor_month = app_uuidv7_month(i.attempt_id)
                 AND l.anchor_id = i.attempt_id
                 AND l.fact_kind = 'provider_cost')) AS costed
      FROM items i
  ),
  labelled AS (
    SELECT s.*,
           CASE WHEN s.evidenced THEN 'evidenced' ELSE 'unevidenced' END AS evidence_label,
           CASE
             WHEN s.charged AND s.costed THEN 'charged'
             WHEN s.charged THEN 'charged_without_cost'
             ELSE 'open'
           END AS status_label
      FROM assessed s
  )
  SELECT r.message_id,
         r.org_id,
         r.channel_code,
         r.billing_policy,
         r.completed_at,
         floor(extract(epoch FROM (now() - r.completed_at)))::bigint,
         r.attempt_id,
         r.provider_id,
         r.customer_exposure,
         r.cost_exposure,
         r.evidence_label,
         r.status_label
    FROM labelled r
   WHERE (p_evidence IS NULL OR r.evidence_label = p_evidence)
     AND (p_status IS NULL OR r.status_label = p_status)
     AND (p_after_completed_at IS NULL
          OR (r.completed_at, r.message_id) > (p_after_completed_at, p_after_message_id))
   ORDER BY r.completed_at, r.message_id
   LIMIT v_limit;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_billing_unknown_register(uuid, text, text, text, integer, timestamptz, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_billing_unknown_register(uuid, text, text, text, integer, timestamptz, uuid, integer) TO acc_app;
--> statement-breakpoint

-- Open items per channel, for the gauge acc_billing_outcome_unknown_open{channel}:
-- enforced outcome_unknown messages with no customer charge on the automatic anchor —
-- the message under charge_per_logical_message, the unknown attempt under
-- charge_per_attempt. The charge lookup names the ledger fact's full key, including the
-- partition key derived from the anchor (anchor_month = app_uuidv7_month(anchor),
-- IMMUTABLE), and runs as a LATERAL subquery per message, so each lookup is pruned at
-- run time to the one monthly partition that can hold the fact (PR #97 review).
CREATE OR REPLACE FUNCTION app_billing_unknown_open_counts()
RETURNS TABLE (channel_code text, open_items bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF app_current_user_id() IS NULL OR NOT app_has_platform_permission('billing.manage') THEN
    RAISE EXCEPTION 'insufficient privilege for the unknown-outcome register'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT app_channel_code(m.channel_id), count(*)::bigint
    FROM messages m
    LEFT JOIN LATERAL (
      SELECT x.id FROM message_attempts x
       WHERE x.message_id = m.id AND x.status = 'outcome_unknown'
       ORDER BY x.attempt_number DESC LIMIT 1
    ) a ON true
    CROSS JOIN LATERAL (
      SELECT CASE WHEN m.billing_policy_snapshot = 'charge_per_attempt' THEN a.id ELSE m.id END
               AS expected_charge_anchor
    ) e
    LEFT JOIN LATERAL (
      SELECT 1 AS found
        FROM usage_ledger l
       WHERE l.anchor_month = app_uuidv7_month(e.expected_charge_anchor)
         AND l.anchor_id = e.expected_charge_anchor
         AND l.fact_kind = 'customer_charge'
         AND l.message_id = m.id
       LIMIT 1
    ) c ON true
   WHERE m.billing_enforced
     AND m.status = 'outcome_unknown'
     AND c.found IS NULL
   GROUP BY 1;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_billing_unknown_open_counts() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_billing_unknown_open_counts() TO acc_app;
