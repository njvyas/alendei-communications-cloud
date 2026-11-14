-- Phase 8C PR 8C-5b: the journey send node's database surface (handover Rev 2 §§3.1D, 6, 7),
-- plus the N1 hardening from the independent review of PR #110.
--
-- Nothing here lets a journey create a message: acc_journey gains no INSERT or UPDATE on
-- messages (the send-path policies are 8B-3/8C-6), and the production send port is
-- unavailable. No capability table, function or policy (8B-3). No switch, flag or role
-- attribute changes; acc_journey stays NOLOGIN with no credential.

-- --- N1: the step <-> message guard fails closed --------------------------------------------
-- 0066's guard passed when its lookup found no row, leaving a missing message to the foreign
-- key. A message that exists but is not visible to the function's owner (FORCE RLS, or a
-- change of owner) would then have passed both the guard (no row) and the foreign key (which
-- checks without row security). A step naming a message the guard cannot read is now refused
-- with the foreign key's SQLSTATE and name, so a genuinely missing message reports exactly as
-- before; a message attributed to another execution, or to none, is still 23514.
CREATE OR REPLACE FUNCTION app_journey_step_message_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_execution uuid;
BEGIN
  SELECT m.journey_execution_id INTO v_execution
    FROM messages m WHERE m.id = NEW.message_id AND m.org_id = NEW.org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'journey step message % is not visible in organization %', NEW.message_id, NEW.org_id
      USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'journey_execution_steps_message_fk';
  END IF;
  IF v_execution IS DISTINCT FROM NEW.execution_id THEN
    RAISE EXCEPTION 'journey step message % is not attributed to execution %', NEW.message_id, NEW.execution_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journey_execution_steps_message_execution';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_step_message_guard() FROM PUBLIC;--> statement-breakpoint

-- --- §3.1D: the runner reads its claimed execution's attributed messages ------------------
-- Read-only, outcome columns only, and bound like every acc_journey policy to the session's
-- claimed execution with a live claim (0064). wait_for_outcome and send_outcome need nothing
-- else; the recipient, payload and billing columns stay unreadable.
CREATE POLICY messages_runner_select ON "messages" FOR SELECT TO acc_journey
  USING (org_id = app_current_org_id()
         AND journey_execution_id = app_journey_execution_id()
         AND (SELECT app_journey_claim_valid()));--> statement-breakpoint
GRANT SELECT ("id", "org_id", "journey_execution_id", "status", "delivery_status", "delivered_at", "read_at")
  ON "messages" TO acc_journey;--> statement-breakpoint

-- The runner arms, keeps and clears wait_for_outcome deadlines (§6); the 0064 update policy
-- already binds the row to the claimed execution.
GRANT UPDATE ("wait_deadline_at") ON "journey_executions" TO acc_journey;
