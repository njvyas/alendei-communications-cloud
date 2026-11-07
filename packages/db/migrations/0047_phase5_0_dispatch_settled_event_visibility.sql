-- =============================================================================
-- Migration: 0047_phase5_0_dispatch_settled_event_visibility   (Phase 5.0, forward fix)
--
-- Defect in 0044 (found implementing PR-B, T6), and the binding it lacked.
--
-- 1. Settlement was impossible. `webhook_events_dispatch_select` admitted only rows
--    whose outcome is 'deferred' or 'unmatched'. Settling a held receipt (design spec
--    Rev 2 §E.6) is an UPDATE of that outcome to a settled value. An UPDATE that reads
--    the table (a WHERE clause) needs SELECT rights, and PostgreSQL then requires the
--    NEW row to satisfy the SELECT policies' USING expression as well as the UPDATE
--    policy's WITH CHECK — so every settlement by acc_dispatch failed with
--    "new row violates row-level security policy for table webhook_events".
--
-- 2. The receipt was not bound to the claimed message. 0044 admitted, for SELECT and
--    UPDATE, any held receipt of the claimed message's provider — including one already
--    matched to another message — and its WITH CHECK never verified that the attempt a
--    receipt is matched to belongs to the claimed message.
--
-- Fix (forward only, repository practice, spec §C.6): one predicate,
-- `app_dispatch_owns_receipt`, decides whether a receipt belongs to the message
-- acc_dispatch holds a live claim on: there must be an attempt of that message, of the
-- receipt's provider, under a live unexpired claim, that the receipt is matched to or —
-- unmatched — names by its own references (the client reference is the attempt id; or
-- the provider message id the attempt recorded). With `p_require_reference` the
-- references must name that very attempt even when the receipt is matched. acc_dispatch
-- has no grant on `normalized`, `provider_id` or the identity columns, so it cannot
-- forge the references it is checked against.
--   SELECT  USING      : owns the receipt (held or already settled).
--   UPDATE  USING      : owns it AND it is still held ('deferred'/'unmatched') —
--                        a settled receipt can never be settled again.
--   UPDATE  WITH CHECK : matched to an attempt of the claimed message that its own
--                        references name, attributed to the current organization —
--                        so a receipt can be settled only onto the attempt it reports on.
-- Receipts of any other message — matched or not — are invisible and unmodifiable.
-- An invoker function (no SECURITY DEFINER): it reads message_attempts and the queue
-- under acc_dispatch's own RLS. ALTER POLICY: no gap, no table rewrite, metadata only.
-- acc_delivery's policies are unchanged.
-- =============================================================================
CREATE FUNCTION app_dispatch_owns_receipt(
  p_provider_id uuid,
  p_matched_attempt_id uuid,
  p_normalized jsonb,
  p_require_reference boolean
) RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM message_attempts a
      JOIN message_dispatch_queue q ON q.message_id = a.message_id
     WHERE a.message_id = app_dispatch_message_id()
       AND a.org_id = app_current_org_id()
       AND a.provider_id = p_provider_id
       AND q.claim_token = app_dispatch_claim_token()
       AND q.claimed_until > now()
       AND (p_matched_attempt_id IS NULL OR a.id = p_matched_attempt_id)
       AND (
         (p_matched_attempt_id IS NOT NULL AND NOT p_require_reference)
         OR a.id::text = p_normalized->>'clientReference'
         OR (a.provider_message_id IS NOT NULL
             AND a.provider_message_id = p_normalized->>'providerMessageId')
       )
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_dispatch_owns_receipt(uuid, uuid, jsonb, boolean) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_dispatch_owns_receipt(uuid, uuid, jsonb, boolean) TO acc_dispatch;--> statement-breakpoint

ALTER POLICY webhook_events_dispatch_select ON "webhook_events"
  USING (app_dispatch_owns_receipt(provider_id, matched_attempt_id, normalized, false));--> statement-breakpoint

ALTER POLICY webhook_events_dispatch_update ON "webhook_events"
  USING (
    outcome IN ('deferred', 'unmatched')
    AND app_dispatch_owns_receipt(provider_id, matched_attempt_id, normalized, false)
  )
  WITH CHECK (
    matched_attempt_id IS NOT NULL
    AND matched_org_id = app_current_org_id()
    AND app_dispatch_owns_receipt(provider_id, matched_attempt_id, normalized, true)
  );
