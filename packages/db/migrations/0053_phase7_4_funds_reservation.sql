-- =============================================================================
-- Phase 7 PR 7-4 — funds reservation at submission (DECISIONS.md §1zi.7;
-- docs/PHASE-7-4-RESERVATION-HANDOVER.md, owner-approved 09-Nov-2026 with
-- D-74-1 … D-74-4).
--
-- Expand-only. No Phase 7.1 or 7.2 object is altered or granted:
-- app_ledger_post, app_rate_message and app_price_lookup stay executable by no
-- application role, and no financial table gains a policy or privilege.
--
-- 1. messages: billable units (always set by the submission core from this
--    migration on) and the billing snapshot (set only when the submission ran
--    under billing enforcement). All six columns are immutable after insert.
-- 2. app_message_reserve(message_id): the sole reservation entry point of the
--    application role. SECURITY DEFINER with a caller check first; every
--    financial input (organization, channel, units, account, policy, amount) is
--    derived from database state, never from the caller. It posts only a
--    `reservation` fact anchored on the message, through the 7.1 writer.
--
-- No SECURITY DEFINER function here runs dynamic SQL, alters anything or sets a
-- variable (tenant-context-trust invariant D).
-- =============================================================================

ALTER TABLE messages
  ADD COLUMN billable_units integer,
  ADD COLUMN billable_unit pricing_unit,
  ADD COLUMN sms_encoding text,
  ADD COLUMN billing_enforced boolean NOT NULL DEFAULT false,
  ADD COLUMN billing_mode_snapshot billing_mode,
  ADD COLUMN billing_policy_snapshot billing_policy;
--> statement-breakpoint
-- Units: a positive count and its unit, both or neither (neither only on rows
-- created before this migration); a per-message unit is exactly 1; SMS carries
-- its encoding and nothing else does.
ALTER TABLE messages
  ADD CONSTRAINT messages_billable_units_range
    CHECK (billable_units IS NULL OR billable_units BETWEEN 1 AND 1000000),
  ADD CONSTRAINT messages_billable_units_pair
    CHECK ((billable_units IS NULL) = (billable_unit IS NULL)),
  ADD CONSTRAINT messages_billable_unit_message
    CHECK (billable_unit IS DISTINCT FROM 'message' OR billable_units = 1),
  ADD CONSTRAINT messages_sms_encoding
    CHECK (
      (sms_encoding IS NULL OR sms_encoding IN ('GSM-7', 'UCS-2'))
      AND ((sms_encoding IS NOT NULL) = (billable_unit IS NOT DISTINCT FROM 'sms_segment'))
    ),
  -- The snapshot exists exactly when the submission ran under enforcement, and
  -- an enforced message always has its units.
  ADD CONSTRAINT messages_billing_snapshot
    CHECK (
      billing_enforced = (billing_mode_snapshot IS NOT NULL)
      AND billing_enforced = (billing_policy_snapshot IS NOT NULL)
      AND (NOT billing_enforced OR billable_units IS NOT NULL)
    );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION fn_messages_billing_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'messages: billable units and the billing snapshot are immutable'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_messages_billing_immutable() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER trg_messages_billing_immutable
  BEFORE UPDATE ON messages FOR EACH ROW
  WHEN (
    (OLD.billable_units, OLD.billable_unit, OLD.sms_encoding, OLD.billing_enforced,
     OLD.billing_mode_snapshot, OLD.billing_policy_snapshot)
    IS DISTINCT FROM
    (NEW.billable_units, NEW.billable_unit, NEW.sms_encoding, NEW.billing_enforced,
     NEW.billing_mode_snapshot, NEW.billing_policy_snapshot)
  )
  EXECUTE FUNCTION fn_messages_billing_immutable();
--> statement-breakpoint

