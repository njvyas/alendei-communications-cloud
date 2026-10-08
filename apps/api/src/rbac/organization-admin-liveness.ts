import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES, TENANT_ROLE_KEYS, type ScopeType } from '@acc/contracts';
import { ORG_ADMIN_LOCK_CLASS, type Transaction } from '@acc/db';
import { sql } from 'drizzle-orm';

import { AppException } from '../common/errors/app.exception';

/**
 * The last-organization-administrator invariant, service half (ADR-015 R-11,
 * D-MEDIUM-3b; `RBAC.md` §7c).
 *
 * **This is the message, not the guarantee** — exactly as for the platform
 * rule (§7a). `fn_assert_org_admin_remains` (migration `0028`) holds the
 * invariant for every writer; what this adds is a `409
 * AUTHZ_LAST_ORGANIZATION_ADMIN` a caller can act on instead of a
 * `restrict_violation` surfacing as a `500`, and the lock ordering ADR-005 D-7
 * describes (advisory lock first, row locks second). The trigger re-acquires
 * the same lock, which within one transaction is a no-op.
 *
 * The definition mirrors the trigger's exactly: an **active** user holding the
 * organization's seeded system role `org_admin` at `organization` scope on that
 * organization. The service counts under the request's RLS context, which can
 * only hide rows, never add them — so it refuses at least everything the
 * trigger would. On disable, `translateOrganizationAdminLiveness` maps the
 * trigger's refusal to the same `409` should it ever fire first (as the
 * platform rule's disable path does); revocation, like the platform rule's,
 * relies on the check, which runs under the lock before the delete.
 */

/** The constraint name `fn_assert_org_admin_remains` raises with. */
export const ORGANIZATION_ADMIN_LIVENESS_CONSTRAINT = 'organization_admin_liveness';

/** `restrict_violation`. */
const PG_RESTRICT_VIOLATION = '23001';

/** Is this grant one that counts towards its organization's administrators? */
export function isOrganizationAdministratorGrant(
  role: { readonly orgId: string | null; readonly key: string; readonly isSystemRole: boolean },
  grant: { readonly scopeType: ScopeType; readonly scopeId: string | null },
): boolean {
  return (
    grant.scopeType === 'organization' &&
    grant.scopeId !== null &&
    role.orgId === grant.scopeId &&
    role.key === TENANT_ROLE_KEYS.ORG_ADMIN &&
    role.isSystemRole
  );
}

/**
 * Takes the per-organization advisory locks, in ascending id order — the order
 * `fn_users_org_admin_guard` takes them — so two transactions locking several
 * organizations cannot deadlock on them. The expression is the trigger's own.
 */
export async function lockOrganizationAdministration(
  tx: Transaction,
  orgIds: readonly string[],
): Promise<void> {
  for (const orgId of [...new Set(orgIds)].sort()) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${ORG_ADMIN_LOCK_CLASS}::int4, hashtext(${orgId}::text))`,
    );
  }
}

/**
 * Refuses a removal that would leave `orgId` with no active administrator.
 * The caller has already taken the lock. `excluding` names what is being
 * removed: one grant (revocation) or every grant of one user (disable).
 *
 * A transition, not an absence — as the trigger: refused only when what is
 * removed is counted now **and** nothing counted remains. Removing a grant
 * held by a user who is not active, or any grant of an organization that has
 * never had an administrator, is not refused.
 */
export async function assertOrganizationAdminRemains(
  tx: Transaction,
  orgId: string,
  excluding: { readonly grantId: string } | { readonly userId: string },
): Promise<void> {
  const removed =
    'grantId' in excluding
      ? sql`ur.id = ${excluding.grantId}`
      : sql`ur.user_id = ${excluding.userId}`;
  const { rows } = await tx.execute<{ present: string; remaining: string }>(sql`
    SELECT count(*) AS present,
           count(*) FILTER (WHERE NOT (${removed})) AS remaining
      FROM user_roles ur
      JOIN users u ON u.id = ur.user_id
      JOIN roles r ON r.id = ur.role_id
     WHERE ur.scope_type = 'organization'
       AND ur.scope_id = ${orgId}
       AND r.org_id = ${orgId}
       AND r.key = ${TENANT_ROLE_KEYS.ORG_ADMIN}
       AND r.is_system_role
       AND u.status = 'active'
  `);
  const present = Number(rows[0]?.present ?? 0);
  const remaining = Number(rows[0]?.remaining ?? 0);
  if (present > remaining && remaining === 0) throw lastOrganizationAdmin();
}

export function lastOrganizationAdmin(): AppException {
  return new AppException({
    // `409`, not `403`: the actor was authorized and the request well-formed —
    // the organization may not enter that state, and the remedy is to appoint
    // another administrator first, not to acquire more authority.
    status: HttpStatus.CONFLICT,
    code: ERROR_CODES.AUTHZ_LAST_ORGANIZATION_ADMIN,
    message: 'This is the last active administrator of the organization; appoint another first',
  });
}

/** The trigger's refusal, rendered as the documented conflict; anything else unchanged. */
export function translateOrganizationAdminLiveness(error: unknown): unknown {
  const cause =
    (error as { cause?: { code?: string; constraint?: string } })?.cause ??
    (error as { code?: string; constraint?: string });
  if (
    cause?.code === PG_RESTRICT_VIOLATION &&
    cause.constraint === ORGANIZATION_ADMIN_LIVENESS_CONSTRAINT
  ) {
    return lastOrganizationAdmin();
  }
  return error;
}
