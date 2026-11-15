-- Phase 8B PR 8B-3a: the shared automation sending identity and campaign attribution
-- (PHASE-8B-3-HANDOVER-Rev2 §§3–5; owner decisions OD-8B3-1..6, 15-Nov-2026).
--
-- Nothing here sends or enables anything:
-- - acc_campaign is created NOLOGIN with no credential; no executor exists (8B-3b) and campaign
--   dispatch stays disabled (CAMPAIGN_DISPATCH_ENABLED, refused outside tests).
-- - The identity is generic over the subject, but the journey subject REFUSES until 8C-6, and
--   acc_journey receives nothing here.
-- - app_content_context_valid() is unchanged. The only Phase 7 object changed is the
--   function-local admission of app_message_reserve (one per-message reservation path).
-- - The one-message-per-recipient unique index on messages (K1) is NOT created here: db:migrate
--   builds it CONCURRENTLY after this migration (barrier) and 0069 verifies it.
--
-- The migrator applies all pending migrations in one transaction, so constraints are added
-- validated (0052/0066 precedent).

-- =============================================================================
-- 1. The shared automation identity (§3.3)
-- =============================================================================
CREATE TYPE "public"."automation_subject_kind" AS ENUM ('campaign_recipient', 'journey_execution');--> statement-breakpoint

CREATE TABLE "automation_capabilities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"subject_kind" "automation_subject_kind" NOT NULL,
	"subject_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"claim_epoch" integer NOT NULL,
	"initiator_user_id" uuid,
	"token_hash" bytea NOT NULL,
	"issued_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "uq_automation_capabilities_token_hash" UNIQUE ("token_hash"),
	CONSTRAINT "automation_capabilities_token_hash_length" CHECK (octet_length("token_hash") = 32),
	CONSTRAINT "automation_capabilities_lifetime" CHECK ("expires_at" > "issued_at" AND "expires_at" <= "issued_at" + interval '30 seconds'),
	CONSTRAINT "automation_capabilities_revoked_after_issue" CHECK ("revoked_at" IS NULL OR "revoked_at" >= "issued_at")
);--> statement-breakpoint
ALTER TABLE "automation_capabilities" ADD CONSTRAINT "automation_capabilities_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_capabilities" ADD CONSTRAINT "automation_capabilities_initiator_user_id_users_id_fk" FOREIGN KEY ("initiator_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_capabilities_subject_idx" ON "automation_capabilities" USING btree ("org_id", "subject_kind", "subject_id");--> statement-breakpoint
CREATE INDEX "automation_capabilities_open_idx" ON "automation_capabilities" USING btree ("org_id", "expires_at") WHERE revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "automation_capabilities_issued_at_idx" ON "automation_capabilities" USING btree ("issued_at");--> statement-breakpoint

CREATE TABLE "automation_controls" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"sending_paused" boolean DEFAULT false NOT NULL,
	"paused_at" timestamp with time zone,
	"paused_by_user_id" uuid,
	"paused_by_label" text,
	"pause_reason" text,
	"revoked_before" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_controls_pause_shape" CHECK ("sending_paused" = ("paused_at" IS NOT NULL)),
	CONSTRAINT "automation_controls_text_bounded" CHECK (("pause_reason" IS NULL OR char_length("pause_reason") BETWEEN 1 AND 200) AND ("paused_by_label" IS NULL OR char_length("paused_by_label") BETWEEN 1 AND 100))
);--> statement-breakpoint
ALTER TABLE "automation_controls" ADD CONSTRAINT "automation_controls_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_controls" ADD CONSTRAINT "automation_controls_paused_by_user_id_users_id_fk" FOREIGN KEY ("paused_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Definer-only: no application role holds any privilege; RLS on, no policy.
ALTER TABLE "automation_capabilities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_controls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON "automation_capabilities", "automation_controls" FROM PUBLIC;--> statement-breakpoint

-- Capabilities are append-only: only revoked_at may change (NULL -> value, once); a row may be
-- deleted only once it is past the 90-day retention (OD-8B3-6).
CREATE FUNCTION app_automation_capabilities_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.issued_at >= clock_timestamp() - interval '90 days' THEN
      RAISE EXCEPTION 'automation capabilities are kept for 90 days' USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF (NEW.id, NEW.org_id, NEW.subject_kind, NEW.subject_id, NEW.automation_id, NEW.claim_epoch,
      NEW.initiator_user_id, NEW.token_hash, NEW.issued_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.org_id, OLD.subject_kind, OLD.subject_id, OLD.automation_id, OLD.claim_epoch,
      OLD.initiator_user_id, OLD.token_hash, OLD.issued_at, OLD.expires_at)
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'automation capabilities are immutable except a single revocation' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_automation_capabilities_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER trg_automation_capabilities_guard BEFORE UPDATE OR DELETE ON "automation_capabilities"
  FOR EACH ROW EXECUTE FUNCTION app_automation_capabilities_guard();--> statement-breakpoint

-- =============================================================================
-- 2. campaigns and campaign_recipients (§4.1)
-- =============================================================================
ALTER TABLE "campaigns" ADD COLUMN "started_by" uuid;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "scheduled_by" uuid;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_scheduled_by_users_id_fk" FOREIGN KEY ("scheduled_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_pause_reason" CHECK ("pause_reason" IS NULL OR "pause_reason" IN ('operator', 'insufficient_funds', 'billing_account', 'no_provider_assignment', 'template_not_approved', 'channel_not_supported', 'automation_paused'));--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_pause_reason_shape" CHECK ("pause_reason" IS NULL OR "status" = 'paused');--> statement-breakpoint

-- Campaign lifecycle backstop (the service FSM, enforced for every principal):
--   draft -> scheduled | running | cancelled; scheduled -> draft | running | cancelled;
--   running -> paused | completed | cancelled; paused -> running | cancelled;
--   completed and cancelled are terminal; started_by / started_at are write-once.
CREATE FUNCTION app_campaigns_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('scheduled', 'running', 'cancelled'))
    OR (OLD.status = 'scheduled' AND NEW.status IN ('draft', 'running', 'cancelled'))
    OR (OLD.status = 'running' AND NEW.status IN ('paused', 'completed', 'cancelled'))
    OR (OLD.status = 'paused' AND NEW.status IN ('running', 'cancelled'))
  ) THEN
    RAISE EXCEPTION 'campaign % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'campaigns_lifecycle';
  END IF;
  IF (OLD.started_by IS NOT NULL AND NEW.started_by IS DISTINCT FROM OLD.started_by)
     OR (OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at) THEN
    RAISE EXCEPTION 'campaign % start attribution is write-once', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'campaigns_start_write_once';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_campaigns_lifecycle_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER trg_campaigns_lifecycle_guard BEFORE UPDATE ON "campaigns"
  FOR EACH ROW EXECUTE FUNCTION app_campaigns_lifecycle_guard();--> statement-breakpoint

