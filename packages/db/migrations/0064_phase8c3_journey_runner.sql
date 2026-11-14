-- Phase 8C PR 8C-3: the journey runner's database principal and claim protocol (owner approval
-- 10-Nov-2026; docs/PHASE-8C-JOURNEYS-HANDOVER.md §§8.2, 8.3, 9).
--
-- acc_journey is created NOLOGIN, as acc_delivery was (0044): this migration gives it no
-- credential, and the runner is off unless JOURNEY_RUNNER_ENABLED is set with an explicit
-- DATABASE_JOURNEY_URL — both a separately authorised enablement step.
--
-- Every acc_journey policy is bound to ONE claimed execution: the session names it
-- (app.journey_execution_id, app.journey_claim_token, app.current_org_id) and the claim must
-- still be live (token matches, lease not expired) — app_journey_claim_valid(). A worker whose
-- lease expired, or whose claim another worker took over, sees and writes nothing. Discovery
-- and claiming go only through app_journey_claim() (SECURITY DEFINER), which also skips
-- executions of journeys that are not active.
--
-- acc_journey can never create a message, a dispatch-queue row or anything financial: it has
-- no privilege on those tables. Expand-only: two queue columns, functions, policies, grants.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acc_journey') THEN
    CREATE ROLE acc_journey NOLOGIN;
  END IF;
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO acc_journey;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_session_bypasses_rls() TO acc_journey;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_org_id() TO acc_journey;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_channel_resolve(text) TO acc_journey;--> statement-breakpoint

-- Retry bookkeeping on the content-free claim rows: claims without progress, last error code.
ALTER TABLE "journey_execution_queue" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "journey_execution_queue" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "journey_execution_queue" ADD CONSTRAINT "journey_execution_queue_attempts_nonnegative" CHECK ("attempts" >= 0);--> statement-breakpoint
ALTER TABLE "journey_execution_queue" ADD CONSTRAINT "journey_execution_queue_error_code_length" CHECK ("last_error_code" IS NULL OR char_length("last_error_code") BETWEEN 1 AND 100);--> statement-breakpoint

CREATE FUNCTION app_journey_execution_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.journey_execution_id', true), '')::uuid $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_execution_id() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_journey_execution_id() TO acc_journey;--> statement-breakpoint

CREATE FUNCTION app_journey_claim_token() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.journey_claim_token', true), '')::uuid $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_claim_token() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_journey_claim_token() TO acc_journey;--> statement-breakpoint

-- The session's claim is live: its queue row, in its organisation, still holds its token and
-- the lease has not expired. Definer, so the check does not depend on the caller's own policies.
CREATE FUNCTION app_journey_claim_valid() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM journey_execution_queue q
     WHERE q.execution_id = app_journey_execution_id()
       AND q.org_id = app_current_org_id()
       AND q.claim_token = app_journey_claim_token()
       AND q.claimed_until > now()
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_claim_valid() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_journey_claim_valid() TO acc_journey;--> statement-breakpoint

