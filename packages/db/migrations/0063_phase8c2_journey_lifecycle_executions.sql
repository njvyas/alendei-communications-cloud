-- Phase 8C PR 8C-2: journey lifecycle, derived triggers, executions, execution queue and
-- append-only step history (owner approval 10-Nov-2026; docs/PHASE-8C-JOURNEYS-HANDOVER.md
-- §§5, 7, 8.1, 8.5). Model B RLS on every new table, composite tenant/workspace FKs.
-- Non-executing by construction: nothing here claims queue rows, processes triggers or events,
-- runs a step or sends. The runner (8C-3), trigger intake (8C-4) and sends (8C-5/8C-6) are not
-- built, and no role other than acc_app is granted anything on these tables.
-- Expand-only: new types, tables, functions and triggers; `journeys` gains three nullable
-- columns, one CHECK and one trigger; `journey_versions` gains one UNIQUE constraint.
CREATE TYPE "public"."journey_trigger_kind" AS ENUM('api', 'event', 'schedule');--> statement-breakpoint
CREATE TYPE "public"."journey_trigger_status" AS ENUM('active', 'paused', 'retired');--> statement-breakpoint
CREATE TYPE "public"."journey_execution_status" AS ENUM('running', 'waiting', 'completed', 'exited', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."journey_step_outcome" AS ENUM('entered', 'completed', 'waited', 'skipped', 'refused', 'failed', 'stubbed', 'exited', 'cancelled');--> statement-breakpoint

-- journey_versions: the target of composite FKs that bind a version to its journey.
ALTER TABLE "journey_versions" ADD CONSTRAINT "uq_journey_versions_id_journey_org" UNIQUE("id","journey_id","org_id");--> statement-breakpoint

-- journeys: the version new enrolments use, and who activated the journey.
ALTER TABLE "journeys" ADD COLUMN "active_version_id" uuid;--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "journeys" ADD COLUMN "activated_by" uuid;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_active_version_fk" FOREIGN KEY ("active_version_id","id","org_id") REFERENCES "public"."journey_versions"("id","journey_id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journeys" ADD CONSTRAINT "journeys_active_version_shape" CHECK ("status" NOT IN ('active', 'paused') OR ("active_version_id" IS NOT NULL AND "activated_at" IS NOT NULL));--> statement-breakpoint

-- Lifecycle guard: draft → active | archived; active ↔ paused; active | paused → archived.
-- `archived` is terminal. Once set, the active version is never cleared, and it may only name
-- a published version. A journey that was ever activated never returns to draft.
CREATE FUNCTION app_journeys_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('active', 'archived'))
    OR (OLD.status = 'active' AND NEW.status IN ('paused', 'archived'))
    OR (OLD.status = 'paused' AND NEW.status IN ('active', 'archived'))
  ) THEN
    RAISE EXCEPTION 'journey % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'archived' AND (NEW.active_version_id IS DISTINCT FROM OLD.active_version_id
     OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
     OR NEW.activated_by IS DISTINCT FROM OLD.activated_by) THEN
    RAISE EXCEPTION 'journey % is archived', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.active_version_id IS NOT NULL AND NEW.active_version_id IS NULL THEN
    RAISE EXCEPTION 'the active version of journey % cannot be cleared', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.active_version_id IS NOT NULL
     AND NEW.active_version_id IS DISTINCT FROM OLD.active_version_id
     AND NOT EXISTS (SELECT 1 FROM journey_versions v
                     WHERE v.id = NEW.active_version_id AND v.status = 'published') THEN
    RAISE EXCEPTION 'the active version of journey % must be published', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journeys_lifecycle_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER trg_journeys_lifecycle_guard BEFORE UPDATE ON "journeys"
  FOR EACH ROW EXECUTE FUNCTION app_journeys_lifecycle_guard();--> statement-breakpoint

