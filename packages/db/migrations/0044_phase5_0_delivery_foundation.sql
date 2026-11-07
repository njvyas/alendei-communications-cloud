-- =============================================================================
-- Migration: 0044_phase5_0_delivery_foundation   (Phase 5.0, M1)
--
-- Delivery-outcome foundation, Option B (two axes): the submission `status` of
-- messages and attempts is unchanged and stays terminal; delivery is a separate,
-- monotonic axis (`delivery_status`) with `read_at` as an attribute. Design:
-- PHASE-5.0-DESIGN-SPEC.md Rev 2 §B–§C and PHASE-5.0-IMPLEMENTATION-PLAN.md §1.
--
-- Expand-only and metadata-only on populated tables: nullable columns without a
-- default, CHECK constraints added NOT VALID (validated by M3, 0046). No
-- existing enum is altered. Old application code keeps working unchanged.
--
-- Order matters: the role is created FIRST (the 0032 precedent), every grant to
-- it follows in this same migration. `db:roles:reconcile` later grants LOGIN; it
-- never creates a role.
--
-- Not in this migration: the unique indexes on message_attempts (built
-- CONCURRENTLY by the db:migrate barrier before 0045) and the delivered-attempt
-- foreign key (0046).
-- =============================================================================

-- --- 1. Principal acc_delivery (NOLOGIN until db:roles:reconcile) -------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acc_delivery') THEN
    CREATE ROLE acc_delivery NOLOGIN;
  END IF;
END
$$;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO acc_delivery;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_session_bypasses_rls() TO acc_delivery;--> statement-breakpoint

-- --- 2. Types -----------------------------------------------------------------
CREATE TYPE "public"."message_delivery_status" AS ENUM ('pending', 'delivered', 'undelivered', 'not_supported');--> statement-breakpoint
CREATE TYPE "public"."webhook_event_outcome" AS ENUM ('applied', 'no_change', 'deferred', 'unmatched', 'rejected_malformed', 'conflict', 'informational');--> statement-breakpoint

-- --- 3. Delivery columns (nullable, no default: metadata-only) ----------------
ALTER TABLE "messages"
  ADD COLUMN "delivery_status" "message_delivery_status",
  ADD COLUMN "delivered_at" timestamp with time zone,
  ADD COLUMN "read_at" timestamp with time zone,
  ADD COLUMN "delivered_attempt_id" uuid;--> statement-breakpoint

ALTER TABLE "message_attempts"
  ADD COLUMN "provider_message_id" text,
  ADD COLUMN "delivery_status" "message_delivery_status",
  ADD COLUMN "delivered_at" timestamp with time zone,
  ADD COLUMN "read_at" timestamp with time zone,
  ADD COLUMN "delivery_updated_at" timestamp with time zone;--> statement-breakpoint

