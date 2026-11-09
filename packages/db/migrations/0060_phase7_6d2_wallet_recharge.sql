-- =============================================================================
-- Phase 7 PR 7-6d-2 — wallet recharge and ledger integration (DECISIONS.md
-- §1zi.13 D-76d-1 to D-76d-5; owner authorisation 09-Nov-2026;
-- docs/PHASE-7-6D-PROVISIONING-RECHARGE-HANDOVER.md Rev 2 §4, §6–§10).
--
-- A recharge records money received off-system (no payment integration): the
-- net spendable amount credited to the wallet, in INR paise (D-76d-2), with a
-- mandatory payment reference unique per organisation after normalisation.
--
-- 1. billing_account_operations gains the recharge kind and its columns
--    (payment reference and its generated normalised form, received date, the
--    ledger row produced) and the approval-refusal columns. Expand-only: the
--    7-6d-1 CHECKs are widened, never loosened for the existing kinds.
-- 2. The ledger writer gains a recharge branch (CREATE OR REPLACE, same
--    signature and privileges); every other branch is unchanged. It posts one
--    fact anchored on the recharge operation, so a repeat is a no-op; the
--    wallet balance rises, reserved is unchanged; a frozen wallet is refused
--    (BL002). Only the 7-6d executor posts it.
-- 3. Definers for acc_app: app_billing_account_request_recharge,
--    app_billing_account_approve_recharge (binds amount and evidence) and
--    app_billing_account_note_refusal. The executor gains the recharge branch;
--    the generic approval refuses a recharge. Nothing else of 0059 changes.
-- 4. The tenant SELECT policy on usage_ledger admits recharge (D-76d-3): the
--    fact carries no message, correlation or note, so a tenant sees its amount
--    and time only. provider_cost stays invisible.
--
-- Dual control (D-76d-1): a recharge waits for a second approver when the
-- threshold (BILLING_DUAL_CONTROL_THRESHOLD_PAISE, server configuration,
-- recorded on the row) is unset or below the amount. No reversal (D-76d-5).
-- Lock order: operation (FOR UPDATE) → organisation (FOR KEY SHARE) → wallet
-- (last). Invariant D holds: no dynamic SQL, set_config or ALTER in a definer.
-- =============================================================================

-- --- 1. Recharge columns and constraints ----------------------------------------------

ALTER TABLE billing_account_operations
  ADD COLUMN payment_reference text,
  ADD COLUMN payment_reference_normalized text
    GENERATED ALWAYS AS (upper(regexp_replace(payment_reference, '[[:space:]]', '', 'g'))) STORED,
  ADD COLUMN received_on date,
  ADD COLUMN result_ledger_id uuid,
  ADD COLUMN last_refusal text,
  ADD COLUMN last_refused_at timestamptz;
--> statement-breakpoint
ALTER TABLE billing_account_operations DROP CONSTRAINT billing_account_operations_kind;
--> statement-breakpoint
ALTER TABLE billing_account_operations ADD CONSTRAINT billing_account_operations_kind CHECK (
  kind IN ('provision', 'credit_limit_change', 'freeze', 'unfreeze', 'recharge')
);
--> statement-breakpoint
ALTER TABLE billing_account_operations DROP CONSTRAINT billing_account_operations_amounts;
--> statement-breakpoint
-- A recharge is a wallet amount above zero; the 7-6d-1 rules for the other kinds are unchanged.
ALTER TABLE billing_account_operations ADD CONSTRAINT billing_account_operations_amounts CHECK (
  CASE
    WHEN kind = 'credit_limit_change'
      THEN account = 'credit_account'
           AND amount_paise IS NOT NULL AND amount_paise >= 0
           AND previous_limit_paise IS NOT NULL AND previous_limit_paise >= 0
           AND amount_paise <> previous_limit_paise
    WHEN kind = 'recharge'
      THEN account = 'wallet' AND amount_paise IS NOT NULL AND amount_paise > 0
           AND previous_limit_paise IS NULL
    ELSE amount_paise IS NULL AND previous_limit_paise IS NULL
  END
);
--> statement-breakpoint
ALTER TABLE billing_account_operations DROP CONSTRAINT billing_account_operations_dual_control;
--> statement-breakpoint
ALTER TABLE billing_account_operations ADD CONSTRAINT billing_account_operations_dual_control CHECK (
  CASE kind
    WHEN 'unfreeze' THEN dual_control
    WHEN 'credit_limit_change' THEN
      dual_control
      OR amount_paise < previous_limit_paise
      OR (threshold_paise IS NOT NULL AND amount_paise - previous_limit_paise <= threshold_paise)
    WHEN 'recharge' THEN
      dual_control OR (threshold_paise IS NOT NULL AND amount_paise <= threshold_paise)
    ELSE NOT dual_control
  END
);
--> statement-breakpoint
-- The evidence: present, well-formed and only on a recharge; received on a past or current date.
ALTER TABLE billing_account_operations ADD CONSTRAINT billing_account_operations_evidence CHECK (
  CASE WHEN kind = 'recharge'
    THEN payment_reference IS NOT NULL
         AND payment_reference ~ '^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,119}$'
         AND char_length(payment_reference_normalized) >= 1
         AND received_on IS NOT NULL
    ELSE payment_reference IS NULL AND received_on IS NULL AND result_ledger_id IS NULL
  END
);
--> statement-breakpoint
ALTER TABLE billing_account_operations ADD CONSTRAINT billing_account_operations_recharge_result CHECK (
  NOT (kind = 'recharge' AND status = 'executed') OR result_ledger_id IS NOT NULL
);
--> statement-breakpoint
ALTER TABLE billing_account_operations ADD CONSTRAINT billing_account_operations_refusal CHECK (
  (last_refusal IS NULL) = (last_refused_at IS NULL)
  AND (last_refusal IS NULL OR (kind = 'recharge' AND last_refusal IN ('account_frozen', 'account_not_configured')))
);
--> statement-breakpoint
-- One receipt credits at most once: unique per organisation among pending and executed recharges,
-- after normalisation (whitespace removed, upper case).
CREATE UNIQUE INDEX billing_account_operations_payment_reference
  ON billing_account_operations (org_id, payment_reference_normalized)
  WHERE kind = 'recharge' AND status IN ('pending', 'executed');
