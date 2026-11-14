-- Phase 8C PR 8C-4: journey event intake and scheduled-trigger processing (owner approval
-- 10-Nov-2026; docs/PHASE-8C-JOURNEYS-HANDOVER.md §§5, 8.1, 9, 12).
--
-- 1. CAPTURE (records only, never executes). AFTER triggers on contacts and messages record the
--    approved catalogue events (JOURNEY_TRIGGER_EVENTS: contact.created, contact.updated,
--    contact.tag_added, message.delivered, message.read, message.failed) in automation_events,
--    in the producer's own transaction — and only when BOTH:
--      a. the platform capture switch (journey_event_capture.enabled) is on — it is created OFF;
--      b. the organisation has an active journey whose active trigger listens for that event in
--         that workspace (and that tag, for contact.tag_added).
--    A capture failure never aborts the producer's write (it is reported as a WARNING).
-- 2. PROCESSING runs only inside the journey runner (disabled by default, refused outside tests)
--    and behind its own flags, through definer functions executable by acc_journey only:
--      app_journey_process_events   — idempotent enrolment from events (SKIP LOCKED, entry_ref
--                                     'event:<id>', one execution per journey and contact);
--      app_journey_claim_schedule   — one due schedule trigger per call (SKIP LOCKED, lease,
--                                     epoch, resumable firing with a keyset cursor);
--      app_journey_enrol_scheduled  — enrols one audience batch for the claimed firing
--                                     (entry_ref 'schedule:<trigger>:<fire instant>');
--      app_journey_finish_schedule  — completes, retries or abandons the firing; audits it;
--      app_journey_purge_events     — retention (30 days).
-- Nothing here creates a message, a dispatch-queue row or anything financial, or calls out.
-- Expand-only: two tables, columns on journey_triggers, functions, triggers, policies.

-- --- the platform capture switch (singleton, OFF) ------------------------------------------
CREATE TABLE "journey_event_capture" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journey_event_capture_singleton" CHECK ("singleton")
);--> statement-breakpoint
INSERT INTO "journey_event_capture" ("singleton", "enabled") VALUES (true, false);--> statement-breakpoint
ALTER TABLE "journey_event_capture" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "journey_event_capture" FROM PUBLIC;--> statement-breakpoint

