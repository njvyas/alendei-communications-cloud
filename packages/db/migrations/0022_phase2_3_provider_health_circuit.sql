-- =============================================================================
-- Phase 2.3 — provider health and circuit breaker (ADR-013 F-6/F-7,
-- ROADMAP §5b 2.3, PROVIDER_ADAPTER.md §5-§6)
--
-- Adds the health and circuit state to `providers` and the append-only
-- `provider_health` samples. The model is canonical in PROVIDER_ADAPTER.md
-- §5-§6 and was frozen before this migration was written (ADR-013 "2.3 design").
--
-- Authorization stays permission-based and names no role (ADR-013 F-3, 0019):
--
--   * `providers.test_send` produces submission samples and moves the circuit,
--     so it may UPDATE a provider — but the guard trigger confines it to the
--     observation columns; administrative columns and the manual override
--     remain `providers.manage` only.
--   * `provider_health` is read on platform-scope eligibility and inserted by
--     sample kind: a `submission` by a `providers.test_send` holder, a `probe`
--     or `override` by a `providers.manage` holder. Append-only.
--   * one exact-shape audit policy admits the four new provider actions.
--
-- No SECURITY DEFINER function is added: everything reuses
-- `app_has_platform_scope()` (0018), `app_has_platform_permission(text)` (0019)
-- and `app_session_bypasses_rls()`. The two trigger functions below are
-- SECURITY INVOKER. Nothing is granted to `acc_auth` or `acc_relay`.
-- =============================================================================

CREATE TYPE "public"."provider_health_classification" AS ENUM('success', 'failure', 'neutral');--> statement-breakpoint
CREATE TYPE "public"."provider_health_sample_kind" AS ENUM('submission', 'probe', 'override');--> statement-breakpoint
CREATE TYPE "public"."provider_health_source" AS ENUM('automatic', 'manual');--> statement-breakpoint
CREATE TABLE "provider_health" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"provider_id" uuid NOT NULL,
	"kind" "provider_health_sample_kind" NOT NULL,
	"outcome" text NOT NULL,
	"classification" "provider_health_classification" NOT NULL,
	"latency_ms" integer,
	"health_state" "provider_health_state" NOT NULL,
	"circuit_state" "provider_circuit_state" NOT NULL,
	"circuit_generation" bigint NOT NULL,
	"source" "provider_health_source" NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_health_outcome_by_kind" CHECK (("provider_health"."kind" = 'submission' AND "provider_health"."outcome" IN ('accepted','timeout','provider_error','rate_limited','auth_error','invalid_request','invalid_recipient','unsupported_content','configuration_error','unknown'))
       OR ("provider_health"."kind" = 'probe' AND "provider_health"."outcome" IN ('healthy','unhealthy','timeout'))
       OR ("provider_health"."kind" = 'override' AND "provider_health"."outcome" = 'manual')),
	CONSTRAINT "provider_health_classification_by_outcome" CHECK ("provider_health"."classification" = CASE
        WHEN "provider_health"."kind" = 'override' THEN 'neutral'
        WHEN "provider_health"."kind" = 'probe' AND "provider_health"."outcome" = 'healthy' THEN 'success'
        WHEN "provider_health"."kind" = 'probe' THEN 'failure'
        WHEN "provider_health"."outcome" = 'accepted' THEN 'success'
        WHEN "provider_health"."outcome" IN ('timeout','provider_error','rate_limited','unknown') THEN 'failure'
        ELSE 'neutral' END::provider_health_classification),
	CONSTRAINT "provider_health_source_by_kind" CHECK (("provider_health"."source" = 'manual') = ("provider_health"."kind" = 'override')),
	CONSTRAINT "provider_health_latency" CHECK (("provider_health"."latency_ms" IS NULL) = ("provider_health"."kind" = 'override') AND ("provider_health"."latency_ms" IS NULL OR "provider_health"."latency_ms" >= 0)),
	CONSTRAINT "provider_health_generation_nonnegative" CHECK ("provider_health"."circuit_generation" >= 0)
);
--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "health_override" "provider_health_state";--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "health_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "circuit_generation" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "circuit_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "circuit_probe_id" uuid;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "circuit_probe_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "providers" ADD COLUMN "circuit_probe_successes" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_health" ADD CONSTRAINT "provider_health_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_health_window_idx" ON "provider_health" USING btree ("provider_id","observed_at","id");--> statement-breakpoint
CREATE INDEX "provider_health_provider_id_idx" ON "provider_health" USING btree ("provider_id","id");--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_health_override_applied" CHECK ("providers"."health_override" IS NULL OR "providers"."health_state" = "providers"."health_override");--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_circuit_generation_nonnegative" CHECK ("providers"."circuit_generation" >= 0);--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_circuit_changed_at_present" CHECK ("providers"."circuit_state" = 'closed' OR "providers"."circuit_changed_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_circuit_probe_slot" CHECK (("providers"."circuit_probe_id" IS NULL) = ("providers"."circuit_probe_lease_until" IS NULL) AND ("providers"."circuit_probe_id" IS NULL OR "providers"."circuit_state" = 'half_open'));--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_circuit_probe_successes" CHECK ("providers"."circuit_probe_successes" >= 0 AND ("providers"."circuit_probe_successes" = 0 OR "providers"."circuit_state" = 'half_open'));
--> statement-breakpoint

