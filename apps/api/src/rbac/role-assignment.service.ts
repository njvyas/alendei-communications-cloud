import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  type AuthPrincipal,
  type PageInfo,
  type ScopeRef,
  type ScopeType,
} from '@acc/contracts';
import { PLATFORM_ADMIN_LOCK_KEY, schema, type Transaction } from '@acc/db';
import { and, eq, sql, type SQL } from 'drizzle-orm';

import { AppException } from '../common/errors/app.exception';
import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
import { ListQuery, type ListQueryInput, type ListQuerySpec } from '../common/http/list-query';

export interface AssignmentView {
  readonly id: string;
  readonly userId: string;
  readonly roleId: string;
  readonly roleKey: string;
  readonly orgId: string | null;
  readonly scopeType: ScopeType;
  readonly scopeId: string | null;
  readonly grantedBy: string | null;
  readonly createdAt: string;
}

export interface GrantInput {
  readonly userId: string;
  readonly roleId: string;
  readonly scopeType: ScopeType;
  readonly scopeId: string | null;
}

/**
 * Narrow, argued relaxations of `grant`'s guards. There is exactly one, and it
 * touches exactly one guard.
 */
export interface GrantOptions {
  /**
   * The target user was inserted by **this same transaction** (Phase 1B.6.1).
   *
   * Guard 5 establishes reachability the only honest way available for a table
   * RLS cannot scope: the target must already hold a grant this request can
   * see. A user created moments ago holds none — its first grant is the one
   * being made — so the probe would refuse every atomic create-and-grant, and
   * the alternative is a user administration service writing `user_roles`
   * itself, which is the duplication `RBAC.md` §8b exists to prevent.
   *
   * What this skips is the *probe*, not the property. Reachability is instead
   * established by construction: `UserAdministrationService` authorized
   * `users.invite` at its own organization and inserted the row in this
   * transaction, so the caller demonstrably reaches the target — it created
   * it. Guards 1-4 are untouched, and guard 1 still decides whether the actor
   * may grant at the named scope at all, which is the escalation-bearing half.
   *
   * It is not reachable from HTTP: `CreateAssignmentDto` has no such field, so
   * only an in-process caller can pass it, and `user-administration-boundary.spec.ts`
   * asserts which callers do.
   */
  readonly targetCreatedInThisTransaction?: boolean;
}

/** Allow-listed filters for `GET /role-assignments` (`API.md` §8b). */
export interface ListAssignmentsFilter extends ListQueryInput {
  readonly userId?: string;
  readonly scopeType?: ScopeType;
  readonly scopeId?: string;
}

/**
 * Role-assignment administration (Phase 1B.5.5, `RBAC.md` §§7-8b, `API.md` §3c).
 *
 * This is the highest-risk endpoint set in Phase 1B: it is the API that confers
 * privilege, so a gap here is not a bug in one feature, it is a general
 * escalation primitive. Five guards run in a fixed order, and the order is
 * load-bearing — each one is only meaningful once the previous has passed.
 *
 *   1. **The actor may grant here at all.** `role_assignments.grant` is checked
 *      against **the scope being granted at**, not the actor's resolved
 *      context. That is the whole of `RBAC.md` §7's "no granting at a scope you
 *      do not cover": an organization admin asking to grant inside its own
 *      organization passes; the same admin naming another organization's
 *      workspace does not, and gets `404` rather than a confirmation that the
 *      workspace exists.
 *
 *   2. **The role is real, visible and assignable.** Read under the request's
 *      own tenant context, so RLS has already removed another tenant's roles —
 *      an unreachable role is `404`, indistinguishable from one that does not
 *      exist.
 *
 *   3. **The role admits this scope level** — `roles.allowed_scope_types`,
 *      the column Phase 1B.5.4 added and this phase is the first to consult
 *      (§6n case 28). `org_admin` at `team` is refused even for an actor who
 *      could legitimately grant `org_admin` at the organization: the role was
 *      never designed to exist at that level, which is a different refusal from
 *      "you may not reach that scope" and carries its own code.
 *
 *   4. **Every permission the role carries is within the actor's own authority
 *      at that scope** (§6n cases 21 and 22). Asked through the boundary's
 *      `unheldPermissions`, which resolves the chain once — never against
 *      `principal.permissions`, whose flattening is exactly what ADR-005
 *      removed from the decision path. A permission the actor holds only in one
 *      workspace does not authorize conferring it across the organization.
 *
 *   5. **The target user is real and within reach.** Users are platform-level
 *      identities, so RLS cannot scope them; reachability is established by the
 *      user already holding a grant the actor can see, and a disabled user is
 *      refused outright.
 *
 * **Not here, deliberately:** the last-platform-admin invariant on revocation.
 * `API.md` §3c specifies `409` for it and `ROADMAP.md` assigns it to Phase
 * 1B.5.6 together with the advisory-lock trigger that makes it hold under
 * concurrency (ADR-005 D-7). Implementing the service half alone would be worse
 * than not implementing it: a check that looks like an invariant but loses
 * under concurrency invites exactly the trust it cannot support.
 */
