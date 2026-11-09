-- =============================================================================
-- Phase 7 PR 7-5 — settlement and the reservation lifecycle (DECISIONS.md
-- §1zi.8; owner authorisation 09-Nov-2026; baseline §§6.2, 6.5, 9.2, 9.3;
-- OD-7-2, OD-7-4, OD-7-4U, RQ-2 and D-74-3).
--
-- Expand-only. No Phase 7.1, 7.2 or 7.4 object is altered or granted:
-- app_ledger_post, app_rate_message, app_price_lookup and app_message_reserve
-- keep exactly their grants. The dispatcher reaches money only through the
-- three functions below, executable by acc_dispatch alone. Each verifies the
-- caller's live dispatch claim under the queue-row lock first, derives every
-- amount from database state and posts through the 7.1 writer, whose fact keys
-- make every posting idempotent.
--
-- 1. message_attempt_billing: the immutable record of whether a settled attempt
--    reached the provider. message_attempts rows are frozen once terminal
--    (fn_message_attempts_terminal_guard), so the classification lives here.
-- 2. app_dispatch_attempt_reserve(attempt, units)  — T2, before the provider call:
--    re-checks the billable units, rates the attempt (E_a) and, under
--    charge_per_attempt, tops up the reservation when the remaining reservation
--    is below this attempt's price (D-74-3).
-- 3. app_dispatch_attempt_settle(attempt, reached) — T3/TR, as an attempt
--    settles: records the classification and, for an attempt that reached the
--    provider, its provider_cost. An outcome_unknown attempt is never "reached"
--    (OD-7-4U): no provider cost.
-- 4. app_dispatch_message_settle()                 — every terminal site:
--    on a confirmed accepted chain, the customer charge(s); then the release of
--    whatever is still reserved. Failed and outcome_unknown chains are never
--    charged (OD-7-4, OD-7-4U; failed-delivery fee 0).
--
-- Lock order (§1zi.1): queue row (the dispatcher's fence, FOR UPDATE) → message
-- → [provider, attempt in T3] → billing account (taken last, by the writer) →
-- new rows only. No SECURITY DEFINER function here runs dynamic SQL, alters
-- anything or sets a variable (tenant-context-trust invariant D).
-- =============================================================================

CREATE TABLE message_attempt_billing (
  attempt_id uuid PRIMARY KEY REFERENCES message_attempts(id) ON DELETE RESTRICT,
  message_id uuid NOT NULL,
  org_id uuid NOT NULL,
  reached_provider boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_attempt_billing_message_fkey FOREIGN KEY (message_id, org_id)
    REFERENCES messages(id, org_id) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX message_attempt_billing_message_id_idx ON message_attempt_billing (message_id);
--> statement-breakpoint
CREATE TRIGGER trg_message_attempt_billing_immutable BEFORE UPDATE OR DELETE ON message_attempt_billing
  FOR EACH ROW EXECUTE FUNCTION fn_billing_immutable();
--> statement-breakpoint
CREATE TRIGGER trg_message_attempt_billing_no_truncate BEFORE TRUNCATE ON message_attempt_billing
  FOR EACH STATEMENT EXECUTE FUNCTION fn_billing_immutable();
--> statement-breakpoint
-- Deny by default: RLS on, no policy, no privilege for any application role.
ALTER TABLE message_attempt_billing ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE message_attempt_billing FROM PUBLIC;
--> statement-breakpoint

-- --- The live-claim check --------------------------------------------------------
--
-- The message bound to this transaction by app.dispatch_message_id, provided the
-- queue row still carries app.dispatch_claim_token with an unexpired lease —
-- read FOR UPDATE, so a stale worker (superseded epoch or token) is refused and
-- lease recovery (SKIP LOCKED) cannot take the row from under the caller.
-- Executable by the schema owner only; called by the definers below.
CREATE OR REPLACE FUNCTION app_dispatch_billing_claim() RETURNS messages
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_message_id uuid := app_dispatch_message_id();
  v_org uuid := nullif(current_setting('app.current_org_id', true), '')::uuid;
  v_message messages%ROWTYPE;
BEGIN
  IF v_message_id IS NULL OR app_dispatch_claim_token() IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'settlement requires a dispatch claim' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM message_dispatch_queue q
   WHERE q.message_id = v_message_id
     AND q.claim_token = app_dispatch_claim_token()
     AND q.claimed_until > now()
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no live dispatch claim for the message' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v_message FROM messages m WHERE m.id = v_message_id AND m.org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the claimed message is not in the organization' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT v_message.billing_enforced THEN
    RAISE EXCEPTION 'message was not submitted under billing enforcement' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN v_message;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_dispatch_billing_claim() FROM PUBLIC;
--> statement-breakpoint

-- --- T2: rate the attempt and top up the reservation (D-74-3) -----------------
--
-- Called after the attempt row is inserted and before COMMIT of the intent
-- transaction, so a refusal happens before any provider call. p_units is the
-- dispatch-time re-derivation of the billable units; it must equal the units
-- persisted at submission (BL009 otherwise).
--
-- Rating (once per attempt; app_rate_message never re-rates): provider cost
-- always; the customer price only under charge_per_attempt. BL007 / BL008 fail
-- closed.
--
-- Top-up (charge_per_attempt): customer charges are posted only when the chain
-- ends accepted, so the remaining reservation is Σ reservations − Σ releases −
-- the prices of every earlier rated attempt of the message (conservatively,
-- whether or not it will be charged). When this attempt's price exceeds it, a
-- `reservation` fact anchored on the attempt covers the difference; the writer
-- checks funds under the account lock (BL003; BL001 / BL002 for the account).
CREATE OR REPLACE FUNCTION app_dispatch_attempt_reserve(p_attempt_id uuid, p_units integer)
RETURNS TABLE (topped_up_paise bigint, customer_price_paise bigint, provider_cost_paise bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_message messages%ROWTYPE;
  v_status text;
  v_per_attempt boolean;
  v_price bigint;
  v_cost bigint;
  v_reserved bigint;
  v_released bigint;
  v_prior bigint;
  v_needed bigint := 0;
BEGIN
  v_message := app_dispatch_billing_claim();
  SELECT a.status::text INTO v_status
    FROM message_attempts a WHERE a.id = p_attempt_id AND a.message_id = v_message.id;
  IF v_status IS NULL OR v_status <> 'submitting' THEN
    RAISE EXCEPTION 'attempt is not the submitting attempt of the claimed message'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_units IS DISTINCT FROM v_message.billable_units THEN
    RAISE EXCEPTION 'billable units changed since submission' USING ERRCODE = 'BL009';
  END IF;

  v_per_attempt := v_message.billing_policy_snapshot = 'charge_per_attempt';
  SELECT r.total_customer_price_paise, r.total_provider_cost_paise INTO v_price, v_cost
    FROM app_rate_message(v_message.org_id, v_message.id, p_attempt_id, v_message.billable_units,
                          v_per_attempt, true) r;

  IF v_per_attempt AND v_price > 0 THEN
    SELECT COALESCE(sum(l.amount_paise) FILTER (WHERE l.entry_type = 'reservation'), 0),
           COALESCE(sum(l.amount_paise) FILTER (WHERE l.entry_type = 'reservation_release'), 0)
      INTO v_reserved, v_released
      FROM usage_ledger l WHERE l.message_id = v_message.id;
    SELECT COALESCE(sum(e.total_customer_price_paise), 0) INTO v_prior
      FROM pricing_evaluations e
     WHERE e.message_id = v_message.id AND e.subject = 'attempt'
       AND e.message_attempt_id <> p_attempt_id;
    v_needed := v_price - (v_reserved - v_released - v_prior);
    IF v_needed > 0 THEN
      PERFORM 1 FROM app_ledger_post(
        v_message.org_id, 'reservation', p_attempt_id, v_needed,
        CASE v_message.billing_mode_snapshot WHEN 'prepaid' THEN 'wallet' ELSE 'credit' END,
        v_message.id, p_attempt_id, v_message.correlation_id, 'per-attempt reservation top-up'
      );
    ELSE
      v_needed := 0;
    END IF;
  END IF;

  RETURN QUERY SELECT v_needed, v_price, v_cost;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_dispatch_attempt_reserve(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_dispatch_attempt_reserve(uuid, integer) TO acc_dispatch;
--> statement-breakpoint

-- --- T3 / TR: settle one attempt --------------------------------------------------
--
-- After the attempt has reached its terminal status in the same transaction.
-- p_reached is the dispatcher's classification of the provider result (pinned
-- in dispatcher code with one test per category). It is recorded once and never
-- changes; an outcome_unknown attempt cannot be "reached" (OD-7-4U). For a
-- reached attempt the provider cost of its evaluation is posted (anchor: the
-- attempt). An attempt without an evaluation (rated at T2) is rated here.
CREATE OR REPLACE FUNCTION app_dispatch_attempt_settle(p_attempt_id uuid, p_reached boolean)
RETURNS TABLE (provider_cost_paise bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_message messages%ROWTYPE;
  v_status text;
  v_existing boolean;
  v_cost bigint;
BEGIN
  v_message := app_dispatch_billing_claim();
  IF p_reached IS NULL THEN
    RAISE EXCEPTION 'the reached classification is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT a.status::text INTO v_status
    FROM message_attempts a WHERE a.id = p_attempt_id AND a.message_id = v_message.id;
  IF v_status IS NULL OR v_status NOT IN ('accepted', 'failed', 'outcome_unknown') THEN
    RAISE EXCEPTION 'attempt is not a settled attempt of the claimed message'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_reached AND v_status = 'outcome_unknown' THEN
    RAISE EXCEPTION 'an outcome_unknown attempt is never billed as reaching the provider'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT p_reached AND v_status = 'accepted' THEN
    RAISE EXCEPTION 'an accepted attempt reached the provider' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO message_attempt_billing (attempt_id, message_id, org_id, reached_provider)
  VALUES (p_attempt_id, v_message.id, v_message.org_id, p_reached)
  ON CONFLICT (attempt_id) DO NOTHING;
  SELECT b.reached_provider INTO v_existing FROM message_attempt_billing b WHERE b.attempt_id = p_attempt_id;
  IF v_existing IS DISTINCT FROM p_reached THEN
    RAISE EXCEPTION 'the attempt was already settled with another classification'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_cost := 0;
  IF p_reached THEN
    SELECT r.total_provider_cost_paise INTO v_cost
      FROM app_rate_message(v_message.org_id, v_message.id, p_attempt_id, v_message.billable_units,
                            v_message.billing_policy_snapshot = 'charge_per_attempt', true) r;
    IF v_cost IS NULL THEN
      RAISE EXCEPTION 'the attempt evaluation carries no provider cost' USING ERRCODE = 'BL008';
    END IF;
    IF v_cost > 0 THEN
      PERFORM 1 FROM app_ledger_post(
        v_message.org_id, 'provider_cost', p_attempt_id, v_cost, NULL,
        v_message.id, p_attempt_id, v_message.correlation_id, NULL
      );
    END IF;
  END IF;
  RETURN QUERY SELECT v_cost;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_dispatch_attempt_settle(uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_dispatch_attempt_settle(uuid, boolean) TO acc_dispatch;
--> statement-breakpoint

-- --- Every terminal site: charge, then release ------------------------------------
--
-- The message must be terminal (accepted, failed or outcome_unknown) in this
-- transaction. Accepted (confirmed provider acceptance, OD-7-4):
--   charge_per_logical_message  one customer_charge = E_m (anchor: the message);
--   charge_per_attempt          one customer_charge per attempt recorded as
--                               having reached the provider, at its E_a (anchor:
--                               the attempt).
-- Failed (failed-delivery fee 0) and outcome_unknown (OD-7-4U): no charge.
-- Then reservation_release, computed by the writer (Σ reservations − Σ charges),
-- in the same transaction that finishes the message. Zero amounts post nothing.
-- Every fact is keyed, so a repeated call changes nothing.
CREATE OR REPLACE FUNCTION app_dispatch_message_settle()
RETURNS TABLE (charged_paise bigint, released_paise bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_message messages%ROWTYPE;
  v_account text;
  v_price bigint;
  v_charged bigint := 0;
  v_released bigint := 0;
  r record;
BEGIN
  v_message := app_dispatch_billing_claim();
  IF v_message.status::text NOT IN ('accepted', 'failed', 'outcome_unknown') THEN
    RAISE EXCEPTION 'message is not terminal' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_account := CASE v_message.billing_mode_snapshot WHEN 'prepaid' THEN 'wallet' ELSE 'credit' END;

  IF v_message.status::text = 'accepted' THEN
    IF v_message.billing_policy_snapshot = 'charge_per_logical_message' THEN
      SELECT e.total_customer_price_paise INTO v_price
        FROM pricing_evaluations e WHERE e.message_id = v_message.id AND e.subject = 'message';
      IF v_price IS NULL THEN
        RAISE EXCEPTION 'the message has no submission-time evaluation' USING ERRCODE = 'invalid_parameter_value';
      END IF;
      IF v_price > 0 THEN
        PERFORM 1 FROM app_ledger_post(
          v_message.org_id, 'customer_charge', v_message.id, v_price, v_account,
          v_message.id, NULL, v_message.correlation_id, NULL
        );
        v_charged := v_price;
      END IF;
    ELSE
      FOR r IN
        SELECT a.id AS attempt_id, e.total_customer_price_paise AS price
          FROM message_attempts a
          JOIN message_attempt_billing b ON b.attempt_id = a.id AND b.reached_provider
          JOIN pricing_evaluations e ON e.message_attempt_id = a.id AND e.subject = 'attempt'
         WHERE a.message_id = v_message.id
         ORDER BY a.attempt_number
      LOOP
        IF r.price IS NULL THEN
          RAISE EXCEPTION 'a reached attempt has no customer price' USING ERRCODE = 'invalid_parameter_value';
        END IF;
        IF r.price > 0 THEN
          PERFORM 1 FROM app_ledger_post(
            v_message.org_id, 'customer_charge', r.attempt_id, r.price, v_account,
            v_message.id, r.attempt_id, v_message.correlation_id, NULL
          );
          v_charged := v_charged + r.price;
        END IF;
      END LOOP;
    END IF;
  END IF;

  -- Release whatever is still reserved (nothing to do when nothing was reserved,
  -- for example a zero price — and then no account need exist).
  IF EXISTS (SELECT 1 FROM usage_ledger l
              WHERE l.message_id = v_message.id AND l.entry_type = 'reservation') THEN
    SELECT p.amount_paise INTO v_released
      FROM app_ledger_post(
        v_message.org_id, 'reservation_release', v_message.id, NULL, v_account,
        v_message.id, NULL, v_message.correlation_id, NULL
      ) p;
  END IF;

  RETURN QUERY SELECT v_charged, COALESCE(v_released, 0);
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_dispatch_message_settle() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_dispatch_message_settle() TO acc_dispatch;
