-- =============================================================================
-- Phase 3.3 — Message Orchestrator & Dispatch Execution
-- (ADR-014 §7, §9, §12, §17.1, P3-D10–D12, P3-D17, P3-D18, P3-D29)
--
-- 1. `messages`:
--    Tenant-content table (Model B RLS: app_content_context_valid).
--    State machine: queued, routing, submitting, accepted, failed, outcome_unknown.
--    Terminal guard trigger: terminal states cannot transition.
-- 2. `message_attempts`:
--    Tenant-content table (Model B RLS).
--    Records each invocation attempt with fencing epoch and claim token.
--    Terminal guard trigger: terminal states cannot transition.
-- 3. `message_events`:
--    Append-only tenant-content event ledger (Model B RLS).
-- 4. `message_dispatch_queue`:
--    Control-plane queue table (Model A Tenancy RLS; non-content only).
--    Carries no payload, phone or provider config.
-- 5. `provider_health.attempt_id`:
--    Composite FK (attempt_id, provider_id) -> message_attempts(id, provider_id).
-- 6. Organization lifecycle advisory locking:
--    Exclusive lock on organizations.status change (ORG_LIFECYCLE_LOCK_CLASS = 482019310).
-- =============================================================================

-- --- 1. Enums ----------------------------------------------------------------
CREATE TYPE "public"."message_status" AS ENUM('queued', 'routing', 'submitting', 'accepted', 'failed', 'outcome_unknown');--> statement-breakpoint
CREATE TYPE "public"."message_attempt_status" AS ENUM('submitting', 'accepted', 'failed', 'outcome_unknown');--> statement-breakpoint

-- --- 2. Messages Table & Constraints -----------------------------------------
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"template_id" uuid,
	"status" "message_status" DEFAULT 'queued' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recipient_address" text NOT NULL,
	"current_attempt_id" uuid,
	"failure_reason" text,
	"correlation_id" text NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_messages_id_org_id" UNIQUE("id","org_id")
);
--> statement-breakpoint

ALTER TABLE "messages" ADD CONSTRAINT "messages_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_org_fk" FOREIGN KEY ("workspace_id","org_id") REFERENCES "public"."workspaces"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_contact_workspace_org_fk" FOREIGN KEY ("contact_id","workspace_id","org_id") REFERENCES "public"."contacts"("id","workspace_id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "messages_org_id_idx" ON "messages" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "messages_workspace_id_idx" ON "messages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "messages_contact_id_idx" ON "messages" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "messages_status_idx" ON "messages" USING btree ("status");--> statement-breakpoint

-- --- 3. Message Triggers -----------------------------------------------------
CREATE TRIGGER trg_messages_updated_at
  BEFORE UPDATE ON "messages"
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();--> statement-breakpoint

CREATE TRIGGER trg_messages_tenant_key_immutable
  AFTER UPDATE OF org_id, workspace_id, contact_id, channel_id ON "messages"
  FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR OLD.contact_id IS DISTINCT FROM NEW.contact_id OR OLD.channel_id IS DISTINCT FROM NEW.channel_id)
  EXECUTE FUNCTION fn_tenant_key_immutable('org_id', 'workspace_id', 'contact_id', 'channel_id');--> statement-breakpoint

CREATE OR REPLACE FUNCTION fn_messages_terminal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('accepted', 'failed', 'outcome_unknown') THEN
    RAISE EXCEPTION 'MESSAGE_ALREADY_TERMINAL: message % is terminal (%) and cannot transition', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'queued' AND NEW.status NOT IN ('queued', 'routing', 'submitting', 'failed') THEN
    RAISE EXCEPTION 'ILLEGAL_STATE_TRANSITION: message % cannot transition % -> %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  ELSIF OLD.status = 'routing' AND NEW.status NOT IN ('routing', 'submitting', 'failed') THEN
    RAISE EXCEPTION 'ILLEGAL_STATE_TRANSITION: message % cannot transition % -> %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  ELSIF OLD.status = 'submitting' AND NEW.status NOT IN ('submitting', 'accepted', 'failed', 'outcome_unknown') THEN
    RAISE EXCEPTION 'ILLEGAL_STATE_TRANSITION: message % cannot transition % -> %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER trg_messages_terminal_guard
  BEFORE UPDATE ON "messages"
  FOR EACH ROW EXECUTE FUNCTION fn_messages_terminal_guard();--> statement-breakpoint

