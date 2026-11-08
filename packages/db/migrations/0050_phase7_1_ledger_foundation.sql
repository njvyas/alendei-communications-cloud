-- =============================================================================
-- Phase 7 PR 7-1 — ledger and billing-account foundation (DECISIONS.md §1zi).
--
-- Expand-only and inert by construction. No application role holds any
-- privilege on the financial tables, none may execute the ledger writer or the
-- partition routine, no account is created and no route uses the new
-- permissions. The only object an application role may execute is the
-- read-only partition report (the API's startup verification, RQ-4).
--
-- Owner decision 08-Nov-2026 (PR 7-1, invariant D of tenant-context-trust kept
-- without exception): the partition routine is SECURITY INVOKER and owner-only.
-- It runs in this migration, after every `db:migrate`, and from the operator
-- command `db:ledger:partitions`; the API never creates partitions.
--
-- Approved decisions implemented here:
--   OD-7-3  usage_ledger partitioned by month from its first migration on the
--           month of the fact's own UUIDv7 anchor; PRIMARY KEY (anchor_month,
--           id); UNIQUE (anchor_month, anchor_id, fact_kind) — globally unique
--           by construction; the month comes from app_uuidv7_month, never from
--           uuid_extract_timestamp (NULL for v7 on PostgreSQL 17); the CHECK
--           rejects NULL; no DEFAULT partition; partitions are created only by
--           app_ledger_ensure_partitions (detached table, range CHECK, guards,
--           then ATTACH, in one transaction), run only by the schema owner; a
--           TRUNCATE guard on every partition.
--   OD-7-2  one SECURITY DEFINER writer, insert-if-absent, balances changed
--           only when a row was inserted; the billing account is the last row
--           lock it takes.
--   OD-7-9  INR only, enforced by CHECK; money in integer paise (bigint); no
--           floating point and no rounding anywhere in this migration.
--   OD-7-5  billing.read, billing.manage, pricing.read, pricing.manage (DP-1,
--           DP-2), inert on the HTTP surface in PR 7-1.
--   Allowlist: the writer accepts reservation, reservation_release,
--           customer_charge and provider_cost only; recharge, refund,
--           adjustment, tax, discount and reseller_markup are refused (BL000).
--   DP-3 to DP-6: exemption from the content-table class, deferred columns and
--           tables, foreign-keyed account columns, SQLSTATEs BL000–BL006.
--   Safeguard 1: no ON DELETE CASCADE anywhere; every ledger and account
--           foreign key is ON DELETE RESTRICT, and ledger rows and accounts
--           cannot be deleted at all.
-- =============================================================================

-- --- 1. Functions shared by the tables ----------------------------------------

-- Month (UTC) of a UUIDv7's 48-bit Unix-millisecond prefix; NULL unless the
-- version nibble is 7. Integer arithmetic only; to_timestamp receives whole
-- seconds. PostgreSQL 17's uuid_extract_timestamp returns NULL for version 7
-- and must not be used (Phase 7 Addendum A §3.1).
CREATE OR REPLACE FUNCTION app_uuidv7_month(p_id uuid) RETURNS date
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN substr(p_id::text, 15, 1) = '7' THEN
      (date_trunc('month',
         to_timestamp((('x' || substr(replace(p_id::text, '-', ''), 1, 12))::bit(48)::bigint / 1000)::double precision)
         AT TIME ZONE 'UTC'))::date
  END
$$;
--> statement-breakpoint

-- Immutability guard for ledger rows (UPDATE, DELETE, TRUNCATE) and for
-- billing-account deletion and truncation. Row and statement triggers share it.
CREATE OR REPLACE FUNCTION fn_billing_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION '%: % is not permitted (financial records are append-only)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint

-- --- 2. Enumerations ----------------------------------------------------------

-- All ten entry types of DATABASE.md §10. Which ones may be posted is the
-- writer's allowlist (section 6), not this type.
CREATE TYPE usage_ledger_entry_type AS ENUM (
  'provider_cost', 'customer_charge', 'reseller_markup', 'tax', 'discount',
  'adjustment', 'refund', 'recharge', 'reservation', 'reservation_release'
);
--> statement-breakpoint
CREATE TYPE billing_account_status AS ENUM ('active', 'frozen');
--> statement-breakpoint

-- --- 3. Billing accounts --------------------------------------------------------