-- --- the event inbox ------------------------------------------------------------------------
CREATE TABLE "automation_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"subject_id" uuid,
	"tag" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"outcome" text,
	"enrolled" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	CONSTRAINT "automation_events_kind" CHECK ("kind" IN ('contact.created', 'contact.updated', 'contact.tag_added', 'message.delivered', 'message.read', 'message.failed')),
	CONSTRAINT "automation_events_tag_shape" CHECK (("kind" = 'contact.tag_added') = ("tag" IS NOT NULL) AND ("tag" IS NULL OR char_length("tag") BETWEEN 1 AND 100)),
	CONSTRAINT "automation_events_dedupe_length" CHECK (char_length("dedupe_key") BETWEEN 1 AND 200),
	CONSTRAINT "automation_events_processed_shape" CHECK (("processed_at" IS NULL) = ("outcome" IS NULL)),
	CONSTRAINT "automation_events_outcome" CHECK ("outcome" IS NULL OR "outcome" IN ('enrolled', 'no_match', 'failed')),
	CONSTRAINT "automation_events_error_shape" CHECK (("outcome" = 'failed') = ("error_code" IS NOT NULL) AND ("error_code" IS NULL OR char_length("error_code") BETWEEN 1 AND 100)),
	CONSTRAINT "automation_events_enrolled_nonnegative" CHECK ("enrolled" >= 0)
);--> statement-breakpoint
ALTER TABLE "automation_events" ADD CONSTRAINT "automation_events_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_events" ADD CONSTRAINT "automation_events_contact_fk" FOREIGN KEY ("contact_id","workspace_id","org_id") REFERENCES "public"."contacts"("id","workspace_id","org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_automation_events_dedupe" ON "automation_events" USING btree ("org_id","kind","dedupe_key");--> statement-breakpoint
CREATE INDEX "automation_events_unprocessed_idx" ON "automation_events" USING btree ("created_at","id") WHERE processed_at IS NULL;--> statement-breakpoint
CREATE INDEX "automation_events_created_at_idx" ON "automation_events" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "automation_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "automation_events" FROM PUBLIC;--> statement-breakpoint

-- --- schedule firing state on journey_triggers --------------------------------------------
ALTER TABLE "journey_triggers" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "journey_triggers" ADD COLUMN "claimed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "journey_triggers" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "journey_triggers" ADD COLUMN "epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "journey_triggers" ADD COLUMN "firing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "journey_triggers" ADD COLUMN "fire_cursor" uuid;--> statement-breakpoint
ALTER TABLE "journey_triggers" ADD COLUMN "fire_enrolled" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "journey_triggers" ADD COLUMN "last_fired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "journey_triggers" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "journey_triggers" ADD COLUMN "last_error_code" text;--> statement-breakpoint
ALTER TABLE "journey_triggers" ADD COLUMN "not_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "journey_triggers" ADD CONSTRAINT "journey_triggers_claim_shape" CHECK (("claim_token" IS NULL) = ("claimed_until" IS NULL));--> statement-breakpoint
ALTER TABLE "journey_triggers" ADD CONSTRAINT "journey_triggers_firing_shape" CHECK (("firing_at" IS NULL AND "fire_cursor" IS NULL AND "fire_enrolled" = 0) OR ("kind" = 'schedule' AND "firing_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "journey_triggers" ADD CONSTRAINT "journey_triggers_counters_nonnegative" CHECK ("epoch" >= 0 AND "attempts" >= 0 AND "fire_enrolled" >= 0);--> statement-breakpoint
ALTER TABLE "journey_triggers" ADD CONSTRAINT "journey_triggers_error_code_length" CHECK ("last_error_code" IS NULL OR char_length("last_error_code") BETWEEN 1 AND 100);--> statement-breakpoint
CREATE INDEX "journey_triggers_firing_idx" ON "journey_triggers" USING btree ("claimed_until") WHERE firing_at IS NOT NULL;--> statement-breakpoint

-- --- capture -----------------------------------------------------------------------------

-- A contact's tags, lower-cased and trimmed: metadata.tags (array) or metadata.tag_list (array
-- or comma list) — the rule of contactTagsFromMetadata.
CREATE FUNCTION app_contact_tags(p_metadata jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(array_agg(DISTINCT lower(btrim(t))) FILTER (WHERE btrim(t) <> ''), '{}')
    FROM (
      SELECT jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(coalesce(p_metadata -> 'tags', p_metadata -> 'tag_list')) = 'array'
                    THEN coalesce(p_metadata -> 'tags', p_metadata -> 'tag_list') ELSE '[]'::jsonb END) AS t
       WHERE jsonb_typeof(coalesce(p_metadata -> 'tags', p_metadata -> 'tag_list')) = 'array'
      UNION ALL
      SELECT unnest(string_to_array(p_metadata ->> 'tag_list', ',')) AS t
       WHERE p_metadata -> 'tags' IS NULL AND jsonb_typeof(p_metadata -> 'tag_list') = 'string'
    ) s
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_contact_tags(jsonb) FROM PUBLIC;--> statement-breakpoint

-- Records one event when the switch is on and an active journey listens for it. Never raises.
CREATE FUNCTION app_journey_capture_event(p_org uuid, p_workspace uuid, p_kind text, p_contact uuid,
  p_subject uuid, p_tag text, p_occurred_at timestamptz, p_dedupe text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journey_event_capture WHERE enabled) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM journey_triggers t
      JOIN journeys j ON j.id = t.journey_id AND j.org_id = t.org_id
     WHERE t.org_id = p_org AND t.workspace_id = p_workspace
       AND t.kind = 'event' AND t.status = 'active' AND t.event_kind = p_kind
       AND (p_tag IS NULL OR lower(t.event_tag) = p_tag)
       AND j.status = 'active' AND j.deleted_at IS NULL
  ) THEN
    RETURN;
  END IF;
  BEGIN
    INSERT INTO automation_events (org_id, workspace_id, kind, contact_id, subject_id, tag, occurred_at, dedupe_key)
    VALUES (p_org, p_workspace, p_kind, p_contact, p_subject, p_tag, p_occurred_at, p_dedupe)
    ON CONFLICT (org_id, kind, dedupe_key) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    -- The producer's write must never fail because of journey capture.
    RAISE WARNING 'journey event capture skipped (%): %', p_kind, SQLSTATE;
  END;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_capture_event(uuid, uuid, text, uuid, uuid, text, timestamptz, text) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION app_journey_capture_contact() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tag text;
  v_tx text := txid_current()::text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journey_event_capture WHERE enabled) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM app_journey_capture_event(NEW.org_id, NEW.workspace_id, 'contact.created', NEW.id, NULL, NULL,
      NEW.created_at, NEW.id::text);
    FOREACH v_tag IN ARRAY app_contact_tags(NEW.metadata) LOOP
      PERFORM app_journey_capture_event(NEW.org_id, NEW.workspace_id, 'contact.tag_added', NEW.id, NULL,
        left(v_tag, 100), NEW.created_at, NEW.id::text || ':' || left(v_tag, 100) || ':' || v_tx);
    END LOOP;
    RETURN NULL;
  END IF;
  IF (NEW.first_name, NEW.last_name, NEW.metadata) IS NOT DISTINCT FROM (OLD.first_name, OLD.last_name, OLD.metadata) THEN
    RETURN NULL;
  END IF;
  PERFORM app_journey_capture_event(NEW.org_id, NEW.workspace_id, 'contact.updated', NEW.id, NULL, NULL,
    now(), NEW.id::text || ':' || v_tx);
  FOR v_tag IN SELECT unnest(app_contact_tags(NEW.metadata)) EXCEPT SELECT unnest(app_contact_tags(OLD.metadata)) LOOP
    PERFORM app_journey_capture_event(NEW.org_id, NEW.workspace_id, 'contact.tag_added', NEW.id, NULL,
      left(v_tag, 100), now(), NEW.id::text || ':' || left(v_tag, 100) || ':' || v_tx);
  END LOOP;
  RETURN NULL;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_capture_contact() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER trg_contacts_journey_capture AFTER INSERT OR UPDATE ON "contacts"
  FOR EACH ROW EXECUTE FUNCTION app_journey_capture_contact();--> statement-breakpoint