-- --- 4. Message Attempts Table & Constraints ---------------------------------
CREATE TABLE "message_attempts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"message_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"provider_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"fencing_epoch" integer NOT NULL,
	"claim_token" uuid NOT NULL,
	"status" "message_attempt_status" DEFAULT 'submitting' NOT NULL,
	"failure_reason" text,
	"latency_ms" integer,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_message_attempts_id_provider_id" UNIQUE("id","provider_id"),
	CONSTRAINT "uq_message_attempts_message_attempt_num" UNIQUE("message_id","attempt_number"),
	CONSTRAINT "message_attempts_latency_ms_nonnegative" CHECK ("message_attempts"."latency_ms" IS NULL OR "message_attempts"."latency_ms" >= 0)
);
--> statement-breakpoint

ALTER TABLE "message_attempts" ADD CONSTRAINT "message_attempts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attempts" ADD CONSTRAINT "message_attempts_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attempts" ADD CONSTRAINT "message_attempts_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attempts" ADD CONSTRAINT "message_attempts_message_org_fk" FOREIGN KEY ("message_id","org_id") REFERENCES "public"."messages"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_attempts" ADD CONSTRAINT "message_attempts_assignment_fk" FOREIGN KEY ("org_id","provider_id") REFERENCES "public"."organization_provider_assignments"("org_id","provider_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "message_attempts_message_id_idx" ON "message_attempts" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_attempts_org_id_idx" ON "message_attempts" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "message_attempts_provider_id_idx" ON "message_attempts" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "message_attempts_claim_token_idx" ON "message_attempts" USING btree ("claim_token");--> statement-breakpoint

CREATE OR REPLACE FUNCTION fn_message_attempts_terminal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('accepted', 'failed', 'outcome_unknown') THEN
    RAISE EXCEPTION 'ATTEMPT_ALREADY_TERMINAL: attempt % is terminal (%) and cannot transition', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER trg_message_attempts_terminal_guard
  BEFORE UPDATE ON "message_attempts"
  FOR EACH ROW EXECUTE FUNCTION fn_message_attempts_terminal_guard();--> statement-breakpoint

-- --- 5. Message Events Table (Append-Only) -----------------------------------
CREATE TABLE "message_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"message_id" uuid NOT NULL,
	"org_id" uuid NOT NULL,
	"attempt_id" uuid,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "message_events" ADD CONSTRAINT "message_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_attempt_id_message_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."message_attempts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_events" ADD CONSTRAINT "message_events_message_org_fk" FOREIGN KEY ("message_id","org_id") REFERENCES "public"."messages"("id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "message_events_message_id_idx" ON "message_events" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_events_org_id_idx" ON "message_events" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "message_events_attempt_id_idx" ON "message_events" USING btree ("attempt_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION fn_message_events_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'message_events is append-only' USING ERRCODE = '42501';
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_message_events_immutable() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER trg_message_events_immutable
  BEFORE UPDATE OR DELETE ON "message_events"
  FOR EACH ROW EXECUTE FUNCTION fn_message_events_immutable();--> statement-breakpoint
CREATE TRIGGER trg_message_events_immutable_stmt
  BEFORE TRUNCATE ON "message_events"
  FOR EACH STATEMENT EXECUTE FUNCTION fn_message_events_immutable();--> statement-breakpoint

-- --- 6. Message Dispatch Queue Table -----------------------------------------
CREATE TABLE "message_dispatch_queue" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatch_epoch" integer DEFAULT 0 NOT NULL,
	"claim_token" uuid,
	"claimed_until" timestamp with time zone,
	"claimed_by" text
);
--> statement-breakpoint

ALTER TABLE "message_dispatch_queue" ADD CONSTRAINT "message_dispatch_queue_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_dispatch_queue" ADD CONSTRAINT "message_dispatch_queue_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_dispatch_queue" ADD CONSTRAINT "message_dispatch_queue_message_org_fk" FOREIGN KEY ("message_id","org_id") REFERENCES "public"."messages"("id","org_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX "message_dispatch_queue_claim_idx" ON "message_dispatch_queue" USING btree ("available_at","claimed_until","message_id");--> statement-breakpoint
CREATE INDEX "message_dispatch_queue_org_id_idx" ON "message_dispatch_queue" USING btree ("org_id");--> statement-breakpoint

-- --- 7. Provider Health attempt_id Composite Foreign Key ---------------------
ALTER TABLE "provider_health" ADD COLUMN "attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "provider_health" ADD CONSTRAINT "provider_health_attempt_provider_fk" FOREIGN KEY ("attempt_id","provider_id") REFERENCES "public"."message_attempts"("id","provider_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_health_submission_attempt_idx" ON "provider_health" USING btree ("attempt_id") WHERE "attempt_id" IS NOT NULL;--> statement-breakpoint

DROP POLICY IF EXISTS provider_health_dispatch_insert ON "provider_health";--> statement-breakpoint
CREATE POLICY provider_health_dispatch_insert ON "provider_health"
  FOR INSERT TO acc_dispatch
  WITH CHECK (
    kind = 'submission'
    AND attempt_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "message_attempts" ma
      WHERE ma.id = provider_health.attempt_id
        AND ma.provider_id = provider_health.provider_id
        AND ma.org_id = app_current_org_id()
        AND ma.claim_token = app_dispatch_claim_token()
        AND ma.status = 'submitting'
    )
  );--> statement-breakpoint

