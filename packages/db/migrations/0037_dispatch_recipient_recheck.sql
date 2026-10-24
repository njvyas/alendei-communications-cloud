-- =============================================================================
-- Migration: 0037_dispatch_recipient_recheck
-- Issue: Phase 4.3 G-2 (owner-approved approach B, 24-Oct-2026)
--
-- Objective:
-- Re-check the recipient against suppressions and consent when a message is
-- dispatched, not only when it is sent: either may change while the message
-- waits in the queue, or between a failed attempt and its fallback re-claim.
--
-- acc_dispatch has no grant on suppressions or consent_events, and receives
-- none here. Instead it may call one narrow function:
--
--   app_dispatch_recipient_block() RETURNS text
--
-- - No arguments: it answers only for the message in the caller's dispatch
--   context (app.dispatch_message_id, app.dispatch_claim_token,
--   app.current_org_id), and only while that claim is live — the same claim
--   check as the messages_dispatch_* policies (0033). Without a live claim it
--   raises insufficient_privilege (42501) rather than answer, so a missing
--   claim can never read as "not blocked".
-- - It returns a code only: NULL, 'RECIPIENT_SUPPRESSED' or 'CONSENT_REVOKED'.
--   No suppression row, reason or consent history leaves the function.
-- - The rules are the send path's (MessagesService.send, checks 3 and 5), in
--   the same order:
--   1. suppressed: an active suppression in the message's organization for its
--      normalized recipient address, on its channel or organization-wide;
--   2. consent revoked: the latest group of consent events for the message's
--      organization, channel and contact contains a revoke. "Latest group" is
--      every event in the same millisecond as the latest one, as the send path
--      compares occurred_at at JavaScript Date precision.
--
-- Privileges: SECURITY DEFINER with a pinned search_path, EXECUTE revoked from
-- PUBLIC and granted to acc_dispatch only. No table, policy or index changes.
--
-- Rollback (only after the dispatcher code that calls it is reverted):
--   DROP FUNCTION app_dispatch_recipient_block();
-- =============================================================================

CREATE OR REPLACE FUNCTION app_dispatch_recipient_block() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_org_id uuid;
  v_channel_id uuid;
  v_contact_id uuid;
  v_address text;
BEGIN
  SELECT m.org_id, m.channel_id, m.contact_id, m.recipient_address
    INTO v_org_id, v_channel_id, v_contact_id, v_address
  FROM messages m
  JOIN message_dispatch_queue q ON q.message_id = m.id
  WHERE m.id = app_dispatch_message_id()
    AND m.org_id = app_current_org_id()
    AND q.org_id = m.org_id
    AND q.claim_token = app_dispatch_claim_token()
    AND q.claimed_until > now();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no live dispatch claim for the message in this dispatch context'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF EXISTS (
    SELECT 1 FROM suppressions s
    WHERE s.org_id = v_org_id
      AND (s.channel_id = v_channel_id OR s.channel_id IS NULL)
      AND s.normalized_address = v_address
      AND s.status = 'active'
  ) THEN
    RETURN 'RECIPIENT_SUPPRESSED';
  END IF;

  IF EXISTS (
    SELECT 1 FROM consent_events c
    WHERE c.org_id = v_org_id
      AND c.channel_id = v_channel_id
      AND c.contact_id = v_contact_id
      AND c.event = 'revoke'
      AND date_trunc('milliseconds', c.occurred_at) = (
        SELECT date_trunc('milliseconds', max(l.occurred_at))
        FROM consent_events l
        WHERE l.org_id = v_org_id
          AND l.channel_id = v_channel_id
          AND l.contact_id = v_contact_id
      )
  ) THEN
    RETURN 'CONSENT_REVOKED';
  END IF;

  RETURN NULL;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_dispatch_recipient_block() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_dispatch_recipient_block() TO acc_dispatch;