ALTER TABLE "campaign_recipients" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_attempts_bounded" CHECK ("attempts" BETWEEN 0 AND 100);--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "campaign_recipients_sent_shape" CHECK (("status" = 'sent') = ("message_id" IS NOT NULL));--> statement-breakpoint
-- K4: the target of the composite attribution foreign key on messages.
ALTER TABLE "campaign_recipients" ADD CONSTRAINT "uq_campaign_recipients_attribution" UNIQUE ("id", "campaign_id", "contact_id", "workspace_id", "org_id");--> statement-breakpoint
-- K3: a message names at most one recipient (replaces the non-unique 0052 index).
DROP INDEX "campaign_recipients_message_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_campaign_recipients_message" ON "campaign_recipients" USING btree ("message_id") WHERE message_id IS NOT NULL;--> statement-breakpoint

-- Recipient guard: pending -> sent | skipped | failed only; terminal rows keep their outcome;
-- message_id is write-once and only with sent; the attribution columns never change. A sent
-- message must be attributed back to this recipient, checked by a definer that FAILS CLOSED
-- when it cannot read the message (the N1 lesson). identity_id may still be cleared by its
-- ON DELETE SET NULL.
CREATE FUNCTION app_campaign_recipients_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_recipient uuid;
BEGIN
  IF (NEW.id, NEW.campaign_id, NEW.org_id, NEW.workspace_id, NEW.contact_id)
     IS DISTINCT FROM (OLD.id, OLD.campaign_id, OLD.org_id, OLD.workspace_id, OLD.contact_id) THEN
    RAISE EXCEPTION 'campaign recipient % attribution is immutable', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'pending'
     AND (NEW.status, NEW.message_id, NEW.skip_reason, NEW.error_code, NEW.attempts)
         IS DISTINCT FROM (OLD.status, OLD.message_id, OLD.skip_reason, OLD.error_code, OLD.attempts) THEN
    RAISE EXCEPTION 'campaign recipient % has ended (%) and is immutable', OLD.id, OLD.status
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'pending' AND NEW.status IN ('sent', 'skipped', 'failed')) THEN
    RAISE EXCEPTION 'campaign recipient % cannot move from % to %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'campaign_recipients_lifecycle';
  END IF;
  IF OLD.message_id IS NOT NULL AND NEW.message_id IS DISTINCT FROM OLD.message_id THEN
    RAISE EXCEPTION 'campaign recipient % message is write-once', OLD.id USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.message_id IS NOT NULL AND OLD.message_id IS NULL THEN
    SELECT m.campaign_recipient_id INTO v_recipient
      FROM messages m WHERE m.id = NEW.message_id AND m.org_id = NEW.org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'campaign recipient % message % is not visible in organization %', NEW.id, NEW.message_id, NEW.org_id
        USING ERRCODE = 'foreign_key_violation', CONSTRAINT = 'campaign_recipients_message_id_messages_id_fk';
    END IF;
    IF v_recipient IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'message % is not attributed to campaign recipient %', NEW.message_id, NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'campaign_recipients_message_attribution';
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_campaign_recipients_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER trg_campaign_recipients_guard BEFORE UPDATE ON "campaign_recipients"
  FOR EACH ROW EXECUTE FUNCTION app_campaign_recipients_guard();--> statement-breakpoint

-- =============================================================================
-- 3. messages: campaign attribution (§4.2, DEP-4)
-- =============================================================================
ALTER TABLE "messages" ADD COLUMN "campaign_recipient_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_campaign_shape"
  CHECK (("campaign_id" IS NULL) = ("campaign_recipient_id" IS NULL));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_single_origin"
  CHECK ("journey_execution_id" IS NULL OR "campaign_recipient_id" IS NULL);--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_campaign_recipient_fk"
  FOREIGN KEY ("campaign_recipient_id", "campaign_id", "contact_id", "workspace_id", "org_id")
  REFERENCES "public"."campaign_recipients" ("id", "campaign_id", "contact_id", "workspace_id", "org_id")
  ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Write-once: the tenant-key trigger (0033, extended by 0066) now also covers the campaign columns.
