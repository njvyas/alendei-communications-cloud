import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  type AuthPrincipal,
  type PermissionKey,
  type ScopeRef,
} from '@acc/contracts';
import type { Transaction } from '@acc/db';

import { AppException } from '../common/errors/app.exception';
import { RequestContext } from '../common/context/request-context';
import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { DENIAL_RECORD, TenantDatabase } from '../database/tenant-database.service';
import { PermissionEvaluator } from './permission-evaluator.service';
import { ScopeChainResolver } from './scope-chain-resolver.service';

/**
 * What a caller asks the boundary. Distinct from the evaluator's
 * `AuthorizationRequest`, which carries an already-resolved scope *and* chain:
 * the difference between the two types is precisely the ancestry this service
 * resolves, and naming them apart keeps that difference visible.
 */
export interface AuthorizationCheck {
  readonly principal: AuthPrincipal;
  readonly permission: PermissionKey | string;
  /**
   * The resource being acted on, named by level and id.
   *
   * Note what is *absent*: there is no ancestry parameter. A caller identifies
   * the target and cannot describe it (ADR-005 D-5).
   */
  readonly target: ScopeRef;
  /**
   * What a refused or unresolvable target is called in the `404` message.
   * Never includes an identifier.
   */
  readonly resourceType?: string;
}

/** What an `authorization.denied` row records as the attempted resource. */
interface DenialSubject {
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly metadata: Record<string, unknown>;
}

/**
 * The reusable authorization boundary (ADR-003 D-5, ADR-005 D-1/D-5).
 *
 * Every scoped operation asks its question here, and the three steps it takes
 * are the three that a call site would otherwise have to remember in order:
 *
 *   1. resolve the target's authoritative ancestry from the database
 *   2. refuse an unresolvable target as `404`, without confirming anything
 *   3. decide, through the evaluator, against a single coherent grant
 *
 * The point is that step 1 cannot be skipped. Before this existed, each handler
 * assembled its own `chain` alongside its own `scope`, and a handler that
 * assembled one from request input would have been indistinguishable in review
 * from one that did not. Here there is no chain to assemble: the only thing a
 * caller supplies is which resource it means.
 *
 * Responsibilities stay separate on purpose, because merging any two of them
 * loses a property:
 *
 *   `ScopeChainResolver`  resource  → authoritative ancestry
 *   `AuthorizationService`  target + permission → decision  (this class)
 *   `PermissionEvaluator`   grant    → coherent-grant algebra
 *
 * The evaluator is never reimplemented here; this class orchestrates and
 * delegates, so the 1B.5.1 invariant has exactly one definition.
 */
@Injectable()
export class AuthorizationService {
  private readonly logger = new Logger(AuthorizationService.name);

  constructor(
    private readonly chains: ScopeChainResolver,
    private readonly evaluator: PermissionEvaluator,
    private readonly audit: AuditWriter,
    private readonly db: TenantDatabase,
  ) {}

  /**
   * Throwing form. `404` when the target does not resolve, `403` when it
   * resolves but no coherent grant covers it.
   *
   * A transaction is **required** rather than optional. The chain must be read
   * under the request's own tenant context — the same `SET LOCAL` transaction
   * the business query runs in (`TENANCY.md` §5, `DATABASE.md` §14a) — so RLS
   * filters it and an out-of-tenant target is invisible rather than merely
   * unauthorized. Accepting a missing transaction would mean opening one here,
   * and a second code path is a second thing to get wrong.
   */
  async assert(tx: Transaction, request: AuthorizationCheck): Promise<void> {
    // Recorded before the decision, and regardless of it: the coverage
    // cross-check asks whether this route looked, not what the answer was, and
    // a refusal is still a check that happened.
    RequestContext.recordAuthorizationCheck(String(request.permission));

    const chain = await this.chains.resolve(tx, request.target);

    if (chain === null) {
      // Not "denied": the caller must not be able to distinguish a resource
      // that is out of its reach from one that does not exist, or the endpoint
      // becomes an existence oracle (`API.md` §3a). The identifier is never
      // echoed — it goes to the operator log only.
      throw new AppException({
        status: HttpStatus.NOT_FOUND,
        code: ERROR_CODES.RESOURCE_NOT_FOUND,
        message: `${request.resourceType ?? 'Resource'} not found`,
        logContext: {
          permission: request.permission,
          targetScopeType: request.target.scopeType,
          targetScopeId: request.target.scopeId,
        },
      });
    }

    try {
      this.evaluator.assert({
        principal: request.principal,
        permission: request.permission,
        target: { scope: request.target, chain },
      });
    } catch (denial) {
      // Record first, refuse second: the record is committed once the caller's
      // transaction has released its connection and before the refusal
      // leaves it (`recordDenial`). The evaluator remains the sole author of
      // the refusal — it is rethrown untouched — so there is still exactly one
      // definition of what a denial looks like to a caller.
      await this.recordDenial(request);
      throw denial;
    }
  }