-- --- 8. Organization Lifecycle Advisory Lock Trigger (D29) -------------------
CREATE OR REPLACE FUNCTION fn_organization_lifecycle_lock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- 482019310 = ORG_LIFECYCLE_LOCK_CLASS (@acc/db).
    PERFORM pg_advisory_xact_lock(482019310, hashtext(NEW.id::text));
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION fn_organization_lifecycle_lock() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER trg_organization_lifecycle_lock
  BEFORE UPDATE OF status ON "organizations"
  FOR EACH ROW EXECUTE FUNCTION fn_organization_lifecycle_lock();--> statement-breakpoint

-- --- 9. RLS Policies: Model B for messages, attempts, events -----------------
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "message_dispatch_queue" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- messages: Model B for acc_app
CREATE POLICY messages_select ON "messages" FOR SELECT TO acc_app
  USING ((org_id = app_current_org_id()) AND ( SELECT app_content_context_valid() AS app_content_context_valid));--> statement-breakpoint
CREATE POLICY messages_insert ON "messages" FOR INSERT TO acc_app
  WITH CHECK ((org_id = app_current_org_id()) AND ( SELECT app_content_context_valid() AS app_content_context_valid));--> statement-breakpoint
CREATE POLICY messages_update ON "messages" FOR UPDATE TO acc_app
  USING ((org_id = app_current_org_id()) AND ( SELECT app_content_context_valid() AS app_content_context_valid))
  WITH CHECK ((org_id = app_current_org_id()) AND ( SELECT app_content_context_valid() AS app_content_context_valid));--> statement-breakpoint

-- messages: acc_dispatch
CREATE POLICY messages_dispatch_select ON "messages" FOR SELECT TO acc_dispatch
  USING (
    id = app_dispatch_message_id()
    AND org_id = app_current_org_id()
    AND EXISTS (
      SELECT 1 FROM "message_dispatch_queue" q
      WHERE q.message_id = messages.id
        AND q.claim_token = app_dispatch_claim_token()
        AND q.claimed_until > now()
    )
  );--> statement-breakpoint
CREATE POLICY messages_dispatch_update ON "messages" FOR UPDATE TO acc_dispatch
  USING (
    id = app_dispatch_message_id()
    AND org_id = app_current_org_id()
    AND EXISTS (
      SELECT 1 FROM "message_dispatch_queue" q
      WHERE q.message_id = messages.id
        AND q.claim_token = app_dispatch_claim_token()
        AND q.claimed_until > now()
    )
  )
  WITH CHECK (
    id = app_dispatch_message_id()
    AND org_id = app_current_org_id()
    AND EXISTS (
      SELECT 1 FROM "message_dispatch_queue" q
      WHERE q.message_id = messages.id
        AND q.claim_token = app_dispatch_claim_token()
        AND q.claimed_until > now()
    )
  );--> statement-breakpoint

-- message_attempts: Model B for acc_app
CREATE POLICY message_attempts_select ON "message_attempts" FOR SELECT TO acc_app
  USING ((org_id = app_current_org_id()) AND ( SELECT app_content_context_valid() AS app_content_context_valid));--> statement-breakpoint
CREATE POLICY message_attempts_insert ON "message_attempts" FOR INSERT TO acc_app
  WITH CHECK ((org_id = app_current_org_id()) AND ( SELECT app_content_context_valid() AS app_content_context_valid));--> statement-breakpoint
CREATE POLICY message_attempts_update ON "message_attempts" FOR UPDATE TO acc_app
  USING ((org_id = app_current_org_id()) AND ( SELECT app_content_context_valid() AS app_content_context_valid))
  WITH CHECK ((org_id = app_current_org_id()) AND ( SELECT app_content_context_valid() AS app_content_context_valid));--> statement-breakpoint

-- message_attempts: acc_dispatch
CREATE POLICY message_attempts_dispatch_select ON "message_attempts" FOR SELECT TO acc_dispatch
  USING (
    message_id = app_dispatch_message_id()
    AND org_id = app_current_org_id()
    AND (
      claim_token = app_dispatch_claim_token()
      OR EXISTS (
        SELECT 1 FROM "message_dispatch_queue" q
        WHERE q.message_id = message_attempts.message_id
          AND q.claim_token = app_dispatch_claim_token()
          AND q.claimed_until > now()
      )
    )
  );--> statement-breakpoint
