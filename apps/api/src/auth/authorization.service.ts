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
import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { TenantDatabase } from '../database/tenant-database.service';
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
      // Record first, refuse second. The evaluator remains the sole author of
      // the refusal — it is rethrown untouched — so there is still exactly one
      // definition of what a denial looks like to a caller.
      await this.recordDenial(request);
      throw denial;
    }
  }

  /**
   * Writes the `authorization.denied` record, in its own transaction, before
   * the refusal is raised (ADR-005 D-6).
   *
   * **Why not the caller's transaction.** The refusal is thrown out of the very
   * transaction the caller opened, which rolls it back — so a denial record
   * written there would be discarded every time, and the control would report
   * nothing while appearing to work. A denial has no business mutation to
   * commit alongside in any case: the request was never going to change
   * anything. Committing separately, before the throw, is what makes the record
   * exist.
   *
   * The consequence is deliberate: the record survives a later rollback of the
   * surrounding request. That is correct for a security event — the attempt
   * happened, and whether the request went on to fail for some other reason
   * does not unmake it.
   *
   * **Fail closed.** Nothing here is caught. If the record cannot be written,
   * that failure propagates instead of the `403`, the request still does not
   * proceed, and the operator sees why. Reporting a plain refusal while
   * silently losing its record is the one outcome this must never produce.
   */
  private async recordDenial(request: AuthorizationCheck): Promise<void> {
    const { principal } = request;
    const actorScope = this.actorScope(principal);

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
              resourceType: request.resourceType ?? request.target.scopeType,
              resourceId: request.target.scopeId,
              outcome: 'denied',
              before: null,
              after: null,
              // Structured and minimal. Enough to answer "who tried to do what,
              // where, and why were they refused" — and deliberately not the
              // request, the headers, the principal or the token, none of which
              // an append-only row should ever carry.
              metadata: {
                permission: request.permission,
                attemptedScopeType: request.target.scopeType,
                attemptedScopeId: request.target.scopeId,
                denialReason: ERROR_CODES.AUTHZ_SCOPE_DENIED,
              },
            },
            auditTx,
          ),
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
  }

  /**
   * The scope the actor legitimately occupies, narrowest first.
   *
   * Narrowest wins because it is the most truthful statement of where the actor
   * was: a principal pinned to one workspace did not act "in the organization",
   * and recording it that way would overstate its reach on a permanent record.
   *
   * No fallback is invented. A principal with no resolved scope at all cannot
   * be described honestly, and the `audit_logs` RLS policy would refuse the row
   * regardless — so this fails closed and loudly rather than guessing. It is
   * defensive: every reachable path resolves a tenant context long before an
   * authorization check, and `TenancyController` refuses without one.
   */
  private actorScope(principal: AuthPrincipal): ScopeRef {
    const { orgId, workspaceId, resellerId, isPlatformAdmin } = principal.tenant;

    if (orgId && workspaceId) return { scopeType: 'workspace', scopeId: workspaceId };
    if (orgId) return { scopeType: 'organization', scopeId: orgId };
    if (resellerId) return { scopeType: 'reseller', scopeId: resellerId };
    if (isPlatformAdmin) return { scopeType: 'platform', scopeId: null };

    throw new Error(
      'audit: cannot record authorization.denied — the principal has no resolved scope to attribute it to',
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