DROP TRIGGER "trg_messages_tenant_key_immutable" ON "messages";--> statement-breakpoint
CREATE TRIGGER trg_messages_tenant_key_immutable
  AFTER UPDATE OF org_id, workspace_id, contact_id, channel_id, journey_id, journey_execution_id, campaign_id, campaign_recipient_id ON "messages"
  FOR EACH ROW
  WHEN (OLD.org_id IS DISTINCT FROM NEW.org_id OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR OLD.contact_id IS DISTINCT FROM NEW.contact_id OR OLD.channel_id IS DISTINCT FROM NEW.channel_id OR OLD.journey_id IS DISTINCT FROM NEW.journey_id OR OLD.journey_execution_id IS DISTINCT FROM NEW.journey_execution_id OR OLD.campaign_id IS DISTINCT FROM NEW.campaign_id OR OLD.campaign_recipient_id IS DISTINCT FROM NEW.campaign_recipient_id)
  EXECUTE FUNCTION fn_tenant_key_immutable('org_id', 'workspace_id', 'contact_id', 'channel_id', 'journey_id', 'journey_execution_id', 'campaign_id', 'campaign_recipient_id');--> statement-breakpoint

-- =============================================================================
-- 4. The campaign claim protocol (§4.4)
-- =============================================================================
CREATE TABLE "campaign_dispatch" (
	"campaign_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_slot_at" timestamp with time zone DEFAULT now() NOT NULL,
	"epoch" integer DEFAULT 0 NOT NULL,
	"claim_token" uuid,
	"claimed_until" timestamp with time zone,
	"claimed_by" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	CONSTRAINT "campaign_dispatch_claim_shape" CHECK (("claim_token" IS NULL) = ("claimed_until" IS NULL) AND ("claim_token" IS NULL) = ("claimed_by" IS NULL)),
	CONSTRAINT "campaign_dispatch_counters" CHECK ("epoch" >= 0 AND "attempts" >= 0),
	CONSTRAINT "campaign_dispatch_text_bounded" CHECK (("claimed_by" IS NULL OR char_length("claimed_by") BETWEEN 1 AND 100) AND ("last_error_code" IS NULL OR char_length("last_error_code") BETWEEN 1 AND 100))
);--> statement-breakpoint
ALTER TABLE "campaign_dispatch" ADD CONSTRAINT "campaign_dispatch_campaign_org_fk" FOREIGN KEY ("campaign_id", "org_id") REFERENCES "public"."campaigns"("id", "org_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_dispatch_due_idx" ON "campaign_dispatch" USING btree ("available_at", "next_slot_at");--> statement-breakpoint
ALTER TABLE "campaign_dispatch" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- acc_app (8B-3b dispatch / pause / cancel) creates and removes the row in its tenant transaction.
CREATE POLICY campaign_dispatch_select ON "campaign_dispatch" FOR SELECT TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY campaign_dispatch_insert ON "campaign_dispatch" FOR INSERT TO acc_app
  WITH CHECK (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
CREATE POLICY campaign_dispatch_delete ON "campaign_dispatch" FOR DELETE TO acc_app
  USING (org_id = app_current_org_id() AND (SELECT app_content_context_valid()));--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "campaign_dispatch" TO acc_app;--> statement-breakpoint
REVOKE ALL ON "campaign_dispatch" FROM PUBLIC;--> statement-breakpoint

-- The executor principal (OD-8B3-1): NOLOGIN, no credential, no membership.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'acc_campaign') THEN
    CREATE ROLE acc_campaign NOLOGIN;
  END IF;
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO acc_campaign;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_session_bypasses_rls() TO acc_campaign;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_org_id() TO acc_campaign;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_channel_resolve(text) TO acc_campaign;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_pricing_unit_for_channel(uuid) TO acc_campaign;--> statement-breakpoint

CREATE FUNCTION app_campaign_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.campaign_id', true), '')::uuid $$;--> statement-breakpoint
CREATE FUNCTION app_campaign_claim_token() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.campaign_claim_token', true), '')::uuid $$;--> statement-breakpoint
CREATE FUNCTION app_campaign_recipient_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('app.campaign_recipient_id', true), '')::uuid $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_campaign_id(), app_campaign_claim_token(), app_campaign_recipient_id() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_campaign_id(), app_campaign_claim_token(), app_campaign_recipient_id() TO acc_campaign;--> statement-breakpoint

-- The session's campaign claim is live (wall-clock lease). Definer, independent of the caller's policies.
CREATE FUNCTION app_campaign_claim_valid() RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM campaign_dispatch d
     WHERE d.campaign_id = app_campaign_id()
       AND d.org_id = app_current_org_id()
       AND d.claim_token = app_campaign_claim_token()
       AND d.claimed_until > clock_timestamp()
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_campaign_claim_valid() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_campaign_claim_valid() TO acc_campaign;--> statement-breakpoint

