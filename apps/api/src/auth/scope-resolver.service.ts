import { HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES, type RoleGrant, type ScopeType, type TenantContext } from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { AppException } from '../common/errors/app.exception';

export interface ResolvedScopes {
  readonly grants: readonly RoleGrant[];
  readonly permissions: readonly string[];
  /** Every organization the principal can legitimately act in. */
  readonly organizationIds: readonly string[];
  readonly isPlatformAdmin: boolean;
  readonly resellerIds: readonly string[];
}

/** The canonical header for choosing among authorized organizations. */
export const ORGANIZATION_HEADER = 'x-acc-organization';

/**
 * Turns a verified identity into a scope set and a tenant context
 * (`TENANCY.md` §2a).
 *
 * Everything here is read from current database state on every request. Nothing
 * is taken from the token, and nothing is cached — a revoked grant therefore
 * stops applying on the next request rather than at token expiry, which is the
 * property ADR-003 D-3 trades a per-request read for.
 */
@Injectable()
export class ScopeResolver {
  /** Reads every grant a user holds, with the role's flattened permissions. */
  async forUser(tx: Transaction, userId: string): Promise<ResolvedScopes> {
    const rows = await tx
      .select({
        roleId: schema.userRoles.roleId,
        roleKey: schema.roles.key,
        scopeType: schema.userRoles.scopeType,
        scopeId: schema.userRoles.scopeId,
        orgId: schema.userRoles.orgId,
      })
      .from(schema.userRoles)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
      .where(eq(schema.userRoles.userId, userId));

    const grants: RoleGrant[] = rows.map((r) => ({
      roleId: r.roleId,
      roleKey: r.roleKey,
      scopeType: r.scopeType as ScopeType,
      scopeId: r.scopeId,
      orgId: r.orgId,
    }));

    const permissions = await this.permissionsForRoles(
      tx,
      grants.map((g) => g.roleId),
    );

    const isPlatformAdmin = grants.some((g) => g.scopeType === 'platform');
    const resellerIds = [
      ...new Set(
        grants.filter((g) => g.scopeType === 'reseller' && g.scopeId).map((g) => g.scopeId!),
      ),
    ];
    const organizationIds = await this.organizationsInScope(
      tx,
      grants,
      resellerIds,
      isPlatformAdmin,
    );

    return { grants, permissions, organizationIds, isPlatformAdmin, resellerIds };
  }

  /** The permission subset an API key may exercise, intersected by the caller. */
  async permissionsForRoles(tx: Transaction, roleIds: readonly string[]): Promise<string[]> {
    if (roleIds.length === 0) return [];
    const rows = await tx
      .selectDistinct({ key: schema.permissions.key })
      .from(schema.rolePermissions)
      .innerJoin(schema.permissions, eq(schema.permissions.id, schema.rolePermissions.permissionId))
      .where(inArray(schema.rolePermissions.roleId, [...roleIds]));
    return rows.map((r) => r.key);
  }

  /**
   * Which organizations the principal may act in.
   *
   * A platform admin reaches every organization; a reseller admin reaches the
   * organizations beneath its resellers; everyone else reaches exactly the
   * organizations named by their own grants. This is the list the selector in
   * §2a is checked against — it is never widened by anything on the request.
   */
  private async organizationsInScope(
    tx: Transaction,
    grants: readonly RoleGrant[],
    resellerIds: readonly string[],
    isPlatformAdmin: boolean,
  ): Promise<string[]> {
    if (isPlatformAdmin) {
      const all = await tx.select({ id: schema.organizations.id }).from(schema.organizations);
      return all.map((o) => o.id);
    }

    const direct = grants.filter((g) => g.orgId).map((g) => g.orgId!);
    if (resellerIds.length === 0) return [...new Set(direct)];

    const beneath = await tx
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(inArray(schema.organizations.resellerId, [...resellerIds]));

    return [...new Set([...direct, ...beneath.map((o) => o.id)])];
  }

  /**
   * Chooses the organization this request acts in (ADR-003 D-4).
   *
   * Exactly one authorized organization may be selected implicitly. More than
   * one requires the header — the request fails rather than resolving to
   * whichever organization happened to sort first, because silently picking one
   * is how a caller ends up writing to the wrong tenant and never finding out.
   *
   * A selector naming an organization outside scope is refused. It is never
   * substituted, and never turned into an empty result set: a refusal and
   * genuine emptiness have to stay distinguishable to the caller and to a test.
   */
  selectOrganization(scopes: ResolvedScopes, requested: string | null): string | null {
    if (requested) {
      if (!scopes.organizationIds.includes(requested)) {
        throw new AppException({
          status: HttpStatus.FORBIDDEN,
          code: ERROR_CODES.TENANCY_CONTEXT_MISMATCH,
          // The message never confirms whether the organization exists.
          message: 'The requested organization is not within your authorized scope',
          logContext: { requestedOrganizationId: requested },
        });
      }
      return requested;
    }

    if (scopes.organizationIds.length === 1) return scopes.organizationIds[0]!;
    if (scopes.organizationIds.length === 0) return null;

    throw new AppException({
      status: HttpStatus.BAD_REQUEST,
      code: ERROR_CODES.TENANCY_CONTEXT_REQUIRED,
      message:
        'Your account has access to more than one organization; specify which one with the X-Acc-Organization header',
    });
  }

  /** Builds the authoritative tenant context for the selected organization. */
  async tenantContextFor(
    tx: Transaction,
    scopes: ResolvedScopes,
    orgId: string | null,
  ): Promise<TenantContext> {
    let resellerId: string | null = scopes.resellerIds[0] ?? null;
    let workspaceId: string | null = null;

    if (orgId) {
      // A workspace context is derived only from a grant that actually names
      // one; it is never taken from the request.
      const workspaceGrant = scopes.grants.find(
        (g) => g.scopeType === 'workspace' && g.orgId === orgId && g.scopeId,
      );
      if (workspaceGrant) {
        workspaceId = workspaceGrant.scopeId;
      } else {
        const teamGrant = scopes.grants.find(
          (g) => g.scopeType === 'team' && g.orgId === orgId && g.scopeId,
        );
        if (teamGrant) {
          const [team] = await tx
            .select({ workspaceId: schema.teams.workspaceId })
            .from(schema.teams)
            .where(eq(schema.teams.id, teamGrant.scopeId!));
          workspaceId = team?.workspaceId ?? null;
        }
      }

      if (!resellerId) {
        const [org] = await tx
          .select({ resellerId: schema.organizations.resellerId })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, orgId));
        resellerId = org?.resellerId ?? null;
      }
    }

    return {
      orgId,
      workspaceId,
      resellerId,
      isPlatformAdmin: scopes.isPlatformAdmin,
    };
  }

  /** Active, unexpired, unrevoked API key matching a presented prefix. */
  async findApiKeyByPrefix(tx: Transaction, prefix: string) {
    const [row] = await tx
      .select({
        id: schema.apiKeys.id,
        orgId: schema.apiKeys.orgId,
        workspaceId: schema.apiKeys.workspaceId,
        keyHash: schema.apiKeys.keyHash,
        scopes: schema.apiKeys.scopes,
        createdBy: schema.apiKeys.createdBy,
        revokedAt: schema.apiKeys.revokedAt,
        expiresAt: schema.apiKeys.expiresAt,
      })
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.keyPrefix, prefix),
          isNull(schema.apiKeys.revokedAt),
          or(isNull(schema.apiKeys.expiresAt), sql`${schema.apiKeys.expiresAt} > now()`),
        ),
      );
    return row ?? null;
  }
}