@Injectable()
export class RoleAssignmentService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
    private readonly lists: ListQuery,
  ) {}

  /**
   * The assignments list's ordering contract (`API.md` §8b).
   *
   * `createdAt` descending by default: a grant list is read newest-first,
   * because the question an administrator brings to it is usually "what changed".
   * Tie-broken by `id`, a UUIDv7 — unique, and chronological in the same
   * direction as `createdAt`, so the two never disagree.
   */
  private readonly listSpec: ListQuerySpec = {
    sortable: {
      // Chronological ordering runs on `id`, not on `created_at`, and that is a
      // correctness requirement rather than an optimisation. A cursor is text,
      // and a `timestamptz` round-tripped through JavaScript loses the
      // database's sub-millisecond precision — so the boundary lands *before*
      // the row it was minted from, the keyset predicate re-selects that row,
      // and the same page repeats forever. `id` is a UUIDv7: chronological by
      // construction, and a string that round-trips exactly.
      createdAt: { column: schema.userRoles.id, encode: (row) => String(row.id) },
      scopeType: {
        column: schema.userRoles.scopeType,
        encode: (row) => String(row.scopeType),
      },
    },
    defaultSort: '-createdAt',
    tieBreaker: schema.userRoles.id,
  };

  /**
   * Assignments visible to the caller.
   *
   * Authorized at the caller's organization, then returned by RLS — the query
   * carries no tenant predicate of its own, so a forgotten filter cannot leak
   * another tenant's grants. Deliberately unpaginated and with only the three
   * filters `API.md` §3c names; the list conventions are Phase 1B.5.8's.
   */
  async list(
    tx: Transaction,
    principal: AuthPrincipal,
    filter: ListAssignmentsFilter = {},
  ): Promise<{ items: readonly AssignmentView[]; page: PageInfo }> {
    const orgId = this.requireOrg(principal);
    await this.authorization.assert(tx, {
      principal,
      permission: 'role_assignments.read',
      target: { scopeType: 'organization', scopeId: orgId },
      resourceType: 'Role assignment',
    });

    const resolved = this.lists.resolve(filter, this.listSpec);

    // Filters narrow; they never widen. The query still carries no tenant
    // predicate of its own — RLS is what scopes it, so a forgotten filter here
    // cannot leak another tenant's grants, and a supplied one cannot reach past
    // what RLS already allows.
    const predicates: SQL[] = [];
    if (filter.userId) predicates.push(eq(schema.userRoles.userId, filter.userId));
    if (filter.scopeType) predicates.push(eq(schema.userRoles.scopeType, filter.scopeType));
    if (filter.scopeId) predicates.push(eq(schema.userRoles.scopeId, filter.scopeId));
    if (resolved.after) predicates.push(resolved.after);

    const rows = await tx
      .select({
        id: schema.userRoles.id,
        userId: schema.userRoles.userId,
        roleId: schema.userRoles.roleId,
        roleKey: schema.roles.key,
        orgId: schema.userRoles.orgId,
        scopeType: schema.userRoles.scopeType,
        scopeId: schema.userRoles.scopeId,
        grantedBy: schema.userRoles.grantedBy,
        createdAt: schema.userRoles.createdAt,
      })
      .from(schema.userRoles)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
      .where(predicates.length > 0 ? and(...predicates) : undefined)
      .orderBy(...resolved.orderBy)
      .limit(this.lists.fetchSize(resolved));

    const { items, page } = this.lists.paginate(
      rows as unknown as Record<string, unknown>[],
      resolved,
      this.listSpec,
      (row) => String(row.id),
    );

    return { items: items.map((row) => this.view(row as never)), page };
  }

  async get(tx: Transaction, principal: AuthPrincipal, id: string): Promise<AssignmentView> {
    const orgId = this.requireOrg(principal);
    await this.authorization.assert(tx, {
      principal,
      permission: 'role_assignments.read',
      target: { scopeType: 'organization', scopeId: orgId },
      resourceType: 'Role assignment',
    });

    return this.view(await this.loadVisible(tx, id));
  }

  /**
   * Grants a role at a scope.
   *
   * One transaction, and the guards run inside it, so everything they read —
   * the role, its permissions, the scope chain — is the state the INSERT
   * commits against. The audit row is written in the same transaction, so a
   * failed audit takes the grant with it (`SECURITY.md` §4).
   */
  /**
   * Guard 1 of `grant`, exposed so the idempotent replay path performs the same
   * check against the same target.
   *
   * A replay must satisfy current authorization, and it does not run `grant`.
   * Writing the check again at the call site would put a second definition of
   * "may this actor grant here" in the codebase, which is the drift ADR-005 D-1
   * exists to prevent.
   */
  async assertMayGrant(tx: Transaction, principal: AuthPrincipal, target: ScopeRef): Promise<void> {
    this.requireOrg(principal);
    await this.authorization.assert(tx, {
      principal,
      permission: 'role_assignments.grant',
      target,
      resourceType: 'Scope',
    });
  }

  async grant(
    tx: Transaction,
    principal: AuthPrincipal,
    input: GrantInput,
    options: GrantOptions = {},
  ): Promise<AssignmentView> {
    this.requireOrg(principal);
    const target: ScopeRef = { scopeType: input.scopeType, scopeId: input.scopeId };

    // Guard 1 — may the actor grant *here*. The target is the scope being
    // granted at, which is what makes non-escalation enforceable at all.
    await this.authorization.assert(tx, {
      principal,
      permission: 'role_assignments.grant',
      target,
      resourceType: 'Scope',
    });

    // Guard 2 — a real, visible, assignable role.
    const role = await this.loadAssignableRole(tx, input.roleId);

    // Guard 3 — §6n case 28.
    this.assertScopeTypeAdmitted(role, input.scopeType);

    // Guard 4 — §6n cases 21 and 22. One chain resolve, not one per permission.
    await this.assertWithinActorAuthority(tx, principal, role.id, target);

    // Guard 5 — a real, reachable, active target user. Skipped only for a user
    // this transaction created, whose reachability is established by
    // construction rather than by a probe that cannot yet succeed (see
    // `GrantOptions`).
    if (!options.targetCreatedInThisTransaction) {
      await this.assertAssignableUser(tx, input.userId);
    }

    const inserted = await this.insertGrant(tx, principal, input);

    await this.audit.record(
      {
        // The scope the grant was made at: for a privilege change, where the
        // privilege now applies is the truthful statement of where it happened.
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        ...actorFromPrincipal(principal),
        action: AUDIT_ACTIONS.USER_ROLE_GRANTED,
        resourceType: 'RoleAssignment',
        resourceId: inserted.id,
        outcome: 'success',
        before: null,
        after: {
          userId: input.userId,
          roleId: input.roleId,
          roleKey: role.key,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
        },
        metadata: { roleKey: role.key, grantedTo: input.userId },
      },
      tx,
    );

    return this.view({ ...inserted, roleKey: role.key });
  }

  /**
   * Revokes one assignment.
   *
   * Authorized at **the grant's own scope**, read from the stored row rather
   * than from anything the caller said — so revoking a grant inside a workspace
   * the actor does not cover is refused even though the actor can see it listed
   * at the organization.
   */
  async revoke(tx: Transaction, principal: AuthPrincipal, id: string): Promise<void> {
    this.requireOrg(principal);
    const assignment = await this.loadVisible(tx, id);

    await this.authorization.assert(tx, {
      principal,
      permission: 'role_assignments.revoke',
      target: { scopeType: assignment.scopeType, scopeId: assignment.scopeId },
      resourceType: 'Role assignment',
    });

    // The last-platform-admin invariant (ADR-005 D-7). Only for a platform
    // grant: every other revocation takes no lock and runs no count.
    if (assignment.scopeType === 'platform') {
      await this.assertPlatformAdminRemains(tx, assignment.id);
    }

    // Conditional delete rather than a read-then-delete: two concurrent
    // revocations of the same assignment must not both report success, and the
    // row lock is what decides which one did the work.
    const deleted = await tx
      .delete(schema.userRoles)
      .where(eq(schema.userRoles.id, id))
      .returning({ id: schema.userRoles.id });

    if (deleted.length === 0) {
      // The other revocation won. Reporting `404` is honest — the assignment is
      // gone — and matches `API.md` §3c's "404 if already gone".
      throw new AppException({
        status: HttpStatus.NOT_FOUND,
        code: ERROR_CODES.RESOURCE_NOT_FOUND,
        message: 'Role assignment not found',
        logContext: { requestedAssignmentId: id },
      });
    }

    await this.audit.record(
      {
        scopeType: assignment.scopeType,
        scopeId: assignment.scopeId,
        ...actorFromPrincipal(principal),
        action: AUDIT_ACTIONS.USER_ROLE_REVOKED,
        resourceType: 'RoleAssignment',
        resourceId: id,
        outcome: 'success',
        before: {
          userId: assignment.userId,
          roleId: assignment.roleId,
          roleKey: assignment.roleKey,
          scopeType: assignment.scopeType,
          scopeId: assignment.scopeId,
        },
        after: null,
        metadata: { roleKey: assignment.roleKey, revokedFrom: assignment.userId },
      },
      tx,
    );
  }

  // --- guards ---------------------------------------------------------------

  private requireOrg(principal: AuthPrincipal): string {
    const orgId = principal.tenant.orgId;
    if (!orgId) {
      throw new AppException({
        status: HttpStatus.BAD_REQUEST,
        code: ERROR_CODES.TENANCY_CONTEXT_REQUIRED,
        message: 'No organization context is established for this request',
      });
    }
    return orgId;
  }

  /**
   * A role the caller may grant.
   *
   * Platform roles are refused here rather than left to
   * `fn_validate_user_role_scope`: the trigger admits them for an actor already
   * holding platform admin, and this surface is tenant administration. A tenant
   * principal must not be able to use role assignment to manufacture platform
   * privilege, and refusing at the service keeps that a `403` with a reason
   * rather than a constraint error.
   */
  private async loadAssignableRole(
    tx: Transaction,
    roleId: string,
  ): Promise<typeof schema.roles.$inferSelect> {
    const [role] = await tx.select().from(schema.roles).where(eq(schema.roles.id, roleId));

    if (!role) {
      // RLS has already removed another tenant's roles, so an unreachable role
      // and a nonexistent one are the same answer.
      throw new AppException({
        status: HttpStatus.NOT_FOUND,
        code: ERROR_CODES.RESOURCE_NOT_FOUND,
        message: 'Role not found',
        logContext: { requestedRoleId: roleId },
      });
    }

    if (role.orgId === null) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_PLATFORM_ROLE_REQUIRED,
        message: 'Platform-level roles cannot be granted through tenant administration',
        logContext: { roleKey: role.key },
      });
    }

    return role;
  }

  /** §6n case 28. `RBAC.md` §7's "no grant at a scope level the role was never designed for". */
  private assertScopeTypeAdmitted(
    role: typeof schema.roles.$inferSelect,
    scopeType: ScopeType,
  ): void {
    const admitted = role.allowedScopeTypes as readonly ScopeType[];
    if (admitted.includes(scopeType)) return;

    throw new AppException({
      // `422`, not `403` (`API.md` §3c): the actor was entitled and the request
      // well-formed — the role simply does not exist at this level. Collapsing
      // it into `403` would tell an administrator it lacked authority it
      // actually has.
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: ERROR_CODES.AUTHZ_SCOPE_TYPE_NOT_ADMITTED,
      message: `This role cannot be granted at ${scopeType} scope`,
      // The role's own design, which the caller can already read from `/roles`.
      details: { roleKey: role.key, allowedScopeTypes: admitted, requested: scopeType },
    });
  }

  /**
   * §6n cases 21 and 22 — no conferring a `(permission, scope)` pair the actor
   * does not itself hold.
   *
   * Two queries regardless of how many permissions the role carries: one for the
   * role's permission set, one inside `unheldPermissions` for the scope chain.
   * The evaluator then decides each permission in memory against the same
   * coherent-grant rule every other decision uses.
   */
  private async assertWithinActorAuthority(
    tx: Transaction,
    principal: AuthPrincipal,
    roleId: string,
    target: ScopeRef,
  ): Promise<void> {
    const carried = await tx
      .select({ key: schema.permissions.key })
      .from(schema.rolePermissions)
      .innerJoin(schema.permissions, eq(schema.permissions.id, schema.rolePermissions.permissionId))
      .where(eq(schema.rolePermissions.roleId, roleId));

    const unheld = await this.authorization.unheldPermissions(tx, {
      principal,
      permissions: carried.map((row) => row.key),
      target,
    });

    if (unheld.length > 0) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_CANNOT_GRANT_UNHELD_PERMISSION,
        message: 'This role carries a permission you do not hold at that scope',
        // The role's composition is readable through `/roles`, so naming the
        // offending permissions discloses nothing new and is what makes the
        // refusal actionable.
        details: { rejected: [...unheld] },
      });
    }
  }

  /**
   * A target user that exists, is active, and is reachable by the actor.
   *
   * `users` is a platform-level table with no tenant column, so RLS cannot scope
   * it and an id alone would be an enumeration oracle. Reachability is
   * established the only honest way available: the user must already hold at
   * least one grant that RLS lets this request see. A user in another tenant has
   * none visible here, so it is `404` — the same answer as an id that does not
   * exist.
   */
  private async assertAssignableUser(tx: Transaction, userId: string): Promise<void> {
    const [visible] = await tx
      .select({ status: schema.users.status })
      .from(schema.users)
      .innerJoin(schema.userRoles, eq(schema.userRoles.userId, schema.users.id))
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (!visible) {
      throw new AppException({
        status: HttpStatus.NOT_FOUND,
        code: ERROR_CODES.RESOURCE_NOT_FOUND,
        message: 'User not found',
        logContext: { requestedUserId: userId },
      });
    }

    if (visible.status === 'disabled') {
      throw new AppException({
        status: HttpStatus.CONFLICT,
        code: ERROR_CODES.RESOURCE_CONFLICT,
        message: 'A disabled user cannot be granted a role',
      });
    }
  }

  /**
   * Refuses a revocation that would leave the platform with no active
   * administrator (ADR-005 D-7).
   *
   * **This is the message, not the guarantee.** `fn_assert_platform_admin_remains`
   * (migration `0005`) is what actually holds the invariant, including against a
   * migration script or an admin tool that never reaches this service. What this
   * adds is a clean `409` with a code the caller can act on, instead of a
   * `restrict_violation` surfacing as a generic `500`.
   *
   * **Why the lock is taken here and not left to the trigger.** Both take the
   * same key, so either alone would serialise correctly. Taking it *before* the
   * DELETE gives this path the lock ordering ADR-005 D-7 describes — advisory
   * lock first, row locks second — which is what keeps it free of any cycle with
   * a concurrent revocation that has already locked a row this transaction will
   * need. The trigger then re-acquires the same key, which within one
   * transaction is a no-op.
   *
   * The count deliberately mirrors the trigger's exactly: an active user holding
   * a grant at `platform` scope. It is the authorization model's own definition
   * of a platform administrator — `ScopeResolver` derives `isPlatformAdmin` as
   * "holds some grant at platform scope" — and not a second notion invented for
   * this check, which would drift.
   */
  private async assertPlatformAdminRemains(tx: Transaction, excludingId: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(${PLATFORM_ADMIN_LOCK_KEY})`);

    const { rows } = await tx.execute<{ remaining: string }>(sql`
      SELECT count(*) AS remaining
      FROM user_roles ur
      JOIN users u ON u.id = ur.user_id
      WHERE ur.scope_type = 'platform'
        AND u.status = 'active'
        AND ur.id <> ${excludingId}
    `);

    if (Number(rows[0]?.remaining ?? 0) === 0) {
      throw new AppException({
        // `409`, not `403`: the actor was authorized and the request
        // well-formed — the platform may simply not enter that state, and the
        // remedy is to appoint another administrator first, not to acquire more
        // authority.
        status: HttpStatus.CONFLICT,
        code: ERROR_CODES.AUTHZ_LAST_PLATFORM_ADMIN,
        message:
          'This is the last active platform administrator; appoint another before revoking it',
      });
    }
  }

  // --- reads and writes ------------------------------------------------------

  private async loadVisible(
    tx: Transaction,
    id: string,
  ): Promise<AssignmentView & { scopeType: ScopeType }> {
    const [row] = await tx
      .select({
        id: schema.userRoles.id,
        userId: schema.userRoles.userId,
        roleId: schema.userRoles.roleId,
        roleKey: schema.roles.key,
        orgId: schema.userRoles.orgId,
        scopeType: schema.userRoles.scopeType,
        scopeId: schema.userRoles.scopeId,
        grantedBy: schema.userRoles.grantedBy,
        createdAt: schema.userRoles.createdAt,
      })
      .from(schema.userRoles)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
      .where(eq(schema.userRoles.id, id));

    if (!row) {
      throw new AppException({
        status: HttpStatus.NOT_FOUND,
        code: ERROR_CODES.RESOURCE_NOT_FOUND,
        message: 'Role assignment not found',
        logContext: { requestedAssignmentId: id },
      });
    }
    return this.view(row);
  }

  /**
   * Inserts the grant, letting the database settle the duplicate race.
   *
   * `user_roles_unique_scoped_grant` / `user_roles_unique_platform_grant` are
   * what decide it (§6n case 29): two concurrent identical grants both pass
   * every service check, and exactly one insert survives. Checking first and
   * inserting second would leave a window between the two, so the conflict is
   * *caused* and then translated rather than predicted.
   *
   * `org_id` is deliberately not supplied — `fn_validate_user_role_scope`
   * derives it from the resolved scope, so it cannot be forged by this writer
   * any more than by any other.
   */
  private async insertGrant(
    tx: Transaction,
    principal: AuthPrincipal,
    input: GrantInput,
  ): Promise<Omit<AssignmentView, 'roleKey'>> {
    const [row] = await tx
      .insert(schema.userRoles)
      .values({
        userId: input.userId,
        roleId: input.roleId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        grantedBy: principal.userId,
      })
      .onConflictDoNothing()
      .returning({
        id: schema.userRoles.id,
        userId: schema.userRoles.userId,
        roleId: schema.userRoles.roleId,
        orgId: schema.userRoles.orgId,
        scopeType: schema.userRoles.scopeType,
        scopeId: schema.userRoles.scopeId,
        grantedBy: schema.userRoles.grantedBy,
        createdAt: schema.userRoles.createdAt,
      });

    if (!row) {
      throw new AppException({
        status: HttpStatus.CONFLICT,
        code: ERROR_CODES.RESOURCE_CONFLICT,
        message: 'This user already holds that role at that scope',
      });
    }

    return {
      id: row.id,
      userId: row.userId,
      roleId: row.roleId,
      orgId: row.orgId,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      grantedBy: row.grantedBy,
      createdAt: row.createdAt.toISOString(),
    } as Omit<AssignmentView, 'roleKey'>;
  }

  private view(row: {
    id: string;
    userId: string;
    roleId: string;
    roleKey: string;
    orgId: string | null;
    scopeType: ScopeType;
    scopeId: string | null;
    grantedBy: string | null;
    createdAt: Date | string;
  }): AssignmentView & { scopeType: ScopeType } {
    return {
      id: row.id,
      userId: row.userId,
      roleId: row.roleId,
      roleKey: row.roleKey,
      orgId: row.orgId,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      grantedBy: row.grantedBy,
      createdAt:
        row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    };
  }
}