CREATE TABLE wallets (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  currency char(3) NOT NULL DEFAULT 'INR',
  balance_paise bigint NOT NULL DEFAULT 0,
  reserved_paise bigint NOT NULL DEFAULT 0,
  status billing_account_status NOT NULL DEFAULT 'active',
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallets_org_id_key UNIQUE (org_id),
  CONSTRAINT wallets_id_org_id_key UNIQUE (id, org_id),
  CONSTRAINT wallets_currency_inr CHECK (currency = 'INR'),
  CONSTRAINT wallets_balance_non_negative CHECK (balance_paise >= 0),
  CONSTRAINT wallets_reserved_non_negative CHECK (reserved_paise >= 0),
  CONSTRAINT wallets_version_non_negative CHECK (version >= 0)
);
--> statement-breakpoint
CREATE TABLE credit_accounts (
  id uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  currency char(3) NOT NULL DEFAULT 'INR',
  credit_limit_paise bigint NOT NULL DEFAULT 0,
  used_paise bigint NOT NULL DEFAULT 0,
  reserved_paise bigint NOT NULL DEFAULT 0,
  status billing_account_status NOT NULL DEFAULT 'active',
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_accounts_org_id_key UNIQUE (org_id),
  CONSTRAINT credit_accounts_id_org_id_key UNIQUE (id, org_id),
  CONSTRAINT credit_accounts_currency_inr CHECK (currency = 'INR'),
  CONSTRAINT credit_accounts_limit_non_negative CHECK (credit_limit_paise >= 0),
  CONSTRAINT credit_accounts_used_non_negative CHECK (used_paise >= 0),
  CONSTRAINT credit_accounts_reserved_non_negative CHECK (reserved_paise >= 0),
  CONSTRAINT credit_accounts_version_non_negative CHECK (version >= 0)
);
--> statement-breakpoint
CREATE TRIGGER trg_wallets_updated_at BEFORE UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_credit_accounts_updated_at BEFORE UPDATE ON credit_accounts
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trg_wallets_org_id_immutable
  AFTER UPDATE OF org_id ON wallets FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id)
  EXECUTE FUNCTION fn_tenant_key_immutable('org_id');
--> statement-breakpoint
CREATE TRIGGER trg_credit_accounts_org_id_immutable
  AFTER UPDATE OF org_id ON credit_accounts FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id)
  EXECUTE FUNCTION fn_tenant_key_immutable('org_id');
--> statement-breakpoint
CREATE TRIGGER trg_wallets_no_delete BEFORE DELETE ON wallets
  FOR EACH ROW EXECUTE FUNCTION fn_billing_immutable();
--> statement-breakpoint
CREATE TRIGGER trg_credit_accounts_no_delete BEFORE DELETE ON credit_accounts
  FOR EACH ROW EXECUTE FUNCTION fn_billing_immutable();
--> statement-breakpoint
CREATE TRIGGER trg_wallets_no_truncate BEFORE TRUNCATE ON wallets
  FOR EACH STATEMENT EXECUTE FUNCTION fn_billing_immutable();
--> statement-breakpoint
CREATE TRIGGER trg_credit_accounts_no_truncate BEFORE TRUNCATE ON credit_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION fn_billing_immutable();
--> statement-breakpoint
-- Deny by default: RLS on, no policy, no privilege for any application role.
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE credit_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE wallets, credit_accounts FROM PUBLIC;
--> statement-breakpoint

-- --- 4. The ledger (partitioned parent) -----------------------------------------

