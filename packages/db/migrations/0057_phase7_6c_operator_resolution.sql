-- =============================================================================
-- Phase 7 PR 7-6c — operator resolution of unknown outcomes (DECISIONS.md
-- §1zi.9 D-76-1, D-76-3, D-76-5 and §1zi.12; owner approval 09-Nov-2026 of the
-- 7-6c handover with D-76c-1, O-1, O-2, C-1 and C-2; baseline §6.5 Policy U).
--
-- An enforced message whose outcome is unknown was released and never charged
-- (7.5, OD-7-4U). Here a platform operator holding billing.manage resolves it
-- explicitly, by a charge or a write-off, under dual control.
--
-- 1. app_ledger_post gains a defaulted trailing argument, p_mode (C-1). The
--    function is dropped and recreated (a new argument changes its identity);
--    its privileges are reapplied exactly as 0050 left them — no EXECUTE for
--    PUBLIC or any application role. Every existing caller passes nine
--    arguments and keeps mode 'automatic', whose behaviour is unchanged.
--    Mode 'operator_resolution' (D-76-1) is accepted only for a customer_charge
--    on an enforced outcome_unknown message with a pending charge resolution;
--    it checks that the account is active (BL002) and that available funds
--    cover the charge (BL003) under the account lock, skips the settled
--    (BL004) and outstanding-reservation (BL006) checks, and moves balance or
--    used only: reserved is unchanged and no reservation is posted.
-- 2. billing_unknown_resolutions: one row per request; snapshots of the amounts
--    and the evidence taken at request; requester ≠ approver (CHECK); at most one
--    pending and one executed resolution per message; a guard trigger admits
--    only pending → executed / rejected; RLS on, no policy, no privilege.
-- 3. Definers for acc_app: request, approve, reject, note a refusal, list. Each
--    first refuses (42501) a caller that is not a signed-in user holding
--    billing.manage at platform scope (the 0049 pattern).
-- 4. app_billing_unknown_register and app_billing_unknown_open_counts (0056) are
--    replaced with the same signatures and privileges: pending_approval and
--    written_off statuses, an executed resolution leaves the open count, a
--    pending one stays open (C-2), and under charge_per_attempt the exposure
--    covers every attempt a resolution would charge (D-76c-1).
--
-- What a charge posts (Policy U: the automatic path's fact identities):
--   charge_per_logical_message  customer_charge E_m on the message;
--   charge_per_attempt          customer_charge E_a on the unknown attempt and on
--                               every earlier attempt recorded as reaching the
--                               provider, as an accepted chain would (D-76c-1);
--   provider_cost               on the unknown attempt, only when a provider
--                               receipt is recorded on it at request and at
--                               execution (O-1); never posted later for an item
--                               charged without evidence.
-- A write-off posts nothing; the executed row and its audit entry are the record.
--
-- Dual control (D-76-3): required when the threshold is unset, when the customer
-- amount exceeds it, or for a charge without evidence. The threshold is the
-- environment setting BILLING_DUAL_CONTROL_THRESHOLD_PAISE (O-2), passed in by
-- the service and recorded on the row.
--
-- Lock order (§1zi.1): resolution row (FOR UPDATE) → message → unknown attempt →
-- billing account (last, taken by the writer) → new rows only. A request has no
-- resolution row yet and starts at the message. No SECURITY DEFINER function
-- here runs dynamic SQL, alters anything or sets a variable (invariant D).
-- =============================================================================

-- --- 1. The ledger writer with its operator-charge mode ---------------------------

DROP FUNCTION app_ledger_post(uuid, usage_ledger_entry_type, uuid, bigint, text, uuid, uuid, text, text);
--> statement-breakpoint
CREATE FUNCTION app_ledger_post(
  p_org_id uuid,
  p_entry_type usage_ledger_entry_type,
  p_anchor_id uuid,
  p_amount_paise bigint,
  p_account text,
  p_message_id uuid,
  p_message_attempt_id uuid,
  p_correlation_id text,
  p_reference_note text,
  p_mode text DEFAULT 'automatic'
)
RETURNS TABLE (inserted boolean, ledger_id uuid, amount_paise bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_month date;
  v_fact text := p_entry_type::text;
  v_reseller uuid;
  v_wallet wallets%ROWTYPE;
  v_credit credit_accounts%ROWTYPE;
  v_wallet_id uuid;
  v_credit_id uuid;
  v_status billing_account_status;
  v_existing_id uuid;
  v_existing_amount bigint;
  v_first_wallet uuid;
  v_first_credit uuid;
  v_first_found boolean;
  v_reserved bigint;
  v_charged bigint;
  v_released bigint;
  v_outstanding bigint;
  v_available bigint;
  v_amount bigint;
  v_id uuid;
  v_operator boolean;
BEGIN
  -- 1. Allowlist.
  IF p_entry_type IS NULL
     OR p_entry_type NOT IN ('reservation', 'reservation_release', 'customer_charge', 'provider_cost') THEN
    RAISE EXCEPTION 'ledger entry type % is not enabled', p_entry_type USING ERRCODE = 'BL000';
  END IF;
  -- The mode: 'automatic' (every 7.4/7.5 caller) or 'operator_resolution' (Policy U, D-76-1),
  -- which only app_billing_resolve_unknown passes, and only for a customer charge.
  IF p_mode IS NULL OR p_mode NOT IN ('automatic', 'operator_resolution') THEN
    RAISE EXCEPTION 'unknown ledger posting mode' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_operator := p_mode = 'operator_resolution';
  IF v_operator AND p_entry_type <> 'customer_charge' THEN
    RAISE EXCEPTION 'the operator-resolution mode posts customer charges only' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 2. Shape (before any data is read or locked).
  IF p_org_id IS NULL OR p_anchor_id IS NULL OR p_message_id IS NULL THEN
    RAISE EXCEPTION 'organization, anchor and message are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_anchor_id <> COALESCE(p_message_attempt_id, p_message_id) THEN
    RAISE EXCEPTION 'anchor must be the attempt when given, else the message' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_entry_type = 'provider_cost' AND p_message_attempt_id IS NULL THEN
    RAISE EXCEPTION 'provider_cost requires an attempt' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_entry_type = 'reservation_release' AND p_message_attempt_id IS NOT NULL THEN
    RAISE EXCEPTION 'reservation_release is anchored on the message' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_entry_type = 'reservation_release' THEN
    IF p_amount_paise IS NOT NULL THEN
      RAISE EXCEPTION 'the release amount is computed by the writer' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSIF p_amount_paise IS NULL OR p_amount_paise <= 0 THEN
    RAISE EXCEPTION 'amount must be a positive number of paise' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_entry_type = 'provider_cost' THEN
    IF p_account IS NOT NULL THEN
      RAISE EXCEPTION 'provider_cost has no account' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSIF p_account IS NULL OR p_account NOT IN ('wallet', 'credit') THEN
    RAISE EXCEPTION 'account must be wallet or credit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_month := app_uuidv7_month(p_anchor_id);
  IF v_month IS NULL THEN
    RAISE EXCEPTION 'anchor is not a UUIDv7' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = p_message_id AND m.org_id = p_org_id) THEN
    RAISE EXCEPTION 'message does not belong to the organization' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_message_attempt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM message_attempts a WHERE a.id = p_message_attempt_id AND a.message_id = p_message_id
  ) THEN
    RAISE EXCEPTION 'attempt does not belong to the message' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT o.reseller_id INTO v_reseller FROM organizations o WHERE o.id = p_org_id;

  -- One message, one lock: every posting for a message (any fact, any account) is serialised on
  -- the message row, taken before the account (lock order message → account, §1zi). Without it,
  -- two first postings to different accounts would take different account locks, both pass the
  -- account-consistency check (BL005) and split the message's reservation between accounts.
  -- FOR NO KEY UPDATE: it does not conflict with the KEY SHARE locks that inserts of attempts and
  -- events referencing the message take.
  PERFORM 1 FROM messages m WHERE m.id = p_message_id FOR NO KEY UPDATE;

  -- The operator-resolution mode applies only to an enforced message whose outcome is unknown and
  -- which a pending charge resolution is executing (read under the message lock).
  IF v_operator THEN
    IF NOT EXISTS (SELECT 1 FROM messages m
                    WHERE m.id = p_message_id AND m.billing_enforced AND m.status = 'outcome_unknown') THEN
      RAISE EXCEPTION 'an operator charge applies only to an enforced outcome_unknown message'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM billing_unknown_resolutions r
                    WHERE r.message_id = p_message_id AND r.action = 'charge' AND r.status = 'pending') THEN
      RAISE EXCEPTION 'an operator charge requires a charge resolution being executed'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  -- 3. Account: the last row lock this transaction takes (account-last rule).
  IF p_account = 'wallet' THEN
    SELECT * INTO v_wallet FROM wallets w WHERE w.org_id = p_org_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'organization has no wallet' USING ERRCODE = 'BL001';
    END IF;
    v_wallet_id := v_wallet.id;
    v_status := v_wallet.status;
  ELSIF p_account = 'credit' THEN
    SELECT * INTO v_credit FROM credit_accounts c WHERE c.org_id = p_org_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'organization has no credit account' USING ERRCODE = 'BL001';
    END IF;
    v_credit_id := v_credit.id;
    v_status := v_credit.status;
  END IF;

  -- An existing fact makes the call an idempotent no-op, whatever has happened since.
  SELECT l.id, l.amount_paise INTO v_existing_id, v_existing_amount
    FROM usage_ledger l
   WHERE l.anchor_month = v_month AND l.anchor_id = p_anchor_id AND l.fact_kind = v_fact;
  IF FOUND THEN
    RETURN QUERY SELECT false, v_existing_id, v_existing_amount;
    RETURN;
  END IF;

  -- 4. Message consistency (account-bearing facts), read under the account lock.
  IF p_account IS NOT NULL THEN
    SELECT l.wallet_id, l.credit_account_id, true INTO v_first_wallet, v_first_credit, v_first_found
      FROM usage_ledger l
     WHERE l.message_id = p_message_id AND l.entry_type = 'reservation'
     ORDER BY l.occurred_at, l.id
     LIMIT 1;
    IF COALESCE(v_first_found, false)
       AND (v_first_wallet IS DISTINCT FROM v_wallet_id OR v_first_credit IS DISTINCT FROM v_credit_id) THEN
      RAISE EXCEPTION 'message is billed to a different account' USING ERRCODE = 'BL005';
    END IF;
    SELECT COALESCE(sum(l.amount_paise) FILTER (WHERE l.entry_type = 'reservation'), 0),
           COALESCE(sum(l.amount_paise) FILTER (WHERE l.entry_type = 'customer_charge'), 0),
           COALESCE(sum(l.amount_paise) FILTER (WHERE l.entry_type = 'reservation_release'), 0),
           count(*) FILTER (WHERE l.entry_type = 'reservation_release') > 0
      INTO v_reserved, v_charged, v_released, v_first_found
      FROM usage_ledger l
     WHERE l.message_id = p_message_id
       AND l.entry_type IN ('reservation', 'customer_charge', 'reservation_release');
    -- The operator-resolution mode charges a released message by design (Policy U).
    IF v_first_found AND p_entry_type IN ('reservation', 'customer_charge') AND NOT v_operator THEN
      RAISE EXCEPTION 'message is already settled' USING ERRCODE = 'BL004';
    END IF;
    v_outstanding := v_reserved - v_charged - v_released;
  END IF;

  -- 5. Rules by entry type.
  IF p_entry_type = 'reservation' THEN
    IF v_status <> 'active' THEN
      RAISE EXCEPTION 'billing account is not active' USING ERRCODE = 'BL002';
    END IF;
    IF p_account = 'wallet' THEN
      v_available := v_wallet.balance_paise - v_wallet.reserved_paise;
    ELSE
      v_available := v_credit.credit_limit_paise - v_credit.used_paise - v_credit.reserved_paise;
    END IF;
    IF v_available < p_amount_paise THEN
      RAISE EXCEPTION 'insufficient funds' USING ERRCODE = 'BL003';
    END IF;
    v_amount := p_amount_paise;
  ELSIF p_entry_type = 'customer_charge' AND v_operator THEN
    -- No reservation backs an operator charge: it is checked against available funds now,
    -- under the account lock, like a reservation.
    IF v_status <> 'active' THEN
      RAISE EXCEPTION 'billing account is not active' USING ERRCODE = 'BL002';
    END IF;
    IF p_account = 'wallet' THEN
      v_available := v_wallet.balance_paise - v_wallet.reserved_paise;
    ELSE
      v_available := v_credit.credit_limit_paise - v_credit.used_paise - v_credit.reserved_paise;
    END IF;
    IF v_available < p_amount_paise THEN
      RAISE EXCEPTION 'insufficient funds' USING ERRCODE = 'BL003';
    END IF;
    v_amount := p_amount_paise;
  ELSIF p_entry_type = 'customer_charge' THEN
    IF p_amount_paise > v_outstanding THEN
      RAISE EXCEPTION 'charge exceeds the outstanding reservation' USING ERRCODE = 'BL006';
    END IF;
    v_amount := p_amount_paise;
  ELSIF p_entry_type = 'reservation_release' THEN
    v_amount := v_outstanding;
    IF v_amount <= 0 THEN
      RETURN QUERY SELECT false, NULL::uuid, 0::bigint;
      RETURN;
    END IF;
  ELSE
    v_amount := p_amount_paise;
  END IF;

  -- 6. Insert if absent.
  INSERT INTO usage_ledger (
    anchor_month, anchor_id, fact_kind, entry_type, org_id, reseller_id, message_id,
    message_attempt_id, wallet_id, credit_account_id, amount_paise, correlation_id, reference_note
  ) VALUES (
    v_month, p_anchor_id, v_fact, p_entry_type, p_org_id, v_reseller, p_message_id,
    p_message_attempt_id, v_wallet_id, v_credit_id, v_amount, p_correlation_id, p_reference_note
  )
  ON CONFLICT (anchor_month, anchor_id, fact_kind) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT l.id, l.amount_paise INTO v_existing_id, v_existing_amount
      FROM usage_ledger l
     WHERE l.anchor_month = v_month AND l.anchor_id = p_anchor_id AND l.fact_kind = v_fact;
    RETURN QUERY SELECT false, v_existing_id, v_existing_amount;
    RETURN;
  END IF;

  -- 7. Balance effect, only for an inserted row.
  IF p_entry_type = 'reservation' THEN
    IF p_account = 'wallet' THEN
      UPDATE wallets SET reserved_paise = reserved_paise + v_amount, version = version + 1 WHERE id = v_wallet_id;
    ELSE
      UPDATE credit_accounts SET reserved_paise = reserved_paise + v_amount, version = version + 1 WHERE id = v_credit_id;
    END IF;
  ELSIF p_entry_type = 'reservation_release' THEN
    IF p_account = 'wallet' THEN
      UPDATE wallets SET reserved_paise = reserved_paise - v_amount, version = version + 1 WHERE id = v_wallet_id;
    ELSE
      UPDATE credit_accounts SET reserved_paise = reserved_paise - v_amount, version = version + 1 WHERE id = v_credit_id;
    END IF;
  ELSIF p_entry_type = 'customer_charge' AND v_operator THEN
    -- Nothing was reserved for it: the reservation is left untouched.
    IF p_account = 'wallet' THEN
      UPDATE wallets SET balance_paise = balance_paise - v_amount, version = version + 1 WHERE id = v_wallet_id;
    ELSE
      UPDATE credit_accounts SET used_paise = used_paise + v_amount, version = version + 1 WHERE id = v_credit_id;
    END IF;
  ELSIF p_entry_type = 'customer_charge' THEN
    IF p_account = 'wallet' THEN
      UPDATE wallets
         SET balance_paise = balance_paise - v_amount, reserved_paise = reserved_paise - v_amount,
             version = version + 1
       WHERE id = v_wallet_id;
    ELSE
      UPDATE credit_accounts
         SET used_paise = used_paise + v_amount, reserved_paise = reserved_paise - v_amount,
             version = version + 1
       WHERE id = v_credit_id;
    END IF;
  END IF;

  RETURN QUERY SELECT true, v_id, v_amount;