  /**
   * Writes the `authorization.denied` record, in its own transaction, before
   * the refusal reaches the client (ADR-005 D-6, amended by ADR-015 R-12).
   *
   * **Why not the caller's transaction.** The refusal is thrown out of the very
   * transaction the caller opened, which rolls it back — so a denial record
   * written there would be discarded every time, and the control would report
   * nothing while appearing to work. A denial has no business mutation to
   * commit alongside in any case: the request was never going to change
   * anything.
   *
   * **Why after the caller's transaction (R-12).** Opening the record's
   * transaction while the caller's still holds an `acc_app` connection is a
   * nested acquisition from the same pool: under enough concurrent denials
   * every caller holds one connection and waits for a second that only another
   * caller can release. So the write is handed to `TenantDatabase.whenReleased`,
   * which runs it once the caller's transaction has settled and returned its
   * connection, and before the refusal propagates past `withTenant` — the
   * record still commits before the client sees the `403`.
   *
   * The consequence is deliberate: the record survives the rollback of the
   * surrounding request. That is correct for a security event — the attempt
   * happened, and whether the request went on to fail for some other reason
   * does not unmake it.
   *
   * **Fail closed.** Nothing here is caught. If the record cannot be written,
   * that failure propagates instead of the `403` (`whenReleased` replaces the
   * transaction's outcome with it), the request still does not proceed, and the
   * operator sees why. Reporting a plain refusal while silently losing its
   * record is the one outcome this must never produce.
   */
  private async recordDenial(
    request: AuthorizationCheck,
    attempted: DenialSubject = {
      resourceType: request.resourceType ?? request.target.scopeType,
      resourceId: request.target.scopeId,
      metadata: {
        attemptedScopeType: request.target.scopeType,
        attemptedScopeId: request.target.scopeId,
      },
    },
  ): Promise<void> {
    const { principal } = request;
    const actorScope = this.actorScope(principal);

    await this.db.whenReleased(async () => {
      try {
        await this.db.withTenant(
          {
            orgId: principal.tenant.orgId,
            workspaceId: principal.tenant.workspaceId,
            resellerId: principal.tenant.resellerId,
            userId: principal.userId,
            isPlatformAdmin: principal.tenant.isPlatformAdmin,
          },
          (auditTx) =>
            this.audit.record(
              {
                // The actor's own legitimate scope — never the scope it tried to
                // reach. The database derives this row's tenancy from this pair,
                // so naming the attempted target here would file the record under
                // a tenant the actor was never in (ADR-005 D-6).
                scopeType: actorScope.scopeType,
                scopeId: actorScope.scopeId,
                ...actorFromPrincipal(principal),
                action: AUDIT_ACTIONS.AUTHORIZATION_DENIED,
                // The attempted target, kept separate from the actor's scope.
                resourceType: attempted.resourceType,
                resourceId: attempted.resourceId,
                outcome: 'denied',
                before: null,
                after: null,
                // Structured and minimal. Enough to answer "who tried to do what,
                // where, and why were they refused" — and deliberately not the
                // request, the headers, the principal or the token, none of which
                // an append-only row should ever carry.
                metadata: {
                  permission: request.permission,
                  ...attempted.metadata,
                  denialReason: ERROR_CODES.AUTHZ_SCOPE_DENIED,
                },
              },
              auditTx,
            ),
          // A refusal record, not a mutation: committed even when the refused
          // check was a precondition and the route's declared one never ran.
          { coverageExempt: DENIAL_RECORD },
        );
      } catch (failure) {
        // Observable to the operator, opaque to the requester: the exception
        // filter renders an unrecognized error as a generic `500` carrying only
        // the correlation id (`API.md` §7).
        this.logger.error(
          `failed to record ${AUDIT_ACTIONS.AUTHORIZATION_DENIED} for ${String(request.permission)} at ${request.target.scopeType}`,
          failure instanceof Error ? failure.stack : String(failure),
        );
        throw failure;
      }
    });
  }

