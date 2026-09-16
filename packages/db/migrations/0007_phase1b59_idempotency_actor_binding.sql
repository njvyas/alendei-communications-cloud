-- =============================================================================
-- Phase 1B.5.9 — actor binding and diagnostics on `idempotency_keys`
--
-- The table, its RLS policy and its `(org_id, endpoint, idempotency_key)` unique
-- index all ship in migration `0000` and are sound; this migration adds only
-- what the execution/replay mechanism needs and could not previously record.
--
-- --- Why an actor at all ------------------------------------------------------
--
-- The documented scope is organization-wide on purpose (`DATABASE.md` §7.1): an
-- org-wide key means a caller cannot accidentally collide across its own
-- workspaces. But org-wide scope alone would let one principal inside an
-- organization present another principal's key and receive that principal's
-- stored response — turning a previously successful request into a credential.
--
-- The *enforcement* for that is the request hash, which includes the resolved
-- principal, so a different actor computes a different hash and is refused as a
-- payload mismatch. These columns are therefore **diagnostic, not a uniqueness
-- term**: they answer "who owned this key" when someone asks why a replay was
-- refused. Making them part of the unique index instead would silently let two
-- principals run the same key as two separate mutations, which is a worse answer
-- than a deterministic refusal.
--
-- Nullable because the two are mutually exclusive — a request is authenticated
-- by a session or by an API key, never both — and `audit_logs` already models
-- the same pair the same way.
--
-- --- Why a correlation id -----------------------------------------------------
--
-- The correlation id of the request that *created* the record, kept so an
-- operator can find the original execution from a replay. It is deliberately not
-- replayed to the client: a replay is its own request and carries its own
-- correlation id (`API.md` §4a).
--
-- Additive only. No table is created, so no new RLS policy is required:
-- `idempotency_keys_tenant` from migration `0000` governs every column added
-- here, which the integration suite re-asserts against the catalog.
-- =============================================================================

ALTER TABLE "idempotency_keys" ADD COLUMN IF NOT EXISTS "actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN IF NOT EXISTS "actor_api_key_id" uuid;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN IF NOT EXISTS "correlation_id" uuid;--> statement-breakpoint

ALTER TABLE "idempotency_keys" DROP CONSTRAINT IF EXISTS "idempotency_keys_actor_user_id_fk";--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_actor_user_id_fk"
  FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint

ALTER TABLE "idempotency_keys" DROP CONSTRAINT IF EXISTS "idempotency_keys_actor_api_key_id_fk";--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_actor_api_key_id_fk"
  FOREIGN KEY ("actor_api_key_id") REFERENCES "public"."api_keys"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint

-- Exactly one actor, mirroring `audit_logs_actor_shape`. A record with neither
-- would be unattributable; one with both would be incoherent.
ALTER TABLE "idempotency_keys" DROP CONSTRAINT IF EXISTS "idempotency_keys_actor_shape";--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_actor_shape"
  CHECK (num_nonnulls("actor_user_id", "actor_api_key_id") <= 1);
