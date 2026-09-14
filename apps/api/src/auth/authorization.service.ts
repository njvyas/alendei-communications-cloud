import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES, type AuthPrincipal, type PermissionKey, type ScopeRef } from '@acc/contracts';
import type { Transaction } from '@acc/db';

import { AppException } from '../common/errors/app.exception';
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
  constructor(
    private readonly chains: ScopeChainResolver,
    private readonly evaluator: PermissionEvaluator,
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

    this.evaluator.assert({
      principal: request.principal,
      permission: request.permission,
      target: { scope: request.target, chain },
    });
  }

  /**
   * Non-throwing form, for filtering listings and rendering capability flags.
   *
   * An unresolvable target is `false` — the same fail-closed answer, without
   * choosing between `403` and `404` for a caller that is not being told
   * either.
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
