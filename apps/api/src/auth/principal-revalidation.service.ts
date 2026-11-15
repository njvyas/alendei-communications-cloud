import { Injectable } from '@nestjs/common';
import type { AuthPrincipal, RoleGrant, ScopeChain } from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, isNull, or, sql } from 'drizzle-orm';

import { TenantDatabase } from '../database/tenant-database.service';
import { SessionService } from '../iam/session.service';
import { UserLifecycleService } from '../iam/user-lifecycle.service';
import { creatorAuthorityFromGrants } from './auth.guard';
import { ScopeResolver } from './scope-resolver.service';

/**
 * Phase 8B PR 8B-3b: the caller's grants as they stand NOW, not as the request snapshot
 * `AuthGuard` resolved when the request began.
 *
 * A request's principal is resolved once, from current database state, and then fixed for the
 * request (`ScopeResolver`, ADR-003 D-3). That is right for an ordinary request, but a mutation
 * that runs several transactions — campaign scheduling materialises an audience between its
 * preflight and its final write — would otherwise commit on the authority the caller held when
 * the request STARTED. Where that commit confers a send authority (a scheduled campaign is
 * started later under its scheduler), the final transaction re-reads the caller's grants here
 * and re-asserts against them.
 *
 * The same rules as `AuthGuard`, read in one fresh identity (`acc_auth`) transaction:
 *  - a user session: the session must still be presentable and the user able to sign in; the
 *    grants are `ScopeResolver.forUser`;
 *  - an API key: the key must still be unrevoked and unexpired and its organisation active; its
 *    single synthetic grant carries the key's scopes intersected with its creator's CURRENT
 *    authority at the key's binding (`creatorAuthorityFromGrants`, `RBAC.md` §5c).
 *
 * Anything no longer valid resolves to NO grants, so the subsequent assertion refuses. Parity
 * with `AuthGuard` is tested (`campaigns-dispatch.int-spec.ts`, against `GET /auth/me/authorization`).
 *
 * The identity transaction is opened while the caller holds an `acc_app` connection. That is a
 * different pool, and identity transactions never wait for an `acc_app` connection, so the
 * nested acquisition cannot form the same-pool cycle ADR-015 R-12 guards against.
 */
@Injectable()
export class PrincipalRevalidator {
  constructor(
    private readonly db: TenantDatabase,
    private readonly sessions: SessionService,
    private readonly users: UserLifecycleService,
    private readonly scopes: ScopeResolver,
  ) {}

  async currentGrants(
    principal: Pick<AuthPrincipal, 'userId' | 'apiKeyId' | 'sessionId'>,
  ): Promise<readonly RoleGrant[]> {
    return this.db.auth.transaction(async (raw) => {
      const tx = raw as Transaction;
      if (principal.apiKeyId) return this.apiKeyGrants(tx, principal.apiKeyId);
      if (principal.userId) return this.userGrants(tx, principal.userId, principal.sessionId);
      return [];
    });
  }

  /** The principal with its grants replaced by the current ones. */
  async refreshed<P extends AuthPrincipal>(principal: P): Promise<P> {
    const roles = await this.currentGrants(principal);
    return { ...principal, roles, permissions: [...new Set(roles.flatMap((g) => g.permissions))] };
  }

  private async userGrants(
    tx: Transaction,
    userId: string,
    sessionId: string | null,
  ): Promise<readonly RoleGrant[]> {
    if (sessionId) {
      const session = await this.sessions.findById(tx, sessionId);
      if (!session || session.userId !== userId || !this.sessions.isPresentable(session)) return [];
    }
    const user = await this.users.findById(tx, userId);
    if (!user || !this.users.canAuthenticate(user)) return [];
    return (await this.scopes.forUser(tx, userId)).grants;
  }

  private async apiKeyGrants(tx: Transaction, apiKeyId: string): Promise<readonly RoleGrant[]> {
    const [key] = await tx
      .select({
        id: schema.apiKeys.id,
        orgId: schema.apiKeys.orgId,
        workspaceId: schema.apiKeys.workspaceId,
        scopes: schema.apiKeys.scopes,
        createdBy: schema.apiKeys.createdBy,
      })
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.id, apiKeyId),
          isNull(schema.apiKeys.revokedAt),
          or(isNull(schema.apiKeys.expiresAt), sql`${schema.apiKeys.expiresAt} > now()`),
        ),
      );
    if (!key) return [];
    const [bound] = await tx
      .select({ status: schema.organizations.status })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, key.orgId));
    if (!bound || bound.status !== 'active') return [];

    const grantScope = key.workspaceId
      ? { scopeType: 'workspace' as const, scopeId: key.workspaceId }
      : { scopeType: 'organization' as const, scopeId: key.orgId };
    const requested = Array.isArray(key.scopes) ? (key.scopes as string[]) : [];
    let creatorAuthority: string[] = [];
    if (key.createdBy) {
      const creator = await this.users.findById(tx, key.createdBy);
      if (creator && this.users.canAuthenticate(creator)) {
        const chain: ScopeChain = {
          resellerId: await this.scopes.resellerForOrganization(tx, key.orgId),
          orgId: key.orgId,
          workspaceId: grantScope.scopeType === 'workspace' ? grantScope.scopeId : null,
          teamId: null,
        };
        creatorAuthority = creatorAuthorityFromGrants(
          (await this.scopes.forUser(tx, key.createdBy)).grants,
          grantScope,
          chain,
        );
      }
    }
    const effective = requested.filter((s) => creatorAuthority.includes(s));
    return [
      {
        roleId: `api_key:${key.id}`,
        roleKey: 'api_key',
        scopeType: grantScope.scopeType,
        scopeId: grantScope.scopeId,
        orgId: key.orgId,
        permissions: effective,
      },
    ];
  }
}