END;
$$;
--> statement-breakpoint
-- The privileges 0050 gave the writer, reapplied (C-1): none for PUBLIC, none for any
-- application role; only the owner's SECURITY DEFINER functions call it.
REVOKE ALL ON FUNCTION app_ledger_post(uuid, usage_ledger_entry_type, uuid, bigint, text, uuid, uuid, text, text, text) FROM PUBLIC;
--> statement-breakpoint

-- --- 2. Resolutions -----------------------------------------------------------------

CREATE TABLE billing_unknown_resolutions (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  org_id uuid NOT NULL,
  message_id uuid NOT NULL,
  attempt_id uuid REFERENCES message_attempts(id) ON DELETE RESTRICT,
  action text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  billing_policy billing_policy NOT NULL,
  customer_amount_paise bigint NOT NULL,
  provider_cost_paise bigint,
  evidence text NOT NULL,
  post_provider_cost boolean NOT NULL,
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
  charged_paise bigint,
  provider_cost_posted_paise bigint,
  last_refusal text,
  last_refused_at timestamptz,
  CONSTRAINT billing_unknown_resolutions_message_fkey FOREIGN KEY (message_id, org_id)
    REFERENCES messages(id, org_id) ON DELETE RESTRICT,
  CONSTRAINT billing_unknown_resolutions_action CHECK (action IN ('charge', 'write_off')),
  CONSTRAINT billing_unknown_resolutions_status CHECK (status IN ('pending', 'executed', 'rejected')),
  CONSTRAINT billing_unknown_resolutions_evidence CHECK (evidence IN ('evidenced', 'unevidenced')),
  CONSTRAINT billing_unknown_resolutions_amounts CHECK (
    customer_amount_paise >= 0
    AND (provider_cost_paise IS NULL OR provider_cost_paise >= 0)
    AND (threshold_paise IS NULL OR threshold_paise >= 0)
    AND (charged_paise IS NULL OR charged_paise >= 0)
    AND (provider_cost_posted_paise IS NULL OR provider_cost_posted_paise >= 0)
  ),
  -- Provider cost only for an evidenced charge (D-76-1, O-1).
  CONSTRAINT billing_unknown_resolutions_cost_evidence CHECK (
    NOT post_provider_cost OR (action = 'charge' AND evidence = 'evidenced')
  ),
  -- An unevidenced charge is always dual-controlled; so is everything without a threshold (D-76-3).
  CONSTRAINT billing_unknown_resolutions_dual_control CHECK (
    dual_control OR (threshold_paise IS NOT NULL AND customer_amount_paise <= threshold_paise
                     AND NOT (action = 'charge' AND evidence = 'unevidenced'))
  ),
  CONSTRAINT billing_unknown_resolutions_reason CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  CONSTRAINT billing_unknown_resolutions_request_key CHECK (char_length(request_key) BETWEEN 1 AND 255),
  -- Requester and approver (and rejector) are different users (D-76-3).
  CONSTRAINT billing_unknown_resolutions_four_eyes CHECK (
    approved_by IS DISTINCT FROM requested_by AND rejected_by IS DISTINCT FROM requested_by
  ),
  CONSTRAINT billing_unknown_resolutions_refusal CHECK (
    (last_refusal IS NULL) = (last_refused_at IS NULL)
    AND (last_refusal IS NULL OR last_refusal IN ('insufficient_funds', 'account_frozen', 'account_not_configured'))
  ),
  CONSTRAINT billing_unknown_resolutions_state CHECK (
    CASE status
      WHEN 'pending' THEN executed_at IS NULL AND rejected_by IS NULL AND rejected_at IS NULL
                          AND rejection_reason IS NULL AND charged_paise IS NULL
                          AND provider_cost_posted_paise IS NULL
      WHEN 'executed' THEN executed_at IS NOT NULL AND rejected_by IS NULL
                           AND charged_paise IS NOT NULL AND provider_cost_posted_paise IS NOT NULL
                           AND (NOT dual_control OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
      WHEN 'rejected' THEN executed_at IS NULL AND approved_by IS NULL AND rejected_by IS NOT NULL
                           AND rejected_at IS NOT NULL
                           AND char_length(btrim(coalesce(rejection_reason, ''))) BETWEEN 1 AND 500
    END
  )
);
--> statement-breakpoint
-- Single resolution: at most one pending request and one executed resolution per message.
CREATE UNIQUE INDEX billing_unknown_resolutions_one_pending
  ON billing_unknown_resolutions (message_id) WHERE status = 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX billing_unknown_resolutions_one_executed
  ON billing_unknown_resolutions (message_id) WHERE status = 'executed';
--> statement-breakpoint
CREATE INDEX billing_unknown_resolutions_org_id_idx ON billing_unknown_resolutions (org_id);
--> statement-breakpoint
CREATE INDEX billing_unknown_resolutions_message_id_idx ON billing_unknown_resolutions (message_id);
--> statement-breakpoint

-- Only pending → executed and pending → rejected; while pending, only the approval and the
-- last refusal may be recorded. Nothing is ever deleted.
CREATE OR REPLACE FUNCTION fn_billing_unknown_resolutions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION '%: % is not permitted (financial records are append-only)', TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a % resolution is final', OLD.status USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.id, NEW.org_id, NEW.message_id, NEW.attempt_id, NEW.action, NEW.billing_policy,
      NEW.customer_amount_paise, NEW.provider_cost_paise, NEW.evidence, NEW.post_provider_cost,
      NEW.dual_control, NEW.threshold_paise, NEW.reason, NEW.request_key, NEW.requested_by,
      NEW.requested_at)
     IS DISTINCT FROM
     (OLD.id, OLD.org_id, OLD.message_id, OLD.attempt_id, OLD.action, OLD.billing_policy,
      OLD.customer_amount_paise, OLD.provider_cost_paise, OLD.evidence, OLD.post_provider_cost,
      OLD.dual_control, OLD.threshold_paise, OLD.reason, OLD.request_key, OLD.requested_by,
      OLD.requested_at) THEN
    RAISE EXCEPTION 'a resolution request is immutable once made' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.approved_by IS NOT NULL
     AND (NEW.approved_by, NEW.approved_at) IS DISTINCT FROM (OLD.approved_by, OLD.approved_at) THEN
    RAISE EXCEPTION 'an approval is recorded once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_billing_unknown_resolutions_guard BEFORE UPDATE OR DELETE ON billing_unknown_resolutions
  FOR EACH ROW EXECUTE FUNCTION fn_billing_unknown_resolutions_guard();