--> statement-breakpoint

-- The 7-6d-1 guard, with the recharge evidence among the immutable request columns.
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
      NEW.requested_at, NEW.payment_reference, NEW.received_on)
     IS DISTINCT FROM
     (OLD.id, OLD.org_id, OLD.account, OLD.kind, OLD.amount_paise, OLD.previous_limit_paise,
      OLD.dual_control, OLD.threshold_paise, OLD.reason, OLD.request_key, OLD.requested_by,
      OLD.requested_at, OLD.payment_reference, OLD.received_on) THEN
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

-- --- 2. The ledger writer's recharge branch -------------------------------------------------

CREATE OR REPLACE FUNCTION app_ledger_post(
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
     OR p_entry_type NOT IN ('reservation', 'reservation_release', 'customer_charge', 'provider_cost', 'recharge') THEN
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

  -- >>> Phase 7 PR 7-6d-2: the wallet recharge (D-76d-2), handled entirely here. Every other entry
  -- type continues below exactly as before.
  IF p_entry_type = 'recharge' THEN
    -- Wallet only; no message, attempt, correlation or note: nothing internal reaches the tenant
    -- view (D-76d-3). The anchor is the executing recharge operation.
    IF p_org_id IS NULL OR p_anchor_id IS NULL OR p_account IS DISTINCT FROM 'wallet'
       OR p_message_id IS NOT NULL OR p_message_attempt_id IS NOT NULL
       OR p_correlation_id IS NOT NULL OR p_reference_note IS NOT NULL THEN
      RAISE EXCEPTION 'a recharge is a wallet fact anchored on its operation, with no message, correlation or note'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF p_amount_paise IS NULL OR p_amount_paise <= 0 THEN
      RAISE EXCEPTION 'amount must be a positive number of paise' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_month := app_uuidv7_month(p_anchor_id);
    IF v_month IS NULL THEN
      RAISE EXCEPTION 'anchor is not a UUIDv7' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Only a pending recharge operation of this organisation, for exactly this amount and approved
    -- when dual control applies, may post (checked under the operation lock its executor holds).
    IF NOT EXISTS (
      SELECT 1 FROM billing_account_operations o
       WHERE o.id = p_anchor_id AND o.org_id = p_org_id AND o.kind = 'recharge' AND o.account = 'wallet'
         AND o.status = 'pending' AND o.amount_paise = p_amount_paise
         AND (NOT o.dual_control OR o.approved_by IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'a recharge requires its executing recharge operation' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT o.reseller_id INTO v_reseller FROM organizations o WHERE o.id = p_org_id;
    -- The wallet: the last row lock (account-last rule).
    SELECT * INTO v_wallet FROM wallets w WHERE w.org_id = p_org_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'organization has no wallet' USING ERRCODE = 'BL001';
    END IF;
    IF v_wallet.status <> 'active' THEN
      RAISE EXCEPTION 'billing account is not active' USING ERRCODE = 'BL002';
    END IF;
    SELECT l.id, l.amount_paise INTO v_existing_id, v_existing_amount
      FROM usage_ledger l
     WHERE l.anchor_month = v_month AND l.anchor_id = p_anchor_id AND l.fact_kind = 'recharge';
    IF FOUND THEN
      RETURN QUERY SELECT false, v_existing_id, v_existing_amount;
      RETURN;
    END IF;
    INSERT INTO usage_ledger (
      anchor_month, anchor_id, fact_kind, entry_type, org_id, reseller_id, wallet_id, amount_paise
    ) VALUES (
      v_month, p_anchor_id, 'recharge', 'recharge', p_org_id, v_reseller, v_wallet.id, p_amount_paise
    )
    ON CONFLICT (anchor_month, anchor_id, fact_kind) DO NOTHING
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN
      SELECT l.id, l.amount_paise INTO v_existing_id, v_existing_amount
        FROM usage_ledger l
       WHERE l.anchor_month = v_month AND l.anchor_id = p_anchor_id AND l.fact_kind = 'recharge';
      RETURN QUERY SELECT false, v_existing_id, v_existing_amount;
      RETURN;
    END IF;
    -- Balance up; the reservation is untouched.
    UPDATE wallets SET balance_paise = balance_paise + p_amount_paise, version = version + 1 WHERE id = v_wallet.id;
    RETURN QUERY SELECT true, v_id, p_amount_paise;
    RETURN;
  END IF;
  -- <<< Phase 7 PR 7-6d-2

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

-- --- 3. Execution and approval ---------------------------------------------------------------

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
  -- >>> Phase 7 PR 7-6d-2: one immutable ledger fact, anchored on this operation; balance up,
  -- reserved unchanged (the writer's recharge branch, which also refuses a frozen wallet).
  ELSIF r.kind = 'recharge' THEN
    SELECT p.ledger_id INTO v_id
      FROM app_ledger_post(r.org_id, 'recharge', r.id, r.amount_paise, 'wallet', NULL, NULL, NULL, NULL) p;
    UPDATE billing_account_operations x SET result_ledger_id = v_id WHERE x.id = r.id;
    -- <<< Phase 7 PR 7-6d-2
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
  -- >>> Phase 7 PR 7-6d-2: a recharge is approved only through app_billing_account_approve_recharge,
  -- which binds the evidence snapshot as well as the amount.
  IF r.kind = 'recharge' THEN
    RAISE EXCEPTION 'a recharge is approved with its evidence' USING ERRCODE = 'BL014';
  END IF;
  -- <<< Phase 7 PR 7-6d-2
  -- Bound to the exact amount the approver saw (none for an operation without one).
  IF p_expected_amount_paise IS DISTINCT FROM r.amount_paise THEN
    RAISE EXCEPTION 'the approved amount does not match the request' USING ERRCODE = 'BL014';
  END IF;
  UPDATE billing_account_operations x SET approved_by = v_user, approved_at = now() WHERE x.id = r.id;
  PERFORM app_billing_account_execute(r.id);
END;
$$;
--> statement-breakpoint

-- A recharge request: the wallet must exist and be active (a frozen wallet is refused, D-76d-4),
-- the payment reference unused (after normalisation); dual control per D-76d-1.
CREATE OR REPLACE FUNCTION app_billing_account_request_recharge(
  p_org_id uuid,
  p_amount_paise bigint,
  p_payment_reference text,
  p_received_on date,
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
  v_status billing_account_status;
  v_dual boolean;
  v_id uuid;
BEGIN
  IF app_current_user_id() IS NULL OR NOT app_has_platform_permission('billing.manage') THEN
    RAISE EXCEPTION 'insufficient privilege for billing account operations' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_amount_paise IS NULL OR p_amount_paise <= 0 THEN
    RAISE EXCEPTION 'a recharge amount must be a positive number of paise' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_payment_reference IS NULL OR p_payment_reference !~ '^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,119}$' THEN
    RAISE EXCEPTION 'a payment reference of 1 to 120 permitted characters is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_received_on IS NULL OR p_received_on > current_date THEN
    RAISE EXCEPTION 'the received date is required and cannot be in the future' USING ERRCODE = 'invalid_parameter_value';
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

  SELECT o.status INTO v_org_status FROM organizations o WHERE o.id = p_org_id FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_org_status = 'closed' THEN
    RAISE EXCEPTION 'the organization is closed' USING ERRCODE = 'BL013';
  END IF;
  SELECT w.status INTO v_status FROM wallets w WHERE w.org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the organization has no wallet' USING ERRCODE = 'BL013';
  END IF;
  IF v_status <> 'active' THEN
    RAISE EXCEPTION 'the wallet is frozen' USING ERRCODE = 'BL002';
  END IF;
  IF EXISTS (SELECT 1 FROM billing_account_operations x
              WHERE x.org_id = p_org_id AND x.kind = 'recharge' AND x.status IN ('pending', 'executed')
                AND x.payment_reference_normalized = upper(regexp_replace(p_payment_reference, '[[:space:]]', '', 'g'))) THEN
    RAISE EXCEPTION 'the payment reference is already used' USING ERRCODE = 'BL013';
  END IF;
  IF EXISTS (SELECT 1 FROM billing_account_operations x
              WHERE x.org_id = p_org_id AND x.account = 'wallet' AND x.kind = 'recharge' AND x.status = 'pending') THEN
    RAISE EXCEPTION 'a recharge is already pending' USING ERRCODE = 'BL013';
  END IF;

  v_dual := p_threshold_paise IS NULL OR p_amount_paise > p_threshold_paise;

  INSERT INTO billing_account_operations (
    org_id, account, kind, amount_paise, dual_control, threshold_paise, reason, request_key,
    requested_by, payment_reference, received_on
  ) VALUES (
    p_org_id, 'wallet', 'recharge', p_amount_paise, v_dual, p_threshold_paise, btrim(p_reason),
    p_request_key, app_current_user_id(), p_payment_reference, p_received_on
  )
  RETURNING id INTO v_id;

  IF NOT v_dual THEN
    PERFORM app_billing_account_execute(v_id);
  END IF;
  RETURN QUERY SELECT v_id, NOT v_dual;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_billing_account_request_recharge(uuid, bigint, text, date, text, bigint, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_billing_account_request_recharge(uuid, bigint, text, date, text, bigint, text) TO acc_app;
--> statement-breakpoint

-- A recharge approval, bound to the exact amount and evidence snapshot the approver saw.
CREATE OR REPLACE FUNCTION app_billing_account_approve_recharge(
  p_operation_id uuid,
  p_expected_amount_paise bigint,
  p_expected_payment_reference text,
  p_expected_received_on date
)
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
  IF r.kind <> 'recharge' THEN
    RAISE EXCEPTION 'not a recharge' USING ERRCODE = 'BL014';
  END IF;
  IF r.status <> 'pending' THEN
    RAISE EXCEPTION 'the account operation is %', r.status USING ERRCODE = 'BL013';
  END IF;
  IF r.requested_by = v_user THEN
    RAISE EXCEPTION 'the requester cannot approve their own request' USING ERRCODE = 'BL011';
  END IF;
  IF p_expected_amount_paise IS DISTINCT FROM r.amount_paise
     OR upper(regexp_replace(coalesce(p_expected_payment_reference, ''), '[[:space:]]', '', 'g'))
        IS DISTINCT FROM r.payment_reference_normalized
     OR p_expected_received_on IS DISTINCT FROM r.received_on THEN
    RAISE EXCEPTION 'the approval does not match the request' USING ERRCODE = 'BL014';
  END IF;
  UPDATE billing_account_operations x SET approved_by = v_user, approved_at = now() WHERE x.id = r.id;
  PERFORM app_billing_account_execute(r.id);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_billing_account_approve_recharge(uuid, bigint, text, date) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_billing_account_approve_recharge(uuid, bigint, text, date) TO acc_app;
--> statement-breakpoint

-- After an approval was refused for the wallet's state (and rolled back), records why on the
-- still-pending recharge. Re-derived here, never taken from the caller: nothing is recorded unless
-- the wallet is in fact missing or frozen.
CREATE OR REPLACE FUNCTION app_billing_account_note_refusal(p_operation_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  r billing_account_operations%ROWTYPE;
  v_status billing_account_status;
  v_refusal text;
BEGIN
  IF app_current_user_id() IS NULL OR NOT app_has_platform_permission('billing.manage') THEN
    RAISE EXCEPTION 'insufficient privilege for billing account operations' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO r FROM billing_account_operations x WHERE x.id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'pending' OR r.kind <> 'recharge' THEN
    RETURN NULL;
  END IF;
  SELECT w.status INTO v_status FROM wallets w WHERE w.org_id = r.org_id;
  v_refusal := CASE
    WHEN v_status IS NULL THEN 'account_not_configured'
    WHEN v_status <> 'active' THEN 'account_frozen'
  END;
  IF v_refusal IS NOT NULL THEN
    UPDATE billing_account_operations x
       SET last_refusal = v_refusal, last_refused_at = now()
     WHERE x.id = r.id;
  END IF;
  RETURN v_refusal;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_billing_account_note_refusal(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_billing_account_note_refusal(uuid) TO acc_app;
--> statement-breakpoint

-- --- 4. Tenant visibility of recharges (D-76d-3) ----------------------------------------------
-- The 0055 policy, with recharge added to the visible entry types; otherwise identical.
DROP POLICY usage_ledger_tenant_select ON usage_ledger;
--> statement-breakpoint
CREATE POLICY usage_ledger_tenant_select ON usage_ledger FOR SELECT TO acc_app
  USING (
    org_id = app_current_org_id()
    AND (SELECT app_content_context_valid())
    AND entry_type IN ('reservation', 'reservation_release', 'customer_charge', 'recharge')
  );
