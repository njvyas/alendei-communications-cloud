-- =============================================================================
-- Phase 1B.6.1 — user administration support
--
-- Deliberately small. The user lifecycle this phase exposes is the one that has
-- existed since migration `0000`: `users.status` with its `invited | active |
-- disabled` enum and the `users_active_requires_credential` CHECK that makes the
-- states mean something. No column is added, no lifecycle timestamp is invented
-- and no policy is changed — the surface is new, the model is not.
--
-- Three things are actually required:
--
--   1. an index for the organization-membership probe the user list runs;
--   2. the `users.reactivate` permission row, so the catalogue matches the code
--      that checks it;
--   3. that permission attached to the roles that already hold its counterpart,
--      so an upgraded database is not left with a permission nothing grants.
--
-- What is deliberately **not** here:
--
--   - Any `DELETE` grant on `users`. `acc_app` has never had one (`0000`), which
--     is why this phase's lifecycle is disable/reactivate rather than deletion:
--     the destructive option is not merely unimplemented, it is unavailable to
--     the application role. Users are referenced by `sessions`, `api_keys`,
--     `user_roles`, `audit_logs` and `idempotency_keys`; removing one would
--     either cascade those away or be refused, and the audit trail must survive
--     the identity it describes.
--   - Any change to `trg_users_platform_admin_liveness` (`0005`). Disabling a
--     user is already one of the two paths that trigger guards, and it remains
--     the final authority over the new endpoint exactly as it is over any other
--     writer. The service's own check exists to produce a clean `409`, not to
--     replace it.
-- =============================================================================

-- --- 1. The organization-membership probe -------------------------------------
-- `users` carries no tenant column by design: an identity is platform-level and
-- its tenancy is entirely expressed by the grants it holds (`TENANCY.md` §1).
-- "The users of this organization" is therefore a semi-join, and `GET /users`
-- runs it as `EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = users.id
-- AND ur.org_id = ?)`.
--
-- `user_roles_org_id_idx` alone would make that scan every grant in the
-- organization for each candidate user. Leading with `org_id` and carrying
-- `user_id` makes the probe index-only and bounded by the organization's own
-- membership.
CREATE INDEX IF NOT EXISTS "user_roles_org_user_id_idx"
  ON "user_roles" ("org_id", "user_id");--> statement-breakpoint

-- --- 2. The `users.reactivate` permission -------------------------------------
-- Seeded here rather than left to `seed.ts` alone so that an upgrade from the
-- previous HEAD is complete on its own. `seed.ts` upserts the same row from
-- `ALL_PERMISSION_KEYS`, so the two agree and running either order is safe.
INSERT INTO "permissions" ("key", "domain", "action", "description")
VALUES ('users.reactivate', 'users', 'reactivate', 'Restore a disabled user')
ON CONFLICT ("key") DO NOTHING;--> statement-breakpoint

-- --- 3. Attaching it to the roles that hold its counterpart --------------------
-- `fn_protect_system_role_permissions` (`0004`) refuses any edit to a system
-- role's permission set outside a provisioning or platform-admin transaction —
-- correctly, since that set *is* the definition of administration. This is the
-- schema owner performing a documented upgrade, and it declares itself exactly
-- as `seed.ts` and `TenantRoleProvisioner` do rather than the guard being
-- relaxed for it.
SELECT set_config('app.provisioning', 'on', true);--> statement-breakpoint

-- `alendei_super_admin` is defined as the whole catalogue, so a new permission
-- belongs to it by construction.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.id, p.id
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."org_id" IS NULL
  AND r."key" = 'alendei_super_admin'
  AND p."key" = 'users.reactivate'
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- Every seeded `org_admin`. An organization admin already holds `users.disable`;
-- withholding the ability to undo it would leave a tenant able to lock a
-- colleague out with no path back, which is a worse outcome than the marginal
-- authority the permission adds. It is granted to `org_admin` and to nothing
-- else: `workspace_manager`, `reseller_admin` and the rest hold neither half.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.id, p.id
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."org_id" IS NOT NULL
  AND r."is_system_role"
  AND r."key" = 'org_admin'
  AND p."key" = 'users.reactivate'
ON CONFLICT DO NOTHING;--> statement-breakpoint

SELECT set_config('app.provisioning', 'off', true);