-- The claimed campaign's workspace and template (definer: read once, by id, under the live claim).
CREATE FUNCTION app_campaign_claimed()
RETURNS TABLE (campaign_id uuid, workspace_id uuid, template_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT c.id, c.workspace_id, c.template_id
    FROM campaigns c
   WHERE c.id = app_campaign_id() AND c.org_id = app_current_org_id() AND app_campaign_claim_valid()
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_campaign_claimed() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_campaign_claimed() TO acc_campaign;--> statement-breakpoint

-- The session recipient of the claimed campaign (its contact), under the live claim.
CREATE FUNCTION app_campaign_session_recipient()
RETURNS TABLE (recipient_id uuid, contact_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT r.id, r.contact_id
    FROM campaign_recipients r
   WHERE r.id = app_campaign_recipient_id() AND r.campaign_id = app_campaign_id()
     AND r.org_id = app_current_org_id() AND app_campaign_claim_valid()
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_campaign_session_recipient() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_campaign_session_recipient() TO acc_campaign;--> statement-breakpoint

-- Discovery and claim: due rows of RUNNING, non-deleted campaigns of organisations whose automation
-- is not paused; SKIP LOCKED, fresh token, lease, epoch + 1, attempts + 1, per-organisation share.
CREATE FUNCTION app_campaign_claim(p_worker text, p_limit integer, p_lease_seconds integer, p_per_org integer)
RETURNS TABLE (campaign_id uuid, org_id uuid, claim_token uuid, epoch integer, attempts integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR p_lease_seconds IS NULL
     OR p_lease_seconds < 5 OR p_lease_seconds > 600 OR p_per_org IS NULL OR p_per_org < 1
     OR p_worker IS NULL OR char_length(p_worker) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'app_campaign_claim: invalid arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  WITH ranked AS (
    SELECT d.campaign_id,
           row_number() OVER (PARTITION BY d.org_id ORDER BY d.available_at, d.campaign_id) AS rn
      FROM campaign_dispatch d
      JOIN campaigns c ON c.id = d.campaign_id AND c.org_id = d.org_id
      LEFT JOIN automation_controls ac ON ac.org_id = d.org_id
     WHERE d.available_at <= now() AND d.next_slot_at <= now()
       AND (d.claimed_until IS NULL OR d.claimed_until < now())
       AND c.status = 'running' AND c.deleted_at IS NULL
       AND NOT coalesce(ac.sending_paused, false)
  ), picked AS (
    SELECT d.campaign_id
      FROM campaign_dispatch d
     WHERE d.campaign_id IN (SELECT r.campaign_id FROM ranked r WHERE r.rn <= p_per_org)
       AND d.available_at <= now() AND d.next_slot_at <= now()
       AND (d.claimed_until IS NULL OR d.claimed_until < now())
     ORDER BY d.available_at, d.campaign_id
     LIMIT p_limit
       FOR UPDATE SKIP LOCKED
  )
  UPDATE campaign_dispatch d
     SET claim_token = gen_random_uuid(),
         claimed_until = now() + make_interval(secs => p_lease_seconds),
         claimed_by = p_worker,
         epoch = d.epoch + 1,
         attempts = d.attempts + 1
    FROM picked
   WHERE d.campaign_id = picked.campaign_id
  RETURNING d.campaign_id, d.org_id, d.claim_token, d.epoch, d.attempts;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_campaign_claim(text, integer, integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_campaign_claim(text, integer, integer, integer) TO acc_campaign;--> statement-breakpoint

-- =============================================================================
-- 5. Capabilities: mint and validity (§3.4) — enforced at the database boundary
-- =============================================================================
-- Mint. Journey subjects are refused until 8C-6. For a campaign recipient: the organisation's
-- control row and then the campaign row are locked FOR SHARE (held to commit), so a pause,
-- cancel or revocation either waits for this send or is seen here. Requires the live claim (and
-- its epoch), a running campaign, the session's own pending recipient and an unpaused
-- organisation. Returns an opaque token; only its sha256 is stored.
CREATE FUNCTION app_automation_capability_mint(p_kind automation_subject_kind, p_subject uuid)
RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org uuid := app_current_org_id();
  v_campaign uuid := app_campaign_id();
  v_paused boolean;
  v_status campaign_status;
  v_deleted timestamptz;
  v_initiator uuid;
  v_epoch integer;
  v_until timestamptz;
  v_token text;
  v_now timestamptz;
BEGIN
  IF p_kind IS DISTINCT FROM 'campaign_recipient' THEN
    RAISE EXCEPTION 'automation capability: % subjects are not available', p_kind
      USING ERRCODE = 'insufficient_privilege', DETAIL = 'SUBJECT_UNAVAILABLE';
  END IF;
  IF v_org IS NULL OR v_campaign IS NULL OR p_subject IS NULL
     OR p_subject IS DISTINCT FROM app_campaign_recipient_id() THEN
    RAISE EXCEPTION 'automation capability: the subject is not the session recipient'
      USING ERRCODE = 'insufficient_privilege', DETAIL = 'SUBJECT_MISMATCH';
  END IF;

  INSERT INTO automation_controls (org_id) VALUES (v_org) ON CONFLICT (org_id) DO NOTHING;
  SELECT ac.sending_paused INTO v_paused FROM automation_controls ac WHERE ac.org_id = v_org FOR SHARE;
  IF v_paused THEN
    RAISE EXCEPTION 'automation capability: sending is paused for the organization'
      USING ERRCODE = 'insufficient_privilege', DETAIL = 'AUTOMATION_PAUSED';
  END IF;

  SELECT c.status, c.deleted_at, c.started_by INTO v_status, v_deleted, v_initiator
    FROM campaigns c WHERE c.id = v_campaign AND c.org_id = v_org FOR SHARE;
  IF NOT FOUND OR v_status IS DISTINCT FROM 'running' OR v_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'automation capability: the campaign is not running'
      USING ERRCODE = 'insufficient_privilege', DETAIL = 'CAMPAIGN_NOT_RUNNING';
  END IF;

  SELECT d.epoch, d.claimed_until INTO v_epoch, v_until
    FROM campaign_dispatch d
   WHERE d.campaign_id = v_campaign AND d.org_id = v_org
     AND d.claim_token = app_campaign_claim_token() AND d.claimed_until > clock_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'automation capability: no live campaign claim'
      USING ERRCODE = 'insufficient_privilege', DETAIL = 'CLAIM_LOST';
  END IF;

  PERFORM 1 FROM campaign_recipients r
   WHERE r.id = p_subject AND r.campaign_id = v_campaign AND r.org_id = v_org AND r.status = 'pending';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'automation capability: the recipient is not pending in the claimed campaign'
      USING ERRCODE = 'insufficient_privilege', DETAIL = 'RECIPIENT_NOT_PENDING';
  END IF;

  -- One instant for issue and expiry (two clock_timestamp() calls would drift past the 30 s CHECK).
  v_now := clock_timestamp();
  IF v_until <= v_now THEN
    RAISE EXCEPTION 'automation capability: no live campaign claim'
      USING ERRCODE = 'insufficient_privilege', DETAIL = 'CLAIM_LOST';
  END IF;
  v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  INSERT INTO automation_capabilities
    (org_id, subject_kind, subject_id, automation_id, claim_epoch, initiator_user_id, token_hash, issued_at, expires_at)
  VALUES (v_org, 'campaign_recipient', p_subject, v_campaign, v_epoch, v_initiator,
          sha256(convert_to(v_token, 'UTF8')), v_now,
          least(v_until, v_now + interval '30 seconds'));
  RETURN v_token;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_automation_capability_mint(automation_subject_kind, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_automation_capability_mint(automation_subject_kind, uuid) TO acc_campaign;--> statement-breakpoint

-- Validity: re-evaluated by every policy and statement that requires it (VOLATILE, wall-clock).
-- True only for the session's own campaign-recipient capability, unexpired, unrevoked (row and
-- organisation-wide revoked_before), with the campaign still running, the organisation not
-- paused and the claim live with the same epoch. Journey subjects are never valid (until 8C-6).
CREATE FUNCTION app_automation_capability_valid() RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM automation_capabilities cap
      JOIN campaigns c ON c.id = cap.automation_id AND c.org_id = cap.org_id
      JOIN campaign_dispatch d ON d.campaign_id = cap.automation_id AND d.org_id = cap.org_id
      LEFT JOIN automation_controls ac ON ac.org_id = cap.org_id
     WHERE nullif(current_setting('app.automation_capability', true), '') IS NOT NULL
       AND cap.token_hash = sha256(convert_to(current_setting('app.automation_capability', true), 'UTF8'))
       AND cap.org_id = app_current_org_id()
       AND cap.subject_kind = 'campaign_recipient'
       AND cap.subject_id = app_campaign_recipient_id()
       AND cap.automation_id = app_campaign_id()
       AND cap.revoked_at IS NULL
       AND clock_timestamp() < cap.expires_at
       AND (ac.revoked_before IS NULL OR cap.issued_at > ac.revoked_before)
       AND NOT coalesce(ac.sending_paused, false)
       AND c.status = 'running' AND c.deleted_at IS NULL
       AND d.claim_token = app_campaign_claim_token()
       AND d.claimed_until > clock_timestamp()
       AND d.epoch = cap.claim_epoch
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_automation_capability_valid() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_automation_capability_valid() TO acc_campaign;--> statement-breakpoint

-- Retention (OD-8B3-6): capabilities older than 90 days, in bounded batches.
CREATE FUNCTION app_automation_purge_capabilities(p_limit integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'app_automation_purge_capabilities: invalid limit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  WITH old AS (
    SELECT id FROM automation_capabilities
     WHERE issued_at < clock_timestamp() - interval '90 days'
     ORDER BY issued_at LIMIT p_limit FOR UPDATE SKIP LOCKED
  )
  DELETE FROM automation_capabilities a USING old WHERE a.id = old.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_automation_purge_capabilities(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_automation_purge_capabilities(integer) TO acc_campaign;--> statement-breakpoint

-- =============================================================================
-- 6. Administrator controls (§3.5, OD-8B3-5, C-1)
-- =============================================================================
-- Organisation-wide authority: the session user holds campaigns.manage through a grant at THIS
-- organization's scope (or a platform grant, mirroring scopeCovers). A workspace or team grant
-- never satisfies it. API-key sessions are refused. Parity with PermissionEvaluator is tested.
CREATE FUNCTION app_automation_org_authority() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_org uuid := app_current_org_id();
  v_user uuid := nullif(current_setting('app.current_user_id', true), '')::uuid;
BEGIN
  IF v_org IS NULL OR v_user IS NULL
     OR nullif(current_setting('app.current_api_key_id', true), '') IS NOT NULL
     OR NOT app_content_context_valid() THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
      FROM user_roles ur
      JOIN users u ON u.id = ur.user_id AND u.status = 'active'
      JOIN role_permissions rp ON rp.role_id = ur.role_id
      JOIN permissions p ON p.id = rp.permission_id AND p.key = 'campaigns.manage'
     WHERE ur.user_id = v_user
       AND ((ur.scope_type = 'organization' AND ur.scope_id = v_org AND ur.org_id = v_org)
            OR ur.scope_type = 'platform')
  );
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_automation_org_authority() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_automation_org_authority() TO acc_app;--> statement-breakpoint

-- Internal: applies a control to one organisation under FOR UPDATE on its control row (serialised
-- against every send's FOR SHARE). No grant: reached through the two definers below (acc_app) or
-- by the owner-run automation:control CLI.
CREATE FUNCTION app_automation_apply_control(p_org uuid, p_action text, p_user uuid, p_label text, p_reason text)
RETURNS TABLE (sending_paused boolean, revoked_before timestamptz, revoked_count integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  v_count integer := 0;
BEGIN
  IF p_org IS NULL OR p_action NOT IN ('pause', 'resume', 'revoke')
     OR (p_reason IS NOT NULL AND char_length(p_reason) NOT BETWEEN 1 AND 200)
     OR (p_label IS NOT NULL AND char_length(p_label) NOT BETWEEN 1 AND 100) THEN
    RAISE EXCEPTION 'app_automation_apply_control: invalid arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO automation_controls (org_id) VALUES (p_org) ON CONFLICT (org_id) DO NOTHING;
  PERFORM 1 FROM automation_controls WHERE org_id = p_org FOR UPDATE;
  IF p_action = 'pause' THEN
    UPDATE automation_controls
       SET sending_paused = true, paused_at = clock_timestamp(), paused_by_user_id = p_user,
           paused_by_label = p_label, pause_reason = p_reason, updated_at = now()
     WHERE org_id = p_org;
  ELSIF p_action = 'resume' THEN
    UPDATE automation_controls
       SET sending_paused = false, paused_at = NULL, paused_by_user_id = NULL,
           paused_by_label = NULL, pause_reason = NULL, updated_at = now()
     WHERE org_id = p_org;
  ELSE
    UPDATE automation_controls SET revoked_before = clock_timestamp(), updated_at = now() WHERE org_id = p_org;
    UPDATE automation_capabilities SET revoked_at = clock_timestamp()
     WHERE org_id = p_org AND revoked_at IS NULL AND expires_at > clock_timestamp();
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;
  RETURN QUERY SELECT ac.sending_paused, ac.revoked_before, v_count FROM automation_controls ac WHERE ac.org_id = p_org;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_automation_apply_control(uuid, text, uuid, text, text) FROM PUBLIC;--> statement-breakpoint

-- The tenant API path (acc_app): the session's organization only, with organisation-scope authority.
CREATE FUNCTION app_automation_control(p_action text, p_reason text)
RETURNS TABLE (sending_paused boolean, revoked_before timestamptz, revoked_count integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT app_automation_org_authority() THEN
    RAISE EXCEPTION 'automation control requires campaigns.manage at organization scope'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY SELECT * FROM app_automation_apply_control(
    app_current_org_id(), p_action, nullif(current_setting('app.current_user_id', true), '')::uuid, NULL, p_reason);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_automation_control(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_automation_control(text, text) TO acc_app;--> statement-breakpoint

-- Read-only status for the same callers.
CREATE FUNCTION app_automation_control_status()
RETURNS TABLE (sending_paused boolean, paused_at timestamptz, pause_reason text, revoked_before timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
  SELECT coalesce(ac.sending_paused, false), ac.paused_at, ac.pause_reason, ac.revoked_before
    FROM (SELECT app_current_org_id() AS org_id) s
    LEFT JOIN automation_controls ac ON ac.org_id = s.org_id
   WHERE app_automation_org_authority()
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_automation_control_status() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_automation_control_status() TO acc_app;--> statement-breakpoint

-- =============================================================================
-- 7. Reservation admission: the one per-message path, function-local (§5.5, C-7)
-- =============================================================================
-- Identical to 0053 except step 1: a valid automation capability also admits the call, and then
-- only for the capability subject's own message.
CREATE OR REPLACE FUNCTION app_message_reserve(p_message_id uuid)
RETURNS TABLE (reserved_paise bigint, inserted boolean, evaluation_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_org uuid := nullif(current_setting('app.current_org_id', true), '')::uuid;
  v_message messages%ROWTYPE;
  v_mode billing_mode;
  v_policy billing_policy;
  v_unit pricing_unit;
  v_eval uuid;
  v_amount bigint;
  v_candidates integer := 0;
  v_max bigint := 0;
  v_price bigint;
  v_provider uuid;
  v_inserted boolean;
  v_posted bigint;
  v_automation boolean := false;
BEGIN
  -- 1. Caller: a tenant content context, or (8B-3a) a valid automation capability.
  IF p_message_id IS NULL THEN
    RAISE EXCEPTION 'a message is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'reservation requires a valid tenant content context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT app_content_context_valid() THEN
    IF NOT app_automation_capability_valid() THEN
      RAISE EXCEPTION 'reservation requires a valid tenant content context'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_automation := true;
  END IF;
  SELECT * INTO v_message FROM messages msg WHERE msg.id = p_message_id AND msg.org_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'message is not in the current organization' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_automation AND (v_message.campaign_recipient_id IS DISTINCT FROM app_campaign_recipient_id()
                       OR v_message.campaign_id IS DISTINCT FROM app_campaign_id()) THEN
    RAISE EXCEPTION 'the message is not the automation capability subject''s'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- 2. The message must have been submitted under enforcement, with its units.
  IF NOT v_message.billing_enforced
     OR v_message.billing_mode_snapshot IS NULL
     OR v_message.billing_policy_snapshot IS NULL
     OR v_message.billable_units IS NULL THEN
    RAISE EXCEPTION 'message was not submitted under billing enforcement'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_unit := app_pricing_unit_for_channel(v_message.channel_id);
  IF v_unit IS NULL OR v_unit <> v_message.billable_unit THEN
    RAISE EXCEPTION 'message units do not match its channel' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- 3. The snapshot must still be the organization's billing settings (0053, unchanged).
  SELECT o.billing_mode, o.billing_policy INTO v_mode, v_policy
    FROM organizations o WHERE o.id = v_org
     FOR SHARE;
  IF (v_mode, v_policy) IS DISTINCT FROM (v_message.billing_mode_snapshot, v_message.billing_policy_snapshot) THEN
    RAISE EXCEPTION 'billing settings changed during submission' USING ERRCODE = 'serialization_failure';
  END IF;

  -- 4. Size.
  IF v_message.billing_policy_snapshot = 'charge_per_logical_message' THEN
    SELECT r.evaluation_id, r.total_customer_price_paise INTO v_eval, v_amount
      FROM app_rate_message(v_org, v_message.id, NULL, v_message.billable_units, true, false) r;
  ELSE
    FOR v_provider IN
      SELECT DISTINCT a.provider_id
        FROM organization_provider_assignments a
       WHERE a.org_id = v_org AND a.channel_id = v_message.channel_id AND a.status = 'active'
       ORDER BY a.provider_id
    LOOP
      SELECT l.customer_price_paise INTO v_price
        FROM app_price_lookup(v_org, v_message.channel_id, v_provider, v_message.billable_units,
                              now(), true, false) l;
      v_candidates := v_candidates + 1;
      v_max := greatest(v_max, v_price);
    END LOOP;
    IF v_candidates = 0 THEN
      RAISE EXCEPTION 'no active provider assignment for the channel' USING ERRCODE = 'serialization_failure';
    END IF;
    v_amount := v_candidates::bigint * v_max;
  END IF;

  -- 5. Reserve (nothing for a zero amount).
  IF v_amount = 0 THEN
    RETURN QUERY SELECT 0::bigint, false, v_eval;
    RETURN;
  END IF;
  SELECT p.inserted, p.amount_paise INTO v_inserted, v_posted
    FROM app_ledger_post(
      v_org, 'reservation', v_message.id, v_amount,
      CASE v_message.billing_mode_snapshot WHEN 'prepaid' THEN 'wallet' ELSE 'credit' END,
      v_message.id, NULL, v_message.correlation_id, NULL
    ) p;
  RETURN QUERY SELECT v_posted, v_inserted, v_eval;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_message_reserve(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_message_reserve(uuid) TO acc_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_message_reserve(uuid) TO acc_campaign;--> statement-breakpoint

-- =============================================================================
-- 8. acc_campaign policies and grants (§4.5)
-- =============================================================================
-- Claim-bound: the claimed campaign's dispatch row, campaign and recipients, and its audit rows.
CREATE POLICY campaign_dispatch_executor_select ON "campaign_dispatch" FOR SELECT TO acc_campaign
  USING (campaign_id = app_campaign_id() AND org_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY campaign_dispatch_executor_update ON "campaign_dispatch" FOR UPDATE TO acc_campaign
  USING (campaign_id = app_campaign_id() AND org_id = app_current_org_id()
         AND claim_token = app_campaign_claim_token() AND claimed_until > clock_timestamp())
  WITH CHECK (campaign_id = app_campaign_id() AND org_id = app_current_org_id());--> statement-breakpoint
CREATE POLICY campaign_dispatch_executor_delete ON "campaign_dispatch" FOR DELETE TO acc_campaign
  USING (campaign_id = app_campaign_id() AND org_id = app_current_org_id()
         AND claim_token = app_campaign_claim_token() AND claimed_until > clock_timestamp());--> statement-breakpoint
CREATE POLICY campaigns_executor_select ON "campaigns" FOR SELECT TO acc_campaign
  USING (id = app_campaign_id() AND org_id = app_current_org_id() AND (SELECT app_campaign_claim_valid()));--> statement-breakpoint
CREATE POLICY campaigns_executor_update ON "campaigns" FOR UPDATE TO acc_campaign
  USING (id = app_campaign_id() AND org_id = app_current_org_id() AND (SELECT app_campaign_claim_valid()))
  WITH CHECK (id = app_campaign_id() AND org_id = app_current_org_id() AND (SELECT app_campaign_claim_valid()));--> statement-breakpoint
CREATE POLICY campaign_recipients_executor_select ON "campaign_recipients" FOR SELECT TO acc_campaign
  USING (campaign_id = app_campaign_id() AND org_id = app_current_org_id() AND (SELECT app_campaign_claim_valid()));--> statement-breakpoint
CREATE POLICY campaign_recipients_executor_update ON "campaign_recipients" FOR UPDATE TO acc_campaign
  USING (campaign_id = app_campaign_id() AND org_id = app_current_org_id() AND (SELECT app_campaign_claim_valid()))
  WITH CHECK (campaign_id = app_campaign_id() AND org_id = app_current_org_id() AND (SELECT app_campaign_claim_valid()));--> statement-breakpoint
CREATE POLICY audit_logs_campaign_executor_insert ON "audit_logs" FOR INSERT TO acc_campaign
  WITH CHECK (org_id = app_current_org_id()
              AND (SELECT app_campaign_claim_valid())
              AND actor_type = 'system' AND actor_label = 'campaign_executor'
              AND actor_user_id IS NULL AND actor_api_key_id IS NULL
              AND action IN ('campaign.completed', 'campaign.auto_paused', 'campaign.recipient_failed')
              AND resource_type = 'Campaign' AND resource_id = app_campaign_id());--> statement-breakpoint

-- Claim-bound AND capability-gated: exactly the shared core's footprint for the session recipient.
CREATE POLICY contacts_executor_select ON "contacts" FOR SELECT TO acc_campaign
  USING (org_id = app_current_org_id()
         AND id = (SELECT r.contact_id FROM app_campaign_session_recipient() r)
         AND (SELECT app_automation_capability_valid()));--> statement-breakpoint
CREATE POLICY contact_identities_executor_select ON "contact_identities" FOR SELECT TO acc_campaign
  USING (org_id = app_current_org_id()
         AND contact_id = (SELECT r.contact_id FROM app_campaign_session_recipient() r)
         AND (SELECT app_automation_capability_valid()));--> statement-breakpoint
CREATE POLICY consent_events_executor_select ON "consent_events" FOR SELECT TO acc_campaign
  USING (org_id = app_current_org_id()
         AND contact_id = (SELECT r.contact_id FROM app_campaign_session_recipient() r)
         AND (SELECT app_automation_capability_valid()));--> statement-breakpoint
CREATE POLICY suppressions_executor_select ON "suppressions" FOR SELECT TO acc_campaign
  USING (org_id = app_current_org_id()
         AND (SELECT app_automation_capability_valid())
         AND normalized_address IN (
           SELECT ci.normalized_address FROM contact_identities ci
            WHERE ci.org_id = app_current_org_id()
              AND ci.contact_id = (SELECT r.contact_id FROM app_campaign_session_recipient() r)));--> statement-breakpoint
CREATE POLICY templates_executor_select ON "templates" FOR SELECT TO acc_campaign
  USING (org_id = app_current_org_id()
         AND id = (SELECT c.template_id FROM app_campaign_claimed() c)
         AND (SELECT app_automation_capability_valid()));--> statement-breakpoint
CREATE POLICY organization_provider_assignments_executor_select ON "organization_provider_assignments" FOR SELECT TO acc_campaign
  USING (org_id = app_current_org_id() AND (SELECT app_automation_capability_valid()));--> statement-breakpoint
CREATE POLICY organizations_executor_select ON "organizations" FOR SELECT TO acc_campaign
  USING (id = app_current_org_id() AND (SELECT app_automation_capability_valid()));--> statement-breakpoint
CREATE POLICY workspaces_executor_select ON "workspaces" FOR SELECT TO acc_campaign
  USING (org_id = app_current_org_id()
         AND id = (SELECT c.workspace_id FROM app_campaign_claimed() c)
         AND (SELECT app_automation_capability_valid()));--> statement-breakpoint
CREATE POLICY messages_executor_insert ON "messages" FOR INSERT TO acc_campaign
  WITH CHECK (org_id = app_current_org_id()
              AND campaign_id = app_campaign_id()
              AND campaign_recipient_id = app_campaign_recipient_id()
              AND contact_id = (SELECT r.contact_id FROM app_campaign_session_recipient() r)
              AND journey_execution_id IS NULL
              AND (SELECT app_automation_capability_valid()));--> statement-breakpoint
CREATE POLICY messages_executor_select ON "messages" FOR SELECT TO acc_campaign
  USING (org_id = app_current_org_id()
         AND campaign_id = app_campaign_id()
         AND campaign_recipient_id = app_campaign_recipient_id()
         AND (SELECT app_automation_capability_valid()));--> statement-breakpoint
CREATE POLICY message_dispatch_queue_executor_insert ON "message_dispatch_queue" FOR INSERT TO acc_campaign
  WITH CHECK (org_id = app_current_org_id()
              AND message_id IN (SELECT m.id FROM messages m
                                  WHERE m.org_id = app_current_org_id()
                                    AND m.campaign_recipient_id = app_campaign_recipient_id())
              AND (SELECT app_automation_capability_valid()));--> statement-breakpoint
CREATE POLICY message_events_executor_insert ON "message_events" FOR INSERT TO acc_campaign
  WITH CHECK (org_id = app_current_org_id()
              AND message_id IN (SELECT m.id FROM messages m
                                  WHERE m.org_id = app_current_org_id()
                                    AND m.campaign_recipient_id = app_campaign_recipient_id())
              AND (SELECT app_automation_capability_valid()));--> statement-breakpoint

GRANT SELECT, DELETE ON "campaign_dispatch" TO acc_campaign;--> statement-breakpoint
GRANT UPDATE ("available_at", "next_slot_at", "claim_token", "claimed_until", "claimed_by", "attempts", "last_error_code") ON "campaign_dispatch" TO acc_campaign;--> statement-breakpoint
GRANT SELECT ON "campaigns" TO acc_campaign;--> statement-breakpoint
GRANT UPDATE ("status", "pause_reason", "completed_at", "metrics", "updated_at") ON "campaigns" TO acc_campaign;--> statement-breakpoint
GRANT SELECT ON "campaign_recipients" TO acc_campaign;--> statement-breakpoint
GRANT UPDATE ("status", "message_id", "skip_reason", "error_code", "attempts", "updated_at") ON "campaign_recipients" TO acc_campaign;--> statement-breakpoint
GRANT INSERT ON "audit_logs" TO acc_campaign;--> statement-breakpoint
GRANT SELECT ON "contacts", "contact_identities", "consent_events", "suppressions", "templates",
  "organization_provider_assignments", "organizations", "workspaces" TO acc_campaign;--> statement-breakpoint
GRANT SELECT, INSERT ON "messages" TO acc_campaign;--> statement-breakpoint
GRANT INSERT ON "message_dispatch_queue", "message_events" TO acc_campaign;