  /**
   * The scope the actor legitimately occupies, narrowest first.
   *
   * Narrowest wins because it is the most truthful statement of where the actor
   * was: a principal pinned to one workspace did not act "in the organization",
   * and recording it that way would overstate its reach on a permanent record.
   *
   * No fallback is invented. A principal holding a platform-scope grant but no
   * selected organization (Phase 2.1's catalogue routes make this reachable, for
   * example `alendei_support` without `X-Acc-Organization`) genuinely occupies
   * `platform`, so that is where its refusal is filed. A principal with no
   * resolved scope at all — no organization, no reseller, no platform grant —
   * cannot be described honestly, and the `audit_logs` RLS policies would refuse
   * the row regardless, so this fails closed and loudly rather than guessing;
   * routes that can reach such a principal refuse it before asserting.
   */
  private actorScope(principal: AuthPrincipal): ScopeRef {
    const { orgId, workspaceId, resellerId, isPlatformAdmin } = principal.tenant;

    if (orgId && workspaceId) return { scopeType: 'workspace', scopeId: workspaceId };
    if (orgId) return { scopeType: 'organization', scopeId: orgId };
    if (resellerId) return { scopeType: 'reseller', scopeId: resellerId };
    if (isPlatformAdmin) return { scopeType: 'platform', scopeId: null };
    // A principal holding any platform-scope grant (for example `alendei_support`
    // with no organization selected) legitimately occupies `platform`, whatever
    // its role is named. Its own denial row there is admitted by
    // `audit_logs_platform_self_denial_insert` (migration `0019`), which the
    // database checks against the actor's current grants.
    if (principal.roles.some((grant) => grant.scopeType === 'platform')) {
      return { scopeType: 'platform', scopeId: null };
    }

    throw new Error(
      'audit: cannot record authorization.denied — the principal has no resolved scope to attribute it to',
    );
  }