-- Message outcomes: delivered (delivery_status becomes 'delivered'), read (read_at set),
-- failed (status becomes 'failed'). One event per message and outcome (dedupe = message id).
CREATE FUNCTION app_journey_capture_message() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journey_event_capture WHERE enabled) THEN
    RETURN NULL;
  END IF;
  IF NEW.delivery_status = 'delivered' AND OLD.delivery_status IS DISTINCT FROM 'delivered' THEN
    PERFORM app_journey_capture_event(NEW.org_id, NEW.workspace_id, 'message.delivered', NEW.contact_id,
      NEW.id, NULL, coalesce(NEW.delivered_at, now()), NEW.id::text);
  END IF;
  IF NEW.read_at IS NOT NULL AND OLD.read_at IS NULL THEN
    PERFORM app_journey_capture_event(NEW.org_id, NEW.workspace_id, 'message.read', NEW.contact_id,
      NEW.id, NULL, NEW.read_at, NEW.id::text);
  END IF;
  IF NEW.status = 'failed' AND OLD.status IS DISTINCT FROM 'failed' THEN
    PERFORM app_journey_capture_event(NEW.org_id, NEW.workspace_id, 'message.failed', NEW.contact_id,
      NEW.id, NULL, coalesce(NEW.completed_at, now()), NEW.id::text);
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_capture_message() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER trg_messages_journey_capture AFTER UPDATE OF status, delivery_status, read_at ON "messages"
  FOR EACH ROW EXECUTE FUNCTION app_journey_capture_message();--> statement-breakpoint

