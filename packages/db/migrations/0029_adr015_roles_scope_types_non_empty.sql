-- =============================================================================
-- ADR-015 follow-up (item 2, approved 08-Oct-2026) — a role's allowed scope-type
-- set is never empty (DATABASE.md §2; RBAC.md §1; DECISIONS.md §1o)
--
-- Migration 0004 created roles_allowed_scope_types_non_empty as
--   CHECK (array_length(allowed_scope_types, 1) >= 1)
-- array_length('{}', 1) is NULL, and a CHECK passes on NULL, so the constraint
-- admitted the empty array it was written to refuse. An empty set also made
-- the R-5 eligibility rule of migration 0026 (role scopes ⊆ permission scopes,
-- fn_validate_role_permission) hold vacuously, so a role row with '{}' could
-- carry any permission — tenant-content keys on a platform role included —
-- although no grant of it was possible (user_roles_scope_type_admitted).
--
-- This migration replaces the expression with the cardinality form migration
-- 0026 already uses for permissions_allowed_scope_types_non_empty, under the
-- SAME constraint name, so every reference to the name stays valid. Nothing
-- else changes: no other constraint, column, trigger, function, policy or
-- grant. Roles carrying zero permissions remain legal — this concerns the
-- scope-type array only. The API already refuses an empty array (role.dto.ts,
-- ArrayMinSize(1)); this is the database backstop for every writer.
--
-- Rerun-safe: the verification block reads only; DROP CONSTRAINT IF EXISTS
-- precedes ADD CONSTRAINT. The verification block refuses the migration —
-- nothing applied — naming the offending role ids if any existing role has an
-- empty set; such a row must be repaired or removed by a deliberate,
-- reviewed change, never by this migration. Adding the constraint re-checks
-- every row in any case.
-- =============================================================================

DO $$
DECLARE
  v_count  bigint;
  v_sample text;
BEGIN
  SELECT count(*), string_agg(id::text, ', ') INTO v_count, v_sample FROM (
    SELECT r.id FROM roles r
     WHERE cardinality(r.allowed_scope_types) = 0
     ORDER BY r.id) s;
  IF v_count > 0 THEN
    RAISE EXCEPTION
      'migration 0029 verification failed [roles_allowed_scope_types_non_empty]: % roles with an empty allowed_scope_types (ids: %)', v_count, v_sample
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_allowed_scope_types_non_empty;
--> statement-breakpoint
ALTER TABLE roles ADD CONSTRAINT roles_allowed_scope_types_non_empty
  CHECK (cardinality(allowed_scope_types) >= 1);