-- Triggers derived from a version's entry node at activation (and re-derived when a new
-- version is published while the journey is active or paused). Nothing reads them yet: event
-- intake and scheduled processing are 8C-4.
CREATE TABLE "journey_triggers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"journey_id" uuid NOT NULL,
	"journey_version_id" uuid NOT NULL,
	"kind" "journey_trigger_kind" NOT NULL,
	"event_kind" text,
	"event_tag" text,
	"segment_id" uuid,
	"schedule" jsonb,
	"next_fire_at" timestamp with time zone,
	"status" "journey_trigger_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journey_triggers_kind_shape" CHECK (
		("kind" = 'api' AND "event_kind" IS NULL AND "event_tag" IS NULL AND "segment_id" IS NULL AND "schedule" IS NULL AND "next_fire_at" IS NULL)
		OR ("kind" = 'event' AND "event_kind" IS NOT NULL AND "segment_id" IS NULL AND "schedule" IS NULL AND "next_fire_at" IS NULL)
		OR ("kind" = 'schedule' AND "event_kind" IS NULL AND "event_tag" IS NULL AND "segment_id" IS NOT NULL AND jsonb_typeof("schedule") = 'object')
	)
);--> statement-breakpoint

ALTER TABLE "journey_triggers" ADD CONSTRAINT "journey_triggers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_triggers" ADD CONSTRAINT "journey_triggers_journey_fk" FOREIGN KEY ("journey_id","workspace_id","org_id") REFERENCES "public"."journeys"("id","workspace_id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_triggers" ADD CONSTRAINT "journey_triggers_version_fk" FOREIGN KEY ("journey_version_id","journey_id","org_id") REFERENCES "public"."journey_versions"("id","journey_id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_journey_triggers_version" ON "journey_triggers" USING btree ("journey_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_journey_triggers_one_live" ON "journey_triggers" USING btree ("journey_id") WHERE status <> 'retired';--> statement-breakpoint
CREATE INDEX "journey_triggers_due_idx" ON "journey_triggers" USING btree ("next_fire_at") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "journey_triggers_org_event_idx" ON "journey_triggers" USING btree ("org_id","event_kind") WHERE status = 'active' AND kind = 'event';--> statement-breakpoint

-- One contact's passage through one journey version.
CREATE TABLE "journey_executions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"journey_id" uuid NOT NULL,
	"journey_version_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" "journey_execution_status" DEFAULT 'running' NOT NULL,
	"current_node_key" text,
	"wake_at" timestamp with time zone,
	"state_version" integer DEFAULT 0 NOT NULL,
	"transitions" integer DEFAULT 0 NOT NULL,
	"entry_kind" "journey_trigger_kind" NOT NULL,
	"entry_ref" text NOT NULL,
	"enrolled_by" uuid,
	"entered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_journey_executions_id_workspace_org" UNIQUE("id","workspace_id","org_id"),
	CONSTRAINT "uq_journey_executions_id_org" UNIQUE("id","org_id"),
	CONSTRAINT "journey_executions_state_version_nonnegative" CHECK ("state_version" >= 0),
	CONSTRAINT "journey_executions_transitions_bounded" CHECK ("transitions" BETWEEN 0 AND 1000),
	CONSTRAINT "journey_executions_entry_ref_length" CHECK (char_length("entry_ref") BETWEEN 1 AND 200),
	CONSTRAINT "journey_executions_end_shape" CHECK (
		("status" IN ('running', 'waiting')) = ("ended_at" IS NULL)
		AND ("ended_at" IS NULL) = ("end_reason" IS NULL)
	),
	CONSTRAINT "journey_executions_end_reason_length" CHECK ("end_reason" IS NULL OR char_length("end_reason") BETWEEN 1 AND 100),
	CONSTRAINT "journey_executions_live_node" CHECK ("status" NOT IN ('running', 'waiting') OR "current_node_key" IS NOT NULL)
);--> statement-breakpoint

ALTER TABLE "journey_executions" ADD CONSTRAINT "journey_executions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_executions" ADD CONSTRAINT "journey_executions_enrolled_by_users_id_fk" FOREIGN KEY ("enrolled_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_executions" ADD CONSTRAINT "journey_executions_journey_fk" FOREIGN KEY ("journey_id","workspace_id","org_id") REFERENCES "public"."journeys"("id","workspace_id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_executions" ADD CONSTRAINT "journey_executions_version_fk" FOREIGN KEY ("journey_version_id","journey_id","org_id") REFERENCES "public"."journey_versions"("id","journey_id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_executions" ADD CONSTRAINT "journey_executions_contact_fk" FOREIGN KEY ("contact_id","workspace_id","org_id") REFERENCES "public"."contacts"("id","workspace_id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- No contact is ever in two live executions of one journey (handover §5).
CREATE UNIQUE INDEX "uq_journey_executions_live_contact" ON "journey_executions" USING btree ("journey_id","contact_id") WHERE status IN ('running', 'waiting');--> statement-breakpoint
-- Idempotent enrolment: one execution per journey, contact and entry reference.
CREATE UNIQUE INDEX "uq_journey_executions_entry" ON "journey_executions" USING btree ("journey_id","contact_id","entry_ref");--> statement-breakpoint
CREATE INDEX "journey_executions_journey_id_idx" ON "journey_executions" USING btree ("journey_id","id");--> statement-breakpoint
CREATE INDEX "journey_executions_version_status_idx" ON "journey_executions" USING btree ("journey_version_id","status");--> statement-breakpoint
CREATE INDEX "journey_executions_contact_idx" ON "journey_executions" USING btree ("org_id","contact_id");--> statement-breakpoint

-- Execution guard: identity never changes, an ended execution never changes, state_version
-- never decreases, and no execution is deleted.
CREATE FUNCTION app_journey_executions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'journey executions are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id OR NEW.journey_id IS DISTINCT FROM OLD.journey_id
     OR NEW.journey_version_id IS DISTINCT FROM OLD.journey_version_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.entry_kind IS DISTINCT FROM OLD.entry_kind
     OR NEW.entry_ref IS DISTINCT FROM OLD.entry_ref OR NEW.enrolled_by IS DISTINCT FROM OLD.enrolled_by
     OR NEW.entered_at IS DISTINCT FROM OLD.entered_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'journey execution identity is immutable' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status NOT IN ('running', 'waiting') THEN
    RAISE EXCEPTION 'journey execution % has ended (%) and is immutable', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.state_version < OLD.state_version OR NEW.transitions < OLD.transitions THEN
    RAISE EXCEPTION 'journey execution % cannot move backwards', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_executions_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER trg_journey_executions_guard BEFORE UPDATE OR DELETE ON "journey_executions"
  FOR EACH ROW EXECUTE FUNCTION app_journey_executions_guard();--> statement-breakpoint

-- Content-free claim rows, one per live execution, shaped like message_dispatch_queue. Nothing
-- claims them in 8C-2: the runner (8C-3) is not built and no runner role is granted access.
CREATE TABLE "journey_execution_queue" (
	"execution_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"claim_token" uuid,
	"claimed_until" timestamp with time zone,
	"claimed_by" text,
	CONSTRAINT "journey_execution_queue_epoch_nonnegative" CHECK ("epoch" >= 0),
	CONSTRAINT "journey_execution_queue_claim_shape" CHECK (("claim_token" IS NULL) = ("claimed_until" IS NULL))
);--> statement-breakpoint

ALTER TABLE "journey_execution_queue" ADD CONSTRAINT "journey_execution_queue_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_execution_queue" ADD CONSTRAINT "journey_execution_queue_execution_org_fk" FOREIGN KEY ("execution_id","org_id") REFERENCES "public"."journey_executions"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journey_execution_queue_claim_idx" ON "journey_execution_queue" USING btree ("available_at","claimed_until","execution_id");--> statement-breakpoint
CREATE INDEX "journey_execution_queue_org_id_idx" ON "journey_execution_queue" USING btree ("org_id");--> statement-breakpoint

-- Append-only step history. `seq` equals the execution's state_version after the step, so one
-- row exists per committed transition. Details are bounded and carry no message content or
-- addresses (handover §11.6). `message_id` is reserved for the send node (8C-5), which adds
-- its foreign key together with the messages attribution columns.
CREATE TABLE "journey_execution_steps" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"node_key" text NOT NULL,
	"node_type" text NOT NULL,
	"outcome" "journey_step_outcome" NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"message_id" uuid,
	"error_code" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journey_execution_steps_seq_positive" CHECK ("seq" >= 1),
	CONSTRAINT "journey_execution_steps_attempt_positive" CHECK ("attempt" >= 1),
	CONSTRAINT "journey_execution_steps_details_bounded" CHECK (jsonb_typeof("details") = 'object' AND octet_length("details"::text) <= 4096),
	CONSTRAINT "journey_execution_steps_text_bounded" CHECK (char_length("node_key") BETWEEN 1 AND 64 AND char_length("node_type") BETWEEN 1 AND 32 AND ("error_code" IS NULL OR char_length("error_code") BETWEEN 1 AND 100)),
	CONSTRAINT "journey_execution_steps_time_order" CHECK ("finished_at" >= "started_at")
);--> statement-breakpoint

ALTER TABLE "journey_execution_steps" ADD CONSTRAINT "journey_execution_steps_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journey_execution_steps" ADD CONSTRAINT "journey_execution_steps_execution_fk" FOREIGN KEY ("execution_id","workspace_id","org_id") REFERENCES "public"."journey_executions"("id","workspace_id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_journey_execution_steps_seq" ON "journey_execution_steps" USING btree ("execution_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_journey_execution_steps_message" ON "journey_execution_steps" USING btree ("message_id") WHERE message_id IS NOT NULL;--> statement-breakpoint

CREATE FUNCTION app_journey_execution_steps_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'journey execution steps are append-only' USING ERRCODE = 'restrict_violation';
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_execution_steps_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER trg_journey_execution_steps_guard BEFORE UPDATE OR DELETE ON "journey_execution_steps"
  FOR EACH ROW EXECUTE FUNCTION app_journey_execution_steps_guard();--> statement-breakpoint

ALTER TABLE "journey_triggers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "journey_executions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "journey_execution_queue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "journey_execution_steps" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY journey_triggers_select ON "journey_triggers" FOR SELECT TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY journey_triggers_insert ON "journey_triggers" FOR INSERT TO acc_app
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY journey_triggers_update ON "journey_triggers" FOR UPDATE TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()))
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint

CREATE POLICY journey_executions_select ON "journey_executions" FOR SELECT TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY journey_executions_insert ON "journey_executions" FOR INSERT TO acc_app
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY journey_executions_update ON "journey_executions" FOR UPDATE TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()))
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint

CREATE POLICY journey_execution_queue_select ON "journey_execution_queue" FOR SELECT TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY journey_execution_queue_insert ON "journey_execution_queue" FOR INSERT TO acc_app
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY journey_execution_queue_update ON "journey_execution_queue" FOR UPDATE TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()))
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY journey_execution_queue_delete ON "journey_execution_queue" FOR DELETE TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint

CREATE POLICY journey_execution_steps_select ON "journey_execution_steps" FOR SELECT TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY journey_execution_steps_insert ON "journey_execution_steps" FOR INSERT TO acc_app
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "journey_triggers", "journey_executions" TO acc_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "journey_execution_queue" TO acc_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "journey_execution_steps" TO acc_app;--> statement-breakpoint
REVOKE ALL ON "journey_triggers", "journey_executions", "journey_execution_queue", "journey_execution_steps" FROM PUBLIC, acc_auth, acc_relay;
