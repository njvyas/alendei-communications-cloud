-- =============================================================================
-- Phase 3.4 — Message Fallback & Resilience
-- (ADR-014 §7, §8, P3-D13, P3-D14, P3-D15, P3-D03)
--
-- 1. Updates `fn_messages_terminal_guard()`:
--    Allows `submitting -> queued` strictly for `acc_dispatch` (or bypass)
--    under an active unexpired dispatch claim on `message_dispatch_queue`,
--    when the active attempt (`OLD.current_attempt_id`) has durably settled
--    as `failed` with a fallback-eligible failure reason (PROVIDER_ERROR or RATE_LIMITED).
-- 2. Preserves strict terminal immutability for `accepted`, `failed`, and `outcome_unknown`.
-- =============================================================================

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
  ELSIF OLD.status = 'submitting' THEN
    IF NEW.status = 'queued' THEN
      -- Fallback state transition guard (Phase 3.4, ADR-014 §7, P3-D13, P3-D14)
      IF NOT (current_user = 'acc_dispatch' OR app_session_bypasses_rls()) THEN
        RAISE EXCEPTION 'UNAUTHORIZED_REQUEUE: principal % is not permitted to requeue message %', current_user, OLD.id
          USING ERRCODE = 'insufficient_privilege';
      END IF;

      IF NOT app_session_bypasses_rls() THEN
        IF NOT EXISTS (
          SELECT 1 FROM "message_dispatch_queue" q
          WHERE q.message_id = OLD.id
            AND q.claim_token = app_dispatch_claim_token()
            AND q.claimed_until > now()
        ) THEN
          RAISE EXCEPTION 'INVALID_DISPATCH_CLAIM: cannot requeue message % without an active unexpired dispatch claim', OLD.id
            USING ERRCODE = 'check_violation';
        END IF;

        IF OLD.current_attempt_id IS NULL OR NOT EXISTS (
          SELECT 1 FROM "message_attempts" ma
          JOIN "message_dispatch_queue" q ON q.message_id = ma.message_id
          WHERE ma.id = OLD.current_attempt_id
            AND ma.message_id = OLD.id
            AND ma.claim_token = app_dispatch_claim_token()
            AND q.claim_token = app_dispatch_claim_token()
            AND ma.fencing_epoch = q.dispatch_epoch
            AND ma.status = 'failed'
            AND (ma.failure_reason LIKE 'PROVIDER_ERROR%' OR ma.failure_reason LIKE 'RATE_LIMITED%')
        ) THEN
          RAISE EXCEPTION 'FALLBACK_ATTEMPT_UNVERIFIED: message % cannot requeue without a durably settled fallback-eligible attempt', OLD.id
            USING ERRCODE = 'check_violation';
        END IF;
      END IF;
    ELSIF NEW.status NOT IN ('submitting', 'accepted', 'failed', 'outcome_unknown') THEN
      RAISE EXCEPTION 'ILLEGAL_STATE_TRANSITION: message % cannot transition % -> %', OLD.id, OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
