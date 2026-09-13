-- =============================================================================
-- Phase 1B.2 — refresh-token rotation lineage on `sessions` (RBAC.md §5a)
--
-- Additive only: four nullable-or-defaulted columns, one self-referencing
-- foreign key, one index, one unique constraint and one check. No table is
-- created, so no new RLS policy is required — `sessions` already carries
-- `sessions_self` (acc_app) and `sessions_auth` (acc_auth) from migration 0000,
-- and both continue to govern every column added here. The integration suite
-- re-asserts them against the catalog rather than assuming they survived.
--
-- The concurrency invariant these columns exist to enforce:
--
--   Two concurrent refresh requests presenting the SAME valid refresh token
--   must not both rotate it.
--
-- That is enforced by the database, not by application checks:
--
--   1. Rotation is a conditional UPDATE — `WHERE id = $1 AND rotated_at IS NULL`.
--      Under READ COMMITTED the second transaction blocks on the row lock, then
--      re-evaluates its predicate against the committed row, matches nothing,
--      and reports zero rows updated. Exactly one caller can win.
--   2. `sessions_replaced_by_session_id_key` makes a successor able to replace
--      at most one predecessor, so two winners cannot be reconciled after the
--      fact even if the conditional update were ever weakened.
--   3. `sessions_rotation_shape` keeps the lineage columns coherent: a row
--      cannot name a successor, or record reuse, without having been rotated.
--
-- A zero-row rotation is not a retryable failure — it means the token was
-- already used, which is the signature of a replayed (presumed stolen) token.
-- The response is to revoke the whole `family_id` chain, which is why the
-- family column exists.
-- =============================================================================

ALTER TABLE "sessions" ADD COLUMN "family_id" uuid DEFAULT uuidv7() NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "replaced_by_session_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "reuse_detected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_replaced_by_session_id_fk" FOREIGN KEY ("replaced_by_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_family_id_idx" ON "sessions" USING btree ("family_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_replaced_by_session_id_key" UNIQUE("replaced_by_session_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_rotation_shape" CHECK (("sessions"."replaced_by_session_id" IS NULL OR "sessions"."rotated_at" IS NOT NULL)
       AND ("sessions"."reuse_detected_at" IS NULL OR "sessions"."rotated_at" IS NOT NULL));