import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  scopeCovers,
  type AuthPrincipal,
  type PermissionKey,
  type ScopeChain,
  type ScopeRef,
} from '@acc/contracts';

import { AppException } from '../common/errors/app.exception';

export interface AuthorizationTarget {
  /** The scope the action is being performed at. */
  readonly scope: ScopeRef;
  /** That scope's resolved ancestry, read from the database, never from input. */
  readonly chain: ScopeChain;
}

export interface AuthorizationRequest {
  readonly principal: AuthPrincipal;
  readonly permission: PermissionKey | string;
  readonly target: AuthorizationTarget;
}

/**
 * The one place an authorization decision is made (`RBAC.md` §2, ADR-003 D-5).
 *
 * Authorization is two questions, and both are mandatory:
 *
 *   1. does the principal hold the permission at all?
 *   2. does it hold it at a scope *covering this target*?
 *
 * Holding `workspaces.update` somewhere is never authority to update *this*
 * workspace. Question 2 is the half an endpoint guard usually cannot answer,
 * because a target's scope is often knowable only once the resource is loaded —
 * which is exactly why this lives in a service every scoped operation calls,
 * rather than in a decorator that runs before the handler.
 *
 * It matters most below organization level: RLS carries no workspace or team
 * term (`TENANCY.md` §3a), so for those levels this evaluator is the *only*
 * enforcement there is. A missing call is not a style problem, it is an
 * isolation hole.
 *
 * Phase 1B.3 ships the evaluator and the identity/tenant half of the chain.
 * Phase 1B.5 builds the role-administration surface on top of it unchanged.
 */
@Injectable()
export class PermissionEvaluator {
  /** Non-throwing form, for filtering listings and rendering capability flags. */
  allows(request: AuthorizationRequest): boolean {
    const { principal, permission, target } = request;

    if (!principal.permissions.includes(permission)) return false;

    // Only grants whose role actually carries the permission can cover it. A
    // principal holding `read_only` at the organization and `org_admin` at one
    // workspace must not have the organization grant satisfy a workspace-level
    // admin action.
    return principal.roles.some(
      (grant) =>
        this.grantCarries(principal, grant.roleId, permission) &&
        scopeCovers(
          { scopeType: grant.scopeType, scopeId: grant.scopeId },
          target.scope,
          target.chain,
        ),
    );
  }

  /** Throwing form. Refusal is a `403` that never echoes the target back. */
  assert(request: AuthorizationRequest): void {
    if (this.allows(request)) return;

    throw new AppException({
      status: HttpStatus.FORBIDDEN,
      code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
      message: 'You do not have permission to perform this action',
      // The attempted target is operator context and audit metadata. It is
      // never presented as the actor's own scope on the audit row, because an
      // attacker-supplied target must not become the record of where the actor
      // legitimately was.
      logContext: {
        permission: request.permission,
        attemptedScopeType: request.target.scope.scopeType,
        attemptedScopeId: request.target.scope.scopeId,
      },
    });
  }

  /**
   * Whether one specific grant's role carries the permission.
   *
   * `AuthPrincipal.permissions` is the flattened union across every grant, which
   * answers question 1 but is too coarse for question 2. Until per-role
   * permission sets are carried on the principal (Phase 1B.5, where role
   * administration needs them anyway), a principal holding the permission
   * through any grant is treated as holding it through each — a deliberate,
   * documented over-approximation that is safe today because Phase 1B.3 exposes
   * no endpoint whose target is below organization level.
   *
   * `DECISIONS.md` records this as the one place Phase 1B.3 is weaker than the
   * model, and Phase 1B.5 closes it by carrying per-grant permissions.
   */
  private grantCarries(principal: AuthPrincipal, _roleId: string, permission: string): boolean {
    return principal.permissions.includes(permission);
  }
}