-- --- The reservation entry point -------------------------------------------------
--
-- Called by the submission core as its last step, in the submission's own
-- transaction, for a message it has just inserted with billing_enforced = true.
--
-- Caller check (the writer and the rating functions bypass RLS, so this is
-- mandatory): a valid tenant content context (an active organization-level user
-- or an unrevoked API key of the organization, app_content_context_valid) and a
-- message of that organization; otherwise 42501, before any money is read.
--
-- Sizing (BILLING.md §§5, 8; handover §6):
--   charge_per_logical_message  E_m = app_rate_message(message subject), the
--                               charge 7-5 will post; its evaluation is recorded.
--   charge_per_attempt          N × max price over the N distinct providers with
--                               an active assignment for (organization, channel)
--                               — the dispatcher's candidates — priced read-only
--                               with app_price_lookup; nothing is recorded.
-- A missing price fails closed (BL007). A zero amount posts nothing (the writer
-- refuses amounts ≤ 0); the message proceeds.
--
-- Account: the message's snapshot mode (prepaid → wallet, postpaid → credit
-- account), which must equal the organization's settings read FOR SHARE here, so
-- no settings change can commit between this check and the reservation's commit;
-- a change between the core's read and this one is a serialization failure
-- (40001), so the request is retried rather than reserved under settings it was
-- not sized for. Lock order: organization (share) → message → account (last). Funds, account presence and status are checked by the writer under the
-- account lock (BL001, BL002, BL003). The account is the last row lock taken.
--
-- Idempotent: a repeated call returns the existing evaluation and fact
-- (inserted = false) and changes nothing.
CREATE OR REPLACE FUNCTION app_message_reserve(p_message_id uuid)
RETURNS TABLE (reserved_paise bigint, inserted boolean, evaluation_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := nullif(current_setting('app.current_org_id', true), '')::uuid;
  v_message messages%ROWTYPE;
  v_mode billing_mode;
  v_policy billing_policy;
  v_unit pricing_unit;
  v_eval uuid;
  v_amount bigint;
  v_candidates integer := 0;
  v_max bigint := 0;
  v_price bigint;
  v_provider uuid;
  v_inserted boolean;
  v_posted bigint;
BEGIN
  -- 1. Caller.
  IF p_message_id IS NULL THEN
    RAISE EXCEPTION 'a message is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_org IS NULL OR NOT app_content_context_valid() THEN
    RAISE EXCEPTION 'reservation requires a valid tenant content context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_message FROM messages msg WHERE msg.id = p_message_id AND msg.org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'message is not in the current organization' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 2. The message must have been submitted under enforcement, with its units.
  IF NOT v_message.billing_enforced
     OR v_message.billing_mode_snapshot IS NULL
     OR v_message.billing_policy_snapshot IS NULL
     OR v_message.billable_units IS NULL THEN
    RAISE EXCEPTION 'message was not submitted under billing enforcement'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_unit := app_pricing_unit_for_channel(v_message.channel_id);
  IF v_unit IS NULL OR v_unit <> v_message.billable_unit THEN
    RAISE EXCEPTION 'message units do not match its channel' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 3. The snapshot must still be the organization's billing settings, and must stay
  -- so until this transaction commits. FOR SHARE conflicts with the FOR UPDATE /
  -- UPDATE of PATCH /organizations/:id (the only path that changes them), so the
  -- two serialise: a change already in progress is waited for (bounded by the
  -- caller's lock_timeout) and then seen here, refusing the stale snapshot (40001);
  -- a change that starts later waits until this reservation has committed. It is
  -- taken before the message and account locks, so the billing account stays the
  -- last row lock (DECISIONS.md §1zi.1), and it does not conflict with the
  -- FOR KEY SHARE locks that inserts referencing the organization take.
  SELECT o.billing_mode, o.billing_policy INTO v_mode, v_policy
    FROM organizations o WHERE o.id = v_org
     FOR SHARE;
  IF (v_mode, v_policy) IS DISTINCT FROM (v_message.billing_mode_snapshot, v_message.billing_policy_snapshot) THEN
    RAISE EXCEPTION 'billing settings changed during submission' USING ERRCODE = 'serialization_failure';
  END IF;

  -- 4. Size.
  IF v_message.billing_policy_snapshot = 'charge_per_logical_message' THEN
    SELECT r.evaluation_id, r.total_customer_price_paise INTO v_eval, v_amount
      FROM app_rate_message(v_org, v_message.id, NULL, v_message.billable_units, true, false) r;
  ELSE
    FOR v_provider IN
      SELECT DISTINCT a.provider_id
        FROM organization_provider_assignments a
       WHERE a.org_id = v_org AND a.channel_id = v_message.channel_id AND a.status = 'active'
       ORDER BY a.provider_id
    LOOP
      SELECT l.customer_price_paise INTO v_price
        FROM app_price_lookup(v_org, v_message.channel_id, v_provider, v_message.billable_units,
                              now(), true, false) l;
      v_candidates := v_candidates + 1;
      v_max := greatest(v_max, v_price);
    END LOOP;
    IF v_candidates = 0 THEN
      -- The core checked for an active assignment in this transaction; one was
      -- withdrawn concurrently. A retry is refused by that check.
      RAISE EXCEPTION 'no active provider assignment for the channel' USING ERRCODE = 'serialization_failure';
    END IF;
    v_amount := v_candidates::bigint * v_max;
  END IF;

  -- 5. Reserve (nothing for a zero amount).
  IF v_amount = 0 THEN
    RETURN QUERY SELECT 0::bigint, false, v_eval;
    RETURN;
  END IF;
  SELECT p.inserted, p.amount_paise INTO v_inserted, v_posted
    FROM app_ledger_post(
      v_org, 'reservation', v_message.id, v_amount,
      CASE v_message.billing_mode_snapshot WHEN 'prepaid' THEN 'wallet' ELSE 'credit' END,
      v_message.id, NULL, v_message.correlation_id, NULL
    ) p;
  RETURN QUERY SELECT v_posted, v_inserted, v_eval;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_message_reserve(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_message_reserve(uuid) TO acc_app;
