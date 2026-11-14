-- Phase 8C PR 8C-5a: journey send attribution (handover Rev 2 §3.1 A–C).
--
-- Schema only. No journey send path exists after this migration: no runner code, policy or
-- grant changes, no capability table, function or policy (8B-3), and every journey, runner,
-- event-intake and scheduler switch stays as it was.
--
-- The migrator applies every pending migration in ONE transaction (schema-migrate.ts), so a
-- NOT VALID / VALIDATE split gives no lock benefit here. The constraints are added validated,
-- as in 0052 (messages.campaign_id); the result is the same as Rev 2's split: no NOT VALID
-- constraint remains.

-- --- C. journey_executions: composite FK target and the wait deadline column -------------
-- The deadline's behaviour (set, re-arm, clear on every end path) is 8C-5b; 8C-5a adds only
-- the column and its invariant. It is not added to any acc_journey column grant here.
ALTER TABLE "journey_executions" ADD COLUMN "wait_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "journey_executions" ADD CONSTRAINT "journey_executions_wait_deadline_shape"
  CHECK ("wait_deadline_at" IS NULL OR "status" = 'waiting');--> statement-breakpoint
ALTER TABLE "journey_executions" ADD CONSTRAINT "uq_journey_executions_attribution"
  UNIQUE ("id", "journey_id", "workspace_id", "contact_id", "org_id");--> statement-breakpoint

-- --- A. messages: nullable attribution columns (expand-only, no rewrite, no new index) ----
-- Executions are never deleted (trg_journey_executions_guard), so FK enforcement needs no
-- child index on messages.
ALTER TABLE "messages" ADD COLUMN "journey_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "journey_execution_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_journey_shape"
  CHECK (("journey_id" IS NULL) = ("journey_execution_id" IS NULL));--> statement-breakpoint
-- The message's workspace, contact and organisation must be the execution's own, and the
-- journey must be the execution's journey.
ALTER TABLE "messages" ADD CONSTRAINT "messages_journey_execution_fk"
  FOREIGN KEY ("journey_execution_id", "journey_id", "workspace_id", "contact_id", "org_id")
  REFERENCES "public"."journey_executions" ("id", "journey_id", "workspace_id", "contact_id", "org_id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Write-once: the attribution is set at insert or never. The 0033 tenant-key trigger is
-- extended (same generic invoker function, same name) so every principal, the owner
-- included, is refused any change to either column after insert, NULL -> value included.
DROP TRIGGER "trg_messages_tenant_key_immutable" ON "messages";--> statement-breakpoint
CREATE TRIGGER trg_messages_tenant_key_immutable
  AFTER UPDATE OF org_id, workspace_id, contact_id, channel_id, journey_id, journey_execution_id ON "messages"
  FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR OLD.contact_id IS DISTINCT FROM NEW.contact_id OR OLD.channel_id IS DISTINCT FROM NEW.channel_id OR OLD.journey_id IS DISTINCT FROM NEW.journey_id OR OLD.journey_execution_id IS DISTINCT FROM NEW.journey_execution_id)
  EXECUTE FUNCTION fn_tenant_key_immutable('org_id', 'workspace_id', 'contact_id', 'channel_id', 'journey_id', 'journey_execution_id');--> statement-breakpoint

-- --- B. journey_execution_steps: step <-> message integrity -------------------------------
-- UNIQUE (message_id) already exists (0063, uq_journey_execution_steps_message).
ALTER TABLE "journey_execution_steps" ADD CONSTRAINT "journey_execution_steps_message_fk"
  FOREIGN KEY ("message_id", "org_id") REFERENCES "public"."messages" ("id", "org_id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_execution_steps" ADD CONSTRAINT "journey_execution_steps_message_shape"
  CHECK ("message_id" IS NULL OR ("node_type" = 'send_message' AND "outcome" = 'completed'));--> statement-breakpoint

-- A step may name only a message attributed to its own execution. Definer so the check sees
-- the message whatever the inserting principal may read; it reads one row by primary key and
-- writes nothing. A message that does not exist is left to the foreign key (23503).
CREATE FUNCTION app_journey_step_message_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_found boolean;
  v_execution uuid;
BEGIN
  SELECT true, m.journey_execution_id INTO v_found, v_execution
    FROM messages m WHERE m.id = NEW.message_id AND m.org_id = NEW.org_id;
  IF v_found AND v_execution IS DISTINCT FROM NEW.execution_id THEN
    RAISE EXCEPTION 'journey step message % is not attributed to execution %', NEW.message_id, NEW.execution_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'journey_execution_steps_message_execution';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_step_message_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER trg_journey_execution_steps_message_guard BEFORE INSERT ON "journey_execution_steps"
  FOR EACH ROW WHEN (NEW.message_id IS NOT NULL) EXECUTE FUNCTION app_journey_step_message_guard();