  /**
   * ADR-012 F-9: does the principal hold `permission`, through coherent grants,
   * over **every** one of `scopes` — the complete grant set of another identity,
   * whose sessions it wants to read or revoke? Throwing form; one audited
   * `403 AUTHZ_SCOPE_DENIED` if any scope is not covered.
   *
   * Sessions belong to the identity, not to an organization, so acting on them
   * affects every organization the subject is in; covering only the selected
   * organization would be cross-scope. The caller supplies the subject's scopes
   * from **authoritative identity state** (read by `ScopeResolver` through
   * `acc_auth`, not through the caller's RLS view, which would hide exactly the
   * grants that must refuse).
   *
   * Each scope's ancestry is resolved on the same identity plane (`acc_auth`),
   * not under the caller's tenant context, and the decision is the evaluator's
   * alone. Resolving under the caller's RLS would make an invisible scope look
   * "uncovered" for a principal whose grant genuinely covers it — a support
   * principal holds `sessions.read` at platform scope, yet is deliberately not
   * an RLS platform administrator (ADR-011 D-2). Nothing about the scopes leaves
   * this method but a yes or no, and whether the *subject* is visible to the
   * caller at all (`404`) is decided beforehand, under RLS, by the caller. A
   * scope whose ancestry does not resolve (deleted meanwhile) is not covered.
   *
   * The refusal names the subject, never the uncovered scope. The audit row is
   * filed under the actor's own scope, and the uncovered grant may be another
   * tenant's — recording its id there would disclose it.
   */
  async assertCoversEveryScope(request: {
    readonly principal: AuthPrincipal;
    readonly permission: PermissionKey | string;
    readonly scopes: readonly ScopeRef[];
    readonly subject: { readonly resourceType: string; readonly resourceId: string };
  }): Promise<void> {
    RequestContext.recordAuthorizationCheck(String(request.permission));

    const resolved = await this.db.auth.transaction(async (identityTx) => {
      const out: { scope: ScopeRef; chain: Awaited<ReturnType<ScopeChainResolver['resolve']>> }[] =
        [];
      for (const scope of request.scopes) {
        out.push({ scope, chain: await this.chains.resolve(identityTx as Transaction, scope) });
      }
      return out;
    });

    for (const { scope, chain } of resolved) {
      const covered =
        chain !== null &&
        this.evaluator.allows({
          principal: request.principal,
          permission: request.permission,
          target: { scope, chain },
        });
      if (covered) continue;

      await this.recordDenial(
        {
          principal: request.principal,
          permission: request.permission,
          target: scope,
          resourceType: request.subject.resourceType,
        },
        {
          resourceType: request.subject.resourceType,
          resourceId: request.subject.resourceId,
          metadata: { denialDetail: 'subject_holds_uncovered_grant' },
        },
      );
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        message: 'You do not have permission to perform this action',
        logContext: { permission: request.permission, subjectId: request.subject.resourceId },
      });
    }
  }

  /**
   * Which of `permissions` the principal does **not** hold at `target`.
   *
   * The same coherent-grant question `allows` asks, asked about a *set* in one
   * pass: the chain is resolved once and the evaluator — which is pure given a
   * resolved chain — decides each permission in memory. Query cost is therefore
   * constant in the number of permissions rather than linear in it.
   *
   * That difference is the reason this exists. Role administration asks this
   * question about every permission a role carries, and asking it by calling
   * `allows` in a loop re-resolves the same ancestry once per permission — a
   * chain read per candidate, growing with the role. Here the boundary is still
   * the only thing that answers, and it answers with a predictable cost.
   *
   * Returns the unheld permissions rather than a boolean because every caller
   * needs to say *which* ones were refused: a role-composition or grant refusal
   * that cannot name the offending permission is not actionable.
   *
   * An unresolvable target yields every permission as unheld — the same
   * fail-closed answer `allows` gives, without choosing a status for a caller
   * that is not being told one.
   */
  async unheldPermissions(
    tx: Transaction,
    request: {
      readonly principal: AuthPrincipal;
      readonly permissions: readonly (PermissionKey | string)[];
      readonly target: ScopeRef;
    },
  ): Promise<readonly string[]> {
    const candidates = [...new Set(request.permissions)];
    if (candidates.length === 0) return [];

    const chain = await this.chains.resolve(tx, request.target);
    if (chain === null) return candidates;

    return candidates.filter(
      (permission) =>
        !this.evaluator.allows({
          principal: request.principal,
          permission,
          target: { scope: request.target, chain },
        }),
    );
  }

  /**
   * Non-throwing form, for filtering listings and rendering capability flags.
   *
   * An unresolvable target is `false` — the same fail-closed answer, without
   * choosing between `403` and `404` for a caller that is not being told
   * either.
   *
   * **Deliberately unaudited.** `authorization.denied` records an *attempted
   * operation* that was refused. This form asks a hypothetical — may this
   * principal do this, so the listing can omit a row or the console can grey out
   * a button — and auditing it would write one row per candidate per render,
   * burying the refusals that represent something someone actually tried.
   */
  async allows(tx: Transaction, request: AuthorizationCheck): Promise<boolean> {
    const chain = await this.chains.resolve(tx, request.target);
    if (chain === null) return false;

    return this.evaluator.allows({
      principal: request.principal,
      permission: request.permission,
      target: { scope: request.target, chain },
    });
  }
}
