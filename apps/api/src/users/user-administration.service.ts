import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  PERMISSIONS,
  PLATFORM_ROLE_KEYS,
  TENANT_ROLE_KEYS,
  type AuthPrincipal,
  type PageInfo,
  type ScopeType,
} from '@acc/contracts';
import { PLATFORM_ADMIN_LOCK_KEY, schema, type Transaction } from '@acc/db';
import { and, eq, exists, isNull, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';

import { AppException } from '../common/errors/app.exception';
import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
import { ListQuery, type ListQueryInput, type ListQuerySpec } from '../common/http/list-query';
import { SessionService } from '../iam/session.service';
import { ScopeResolver } from '../auth/scope-resolver.service';
import { TenantDatabase } from '../database/tenant-database.service';
import {
  assertOrganizationAdminRemains,
  lockOrganizationAdministration,
  translateOrganizationAdminLiveness,
} from '../rbac/organization-admin-liveness';
import { RoleAssignmentService } from '../rbac/role-assignment.service';
import type { UserStatus } from './user.dto';

/**
 * The user as the control plane presents it.
 *
 * What is absent is the specification, not an omission: no `passwordHash`, no
 * `passwordUpdatedAt`, no `mfaSecretRef`, no `mfaEnabled`, no session or token
 * material, no API-key anything. `password_hash` and `mfa_secret_ref` are
 * credential material (`SECURITY.md` §1) and never leave the database;
 * `mfa_enabled` is withheld because MFA is not implemented at all (`RBAC.md`
 * §5) and publishing the flag would imply a shipped control.
 *
 * Role assignments are **not** embedded. They are their own resource with their
 * own read model, filterable by user (`GET /role-assignments?userId=`), and
 * copying them in here would be a second representation of authorization to
 * keep in step with the first (`API.md` §3c).
 */
export interface UserView {
  readonly id: string;
  readonly email: string;
  readonly phone: string | null;
  readonly status: UserStatus;
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One of another user's live sessions — the same shape as `GET /auth/sessions`. */
export interface AdminSessionView {
  readonly id: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly current: boolean;
}

export interface CreateUserInput {
  readonly email: string;
  readonly phone?: string | null;
  readonly initialRole: {
    readonly roleId: string;
    readonly scopeType: ScopeType;
    readonly scopeId: string;
  };
}

export interface UpdateUserInput {
  /** Present only when the caller supplied it; `null` clears the number. */
  readonly phone?: string | null;
}

/** Allow-listed filters for `GET /users` (`API.md` §8b). */
export interface ListUsersFilter extends ListQueryInput {
  readonly status?: UserStatus;
  readonly email?: string;
}

/** `restrict_violation` — what `fn_assert_platform_admin_remains` raises. */
const PG_RESTRICT_VIOLATION = '23001';
/** `unique_violation` — what `users_email_key` raises. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * User administration (Phase 1B.6.1, `API.md` §3d, `RBAC.md` §§5a.1, 8c).
 *
 * ---
 *
 * **The lifecycle is the one that already existed.** `users.status` has carried
 * `invited | active | disabled` since migration `0000`, and
 * `users_active_requires_credential` makes the states mean something: an
 * `active` user holds a password or an MFA secret, so there is no state in which
 * a user is both usable and credential-less. This phase exposes that model; it
 * does not add to it.
 *
 *     invited  ──(credential set out of band)──▶  active  ──disable()──▶  disabled
 *        ▲                                          ▲                        │
 *        └────────── reactivate() ──────────────────┴────────────────────────┘
 *
 * `reactivate` returns a user to `active` when a credential survives, and to
 * `invited` when none does — the state they were in before, and the only other
 * one the CHECK admits. Silently leaving them disabled, or refusing outright,
 * would make a disabled credential-less user permanently unrecoverable.
 *
 * **There is no delete, and that is structural rather than a policy.** `acc_app`
 * holds no `DELETE` grant on `users` (migration `0000`), so the application role
 * cannot perform one however the service is written. It is also the right
 * answer: users are referenced by `sessions`, `api_keys.created_by`,
 * `user_roles`, `idempotency_keys.actor_user_id` and `audit_logs.actor_user_id`,
 * and an audit trail must outlive the identity it describes.
 *
 * ---
 *
 * **Tenancy, for a table that has none.** `users` carries no organization
 * column: an identity is platform-level and its tenancy is entirely the grants
 * it holds (`TENANCY.md` §1). Every read here is therefore narrowed by an
 * explicit membership predicate — *holds at least one grant in the request's
 * organization* — beneath which `users_select` RLS still applies. The two are
 * not redundant: RLS admits any user reachable through any organization in
 * scope, which for a reseller admin is a wider set than the organization the
 * request selected, and a user list that widened with the reader's other
 * memberships would be wrong.
 *
 * **Authorization is asked, never inferred.** Every method calls
 * `AuthorizationService.assert` inside the caller's transaction against the
 * request's own organization. Nothing here reads `principal.permissions`, and
 * nothing compares organization ids to decide access.
 *
 * **Privilege is not administered here.** Role assignment stays owned by
 * `RoleAssignmentService`, including the one place this service needs it — the
 * initial grant at creation, which runs through `grant()` with all five guards
 * and only its reachability *probe* relaxed (see `GrantOptions`).
 */
@Injectable()
export class UserAdministrationService {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly assignments: RoleAssignmentService,
    private readonly sessions: SessionService,
    private readonly audit: AuditWriter,
    private readonly lists: ListQuery,
    private readonly db: TenantDatabase,
    private readonly scopes: ScopeResolver,
  ) {}

  /**
   * The user list's ordering contract (`API.md` §8b).
   *
   * `-createdAt` by default: the question an administrator brings to a user list
   * is usually "who was added", and newest-first answers it without paging.
   * `email` is offered because it is how one looks for a known person, and
   * `status` because it is how one finds the disabled.
   *
   * Chronological ordering runs on `id`, not on `created_at`, for the reason
   * every other list here does: a cursor is text, and a `timestamptz`
   * round-tripped through JavaScript loses the database's sub-millisecond
   * precision, so the boundary lands *before* the row it was minted from and the
   * page repeats forever. `id` is a UUIDv7 — chronological by construction and a
   * string that round-trips exactly.
   */
  private readonly listSpec: ListQuerySpec = {
    sortable: {
      createdAt: { column: schema.users.id, encode: (row) => String(row.id) },
      email: { column: schema.users.email, encode: (row) => String(row.email) },
      status: { column: schema.users.status, encode: (row) => String(row.status) },
    },
    defaultSort: '-createdAt',
    tieBreaker: schema.users.id,
  };

  // --- reads -----------------------------------------------------------------

  async list(
    tx: Transaction,
    principal: AuthPrincipal,
    filter: ListUsersFilter = {},
  ): Promise<{ items: readonly UserView[]; page: PageInfo }> {
    const orgId = this.requireOrg(principal);
    await this.authorization.assert(tx, {
      principal,
      permission: 'users.read',
      target: { scopeType: 'organization', scopeId: orgId },
      resourceType: 'User',
    });

    const resolved = this.lists.resolve(filter, this.listSpec);

    // Membership first, then the caller's filters. Filters narrow; they never
    // widen — each one is applied inside what membership and RLS already allow,
    // so an `email` naming someone in another tenant matches nothing rather than
    // reaching them.
    const predicates: SQL[] = [this.memberOf(orgId)];
    if (filter.status) predicates.push(eq(schema.users.status, filter.status));
    if (filter.email) {
      predicates.push(sql`lower(${schema.users.email}) = lower(${filter.email})`);
    }
    if (resolved.after) predicates.push(resolved.after);

    const rows = await tx
      .select(this.columns())
      .from(schema.users)
      .where(and(...predicates))
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

  async get(tx: Transaction, principal: AuthPrincipal, id: string): Promise<UserView> {
    const orgId = this.requireOrg(principal);
    await this.authorization.assert(tx, {
      principal,
      permission: 'users.read',
      target: { scopeType: 'organization', scopeId: orgId },
      resourceType: 'User',
    });

    return this.view(await this.loadMember(tx, orgId, id));
  }

  // --- creation ---------------------------------------------------------------

  /**
   * The check `create` performs before it does anything, exposed so the
   * idempotent replay path runs the same one against the same target.
   *
   * A replay does not run `create`, so without this a stored response would be
   * handed back on the strength of a decision made during the original request.
   * Written once and called from both, so "may this actor create users here"
   * has one definition.
   */
  async assertMayCreate(tx: Transaction, principal: AuthPrincipal): Promise<void> {
    const orgId = this.requireOrg(principal);
    await this.authorization.assert(tx, {
      principal,
      permission: 'users.invite',
      target: { scopeType: 'organization', scopeId: orgId },
      resourceType: 'User',
    });
  }

  /**
   * Creates an identity and its first grant, atomically.
   *
   * **No credential is set, accepted or returned.** The user is created
   * `invited`, which by `users_active_requires_credential` is precisely the
   * state that cannot authenticate. How an invited user comes to hold a
   * credential is `DECISIONS.md` D16 and is still undecided: it needs either an
   * invitation token delivered out of band or an administrator-set password, and
   * neither a token table nor a mail transport exists. This endpoint therefore
   * takes no password, returns no password, mints no temporary credential and
   * sends no invitation — inventing any of those would be the unsafe workaround
   * the decision exists to prevent.
   *
   * **The order of operations is forced by RLS, not chosen.** `INSERT …
   * RETURNING` applies the `users_select` policy to the new row, and a user with
   * no grant yet satisfies none of its three arms — so the id is generated here,
   * the insert returns nothing, the grant is made, and only then is the row read
   * back. That read-back is also the proof: if it comes up empty the user is not
   * reachable and the transaction has no business committing.
   */
  async create(
    tx: Transaction,
    principal: AuthPrincipal,
    input: CreateUserInput,
  ): Promise<UserView> {
    const orgId = this.requireOrg(principal);
    await this.authorization.assert(tx, {
      principal,
      // The target is the request's own organization. Creating an identity is an
      // organization-level act — a `users` row belongs to no workspace — and the
      // narrower question, whether this actor may confer *that role at that
      // scope*, is answered separately and authoritatively by the grant below.
      permission: 'users.invite',
      target: { scopeType: 'organization', scopeId: orgId },
      resourceType: 'User',
    });

    const userId = uuidv7();
    await this.insertIdentity(tx, userId, input);

    // Role assignment stays owned by `RoleAssignmentService` (`RBAC.md` §8b).
    // Guards 1-4 run unchanged — in particular guard 1, which decides whether
    // this actor may grant at the named scope at all, and guard 4, which refuses
    // a role carrying a permission the actor does not itself hold there. Only
    // guard 5's reachability probe is skipped, because the user this transaction
    // just created cannot yet hold the visible grant it looks for.
    await this.assignments.grant(
      tx,
      principal,
      {
        userId,
        roleId: input.initialRole.roleId,
        scopeType: input.initialRole.scopeType,
        scopeId: input.initialRole.scopeId,
      },
      { targetCreatedInThisTransaction: true },
    );

    const created = await this.loadMember(tx, orgId, userId);

    await this.audit.record(
      {
        scopeType: 'organization',
        scopeId: orgId,
        ...actorFromPrincipal(principal),
        action: AUDIT_ACTIONS.USER_INVITED,
        resourceType: 'User',
        resourceId: userId,
        outcome: 'success',
        before: null,
        // Identity and lifecycle state only. No credential material exists to
        // record — none was supplied and none was generated.
        after: { email: created.email, status: created.status },
        metadata: {
          initialRoleId: input.initialRole.roleId,
          initialScopeType: input.initialRole.scopeType,
        },
      },
      tx,
    );

    return this.view(created);
  }

  // --- profile update -----------------------------------------------------------

  /**
   * Updates the supported profile attributes.
   *
   * There is exactly one, `phone`, and that is what the schema has. The
   * alternative was adding a display-name column to make the endpoint look
   * fuller, which would be a schema change driven by the shape of an API rather
   * than by a requirement.
   *
   * **`email` is not editable here, deliberately.** It is the login identity:
   * changing it would have to settle case-normalized global uniqueness, whether
   * live sessions survive, what an API key created by the old address means,
   * whether the old address may be reclaimed, and how account recovery behaves
   * across the change — and the honest mechanism for it is a verified change
   * flow that does not exist. A `PATCH` that quietly rewrote the identity would
   * be that missing flow's absence, shipped as a feature.
   */
  async update(
    tx: Transaction,
    principal: AuthPrincipal,
    id: string,
    input: UpdateUserInput,
  ): Promise<UserView> {
    const orgId = this.requireOrg(principal);
    await this.authorization.assert(tx, {
      principal,
      permission: 'users.update',
      target: { scopeType: 'organization', scopeId: orgId },
      resourceType: 'User',
    });

    const before = await this.loadMember(tx, orgId, id);

    // Nothing supplied is not an error and not a change. Returning the user
    // unchanged and writing no audit row keeps the trail a record of what
    // happened rather than of what was asked.
    if (!('phone' in input)) return this.view(before);
    if ((input.phone ?? null) === before.phone) return this.view(before);

    const [row] = await tx
      .update(schema.users)
      .set({ phone: input.phone ?? null, updatedAt: new Date() })
      .where(eq(schema.users.id, id))
      .returning(this.columns());

    if (!row) throw this.notFound(id);
    const after = row as unknown as UserRow;

    await this.audit.record(
      {
        scopeType: 'organization',
        scopeId: orgId,
        ...actorFromPrincipal(principal),
        action: AUDIT_ACTIONS.USER_UPDATED,
        resourceType: 'User',
        resourceId: id,
        outcome: 'success',
        before: { phone: before.phone },
        after: { phone: after.phone },
        metadata: { fields: ['phone'] },
      },
      tx,
    );

    return this.view(after);
  }

  // --- lifecycle ------------------------------------------------------------------

  /**
   * Disables a user.
   *
   * A dedicated operation rather than `PATCH { status }`, because the two are
   * not the same kind of act: this one revokes live access, is guarded by the
   * platform-admin liveness invariant, and produces its own audit action. Hiding
   * that behind a generic field update would make a privilege change look like a
   * profile edit in the route table, in the audit trail and in a client.
   *
   * The sequence, in one transaction:
   *
   *   1. authorize `users.disable` at the request's organization;
   *   2. resolve the target through the membership predicate — `404` otherwise,
   *      never a confirmation that a user exists elsewhere;
   *   3. refuse a no-op (`409`), so "already disabled" is a definite answer;
   *   4. refuse, cleanly, a disable that would leave no active platform
   *      administrator;
   *   5. update the status — where the database has the final word;
   *   6. revoke every live session;
   *   7. audit, inside the same transaction.
   *
   * **Sessions: both mechanisms, and neither is new.** `AuthGuard` already
   * re-reads the user on every request and refuses a non-active one, so a
   * disabled user is locked out at the next request whatever happens to their
   * session rows — that is the guarantee, and it does not depend on this step.
   * Revoking here, through the existing `SessionService` and in the same
   * transaction, makes the stored state agree with it rather than leaving rows
   * that claim to be live. No second invalidation mechanism is introduced and no
   * token is touched: the refresh token is only a hash in `sessions`, and
   * revoking the row is what makes it unusable.
   */
  async disable(tx: Transaction, principal: AuthPrincipal, id: string): Promise<UserView> {
    const orgId = this.requireOrg(principal);
    await this.authorization.assert(tx, {
      principal,
      permission: 'users.disable',
      target: { scopeType: 'organization', scopeId: orgId },
      resourceType: 'User',
    });

    const before = await this.loadMember(tx, orgId, id);

    // ADR-012 F-9, applied to disable (Phase 1C.2 remediation M-2). Disabling
    // an identity signs it out, and blocks its sign-in, in every organization it
    // belongs to — so, exactly as for revoking its sessions, the administrator
    // must cover **every** grant the target holds, not merely the selected
    // organization. Same evaluator, same authoritative grant set; checked
    // before the status is disclosed or anything is written.
    await this.assertCoversSubjectGrants(principal, id, PERMISSIONS.USERS_DISABLE);

    if (before.status === 'disabled') {
      throw this.lifecycleConflict('This user is already disabled', before.status);
    }

    // Only for an administrator: every other disable takes no lock and runs
    // no count. Organizations first, then the platform — the order the
    // triggers beneath take the same locks in (`trg_users_org_admin_liveness`
    // fires before `trg_users_platform_admin_liveness`).
    if (before.status === 'active') {
      await this.assertOrganizationAdminsRemain(tx, id);
      await this.assertPlatformAdminRemains(tx, id);
    }

    const after = await this.setStatus(tx, id, 'disabled');
    const revoked = await this.sessions.revokeAllForUser(tx, id, 'user_disabled');

    await this.audit.record(
      {
        scopeType: 'organization',
        scopeId: orgId,
        ...actorFromPrincipal(principal),
        action: AUDIT_ACTIONS.USER_DISABLED,
        resourceType: 'User',
        resourceId: id,
        outcome: 'success',
        before: { status: before.status },
        after: { status: after.status },
        // A count, never the session ids or anything they carry.
        metadata: { sessionsRevoked: revoked },
      },
      tx,
    );

    return this.view(after);
  }

  /**
   * Restores a disabled user.
   *
   * The destination is not a free choice: `users_active_requires_credential`
   * refuses `active` for a user holding neither a password nor an MFA secret, so
   * one who was disabled before ever activating returns to `invited` — exactly
   * where they were. The response says which, and the audit row records it.
   *
   * **Sessions are not restored.** They were revoked when the user was disabled
   * and stay revoked: reactivation returns the ability to sign in, not the
   * sessions that existed before it.
   */
  async reactivate(tx: Transaction, principal: AuthPrincipal, id: string): Promise<UserView> {
    const orgId = this.requireOrg(principal);
    await this.authorization.assert(tx, {
      principal,
      permission: 'users.reactivate',
      target: { scopeType: 'organization', scopeId: orgId },
      resourceType: 'User',
    });

    const before = await this.loadMember(tx, orgId, id);

    // ADR-012 F-9, applied to reactivate (Phase 1C security remediation). Like
    // disable, reactivation is global to the identity: it restores sign-in in
    // every organization the user belongs to, its authority at every scope it
    // holds a grant, and the effectiveness of every API key it created. So the
    // administrator must cover **every** grant the target holds — same helper,
    // same evaluator, same authoritative grant set as disable — checked before
    // the status is disclosed or anything is written. The refusal is a generic
    // audited `403` that names no grant.
    await this.assertCoversSubjectGrants(principal, id, PERMISSIONS.USERS_REACTIVATE);

    if (before.status !== 'disabled') {
      throw this.lifecycleConflict('This user is not disabled', before.status);
    }

    const [credential] = await tx
      .select({
        hasCredential: sql<boolean>`(${schema.users.passwordHash} IS NOT NULL OR ${schema.users.mfaSecretRef} IS NOT NULL)`,
      })
      .from(schema.users)
      .where(eq(schema.users.id, id));

    const restored: UserStatus = credential?.hasCredential ? 'active' : 'invited';
    const after = await this.setStatus(tx, id, restored);

    await this.audit.record(
      {
        scopeType: 'organization',
        scopeId: orgId,
        ...actorFromPrincipal(principal),
        action: AUDIT_ACTIONS.USER_REACTIVATED,
        resourceType: 'User',
        resourceId: id,
        outcome: 'success',
        before: { status: before.status },
        after: { status: after.status },
        // Whether a credential survived, never anything about it.
        metadata: { restoredTo: restored },
      },
      tx,
    );

    return this.view(after);
  }

  // --- administrator session management (Phase 1C.2, ADR-012 F-9) ------------

  /**
   * Another user's live sessions. `sessions.read` covering the selected
   * organization **and** every grant the target holds.
   */
  async listSessions(
    tx: Transaction,
    principal: AuthPrincipal,
    id: string,
  ): Promise<AdminSessionView[]> {
    await this.assertSessionAuthority(tx, principal, id, PERMISSIONS.SESSIONS_READ);
    const rows = await this.sessions.listLive(tx, id);
    return rows.map((r) => ({ ...r, current: r.id === principal.sessionId }));
  }

  /**
   * Revokes every session of another user (ADR-012 F-9): `sessions.revoke`
   * covering the organization and every grant the target holds; a signed-in
   * administrator only. Returns the number of live sessions revoked.
   */
  async revokeAllSessions(tx: Transaction, principal: AuthPrincipal, id: string): Promise<number> {
    this.requireSessionActor(principal);
    const orgId = await this.assertSessionAuthority(tx, principal, id, PERMISSIONS.SESSIONS_REVOKE);

    const revoked = await this.sessions.revokeAllForUser(tx, id, 'admin_revoked');
    await this.audit.record(
      {
        // The administrator's own scope, never the target's (ADR-005 D-6).
        scopeType: 'organization',
        scopeId: orgId,
        ...actorFromPrincipal(principal),
        action: AUDIT_ACTIONS.SESSION_REVOKED_ALL,
        resourceType: 'User',
        resourceId: id,
        outcome: 'success',
        before: null,
        after: { revoked },
        metadata: { revokedBy: 'administrator' },
      },
      tx,
    );
    return revoked;
  }

  /**
   * Revokes one logical session (rotation chain) of another user. `404` when the
   * session is not the target's or has nothing live left.
   */
  async revokeSession(
    tx: Transaction,
    principal: AuthPrincipal,
    id: string,
    sessionId: string,
  ): Promise<void> {
    this.requireSessionActor(principal);
    const orgId = await this.assertSessionAuthority(tx, principal, id, PERMISSIONS.SESSIONS_REVOKE);

    const target = await this.sessions.findById(tx, sessionId);
    if (!target || target.userId !== id) throw this.sessionNotFound(sessionId);
    const outcome = await this.sessions.revokeChain(tx, sessionId, 'admin_revoked');
    if (!outcome || outcome.liveRevoked === 0) throw this.sessionNotFound(sessionId);

    await this.audit.record(
      {
        scopeType: 'organization',
        scopeId: orgId,
        ...actorFromPrincipal(principal),
        action: AUDIT_ACTIONS.SESSION_REVOKED,
        resourceType: 'Session',
        resourceId: sessionId,
        outcome: 'success',
        before: null,
        after: { revoked: true },
        metadata: { userId: id, revokedBy: 'administrator' },
      },
      tx,
    );
  }

  /**
   * The F-9 decision, in order: the permission at the selected organization
   * (audited `403`); the target is a member of it (`404` otherwise, no echo);
   * then every grant the target holds — read from authoritative identity state,
   * not through this caller's RLS view — must be covered (audited `403`).
   *
   * **Accepted race.** The target's grants are read, through `acc_auth`, inside
   * this transaction but on a separate connection. A grant created concurrently
   * and committed after that read is not seen. The effect is bounded: the
   * decision stands on the grant set as of the read, and the most it can do is
   * sign out a user whose new grant was created a moment too late to refuse —
   * it can never confer authority on the administrator or reach another
   * resource.
   */
  private async assertSessionAuthority(
    tx: Transaction,
    principal: AuthPrincipal,
    id: string,
    permission: string,
  ): Promise<string> {
    const orgId = this.requireOrg(principal);
    await this.authorization.assert(tx, {
      principal,
      permission,
      target: { scopeType: 'organization', scopeId: orgId },
      resourceType: 'User',
    });
    await this.loadMember(tx, orgId, id);
    await this.assertCoversSubjectGrants(principal, id, permission);
    return orgId;
  }

  /**
   * ADR-012 F-9 complete-grant coverage — the one implementation, shared by
   * session administration and `disable`. The target identity's complete grant
   * set is read from authoritative identity state (`ScopeResolver` through
   * `acc_auth`), never through the caller's RLS-visible subset, and each grant
   * must be covered for `permission` by the caller's coherent grants
   * (`AuthorizationService.assertCoversEveryScope`: audited `403` otherwise,
   * recorded before the refusal is raised).
   *
   * Every grant row counts, including one in a suspended or closed
   * organization: grants have no inactive state, and counting them can only
   * refuse more often.
   */
  private async assertCoversSubjectGrants(
    principal: AuthPrincipal,
    id: string,
    permission: string,
  ): Promise<void> {
    const subject = await this.db.auth.transaction((authTx) =>
      this.scopes.forUser(authTx as Transaction, id),
    );
    await this.authorization.assertCoversEveryScope({
      principal,
      permission,
      scopes: subject.grants.map((g) => ({ scopeType: g.scopeType, scopeId: g.scopeId })),
      subject: { resourceType: 'User', resourceId: id },
    });
  }

  /** Revoking another user's sessions is for a signed-in administrator, never an API key. */
  private requireSessionActor(principal: AuthPrincipal): void {
    if (principal.actorType === 'user' && principal.userId && principal.sessionId) return;
    throw new AppException({
      status: HttpStatus.FORBIDDEN,
      code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
      message: 'Revoking sessions requires a signed-in user session',
    });
  }

  private sessionNotFound(sessionId: string): AppException {
    return new AppException({
      status: HttpStatus.NOT_FOUND,
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
      message: 'Session not found',
      logContext: { sessionId },
    });
  }

  // --- guards and helpers -------------------------------------------------------

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
   * *Holds at least one grant in this organization* — the only honest expression
   * of membership for a table with no tenant column.
   *
   * `EXISTS` rather than a join, so a user with several grants appears once and
   * the keyset ordering over `users.id` stays total. The subquery runs under
   * `user_roles`' own RLS policy, so it can narrow the visible set but never
   * widen it.
   */
  private memberOf(orgId: string): SQL {
    return exists(
      sql`(SELECT 1 FROM ${schema.userRoles} ur
            WHERE ur.user_id = ${schema.users.id} AND ur.org_id = ${orgId})`,
    );
  }

  /**
   * One user of this organization, or `404`.
   *
   * A user in another tenant, a user with no grant here, and an id that was
   * never issued are one answer with one message and no echo of the identifier —
   * so the endpoint cannot be used to discover which users exist (`API.md` §3a).
   */
  private async loadMember(tx: Transaction, orgId: string, id: string): Promise<UserRow> {
    const [row] = await tx
      .select(this.columns())
      .from(schema.users)
      .where(and(eq(schema.users.id, id), this.memberOf(orgId)));

    if (!row) throw this.notFound(id);
    return row as unknown as UserRow;
  }

  private async setStatus(tx: Transaction, id: string, status: UserStatus): Promise<UserRow> {
    const rows = await tx
      .update(schema.users)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.users.id, id))
      .returning(this.columns())
      .catch((error: unknown) => {
        throw this.translateLivenessViolation(error);
      });

    const row = rows[0];
    if (!row) throw this.notFound(id);
    return row as unknown as UserRow;
  }

  private async insertIdentity(
    tx: Transaction,
    userId: string,
    input: CreateUserInput,
  ): Promise<void> {
    await tx
      .insert(schema.users)
      .values({
        // Generated here rather than by the default, so the row can be inserted
        // without `RETURNING` — which would apply `users_select` to a user that
        // does not hold a grant yet and fail.
        id: userId,
        email: input.email,
        phone: input.phone ?? null,
        // The only state a user with no credential may hold.
        status: 'invited',
      })
      .catch((error: unknown) => {
        throw this.translateDuplicateIdentity(error);
      });
  }

  /**
   * Refuses a disable that would leave any organization the user administers
   * with no active administrator (ADR-015 R-11, D-MEDIUM-3b; `RBAC.md` §7c).
   *
   * The message, not the guarantee: `trg_users_org_admin_liveness` (migration
   * `0028`) fires on exactly this transition for every writer. The locks are
   * taken here first, in ascending organization order as the trigger takes
   * them, and a lost race's `restrict_violation` is translated to the same
   * `409` by `translateLivenessViolation`.
   */
  private async assertOrganizationAdminsRemain(tx: Transaction, userId: string): Promise<void> {
    const administered = await tx
      .selectDistinct({ orgId: schema.userRoles.scopeId })
      .from(schema.userRoles)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
      .where(
        and(
          eq(schema.userRoles.userId, userId),
          eq(schema.userRoles.scopeType, 'organization'),
          eq(schema.roles.orgId, schema.userRoles.scopeId),
          eq(schema.roles.key, TENANT_ROLE_KEYS.ORG_ADMIN),
          eq(schema.roles.isSystemRole, true),
        ),
      );
    // Early exit, as the trigger's: a user administering nothing takes no lock.
    const orgIds = administered.map((row) => row.orgId!).sort();
    if (orgIds.length === 0) return;

    await lockOrganizationAdministration(tx, orgIds);
    for (const orgId of orgIds) {
      await assertOrganizationAdminRemains(tx, orgId, { userId });
    }
  }

  /**
   * Refuses a disable that would leave the platform with no active
   * administrator (ADR-005 D-7).
   *
   * **This is the message, not the guarantee.** `trg_users_platform_admin_liveness`
   * (migration `0005`) already fires on exactly this transition and is what
   * actually holds the invariant, including for a writer that never reaches this
   * service. What this adds is a clean `409` with an actionable code instead of
   * a `restrict_violation` surfacing as a `500` — and `translateLivenessViolation`
   * covers the race in which two disables pass this check and the trigger
   * refuses the loser.
   *
   * The lock is taken here rather than left to the trigger for the ordering
   * ADR-005 D-7 describes: advisory lock first, row locks second, so this path
   * cannot form a cycle with a concurrent revocation that already holds a row
   * this transaction will need. The trigger re-acquires the same key, which
   * within one transaction is a no-op.
   *
   * The count mirrors the trigger's exactly — an active user holding
   * `alendei_super_admin` at `platform` scope, excluding this one (migration
   * `0010`) — because a second definition of "platform administrator" would
   * drift from the first. A support grant is platform-scoped and does not count.
   */
  private async assertPlatformAdminRemains(
    tx: Transaction,
    excludingUserId: string,
  ): Promise<void> {
    const [holder] = await tx
      .select({ id: schema.userRoles.id })
      .from(schema.userRoles)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
      .where(
        and(
          eq(schema.userRoles.userId, excludingUserId),
          eq(schema.userRoles.scopeType, 'platform'),
          isNull(schema.roles.orgId),
          eq(schema.roles.key, PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN),
        ),
      )
      .limit(1);

    // Early exit, exactly as the trigger's first statement does: an ordinary
    // user's disable takes no lock and runs no count.
    if (!holder) return;

    await tx.execute(sql`select pg_advisory_xact_lock(${PLATFORM_ADMIN_LOCK_KEY})`);

    const { rows } = await tx.execute<{ remaining: string }>(sql`
      SELECT count(*) AS remaining
      FROM user_roles ur
      JOIN users u ON u.id = ur.user_id
      JOIN roles r ON r.id = ur.role_id
      WHERE ur.scope_type = 'platform'
        AND r.org_id IS NULL
        AND r.key = ${PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN}
        AND u.status = 'active'
        AND ur.user_id <> ${excludingUserId}
    `);

    if (Number(rows[0]?.remaining ?? 0) === 0) {
      throw new AppException({
        status: HttpStatus.CONFLICT,
        code: ERROR_CODES.AUTHZ_LAST_PLATFORM_ADMIN,
        message:
          'This is the last active platform administrator; appoint another before disabling it',
      });
    }
  }

  /**
   * The trigger's refusal, rendered as the documented conflict.
   *
   * Reached when a concurrent disable won the race between this transaction's
   * count and its update. The database is the authority in that case and its
   * answer must reach the caller as the same `409` the service-level check
   * produces — not as a `500`, which would report a working invariant as a bug.
   */
  private translateLivenessViolation(error: unknown): unknown {
    // The organization rule raises the same SQLSTATE with its own constraint
    // name (migration `0028`), and is its own `409`.
    const organization = translateOrganizationAdminLiveness(error);
    if (organization !== error) return organization;
    if (this.pgCode(error) !== PG_RESTRICT_VIOLATION) return error;
    return new AppException({
      status: HttpStatus.CONFLICT,
      code: ERROR_CODES.AUTHZ_LAST_PLATFORM_ADMIN,
      message:
        'This is the last active platform administrator; appoint another before disabling it',
    });
  }

  /**
   * `users_email_key` refusing a second identity for one address.
   *
   * The index is **global**, not per organization, because an identity is
   * platform-level — so this `409` does disclose that the address is registered
   * somewhere on the platform. That is inherent to a single identity namespace
   * and is recorded as such in `SECURITY.md` rather than papered over: the
   * message names no organization, no user and no status, so what leaks is the
   * existence of an address and nothing about who holds it or where.
   */
  private translateDuplicateIdentity(error: unknown): unknown {
    if (this.pgCode(error) !== PG_UNIQUE_VIOLATION) return error;
    return new AppException({
      status: HttpStatus.CONFLICT,
      code: ERROR_CODES.RESOURCE_CONFLICT,
      message: 'That email address is already registered',
    });
  }

  private pgCode(error: unknown): string | undefined {
    return (
      (error as { cause?: { code?: string }; code?: string })?.cause?.code ??
      (error as { code?: string })?.code
    );
  }

  private lifecycleConflict(message: string, status: UserStatus): AppException {
    return new AppException({
      status: HttpStatus.CONFLICT,
      code: ERROR_CODES.USER_LIFECYCLE_CONFLICT,
      message,
      // The current state, which the caller can already read from `GET
      // /users/:id`, so naming it discloses nothing and makes the refusal
      // actionable.
      details: { status },
    });
  }

  private notFound(id: string): AppException {
    return new AppException({
      status: HttpStatus.NOT_FOUND,
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
      message: 'User not found',
      logContext: { requestedUserId: id },
    });
  }

  /**
   * The projection, written once.
   *
   * Every read goes through it, so no query can select a credential column by
   * accident — `select()` with no argument would return the whole row,
   * `password_hash` included, and the only reliable defence against that is
   * never writing it.
   */
  private columns() {
    return {
      id: schema.users.id,
      email: schema.users.email,
      phone: schema.users.phone,
      status: schema.users.status,
      lastLoginAt: schema.users.lastLoginAt,
      createdAt: schema.users.createdAt,
      updatedAt: schema.users.updatedAt,
    };
  }

  private view(row: UserRow): UserView {
    return {
      id: row.id,
      email: row.email,
      phone: row.phone,
      status: row.status,
      lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

interface UserRow {
  id: string;
  email: string;
  phone: string | null;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
