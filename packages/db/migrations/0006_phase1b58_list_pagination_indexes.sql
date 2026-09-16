-- =============================================================================
-- Phase 1B.5.8 — indexes supporting keyset pagination (`API.md` §8)
--
-- Cursor pagination reads `WHERE <tenant predicate> AND (<sort>, id) > (?, ?)
-- ORDER BY <sort>, id LIMIT n`. Without an index whose leading columns match
-- that ordering, PostgreSQL sorts the whole predicate on every page — which is
-- the behaviour offset pagination is usually blamed for and which keyset
-- pagination only avoids when the index actually exists.
--
-- Each index below is the tenant discriminator followed by the sort column and
-- the tie-breaker, in the default sort's direction, so the planner can walk it
-- and stop at `LIMIT`.
--
-- No table is created, so no RLS policy is required; every column indexed here
-- is already governed by its table's existing policies, which the integration
-- suite re-asserts against the catalog rather than assuming.
--
-- Deliberately *not* added: an index per offered sort direction. PostgreSQL can
-- scan a btree backwards, so `(org_id, key, id)` serves both `key` and `-key`.
-- Nor an index for `/permissions`: the catalogue is 33 rows and global, and the
-- existing `permissions_key_key` unique index already orders it.
-- =============================================================================

-- `GET /roles` — default sort `key`, alternative `createdAt`, tie-break `id`.
CREATE INDEX IF NOT EXISTS "roles_org_key_id_idx"
  ON "roles" ("org_id", "key", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "roles_org_created_at_id_idx"
  ON "roles" ("org_id", "created_at", "id");--> statement-breakpoint

-- `GET /role-assignments` — default sort `-createdAt`, alternative `scopeType`.
-- `org_id` leads because RLS scopes every read of this table by it.
CREATE INDEX IF NOT EXISTS "user_roles_org_created_at_id_idx"
  ON "user_roles" ("org_id", "created_at", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_roles_org_scope_type_id_idx"
  ON "user_roles" ("org_id", "scope_type", "id");--> statement-breakpoint

-- `GET /tenants/workspaces` — default sort `name`, alternative `createdAt`.
CREATE INDEX IF NOT EXISTS "workspaces_org_name_id_idx"
  ON "workspaces" ("org_id", "name", "id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspaces_org_created_at_id_idx"
  ON "workspaces" ("org_id", "created_at", "id");