-- --- shared: create one execution positioned after the entry node -------------------------
-- Inserts executions for (journey, version) and the given contacts that never entered the
-- journey (entry policy `once`); ON CONFLICT covers concurrent enrolment (live partial unique)
-- and replays (entry_ref unique). Adds the queue row and the `entered` history row.
CREATE FUNCTION app_journey_enrol_contacts(p_org uuid, p_workspace uuid, p_journey uuid, p_version uuid,
  p_contacts uuid[], p_entry_kind journey_trigger_kind, p_entry_ref text, p_details jsonb)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_graph jsonb;
  v_entry text;
  v_next text;
  v_count integer;
BEGIN
  SELECT v.graph INTO v_graph FROM journey_versions v
   WHERE v.id = p_version AND v.journey_id = p_journey AND v.org_id = p_org AND v.status = 'published';
  IF v_graph IS NULL THEN
    RETURN 0;
  END IF;
  v_entry := v_graph ->> 'entry';
  v_next := v_graph -> 'nodes' -> v_entry ->> 'next';
  IF v_next IS NULL THEN
    RETURN 0;
  END IF;
  WITH created AS (
    INSERT INTO journey_executions
      (org_id, workspace_id, journey_id, journey_version_id, contact_id, status, current_node_key,
       state_version, transitions, entry_kind, entry_ref)
    SELECT c.org_id, c.workspace_id, p_journey, p_version, c.id, 'running', v_next, 1, 1, p_entry_kind, p_entry_ref
      FROM contacts c
     WHERE c.org_id = p_org AND c.workspace_id = p_workspace AND c.id = ANY (p_contacts)
       AND NOT EXISTS (SELECT 1 FROM journey_executions e WHERE e.journey_id = p_journey AND e.contact_id = c.id)
    ON CONFLICT DO NOTHING
    RETURNING id, org_id, workspace_id
  ), queued AS (
    INSERT INTO journey_execution_queue (execution_id, org_id) SELECT id, org_id FROM created RETURNING execution_id
  ), history AS (
    INSERT INTO journey_execution_steps (org_id, workspace_id, execution_id, seq, node_key, node_type, outcome, details)
    SELECT org_id, workspace_id, id, 1, v_entry, 'entry', 'entered', p_details FROM created RETURNING 1
  )
  SELECT count(*)::int INTO v_count FROM history;
  RETURN v_count;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_enrol_contacts(uuid, uuid, uuid, uuid, uuid[], journey_trigger_kind, text, jsonb) FROM PUBLIC;--> statement-breakpoint