CREATE TABLE usage_ledger (
  id uuid NOT NULL DEFAULT uuidv7(),
  anchor_month date NOT NULL,
  anchor_id uuid NOT NULL,
  fact_kind text NOT NULL,
  entry_type usage_ledger_entry_type NOT NULL,
  org_id uuid NOT NULL,
  reseller_id uuid,
  message_id uuid,
  message_attempt_id uuid,
  wallet_id uuid,
  credit_account_id uuid,
  amount_paise bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'INR',
  correlation_id text,
  reference_note text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_ledger_pkey PRIMARY KEY (anchor_month, id),
  CONSTRAINT usage_ledger_fact_key UNIQUE (anchor_month, anchor_id, fact_kind),
  -- C1: the partition month is the anchor's own month; NULL (non-v7) refused.
  CONSTRAINT usage_ledger_anchor_month CHECK (
    app_uuidv7_month(anchor_id) IS NOT NULL AND anchor_month = app_uuidv7_month(anchor_id)
  ),
  -- C2: one fact kind per entry type; tax and discount carry a line suffix (tax:<line>).
  CONSTRAINT usage_ledger_fact_kind CHECK (
    (entry_type NOT IN ('tax', 'discount') AND fact_kind = entry_type::text)
    OR (entry_type IN ('tax', 'discount') AND fact_kind ~ ('^' || entry_type::text || ':.+$'))
  ),
  -- C3: at most one account.
  CONSTRAINT usage_ledger_one_account CHECK (num_nonnulls(wallet_id, credit_account_id) <= 1),
  -- C4: account presence for the decided entry types (tax and discount await RQ-1).
  CONSTRAINT usage_ledger_account_presence CHECK (
    CASE
      WHEN entry_type IN ('provider_cost', 'reseller_markup')
        THEN num_nonnulls(wallet_id, credit_account_id) = 0
      WHEN entry_type IN ('reservation', 'reservation_release', 'customer_charge', 'recharge', 'refund', 'adjustment')
        THEN num_nonnulls(wallet_id, credit_account_id) = 1
      ELSE true
    END
  ),
  -- C5: message linkage and anchors of the message-billing facts.
  CONSTRAINT usage_ledger_message_linkage CHECK (
    (message_attempt_id IS NULL OR message_id IS NOT NULL)
    AND (
      entry_type NOT IN ('reservation', 'reservation_release', 'customer_charge', 'provider_cost')
      OR (message_id IS NOT NULL AND anchor_id = COALESCE(message_attempt_id, message_id))
    )
    AND (entry_type <> 'provider_cost' OR message_attempt_id IS NOT NULL)
    AND (entry_type <> 'reservation_release' OR message_attempt_id IS NULL)
  ),
  CONSTRAINT usage_ledger_amount_positive CHECK (amount_paise > 0),
  CONSTRAINT usage_ledger_currency_inr CHECK (currency = 'INR'),
  CONSTRAINT usage_ledger_reference_note_length CHECK (reference_note IS NULL OR char_length(reference_note) <= 500),
  -- Foreign keys: same-organization by composition; never cascading.
  CONSTRAINT usage_ledger_org_id_fkey FOREIGN KEY (org_id)
    REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT usage_ledger_reseller_id_fkey FOREIGN KEY (reseller_id)
    REFERENCES resellers(id) ON DELETE RESTRICT,
  CONSTRAINT usage_ledger_message_fkey FOREIGN KEY (message_id, org_id)
    REFERENCES messages(id, org_id) ON DELETE RESTRICT,
  CONSTRAINT usage_ledger_message_attempt_fkey FOREIGN KEY (message_attempt_id, message_id)
    REFERENCES message_attempts(id, message_id) ON DELETE RESTRICT,
  CONSTRAINT usage_ledger_wallet_fkey FOREIGN KEY (wallet_id, org_id)
    REFERENCES wallets(id, org_id) ON DELETE RESTRICT,
  CONSTRAINT usage_ledger_credit_account_fkey FOREIGN KEY (credit_account_id, org_id)
    REFERENCES credit_accounts(id, org_id) ON DELETE RESTRICT
) PARTITION BY RANGE (anchor_month);
--> statement-breakpoint
CREATE INDEX usage_ledger_org_id_occurred_at_idx ON usage_ledger (org_id, occurred_at);
--> statement-breakpoint
CREATE INDEX usage_ledger_message_id_idx ON usage_ledger (message_id) WHERE message_id IS NOT NULL;
--> statement-breakpoint
-- Row guard on the parent: PostgreSQL clones it to every partition, including
-- partitions attached later.
CREATE TRIGGER trg_usage_ledger_immutable BEFORE UPDATE OR DELETE ON usage_ledger
  FOR EACH ROW EXECUTE FUNCTION fn_billing_immutable();
--> statement-breakpoint
-- Statement guard on the parent. It does not fire for a partition truncated
-- directly, so the partition routine attaches the same guard to each partition.
CREATE TRIGGER trg_usage_ledger_no_truncate BEFORE TRUNCATE ON usage_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION fn_billing_immutable();
--> statement-breakpoint
ALTER TABLE usage_ledger ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL ON TABLE usage_ledger FROM PUBLIC;
--> statement-breakpoint

-- --- 5. Partition routine and report ------------------------------------------