-- --- provider_health: global catalogue posture, append-only ----------------------
ALTER TABLE provider_health ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY provider_health_platform_read ON provider_health FOR SELECT TO acc_app
  USING (app_has_platform_scope());
--> statement-breakpoint
-- A sample is written by the operation that observed it, so the permission
-- that admits it is that operation's: test-send writes `submission`, the health
-- check writes `probe`, the manual override writes `override`.
CREATE POLICY provider_health_platform_insert ON provider_health FOR INSERT TO acc_app
  WITH CHECK (
    (kind = 'submission' AND app_has_platform_permission('providers.test_send'))
    OR (kind IN ('probe', 'override') AND app_has_platform_permission('providers.manage'))
  );
--> statement-breakpoint
GRANT SELECT, INSERT ON provider_health TO acc_app;
--> statement-breakpoint

CREATE FUNCTION fn_provider_health_append_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'provider_health is append-only: % is not permitted (record a new sample instead)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_provider_health_append_only
  BEFORE UPDATE OR DELETE ON provider_health
  FOR EACH ROW EXECUTE FUNCTION fn_provider_health_append_only();
--> statement-breakpoint
CREATE TRIGGER trg_provider_health_no_truncate
  BEFORE TRUNCATE ON provider_health
  FOR EACH STATEMENT EXECUTE FUNCTION fn_provider_health_append_only();
--> statement-breakpoint

-- --- providers: test_send may write observation state, and only that ----------
-- An additional permissive UPDATE policy; `providers_platform_update`
-- (`providers.manage`, 0019) is unchanged. RLS cannot compare OLD with NEW, so
-- the guard trigger below decides which columns a non-manager may change.
CREATE POLICY providers_platform_observation_update ON providers FOR UPDATE TO acc_app
  USING (app_has_platform_permission('providers.test_send'))
  WITH CHECK (app_has_platform_permission('providers.test_send'));
--> statement-breakpoint

-- The database backstop for PROVIDER_ADAPTER.md §6e. For every principal but
-- the owner/maintenance session:
--   1. administrative columns and the manual override change only for a
--      `providers.manage` holder;
--   2. `circuit_state` changes only along T1-T4, each advancing
--      `circuit_generation` by exactly one, and the generation never changes
--      otherwise — so a stale writer can neither skip an edge nor overwrite a
--      newer episode.
-- SECURITY INVOKER: it decides with the caller's own authority.
CREATE FUNCTION fn_providers_state_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
BEGIN
  IF app_session_bypasses_rls() THEN
    RETURN NEW;
  END IF;

  IF (NEW.channel_id, NEW.name, NEW.adapter_key, NEW.status, NEW.health_override)
       IS DISTINCT FROM
     (OLD.channel_id, OLD.name, OLD.adapter_key, OLD.status, OLD.health_override)
     AND NOT app_has_platform_permission('providers.manage') THEN
    RAISE EXCEPTION 'changing a provider''s administrative columns or health override requires providers.manage'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.circuit_state IS DISTINCT FROM OLD.circuit_state THEN
    IF OLD.circuit_state::text || '>' || NEW.circuit_state::text NOT IN
         ('closed>open', 'open>half_open', 'half_open>open', 'half_open>closed') THEN
      RAISE EXCEPTION 'illegal circuit transition % -> %', OLD.circuit_state, NEW.circuit_state
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.circuit_generation IS DISTINCT FROM OLD.circuit_generation + 1 THEN
      RAISE EXCEPTION 'a circuit transition advances the generation by exactly one (% -> %)',
        OLD.circuit_generation, NEW.circuit_generation
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.circuit_generation IS DISTINCT FROM OLD.circuit_generation THEN
    RAISE EXCEPTION 'the circuit generation changes only with a circuit transition'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER trg_providers_state_guard
  BEFORE UPDATE ON providers
  FOR EACH ROW EXECUTE FUNCTION fn_providers_state_guard();
--> statement-breakpoint

-- --- Audit: the four health/circuit actions, an exact row shape ----------------
-- Each action is admitted for the permission of the operation that records it:
-- the health check and the override (`providers.manage`); a health change, from
-- either of those or from a test-send (`providers.manage` or
-- `providers.test_send`); a circuit change, only ever from a test-send
-- (`providers.test_send`). Every other audit policy is unchanged.
CREATE POLICY audit_logs_provider_health_insert ON audit_logs FOR INSERT TO acc_app
  WITH CHECK (
    scope_type = 'platform'
    AND scope_id IS NULL
    AND actor_type = 'user'
    AND actor_user_id = app_current_user_id()
    AND resource_type = 'Provider'
    AND (
      (action = 'provider.health_checked' AND outcome IN ('success', 'failure')
        AND app_has_platform_permission('providers.manage'))
      OR (action = 'provider.health_overridden' AND outcome = 'success'
        AND app_has_platform_permission('providers.manage'))
      OR (action = 'provider.health_changed' AND outcome = 'success'
        AND (app_has_platform_permission('providers.manage')
             OR app_has_platform_permission('providers.test_send')))
      OR (action = 'provider.circuit_changed' AND outcome = 'success'
        AND app_has_platform_permission('providers.test_send'))
    )
  );
