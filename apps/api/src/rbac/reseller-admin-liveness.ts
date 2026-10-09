import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES, PLATFORM_ROLE_KEYS, type ScopeType } from '@acc/contracts';
import { RESELLER_ADMIN_LOCK_CLASS, type Transaction } from '@acc/db';
import { sql } from 'drizzle-orm';

import { AppException } from '../common/errors/app.exception';

/**
 * The last-reseller-administrator invariant, service half (ADR-015 follow-up
 * item 4; `RBAC.md` §7d; migration `0030`) — the reseller counterpart of
 * `organization-admin-liveness.ts`.
 *
 * **The database is the guarantee.** `fn_assert_reseller_admin_remains`
 * (migration `0030`) holds the invariant for every writer. What this adds is
 * the lock ordering ADR-005 D-7 describes (advisory lock first, row locks
 * second), a `409 AUTHZ_LAST_RESELLER_ADMIN` decided before anything is
 * written whenever the service can decide it, and the translation of the
 * trigger's `restrict_violation` to the same `409` whenever it cannot.
 *
 * **Why the service may be unable to decide (RLS).** The count runs under the
 * request's RLS context. A reseller principal sees every reseller-scope grant
 * of its own reseller (`user_roles_tenant`: `scope_id = app_current_reseller_id()`)
 * and every platform role (`roles_select`), but **not** every peer's `users`
 * row: `users_select` admits a user only through a grant in an organization
 * in reach, so a peer holding nothing but a reseller grant is invisible, and
 * its status unknown. Counting only what is visible could refuse a removal
 * the database would allow (the last *visible* administrator, with an
 * invisible active peer). So the count refuses **only when no qualifying
 * grant's holder is hidden** — then it is exact — and otherwise defers to the
 * trigger, which decides under the same lock with full visibility. It never
 * refuses what the database would allow; RLS is not widened and no second
 * authorization path exists. Visibility of the grants themselves is
 * all-or-nothing per reseller (the policy arm depends on `scope_id` alone),
 * so a hidden grant cannot shrink the count.
 */

/** The constraint name `fn_assert_reseller_admin_remains` raises with. */
export const RESELLER_ADMIN_LIVENESS_CONSTRAINT = 'reseller_admin_liveness';

/** `restrict_violation`. */
const PG_RESTRICT_VIOLATION = '23001';

/** Is this grant one that counts towards its reseller's administrators? */
export function isResellerAdministratorGrant(
  role: { readonly orgId: string | null; readonly key: string; readonly isSystemRole: boolean },
  grant: { readonly scopeType: ScopeType; readonly scopeId: string | null },
): boolean {
  return (
    grant.scopeType === 'reseller' &&
    grant.scopeId !== null &&
    role.orgId === null &&
    role.key === PLATFORM_ROLE_KEYS.RESELLER_ADMIN &&
    role.isSystemRole
  );
}

/**
 * Takes the per-reseller advisory locks, in ascending id order — the order
 * `fn_users_reseller_admin_guard` takes them. Callers that also take
 * organization or platform liveness locks take those first (organization →
 * platform → reseller, the order the triggers fire in).
 */
export async function lockResellerAdministration(
  tx: Transaction,
  resellerIds: readonly string[],
): Promise<void> {
  for (const resellerId of [...new Set(resellerIds)].sort()) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${RESELLER_ADMIN_LOCK_CLASS}::int4, hashtext(${resellerId}::text))`,
    );
  }
}

/**
 * Refuses a removal that would leave `resellerId` with no active
 * administrator — when, and only when, the request can see every holder.
 * The caller has already taken the lock. `excluding` names what is being
 * removed: one grant (revocation) or every grant of one user (disable).
 *
 * A transition, not an absence: refused only when what is removed is counted
 * now **and** nothing counted remains. If any qualifying grant's holder is
 * hidden by RLS, nothing is decided here: the write proceeds under the lock
 * and the trigger decides (`translateResellerAdminLiveness` renders its
 * refusal).
 */
export async function assertResellerAdminRemains(
  tx: Transaction,
  resellerId: string,
  excluding: { readonly grantId: string } | { readonly userId: string },
): Promise<void> {
  const removed =
    'grantId' in excluding
      ? sql`ur.id = ${excluding.grantId}`
      : sql`ur.user_id = ${excluding.userId}`;
  const { rows } = await tx.execute<{ hidden: string; present: string; remaining: string }>(sql`
    SELECT count(*) FILTER (WHERE u.id IS NULL) AS hidden,
           count(*) FILTER (WHERE u.status = 'active') AS present,
           count(*) FILTER (WHERE u.status = 'active' AND NOT (${removed})) AS remaining
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      LEFT JOIN users u ON u.id = ur.user_id
     WHERE ur.scope_type = 'reseller'
       AND ur.scope_id = ${resellerId}
       AND r.org_id IS NULL
       AND r.key = ${PLATFORM_ROLE_KEYS.RESELLER_ADMIN}
       AND r.is_system_role
  `);
  const hidden = Number(rows[0]?.hidden ?? 0);
  const present = Number(rows[0]?.present ?? 0);
  const remaining = Number(rows[0]?.remaining ?? 0);
  if (hidden > 0) return;
  if (present > remaining && remaining === 0) throw lastResellerAdmin();
}

export function lastResellerAdmin(): AppException {
  return new AppException({
    // `409`, not `403`: the actor was authorized and the request well-formed —
    // the reseller may not enter that state, and the remedy is to appoint
    // another administrator first, not to acquire more authority.
    status: HttpStatus.CONFLICT,
    code: ERROR_CODES.AUTHZ_LAST_RESELLER_ADMIN,
    message: 'This is the last active administrator of the reseller; appoint another first',
  });
}

/** The trigger's refusal, rendered as the documented conflict; anything else unchanged. */
export function translateResellerAdminLiveness(error: unknown): unknown {
  const cause =
    (error as { cause?: { code?: string; constraint?: string } })?.cause ??
    (error as { code?: string; constraint?: string });
  if (
    cause?.code === PG_RESTRICT_VIOLATION &&
    cause.constraint === RESELLER_ADMIN_LIVENESS_CONSTRAINT
  ) {
    return lastResellerAdmin();
  }
  return error;
}