-- Creates the missing monthly partitions from the current month (UTC, database
-- clock) to p_months_ahead months ahead (0..36), never a past month. Each one is
-- created detached with the parent's columns and constraints, given its range
-- CHECK (so ATTACH needs no scan), row security, no PUBLIC privilege and the
-- TRUNCATE guard, and only then attached; the parent's indexes, foreign keys and
-- row triggers are cloned onto it by the ATTACH. Everything happens in the
-- caller's transaction, under a transaction-scoped advisory lock (class
-- 482019311 = LEDGER_PARTITION_LOCK_CLASS in @acc/db), so a failure leaves
-- nothing behind. A table of a partition's name that exists but is not attached
-- is refused, never adopted.
--
-- SECURITY INVOKER and owner-only (no EXECUTE for PUBLIC or any application
-- role): it needs the owner's DDL rights, and no SECURITY DEFINER function may
-- run dynamic SQL or ALTER anything (tenant-context-trust invariant D).
CREATE OR REPLACE FUNCTION app_ledger_ensure_partitions(p_months_ahead integer DEFAULT 24)
RETURNS TABLE (partition_name text, range_start date, action text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_first date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  v_month date;
  v_next date;
  v_name text;
  v_rel regclass;
  i integer;
BEGIN
  IF p_months_ahead IS NULL OR p_months_ahead < 0 OR p_months_ahead > 36 THEN
    RAISE EXCEPTION 'months ahead must be between 0 and 36' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(482019311, 0);
  FOR i IN 0..p_months_ahead LOOP
    v_month := (v_first + make_interval(months => i))::date;
    v_next := (v_month + interval '1 month')::date;
    v_name := 'usage_ledger_p' || to_char(v_month, 'YYYYMM');
    v_rel := to_regclass('public.' || quote_ident(v_name));
    IF v_rel IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM pg_inherits WHERE inhrelid = v_rel AND inhparent = 'public.usage_ledger'::regclass
      ) THEN
        RAISE EXCEPTION 'table % exists but is not a usage_ledger partition', v_name
          USING ERRCODE = 'object_not_in_prerequisite_state';
      END IF;
      partition_name := v_name; range_start := v_month; action := 'exists';
      RETURN NEXT;
      CONTINUE;
    END IF;
    EXECUTE format('CREATE TABLE %I.%I (LIKE public.usage_ledger INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', 'public', v_name);
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (anchor_month >= %L::date AND anchor_month < %L::date)',
                   v_name, v_name || '_range', v_month, v_next);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', v_name);
    EXECUTE format('CREATE TRIGGER trg_usage_ledger_no_truncate BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION fn_billing_immutable()', v_name);
    EXECUTE format('ALTER TABLE public.usage_ledger ATTACH PARTITION public.%I FOR VALUES FROM (%L) TO (%L)',
                   v_name, v_month, v_next);
    partition_name := v_name; range_start := v_month; action := 'created';
    RETURN NEXT;
  END LOOP;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_ledger_ensure_partitions(integer) FROM PUBLIC;
--> statement-breakpoint

-- One row per usage_ledger partition and per same-named orphan table: its range
-- (NULL for an orphan), whether it is attached, and whether it carries the
-- protections every partition must have — the TRUNCATE guard, the cloned row
-- guard, row security, and no privilege for anyone but its owner. Read-only and
-- SECURITY INVOKER: it reads only the system catalogues, which every role may
-- read, so the API's startup verification needs no elevated rights.
CREATE OR REPLACE FUNCTION app_ledger_partition_report()
RETURNS TABLE (
  partition_name text, range_start date, range_end date, attached boolean,
  truncate_guarded boolean, row_guarded boolean, rls_enabled boolean, privileges_restricted boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT c.relname::text,
         CASE WHEN i.inhrelid IS NOT NULL THEN
           substring(pg_get_expr(c.relpartbound, c.oid) FROM 'FROM \(''([0-9-]+)''\)')::date END,
         CASE WHEN i.inhrelid IS NOT NULL THEN
           substring(pg_get_expr(c.relpartbound, c.oid) FROM 'TO \(''([0-9-]+)''\)')::date END,
         i.inhrelid IS NOT NULL,
         EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
                    AND (t.tgtype & 32) <> 0 AND t.tgfoid = 'fn_billing_immutable()'::regprocedure),
         EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = c.oid AND (t.tgtype & 1) = 1
                    AND (t.tgtype & 16) <> 0 AND (t.tgtype & 8) <> 0
                    AND t.tgfoid = 'fn_billing_immutable()'::regprocedure),
         c.relrowsecurity,
         NOT EXISTS (SELECT 1 FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
                      WHERE a.grantee <> c.relowner)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    LEFT JOIN pg_inherits i ON i.inhrelid = c.oid AND i.inhparent = 'public.usage_ledger'::regclass
   WHERE c.relkind IN ('r', 'p')
     AND (i.inhrelid IS NOT NULL OR c.relname ~ '^usage_ledger_p[0-9]{6}$')
   ORDER BY c.relname
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_ledger_partition_report() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_ledger_partition_report() TO acc_app;
--> statement-breakpoint
-- The deployment's first partitions: the current month and the next 24.
SELECT count(*) FROM app_ledger_ensure_partitions(24);
--> statement-breakpoint

