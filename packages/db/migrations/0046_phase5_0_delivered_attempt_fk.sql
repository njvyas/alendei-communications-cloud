-- =============================================================================
-- Migration: 0046_phase5_0_delivered_attempt_fk   (Phase 5.0, M3)
--
-- 1. Attaches the concurrently built unique index (id, message_id) as the UNIQUE
--    constraint of the same name (USING INDEX: no rebuild, no rename).
-- 2. Adds the composite foreign key messages(delivered_attempt_id, id) ->
--    message_attempts(id, message_id): the delivering attempt must belong to the
--    same message. Added NOT VALID, then validated (no long exclusive lock; every
--    existing delivered_attempt_id is NULL, which MATCH SIMPLE never checks).
-- 3. Validates the CHECK constraints 0044 added NOT VALID.
-- =============================================================================
ALTER TABLE "message_attempts" ADD CONSTRAINT "uq_message_attempts_id_message_id" UNIQUE USING INDEX "uq_message_attempts_id_message_id";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_delivered_attempt_fk"
  FOREIGN KEY ("delivered_attempt_id", "id") REFERENCES "public"."message_attempts"("id", "message_id")
  ON DELETE restrict ON UPDATE no action NOT VALID;--> statement-breakpoint
ALTER TABLE "messages" VALIDATE CONSTRAINT "messages_delivered_attempt_fk";--> statement-breakpoint
ALTER TABLE "messages" VALIDATE CONSTRAINT "messages_delivered_at_consistent";--> statement-breakpoint
ALTER TABLE "messages" VALIDATE CONSTRAINT "messages_read_implies_delivered";--> statement-breakpoint
ALTER TABLE "messages" VALIDATE CONSTRAINT "messages_delivered_attempt_consistent";--> statement-breakpoint
ALTER TABLE "message_attempts" VALIDATE CONSTRAINT "message_attempts_delivered_at_consistent";--> statement-breakpoint
ALTER TABLE "message_attempts" VALIDATE CONSTRAINT "message_attempts_read_implies_delivered";--> statement-breakpoint
ALTER TABLE "message_attempts" VALIDATE CONSTRAINT "message_attempts_provider_message_id_length";