-- The claimed execution's journey, version, contact and workspace (definer: read once, by id).
CREATE FUNCTION app_journey_claimed_execution()
RETURNS TABLE (journey_id uuid, journey_version_id uuid, contact_id uuid, workspace_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT e.journey_id, e.journey_version_id, e.contact_id, e.workspace_id
    FROM journey_executions e
   WHERE e.id = app_journey_execution_id()
     AND e.org_id = app_current_org_id()
     AND app_journey_claim_valid()
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_claimed_execution() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_journey_claimed_execution() TO acc_journey;--> statement-breakpoint

-- Discovery and claim (handover §8.2). Due, unclaimed or lease-expired rows of live executions
-- of ACTIVE journeys; at most p_per_org per organisation per call (fairness), p_limit in all.
-- Each claimed row gets a fresh token, a lease, epoch + 1 (fencing) and attempts + 1 (claims
-- without progress; the runner resets it on a committed transition). SKIP LOCKED: a row held
-- by a worker inside its transition transaction is never taken.
CREATE FUNCTION app_journey_claim(p_worker text, p_limit integer, p_lease_seconds integer, p_per_org integer)
RETURNS TABLE (execution_id uuid, org_id uuid, claim_token uuid, epoch integer, attempts integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR p_lease_seconds IS NULL
     OR p_lease_seconds < 5 OR p_lease_seconds > 600 OR p_per_org IS NULL OR p_per_org < 1
     OR p_worker IS NULL OR char_length(p_worker) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'app_journey_claim: invalid arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  WITH ranked AS (
    SELECT q.execution_id,
           row_number() OVER (PARTITION BY q.org_id ORDER BY q.available_at, q.execution_id) AS rn
      FROM journey_execution_queue q
      JOIN journey_executions e ON e.id = q.execution_id AND e.org_id = q.org_id
      JOIN journeys j ON j.id = e.journey_id AND j.org_id = e.org_id
     WHERE q.available_at <= now()
       AND (q.claimed_until IS NULL OR q.claimed_until < now())
       AND e.status IN ('running', 'waiting')
       AND j.status = 'active'
       AND j.deleted_at IS NULL
  ), picked AS (
    SELECT q.execution_id
      FROM journey_execution_queue q
     WHERE q.execution_id IN (SELECT r.execution_id FROM ranked r WHERE r.rn <= p_per_org)
       AND q.available_at <= now()
       AND (q.claimed_until IS NULL OR q.claimed_until < now())
     ORDER BY q.available_at, q.execution_id
     LIMIT p_limit
       FOR UPDATE SKIP LOCKED
  )
  UPDATE journey_execution_queue q
     SET claim_token = gen_random_uuid(),
         claimed_until = now() + make_interval(secs => p_lease_seconds),
         claimed_by = p_worker,
         epoch = q.epoch + 1,
         attempts = q.attempts + 1
    FROM picked
   WHERE q.execution_id = picked.execution_id
  RETURNING q.execution_id, q.org_id, q.claim_token, q.epoch, q.attempts;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_claim(text, integer, integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_journey_claim(text, integer, integer, integer) TO acc_journey;--> statement-breakpoint

-- --- acc_journey policies: the one claimed execution, while its claim is live -------------

-- SELECT names the session's execution only (content-free); it does not require the live claim,
-- because a release clears the token and PostgreSQL checks the updated row against SELECT
-- policies too. The runner's fence read checks token, lease and epoch explicitly; UPDATE and
-- DELETE require the live claim.
CREATE POLICY journey_execution_queue_runner_select ON "journey_execution_queue" FOR SELECT TO acc_journey
  USING (execution_id = app_journey_execution_id() AND org_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY journey_execution_queue_runner_update ON "journey_execution_queue" FOR UPDATE TO acc_journey
  USING (execution_id = app_journey_execution_id() AND org_id = app_current_org_id()
         AND claim_token = app_journey_claim_token() AND claimed_until > now())
  WITH CHECK (execution_id = app_journey_execution_id() AND org_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY journey_execution_queue_runner_delete ON "journey_execution_queue" FOR DELETE TO acc_journey
  USING (execution_id = app_journey_execution_id() AND org_id = app_current_org_id()
         AND claim_token = app_journey_claim_token() AND claimed_until > now());--> statement-breakpoint

CREATE POLICY journey_executions_runner_select ON "journey_executions" FOR SELECT TO acc_journey
  USING (id = app_journey_execution_id() AND org_id = app_current_org_id() AND (SELECT app_journey_claim_valid()));--> statement-breakpoint
CREATE POLICY journey_executions_runner_update ON "journey_executions" FOR UPDATE TO acc_journey
  USING (id = app_journey_execution_id() AND org_id = app_current_org_id() AND (SELECT app_journey_claim_valid()))
  WITH CHECK (id = app_journey_execution_id() AND org_id = app_current_org_id() AND (SELECT app_journey_claim_valid()));--> statement-breakpoint

CREATE POLICY journey_execution_steps_runner_select ON "journey_execution_steps" FOR SELECT TO acc_journey
  USING (execution_id = app_journey_execution_id() AND org_id = app_current_org_id() AND (SELECT app_journey_claim_valid()));--> statement-breakpoint
CREATE POLICY journey_execution_steps_runner_insert ON "journey_execution_steps" FOR INSERT TO acc_journey
  WITH CHECK (execution_id = app_journey_execution_id() AND org_id = app_current_org_id() AND (SELECT app_journey_claim_valid()));--> statement-breakpoint

CREATE POLICY journey_versions_runner_select ON "journey_versions" FOR SELECT TO acc_journey
  USING (org_id = app_current_org_id()
         AND id = (SELECT c.journey_version_id FROM app_journey_claimed_execution() c));--> statement-breakpoint
CREATE POLICY journeys_runner_select ON "journeys" FOR SELECT TO acc_journey
  USING (org_id = app_current_org_id()
         AND id = (SELECT c.journey_id FROM app_journey_claimed_execution() c));--> statement-breakpoint

CREATE POLICY contacts_runner_select ON "contacts" FOR SELECT TO acc_journey
  USING (org_id = app_current_org_id()
         AND id = (SELECT c.contact_id FROM app_journey_claimed_execution() c));--> statement-breakpoint
CREATE POLICY contacts_runner_update ON "contacts" FOR UPDATE TO acc_journey
  USING (org_id = app_current_org_id()
         AND id = (SELECT c.contact_id FROM app_journey_claimed_execution() c))
  WITH CHECK (org_id = app_current_org_id()
         AND id = (SELECT c.contact_id FROM app_journey_claimed_execution() c));--> statement-breakpoint
CREATE POLICY contact_identities_runner_select ON "contact_identities" FOR SELECT TO acc_journey
  USING (org_id = app_current_org_id()
         AND contact_id = (SELECT c.contact_id FROM app_journey_claimed_execution() c));--> statement-breakpoint
CREATE POLICY consent_events_runner_select ON "consent_events" FOR SELECT TO acc_journey
  USING (org_id = app_current_org_id()
         AND contact_id = (SELECT c.contact_id FROM app_journey_claimed_execution() c));--> statement-breakpoint
-- Only the suppressions that name one of the claimed contact's addresses.
CREATE POLICY suppressions_runner_select ON "suppressions" FOR SELECT TO acc_journey
  USING (org_id = app_current_org_id()
         AND normalized_address IN (
           SELECT ci.normalized_address FROM contact_identities ci
            WHERE ci.org_id = app_current_org_id()
              AND ci.contact_id = (SELECT c.contact_id FROM app_journey_claimed_execution() c)));--> statement-breakpoint
CREATE POLICY segments_runner_select ON "segments" FOR SELECT TO acc_journey
  USING (org_id = app_current_org_id()
         AND workspace_id = (SELECT c.workspace_id FROM app_journey_claimed_execution() c));--> statement-breakpoint

-- update_contact is audited as the system actor `journey_runner`, against the claimed contact.
CREATE POLICY audit_logs_journey_runner_insert ON "audit_logs" FOR INSERT TO acc_journey
  WITH CHECK (org_id = app_current_org_id()
              AND (SELECT app_journey_claim_valid())
              AND actor_type = 'system' AND actor_label = 'journey_runner'
              AND actor_user_id IS NULL AND actor_api_key_id IS NULL
              AND action = 'contact.updated' AND resource_type = 'Contact'
              AND resource_id = (SELECT c.contact_id FROM app_journey_claimed_execution() c));--> statement-breakpoint

GRANT SELECT, DELETE ON "journey_execution_queue" TO acc_journey;--> statement-breakpoint
GRANT UPDATE ("available_at", "claim_token", "claimed_until", "claimed_by", "attempts", "last_error_code") ON "journey_execution_queue" TO acc_journey;--> statement-breakpoint
GRANT SELECT ON "journey_executions" TO acc_journey;--> statement-breakpoint
GRANT UPDATE ("status", "current_node_key", "wake_at", "state_version", "transitions", "ended_at", "end_reason", "updated_at") ON "journey_executions" TO acc_journey;--> statement-breakpoint
GRANT SELECT, INSERT ON "journey_execution_steps" TO acc_journey;--> statement-breakpoint
GRANT SELECT ON "journey_versions", "journeys", "contact_identities", "consent_events", "suppressions", "segments" TO acc_journey;--> statement-breakpoint
GRANT SELECT ON "contacts" TO acc_journey;--> statement-breakpoint
GRANT UPDATE ("first_name", "last_name", "metadata", "updated_at") ON "contacts" TO acc_journey;--> statement-breakpoint
GRANT INSERT ON "audit_logs" TO acc_journey;
