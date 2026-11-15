-- Phase 8B PR 8B-3b: the campaign executor's two database needs that 8B-3a did not cover
-- (PHASE-8B-3-HANDOVER-Rev2 §6.1). Nothing here enables anything: acc_campaign stays NOLOGIN and
-- CAMPAIGN_DISPATCH_ENABLED stays off (refused outside tests).
--
-- 1. The channel code of the claimed campaign: the shared core takes a channel CODE, and the
--    executor holds only the campaign's channel_id. app_channel_code (0031, definer, catalogue
--    read by id) is granted to acc_campaign; it reveals nothing tenant-specific.
-- 2. Scheduled start. The scheduler runs without a tenant session (no user, no API key), so it
--    cannot use acc_app. app_campaign_start_due (definer, acc_campaign only) moves due
--    `scheduled` campaigns to `running` with the scheduling user as the initiator (OD-8C-1),
--    creates their claim row, and audits the start — under SKIP LOCKED, so concurrent schedulers
--    start each campaign once. It never starts a campaign of a paused organisation, one with no
--    pending recipient, or one without a recorded initiator (scheduled before 8B-3b: it must be
--    scheduled again by a caller who holds messages.send).

GRANT EXECUTE ON FUNCTION app_channel_code(uuid) TO acc_campaign;--> statement-breakpoint

-- 3. Initiator attribution for API-key callers (OD-8C-1): a campaign scheduled or dispatched with
--    an API key records the key (the user columns stay NULL). Write-once, like started_by.
ALTER TABLE "campaigns" ADD COLUMN "scheduled_by_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "started_by_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_scheduled_by_api_key_id_api_keys_id_fk" FOREIGN KEY ("scheduled_by_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_started_by_api_key_id_api_keys_id_fk" FOREIGN KEY ("started_by_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_single_initiator" CHECK ("started_by" IS NULL OR "started_by_api_key_id" IS NULL);--> statement-breakpoint
CREATE FUNCTION app_campaigns_api_key_initiator_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.started_by_api_key_id IS NOT NULL AND NEW.started_by_api_key_id IS DISTINCT FROM OLD.started_by_api_key_id THEN
    RAISE EXCEPTION 'campaign % start attribution is write-once', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'campaigns_start_write_once';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_campaigns_api_key_initiator_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER trg_campaigns_api_key_initiator_guard BEFORE UPDATE ON "campaigns"
  FOR EACH ROW EXECUTE FUNCTION app_campaigns_api_key_initiator_guard();--> statement-breakpoint

CREATE FUNCTION app_campaign_start_due(p_limit integer)
RETURNS TABLE (campaign_id uuid, org_id uuid)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'app_campaign_start_due: invalid limit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  WITH due AS (
    SELECT c.id
      FROM campaigns c
      LEFT JOIN automation_controls ac ON ac.org_id = c.org_id
     WHERE c.status = 'scheduled' AND c.deleted_at IS NULL
       AND c.scheduled_at IS NOT NULL AND c.scheduled_at <= now()
       AND (c.scheduled_by IS NOT NULL OR c.scheduled_by_api_key_id IS NOT NULL)
       AND NOT coalesce(ac.sending_paused, false)
       AND EXISTS (SELECT 1 FROM campaign_recipients r WHERE r.campaign_id = c.id AND r.status = 'pending')
     ORDER BY c.scheduled_at, c.id
     LIMIT p_limit
       FOR UPDATE OF c SKIP LOCKED
  ), started AS (
    UPDATE campaigns c
       SET status = 'running', started_by = c.scheduled_by, started_by_api_key_id = c.scheduled_by_api_key_id,
           started_at = now(), updated_at = now()
      FROM due
     WHERE c.id = due.id AND c.status = 'scheduled'
    RETURNING c.id, c.org_id, c.workspace_id, c.scheduled_by, c.scheduled_by_api_key_id
  ), claim AS (
    INSERT INTO campaign_dispatch (campaign_id, org_id)
    SELECT s.id, s.org_id FROM started s
    ON CONFLICT (campaign_id) DO NOTHING
    RETURNING campaign_dispatch.campaign_id
  ), audited AS (
    INSERT INTO audit_logs (scope_type, scope_id, actor_type, actor_label, action, resource_type, resource_id,
                            outcome, metadata, correlation_id)
    SELECT 'workspace', s.workspace_id, 'system', 'campaign_scheduler', 'campaign.started', 'Campaign', s.id,
           'success'::audit_outcome,
           jsonb_build_object('via', 'schedule', 'initiatorUserId', s.scheduled_by, 'initiatorApiKeyId', s.scheduled_by_api_key_id),
           gen_random_uuid()
      FROM started s
    RETURNING 1
  )
  SELECT s.id, s.org_id FROM started s;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_campaign_start_due(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_campaign_start_due(integer) TO acc_campaign;