-- --- 6. The single ledger writer (OD-7-2) -----------------------------------------

-- Posts one financial fact if it does not already exist, and changes the
-- account's materialised balances only when a row was actually inserted.
--
-- Balance effects (reserved = the sum of OPEN reservations, DATABASE.md §10):
--   reservation          reserved += a
--   customer_charge      balance −= a (wallet) / used += a (credit), and
--                        reserved −= a: the charge consumes its share of the
--                        message's reservation, which is no longer open
--   reservation_release  reserved −= a, where a = Σ reservations − Σ charges −
--                        Σ releases of the message (BILLING.md §8: "reserved
--                        amount − actual customer_charge"); never caller-supplied
--   provider_cost        none
-- so a settled message leaves reserved exactly as it was before its reservation.
-- Executable by no application role in PR 7-1 (PR 7-4 adds the acc_app branch,
-- PR 7-5 the acc_dispatch branch, each with its grant).
--
-- Allowlist (approved 08-Nov-2026): reservation, reservation_release,
-- customer_charge, provider_cost. Every other entry type is refused (BL000).
--
-- SQLSTATEs (DP-6): BL000 entry type not enabled; BL001 no billing account;
-- BL002 account not active; BL003 insufficient funds; BL004 message already
-- settled; BL005 account mismatch; BL006 charge exceeds reservation.
-- Argument errors raise 22023.
CREATE OR REPLACE FUNCTION app_ledger_post(
  p_org_id uuid,
  p_entry_type usage_ledger_entry_type,
  p_anchor_id uuid,
  p_amount_paise bigint,
  p_account text,
  p_message_id uuid,
  p_message_attempt_id uuid,
  p_correlation_id text,
  p_reference_note text
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
BEGIN
  -- 1. Allowlist.
  IF p_entry_type IS NULL
     OR p_entry_type NOT IN ('reservation', 'reservation_release', 'customer_charge', 'provider_cost') THEN
    RAISE EXCEPTION 'ledger entry type % is not enabled', p_entry_type USING ERRCODE = 'BL000';
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
    IF v_first_found AND p_entry_type IN ('reservation', 'customer_charge') THEN
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
REVOKE ALL ON FUNCTION app_ledger_post(uuid, usage_ledger_entry_type, uuid, bigint, text, uuid, uuid, text, text) FROM PUBLIC;
--> statement-breakpoint

-- --- 7. Permissions and role grants (OD-7-5, DP-1, DP-2) ------------------------

INSERT INTO permissions (key, domain, action, description, classification, allowed_scope_types) VALUES
  ('billing.read', 'billing', 'read',
   'Read the organization''s own billing accounts, ledger and invoices', 'tenant_content', '{organization}'),
  ('billing.manage', 'billing', 'manage',
   'Platform money movement and billing-account administration', 'tenancy_administration', '{platform}'),
  ('pricing.read', 'pricing', 'read',
   'Read the platform pricing catalogue', 'platform_catalogue', '{platform}'),
  ('pricing.manage', 'pricing', 'manage',
   'Administer the platform pricing catalogue', 'platform_catalogue', '{platform}')
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint
SELECT set_config('app.provisioning', 'on', true);
--> statement-breakpoint
-- alendei_super_admin: every non-content key, by construction.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.org_id IS NULL
  AND r.key = 'alendei_super_admin'
  AND p.key IN ('billing.manage', 'pricing.read', 'pricing.manage')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- alendei_support: the read-only pricing catalogue only (DP-2).
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.org_id IS NULL
  AND r.key = 'alendei_support'
  AND p.key = 'pricing.read'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Every existing organization's org_admin (the 0008 pattern); new organizations
-- receive it from the role definition through TenantRoleProvisioner.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
CROSS JOIN permissions p
WHERE r.org_id IS NOT NULL
  AND r.is_system_role
  AND r.key = 'org_admin'
  AND p.key = 'billing.read'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
SELECT set_config('app.provisioning', 'off', true);