-- Consistency checks, NOT VALID here (no scan, no long lock); validated in 0046.
-- Existing rows are all NULL in these columns and satisfy them trivially.
ALTER TABLE "messages" ADD CONSTRAINT "messages_delivered_at_consistent"
  CHECK ((delivered_at IS NULL OR delivery_status = 'delivered') AND (delivery_status IS DISTINCT FROM 'delivered' OR delivered_at IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_read_implies_delivered"
  CHECK (read_at IS NULL OR delivered_at IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_delivered_attempt_consistent"
  CHECK (delivered_attempt_id IS NULL OR delivery_status = 'delivered') NOT VALID;--> statement-breakpoint
ALTER TABLE "message_attempts" ADD CONSTRAINT "message_attempts_delivered_at_consistent"
  CHECK ((delivered_at IS NULL OR delivery_status = 'delivered') AND (delivery_status IS DISTINCT FROM 'delivered' OR delivered_at IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "message_attempts" ADD CONSTRAINT "message_attempts_read_implies_delivered"
  CHECK (read_at IS NULL OR delivered_at IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "message_attempts" ADD CONSTRAINT "message_attempts_provider_message_id_length"
  CHECK (provider_message_id IS NULL OR char_length(provider_message_id) BETWEEN 1 AND 255) NOT VALID;--> statement-breakpoint

-- --- 4. Provider ingress key (hash only) and kill switch ----------------------
-- The plaintext key is shown once at creation/rotation and never stored. The
-- previous hash is accepted until its expiry (rotation grace). Ingress is OFF by
-- default per provider; the deployment flag DELIVERY_WEBHOOKS_ENABLED gates it too.
ALTER TABLE "providers"
  ADD COLUMN "webhook_ingress_key_hash" bytea,
  ADD COLUMN "webhook_ingress_key_previous_hash" bytea,
  ADD COLUMN "webhook_ingress_key_previous_expires_at" timestamp with time zone,
  ADD COLUMN "webhook_ingress_key_rotated_at" timestamp with time zone,
  ADD COLUMN "webhook_ingress_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_webhook_ingress_key_hash_length"
  CHECK (webhook_ingress_key_hash IS NULL OR octet_length(webhook_ingress_key_hash) = 32);--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_webhook_ingress_previous_hash_length"
  CHECK (webhook_ingress_key_previous_hash IS NULL OR octet_length(webhook_ingress_key_previous_hash) = 32);--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_webhook_ingress_previous_consistent"
  CHECK ((webhook_ingress_key_previous_hash IS NULL) = (webhook_ingress_key_previous_expires_at IS NULL)
         AND (webhook_ingress_key_previous_hash IS NULL OR webhook_ingress_key_previous_hash <> webhook_ingress_key_hash));--> statement-breakpoint
CREATE UNIQUE INDEX "providers_webhook_ingress_key_hash_uq" ON "providers" ("webhook_ingress_key_hash") WHERE "webhook_ingress_key_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "providers_webhook_ingress_previous_hash_uq" ON "providers" ("webhook_ingress_key_previous_hash") WHERE "webhook_ingress_key_previous_hash" IS NOT NULL;--> statement-breakpoint

-- --- 5. webhook_events: one row per distinct provider event -------------------
-- Duplicates are counted on the original row (duplicate_count), never stored as
-- rows. A request malformed as a whole writes no row (request-level metric/log
-- only). No raw payload is stored: `normalized` is a redacted envelope.
-- `matched_org_id` is attribution metadata set only after the event matched an
-- attempt (derived from the database row, never from the payload); tenant roles
-- have no access to this table.
CREATE TABLE "webhook_events" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "provider_id" uuid NOT NULL,
  "request_id" uuid NOT NULL,
  "event_index" integer NOT NULL,
  "provider_event_id" text,
  "event_sha256" bytea NOT NULL,
  "signature_timestamp" timestamp with time zone,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "outcome" "webhook_event_outcome" NOT NULL,
  "matched_attempt_id" uuid,
  "matched_org_id" uuid,
  "normalized" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "processed_at" timestamp with time zone,
  "duplicate_count" integer DEFAULT 0 NOT NULL,
  "last_duplicate_at" timestamp with time zone,
  CONSTRAINT "webhook_events_request_event_uq" UNIQUE ("request_id", "event_index"),
  CONSTRAINT "webhook_events_event_index_nonnegative" CHECK ("event_index" >= 0 AND "event_index" < 100),
  CONSTRAINT "webhook_events_provider_event_id_length" CHECK ("provider_event_id" IS NULL OR char_length("provider_event_id") BETWEEN 1 AND 255),
  CONSTRAINT "webhook_events_event_sha256_length" CHECK (octet_length("event_sha256") = 32),
  CONSTRAINT "webhook_events_duplicate_count_nonnegative" CHECK ("duplicate_count" >= 0),
  CONSTRAINT "webhook_events_match_consistent" CHECK (("matched_attempt_id" IS NULL) = ("matched_org_id" IS NULL)),
  CONSTRAINT "webhook_events_normalized_object" CHECK (jsonb_typeof("normalized") = 'object')
);--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_matched_attempt_id_fk" FOREIGN KEY ("matched_attempt_id") REFERENCES "public"."message_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_matched_org_id_fk" FOREIGN KEY ("matched_org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Primary deduplication key: the provider event id. Fallback (only without one): the event hash.
CREATE UNIQUE INDEX "webhook_events_provider_event_uq" ON "webhook_events" ("provider_id", "provider_event_id") WHERE "provider_event_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_hash_uq" ON "webhook_events" ("provider_id", "event_sha256") WHERE "provider_event_id" IS NULL;--> statement-breakpoint
CREATE INDEX "webhook_events_pending_idx" ON "webhook_events" ("provider_id", "outcome") WHERE "outcome" IN ('deferred', 'unmatched');--> statement-breakpoint
CREATE INDEX "webhook_events_matched_attempt_idx" ON "webhook_events" ("matched_attempt_id") WHERE "matched_attempt_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "webhook_events_received_at_idx" ON "webhook_events" ("received_at");--> statement-breakpoint

-- webhook_events integrity: identity columns are immutable; the match is write-once;
-- an outcome may only leave `deferred`/`unmatched` (to a settled outcome); rows are
-- never deleted by an application principal (no DELETE grant).
CREATE OR REPLACE FUNCTION fn_webhook_events_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provider_id IS DISTINCT FROM OLD.provider_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.event_index IS DISTINCT FROM OLD.event_index
     OR NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id
     OR NEW.event_sha256 IS DISTINCT FROM OLD.event_sha256
     OR NEW.signature_timestamp IS DISTINCT FROM OLD.signature_timestamp
     OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
    RAISE EXCEPTION 'WEBHOOK_EVENT_IMMUTABLE: identity of webhook event % cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.matched_attempt_id IS NOT NULL AND NEW.matched_attempt_id IS DISTINCT FROM OLD.matched_attempt_id THEN
    RAISE EXCEPTION 'WEBHOOK_EVENT_MATCH_IMMUTABLE: webhook event % is already matched', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.outcome IS DISTINCT FROM OLD.outcome AND OLD.outcome NOT IN ('deferred', 'unmatched') THEN
    RAISE EXCEPTION 'WEBHOOK_EVENT_OUTCOME_SETTLED: webhook event % outcome % is settled', OLD.id, OLD.outcome
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.duplicate_count < OLD.duplicate_count THEN
    RAISE EXCEPTION 'WEBHOOK_EVENT_DUPLICATE_COUNT_DECREASE: webhook event %', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER trg_webhook_events_guard
  BEFORE UPDATE ON "webhook_events"
  FOR EACH ROW EXECUTE FUNCTION fn_webhook_events_guard();--> statement-breakpoint

-- --- 6. Delivery context and resolver functions -------------------------------
CREATE OR REPLACE FUNCTION app_delivery_provider_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.delivery_provider_id', true), '')::uuid $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_delivery_provider_id() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_delivery_provider_id() TO acc_delivery;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_delivery_message_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.delivery_message_id', true), '')::uuid $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_delivery_message_id() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_delivery_message_id() TO acc_delivery;--> statement-breakpoint

-- Resolves an ingress key hash (current, or previous within its grace) to the
-- provider facts the ingress needs. Returns nothing for an unknown key.
CREATE OR REPLACE FUNCTION app_webhook_provider_resolve(p_key_hash bytea)
RETURNS TABLE (provider_id uuid, adapter_key text, channel_code text, provider_status text, ingress_enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT p.id, p.adapter_key, c.code::text, p.status::text, p.webhook_ingress_enabled
    FROM providers p
    JOIN channels c ON c.id = p.channel_id
   WHERE p_key_hash IS NOT NULL
     AND octet_length(p_key_hash) = 32
     AND (p.webhook_ingress_key_hash = p_key_hash
          OR (p.webhook_ingress_key_previous_hash = p_key_hash
              AND p.webhook_ingress_key_previous_expires_at > now()))
   LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_webhook_provider_resolve(bytea) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_webhook_provider_resolve(bytea) TO acc_delivery;--> statement-breakpoint

-- Resolves a delivery event to exactly one attempt of the given provider: by the
-- provider's message id first, otherwise by ACC's client reference (the attempt
-- id). Never crosses providers; returns no payload or recipient data.
CREATE OR REPLACE FUNCTION app_delivery_resolve(p_provider_id uuid, p_provider_message_id text, p_client_reference uuid)
RETURNS TABLE (attempt_id uuid, message_id uuid, org_id uuid, attempt_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT a.id, a.message_id, a.org_id, a.status::text
    FROM message_attempts a
   WHERE p_provider_id IS NOT NULL
     AND a.provider_id = p_provider_id
     AND (
       (p_provider_message_id IS NOT NULL AND a.provider_message_id = p_provider_message_id)
       OR (p_provider_message_id IS NULL AND p_client_reference IS NOT NULL AND a.id = p_client_reference)
       OR (p_provider_message_id IS NOT NULL AND p_client_reference IS NOT NULL
           AND a.id = p_client_reference AND a.provider_message_id IS NULL)
     )
   ORDER BY (a.provider_message_id = p_provider_message_id) DESC NULLS LAST
   LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_delivery_resolve(uuid, text, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_delivery_resolve(uuid, text, uuid) TO acc_delivery;--> statement-breakpoint

-- Platform support read of webhook_events (spec Rev 2 §C.2a "Other roles"): tenant
-- roles have no access to the table; an active `platform.support.read` holder at
-- platform scope reads the redacted columns through this function only (the 0040
-- pattern: user re-read live, a forged app.is_platform_admin is refused). Never
-- returns a key, a hash or a raw payload. p_limit is clamped to 1..100 here.
CREATE FUNCTION app_platform_support_webhook_events(
  p_provider_id uuid,
  p_outcome text DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
BEGIN
  IF app_current_user_id() IS NULL
     OR NOT app_has_platform_permission('platform.support.read') THEN
    RAISE EXCEPTION 'insufficient privilege for platform support webhook events'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN (
    SELECT coalesce(jsonb_agg(item ORDER BY received_at DESC, id DESC), '[]'::jsonb)
      FROM (
        SELECT e.id, e.received_at,
               jsonb_build_object(
                 'id', e.id,
                 'providerId', e.provider_id,
                 'requestId', e.request_id,
                 'eventIndex', e.event_index,
                 'providerEventId', e.provider_event_id,
                 'outcome', e.outcome::text,
                 'matchedAttemptId', e.matched_attempt_id,
                 'matchedOrgId', e.matched_org_id,
                 'normalized', e.normalized,
                 'signatureTimestamp', e.signature_timestamp,
                 'receivedAt', e.received_at,
                 'processedAt', e.processed_at,
                 'duplicateCount', e.duplicate_count,
                 'lastDuplicateAt', e.last_duplicate_at
               ) AS item
          FROM webhook_events e
         WHERE e.provider_id = p_provider_id
           AND (p_outcome IS NULL OR e.outcome::text = p_outcome)
         ORDER BY e.received_at DESC, e.id DESC
         LIMIT v_limit
      ) recent
  );
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_platform_support_webhook_events(uuid, text, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_platform_support_webhook_events(uuid, text, integer) TO acc_app;--> statement-breakpoint

-- --- 7. Guards ----------------------------------------------------------------
-- Delivery columns, per table. Everything else on a terminal row stays immutable.
-- messages:          delivery_status, delivered_at, read_at, delivered_attempt_id (+ updated_at, set by trigger)
-- message_attempts:  delivery_status, delivered_at, read_at, delivery_updated_at

-- fn_messages_terminal_guard: identical to 0034 except that, on a terminal row, an
-- UPDATE changing ONLY delivery columns (and updated_at) is let through to the
-- delivery guard below instead of raising MESSAGE_ALREADY_TERMINAL.
CREATE OR REPLACE FUNCTION fn_messages_terminal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('accepted', 'failed', 'outcome_unknown') THEN
    IF (to_jsonb(OLD) - ARRAY['delivery_status', 'delivered_at', 'read_at', 'delivered_attempt_id', 'updated_at'])
       = (to_jsonb(NEW) - ARRAY['delivery_status', 'delivered_at', 'read_at', 'delivered_attempt_id', 'updated_at']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'MESSAGE_ALREADY_TERMINAL: message % is terminal (%) and cannot transition', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'queued' AND NEW.status NOT IN ('queued', 'routing', 'submitting', 'failed') THEN
    RAISE EXCEPTION 'ILLEGAL_STATE_TRANSITION: message % cannot transition % -> %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  ELSIF OLD.status = 'routing' AND NEW.status NOT IN ('routing', 'submitting', 'failed') THEN
    RAISE EXCEPTION 'ILLEGAL_STATE_TRANSITION: message % cannot transition % -> %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  ELSIF OLD.status = 'submitting' THEN
    IF NEW.status = 'queued' THEN
      -- Fallback state transition guard (Phase 3.4, ADR-014 §7, P3-D13, P3-D14)
      IF NOT (current_user = 'acc_dispatch' OR app_session_bypasses_rls()) THEN
        RAISE EXCEPTION 'UNAUTHORIZED_REQUEUE: principal % is not permitted to requeue message %', current_user, OLD.id
          USING ERRCODE = 'insufficient_privilege';
      END IF;

      IF NOT app_session_bypasses_rls() THEN
        IF NOT EXISTS (
          SELECT 1 FROM "message_dispatch_queue" q
          WHERE q.message_id = OLD.id
            AND q.claim_token = app_dispatch_claim_token()
            AND q.claimed_until > now()
        ) THEN
          RAISE EXCEPTION 'INVALID_DISPATCH_CLAIM: cannot requeue message % without an active unexpired dispatch claim', OLD.id
            USING ERRCODE = 'check_violation';
        END IF;

        IF OLD.current_attempt_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM "message_attempts" ma
          JOIN "message_dispatch_queue" q ON q.message_id = ma.message_id
          WHERE ma.id = OLD.current_attempt_id
            AND ma.message_id = OLD.id
            AND ma.claim_token = app_dispatch_claim_token()
            AND q.claim_token = app_dispatch_claim_token()
            AND ma.fencing_epoch = q.dispatch_epoch
            AND ma.status = 'failed'
            AND (ma.failure_reason LIKE 'PROVIDER_ERROR%' OR ma.failure_reason LIKE 'RATE_LIMITED%')
        ) THEN
          RAISE EXCEPTION 'FALLBACK_ATTEMPT_UNVERIFIED: message % cannot requeue without a durably settled fallback-eligible attempt', OLD.id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    ELSIF NEW.status NOT IN ('submitting', 'accepted', 'failed', 'outcome_unknown') THEN
      RAISE EXCEPTION 'ILLEGAL_STATE_TRANSITION: message % cannot transition % -> %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- fn_message_attempts_terminal_guard: identical to 0033 except the same delivery-only exception.
CREATE OR REPLACE FUNCTION fn_message_attempts_terminal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('accepted', 'failed', 'outcome_unknown') THEN
    IF (to_jsonb(OLD) - ARRAY['delivery_status', 'delivered_at', 'read_at', 'delivery_updated_at'])
       = (to_jsonb(NEW) - ARRAY['delivery_status', 'delivered_at', 'read_at', 'delivery_updated_at']) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ATTEMPT_ALREADY_TERMINAL: attempt % is terminal (%) and cannot transition', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Rank used for monotonic delivery transitions (spec §B.3).
CREATE OR REPLACE FUNCTION app_delivery_rank(s message_delivery_status) RETURNS integer
LANGUAGE sql IMMUTABLE
AS $$ SELECT CASE s WHEN 'delivered' THEN 2 WHEN 'undelivered' THEN 1 ELSE 0 END $$;--> statement-breakpoint

-- Delivery transition guard, shared by messages and message_attempts:
--   * only acc_delivery and acc_dispatch (or an RLS-bypassing maintenance session)
--     may write delivery columns;
--   * a status, once set, never returns to NULL; among the rank-0 values
--     (pending, not_supported) it is set once from NULL and never swapped;
--   * the rank never decreases (pending/not_supported < undelivered < delivered);
--   * delivered_at, read_at (and messages.delivered_attempt_id) are write-once;
--   * message_attempts.provider_message_id is write-once.
CREATE OR REPLACE FUNCTION fn_delivery_transition_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_status message_delivery_status := OLD.delivery_status;
  new_status message_delivery_status := NEW.delivery_status;
  changed boolean;
BEGIN
  changed := new_status IS DISTINCT FROM old_status
          OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
          OR NEW.read_at IS DISTINCT FROM OLD.read_at;
  IF TG_TABLE_NAME = 'messages' THEN
    changed := changed OR (to_jsonb(NEW)->>'delivered_attempt_id') IS DISTINCT FROM (to_jsonb(OLD)->>'delivered_attempt_id');
  ELSE
    changed := changed
            OR (to_jsonb(NEW)->>'delivery_updated_at') IS DISTINCT FROM (to_jsonb(OLD)->>'delivery_updated_at')
            OR (to_jsonb(NEW)->>'provider_message_id') IS DISTINCT FROM (to_jsonb(OLD)->>'provider_message_id');
  END IF;
  IF NOT changed THEN
    RETURN NEW;
  END IF;

  IF NOT (current_user IN ('acc_delivery', 'acc_dispatch') OR app_session_bypasses_rls()) THEN
    RAISE EXCEPTION 'DELIVERY_WRITE_FORBIDDEN: principal % may not change delivery state of % %', current_user, TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF old_status IS NOT NULL AND new_status IS NULL THEN
    RAISE EXCEPTION 'DELIVERY_TRANSITION_INVALID: % % delivery status cannot return to NULL', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF old_status IS NOT NULL AND new_status IS DISTINCT FROM old_status THEN
    IF app_delivery_rank(new_status) < app_delivery_rank(old_status)
       OR (app_delivery_rank(new_status) = 0 AND app_delivery_rank(old_status) = 0) THEN
      RAISE EXCEPTION 'DELIVERY_TRANSITION_INVALID: % % delivery status cannot change % -> %', TG_TABLE_NAME, OLD.id, old_status, new_status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at THEN
    RAISE EXCEPTION 'DELIVERY_TRANSITION_INVALID: % % delivered_at is write-once', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    RAISE EXCEPTION 'DELIVERY_TRANSITION_INVALID: % % read_at is write-once', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'messages' THEN
    IF (to_jsonb(OLD)->>'delivered_attempt_id') IS NOT NULL
       AND (to_jsonb(NEW)->>'delivered_attempt_id') IS DISTINCT FROM (to_jsonb(OLD)->>'delivered_attempt_id') THEN
      RAISE EXCEPTION 'DELIVERY_TRANSITION_INVALID: message % delivered_attempt_id is write-once', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF (to_jsonb(OLD)->>'provider_message_id') IS NOT NULL
       AND (to_jsonb(NEW)->>'provider_message_id') IS DISTINCT FROM (to_jsonb(OLD)->>'provider_message_id') THEN
      RAISE EXCEPTION 'DELIVERY_TRANSITION_INVALID: attempt % provider_message_id is write-once', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- New rows never carry delivery state (it is only ever set by a later transition).
CREATE OR REPLACE FUNCTION fn_delivery_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF app_session_bypasses_rls() THEN
    RETURN NEW;
  END IF;
  IF NEW.delivery_status IS NOT NULL OR NEW.delivered_at IS NOT NULL OR NEW.read_at IS NOT NULL
     OR (TG_TABLE_NAME = 'messages' AND (to_jsonb(NEW)->>'delivered_attempt_id') IS NOT NULL)
     OR (TG_TABLE_NAME = 'message_attempts' AND ((to_jsonb(NEW)->>'provider_message_id') IS NOT NULL
                                                 OR (to_jsonb(NEW)->>'delivery_updated_at') IS NOT NULL)) THEN
    RAISE EXCEPTION 'DELIVERY_STATE_ON_INSERT: a new % row cannot carry delivery state', TG_TABLE_NAME
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER trg_messages_delivery_guard
  BEFORE UPDATE ON "messages"
  FOR EACH ROW EXECUTE FUNCTION fn_delivery_transition_guard();--> statement-breakpoint
CREATE TRIGGER trg_message_attempts_delivery_guard
  BEFORE UPDATE ON "message_attempts"
  FOR EACH ROW EXECUTE FUNCTION fn_delivery_transition_guard();--> statement-breakpoint
CREATE TRIGGER trg_messages_delivery_insert_guard
  BEFORE INSERT ON "messages"
  FOR EACH ROW EXECUTE FUNCTION fn_delivery_insert_guard();--> statement-breakpoint
CREATE TRIGGER trg_message_attempts_delivery_insert_guard
  BEFORE INSERT ON "message_attempts"
  FOR EACH ROW EXECUTE FUNCTION fn_delivery_insert_guard();--> statement-breakpoint

-- --- 8. Row-level security ----------------------------------------------------
ALTER TABLE "webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- acc_delivery works on exactly one provider per transaction (app.delivery_provider_id,
-- set from the resolved ingress key) and one message at a time (app.delivery_message_id,
-- set from the resolved attempt), inside that message's organization context.
CREATE POLICY webhook_events_delivery_select ON "webhook_events" FOR SELECT TO acc_delivery
  USING (provider_id = app_delivery_provider_id());--> statement-breakpoint
CREATE POLICY webhook_events_delivery_insert ON "webhook_events" FOR INSERT TO acc_delivery
  WITH CHECK (provider_id = app_delivery_provider_id());--> statement-breakpoint
CREATE POLICY webhook_events_delivery_update ON "webhook_events" FOR UPDATE TO acc_delivery
  USING (provider_id = app_delivery_provider_id())
  WITH CHECK (provider_id = app_delivery_provider_id());--> statement-breakpoint

-- acc_dispatch, at settlement, may read and settle only `deferred`/`unmatched` events of
-- the provider of an attempt belonging to the message it currently holds a live claim on.
CREATE POLICY webhook_events_dispatch_select ON "webhook_events" FOR SELECT TO acc_dispatch
  USING (
    outcome IN ('deferred', 'unmatched')
    AND EXISTS (
      SELECT 1 FROM "message_attempts" ma
      JOIN "message_dispatch_queue" q ON q.message_id = ma.message_id
      WHERE ma.message_id = app_dispatch_message_id()
        AND ma.provider_id = webhook_events.provider_id
        AND q.claim_token = app_dispatch_claim_token()
        AND q.claimed_until > now()
    )
  );--> statement-breakpoint
CREATE POLICY webhook_events_dispatch_update ON "webhook_events" FOR UPDATE TO acc_dispatch
  USING (
    outcome IN ('deferred', 'unmatched')
    AND EXISTS (
      SELECT 1 FROM "message_attempts" ma
      JOIN "message_dispatch_queue" q ON q.message_id = ma.message_id
      WHERE ma.message_id = app_dispatch_message_id()
        AND ma.provider_id = webhook_events.provider_id
        AND q.claim_token = app_dispatch_claim_token()
        AND q.claimed_until > now()
    )
  )
  WITH CHECK (
    matched_org_id IS NULL OR matched_org_id = app_current_org_id()
  );--> statement-breakpoint

-- acc_delivery on the message tables: the resolved organization and message only.
CREATE POLICY messages_delivery_select ON "messages" FOR SELECT TO acc_delivery
  USING (org_id = app_current_org_id() AND id = app_delivery_message_id());--> statement-breakpoint
CREATE POLICY messages_delivery_update ON "messages" FOR UPDATE TO acc_delivery
  USING (org_id = app_current_org_id() AND id = app_delivery_message_id())
  WITH CHECK (org_id = app_current_org_id() AND id = app_delivery_message_id());--> statement-breakpoint
CREATE POLICY message_attempts_delivery_select ON "message_attempts" FOR SELECT TO acc_delivery
  USING (org_id = app_current_org_id() AND message_id = app_delivery_message_id());--> statement-breakpoint
CREATE POLICY message_attempts_delivery_update ON "message_attempts" FOR UPDATE TO acc_delivery
  USING (org_id = app_current_org_id() AND message_id = app_delivery_message_id())
  WITH CHECK (org_id = app_current_org_id() AND message_id = app_delivery_message_id());--> statement-breakpoint
CREATE POLICY message_events_delivery_insert ON "message_events" FOR INSERT TO acc_delivery
  WITH CHECK (org_id = app_current_org_id() AND message_id = app_delivery_message_id());--> statement-breakpoint

-- --- 9. Grants (spec Rev 2 §C.2a, plan §1.1) ----------------------------------
GRANT SELECT, INSERT ON "webhook_events" TO acc_delivery;--> statement-breakpoint
GRANT UPDATE (outcome, matched_attempt_id, matched_org_id, normalized, processed_at, duplicate_count, last_duplicate_at) ON "webhook_events" TO acc_delivery;--> statement-breakpoint
GRANT SELECT ON "messages" TO acc_delivery;--> statement-breakpoint
GRANT UPDATE (delivery_status, delivered_at, read_at, delivered_attempt_id, updated_at) ON "messages" TO acc_delivery;--> statement-breakpoint
GRANT SELECT ON "message_attempts" TO acc_delivery;--> statement-breakpoint
GRANT UPDATE (delivery_status, delivered_at, read_at, delivery_updated_at) ON "message_attempts" TO acc_delivery;--> statement-breakpoint
GRANT INSERT ON "message_events" TO acc_delivery;--> statement-breakpoint

-- acc_dispatch additions (settlement): initial delivery state, provider message id,
-- and settling deferred/unmatched events. Existing grants are unchanged.
GRANT UPDATE (delivery_status, delivered_at, read_at, delivered_attempt_id) ON "messages" TO acc_dispatch;--> statement-breakpoint
GRANT UPDATE (provider_message_id, delivery_status, delivered_at, read_at, delivery_updated_at) ON "message_attempts" TO acc_dispatch;--> statement-breakpoint
GRANT SELECT ON "webhook_events" TO acc_dispatch;--> statement-breakpoint
GRANT UPDATE (outcome, matched_attempt_id, matched_org_id, processed_at) ON "webhook_events" TO acc_dispatch;--> statement-breakpoint

-- --- 10. Audit: ingress key administration (the 0019/0020 exact-shape pattern) --
CREATE POLICY audit_logs_provider_webhook_ingress_insert ON audit_logs FOR INSERT TO acc_app
  WITH CHECK (
    scope_type = 'platform'
    AND scope_id IS NULL
    AND actor_type = 'user'
    AND actor_user_id = app_current_user_id()
    AND outcome = 'success'
    AND resource_type = 'Provider'
    AND action IN (
      'provider.webhook_ingress_key_rotated',
      'provider.webhook_ingress_enabled',
      'provider.webhook_ingress_disabled'
    )
    AND app_has_platform_permission('providers.manage')
  );
