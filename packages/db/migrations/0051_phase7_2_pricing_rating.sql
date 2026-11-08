-- =============================================================================
-- Phase 7 PR 7-2 — pricing and rating (DECISIONS.md §1zi; Phase 7.2 handover,
-- owner-approved 08-Nov-2026 with OD-P-1, OD-P-2 and OD-P-3).
--
-- Expand-only. No Phase 7.1 object is altered; fn_billing_immutable (0050) is
-- reused as a trigger function only. The one change to an existing object is
-- the platform namespace for idempotency_keys (section at the end; owner
-- correction to PR #90, 08-Nov-2026): org_id becomes nullable for platform
-- records only, with its own unique index, shape CHECK and RLS policy. Every
-- organization row, policy, index and grant is unchanged.
--
-- Approved financial rules implemented here:
--   1. Rates are integers in 1/10,000 of a paisa (`*_e4` bigint columns).
--   2. Integer arithmetic only: exact = units × rate (both integers).
--   3. Round half up to whole paise once per price component per rated
--      transaction: paise = (exact + 5000) / 10000 (all values ≥ 0). A CHECK on
--      every component proves it.
--   4. No per-segment or aggregate rounding: an evaluation total is its single
--      rounded component.
--   5. A zero-paise result is recorded on the evaluation; posting nothing for it
--      is the ledger callers' rule (PR 7-4/7-5).
--   6. Units: SMS = the caller's (approved, persisted) segment count;
--      WhatsApp and RCS = exactly 1 per message. The unit is derived from the
--      channel, never supplied by the caller.
--   7. Provider cost comes only from provider_cost_rates.
--   8. A provider-specific rule beats the channel default; a missing assignment,
--      version, rule or cost rate fails closed (BL007 / BL008).
--   9. Evaluations, their components, active rate-card versions and their rules,
--      provider cost rates and assignments are immutable; nothing is ever
--      re-rated, and effective dates can never be in the past (no backdating).
--
-- Scopes (OD-P-3): a rate card is assigned to the platform default
-- (org_id NULL) or to one organization; dimensions are channel and an optional
-- provider.
--
-- Inert by construction: the rating functions are executable by no application
-- role; acc_app may administer the catalogue tables only under a validated
-- platform-scope claim (app_has_platform_scope(), migration 0018). No SECURITY
-- DEFINER function here runs dynamic SQL, alters anything or sets variables
-- (tenant-context-trust invariant D).
-- =============================================================================

CREATE TYPE pricing_version_status AS ENUM ('draft', 'active');
--> statement-breakpoint
CREATE TYPE pricing_unit AS ENUM ('sms_segment', 'message');
--> statement-breakpoint
CREATE TYPE pricing_subject AS ENUM ('message', 'attempt');
--> statement-breakpoint
CREATE TYPE pricing_component AS ENUM ('customer_price', 'provider_cost');
--> statement-breakpoint

-- The billable unit of a channel (approved rule 6); NULL for a channel that is
-- not priced.
CREATE OR REPLACE FUNCTION app_pricing_unit_for_channel(p_channel uuid) RETURNS pricing_unit
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE c.code
           WHEN 'sms' THEN 'sms_segment'::pricing_unit
           WHEN 'whatsapp' THEN 'message'::pricing_unit
           WHEN 'rcs' THEN 'message'::pricing_unit
         END
    FROM channels c
   WHERE c.id = p_channel
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_pricing_unit_for_channel(uuid) FROM PUBLIC;
--> statement-breakpoint
-- The rule and cost-rate guards below run with the caller's privileges (acc_app
-- when the platform pricing API inserts); this pure channel→unit lookup is all
-- they need. It prices nothing.
GRANT EXECUTE ON FUNCTION app_pricing_unit_for_channel(uuid) TO acc_app;
--> statement-breakpoint

-- --- Rate cards -----------------------------------------------------------------