--> statement-breakpoint
CREATE TRIGGER trg_billing_unknown_resolutions_no_truncate BEFORE TRUNCATE ON billing_unknown_resolutions
  FOR EACH STATEMENT EXECUTE FUNCTION fn_billing_unknown_resolutions_guard();
--> statement-breakpoint
-- Deny by default: RLS on, no policy, no privilege for any application role.
ALTER TABLE billing_unknown_resolutions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE billing_unknown_resolutions FROM PUBLIC;
--> statement-breakpoint

-- --- 3. Assessment (owner-only helpers) ----------------------------------------------

-- The customer charge lines a charge resolution posts — the automatic path's fact identities:
-- under charge_per_logical_message one line, E_m on the message; under charge_per_attempt one
-- line per attempt that is the unknown attempt or is recorded as reaching the provider, E_a on
-- that attempt (D-76c-1). An amount is NULL when its evaluation is missing.
CREATE OR REPLACE FUNCTION app_billing_unknown_charge_lines(p_message_id uuid, p_unknown_attempt_id uuid)
RETURNS TABLE (anchor_id uuid, attempt_id uuid, amount_paise bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_policy billing_policy;
BEGIN
  SELECT m.billing_policy_snapshot INTO v_policy FROM messages m WHERE m.id = p_message_id;
  IF v_policy = 'charge_per_logical_message' THEN
    RETURN QUERY
    SELECT p_message_id, NULL::uuid,
           (SELECT e.total_customer_price_paise FROM pricing_evaluations e
             WHERE e.message_id = p_message_id AND e.subject = 'message');
  ELSIF v_policy = 'charge_per_attempt' THEN
    RETURN QUERY
    SELECT a.id, a.id, e.total_customer_price_paise
      FROM message_attempts a
      LEFT JOIN pricing_evaluations e ON e.message_attempt_id = a.id AND e.subject = 'attempt'
     WHERE a.message_id = p_message_id
       AND (a.id = p_unknown_attempt_id
            OR EXISTS (SELECT 1 FROM message_attempt_billing b
                        WHERE b.attempt_id = a.id AND b.reached_provider))
     ORDER BY a.attempt_number;
  END IF;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_billing_unknown_charge_lines(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint

-- The state a resolution is decided on, recomputed at request and again at execution: the
-- unknown attempt, the total customer amount, the attempt's evaluated provider cost and the
-- evidence (a provider receipt recorded on the unknown attempt, O-1).
CREATE OR REPLACE FUNCTION app_billing_unknown_assess(p_message_id uuid)
RETURNS TABLE (
  attempt_id uuid,
  customer_amount_paise bigint,
  provider_cost_paise bigint,
  evidence text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_attempt uuid;
  v_evidenced boolean := false;
  v_lines bigint;
  v_missing bigint;
  v_amount bigint;
  v_cost bigint;
BEGIN
  SELECT x.id, (x.delivery_status IN ('delivered', 'undelivered') OR x.read_at IS NOT NULL)
    INTO v_attempt, v_evidenced
    FROM message_attempts x
   WHERE x.message_id = p_message_id AND x.status = 'outcome_unknown'
   ORDER BY x.attempt_number DESC
   LIMIT 1;
  SELECT count(*), count(*) FILTER (WHERE l.amount_paise IS NULL), COALESCE(sum(l.amount_paise), 0)
    INTO v_lines, v_missing, v_amount
    FROM app_billing_unknown_charge_lines(p_message_id, v_attempt) l;
  IF v_lines = 0 OR v_missing > 0 THEN
    RAISE EXCEPTION 'the message lacks the evaluations a resolution needs' USING ERRCODE = 'BL010';
  END IF;
  IF v_attempt IS NOT NULL THEN
    SELECT e.total_provider_cost_paise INTO v_cost
      FROM pricing_evaluations e WHERE e.subject = 'attempt' AND e.message_attempt_id = v_attempt;
  END IF;
  RETURN QUERY SELECT v_attempt, v_amount, v_cost,
                      CASE WHEN COALESCE(v_evidenced, false) THEN 'evidenced' ELSE 'unevidenced' END;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_billing_unknown_assess(uuid) FROM PUBLIC;
--> statement-breakpoint

-- --- 4. Execution (owner-only; reached from request and approve) --------------------

CREATE OR REPLACE FUNCTION app_billing_resolve_unknown(p_resolution_id uuid)
RETURNS TABLE (charged_paise bigint, provider_cost_posted_paise bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  r billing_unknown_resolutions%ROWTYPE;
  v_message messages%ROWTYPE;
  v_now record;
  v_line record;
  v_account text;
  v_charged bigint := 0;
  v_cost bigint := 0;
BEGIN
  IF app_current_user_id() IS NULL OR NOT app_has_platform_permission('billing.manage') THEN
    RAISE EXCEPTION 'insufficient privilege to resolve an unknown outcome' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Lock order: resolution → message → unknown attempt → account (the writer, last).
  SELECT * INTO r FROM billing_unknown_resolutions x WHERE x.id = p_resolution_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolution not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'the resolution is %', r.status USING ERRCODE = 'BL010';
  END IF;
  IF r.dual_control AND r.approved_by IS NULL THEN
    RAISE EXCEPTION 'the resolution requires a second approver' USING ERRCODE = 'BL011';
  END IF;
  SELECT * INTO v_message FROM messages m WHERE m.id = r.message_id FOR NO KEY UPDATE;
  IF NOT (v_message.billing_enforced AND v_message.status = 'outcome_unknown') THEN
    RAISE EXCEPTION 'the message is no longer an unresolved unknown outcome' USING ERRCODE = 'BL012';
  END IF;
  IF r.attempt_id IS NOT NULL THEN
    -- Holds the attempt's evidence steady (a receipt updates the attempt row) until commit.
    PERFORM 1 FROM message_attempts a WHERE a.id = r.attempt_id FOR SHARE;
  END IF;

  -- The decision is bound to the request: the same attempt, amounts and evidence now.
  SELECT * INTO v_now FROM app_billing_unknown_assess(r.message_id);
  IF v_now.attempt_id IS DISTINCT FROM r.attempt_id
     OR v_now.customer_amount_paise IS DISTINCT FROM r.customer_amount_paise
     OR v_now.provider_cost_paise IS DISTINCT FROM r.provider_cost_paise
     OR v_now.evidence IS DISTINCT FROM r.evidence THEN
    RAISE EXCEPTION 'the outcome changed since the request' USING ERRCODE = 'BL012';
  END IF;

  IF r.action = 'charge' THEN
    v_account := CASE v_message.billing_mode_snapshot WHEN 'prepaid' THEN 'wallet' ELSE 'credit' END;
    FOR v_line IN SELECT * FROM app_billing_unknown_charge_lines(r.message_id, r.attempt_id) LOOP
      IF v_line.amount_paise > 0 THEN
        PERFORM 1 FROM app_ledger_post(
          v_message.org_id, 'customer_charge', v_line.anchor_id, v_line.amount_paise, v_account,
          v_message.id, v_line.attempt_id, v_message.correlation_id, 'outcome_unknown_resolved',
          'operator_resolution'
        );
        v_charged := v_charged + v_line.amount_paise;
      END IF;
    END LOOP;
    IF r.post_provider_cost THEN
      IF r.provider_cost_paise IS NULL THEN
        RAISE EXCEPTION 'the unknown attempt carries no provider cost' USING ERRCODE = 'BL008';
      END IF;
      IF r.provider_cost_paise > 0 THEN
        PERFORM 1 FROM app_ledger_post(
          v_message.org_id, 'provider_cost', r.attempt_id, r.provider_cost_paise, NULL,
          v_message.id, r.attempt_id, v_message.correlation_id, 'outcome_unknown_resolved'
        );
        v_cost := r.provider_cost_paise;
      END IF;
    END IF;
  END IF;

  UPDATE billing_unknown_resolutions x
     SET status = 'executed', executed_at = now(), charged_paise = v_charged,
         provider_cost_posted_paise = v_cost
   WHERE x.id = r.id;
  RETURN QUERY SELECT v_charged, v_cost;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_billing_resolve_unknown(uuid) FROM PUBLIC;
--> statement-breakpoint

-- --- 5. Entry points for acc_app --------------------------------------------------------

CREATE OR REPLACE FUNCTION app_billing_resolution_request(
  p_message_id uuid,
  p_action text,
  p_reason text,
  p_threshold_paise bigint,
  p_request_key text
)
RETURNS TABLE (resolution_id uuid, executed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_message messages%ROWTYPE;
  v_now record;
  v_dual boolean;
  v_id uuid;
BEGIN
  IF app_current_user_id() IS NULL OR NOT app_has_platform_permission('billing.manage') THEN
    RAISE EXCEPTION 'insufficient privilege to resolve an unknown outcome' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('charge', 'write_off') THEN
    RAISE EXCEPTION 'action must be charge or write_off' USING ERRCODE = 'invalid_parameter_value';
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

  -- No resolution row exists yet: the message is the first lock.
  SELECT * INTO v_message FROM messages m WHERE m.id = p_message_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'message not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF NOT (v_message.billing_enforced AND v_message.status = 'outcome_unknown') THEN
    RAISE EXCEPTION 'the message is not an unknown outcome under billing enforcement' USING ERRCODE = 'BL010';
  END IF;
  IF EXISTS (SELECT 1 FROM billing_unknown_resolutions x
              WHERE x.message_id = p_message_id AND x.status IN ('pending', 'executed')) THEN
    RAISE EXCEPTION 'the outcome is already resolved or awaiting approval' USING ERRCODE = 'BL010';
  END IF;
  IF EXISTS (SELECT 1 FROM usage_ledger l
              WHERE l.message_id = p_message_id AND l.entry_type = 'customer_charge') THEN
    RAISE EXCEPTION 'the message is already charged' USING ERRCODE = 'BL010';
  END IF;

  SELECT * INTO v_now FROM app_billing_unknown_assess(p_message_id);
  IF p_action = 'charge' AND v_now.evidence = 'evidenced' AND v_now.provider_cost_paise IS NULL THEN
    RAISE EXCEPTION 'the unknown attempt carries no evaluated provider cost' USING ERRCODE = 'BL010';
  END IF;
  v_dual :=p_threshold_paise IS NULL
            OR v_now.customer_amount_paise > p_threshold_paise
            OR (p_action = 'charge' AND v_now.evidence = 'unevidenced');

  INSERT INTO billing_unknown_resolutions (
    org_id, message_id, attempt_id, action, billing_policy, customer_amount_paise,
    provider_cost_paise, evidence, post_provider_cost, dual_control, threshold_paise, reason,
    request_key, requested_by
  ) VALUES (
    v_message.org_id, p_message_id, v_now.attempt_id, p_action, v_message.billing_policy_snapshot,
    v_now.customer_amount_paise, v_now.provider_cost_paise, v_now.evidence,
    p_action = 'charge' AND v_now.evidence = 'evidenced', v_dual, p_threshold_paise, btrim(p_reason),
    p_request_key, app_current_user_id()
  )
  RETURNING id INTO v_id;

  IF NOT v_dual THEN
    PERFORM 1 FROM app_billing_resolve_unknown(v_id);
  END IF;
  RETURN QUERY SELECT v_id, NOT v_dual;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_billing_resolution_request(uuid, text, text, bigint, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_billing_resolution_request(uuid, text, text, bigint, text) TO acc_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_billing_resolution_approve(p_resolution_id uuid, p_expected_amount_paise bigint)
RETURNS TABLE (charged_paise bigint, provider_cost_posted_paise bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  r billing_unknown_resolutions%ROWTYPE;
  v_user uuid := app_current_user_id();
BEGIN
  IF v_user IS NULL OR NOT app_has_platform_permission('billing.manage') THEN
    RAISE EXCEPTION 'insufficient privilege to resolve an unknown outcome' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO r FROM billing_unknown_resolutions x WHERE x.id = p_resolution_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolution not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'the resolution is %', r.status USING ERRCODE = 'BL010';
  END IF;
  IF r.requested_by = v_user THEN
    RAISE EXCEPTION 'the requester cannot approve their own request' USING ERRCODE = 'BL011';
  END IF;
  -- Bound to the exact amount the approver saw.
  IF p_expected_amount_paise IS DISTINCT FROM r.customer_amount_paise THEN
    RAISE EXCEPTION 'the approved amount does not match the request' USING ERRCODE = 'BL012';
  END IF;
  UPDATE billing_unknown_resolutions x SET approved_by = v_user, approved_at = now() WHERE x.id = r.id;
  RETURN QUERY SELECT * FROM app_billing_resolve_unknown(r.id);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_billing_resolution_approve(uuid, bigint) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_billing_resolution_approve(uuid, bigint) TO acc_app;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_billing_resolution_reject(p_resolution_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  r billing_unknown_resolutions%ROWTYPE;
  v_user uuid := app_current_user_id();
BEGIN
  IF v_user IS NULL OR NOT app_has_platform_permission('billing.manage') THEN
    RAISE EXCEPTION 'insufficient privilege to resolve an unknown outcome' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'a reason of 1 to 500 characters is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO r FROM billing_unknown_resolutions x WHERE x.id = p_resolution_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'resolution not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'the resolution is %', r.status USING ERRCODE = 'BL010';
  END IF;
  IF r.requested_by = v_user THEN
    RAISE EXCEPTION 'the requester cannot reject their own request' USING ERRCODE = 'BL011';
  END IF;
  UPDATE billing_unknown_resolutions x
     SET status = 'rejected', rejected_by = v_user, rejected_at = now(), rejection_reason = btrim(p_reason)
   WHERE x.id = r.id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_billing_resolution_reject(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_billing_resolution_reject(uuid, text) TO acc_app;
--> statement-breakpoint

-- After an approval was refused for funds or account state (and rolled back), records why on the
-- still-pending request. The refusal is re-derived here, never taken from the caller: nothing is
-- recorded unless the account is in fact frozen, missing or short of the request's amount.
CREATE OR REPLACE FUNCTION app_billing_resolution_note_refusal(p_resolution_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  r billing_unknown_resolutions%ROWTYPE;
  v_mode billing_mode;
  v_status billing_account_status;
  v_available bigint;
  v_refusal text;
BEGIN
  IF app_current_user_id() IS NULL OR NOT app_has_platform_permission('billing.manage') THEN
    RAISE EXCEPTION 'insufficient privilege to resolve an unknown outcome' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO r FROM billing_unknown_resolutions x WHERE x.id = p_resolution_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'pending' OR r.action <> 'charge' THEN
    RETURN NULL;
  END IF;
  SELECT m.billing_mode_snapshot INTO v_mode FROM messages m WHERE m.id = r.message_id;
  IF v_mode = 'prepaid' THEN
    SELECT w.status, w.balance_paise - w.reserved_paise INTO v_status, v_available
      FROM wallets w WHERE w.org_id = r.org_id;
  ELSE
    SELECT c.status, c.credit_limit_paise - c.used_paise - c.reserved_paise INTO v_status, v_available
      FROM credit_accounts c WHERE c.org_id = r.org_id;
  END IF;
  v_refusal := CASE
    WHEN v_status IS NULL THEN 'account_not_configured'
    WHEN v_status <> 'active' THEN 'account_frozen'
    WHEN v_available < r.customer_amount_paise THEN 'insufficient_funds'
  END;
  IF v_refusal IS NOT NULL THEN
    UPDATE billing_unknown_resolutions x
       SET last_refusal = v_refusal, last_refused_at = now()
     WHERE x.id = r.id;
  END IF;
  RETURN v_refusal;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_billing_resolution_note_refusal(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_billing_resolution_note_refusal(uuid) TO acc_app;
--> statement-breakpoint

-- Resolutions, newest first, by id cursor.
CREATE OR REPLACE FUNCTION app_billing_resolutions_list(
  p_id uuid,
  p_status text,
  p_org_id uuid,
  p_message_id uuid,
  p_before_id uuid,
  p_limit integer
)
RETURNS SETOF billing_unknown_resolutions
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
    RAISE EXCEPTION 'insufficient privilege for billing resolutions' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('pending', 'executed', 'rejected') THEN
    RAISE EXCEPTION 'invalid status filter' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT x.*
    FROM billing_unknown_resolutions x
   WHERE (p_id IS NULL OR x.id = p_id)
     AND (p_status IS NULL OR x.status = p_status)
     AND (p_org_id IS NULL OR x.org_id = p_org_id)
     AND (p_message_id IS NULL OR x.message_id = p_message_id)
     AND (p_before_id IS NULL OR x.id < p_before_id)
   ORDER BY x.id DESC
   LIMIT v_limit;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_billing_resolutions_list(uuid, text, uuid, uuid, uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_billing_resolutions_list(uuid, text, uuid, uuid, uuid, integer) TO acc_app;
--> statement-breakpoint

-- --- 6. The register (0056), same signatures and privileges ------------------------------
--
-- Status, in order: written_off (an executed write-off); charged / charged_without_cost (a
-- customer charge on the automatic anchor, with or without the unknown attempt's provider cost —
-- or an executed charge resolution that posted nothing because its amount was zero);
-- pending_approval (a pending request); open. A rejected request leaves the item open.
-- Under charge_per_attempt the customer exposure is what a charge would post (D-76c-1): the
-- unknown attempt's E_a plus that of every earlier attempt recorded as reaching the provider.
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
           CASE WHEN i.billing_policy = 'charge_per_attempt' THEN
             (SELECT sum(e.total_customer_price_paise)::bigint FROM pricing_evaluations e
               WHERE e.subject = 'attempt' AND e.message_id = i.message_id
                 AND (e.message_attempt_id = i.attempt_id
                      OR EXISTS (SELECT 1 FROM message_attempt_billing b
                                  WHERE b.attempt_id = e.message_attempt_id AND b.reached_provider)))
           ELSE
             (SELECT e.total_customer_price_paise FROM pricing_evaluations e
               WHERE e.subject = 'message' AND e.message_id = i.message_id
               LIMIT 1)
           END AS customer_exposure,
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
                 AND l.fact_kind = 'provider_cost')) AS costed,
           (SELECT x.action FROM billing_unknown_resolutions x
             WHERE x.message_id = i.message_id AND x.status = 'executed') AS executed_action,
           EXISTS (SELECT 1 FROM billing_unknown_resolutions x
                    WHERE x.message_id = i.message_id AND x.status = 'pending') AS pending
      FROM items i
  ),
  labelled AS (
    SELECT s.*,
           CASE WHEN s.evidenced THEN 'evidenced' ELSE 'unevidenced' END AS evidence_label,
           CASE
             WHEN s.executed_action = 'write_off' THEN 'written_off'
             WHEN (s.charged OR s.executed_action = 'charge') AND s.costed THEN 'charged'
             WHEN s.charged OR s.executed_action = 'charge' THEN 'charged_without_cost'
             WHEN s.pending THEN 'pending_approval'
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

-- Open items per channel: no customer charge on the automatic anchor (looked up by the ledger
-- fact's full key, partition-pruned, PR #97 review) and no executed resolution. A pending request
-- is still open (C-2); a written-off or charged item is not.
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
     AND NOT EXISTS (SELECT 1 FROM billing_unknown_resolutions x
                      WHERE x.message_id = m.id AND x.status = 'executed')
   GROUP BY 1;
END;
$$;
