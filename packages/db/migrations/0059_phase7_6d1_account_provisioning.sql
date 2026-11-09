-- =============================================================================
-- Phase 7 PR 7-6d-1 — billing-account provisioning, credit limits, freeze and
-- unfreeze (DECISIONS.md §1zi.13 D-76d-1 and D-76d-4; owner authorisation
-- 09-Nov-2026; docs/PHASE-7-6D-PROVISIONING-RECHARGE-HANDOVER.md Rev 2).
--
-- Numbered 0059: 0058 is claimed by the open Phase 8A.1 PR (#99), and this
-- migration does not depend on it.
--
-- Expand-only. No ledger fact is written and the ledger writer is untouched:
-- provisioning creates an empty account, a credit limit is configuration and a
-- freeze is a status change. Recharge is PR 7-6d-2.
--
-- 1. billing_account_operations: one row per operator request — provision,
--    credit_limit_change, freeze, unfreeze — with the dual-control rule,
--    four eyes, one pending operation per (organisation, account, kind) and a
--    transition guard; RLS on, no policy, no grant.
-- 2. Definers for acc_app (request, approve, reject, the account read and the
--    operations list), each refusing (42501) a caller that is not a signed-in
--    user holding billing.manage at platform scope (the 0049 pattern); the
--    executor is owner-only.
--
-- Dual control (D-76d-1): a credit-limit increase needs a second approver when
-- the threshold is unset or the increase (new − current) exceeds it; a decrease,
-- a freeze and a provisioning do not; an unfreeze always does. The threshold is
-- the server setting BILLING_DUAL_CONTROL_THRESHOLD_PAISE, passed in by the
-- service and recorded on the row; the CHECKs enforce the rule against it.
--
-- Freeze (D-76d-4) sets status only: balances, limits and reservations are
-- unchanged. The writer already refuses new reservations, top-ups and operator
-- charges on a frozen account (BL002); settlement of existing reservations is
-- unaffected. A credit-limit change never alters status.
--
-- Lock order (§1zi.1): operation row (FOR UPDATE) → organisation (FOR KEY SHARE)
-- → account (last). A request has no row yet and starts at the organisation.
-- No SECURITY DEFINER function here runs dynamic SQL, alters anything or sets a
-- variable (tenant-context-trust invariant D).
-- =============================================================================

CREATE TABLE billing_account_operations (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  account text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  amount_paise bigint,
  previous_limit_paise bigint,
  dual_control boolean NOT NULL,
  threshold_paise bigint,
  reason text NOT NULL,
  request_key text NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  rejected_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  rejected_at timestamptz,
  rejection_reason text,
  executed_at timestamptz,
  CONSTRAINT billing_account_operations_account CHECK (account IN ('wallet', 'credit_account')),
  CONSTRAINT billing_account_operations_kind CHECK (
    kind IN ('provision', 'credit_limit_change', 'freeze', 'unfreeze')
  ),
  CONSTRAINT billing_account_operations_status CHECK (status IN ('pending', 'executed', 'rejected')),
  -- A credit limit belongs to the credit account; only a limit change carries amounts.
  CONSTRAINT billing_account_operations_amounts CHECK (
    CASE WHEN kind = 'credit_limit_change'
      THEN account = 'credit_account'
           AND amount_paise IS NOT NULL AND amount_paise >= 0
           AND previous_limit_paise IS NOT NULL AND previous_limit_paise >= 0
           AND amount_paise <> previous_limit_paise
      ELSE amount_paise IS NULL AND previous_limit_paise IS NULL
    END
  ),
  CONSTRAINT billing_account_operations_threshold CHECK (threshold_paise IS NULL OR threshold_paise >= 0),
  -- D-76d-1, enforced against the recorded threshold.
  CONSTRAINT billing_account_operations_dual_control CHECK (
    CASE kind
      WHEN 'unfreeze' THEN dual_control
      WHEN 'credit_limit_change' THEN
        dual_control
        OR amount_paise < previous_limit_paise
        OR (threshold_paise IS NOT NULL AND amount_paise - previous_limit_paise <= threshold_paise)
      ELSE NOT dual_control
    END
  ),
  CONSTRAINT billing_account_operations_reason CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  CONSTRAINT billing_account_operations_request_key CHECK (char_length(request_key) BETWEEN 1 AND 255),
  -- RQ-3: a request key is unique per organisation.
  CONSTRAINT billing_account_operations_request_key_key UNIQUE (org_id, request_key),
  -- Four eyes (D-76-3 mechanics): the requester neither approves nor rejects.
  CONSTRAINT billing_account_operations_four_eyes CHECK (
    approved_by IS DISTINCT FROM requested_by AND rejected_by IS DISTINCT FROM requested_by
  ),
  CONSTRAINT billing_account_operations_state CHECK (
    CASE status
      WHEN 'pending' THEN executed_at IS NULL AND rejected_by IS NULL AND rejected_at IS NULL
                          AND rejection_reason IS NULL
      WHEN 'executed' THEN executed_at IS NOT NULL AND rejected_by IS NULL
                           AND (NOT dual_control OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
      WHEN 'rejected' THEN executed_at IS NULL AND approved_by IS NULL AND rejected_by IS NOT NULL
                           AND rejected_at IS NOT NULL
                           AND char_length(btrim(coalesce(rejection_reason, ''))) BETWEEN 1 AND 500
    END
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX billing_account_operations_one_pending
  ON billing_account_operations (org_id, account, kind) WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX billing_account_operations_org_id_idx ON billing_account_operations (org_id, id);
--> statement-breakpoint

-- Only pending → executed and pending → rejected; while pending, only the approval (once) may be
-- recorded; the request's own columns never change; nothing is deleted.
CREATE OR REPLACE FUNCTION fn_billing_account_operations_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION '%: % is not permitted (financial records are append-only)', TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a % account operation is final', OLD.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.org_id, NEW.account, NEW.kind, NEW.amount_paise, NEW.previous_limit_paise,
      NEW.dual_control, NEW.threshold_paise, NEW.reason, NEW.request_key, NEW.requested_by,
      NEW.requested_at)
     IS DISTINCT FROM
     (OLD.id, OLD.org_id, OLD.account, OLD.kind, OLD.amount_paise, OLD.previous_limit_paise,
      OLD.dual_control, OLD.threshold_paise, OLD.reason, OLD.request_key, OLD.requested_by,
      OLD.requested_at) THEN
    RAISE EXCEPTION 'an account operation request is immutable once made' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.approved_by IS NOT NULL
     AND (NEW.approved_by, NEW.approved_at) IS DISTINCT FROM (OLD.approved_by, OLD.approved_at) THEN
    RAISE EXCEPTION 'an approval is recorded once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_billing_account_operations_guard BEFORE UPDATE OR DELETE ON billing_account_operations
  FOR EACH ROW EXECUTE FUNCTION fn_billing_account_operations_guard();
--> statement-breakpoint
CREATE TRIGGER trg_billing_account_operations_no_truncate BEFORE TRUNCATE ON billing_account_operations
  FOR EACH STATEMENT EXECUTE FUNCTION fn_billing_account_operations_guard();
--> statement-breakpoint
-- Deny by default: RLS on, no policy, no privilege for any application role.
ALTER TABLE billing_account_operations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE billing_account_operations FROM PUBLIC;
--> statement-breakpoint

-- --- Execution (owner-only; reached from request and approve) -------------------------

CREATE OR REPLACE FUNCTION app_billing_account_execute(p_operation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  r billing_account_operations%ROWTYPE;
  v_org_status organization_status;
  v_id uuid;
  v_status billing_account_status;
  v_limit bigint;
BEGIN
  IF app_current_user_id() IS NULL OR NOT app_has_platform_permission('billing.manage') THEN
    RAISE EXCEPTION 'insufficient privilege for billing account operations' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Lock order: operation → organisation → account (last).
  SELECT * INTO r FROM billing_account_operations x WHERE x.id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account operation not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'the account operation is %', r.status USING ERRCODE = 'BL013';
  END IF;
  IF r.dual_control AND r.approved_by IS NULL THEN
    RAISE EXCEPTION 'the account operation requires a second approver' USING ERRCODE = 'BL011';
  END IF;
  SELECT o.status INTO v_org_status FROM organizations o WHERE o.id = r.org_id FOR KEY SHARE;
  IF v_org_status = 'closed' THEN
    RAISE EXCEPTION 'the organization is closed' USING ERRCODE = 'BL013';
  END IF;

  IF r.kind = 'provision' THEN
    IF r.account = 'wallet' THEN
      INSERT INTO wallets (org_id) VALUES (r.org_id) ON CONFLICT (org_id) DO NOTHING RETURNING id INTO v_id;
    ELSE
      INSERT INTO credit_accounts (org_id) VALUES (r.org_id) ON CONFLICT (org_id) DO NOTHING RETURNING id INTO v_id;
    END IF;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'the account already exists' USING ERRCODE = 'BL013';
    END IF;
  ELSIF r.kind = 'credit_limit_change' THEN
    SELECT c.id, c.credit_limit_paise INTO v_id, v_limit
      FROM credit_accounts c WHERE c.org_id = r.org_id FOR UPDATE;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'the organization has no credit account' USING ERRCODE = 'BL013';
    END IF;
    -- Bound to the limit the requester saw; the increase was measured against it.
    IF v_limit <> r.previous_limit_paise THEN
      RAISE EXCEPTION 'the credit limit changed since the request' USING ERRCODE = 'BL014';
    END IF;
    -- The limit only: status (frozen or active) is never touched.
    UPDATE credit_accounts c SET credit_limit_paise = r.amount_paise, version = version + 1 WHERE c.id = v_id;
  ELSE
    IF r.account = 'wallet' THEN
      SELECT w.id, w.status INTO v_id, v_status FROM wallets w WHERE w.org_id = r.org_id FOR UPDATE;
    ELSE
      SELECT c.id, c.status INTO v_id, v_status FROM credit_accounts c WHERE c.org_id = r.org_id FOR UPDATE;
    END IF;
    IF v_id IS NULL THEN
      RAISE EXCEPTION 'the organization has no such account' USING ERRCODE = 'BL013';
    END IF;
    IF (r.kind = 'freeze' AND v_status <> 'active') OR (r.kind = 'unfreeze' AND v_status <> 'frozen') THEN
      RAISE EXCEPTION 'the account status changed since the request' USING ERRCODE = 'BL014';
    END IF;
    -- Status only: balances, limits and reservations are unchanged (D-76d-4).
    IF r.account = 'wallet' THEN
      UPDATE wallets w
         SET status = CASE r.kind WHEN 'freeze' THEN 'frozen' ELSE 'active' END::billing_account_status,
             version = version + 1
       WHERE w.id = v_id;
    ELSE
      UPDATE credit_accounts c
         SET status = CASE r.kind WHEN 'freeze' THEN 'frozen' ELSE 'active' END::billing_account_status,
             version = version + 1
       WHERE c.id = v_id;
    END IF;
  END IF;

  UPDATE billing_account_operations x SET status = 'executed', executed_at = now() WHERE x.id = r.id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_billing_account_execute(uuid) FROM PUBLIC;
--> statement-breakpoint

-- --- Entry points for acc_app --------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_billing_account_request(
  p_org_id uuid,
  p_account text,
  p_kind text,
  p_new_limit_paise bigint,
  p_previous_limit_paise bigint,
  p_reason text,
  p_threshold_paise bigint,
  p_request_key text
)
RETURNS TABLE (operation_id uuid, executed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org_status organization_status;
  v_exists boolean;
  v_status billing_account_status;
  v_limit bigint;
  v_dual boolean;
  v_id uuid;
BEGIN
  IF app_current_user_id() IS NULL OR NOT app_has_platform_permission('billing.manage') THEN
    RAISE EXCEPTION 'insufficient privilege for billing account operations' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_account IS NULL OR p_account NOT IN ('wallet', 'credit_account') THEN
    RAISE EXCEPTION 'account must be wallet or credit_account' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('provision', 'credit_limit_change', 'freeze', 'unfreeze') THEN
    RAISE EXCEPTION 'unknown account operation' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a reason of 1 to 500 characters is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_threshold_paise IS NOT NULL AND p_threshold_paise < 0 THEN
    RAISE EXCEPTION 'the dual-control threshold cannot be negative' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_request_key IS NULL OR char_length(p_request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'a request key is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_kind = 'credit_limit_change' THEN
    IF p_account <> 'credit_account' OR p_new_limit_paise IS NULL OR p_new_limit_paise < 0
       OR p_previous_limit_paise IS NULL OR p_previous_limit_paise < 0
       OR p_new_limit_paise = p_previous_limit_paise THEN
      RAISE EXCEPTION 'a credit-limit change needs a different, non-negative new limit and the previous limit'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSIF p_new_limit_paise IS NOT NULL OR p_previous_limit_paise IS NOT NULL THEN
    RAISE EXCEPTION 'only a credit-limit change carries amounts' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT o.status INTO v_org_status FROM organizations o WHERE o.id = p_org_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_org_status = 'closed' THEN
    RAISE EXCEPTION 'the organization is closed' USING ERRCODE = 'BL013';
  END IF;

  IF p_account = 'wallet' THEN
    SELECT true, w.status, NULL::bigint INTO v_exists, v_status, v_limit FROM wallets w WHERE w.org_id = p_org_id;
  ELSE
    SELECT true, c.status, c.credit_limit_paise INTO v_exists, v_status, v_limit
      FROM credit_accounts c WHERE c.org_id = p_org_id;
  END IF;
  v_exists := COALESCE(v_exists, false);
  IF (p_kind = 'provision' AND v_exists) OR (p_kind <> 'provision' AND NOT v_exists) THEN
    RAISE EXCEPTION 'the account % for this operation', CASE WHEN v_exists THEN 'already exists' ELSE 'does not exist' END
      USING ERRCODE = 'BL013';
  END IF;
  IF (p_kind = 'freeze' AND v_status <> 'active') OR (p_kind = 'unfreeze' AND v_status <> 'frozen') THEN
    RAISE EXCEPTION 'the account is already %', v_status USING ERRCODE = 'BL013';
  END IF;
  IF p_kind = 'credit_limit_change' AND v_limit <> p_previous_limit_paise THEN
    RAISE EXCEPTION 'the credit limit is not the one the request names' USING ERRCODE = 'BL014';
  END IF;
  IF EXISTS (SELECT 1 FROM billing_account_operations x
              WHERE x.org_id = p_org_id AND x.account = p_account AND x.kind = p_kind AND x.status = 'pending') THEN
    RAISE EXCEPTION 'an operation of this kind is already pending' USING ERRCODE = 'BL013';
  END IF;

  v_dual := CASE p_kind
    WHEN 'unfreeze' THEN true
    WHEN 'credit_limit_change' THEN
      p_new_limit_paise > p_previous_limit_paise
      AND (p_threshold_paise IS NULL OR p_new_limit_paise - p_previous_limit_paise > p_threshold_paise)
    ELSE false
  END;

  INSERT INTO billing_account_operations (
    org_id, account, kind, amount_paise, previous_limit_paise, dual_control, threshold_paise,
    reason, request_key, requested_by
  ) VALUES (
    p_org_id, p_account, p_kind, p_new_limit_paise, p_previous_limit_paise, v_dual, p_threshold_paise,
    btrim(p_reason), p_request_key, app_current_user_id()
  )
  RETURNING id INTO v_id;

  IF NOT v_dual THEN
    PERFORM app_billing_account_execute(v_id);
  END IF;
  RETURN QUERY SELECT v_id, NOT v_dual;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_billing_account_request(uuid, text, text, bigint, bigint, text, bigint, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_billing_account_request(uuid, text, text, bigint, bigint, text, bigint, text) TO acc_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_billing_account_approve(p_operation_id uuid, p_expected_amount_paise bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  r billing_account_operations%ROWTYPE;
  v_user uuid := app_current_user_id();
BEGIN
  IF v_user IS NULL OR NOT app_has_platform_permission('billing.manage') THEN
    RAISE EXCEPTION 'insufficient privilege for billing account operations' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO r FROM billing_account_operations x WHERE x.id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account operation not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'the account operation is %', r.status USING ERRCODE = 'BL013';
  END IF;
  IF r.requested_by = v_user THEN
    RAISE EXCEPTION 'the requester cannot approve their own request' USING ERRCODE = 'BL011';
  END IF;
  -- Bound to the exact amount the approver saw (none for an operation without one).
  IF p_expected_amount_paise IS DISTINCT FROM r.amount_paise THEN
    RAISE EXCEPTION 'the approved amount does not match the request' USING ERRCODE = 'BL014';
  END IF;
  UPDATE billing_account_operations x SET approved_by = v_user, approved_at = now() WHERE x.id = r.id;
  PERFORM app_billing_account_execute(r.id);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_billing_account_approve(uuid, bigint) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_billing_account_approve(uuid, bigint) TO acc_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_billing_account_reject(p_operation_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  r billing_account_operations%ROWTYPE;
  v_user uuid := app_current_user_id();
BEGIN
  IF v_user IS NULL OR NOT app_has_platform_permission('billing.manage') THEN
    RAISE EXCEPTION 'insufficient privilege for billing account operations' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a reason of 1 to 500 characters is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO r FROM billing_account_operations x WHERE x.id = p_operation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account operation not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'the account operation is %', r.status USING ERRCODE = 'BL013';
  END IF;
  IF r.requested_by = v_user THEN
    RAISE EXCEPTION 'the requester cannot reject their own request' USING ERRCODE = 'BL011';
  END IF;
  UPDATE billing_account_operations x
     SET status = 'rejected', rejected_by = v_user, rejected_at = now(), rejection_reason = btrim(p_reason)
   WHERE x.id = r.id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_billing_account_reject(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_billing_account_reject(uuid, text) TO acc_app;
--> statement-breakpoint

-- --- Platform reads -------------------------------------------------------------------------

-- An organisation's billing accounts (zero, one or two rows); unknown organisation: P0002.
CREATE OR REPLACE FUNCTION app_billing_accounts_get(p_org_id uuid)
RETURNS TABLE (
  account text,
  account_id uuid,
  status billing_account_status,
  balance_paise bigint,
  credit_limit_paise bigint,
  used_paise bigint,
  reserved_paise bigint,
  version bigint,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
  IF app_current_user_id() IS NULL OR NOT app_has_platform_permission('billing.manage') THEN
    RAISE EXCEPTION 'insufficient privilege for billing accounts' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = p_org_id) THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN QUERY
  SELECT 'wallet'::text, w.id, w.status, w.balance_paise, NULL::bigint, NULL::bigint, w.reserved_paise,
         w.version, w.created_at, w.updated_at
    FROM wallets w WHERE w.org_id = p_org_id
  UNION ALL
  SELECT 'credit_account'::text, c.id, c.status, NULL::bigint, c.credit_limit_paise, c.used_paise,
         c.reserved_paise, c.version, c.created_at, c.updated_at
    FROM credit_accounts c WHERE c.org_id = p_org_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_billing_accounts_get(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_billing_accounts_get(uuid) TO acc_app;
--> statement-breakpoint

-- Account operations, newest first, by id cursor.
CREATE OR REPLACE FUNCTION app_billing_account_operations_list(
  p_id uuid,
  p_org_id uuid,
  p_account text,
  p_kind text,
  p_status text,
  p_before_id uuid,
  p_limit integer
)
RETURNS SETOF billing_account_operations
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
    RAISE EXCEPTION 'insufficient privilege for billing account operations' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
  SELECT x.*
    FROM billing_account_operations x
   WHERE (p_id IS NULL OR x.id = p_id)
     AND (p_org_id IS NULL OR x.org_id = p_org_id)
     AND (p_account IS NULL OR x.account = p_account)
     AND (p_kind IS NULL OR x.kind = p_kind)
     AND (p_status IS NULL OR x.status = p_status)
     AND (p_before_id IS NULL OR x.id < p_before_id)
   ORDER BY x.id DESC
   LIMIT v_limit;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_billing_account_operations_list(uuid, uuid, text, text, text, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_billing_account_operations_list(uuid, uuid, text, text, text, uuid, integer) TO acc_app;