CREATE TABLE pricing_plans (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_plans_name_length CHECK (char_length(name) BETWEEN 1 AND 200),
  CONSTRAINT pricing_plans_description_length CHECK (description IS NULL OR char_length(description) <= 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX pricing_plans_name_key ON pricing_plans (lower(name));
--> statement-breakpoint

CREATE TABLE pricing_plan_versions (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  plan_id uuid NOT NULL REFERENCES pricing_plans(id) ON DELETE RESTRICT,
  version_number integer NOT NULL,
  status pricing_version_status NOT NULL DEFAULT 'draft',
  effective_from timestamptz,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_plan_versions_number_key UNIQUE (plan_id, version_number),
  CONSTRAINT pricing_plan_versions_effective_key UNIQUE (plan_id, effective_from),
  CONSTRAINT pricing_plan_versions_number_positive CHECK (version_number > 0),
  CONSTRAINT pricing_plan_versions_state CHECK (
    (status = 'draft' AND effective_from IS NULL AND activated_at IS NULL)
    OR (status = 'active' AND effective_from IS NOT NULL AND activated_at IS NOT NULL
        AND effective_from >= activated_at)
  )
);
--> statement-breakpoint
-- At most one draft per plan: a retried "create the next draft" is refused
-- (409) instead of creating a second draft, so every catalogue POST is
-- naturally idempotent.
CREATE UNIQUE INDEX pricing_plan_versions_one_draft ON pricing_plan_versions (plan_id) WHERE status = 'draft';
--> statement-breakpoint

-- A draft may only be activated; an active version never changes; no version
-- is ever deleted. Activation stamps activated_at with the transaction time and
-- refuses an effective_from in the past (no backdating, BILLING.md §15).
CREATE OR REPLACE FUNCTION fn_pricing_version_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pricing_plan_versions: DELETE is not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'active' THEN
    RAISE EXCEPTION 'pricing_plan_versions: an active version is immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
     OR NEW.version_number IS DISTINCT FROM OLD.version_number
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'pricing_plan_versions: identity columns are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'active' THEN
    NEW.activated_at := now();
    IF NEW.effective_from IS NULL OR NEW.effective_from < now() THEN
      RAISE EXCEPTION 'pricing_plan_versions: effective_from must not be in the past' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_pricing_plan_versions_guard BEFORE UPDATE OR DELETE ON pricing_plan_versions
  FOR EACH ROW EXECUTE FUNCTION fn_pricing_version_guard();
--> statement-breakpoint

CREATE TABLE pricing_rules (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  plan_version_id uuid NOT NULL REFERENCES pricing_plan_versions(id) ON DELETE RESTRICT,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  provider_id uuid,
  unit_price_e4 bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_rules_provider_channel_fkey FOREIGN KEY (provider_id, channel_id)
    REFERENCES providers(id, channel_id) ON DELETE RESTRICT,
  CONSTRAINT pricing_rules_price_range CHECK (unit_price_e4 >= 0 AND unit_price_e4 <= 1000000000000),
  CONSTRAINT pricing_rules_key UNIQUE NULLS NOT DISTINCT (plan_version_id, channel_id, provider_id)
);
--> statement-breakpoint

-- Rules change only while their version is a draft. The version row is read
-- FOR SHARE, so an activation and a rule change cannot interleave.
CREATE OR REPLACE FUNCTION fn_pricing_rule_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status pricing_version_status;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT v.status INTO v_status FROM pricing_plan_versions v WHERE v.id = OLD.plan_version_id FOR SHARE;
    IF v_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'pricing_rules: the rules of an active version are immutable' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT v.status INTO v_status FROM pricing_plan_versions v WHERE v.id = NEW.plan_version_id FOR SHARE;
    IF v_status IS DISTINCT FROM 'draft' THEN
      RAISE EXCEPTION 'pricing_rules: rules may be added only to a draft version' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF app_pricing_unit_for_channel(NEW.channel_id) IS NULL THEN
      RAISE EXCEPTION 'pricing_rules: the channel is not priced' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_pricing_rules_guard BEFORE INSERT OR UPDATE OR DELETE ON pricing_rules
  FOR EACH ROW EXECUTE FUNCTION fn_pricing_rule_guard();
--> statement-breakpoint

-- --- Provider cost rates and rate-card assignments (append-only, dated) ----------

CREATE TABLE provider_cost_rates (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  provider_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  unit_cost_e4 bigint NOT NULL,
  effective_from timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_cost_rates_provider_channel_fkey FOREIGN KEY (provider_id, channel_id)
    REFERENCES providers(id, channel_id) ON DELETE RESTRICT,
  CONSTRAINT provider_cost_rates_cost_range CHECK (unit_cost_e4 >= 0 AND unit_cost_e4 <= 1000000000000),
  CONSTRAINT provider_cost_rates_key UNIQUE (provider_id, effective_from),
  CONSTRAINT provider_cost_rates_not_backdated CHECK (effective_from >= created_at)
);
--> statement-breakpoint
CREATE TABLE customer_pricing_assignments (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  org_id uuid REFERENCES organizations(id) ON DELETE RESTRICT,
  plan_id uuid NOT NULL REFERENCES pricing_plans(id) ON DELETE RESTRICT,
  effective_from timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_pricing_assignments_key UNIQUE NULLS NOT DISTINCT (org_id, effective_from),
  CONSTRAINT customer_pricing_assignments_not_backdated CHECK (effective_from >= created_at)
);
--> statement-breakpoint
CREATE INDEX customer_pricing_assignments_org_effective_idx
  ON customer_pricing_assignments (org_id, effective_from DESC);
--> statement-breakpoint

-- created_at is the database's own insertion time, so the no-backdating CHECKs
-- cannot be defeated by a caller-supplied created_at.
CREATE OR REPLACE FUNCTION fn_pricing_stamp_created_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.created_at := now();
  -- Nested, not AND-ed: assignments have no channel_id, and PL/pgSQL does not
  -- short-circuit a record-field reference.
  IF TG_TABLE_NAME = 'provider_cost_rates' THEN
    IF app_pricing_unit_for_channel(NEW.channel_id) IS NULL THEN
      RAISE EXCEPTION 'provider_cost_rates: the channel is not priced' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_provider_cost_rates_stamp BEFORE INSERT ON provider_cost_rates
  FOR EACH ROW EXECUTE FUNCTION fn_pricing_stamp_created_at();
--> statement-breakpoint
CREATE TRIGGER trg_customer_pricing_assignments_stamp BEFORE INSERT ON customer_pricing_assignments
  FOR EACH ROW EXECUTE FUNCTION fn_pricing_stamp_created_at();
--> statement-breakpoint

-- --- Evaluations (the record of how an amount was calculated, BILLING.md §16) ---

CREATE TABLE pricing_evaluations (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  message_id uuid NOT NULL,
  message_attempt_id uuid,
  subject pricing_subject NOT NULL,
  plan_version_id uuid REFERENCES pricing_plan_versions(id) ON DELETE RESTRICT,
  rating_timestamp timestamptz NOT NULL,
  currency char(3) NOT NULL DEFAULT 'INR',
  units integer NOT NULL,
  unit pricing_unit NOT NULL,
  total_customer_price_paise bigint,
  total_provider_cost_paise bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_evaluations_message_fkey FOREIGN KEY (message_id, org_id)
    REFERENCES messages(id, org_id) ON DELETE RESTRICT,
  CONSTRAINT pricing_evaluations_message_attempt_fkey FOREIGN KEY (message_attempt_id, message_id)
    REFERENCES message_attempts(id, message_id) ON DELETE RESTRICT,
  CONSTRAINT pricing_evaluations_currency_inr CHECK (currency = 'INR'),
  CONSTRAINT pricing_evaluations_units_range CHECK (units BETWEEN 1 AND 1000000),
  CONSTRAINT pricing_evaluations_message_unit CHECK (unit <> 'message' OR units = 1),
  CONSTRAINT pricing_evaluations_subject CHECK ((subject = 'attempt') = (message_attempt_id IS NOT NULL)),
  CONSTRAINT pricing_evaluations_has_amount CHECK (num_nonnulls(total_customer_price_paise, total_provider_cost_paise) >= 1),
  CONSTRAINT pricing_evaluations_customer_version CHECK ((plan_version_id IS NULL) = (total_customer_price_paise IS NULL)),
  CONSTRAINT pricing_evaluations_customer_non_negative CHECK (total_customer_price_paise IS NULL OR total_customer_price_paise >= 0),
  CONSTRAINT pricing_evaluations_cost_non_negative CHECK (total_provider_cost_paise IS NULL OR total_provider_cost_paise >= 0),
  CONSTRAINT pricing_evaluations_cost_on_attempt CHECK (subject = 'attempt' OR total_provider_cost_paise IS NULL)
);
--> statement-breakpoint
-- One evaluation per rated subject: the idempotency key of rating.
CREATE UNIQUE INDEX pricing_evaluations_message_key ON pricing_evaluations (message_id) WHERE subject = 'message';
--> statement-breakpoint
CREATE UNIQUE INDEX pricing_evaluations_attempt_key ON pricing_evaluations (message_attempt_id) WHERE subject = 'attempt';
--> statement-breakpoint
CREATE INDEX pricing_evaluations_message_id_idx ON pricing_evaluations (message_id);
--> statement-breakpoint

CREATE TABLE pricing_evaluation_components (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  evaluation_id uuid NOT NULL REFERENCES pricing_evaluations(id) ON DELETE RESTRICT,
  component pricing_component NOT NULL,
  pricing_rule_id uuid REFERENCES pricing_rules(id) ON DELETE RESTRICT,
  provider_cost_rate_id uuid REFERENCES provider_cost_rates(id) ON DELETE RESTRICT,
  quantity integer NOT NULL,
  unit pricing_unit NOT NULL,
  unit_rate_e4 bigint NOT NULL,
  amount_exact_e4 bigint NOT NULL,
  amount_paise bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pricing_evaluation_components_key UNIQUE (evaluation_id, component),
  CONSTRAINT pricing_evaluation_components_source CHECK (
    (component = 'customer_price' AND pricing_rule_id IS NOT NULL AND provider_cost_rate_id IS NULL)
    OR (component = 'provider_cost' AND provider_cost_rate_id IS NOT NULL AND pricing_rule_id IS NULL)
  ),
  CONSTRAINT pricing_evaluation_components_quantity_range CHECK (quantity BETWEEN 1 AND 1000000),
  CONSTRAINT pricing_evaluation_components_rate_range CHECK (unit_rate_e4 >= 0 AND unit_rate_e4 <= 1000000000000),
  -- Rules 2–3, proved on every row: integer product, then half-up to whole paise once.
  CONSTRAINT pricing_evaluation_components_exact CHECK (amount_exact_e4 = quantity::bigint * unit_rate_e4),
  CONSTRAINT pricing_evaluation_components_rounding CHECK (amount_paise = (amount_exact_e4 + 5000) / 10000)
);
--> statement-breakpoint

-- --- Immutability (rule 9) -------------------------------------------------------

CREATE TRIGGER trg_pricing_plans_no_delete BEFORE DELETE ON pricing_plans
  FOR EACH ROW EXECUTE FUNCTION fn_billing_immutable();
--> statement-breakpoint
CREATE TRIGGER trg_provider_cost_rates_immutable BEFORE UPDATE OR DELETE ON provider_cost_rates
  FOR EACH ROW EXECUTE FUNCTION fn_billing_immutable();
--> statement-breakpoint
CREATE TRIGGER trg_customer_pricing_assignments_immutable BEFORE UPDATE OR DELETE ON customer_pricing_assignments
  FOR EACH ROW EXECUTE FUNCTION fn_billing_immutable();
--> statement-breakpoint
CREATE TRIGGER trg_pricing_evaluations_immutable BEFORE UPDATE OR DELETE ON pricing_evaluations
  FOR EACH ROW EXECUTE FUNCTION fn_billing_immutable();
--> statement-breakpoint
CREATE TRIGGER trg_pricing_evaluation_components_immutable BEFORE UPDATE OR DELETE ON pricing_evaluation_components
  FOR EACH ROW EXECUTE FUNCTION fn_billing_immutable();
--> statement-breakpoint
CREATE TRIGGER trg_pricing_plans_no_truncate BEFORE TRUNCATE ON pricing_plans
  FOR EACH STATEMENT EXECUTE FUNCTION fn_billing_immutable();
--> statement-breakpoint
CREATE TRIGGER trg_pricing_plan_versions_no_truncate BEFORE TRUNCATE ON pricing_plan_versions
  FOR EACH STATEMENT EXECUTE FUNCTION fn_billing_immutable();
--> statement-breakpoint
CREATE TRIGGER trg_pricing_rules_no_truncate BEFORE TRUNCATE ON pricing_rules
  FOR EACH STATEMENT EXECUTE FUNCTION fn_billing_immutable();
--> statement-breakpoint
CREATE TRIGGER trg_provider_cost_rates_no_truncate BEFORE TRUNCATE ON provider_cost_rates
  FOR EACH STATEMENT EXECUTE FUNCTION fn_billing_immutable();
--> statement-breakpoint
CREATE TRIGGER trg_customer_pricing_assignments_no_truncate BEFORE TRUNCATE ON customer_pricing_assignments
  FOR EACH STATEMENT EXECUTE FUNCTION fn_billing_immutable();
--> statement-breakpoint
CREATE TRIGGER trg_pricing_evaluations_no_truncate BEFORE TRUNCATE ON pricing_evaluations
  FOR EACH STATEMENT EXECUTE FUNCTION fn_billing_immutable();
--> statement-breakpoint
CREATE TRIGGER trg_pricing_evaluation_components_no_truncate BEFORE TRUNCATE ON pricing_evaluation_components
  FOR EACH STATEMENT EXECUTE FUNCTION fn_billing_immutable();
--> statement-breakpoint

-- --- Row security and privileges -------------------------------------------------

-- The catalogue: acc_app only under a validated platform-scope claim (the 0018
-- pattern); the API additionally asserts pricing.read / pricing.manage at
-- platform scope and accepts signed-in users only.
ALTER TABLE pricing_plans ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pricing_plan_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pricing_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE provider_cost_rates ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE customer_pricing_assignments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY pricing_plans_platform ON pricing_plans FOR ALL TO acc_app
  USING (app_has_platform_scope()) WITH CHECK (app_has_platform_scope());
--> statement-breakpoint
CREATE POLICY pricing_plan_versions_platform ON pricing_plan_versions FOR ALL TO acc_app
  USING (app_has_platform_scope()) WITH CHECK (app_has_platform_scope());
--> statement-breakpoint
CREATE POLICY pricing_rules_platform ON pricing_rules FOR ALL TO acc_app
  USING (app_has_platform_scope()) WITH CHECK (app_has_platform_scope());
--> statement-breakpoint
CREATE POLICY provider_cost_rates_platform ON provider_cost_rates FOR ALL TO acc_app
  USING (app_has_platform_scope()) WITH CHECK (app_has_platform_scope());
--> statement-breakpoint
CREATE POLICY customer_pricing_assignments_platform ON customer_pricing_assignments FOR ALL TO acc_app
  USING (app_has_platform_scope()) WITH CHECK (app_has_platform_scope());
--> statement-breakpoint
REVOKE ALL ON TABLE pricing_plans, pricing_plan_versions, pricing_rules, provider_cost_rates,
  customer_pricing_assignments, pricing_evaluations, pricing_evaluation_components FROM PUBLIC;
--> statement-breakpoint
-- Plans are never renamed or deleted; versions are created, then activated;
-- draft rules are replaced (DELETE + INSERT, refused once active); cost rates and
-- assignments are append-only.
GRANT SELECT, INSERT ON pricing_plans TO acc_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON pricing_plan_versions TO acc_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON pricing_rules TO acc_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON provider_cost_rates TO acc_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON customer_pricing_assignments TO acc_app;
--> statement-breakpoint
-- Evaluations: no application-role privilege at all; written and read only by
-- the SECURITY DEFINER rating functions below. RLS on with no policy.
ALTER TABLE pricing_evaluations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pricing_evaluation_components ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- --- Rating --------------------------------------------------------------------

-- The price and/or provider cost of `p_units` units on a channel (and provider)
-- at `p_at`. Read-only; used by app_rate_message and, from PR 7-4, to size
-- reservations without recording anything. Fails closed: BL007 when no
-- assignment, active version or rule prices it; BL008 when no provider cost rate
-- is in force. Resolution: the organization's assignment in force at p_at, else
-- the platform default's; that plan's active version in force at p_at; the rule
-- for (channel, provider) if any, else the channel default (provider NULL); the
-- provider's cost rate in force at p_at.
CREATE OR REPLACE FUNCTION app_price_lookup(
  p_org_id uuid,
  p_channel_id uuid,
  p_provider_id uuid,
  p_units integer,
  p_at timestamptz,
  p_with_customer boolean,
  p_with_cost boolean
)
RETURNS TABLE (
  unit pricing_unit,
  plan_version_id uuid,
  pricing_rule_id uuid,
  unit_price_e4 bigint,
  customer_exact_e4 bigint,
  customer_price_paise bigint,
  provider_cost_rate_id uuid,
  unit_cost_e4 bigint,
  cost_exact_e4 bigint,
  provider_cost_paise bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_unit pricing_unit;
  v_plan uuid;
  v_version uuid;
  v_rule uuid;
  v_price bigint;
  v_rate uuid;
  v_cost bigint;
BEGIN
  IF p_org_id IS NULL OR p_channel_id IS NULL OR p_at IS NULL OR p_units IS NULL THEN
    RAISE EXCEPTION 'organization, channel, units and time are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT (coalesce(p_with_customer, false) OR coalesce(p_with_cost, false)) THEN
    RAISE EXCEPTION 'nothing to price' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_units < 1 OR p_units > 1000000 THEN
    RAISE EXCEPTION 'units must be between 1 and 1000000' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_unit := app_pricing_unit_for_channel(p_channel_id);
  IF v_unit IS NULL THEN
    RAISE EXCEPTION 'the channel is not priced' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_unit = 'message' AND p_units <> 1 THEN
    RAISE EXCEPTION 'WhatsApp and RCS are priced at exactly one unit per message' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_with_cost AND p_provider_id IS NULL THEN
    RAISE EXCEPTION 'a provider cost needs a provider' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_provider_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM providers p WHERE p.id = p_provider_id AND p.channel_id = p_channel_id) THEN
    RAISE EXCEPTION 'the provider does not serve the channel' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_with_customer THEN
    SELECT a.plan_id INTO v_plan
      FROM customer_pricing_assignments a
     WHERE a.org_id = p_org_id AND a.effective_from <= p_at
     ORDER BY a.effective_from DESC
     LIMIT 1;
    IF v_plan IS NULL THEN
      SELECT a.plan_id INTO v_plan
        FROM customer_pricing_assignments a
       WHERE a.org_id IS NULL AND a.effective_from <= p_at
       ORDER BY a.effective_from DESC
       LIMIT 1;
    END IF;
    IF v_plan IS NULL THEN
      RAISE EXCEPTION 'no rate card is assigned' USING ERRCODE = 'BL007';
    END IF;
    SELECT v.id INTO v_version
      FROM pricing_plan_versions v
     WHERE v.plan_id = v_plan AND v.status = 'active' AND v.effective_from <= p_at
     ORDER BY v.effective_from DESC
     LIMIT 1;
    IF v_version IS NULL THEN
      RAISE EXCEPTION 'the assigned rate card has no version in force' USING ERRCODE = 'BL007';
    END IF;
    SELECT r.id, r.unit_price_e4 INTO v_rule, v_price
      FROM pricing_rules r
     WHERE r.plan_version_id = v_version
       AND r.channel_id = p_channel_id
       AND (r.provider_id IS NULL OR r.provider_id = p_provider_id)
     ORDER BY (r.provider_id IS NULL) ASC
     LIMIT 1;
    IF v_rule IS NULL THEN
      RAISE EXCEPTION 'the rate card does not price this channel' USING ERRCODE = 'BL007';
    END IF;
  END IF;

  IF p_with_cost THEN
    SELECT c.id, c.unit_cost_e4 INTO v_rate, v_cost
      FROM provider_cost_rates c
     WHERE c.provider_id = p_provider_id AND c.channel_id = p_channel_id AND c.effective_from <= p_at
     ORDER BY c.effective_from DESC
     LIMIT 1;
    IF v_rate IS NULL THEN
      RAISE EXCEPTION 'no provider cost rate is in force' USING ERRCODE = 'BL008';
    END IF;
  END IF;

  RETURN QUERY SELECT
    v_unit,
    v_version,
    v_rule,
    v_price,
    p_units::bigint * v_price,
    (p_units::bigint * v_price + 5000) / 10000,
    v_rate,
    v_cost,
    p_units::bigint * v_cost,
    (p_units::bigint * v_cost + 5000) / 10000;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_price_lookup(uuid, uuid, uuid, integer, timestamptz, boolean, boolean) FROM PUBLIC;
--> statement-breakpoint

-- Rates one message (no attempt) or one attempt, once. The channel comes from
-- the message and the provider from the attempt, never from the caller. If the
-- subject already has an evaluation it is returned unchanged (inserted = false),
-- whatever the arguments: nothing is ever re-rated. Otherwise the subject is
-- priced at the transaction time and the evaluation and its components are
-- inserted; concurrent first calls produce exactly one evaluation.
--   message subject: customer price only (the provider is not yet known);
--   attempt subject: provider cost and/or customer price.
CREATE OR REPLACE FUNCTION app_rate_message(
  p_org_id uuid,
  p_message_id uuid,
  p_message_attempt_id uuid,
  p_units integer,
  p_with_customer boolean,
  p_with_cost boolean
)
RETURNS TABLE (
  evaluation_id uuid,
  inserted boolean,
  rating_timestamp timestamptz,
  total_customer_price_paise bigint,
  total_provider_cost_paise bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_channel uuid;
  v_provider uuid;
  v_subject pricing_subject;
  v_at timestamptz := now();
  v_id uuid;
  l record;
  e record;
BEGIN
  IF p_org_id IS NULL OR p_message_id IS NULL THEN
    RAISE EXCEPTION 'organization and message are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT m.channel_id INTO v_channel FROM messages m WHERE m.id = p_message_id AND m.org_id = p_org_id;
  IF v_channel IS NULL THEN
    RAISE EXCEPTION 'message does not belong to the organization' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_message_attempt_id IS NULL THEN
    v_subject := 'message';
    IF coalesce(p_with_cost, false) THEN
      RAISE EXCEPTION 'a message-level evaluation carries no provider cost' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSE
    v_subject := 'attempt';
    SELECT a.provider_id INTO v_provider
      FROM message_attempts a WHERE a.id = p_message_attempt_id AND a.message_id = p_message_id;
    IF v_provider IS NULL THEN
      RAISE EXCEPTION 'attempt does not belong to the message' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  -- Existing evaluation: returned unchanged.
  SELECT ev.id, ev.rating_timestamp, ev.total_customer_price_paise, ev.total_provider_cost_paise INTO e
    FROM pricing_evaluations ev
   WHERE (v_subject = 'message' AND ev.subject = 'message' AND ev.message_id = p_message_id)
      OR (v_subject = 'attempt' AND ev.subject = 'attempt' AND ev.message_attempt_id = p_message_attempt_id);
  IF FOUND THEN
    RETURN QUERY SELECT e.id, false, e.rating_timestamp, e.total_customer_price_paise, e.total_provider_cost_paise;
    RETURN;
  END IF;

  SELECT * INTO l
    FROM app_price_lookup(p_org_id, v_channel, v_provider, p_units, v_at,
                          coalesce(p_with_customer, false), coalesce(p_with_cost, false));

  INSERT INTO pricing_evaluations (
    org_id, message_id, message_attempt_id, subject, plan_version_id, rating_timestamp,
    units, unit, total_customer_price_paise, total_provider_cost_paise
  ) VALUES (
    p_org_id, p_message_id, p_message_attempt_id, v_subject, l.plan_version_id, v_at,
    p_units, l.unit, l.customer_price_paise, l.provider_cost_paise
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    -- A concurrent first call won; return its evaluation.
    SELECT ev.id, ev.rating_timestamp, ev.total_customer_price_paise, ev.total_provider_cost_paise INTO e
      FROM pricing_evaluations ev
     WHERE (v_subject = 'message' AND ev.subject = 'message' AND ev.message_id = p_message_id)
        OR (v_subject = 'attempt' AND ev.subject = 'attempt' AND ev.message_attempt_id = p_message_attempt_id);
    RETURN QUERY SELECT e.id, false, e.rating_timestamp, e.total_customer_price_paise, e.total_provider_cost_paise;
    RETURN;
  END IF;

  IF l.pricing_rule_id IS NOT NULL THEN
    INSERT INTO pricing_evaluation_components (
      evaluation_id, component, pricing_rule_id, quantity, unit, unit_rate_e4, amount_exact_e4, amount_paise
    ) VALUES (
      v_id, 'customer_price', l.pricing_rule_id, p_units, l.unit, l.unit_price_e4, l.customer_exact_e4, l.customer_price_paise
    );
  END IF;
  IF l.provider_cost_rate_id IS NOT NULL THEN
    INSERT INTO pricing_evaluation_components (
      evaluation_id, component, provider_cost_rate_id, quantity, unit, unit_rate_e4, amount_exact_e4, amount_paise
    ) VALUES (
      v_id, 'provider_cost', l.provider_cost_rate_id, p_units, l.unit, l.unit_cost_e4, l.cost_exact_e4, l.provider_cost_paise
    );
  END IF;

  RETURN QUERY SELECT v_id, true, v_at, l.customer_price_paise, l.provider_cost_paise;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_rate_message(uuid, uuid, uuid, integer, boolean, boolean) FROM PUBLIC;
--> statement-breakpoint

-- =============================================================================
-- Platform namespace for idempotency_keys (owner correction to PR #90).
--
-- The pricing catalogue's creating POSTs require an Idempotency-Key and use the
-- existing mechanism (IdempotencyService: claim, work and finalize in one
-- transaction; replay on the same key and request; 422 on a different request;
-- 409 while in progress). Its records are namespaced by organization, and the
-- catalogue has none, so a platform record carries org_id NULL:
--   * unique (endpoint, idempotency_key) among platform records, the platform
--     counterpart of idempotency_keys_scope_key;
--   * only a /platform/ endpoint, and never an API key, may own one;
--   * acc_app reaches platform records only under a validated platform-scope
--     claim (app_has_platform_scope(), the 0018 pattern). The organization
--     policy is untouched: app_org_in_scope(NULL) is false, so no tenant
--     principal can see or write a platform record.
-- Column grants (0025: no UPDATE of org_id, endpoint or the key; no DELETE) and
-- the org_id immutability trigger apply unchanged.
-- =============================================================================
ALTER TABLE idempotency_keys ALTER COLUMN org_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE idempotency_keys ADD CONSTRAINT idempotency_keys_platform_shape CHECK (
  org_id IS NOT NULL OR (endpoint LIKE '% /platform/%' AND actor_api_key_id IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX idempotency_keys_platform_scope_key ON idempotency_keys (endpoint, idempotency_key)
  WHERE org_id IS NULL;
--> statement-breakpoint
CREATE POLICY idempotency_keys_platform ON idempotency_keys FOR ALL TO acc_app
  USING (org_id IS NULL AND app_has_platform_scope())
  WITH CHECK (org_id IS NULL AND app_has_platform_scope());