-- --- event intake ------------------------------------------------------------------------
-- Processes up to p_limit unprocessed events, oldest first, SKIP LOCKED (two runners never take
-- the same event). An event enrols its contact into every active journey of its workspace whose
-- active trigger listens for it — except journeys activated after the event occurred (a late
-- or pre-activation event never enrols). Marked processed in the same transaction. Replaying an
-- event is harmless: it is already processed, and entry_ref 'event:<id>' is unique per journey
-- and contact.
CREATE FUNCTION app_journey_process_events(p_limit integer)
RETURNS TABLE (event_id uuid, outcome text, enrolled integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  ev record;
  tr record;
  v_total integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'app_journey_process_events: invalid arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR ev IN
    SELECT a.* FROM automation_events a
     WHERE a.processed_at IS NULL
     ORDER BY a.created_at, a.id
     LIMIT p_limit
       FOR UPDATE SKIP LOCKED
  LOOP
    v_total := 0;
    BEGIN
    FOR tr IN
      SELECT t.journey_id, t.journey_version_id
        FROM journey_triggers t
        JOIN journeys j ON j.id = t.journey_id AND j.org_id = t.org_id
       WHERE t.org_id = ev.org_id AND t.workspace_id = ev.workspace_id
         AND t.kind = 'event' AND t.status = 'active' AND t.event_kind = ev.kind
         AND (ev.tag IS NULL OR lower(t.event_tag) = ev.tag)
         AND j.status = 'active' AND j.deleted_at IS NULL
         AND j.active_version_id = t.journey_version_id
         AND j.activated_at <= ev.occurred_at
       ORDER BY t.journey_id
    LOOP
      v_total := v_total + app_journey_enrol_contacts(ev.org_id, ev.workspace_id, tr.journey_id,
        tr.journey_version_id, ARRAY[ev.contact_id], 'event', 'event:' || ev.id::text,
        jsonb_build_object('entryKind', 'event', 'eventKind', ev.kind));
    END LOOP;
    UPDATE automation_events
       SET processed_at = now(), outcome = CASE WHEN v_total > 0 THEN 'enrolled' ELSE 'no_match' END,
           enrolled = v_total
     WHERE id = ev.id;
    event_id := ev.id;
    outcome := CASE WHEN v_total > 0 THEN 'enrolled' ELSE 'no_match' END;
    enrolled := v_total;
    EXCEPTION WHEN OTHERS THEN
      -- One failing event never blocks the inbox: its enrolments roll back (subtransaction), it
      -- is recorded as failed with its SQLSTATE, and the batch continues.
      UPDATE automation_events
         SET processed_at = now(), outcome = 'failed', enrolled = 0, error_code = SQLSTATE
       WHERE id = ev.id;
      event_id := ev.id;
      outcome := 'failed';
      enrolled := 0;
    END;
    RETURN NEXT;
  END LOOP;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_process_events(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_journey_process_events(integer) TO acc_journey;--> statement-breakpoint

-- Retention: events older than p_days (≥ 1) are removed, at most p_limit per call.
CREATE FUNCTION app_journey_purge_events(p_days integer, p_limit integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_days IS NULL OR p_days < 1 OR p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'app_journey_purge_events: invalid arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH doomed AS (
    SELECT id FROM automation_events
     WHERE created_at < now() - make_interval(days => p_days)
     ORDER BY created_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  DELETE FROM automation_events a USING doomed WHERE a.id = doomed.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_purge_events(integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_journey_purge_events(integer, integer) TO acc_journey;--> statement-breakpoint

-- --- scheduled triggers ------------------------------------------------------------------
CREATE FUNCTION app_journey_trigger_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.journey_trigger_id', true), '')::uuid $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_trigger_id() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_journey_trigger_id() TO acc_journey;--> statement-breakpoint

CREATE FUNCTION app_journey_trigger_claim_token() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.journey_trigger_claim_token', true), '')::uuid $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_trigger_claim_token() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_journey_trigger_claim_token() TO acc_journey;--> statement-breakpoint

-- The session's schedule claim is live: its trigger, in its organisation, still holds its token
-- with an unexpired lease and is firing. Returns the trigger's workspace and segment, or no row.
CREATE FUNCTION app_journey_claimed_trigger()
RETURNS TABLE (trigger_id uuid, workspace_id uuid, segment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT t.id, t.workspace_id, t.segment_id
    FROM journey_triggers t
   WHERE t.id = app_journey_trigger_id()
     AND t.org_id = app_current_org_id()
     AND t.claim_token = app_journey_trigger_claim_token()
     AND t.claimed_until > now()
     AND t.firing_at IS NOT NULL
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_claimed_trigger() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_journey_claimed_trigger() TO acc_journey;--> statement-breakpoint

-- Claims one due schedule trigger of an active journey (or a firing whose lease expired, to
-- resume it): SKIP LOCKED, fresh token, lease, epoch + 1, attempts + 1. The fire instant is
-- frozen in firing_at (= the next_fire_at that was due), so a resumed or overlapping worker
-- enrols under the same entry_ref and can never create a second enrolment for that fire.
CREATE FUNCTION app_journey_claim_schedule(p_worker text, p_lease_seconds integer)
RETURNS TABLE (trigger_id uuid, org_id uuid, workspace_id uuid, journey_id uuid, journey_version_id uuid,
  segment_id uuid, schedule jsonb, firing_at timestamptz, fire_cursor uuid, claim_token uuid,
  epoch integer, attempts integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 5 OR p_lease_seconds > 600
     OR p_worker IS NULL OR char_length(p_worker) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'app_journey_claim_schedule: invalid arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  WITH picked AS (
    SELECT t.id
      FROM journey_triggers t
      JOIN journeys j ON j.id = t.journey_id AND j.org_id = t.org_id
     WHERE t.kind = 'schedule' AND t.status = 'active'
       AND j.status = 'active' AND j.deleted_at IS NULL
       AND j.active_version_id = t.journey_version_id
       AND (t.claimed_until IS NULL OR t.claimed_until < now())
       AND (t.firing_at IS NOT NULL OR t.next_fire_at <= now())
       AND (t.not_before IS NULL OR t.not_before <= now())
     ORDER BY coalesce(t.firing_at, t.next_fire_at), t.id
     LIMIT 1
       FOR UPDATE OF t SKIP LOCKED
  )
  UPDATE journey_triggers t
     SET firing_at = coalesce(t.firing_at, t.next_fire_at),
         claim_token = gen_random_uuid(),
         claimed_until = now() + make_interval(secs => p_lease_seconds),
         claimed_by = p_worker,
         epoch = t.epoch + 1,
         attempts = t.attempts + 1
    FROM picked
   WHERE t.id = picked.id
  RETURNING t.id, t.org_id, t.workspace_id, t.journey_id, t.journey_version_id, t.segment_id, t.schedule,
            t.firing_at, t.fire_cursor, t.claim_token, t.epoch, t.attempts;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_claim_schedule(text, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_journey_claim_schedule(text, integer) TO acc_journey;--> statement-breakpoint

-- Enrols one audience batch for the session's claimed firing and advances its cursor. The
-- contacts must be in the trigger's workspace; the entry reference is derived here from the
-- frozen fire instant, never from the caller.
CREATE FUNCTION app_journey_enrol_scheduled(p_contacts uuid[], p_cursor uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  t journey_triggers%ROWTYPE;
  v_count integer;
BEGIN
  SELECT * INTO t FROM journey_triggers
   WHERE id = app_journey_trigger_id() AND org_id = app_current_org_id()
     AND claim_token = app_journey_trigger_claim_token() AND claimed_until > now()
     AND firing_at IS NOT NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'journey schedule claim lost' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_contacts IS NULL OR cardinality(p_contacts) > 1000 THEN
    RAISE EXCEPTION 'app_journey_enrol_scheduled: invalid batch' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_count := app_journey_enrol_contacts(t.org_id, t.workspace_id, t.journey_id, t.journey_version_id,
    p_contacts, 'schedule',
    'schedule:' || t.id::text || ':' || to_char(t.firing_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    jsonb_build_object('entryKind', 'schedule', 'firedAt',
      to_char(t.firing_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')));
  UPDATE journey_triggers
     SET fire_cursor = p_cursor, fire_enrolled = fire_enrolled + v_count, attempts = 0,
         last_error_code = NULL, updated_at = now()
   WHERE id = t.id;
  RETURN v_count;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_enrol_scheduled(uuid[], uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_journey_enrol_scheduled(uuid[], uuid) TO acc_journey;--> statement-breakpoint

-- Finishes the claimed firing:
--   'completed' — the whole audience was enrolled: last_fired_at = firing_at, the next fire is
--                 the caller's computation (strictly after the fire instant, DST-correct), the
--                 firing state is cleared, and the fire is audited (system actor journey_runner);
--   'abandoned' — a deterministic failure or poison: the fire is skipped (no further
--                 enrolment for it), the next fire is scheduled, the error recorded and audited;
--   'retry'     — a transient failure: the claim is released, the firing (and cursor) kept, and
--                 the trigger is not claimable again before p_retry_at.
CREATE FUNCTION app_journey_finish_schedule(p_result text, p_next_fire_at timestamptz,
  p_error_code text, p_retry_at timestamptz, p_correlation uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  t journey_triggers%ROWTYPE;
BEGIN
  SELECT * INTO t FROM journey_triggers
   WHERE id = app_journey_trigger_id() AND org_id = app_current_org_id()
     AND claim_token = app_journey_trigger_claim_token() AND claimed_until > now()
     AND firing_at IS NOT NULL
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'journey schedule claim lost' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_result = 'retry' THEN
    IF p_retry_at IS NULL THEN
      RAISE EXCEPTION 'retry needs a time' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE journey_triggers
       SET claim_token = NULL, claimed_until = NULL, claimed_by = NULL, not_before = p_retry_at,
           last_error_code = p_error_code, updated_at = now()
     WHERE id = t.id;
    RETURN;
  END IF;
  IF p_result NOT IN ('completed', 'abandoned') OR (p_next_fire_at IS NOT NULL AND p_next_fire_at <= t.firing_at) THEN
    RAISE EXCEPTION 'app_journey_finish_schedule: invalid arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE journey_triggers
     SET last_fired_at = t.firing_at, next_fire_at = p_next_fire_at,
         firing_at = NULL, fire_cursor = NULL, fire_enrolled = 0,
         claim_token = NULL, claimed_until = NULL, claimed_by = NULL, attempts = 0, not_before = NULL,
         last_error_code = CASE WHEN p_result = 'abandoned' THEN p_error_code END,
         updated_at = now()
   WHERE id = t.id;
  INSERT INTO audit_logs (scope_type, scope_id, actor_type, actor_label, action, resource_type, resource_id,
                          outcome, metadata, correlation_id)
  VALUES ('workspace', t.workspace_id, 'system', 'journey_runner', 'journey.schedule_fired', 'Journey', t.journey_id,
          CASE WHEN p_result = 'completed' THEN 'success' ELSE 'failure' END::audit_outcome,
          jsonb_build_object('triggerId', t.id, 'journeyVersionId', t.journey_version_id,
                             'firedAt', t.firing_at, 'enrolled', t.fire_enrolled, 'result', p_result,
                             'errorCode', p_error_code, 'nextFireAt', p_next_fire_at),
          p_correlation);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_journey_finish_schedule(text, timestamptz, text, timestamptz, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_journey_finish_schedule(text, timestamptz, text, timestamptz, uuid) TO acc_journey;--> statement-breakpoint

-- --- acc_journey reads for a claimed firing: the trigger's workspace audience only -------
CREATE POLICY contacts_scheduler_select ON "contacts" FOR SELECT TO acc_journey
  USING (org_id = app_current_org_id()
         AND workspace_id = (SELECT c.workspace_id FROM app_journey_claimed_trigger() c));--> statement-breakpoint
CREATE POLICY contact_identities_scheduler_select ON "contact_identities" FOR SELECT TO acc_journey
  USING (org_id = app_current_org_id()
         AND workspace_id = (SELECT c.workspace_id FROM app_journey_claimed_trigger() c));--> statement-breakpoint
CREATE POLICY consent_events_scheduler_select ON "consent_events" FOR SELECT TO acc_journey
  USING (org_id = app_current_org_id()
         AND workspace_id = (SELECT c.workspace_id FROM app_journey_claimed_trigger() c));--> statement-breakpoint
CREATE POLICY suppressions_scheduler_select ON "suppressions" FOR SELECT TO acc_journey
  USING (org_id = app_current_org_id()
         AND EXISTS (SELECT 1 FROM app_journey_claimed_trigger() c));--> statement-breakpoint
CREATE POLICY segments_scheduler_select ON "segments" FOR SELECT TO acc_journey
  USING (org_id = app_current_org_id()
         AND id = (SELECT c.segment_id FROM app_journey_claimed_trigger() c));