CREATE POLICY message_attempts_dispatch_insert ON "message_attempts" FOR INSERT TO acc_dispatch
  WITH CHECK (
    message_id = app_dispatch_message_id()
    AND org_id = app_current_org_id()
    AND claim_token = app_dispatch_claim_token()
    AND EXISTS (
      SELECT 1 FROM "organization_provider_assignments" opa
      WHERE opa.org_id = message_attempts.org_id
        AND opa.provider_id = message_attempts.provider_id
        AND opa.status = 'active'
    )
    AND EXISTS (
      SELECT 1 FROM "organizations" o
      WHERE o.id = message_attempts.org_id
        AND o.status = 'active'
    )
  );--> statement-breakpoint
CREATE POLICY message_attempts_dispatch_update ON "message_attempts" FOR UPDATE TO acc_dispatch
  USING (
    message_id = app_dispatch_message_id()
    AND org_id = app_current_org_id()
    AND EXISTS (
      SELECT 1 FROM "message_dispatch_queue" q
      WHERE q.message_id = message_attempts.message_id
        AND q.claim_token = app_dispatch_claim_token()
        AND q.claimed_until > now()
    )
  )
  WITH CHECK (
    message_id = app_dispatch_message_id()
    AND org_id = app_current_org_id()
  );--> statement-breakpoint

-- message_events: Model B for acc_app
CREATE POLICY message_events_select ON "message_events" FOR SELECT TO acc_app
  USING ((org_id = app_current_org_id()) AND ( SELECT app_content_context_valid() AS app_content_context_valid));--> statement-breakpoint
CREATE POLICY message_events_insert ON "message_events" FOR INSERT TO acc_app
  WITH CHECK ((org_id = app_current_org_id()) AND ( SELECT app_content_context_valid() AS app_content_context_valid));--> statement-breakpoint

-- message_events: acc_dispatch (INSERT only)
CREATE POLICY message_events_dispatch_insert ON "message_events" FOR INSERT TO acc_dispatch
  WITH CHECK (
    message_id = app_dispatch_message_id()
    AND org_id = app_current_org_id()
    AND EXISTS (
      SELECT 1 FROM "message_dispatch_queue" q
      WHERE q.message_id = message_events.message_id
        AND q.claim_token = app_dispatch_claim_token()
        AND q.claimed_until > now()
    )
  );--> statement-breakpoint

-- message_dispatch_queue: Model A for acc_app
CREATE POLICY message_dispatch_queue_tenant ON "message_dispatch_queue" FOR ALL TO acc_app
  USING (app_org_in_scope(org_id))
  WITH CHECK (app_org_in_scope(org_id));--> statement-breakpoint

-- message_dispatch_queue: acc_dispatch (discovery, claim and delete)
CREATE POLICY message_dispatch_queue_dispatch_select ON "message_dispatch_queue" FOR SELECT TO acc_dispatch
  USING (true);--> statement-breakpoint
CREATE POLICY message_dispatch_queue_dispatch_update ON "message_dispatch_queue" FOR UPDATE TO acc_dispatch
  USING (true)
  WITH CHECK (true);--> statement-breakpoint
CREATE POLICY message_dispatch_queue_dispatch_delete ON "message_dispatch_queue" FOR DELETE TO acc_dispatch
  USING (
    message_id = app_dispatch_message_id()
    AND org_id = app_current_org_id()
    AND claim_token = app_dispatch_claim_token()
  );--> statement-breakpoint

-- --- 10. Table & Column Grants -----------------------------------------------
GRANT SELECT, INSERT, UPDATE ON "messages" TO acc_app;--> statement-breakpoint
GRANT SELECT, UPDATE (status, current_attempt_id, failure_reason, completed_at, updated_at) ON "messages" TO acc_dispatch;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON "message_attempts" TO acc_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE (status, failure_reason, latency_ms, completed_at) ON "message_attempts" TO acc_dispatch;--> statement-breakpoint

GRANT SELECT, INSERT ON "message_events" TO acc_app;--> statement-breakpoint
GRANT INSERT ON "message_events" TO acc_dispatch;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "message_dispatch_queue" TO acc_app;--> statement-breakpoint
GRANT SELECT, UPDATE, DELETE ON "message_dispatch_queue" TO acc_dispatch;--> statement-breakpoint

-- --- 11. Channel Resolve Helper (ADR-014 preflight) --------------------------
CREATE OR REPLACE FUNCTION app_channel_resolve(p_code text)
RETURNS TABLE (id uuid, code text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT id, code::text, status::text FROM channels WHERE code::text = p_code;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_channel_resolve(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_channel_resolve(text) TO acc_app;
