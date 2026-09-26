import { HttpStatus, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  PLATFORM_ROLE_KEYS,
  type RoleGrant,
  type ScopeType,
  type TenantContext,
} from '@acc/contracts';
import { schema, type Transaction } from '@acc/db';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { AppException } from '../common/errors/app.exception';

export interface ResolvedScopes {
  readonly grants: readonly RoleGrant[];
  readonly permissions: readonly string[];
  /** Every organization the principal can legitimately act in. */
  readonly organizationIds: readonly string[];
  /**
   * An active holder of `alendei_super_admin` at platform scope — the only
   * principal RLS treats as unrestricted (`isPlatformAdministrator`).
   */
  readonly isPlatformAdmin: boolean;
  /**
   * Holds *some* grant at platform scope (super admin or support). Widens which
   * organizations may be selected, and nothing else: inside the selected
   * organization RLS scopes a support principal exactly like a member.
   */
  readonly hasPlatformGrant: boolean;
  /** Resellers the principal holds a genuine `reseller`-scope grant on. */
  readonly resellerIds: readonly string[];
}

/**
 * The one definition of a platform administrator, shared with
 * `app_is_platform_admin()` (migration `0010`) and the liveness invariant: a grant
 * of `alendei_super_admin` at `platform` scope. A support grant is platform-scoped
 * too, and deliberately does not qualify.
 */
export function isPlatformAdministrator(grants: readonly RoleGrant[]): boolean {
  return grants.some(
    (g) => g.scopeType === 'platform' && g.roleKey === PLATFORM_ROLE_KEYS.ALENDEI_SUPER_ADMIN,
  );
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
  /** Reads every grant a user holds, each carrying its own role's permissions. */
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
      .where(eq(schema.userRoles.userId, userId))
      // Deterministic, so every "first matching grant" below is the same grant
      // on every request rather than whatever order the heap returned.
      .orderBy(schema.userRoles.id);

    // Per role, not flattened. Keeping the role-to-permission mapping is what
    // makes a coherent-grant decision possible at all (ADR-005 D-1); collapsing
    // it here is what previously made one impossible.
    const byRole = await this.permissionsByRole(
      tx,
      rows.map((r) => r.roleId),
    );

    const grants: RoleGrant[] = rows.map((r) => ({
      roleId: r.roleId,
      roleKey: r.roleKey,
      scopeType: r.scopeType as ScopeType,
      scopeId: r.scopeId,
      orgId: r.orgId,
      permissions: byRole.get(r.roleId) ?? [],
    }));

    // The union, derived from the grants rather than queried separately, so the
    // two can never disagree. Non-authoritative for authorization (ADR-005 D-3).
    const permissions = [...new Set(grants.flatMap((g) => g.permissions))];

    const isPlatformAdmin = isPlatformAdministrator(grants);
    const hasPlatformGrant = grants.some((g) => g.scopeType === 'platform');
    const resellerIds = [
      ...new Set(
        grants.filter((g) => g.scopeType === 'reseller' && g.scopeId).map((g) => g.scopeId!),
      ),
    ];
    const organizationIds = await this.organizationsInScope(
      tx,
      grants,
      resellerIds,
      hasPlatformGrant,
    );

    return { grants, permissions, organizationIds, isPlatformAdmin, hasPlatformGrant, resellerIds };
  }

  /**
   * The permissions each role carries, keyed by role.
   *
   * Deliberately *not* a flattened union: `role_permissions` already models the
   * role-to-permission relation correctly, and the only thing that ever lost it
   * was this projection selecting `DISTINCT key` and discarding `role_id`. The
   * query reads the same rows over the same index; it simply keeps the column
   * that says which role each permission came from.
   */
  async permissionsByRole(
    tx: Transaction,
    roleIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const byRole = new Map<string, string[]>();
    const unique = [...new Set(roleIds)];
    if (unique.length === 0) return byRole;

    const rows = await tx
      .select({ roleId: schema.rolePermissions.roleId, key: schema.permissions.key })
      .from(schema.rolePermissions)
      .innerJoin(schema.permissions, eq(schema.permissions.id, schema.rolePermissions.permissionId))
      .where(inArray(schema.rolePermissions.roleId, unique));

    for (const row of rows) {
      const existing = byRole.get(row.roleId);
      if (existing) existing.push(row.key);
      else byRole.set(row.roleId, [row.key]);
    }
    return byRole;
  }

  /**
   * The reseller owning an organization, for building the scope chain an
   * API key's binding scope is judged against (ADR-005 D-4).
   *
   * A reseller-scoped creator legitimately covers the organizations beneath its
   * reseller, and `scopeCovers` can only see that through the chain — so
   * omitting the term here would silently strip a reseller admin's authority
   * from every key it creates.
   */
  async resellerForOrganization(tx: Transaction, orgId: string): Promise<string | null> {
    const [org] = await tx
      .select({ resellerId: schema.organizations.resellerId })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId));
    return org?.resellerId ?? null;
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
    hasPlatformGrant: boolean,
  ): Promise<string[]> {
    if (hasPlatformGrant) {
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

  /**
   * Builds the authoritative tenant context for the selected organization.
   *
   * **`resellerId` is reseller *authority*, never reseller *context*.** It is set
   * only when the principal holds a genuine `reseller`-scope grant on the
   * reseller that owns the selected organization — because this value becomes
   * `app.current_reseller_id`, and `app_org_in_scope()` admits every
   * organization beneath it. It previously fell back to the selected
   * organization's own reseller for every principal, which handed an ordinary
   * organization member RLS visibility of every sibling organization under the
   * same reseller (Gate-B audit, Blocker 1). The database now refuses that claim
   * independently (migration `0010`), but the application does not make it.
   *
   * With no organization selected, a principal holding exactly one reseller
   * grant acts as that reseller; holding several, it acts as none, rather than
   * as whichever sorted first.
   */
  async tenantContextFor(
    tx: Transaction,
    scopes: ResolvedScopes,
    orgId: string | null,
  ): Promise<TenantContext> {
    let resellerId: string | null = null;
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

      if (scopes.resellerIds.length > 0) {
        const owner = await this.resellerForOrganization(tx, orgId);
        if (owner && scopes.resellerIds.includes(owner)) resellerId = owner;
      }
    } else if (scopes.resellerIds.length === 1) {
      resellerId = scopes.resellerIds[0]!;
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
