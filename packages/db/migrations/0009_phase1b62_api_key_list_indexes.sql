-- =============================================================================
-- Phase 1B.6.2 — indexes supporting the API-key list (`API.md` §8)
--
-- The smallest change the phase needs, and the only one. `api_keys` has carried
-- everything else since migration `0000`: `key_prefix` (unique, shaped),
-- `key_hash` (Argon2id), `scopes`, `last_used_at`, `expires_at`, `revoked_at`,
-- `revoked_reason`, `created_by`, the `(id, org_id)` composite the audit foreign
-- key depends on, and the `api_keys_tenant` RLS policy. No column is added, no
-- policy is changed, and no state machine is persisted.
--
-- Two indexes, one per offered sort, in the shape migration `0006` established:
-- the tenant discriminator, the sort column, then the tie-breaker, so the
-- planner walks the index and stops at LIMIT instead of sorting the whole
-- predicate on every page.
--
-- No table is created, so no RLS policy is required; every column indexed here
-- is already governed by `api_keys_tenant`, which the integration suite
-- re-asserts against the catalog rather than assuming.
--
-- **Deliberately not added:**
--
--   - An index for a `status` sort. `status` is *derived* (`revoked_at`,
--     `expires_at`, `now()`), not stored — see `DATABASE.md` §2 — so there is no
--     column to order by, and materialising one would create the second source
--     of truth the derived model exists to avoid.
--   - Indexes for `last_used_at` / `expires_at` sorts. Both columns are
--     nullable, and keyset pagination over a nullable column has no total order
--     without explicit NULLS handling in both the ordering and the cursor
--     predicate. The sorts are not offered, so the indexes would serve nothing.
--   - Anything for the authentication path. `api_keys_key_prefix_key` from
--     `0000` already makes credential lookup a single unique-index probe.
-- =============================================================================

-- `GET /api-keys` — default sort `-createdAt`, which orders by `id` (a UUIDv7,
-- chronological by construction and exact through a text cursor).
CREATE INDEX IF NOT EXISTS "api_keys_org_id_id_idx"
  ON "api_keys" ("org_id", "id");--> statement-breakpoint

-- `GET /api-keys?sort=name` — the alternative ordering.
CREATE INDEX IF NOT EXISTS "api_keys_org_name_id_idx"
  ON "api_keys" ("org_id", "name", "id");
