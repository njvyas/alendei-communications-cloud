import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AUDIT_ACTIONS,
  ERROR_CODES,
  type AuditAction,
  type AuthPrincipal,
  type PermissionKey,
} from '@acc/contracts';
import { type Transaction } from '@acc/db';
import { sql } from 'drizzle-orm';

import { actorFromPrincipal } from '../audit/audit-actor';
import { AuditWriter } from '../audit/audit-writer.service';
import { AuthorizationService } from '../auth/authorization.service';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { PLATFORM } from './provider-views';

/**
 * Authorization and audit for every provider operation (ADR-013 F-3, F-4).
 * Extracted unchanged from the 2.1/2.2 registry service in 2.3, so the health
 * and circuit routes decide and record exactly as the catalogue routes do.
 */
@Injectable()
export class ProviderAccess {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditWriter,
  ) {}

  /**
   * The route's permission at platform scope, decided by `AuthorizationService`
   * — the only authority. Called first in every operation's transaction.
   *
   * Every refusal goes through `assert` and its `authorization.denied` row — a
   * platform-scope principal without the permission (`alendei_support`, with or
   * without `X-Acc-Organization`) is filed at `platform` (migration `0019`).
   *
   * One case cannot be: a principal with **no** organization in context, **no**
   * reseller grant and **no** platform-scope grant — for example a member of
   * several organizations calling without `X-Acc-Organization`. There is no scope
   * its refusal could be filed under (ADR-005 D-6 files a denial at the actor's
   * own scope, and it has none here), so `AuthorizationService.recordDenial`
   * would fail with a `500`. Such a principal can never hold a platform-scope
   * permission — platform coverage requires a platform-scope grant — so it is
   * refused here: the same `403`, logged at `warn` with the correlation id by
   * `AllExceptionsFilter`, and the check recorded so route coverage holds. This
   * path only ever refuses; the non-auditing `allows` is asked as well, so a
   * principal the evaluator permits can never be refused here (ADR-013 F-3).
   */
  async authorize(
    tx: Transaction,
    principal: AuthPrincipal,
    permission: PermissionKey,
  ): Promise<void> {
    const { orgId, resellerId } = principal.tenant;
    const hasPlatformGrant = principal.roles.some((grant) => grant.scopeType === 'platform');
    const attributable = Boolean(orgId || resellerId || hasPlatformGrant);
    if (
      !attributable &&
      !(await this.authorization.allows(tx, {
        principal,
        permission,
        target: PLATFORM,
        resourceType: 'Provider',
      }))
    ) {
      RequestContext.recordAuthorizationCheck(permission);
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        message: 'You do not have permission to perform this action',
        logContext: {
          permission,
          targetScopeType: 'platform',
          reason:
            'refused; no organization, reseller or platform scope to attribute the refusal to',
        },
      });
    }
    await this.authorization.assert(tx, {
      principal,
      permission,
      target: PLATFORM,
      resourceType: 'Provider',
    });
    // Defensive: the catalogue is administered by signed-in users. An API key
    // is organization-bound and cannot hold platform authority, so the assertion
    // above refuses it; this keeps that true if the evaluator ever changes.
    if (principal.actorType !== 'user' || !principal.userId) {
      throw new AppException({
        status: HttpStatus.FORBIDDEN,
        code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
        message: 'You do not have permission to perform this action',
        logContext: { permission, targetScopeType: 'platform', reason: 'not a signed-in user' },
      });
    }
  }

  /**
   * The actor's authority **as the database holds it now**, not as it stood
   * when the request was authenticated.
   *
   * `AuthorizationService.assert` evaluates the grants `AuthGuard` resolved at
   * the start of the request. For an operation that calls an adapter between two
   * transactions (test-send, health check) that snapshot is up to an adapter
   * timeout old by the second transaction, so its writes are gated on a fresh
   * read as well: `app_has_platform_permission`, the same predicate the RLS
   * policies apply (migrations `0020`, `0022`). If the grant was revoked or the
   * user disabled meanwhile, the request ends with a `403` and nothing is
   * written — rather than an RLS refusal surfacing as a `500`. The adapter call
   * itself was authorized when it started; its result is neither returned nor
   * recorded.
   */
  async assertAuthorityCurrent(
    tx: Transaction,
    permission: PermissionKey,
    logContext: Record<string, unknown>,
  ): Promise<void> {
    const { rows } = await tx.execute<{ allowed: boolean }>(
      sql`select app_has_platform_permission(${permission}) as allowed`,
    );
    if (rows[0]?.allowed === true) return;
    throw new AppException({
      status: HttpStatus.FORBIDDEN,
      code: ERROR_CODES.AUTHZ_SCOPE_DENIED,
      message: 'You do not have permission to perform this action',
      logContext: { permission, targetScopeType: 'platform', ...logContext },
    });
  }

  /**
   * The audit row, in the mutation's own transaction (every provider action is
   * security-sensitive, ADR-013 F-4), at `platform` scope — the scope the
   * decision was made at. Nothing secret can reach it: the catalogue holds no
   * credential, and capability keys that would name one are refused.
   */
  /**
   * The circuit policy change (`provider.circuit_policy_updated`), in the
   * update's own transaction, at `platform` scope. The policy has no row id:
   * `resource_id` is null and the versions are in before/after.
   */
  recordCircuitPolicy(
    tx: Transaction,
    principal: AuthPrincipal,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record(
      {
        scopeType: 'platform',
        scopeId: null,
        ...actorFromPrincipal(principal),
        action: AUDIT_ACTIONS.PROVIDER_CIRCUIT_POLICY_UPDATED,
        resourceType: 'ProviderCircuitPolicy',
        resourceId: null,
        outcome: 'success',
        before,
        after,
        metadata: {},
      },
      tx,
    );
  }

  record(
    tx: Transaction,
    principal: AuthPrincipal,
    action: AuditAction,
    providerId: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown>,
    outcome: 'success' | 'failure' = 'success',
  ): Promise<void> {
    return this.audit.record(
      {
        scopeType: 'platform',
        scopeId: null,
        ...actorFromPrincipal(principal),
        action,
        resourceType: 'Provider',
        resourceId: providerId,
        outcome,
        before,
        after,
        metadata: {},
      },
      tx,
    );
  }
}
