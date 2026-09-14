import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  scopeCovers,
  type AuthPrincipal,
  type PermissionKey,
  type RoleGrant,
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
 * **Both questions are answered about the same grant** (ADR-005 D-1). That is
 * the property the whole design rests on, and it is the one that was previously
 * missing: asking "does the principal hold P anywhere?" and "does the principal
 * cover this target anywhere?" independently authorizes the cross-product of
 * the two answers, which contains combinations no grant confers. A principal
 * holding `read_only` across an organization and `workspace_manager` in one
 * workspace would pass an organization-level check for `role_assignments.grant`
 * — a permission the organization grant does not carry, at a scope the
 * workspace grant does not reach. Both halves are therefore read off one
 * `RoleGrant`, which makes the mistake unrepresentable rather than merely
 * avoided.
 *
 * Phase 1B.3 shipped the evaluator and the identity/tenant half of the chain;
 * Phase 1B.5.1 corrected its provenance. Phase 1B.5 builds the
 * role-administration surface on top of it unchanged.
 */
@Injectable()
export class PermissionEvaluator {
  /**
   * Non-throwing form, for filtering listings and rendering capability flags.
   *
   *     ALLOW(P, target)  ⟺  ∃ g ∈ principal.roles :
   *             P ∈ g.permissions
   *         ∧   scopeCovers(g.scope, target.scope, target.chain)
   *
   * `AuthPrincipal.permissions` — the flattened union — is deliberately not
   * read here (ADR-005 D-3). It answers "somewhere", and this question is
   * "here".
   */
  allows(request: AuthorizationRequest): boolean {
    const { principal, permission, target } = request;
    return principal.roles.some((grant) => this.grantAuthorizes(grant, permission, target));
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
   * Whether **this one grant** authorizes this action.
   *
   * Both terms read off the same `grant` parameter, and there is no other
   * source of either in scope. That is the point: the cross-product is not
   * guarded against here, it is structurally impossible to express.
   *
   * A grant's own permission set comes from `role_permissions` for its role
   * (`ScopeResolver.permissionsByRole`), so a grant can never be widened by
   * what some *other* grant's role happens to carry.
   */
  private grantAuthorizes(
    grant: RoleGrant,
    permission: PermissionKey | string,
    target: AuthorizationTarget,
  ): boolean {
    if (!grant.permissions.includes(permission)) return false;
    return scopeCovers(
      { scopeType: grant.scopeType, scopeId: grant.scopeId },
      target.scope,
      target.chain,
    );
  }
}
